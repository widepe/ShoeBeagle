// /api/scrapers/scheels-firecrawl.js
//
// Scheels sale running shoes scraper
// - Uses Firecrawl because Scheels product listing is JS-rendered
// - Scrapes paginated pages like:
//   https://www.scheels.com/search/sale/?r=activity%3ARunning&q=shoes
//   https://www.scheels.com/search/sale/?r=activity%3ARunning&q=shoes&page=2
// - Handles normal pricing and price ranges
// - Skips hidden-price tiles ("see price in cart", "add to bag to see price", etc.)
// - Tracks top-level metadata, page summaries, gender counts, and drop reasons
// - Blob payload contains top-level fields + deals array only
//
// ENV:
//   - FIRECRAWL_API_KEY
//   - BLOB_READ_WRITE_TOKEN
//   - optional CRON_SECRET (commented out for testing)
//
// TEST:
//   /api/scrapers/scheels-firecrawl
//
// NOTES:
// - shoeType is always "unknown"
// - page summaries are one summary per paginated page
// - range pricing fills salePriceLow/salePriceHigh/originalPriceLow/originalPriceHigh/discountPercentUpTo

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = { maxDuration: 300 };

const STORE = "Scheels";
const SCHEMA_VERSION = 1;
const VIA = "firecrawl";
const BASE_URL = "https://www.scheels.com";
const BLOB_PATH = "scheels-sale.json";
const START_URL =
  "https://www.scheels.com/search/sale/?r=activity%3ARunning&q=shoes";

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
  "Topo Athletic",
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
  "inov-8",
  "Inov-8",
];

function nowIso() {
  return new Date().toISOString();
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function toAbsUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, BASE_URL).toString();
  } catch {
    return null;
  }
}

function parseMoney(text) {
  if (!text) return null;
  const m = String(text).replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function roundPct(n) {
  return Number.isFinite(n) ? Math.round(n) : null;
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
    return {
      brand: brandMatch,
      model: cleanText(title.slice(brandMatch.length)) || null,
    };
  }

  const parts = title.split(/\s+/).filter(Boolean);
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

function parsePriceBlock(pricingText, priceTokens) {
  const text = cleanText(pricingText || "");
  const nums = (priceTokens || [])
    .map((x) => parseMoney(x))
    .filter((n) => Number.isFinite(n));

  const lower = text.toLowerCase();

  const result = {
    hiddenPrice: pricingLooksHidden(text),

    salePrice: null,
    originalPrice: null,
    discountPercent: null,

    salePriceLow: null,
    salePriceHigh: null,
    originalPriceLow: null,
    originalPriceHigh: null,
    discountPercentUpTo: null,
  };

  if (result.hiddenPrice) return result;

  const hasOldRange = /old price range/i.test(lower);
  const hasSaleRange = /sale price range/i.test(lower);
  const hasOldSingle = /old price:/i.test(lower);
  const hasSaleSingle = /sale price:/i.test(lower);

  if ((hasOldRange || hasSaleRange) && nums.length >= 4) {
    result.originalPriceLow = nums[0];
    result.originalPriceHigh = nums[1];
    result.salePriceLow = nums[2];
    result.salePriceHigh = nums[3];
    result.discountPercentUpTo = computeDiscountPercent(
      result.originalPriceHigh,
      result.salePriceLow
    );
    return result;
  }

  if ((hasOldSingle || hasSaleSingle) && nums.length >= 2) {
    result.originalPrice = nums[0];
    result.salePrice = nums[1];
    result.discountPercent = computeDiscountPercent(
      result.originalPrice,
      result.salePrice
    );
    return result;
  }

  if (nums.length === 4) {
    result.originalPriceLow = nums[0];
    result.originalPriceHigh = nums[1];
    result.salePriceLow = nums[2];
    result.salePriceHigh = nums[3];
    result.discountPercentUpTo = computeDiscountPercent(
      result.originalPriceHigh,
      result.salePriceLow
    );
    return result;
  }

  if (nums.length === 3) {
    result.originalPrice = nums[0];
    result.salePriceLow = Math.min(nums[1], nums[2]);
    result.salePriceHigh = Math.max(nums[1], nums[2]);
    result.discountPercentUpTo = computeDiscountPercent(
      result.originalPrice,
      result.salePriceLow
    );
    return result;
  }

  if (nums.length === 2) {
    result.originalPrice = nums[0];
    result.salePrice = nums[1];
    result.discountPercent = computeDiscountPercent(
      result.originalPrice,
      result.salePrice
    );
    return result;
  }

  if (nums.length === 1) {
    result.salePrice = nums[0];
    return result;
  }

  return result;
}

function hasAnySalePrice(deal) {
  return (
    Number.isFinite(deal.salePrice) ||
    Number.isFinite(deal.salePriceLow) ||
    Number.isFinite(deal.salePriceHigh)
  );
}

async function firecrawlScrapeRawHtml(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY");

  const resp = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["rawHtml"],
      onlyMainContent: false,
      waitFor: 2500,
      timeout: 120000,
      blockAds: true,
      proxy: "auto",
      actions: [
        { type: "wait", milliseconds: 1500 },
      ],
    }),
  });

  const json = await resp.json().catch(() => null);

  if (!resp.ok) {
    throw new Error(
      `Firecrawl scrape failed for ${url}: ${resp.status} ${
        json?.error || resp.statusText
      }`
    );
  }

  const rawHtml =
    json?.data?.rawHtml ||
    json?.rawHtml ||
    json?.data?.html ||
    json?.html ||
    "";

  if (!rawHtml || typeof rawHtml !== "string") {
    throw new Error(`No rawHtml returned for ${url}`);
  }

  return rawHtml;
}

