// /api/scrapers/underarmour-outlet.js

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Under Armour";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";
const BASE_URL = "https://www.underarmour.com";

const CATEGORY_URLS = [
  {
    genderHint: "mens",
    baseUrl: "https://www.underarmour.com/en-us/c/outlet/mens/shoes/running/",
  },
  {
    genderHint: "womens",
    baseUrl: "https://www.underarmour.com/en-us/c/outlet/womens/shoes/running/",
  },
];

// Based on the behavior you found, only scrape pages 1 and 2.
const PAGE_NUMBERS = [1, 2];

function nowIso() {
  return new Date().toISOString();
}

function absoluteUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, BASE_URL).toString();
  } catch {
    return null;
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(html) {
  return cleanText(String(html || "").replace(/<[^>]*>/g, " "));
}

function normalizeApostrophes(s) {
  return String(s || "")
    .replace(/[\u2018\u2019\u2032\u00B4]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(text) {
  if (!text) return null;
  const m = String(text)
    .replace(/,/g, "")
    .match(/\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (
    typeof originalPrice !== "number" ||
    typeof salePrice !== "number" ||
    !isFinite(originalPrice) ||
    !isFinite(salePrice) ||
    originalPrice <= 0 ||
    salePrice >= originalPrice
  ) {
    return null;
  }
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function inferGender(subHeader, listingURL = "", fallbackGender = "unknown") {
  const s = normalizeApostrophes(subHeader).toLowerCase();

  if (s.includes("women's") || s.includes("womens")) return "womens";
  if (s.includes("men's") || s.includes("mens")) return "mens";
  if (s.includes("unisex")) return "unisex";

  const url = String(listingURL || "").toLowerCase();
  if (url.includes("_womens_") || url.includes("/womens/")) return "womens";
  if (url.includes("_mens_") || url.includes("/mens/")) return "mens";
  if (url.includes("_unisex_") || url.includes("/unisex/")) return "unisex";

  return fallbackGender;
}

function inferShoeType(subHeader) {
  const s = normalizeApostrophes(subHeader).toLowerCase();

  if (s.includes("trail")) return "trail";
  if (s.includes("track") || s.includes("spike")) return "track";
  if (s.includes("running")) return "road";
  return "unknown";
}

function modelFromListingName(listingName) {
  const raw = cleanText(listingName);
  return raw.replace(/^UA\s+/i, "").trim() || raw;
}

function incrementCounter(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + by;
}

function initDropCounts() {
  return {
    totalTiles: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingOriginalPrice: 0,
    dropped_missingSalePrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_duplicateAfterMerge: 0,
  };
}

function mergeDropCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (target[key] || 0) + (value || 0);
  }
  return target;
}

function buildPageUrl(baseUrl, pageNumber) {
  return pageNumber === 1 ? baseUrl : `${baseUrl}?page=${pageNumber}`;
}

async function fetchHtml(url) {
  const resp = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });

  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status} for ${url}`);
    err.status = resp.status;
    throw err;
  }

  return await resp.text();
}

function extractTiles(html) {
  const tiles = [];

  const patterns = [
    /<div[^>]+id="product-[^"]+"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi,
    /<article[^>]+id="product-[^"]+"[\s\S]*?<\/article>/gi,
    /<div[^>]+data-testid="product-tile"[\s\S]*?<\/div>\s*<\/div>/gi,
  ];

  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(html)) !== null) {
      tiles.push(match[0]);
    }
    if (tiles.length > 0) break;
  }

  const deduped = [];
  const seen = new Set();
  for (const tile of tiles) {
    const key = tile.slice(0, 300);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(tile);
  }

  return deduped;
}

function extractAttr(html, regex) {
  const m = html.match(regex);
  return m ? decodeHtml(m[1]) : null;
}

function extractSubHeader(tileHtml) {
  const raw =
    extractAttr(
      tileHtml,
      /<span[^>]+class="[^"]*ProductTile-module-scss-module__[^"]*product-sub-header[^"]*"[^>]*>([\s\S]*?)<\/span>/i
    ) ||
    extractAttr(
      tileHtml,
      /<span[^>]*>\s*((?:Men|Women|Unisex)[\s\S]*?Shoes?)\s*<\/span>/i
    ) ||
    "";

  return stripTags(raw);
}

function extractDealFromTile(tileHtml, dropCounts, fallbackGender) {
  incrementCounter(dropCounts, "totalTiles");

  const listingURL = absoluteUrl(
    extractAttr(
      tileHtml,
      /<a[^>]+class="[^"]*ProductTile-module-scss-module__[^"]*product-item-link[^"]*"[^>]+href="([^"]+)"/i
    ) ||
      extractAttr(
        tileHtml,
        /<a[^>]+class="[^"]*ProductTile-module-scss-module__[^"]*product-image-link[^"]*"[^>]+href="([^"]+)"/i
      ) ||
      extractAttr(
        tileHtml,
        /<a[^>]+href="([^"]+\/p\/[^"]+)"/i
      )
  );

  const imageURL = absoluteUrl(
    extractAttr(tileHtml, /<img[^>]+data-testid="tile-image"[^>]+src="([^"]+)"/i) ||
      extractAttr(tileHtml, /<img[^>]+src="([^"]*underarmour\.scene7\.com[^"]*)"/i) ||
      extractAttr(tileHtml, /<img[^>]+src="([^"]+)"/i)
  );

  const listingName =
    stripTags(
      extractAttr(
        tileHtml,
        /<a[^>]+class="[^"]*ProductTile-module-scss-module__[^"]*product-item-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i
      ) ||
        extractAttr(
          tileHtml,
          /<img[^>]+alt="([^"]+)"/i
        ) ||
        extractAttr(
          tileHtml,
          /<h2[^>]*>([\s\S]*?)<\/h2>/i
        ) ||
        extractAttr(
          tileHtml,
          /<h3[^>]*>([\s\S]*?)<\/h3>/i
        )
    ) || null;

  const subHeader = extractSubHeader(tileHtml);

  const srPriceText =
    stripTags(
      extractAttr(
        tileHtml,
        /<div[^>]+class="[^"]*PriceDisplay-module-scss-module__[^"]*sr-price[^"]*"[^>]*>([\s\S]*?)<\/div>/i
      )
    ) || "";

  let originalPrice = null;
  let salePrice = null;

  const originalMatch = srPriceText.match(
    /Original price:\s*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/i
  );
  const saleMatch = srPriceText.match(
    /Sale price:\s*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/i
  );

  if (originalMatch) originalPrice = Number(originalMatch[1]);
  if (saleMatch) salePrice = Number(saleMatch[1]);

  if (originalPrice == null) {
    originalPrice = parsePrice(
      extractAttr(
        tileHtml,
        /<span[^>]+data-testid="price-display-list-price"[^>]*>([\s\S]*?)<\/span>/i
      ) ||
        extractAttr(
          tileHtml,
          /<span[^>]*class="[^"]*list-price[^"]*"[^>]*>([\s\S]*?)<\/span>/i
        )
    );
  }

  if (salePrice == null) {
    salePrice = parsePrice(
      extractAttr(
        tileHtml,
        /<span[^>]+data-testid="price-display-sales-price"[^>]*>([\s\S]*?)<\/span>/i
      ) ||
        extractAttr(
          tileHtml,
          /<span[^>]*class="[^"]*sales-price[^"]*"[^>]*>([\s\S]*?)<\/span>/i
        )
    );
  }

  if (!listingName) {
    incrementCounter(dropCounts, "dropped_missingListingName");
    return null;
  }

  if (!listingURL) {
    incrementCounter(dropCounts, "dropped_missingListingURL");
    return null;
  }

  if (!imageURL) {
    incrementCounter(dropCounts, "dropped_missingImageURL");
    return null;
  }

  if (originalPrice == null) {
    incrementCounter(dropCounts, "dropped_missingOriginalPrice");
    return null;
  }

  if (salePrice == null) {
    incrementCounter(dropCounts, "dropped_missingSalePrice");
    return null;
  }

  if (!(salePrice < originalPrice)) {
    incrementCounter(dropCounts, "dropped_saleNotLessThanOriginal");
    return null;
  }

  return {
    schemaVersion: SCHEMA_VERSION,

    listingName,

    brand: "Under Armour",
    model: modelFromListingName(listingName),

    salePrice,
    originalPrice,
    discountPercent: computeDiscountPercent(originalPrice, salePrice),

    salePriceLow: null,
    salePriceHigh: null,
    originalPriceLow: null,
    originalPriceHigh: null,
    discountPercentUpTo: null,

    store: STORE,

    listingURL,
    imageURL,

    gender: inferGender(subHeader, listingURL, fallbackGender),
    shoeType: inferShoeType(subHeader),
  };
}

function makePageSummary({ genderHint, pageNumber, url, ok, error, tiles, extracted, dropCounts }) {
  return {
    genderHint,
    page: pageNumber,
    url,
    ok,
    error: error || null,
    tilesFound: tiles,
    dealsExtracted: extracted,
    droppedDeals:
      (dropCounts?.dropped_missingListingName || 0) +
      (dropCounts?.dropped_missingListingURL || 0) +
      (dropCounts?.dropped_missingImageURL || 0) +
      (dropCounts?.dropped_missingOriginalPrice || 0) +
      (dropCounts?.dropped_missingSalePrice || 0) +
      (dropCounts?.dropped_saleNotLessThanOriginal || 0),
  };
}

async function scrapeCategory({ baseUrl, genderHint }) {
  const sourceUrls = [];
  const deals = [];
  const pageSummaries = [];
  const dropCounts = initDropCounts();

  let pagesFetched = 0;

  for (const pageNumber of PAGE_NUMBERS) {
    const url = buildPageUrl(baseUrl, pageNumber);

    let html;
    try {
      html = await fetchHtml(url);
      pagesFetched += 1;
      sourceUrls.push(url);
    } catch (err) {
      pageSummaries.push(
        makePageSummary({
          genderHint,
          pageNumber,
          url,
          ok: false,
          error: err?.message || "Unknown fetch error",
          tiles: 0,
          extracted: 0,
          dropCounts: initDropCounts(),
        })
      );

      // Stop this category if page 2 or later fails.
      // If page 1 fails, this category simply yields no deals.
      break;
    }

    const beforeCount = deals.length;
    const beforeDrops = { ...dropCounts };

    const tiles = extractTiles(html);

    for (const tileHtml of tiles) {
      const deal = extractDealFromTile(tileHtml, dropCounts, genderHint);
      if (deal) deals.push(deal);
    }

    const extractedThisPage = deals.length - beforeCount;

    const deltaDropCounts = {};
    for (const key of Object.keys(dropCounts)) {
      deltaDropCounts[key] = (dropCounts[key] || 0) - (beforeDrops[key] || 0);
    }

    pageSummaries.push(
      makePageSummary({
        genderHint,
        pageNumber,
        url,
        ok: true,
        error: null,
        tiles: tiles.length,
        extracted: extractedThisPage,
        dropCounts: deltaDropCounts,
      })
    );

    // If a page comes back empty, stop.
    if (tiles.length === 0) break;

    // If page 2 has no extracted deals, that's fine; no more pages are attempted anyway.
  }

  return {
    sourceUrls,
    pagesFetched,
    deals,
    dropCounts,
    pageSummaries,
  };
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    // CRON auth (temporarily commented out for testing)
    /*
    const auth = req.headers.authorization;
    if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    */

    const perCategory = [];
    for (const category of CATEGORY_URLS) {
      const result = await scrapeCategory(category);
      perCategory.push(result);
    }

    const sourceUrls = perCategory.flatMap((x) => x.sourceUrls);
    const pagesFetched = perCategory.reduce((sum, x) => sum + x.pagesFetched, 0);
    const rawDeals = perCategory.flatMap((x) => x.deals);
    const pageSummaries = perCategory.flatMap((x) => x.pageSummaries);
    const dealsFound = rawDeals.length;

    const combinedDropCounts = initDropCounts();
    for (const result of perCategory) {
      mergeDropCounts(combinedDropCounts, result.dropCounts);
    }

    const seen = new Set();
    const deals = [];

    for (const deal of rawDeals) {
      const key = `${deal.listingURL}__${deal.salePrice}__${deal.originalPrice}`;
      if (seen.has(key)) {
        incrementCounter(combinedDropCounts, "dropped_duplicateAfterMerge");
        continue;
      }
      seen.add(key);
      deals.push(deal);
    }

    const dealsExtracted = deals.length;

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      dropCounts: combinedDropCounts,
      pageSummaries,

      deals,
    };

    const blob = await put("underarmour-outlet.json", JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return res.status(200).json({
      success: true,
      store: payload.store,
      schemaVersion: payload.schemaVersion,
      lastUpdated: payload.lastUpdated,
      via: payload.via,
      sourceUrls: payload.sourceUrls,
      pagesFetched: payload.pagesFetched,
      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,
      scrapeDurationMs: payload.scrapeDurationMs,
      ok: payload.ok,
      error: payload.error,
      dropCounts: payload.dropCounts,
      pageSummaries: payload.pageSummaries,
      blobUrl: blob.url,
    });
  } catch (err) {
    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls: [],
      pagesFetched: 0,

      dealsFound: 0,
      dealsExtracted: 0,

      scrapeDurationMs: Date.now() - startedAt,

      ok: false,
      error: err?.message || "Unknown error",

      dropCounts: initDropCounts(),
      pageSummaries: [],

      deals: [],
    };

    return res.status(500).json({
      success: false,
      store: payload.store,
      schemaVersion: payload.schemaVersion,
      lastUpdated: payload.lastUpdated,
      via: payload.via,
      sourceUrls: payload.sourceUrls,
      pagesFetched: payload.pagesFetched,
      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,
      scrapeDurationMs: payload.scrapeDurationMs,
      ok: payload.ok,
      error: payload.error,
      dropCounts: payload.dropCounts,
      pageSummaries: payload.pageSummaries,
    });
  }
}
