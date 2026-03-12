// /api/scrapers/dsw.js
//
// DSW clearance running shoes scraper
//
// What this does
// - Uses Firecrawl raw HTML to fetch rendered page HTML
// - Scrapes all pages from exactly 1 category path:
//   https://www.dsw.com/category/clearance/shoes/athletic-sneakers/running?gender=Men,Women
// - Uses DSW pagination offsets like &No=60, &No=120, etc.
// - Sets shoeType = "unknown" for all deals
// - Price rule:
//   * one visible price  -> salePrice only
//   * two visible prices -> salePrice = first/lower, originalPrice = second/higher
// - Skips hidden-price phrases like:
//     "see price in cart"
//     "add to bag to see price"
//     "see price in bag"
//     and similar
// - Writes dsw-firecrawl.json to Vercel Blob
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//   - FIRECRAWL_API_KEY
//
// TEST:
//   /api/scrapers/dsw

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "DSW";
const SCHEMA_VERSION = 1;
const VIA = "firecrawl-raw-html";
const BLOB_PATH = "dsw-firecrawl.json";

const SOURCE_URL =
  "https://www.dsw.com/category/clearance/shoes/athletic-sneakers/running?gender=Men,Women";

const PAGE_SIZE = 60;
const MAX_PAGES = 20;

const HIDDEN_PRICE_PATTERNS = [
  /see\s+price\s+in\s+cart/i,
  /see\s+price\s+in\s+bag/i,
  /price\s+in\s+cart/i,
  /price\s+in\s+bag/i,
  /add\s+to\s+bag\s+to\s+see\s+price/i,
  /add\s+to\s+cart\s+to\s+see\s+price/i,
  /add\s+for\s+price/i,
  /see\s+final\s+price/i,
];

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function toAbsoluteUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://www.dsw.com${url}`;
  return `https://www.dsw.com/${url.replace(/^\/+/, "")}`;
}

function parseAllMoney(text) {
  if (!text) return [];
  const matches = [...String(text).replace(/,/g, "").matchAll(/\$?\s*(\d+(?:\.\d{1,2})?)/g)];
  return matches.map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
}

function hasHiddenPriceText(text) {
  const s = cleanText(text);
  return HIDDEN_PRICE_PATTERNS.some((re) => re.test(s));
}

