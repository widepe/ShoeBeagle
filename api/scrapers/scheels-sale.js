// /api/scrapers/scheels-sale.js
//
// Scheels sale running shoes scraper
// - Uses Playwright because Scheels uses a client-side "Load More" flow
// - Scrapes sale running shoes from:
//   https://www.scheels.com/search/sale/?r=activity%3ARunning&q=shoes
// - Handles both normal pricing and range pricing
// - Skips hidden-price tiles like:
//   "see price in cart", "add to bag to see price", "see price in bag", etc.
// - Writes ONLY top-level metadata + deals array to Vercel Blob
// - Tracks drop reasons globally and per virtual page summary
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//   - optional: CRON_SECRET (commented out below for testing)
//
// INSTALL IF NEEDED:
//   npm i playwright @vercel/blob
//
// TEST:
//   /api/scrapers/scheels-sale
//
// NOTES:
// - shoeType is always "unknown" here, per your instruction
// - gender is derived from listing title
// - range pricing fills:
//     salePriceLow / salePriceHigh
//     originalPriceLow / originalPriceHigh
//     discountPercentUpTo
// - exact single-price deals fill:
//     salePrice / originalPrice / discountPercent

import { chromium } from "playwright";
import { put } from "@vercel/blob";

export const config = { maxDuration: 300 };

const STORE = "Scheels";
const SCHEMA_VERSION = 1;
const VIA = "playwright";
const BASE_URL = "https://www.scheels.com";
const START_URL =
  "https://www.scheels.com/search/sale/?r=activity%3ARunning&q=shoes";
const BLOB_PATH = "scheels-sale.json";

const HIDDEN_PRICE_PATTERNS = [
  /see\s+price\s+in\s+cart/i,
  /see\s+price\s+in\s+bag/i,
  /add\s+to\s+bag\s+to\s+see\s+price/i,
  /add\s+to\s+cart\s+to\s+see\s+price/i,
  /price\s+in\s+cart/i,
  /price\s+in\s+bag/i,
  /pricing\s+in\s+cart/i,
  /pricing\s+in\s+bag/i,
];

const BRAND_PREFIXES = [
  "New Balance",
  "Under Armour",
  "La Sportiva",
  "On",
  "Nike",
  "ASICS",
  "Brooks",
  "Saucony",
  "HOKA",
  "Mizuno",
  "PUMA",
  "Adidas",
  "adidas",
  "Altra",
  "Topo Athletic",
  "Salomon",
  "Merrell",
  "Craft",
  "Diadora",
  "Reebok",
  "Karhu",
  "361",
  "Newton",
  "Norda",
  "Scarpa",
  "Arc'teryx",
  "inov-8",
  "Inov-8",
];

function nowIso() {
  return new Date().toISOString();
}

function toAbsUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, BASE_URL).toString();
  } catch {
    return null;
  }
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function parseMoney(text) {
  if (!text) return null;
  const m = String(text).replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function roundPct(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function computeDiscountPercent(original, sale) {
  if (
    !Number.isFinite(original) ||
    !Number.isFinite(sale) ||
    original <= 0 ||
    sale >= original
  ) {
    return null;
  }
  return roundPct(((original - sale) / original) * 100);
}

function parseGender(listingName) {
  const t = (listingName || "").toLowerCase();
  if (/\bwomen'?s\b|\bwomens\b/.test(t)) return "womens";
  if (/\bmen'?s\b|\bmens\b/.test(t)) return "mens";
  if (/\bunisex\b/.test(t)) return "unisex";
  return "unknown";
}

function stripGenderPrefix(listingName) {
  return cleanText(
    String(listingName || "")
      .replace(/^(women'?s|womens)\s+/i, "")
      .replace(/^(men'?s|mens)\s+/i, "")
      .replace(/^unisex\s+/i, "")
  );
}

function parseBrandAndModel(listingName) {
  const title = stripGenderPrefix(listingName)
    .replace(/\bRunning Shoes\b/i, "")
    .replace(/\bRunning Shoe\b/i, "")
    .trim();

  const brandMatch = [...BRAND_PREFIXES]
    .sort((a, b) => b.length - a.length)
    .find((brand) => title.toLowerCase().startsWith(brand.toLowerCase()));

  if (brandMatch) {
    const model = cleanText(title.slice(brandMatch.length)) || null;
    return {
      brand: brandMatch,
      model,
    };
  }

  const parts = title.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return { brand: null, model: null };
  }

  return {
    brand: parts[0] || null,
    model: cleanText(parts.slice(1).join(" ")) || null,
  };
}

function makeDropCounts() {
  return {
    totalTiles: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_hiddenPrice: 0,
    dropped_missingSalePrice: 0,
    dropped_duplicateAfterMerge: 0,
    dropped_notRunningShoesTitle: 0,
  };
}

function makeGenderCounts() {
  return {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };
}

function increment(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + by;
}

function pricingLooksHidden(pricingText) {
  const t = cleanText(pricingText);
  return HIDDEN_PRICE_PATTERNS.some((re) => re.test(t));
}

function parsePriceBlock($tileLike) {
  const pricingText = cleanText($tileLike.pricingText || "");
  const priceTokens = Array.isArray($tileLike.priceTokens)
    ? $tileLike.priceTokens
        .map((x) => parseMoney(x))
        .filter((n) => Number.isFinite(n))
    : [];

  if (pricingLooksHidden(pricingText)) {
    return { hiddenPrice: true };
  }

  const lowerText = pricingText.toLowerCase();
  const hasOldRange = /old price range/i.test(lowerText);
  const hasSaleRange = /sale price range/i.test(lowerText);
  const hasOldSingle = /old price:/i.test(lowerText);
  const hasSaleSingle = /sale price:/i.test(lowerText);

  const result = {
    hiddenPrice: false,

    salePrice: null,
    originalPrice: null,
    discountPercent: null,

    salePriceLow: null,
    salePriceHigh: null,
    originalPriceLow: null,
    originalPriceHigh: null,
    discountPercentUpTo: null,
  };

  // Most reliable case: range/range from your provided tile:
  // Old Price range: $220.00 - $240.00
  // Sale Price Range: $164.99 - $240.00
  if ((hasOldRange || hasSaleRange) && priceTokens.length >= 4) {
    result.originalPriceLow = priceTokens[0];
    result.originalPriceHigh = priceTokens[1];
    result.salePriceLow = priceTokens[2];
    result.salePriceHigh = priceTokens[3];

    const bestOriginal = result.originalPriceHigh ?? result.originalPriceLow;
    const bestSale = result.salePriceLow ?? result.salePriceHigh;
    result.discountPercentUpTo = computeDiscountPercent(bestOriginal, bestSale);

    return result;
  }

  // Old single + sale single
  if ((hasOldSingle || hasSaleSingle) && priceTokens.length >= 2) {
    result.originalPrice = priceTokens[0];
    result.salePrice = priceTokens[1];
    result.discountPercent = computeDiscountPercent(
      result.originalPrice,
      result.salePrice
    );
    return result;
  }

  // Fallbacks for mixed structures
  if (priceTokens.length === 4) {
    result.originalPriceLow = priceTokens[0];
    result.originalPriceHigh = priceTokens[1];
    result.salePriceLow = priceTokens[2];
    result.salePriceHigh = priceTokens[3];
    result.discountPercentUpTo = computeDiscountPercent(
      result.originalPriceHigh,
      result.salePriceLow
    );
    return result;
  }

  if (priceTokens.length === 3) {
    // Sometimes one side is single and the other is range
    // Assume first is original, remaining two are sale range
    result.originalPrice = priceTokens[0];
    result.salePriceLow = Math.min(priceTokens[1], priceTokens[2]);
    result.salePriceHigh = Math.max(priceTokens[1], priceTokens[2]);
    result.discountPercentUpTo = computeDiscountPercent(
      result.originalPrice,
      result.salePriceLow
    );
    return result;
  }

  if (priceTokens.length === 2) {
    result.originalPrice = priceTokens[0];
    result.salePrice = priceTokens[1];
    result.discountPercent = computeDiscountPercent(
      result.originalPrice,
      result.salePrice
    );
    return result;
  }

  if (priceTokens.length === 1) {
    // Sale-only tile
    result.salePrice = priceTokens[0];
    return result;
  }

  return result;
}

async function extractVisibleTiles(page) {
  return await page.$$eval('article[id^="plp-item-"]', (articles) =>
    articles.map((article) => {
      const titleAnchor = article.querySelector("h2 a[href]");
      const image = article.querySelector("img[src]");
      const pricingRoot =
        article.querySelector('[id$="-pricing"]') ||
        article.querySelector("div[id*='pricing']");
      const priceSpans = pricingRoot
        ? Array.from(pricingRoot.querySelectorAll("span"))
            .map((el) => (el.textContent || "").trim())
            .filter(Boolean)
        : [];

      return {
        articleId: article.getAttribute("id") || null,
        objectId: article.getAttribute("data-object-id") || null,
        listingName: (titleAnchor?.textContent || "").trim(),
        listingURL: titleAnchor?.getAttribute("href") || null,
        imageURL: image?.getAttribute("src") || null,
        pricingText: (pricingRoot?.innerText || "").trim(),
        priceTokens: priceSpans,
      };
    })
  );
}

async function getShowingCounts(page) {
  const text = await page
    .$eval("div.flex.justify-center.pt-15 p", (el) => el.textContent || "")
    .catch(() => "");

  const m = text.match(/Showing\s+(\d+)\s+of\s+(\d+)/i);
  return {
    raw: cleanText(text),
    shown: m ? Number(m[1]) : null,
    total: m ? Number(m[2]) : null,
  };
}

async function clickLoadMore(page) {
  const button = page.getByRole("button", { name: /load more/i }).first();
  const exists = await button.isVisible().catch(() => false);
  if (!exists) return false;

  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click({ timeout: 10000 }).catch(() => {});
  return true;
}

function buildDeal(raw) {
  const listingName = cleanText(raw.listingName);
  const listingURL = toAbsUrl(raw.listingURL);
  const imageURL = raw.imageURL || null;

  const gender = parseGender(listingName);
  const { brand, model } = parseBrandAndModel(listingName);
  const pricing = parsePriceBlock(raw);

  return {
    schemaVersion: SCHEMA_VERSION,

    listingName,
    brand,
    model,

    salePrice: pricing.salePrice,
    originalPrice: pricing.originalPrice,
    discountPercent: pricing.discountPercent,

    salePriceLow: pricing.salePriceLow,
    salePriceHigh: pricing.salePriceHigh,
    originalPriceLow: pricing.originalPriceLow,
    originalPriceHigh: pricing.originalPriceHigh,
    discountPercentUpTo: pricing.discountPercentUpTo,

    store: STORE,

    listingURL,
    imageURL,

    gender,
    shoeType: "unknown",
  };
}

function hasAnySalePrice(deal) {
  return (
    Number.isFinite(deal.salePrice) ||
    Number.isFinite(deal.salePriceLow) ||
    Number.isFinite(deal.salePriceHigh)
  );
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  // TEMPORARILY COMMENTED OUT FOR TESTING:
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage({
      viewport: { width: 1440, height: 1600 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    });

    await page.goto(START_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForSelector('article[id^="plp-item-"]', { timeout: 30000 });

    const sourceUrls = [START_URL];
    const pageSummaries = [];
    const globalDropCounts = makeDropCounts();
    const globalGenderCounts = makeGenderCounts();

    const seenKeys = new Set();
    const processedTileKeys = new Set();
    const deals = [];

    let virtualPage = 1;
    let pagesFetched = 0;
    let totalExpected = null;

    for (let guard = 0; guard < 50; guard++) {
      const counts = await getShowingCounts(page);
      if (Number.isFinite(counts.total)) totalExpected = counts.total;

      const visibleTiles = await extractVisibleTiles(page);
      const newTiles = visibleTiles.filter((tile) => {
        const key = tile.articleId || tile.objectId || tile.listingURL || "";
        if (!key) return false;
        if (processedTileKeys.has(key)) return false;
        processedTileKeys.add(key);
        return true;
      });

      const summaryDropCounts = makeDropCounts();
      const summaryGenderCounts = makeGenderCounts();

      let summaryDealsExtracted = 0;

      for (const tile of newTiles) {
        increment(globalDropCounts, "totalTiles");
        increment(summaryDropCounts, "totalTiles");

        const listingName = cleanText(tile.listingName);
        const listingURL = toAbsUrl(tile.listingURL);
        const imageURL = tile.imageURL || null;
        const pricing = parsePriceBlock(tile);

        if (!listingName) {
          increment(globalDropCounts, "dropped_missingListingName");
          increment(summaryDropCounts, "dropped_missingListingName");
          continue;
        }

        if (!/running shoe/i.test(listingName)) {
          increment(globalDropCounts, "dropped_notRunningShoesTitle");
          increment(summaryDropCounts, "dropped_notRunningShoesTitle");
          continue;
        }

        if (!listingURL) {
          increment(globalDropCounts, "dropped_missingListingURL");
          increment(summaryDropCounts, "dropped_missingListingURL");
          continue;
        }

        if (!imageURL) {
          increment(globalDropCounts, "dropped_missingImageURL");
          increment(summaryDropCounts, "dropped_missingImageURL");
          continue;
        }

        if (pricing.hiddenPrice) {
          increment(globalDropCounts, "dropped_hiddenPrice");
          increment(summaryDropCounts, "dropped_hiddenPrice");
          continue;
        }

        const deal = buildDeal(tile);

        if (!hasAnySalePrice(deal)) {
          increment(globalDropCounts, "dropped_missingSalePrice");
          increment(summaryDropCounts, "dropped_missingSalePrice");
          continue;
        }

        const dedupeKey =
          deal.listingURL ||
          `${deal.listingName}__${deal.salePrice ?? ""}__${deal.salePriceLow ?? ""}__${deal.salePriceHigh ?? ""}`;

        if (seenKeys.has(dedupeKey)) {
          increment(globalDropCounts, "dropped_duplicateAfterMerge");
          increment(summaryDropCounts, "dropped_duplicateAfterMerge");
          continue;
        }

        seenKeys.add(dedupeKey);
        deals.push(deal);
        summaryDealsExtracted += 1;

        increment(globalGenderCounts, deal.gender);
        increment(summaryGenderCounts, deal.gender);
      }

      pagesFetched += 1;

      pageSummaries.push({
        page: virtualPage,
        url: START_URL,
        shownText: counts.raw || null,
        shownCount: counts.shown,
        totalCount: counts.total,
        tilesSeenThisStep: newTiles.length,
        dealsExtracted: summaryDealsExtracted,
        genderCounts: summaryGenderCounts,
        dropCounts: summaryDropCounts,
      });

      const noMoreNeeded =
        Number.isFinite(counts.shown) &&
        Number.isFinite(counts.total) &&
        counts.shown >= counts.total;

      if (noMoreNeeded) break;

      const clicked = await clickLoadMore(page);
      if (!clicked) break;

      await page.waitForTimeout(1500);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      virtualPage += 1;
    }

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,

      pagesFetched,

      dealsFound: processedTileKeys.size,
      dealsExtracted: deals.length,

      dealsForMens: globalGenderCounts.mens,
      dealsForWomens: globalGenderCounts.womens,
      dealsForUnisex: globalGenderCounts.unisex,
      dealsForUnknown: globalGenderCounts.unknown,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      pageSummaries,
      dropCounts: globalDropCounts,

      deals,
    };

    const blob = await put(BLOB_PATH, JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobPath: BLOB_PATH,
      blobUrl: blob.url,

      pagesFetched: payload.pagesFetched,
      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,

      dealsForMens: payload.dealsForMens,
      dealsForWomens: payload.dealsForWomens,
      dealsForUnisex: payload.dealsForUnisex,
      dealsForUnknown: payload.dealsForUnknown,

      dropCounts: payload.dropCounts,
      pageSummaries: payload.pageSummaries,

      scrapeDurationMs: payload.scrapeDurationMs,
      ok: true,
      error: null,

      // intentionally NOT returning the full deals array in the endpoint response
      // the blob itself contains top-level fields + deals array only
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: err?.message || String(err),
      scrapeDurationMs: Date.now() - startedAt,
      ok: false,
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