function extractShowingCounts($) {
  const text = cleanText(
    $("div.flex.justify-center.pt-15 p").first().text() || ""
  );
  const m = text.match(/Showing\s+(\d+)\s+of\s+(\d+)/i);

  return {
    shownText: text || null,
    shownCount: m ? Number(m[1]) : null,
    totalCount: m ? Number(m[2]) : null,
  };
}

function extractTilesFromHtml(html) {
  const $ = cheerio.load(html);
  const tiles = [];

  $('article[id^="plp-item-"]').each((_, el) => {
    const $el = $(el);
    const titleAnchor = $el.find("h2 a[href]").first();
    const image = $el.find("img[src]").first();
    const pricingRoot =
      $el.find('[id$="-pricing"]').first().get(0)
        ? $el.find('[id$="-pricing"]').first()
        : $el.find('div[id*="pricing"]').first();

    const priceTokens = [];
    pricingRoot.find("span").each((__, span) => {
      const txt = cleanText($(span).text());
      if (txt) priceTokens.push(txt);
    });

    tiles.push({
      articleId: $el.attr("id") || null,
      objectId: $el.attr("data-object-id") || null,
      listingName: cleanText(titleAnchor.text()),
      listingURL: titleAnchor.attr("href") || null,
      imageURL: image.attr("src") || null,
      pricingText: cleanText(pricingRoot.text()),
      priceTokens,
    });
  });

  return {
    tiles,
    counts: extractShowingCounts($),
  };
}