function inferGender(listingName) {
  const s = cleanText(listingName).toLowerCase();
  if (/\bmen'?s\b/.test(s) || /\bmens\b/.test(s)) return "mens";
  if (/\bwomen'?s\b/.test(s) || /\bwomens\b/.test(s)) return "womens";
  if (/\bunisex\b/.test(s)) return "unisex";
  return "unknown";
}

function extractBrandAndModel(listingName) {
  const cleaned = cleanText(listingName);
  if (!cleaned) return { brand: "Unknown", model: "" };

  const base = cleaned
    .replace(/\s*-\s*(men'?s|women'?s|womens|mens|unisex)\s*$/i, "")
    .trim();

  const multiWordBrands = [
    "Under Armour",
    "New Balance",
    "On",
    "Brooks",
    "ASICS",
    "Saucony",
    "HOKA",
    "Nike",
    "adidas",
    "PUMA",
    "Mizuno",
    "Altra",
    "Topo",
    "Merrell",
    "Salomon",
    "Reebok",
    "Skechers",
  ];

  const matchedBrand = multiWordBrands.find(
    (b) => base.toLowerCase() === b.toLowerCase() || base.toLowerCase().startsWith(b.toLowerCase() + " ")
  );

  if (matchedBrand) {
    return {
      brand: matchedBrand,
      model: base.slice(matchedBrand.length).trim(),
    };
  }

  const parts = base.split(/\s+/).filter(Boolean);
  if (!parts.length) return { brand: "Unknown", model: "" };

  return {
    brand: parts[0],
    model: parts.slice(1).join(" ").trim(),
  };
}

function parseResultsCount($) {
  const text = cleanText($(".product-listing__products--total-count").first().text());
  const match = text.match(/\b(\d{1,6})\s+Results\b/i);
  return match ? Number(match[1]) : null;
}

function initDropCounts() {
  return {
    totalTiles: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_hidden_price_text: 0,
    dropped_duplicateAfterMerge: 0,
  };
}

function initGenderCounts() {
  return {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };
}

function bumpDrop(dropCounts, reason) {
  const map = {
    missingListingName: "dropped_missingListingName",
    missingListingURL: "dropped_missingListingURL",
    missingImageURL: "dropped_missingImageURL",
    missingSalePrice: "dropped_missingSalePrice",
    hidden_price_text: "dropped_hidden_price_text",
    duplicateAfterMerge: "dropped_duplicateAfterMerge",
  };
  const key = map[reason];
  if (key) dropCounts[key] += 1;
}

function dedupeDeals(deals, dropCounts) {
  const seen = new Set();
  const out = [];

  for (const deal of deals) {
    const key = deal.listingURL;
    if (seen.has(key)) {
      bumpDrop(dropCounts, "duplicateAfterMerge");
      continue;
    }
    seen.add(key);
    out.push(deal);
  }

  return out;
}

function makePageUrl(baseUrl, offset) {
  if (!offset) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.set("No", String(offset));
  return url.toString();
}

async function fetchFirecrawlHtml(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY");

  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["html"],
      onlyMainContent: false,
      waitFor: 2000,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Firecrawl HTTP ${resp.status} for ${url} | ${text.slice(0, 300)}`);
  }

  const json = await resp.json();

  const html =
    json?.data?.html ||
    json?.html ||
    "";

  if (!html || typeof html !== "string") {
    throw new Error(`Firecrawl returned no HTML for ${url}`);
  }

  return html;
}

function parseTile($tile) {
  const tileText = cleanText($tile.text());

  if (hasHiddenPriceText(tileText)) {
    return {
      ok: false,
      reason: "hidden_price_text",
      detail: tileText.slice(0, 220),
    };
  }

  const listingName = cleanText(
    $tile.find('[data-testid="product-tile__name"]').first().text()
  );

  if (!listingName) {
    return { ok: false, reason: "missingListingName", detail: null };
  }

  const rawHref =
    $tile.find("a.product-tile__pdp-link").first().attr("href") ||
    $tile.find('a[href*="/product/"]').first().attr("href") ||
    "";

  const listingURL = toAbsoluteUrl(rawHref);
  if (!listingURL) {
    return { ok: false, reason: "missingListingURL", detail: listingName };
  }

  let imageURL =
    $tile.find("img").first().attr("src") ||
    $tile.find("img").first().attr("srcset") ||
    $tile.find("source").first().attr("srcset") ||
    "";

  if (imageURL && imageURL.includes(",")) {
    imageURL = imageURL.split(",")[0].trim().split(" ")[0].trim();
  }

  imageURL = decodeHtmlEntities(toAbsoluteUrl(imageURL));
  if (!imageURL) {
    return { ok: false, reason: "missingImageURL", detail: listingName };
  }

  const priceText = cleanText(
    $tile.find(".product-tile__price, [data-testid='product-tile__details-container']").first().text()
  );

  if (hasHiddenPriceText(priceText)) {
    return { ok: false, reason: "hidden_price_text", detail: listingName };
  }

  const moneyValues = parseAllMoney(priceText);
  if (!moneyValues.length) {
    return {
      ok: false,
      reason: "missingSalePrice",
      detail: `${listingName} | ${priceText.slice(0, 200)}`,
    };
  }

  let salePrice = null;
  let originalPrice = null;

  if (moneyValues.length === 1) {
    salePrice = moneyValues[0];
  } else {
    salePrice = moneyValues[0];
    originalPrice = moneyValues[1];
  }

  const gender = inferGender(listingName);
  const { brand, model } = extractBrandAndModel(listingName);

  return {
    ok: true,
    deal: {
      schemaVersion: SCHEMA_VERSION,
      listingName,
      brand,
      model,
      salePrice,
      originalPrice,
      discountPercent: null,
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,
      store: STORE,
      listingURL,
      imageURL,
      gender,
      shoeType: "unknown",
    },
  };
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const dropCounts = initDropCounts();
  const genderCounts = initGenderCounts();
  const pageSummaries = [];
  const rawDeals = [];
  const fetchedPageUrls = [];

  try {
    const firstHtml = await fetchFirecrawlHtml(SOURCE_URL);
    const $first = cheerio.load(firstHtml);

    const resultsCount = parseResultsCount($first);
    const totalPages = resultsCount
      ? Math.min(Math.ceil(resultsCount / PAGE_SIZE), MAX_PAGES)
      : 1;

    for (let pageNum = 1; pageNum <= totalPages; pageNum += 1) {
      const offset = (pageNum - 1) * PAGE_SIZE;
      const pageUrl = makePageUrl(SOURCE_URL, offset);

      let html;
      try {
        html = pageNum === 1 ? firstHtml : await fetchFirecrawlHtml(pageUrl);
      } catch (err) {
        pageSummaries.push({
          sourceUrl: SOURCE_URL,
          page: pageNum,
          pageUrl,
          shoeType: "unknown",
          ok: false,
          error: err?.message || String(err),
          totalTiles: 0,
          extractedDealsBeforeDedupe: 0,
          extractedDeals: 0,
          mensDeals: 0,
          womensDeals: 0,
          unisexDeals: 0,
          unknownDeals: 0,
          dropCounts: {
            missingListingName: 0,
            missingListingURL: 0,
            missingImageURL: 0,
            missingSalePrice: 0,
            hidden_price_text: 0,
          },
        });
        continue;
      }

      fetchedPageUrls.push(pageUrl);

      const $ = cheerio.load(html);
      const $tiles = $("app-product-tile");

      const pageDropCounts = {
        missingListingName: 0,
        missingListingURL: 0,
        missingImageURL: 0,
        missingSalePrice: 0,
        hidden_price_text: 0,
      };

      const pageGenderCounts = {
        mens: 0,
        womens: 0,
        unisex: 0,
        unknown: 0,
      };

      $tiles.each((_, el) => {
        dropCounts.totalTiles += 1;

        const result = parseTile($(el));

        if (!result.ok) {
          pageDropCounts[result.reason] = (pageDropCounts[result.reason] || 0) + 1;
          bumpDrop(dropCounts, result.reason);
          return;
        }

        const deal = result.deal;
        rawDeals.push(deal);

        if (pageGenderCounts[deal.gender] !== undefined) pageGenderCounts[deal.gender] += 1;
        if (genderCounts[deal.gender] !== undefined) genderCounts[deal.gender] += 1;
      });

      pageSummaries.push({
        sourceUrl: SOURCE_URL,
        page: pageNum,
        pageUrl,
        shoeType: "unknown",
        ok: true,
        error: null,
        totalTiles: $tiles.length,
        extractedDealsBeforeDedupe: rawDeals.length,
        extractedDeals: null,
        mensDeals: pageGenderCounts.mens,
        womensDeals: pageGenderCounts.womens,
        unisexDeals: pageGenderCounts.unisex,
        unknownDeals: pageGenderCounts.unknown,
        dropCounts: pageDropCounts,
      });

      if ($tiles.length === 0) break;
    }

    const deals = dedupeDeals(rawDeals, dropCounts);

    for (const summary of pageSummaries) {
      if (summary.ok && summary.extractedDeals === null) {
        summary.extractedDeals = summary.extractedDealsBeforeDedupe;
      }
    }

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,
      sourceUrls: [SOURCE_URL],
      pagesFetched: fetchedPageUrls.length,
      dealsFound: dropCounts.totalTiles,
      dealsExtracted: deals.length,
      scrapeDurationMs: Date.now() - startedAt,
      ok: true,
      error: null,
      dropCounts,
      genderCounts,
      pageSummaries,
      deals,
    };

    const blob = await put(BLOB_PATH, JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json; charset=utf-8",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobUrl: blob.url,
      pagesFetched: payload.pagesFetched,
      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,
      scrapeDurationMs: payload.scrapeDurationMs,
      dropCounts: payload.dropCounts,
      genderCounts: payload.genderCounts,
      pageSummaries: payload.pageSummaries,
      ok: true,
      error: null,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: err?.message || String(err),
      scrapeDurationMs: Date.now() - startedAt,
      dropCounts,
      genderCounts,
      pageSummaries,
    });
  }
}
