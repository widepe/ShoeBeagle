// /api/scrapers/underarmour-outlet.js

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Under Armour";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";
const BASE_URL = "https://www.underarmour.com";

const START_URLS = [
  "https://www.underarmour.com/en-us/c/outlet/mens/shoes/running/",
  "https://www.underarmour.com/en-us/c/outlet/womens/shoes/running/",
];

const MAX_PAGES = 10;

// CRON auth (temporarily commented out for testing)
/*
const auth = req.headers.authorization;
if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  return res.status(401).json({ success: false, error: "Unauthorized" });
}
*/

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
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(html) {
  return cleanText(String(html || "").replace(/<[^>]*>/g, " "));
}

function parsePrice(text) {
  if (!text) return null;
  const m = String(text).replace(/,/g, "").match(/\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
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

function inferGender(subHeader) {
  const s = String(subHeader || "").toLowerCase();

  if (s.includes("men's") || s.includes("mens")) return "mens";
  if (s.includes("women's") || s.includes("womens")) return "womens";
  if (s.includes("unisex")) return "unisex";
  return "unknown";
}

function inferShoeType(subHeader) {
  const s = String(subHeader || "").toLowerCase();

  if (s.includes("trail")) return "trail";
  if (s.includes("track") || s.includes("spike")) return "track";
  if (s.includes("running")) return "road";
  return "unknown";
}

function modelFromListingName(listingName) {
  const raw = cleanText(listingName);
  return raw.replace(/^UA\s+/i, "").trim() || raw;
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of arr) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

async function fetchHtml(url) {
  const resp = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
    },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }

  return await resp.text();
}

function extractTiles(html) {
  const matches = [...html.matchAll(/<div[^>]+id="product-[^"]+"[\s\S]*?<\/section><\/div>/gi)];
  if (matches.length) return matches.map((m) => m[0]);

  // fallback: tile container class
  return [
    ...html.matchAll(
      /<div[^>]+data-testid="product-tile-container"[\s\S]*?<\/section><\/div>/gi
    ),
  ].map((m) => m[0]);
}

function extractAttr(html, regex) {
  const m = html.match(regex);
  return m ? decodeHtml(m[1]) : null;
}

function extractDealFromTile(tileHtml) {
  const listingURL = absoluteUrl(
    extractAttr(
      tileHtml,
      /<a[^>]+class="[^"]*ProductTile-module-scss-module__[^"]*product-item-link[^"]*"[^>]+href="([^"]+)"/i
    ) ||
      extractAttr(
        tileHtml,
        /<a[^>]+class="[^"]*ProductTile-module-scss-module__[^"]*product-image-link[^"]*"[^>]+href="([^"]+)"/i
      )
  );

  const imageURL = absoluteUrl(
    extractAttr(
      tileHtml,
      /<img[^>]+data-testid="tile-image"[^>]+src="([^"]+)"/i
    )
  );

  const listingName =
    stripTags(
      extractAttr(
        tileHtml,
        /<a[^>]+class="[^"]*ProductTile-module-scss-module__[^"]*product-item-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i
      )
    ) || null;

  const subHeader =
    stripTags(
      extractAttr(
        tileHtml,
        /<span[^>]+class="[^"]*ProductTile-module-scss-module__[^"]*product-sub-header[^"]*"[^>]*>([\s\S]*?)<\/span>/i
      )
    ) || "";

  const srPriceText =
    stripTags(
      extractAttr(
        tileHtml,
        /<div[^>]+class="[^"]*PriceDisplay-module-scss-module__[^"]*sr-price[^"]*"[^>]*>([\s\S]*?)<\/div>/i
      )
    ) || "";

  let originalPrice = null;
  let salePrice = null;

  const originalMatch = srPriceText.match(/Original price:\s*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  const saleMatch = srPriceText.match(/Sale price:\s*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/i);

  if (originalMatch) originalPrice = Number(originalMatch[1]);
  if (saleMatch) salePrice = Number(saleMatch[1]);

  if (originalPrice == null) {
    originalPrice = parsePrice(
      extractAttr(
        tileHtml,
        /<span[^>]+data-testid="price-display-list-price"[^>]*>([\s\S]*?)<\/span>/i
      )
    );
  }

  if (salePrice == null) {
    salePrice = parsePrice(
      extractAttr(
        tileHtml,
        /<span[^>]+data-testid="price-display-sales-price"[^>]*>([\s\S]*?)<\/span>/i
      )
    );
  }

  if (!listingName || !listingURL || !imageURL) return null;
  if (salePrice == null || originalPrice == null) return null;

  const deal = {
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

    gender: inferGender(subHeader),
    shoeType: inferShoeType(subHeader),
  };

  return deal;
}

function extractNextUrl(html, currentUrl) {
  const nextHref =
    extractAttr(html, /<a[^>]+data-testid="pager-next"[^>]+href="([^"]+)"/i) ||
    extractAttr(html, /<a[^>]+aria-label="Go to the next page"[^>]+href="([^"]+)"/i);

  if (!nextHref) return null;

  const abs = absoluteUrl(nextHref);
  if (!abs || abs === currentUrl) return null;
  return abs;
}

async function scrapeCategory(startUrl) {
  const visited = new Set();
  const sourceUrls = [];
  const deals = [];

  let url = startUrl;
  let pagesFetched = 0;

  while (url && !visited.has(url) && pagesFetched < MAX_PAGES) {
    visited.add(url);
    sourceUrls.push(url);

    const html = await fetchHtml(url);
    pagesFetched += 1;

    const tiles = extractTiles(html);
    for (const tileHtml of tiles) {
      const deal = extractDealFromTile(tileHtml);
      if (deal) deals.push(deal);
    }

    url = extractNextUrl(html, url);
  }

  return {
    sourceUrls,
    pagesFetched,
    deals,
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
    for (const startUrl of START_URLS) {
      const result = await scrapeCategory(startUrl);
      perCategory.push(result);
    }

    const sourceUrls = perCategory.flatMap((x) => x.sourceUrls);
    const pagesFetched = perCategory.reduce((sum, x) => sum + x.pagesFetched, 0);
    const rawDeals = perCategory.flatMap((x) => x.deals);
    const dealsFound = rawDeals.length;

    const deals = uniqBy(rawDeals, (d) => `${d.listingURL}__${d.salePrice}__${d.originalPrice}`);
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
      ...payload,
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

      deals: [],
    };

    return res.status(500).json({
      success: false,
      ...payload,
    });
  }
}