function buildDeal(tile) {
  const listingName = cleanText(tile.listingName);
  const listingURL = toAbsUrl(tile.listingURL);
  const imageURL = tile.imageURL || null;

  const gender = parseGender(listingName);
  const { brand, model } = parseBrandAndModel(listingName);
  const pricing = parsePriceBlock(tile.pricingText, tile.priceTokens);

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

function makePageUrl(pageNum) {
  if (pageNum <= 1) return START_URL;
  return `${START_URL}&page=${pageNum}`;
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  // TEMPORARILY COMMENTED OUT FOR TESTING:
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error("Missing BLOB_READ_WRITE_TOKEN");
    }

    const sourceUrls = [];
    const pageSummaries = [];
    const dropCounts = makeDropCounts();
    const genderCounts = makeGenderCounts();
    const deals = [];
    const seenDeals = new Set();

    let pagesFetched = 0;
    let dealsFound = 0;
    let maxPages = 30;
    let totalExpected = null;

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const url = makePageUrl(pageNum);
      sourceUrls.push(url);

      const rawHtml = await firecrawlScrapeRawHtml(url);
      const { tiles, counts } = extractTilesFromHtml(rawHtml);

      if (pageNum === 1 && Number.isFinite(counts.totalCount)) {
        totalExpected = counts.totalCount;
        maxPages = Math.max(1, Math.ceil(totalExpected / 24) + 2);
      }

      if (!tiles.length) {
        break;
      }

      const pageDropCounts = makeDropCounts();
      const pageGenderCounts = makeGenderCounts();
      let pageDealsExtracted = 0;

      pagesFetched += 1;
      dealsFound += tiles.length;

      for (const tile of tiles) {
        increment(dropCounts, "totalTiles");
        increment(pageDropCounts, "totalTiles");

        const listingName = cleanText(tile.listingName);
        const listingURL = toAbsUrl(tile.listingURL);
        const imageURL = tile.imageURL || null;
        const pricing = parsePriceBlock(tile.pricingText, tile.priceTokens);

        if (!listingName) {
          increment(dropCounts, "dropped_missingListingName");
          increment(pageDropCounts, "dropped_missingListingName");
          continue;
        }

        if (!/running shoe/i.test(listingName)) {
          increment(dropCounts, "dropped_notRunningShoesTitle");
          increment(pageDropCounts, "dropped_notRunningShoesTitle");
          continue;
        }

        if (!listingURL) {
          increment(dropCounts, "dropped_missingListingURL");
          increment(pageDropCounts, "dropped_missingListingURL");
          continue;
        }

        if (!imageURL) {
          increment(dropCounts, "dropped_missingImageURL");
          increment(pageDropCounts, "dropped_missingImageURL");
          continue;
        }

        if (pricing.hiddenPrice) {
          increment(dropCounts, "dropped_hiddenPrice");
          increment(pageDropCounts, "dropped_hiddenPrice");
          continue;
        }

        const deal = buildDeal(tile);

        if (!hasAnySalePrice(deal)) {
          increment(dropCounts, "dropped_missingSalePrice");
          increment(pageDropCounts, "dropped_missingSalePrice");
          continue;
        }

        const dedupeKey =
          deal.listingURL ||
          `${deal.listingName}__${deal.salePrice ?? ""}__${deal.salePriceLow ?? ""}__${deal.salePriceHigh ?? ""}`;

        if (seenDeals.has(dedupeKey)) {
          increment(dropCounts, "dropped_duplicateAfterMerge");
          increment(pageDropCounts, "dropped_duplicateAfterMerge");
          continue;
        }

        seenDeals.add(dedupeKey);
        deals.push(deal);
        pageDealsExtracted += 1;

        increment(genderCounts, deal.gender);
        increment(pageGenderCounts, deal.gender);
      }

      pageSummaries.push({
        page: pageNum,
        url,
        shownText: counts.shownText,
        shownCount: counts.shownCount,
        totalCount: counts.totalCount,
        tilesSeenThisPage: tiles.length,
        dealsExtracted: pageDealsExtracted,
        genderCounts: pageGenderCounts,
        dropCounts: pageDropCounts,
      });

      if (
        Number.isFinite(counts.shownCount) &&
        Number.isFinite(counts.totalCount) &&
        counts.shownCount >= counts.totalCount
      ) {
        break;
      }
    }

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,

      pagesFetched,

      dealsFound,
      dealsExtracted: deals.length,

      dealsForMens: genderCounts.mens,
      dealsForWomens: genderCounts.womens,
      dealsForUnisex: genderCounts.unisex,
      dealsForUnknown: genderCounts.unknown,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      pageSummaries,
      dropCounts,

      deals,
    };

    const blob = await put(BLOB_PATH, JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
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
    });
  } catch (err) {
    console.error("SCHEELS FIRECRAWL SCRAPER ERROR:", err);

    return res.status(500).json({
      success: false,
      store: STORE,
      error: err?.message || String(err),
      scrapeDurationMs: Date.now() - startedAt,
      ok: false,
    });
  }
}
