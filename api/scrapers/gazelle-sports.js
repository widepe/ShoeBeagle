// /api/scrape-gazelle-sports.js  (CommonJS)
//
// ✅ Vercel-only scraper for Gazelle Sports men's + women's sale shoes.
// ✅ Avoids client-rendered tiles by using Shopify collection JSON endpoints:
//    https://gazellesports.com/collections/<collection-handle>/products.json?limit=250&page=1
//
// Rules (per your requirements):
// - Gender comes from the collection URL (mens/womens),
//   BUT if product title contains "unisex" OR "all gender" => gender = "unisex".
// - If "soccer" appears anywhere (title/vendor/type/tags) => DROP.
// - shoeType is always "unknown".
// - Must have both sale + original price (compare_at_price) to be included.
// - Uses min(variant.price) as salePrice, max(variant.compare_at_price) as originalPrice.
// - Range fields are null (single price output).
//
// Output blob URL env:
//   GAZELLESPORTS_DEALS_BLOB_URL = https://.../gazelle-sports.json

const { put } = require("@vercel/blob");

// -----------------------------
// tiny helpers
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}

function normalizeWs(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function safeLower(s) {
  return String(s || "").toLowerCase();
}

function deriveGenderFromCollectionUrl(url) {
  const u = safeLower(url);
  if (u.includes("/mens-") || u.includes("/mens")) return "mens";
  if (u.includes("/womens-") || u.includes("/womens")) return "womens";
  return "unknown";
}

function overrideGenderIfUnisex(title, defaultGender) {
  const t = safeLower(title);
  if (t.includes("unisex") || t.includes("all gender") || t.includes("all-gender")) return "unisex";
  return defaultGender;
}

function containsBannedWord(haystack) {
  return /\b(soccer|sandal|sandals)\b/i.test(String(haystack || ""));
}

function toNum(s) {
  // Shopify product JSON commonly has "45.95" strings
  const n = Number(String(s || "").trim());
  return Number.isFinite(n) ? n : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0) return null;
  const pct = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  return Number.isFinite(pct) ? pct : null;
}

// Optional: extract a cleaner model from title (keeps listingName unchanged)
function extractModelFromTitle(title) {
  let t = normalizeWs(title);

  // Strip leading gender phrase
  t = t
    .replace(/^Men's\s+/i, "")
    .replace(/^Women's\s+/i, "")
    .replace(/^All\s*Gender\s+/i, "");

  // Cut at " - " (colors/width usually follow)
  const dashIdx = t.indexOf(" - ");
  if (dashIdx !== -1) t = t.slice(0, dashIdx);

  // Cut at common descriptors
  const cutPhrases = [
    " Running Shoe",
    " Running Shoes",
  ];

  const lower = t.toLowerCase();
  for (const phrase of cutPhrases) {
    const idx = lower.indexOf(phrase.toLowerCase());
    if (idx !== -1) {
      t = t.slice(0, idx);
      break;
    }
  }

  return normalizeWs(t) || normalizeWs(title);
}

// -----------------------------
// network
// -----------------------------
async function fetchJson(url, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; ShoeBeagleBot/1.0; +https://shoebeagle.com)",
        accept: "application/json,text/plain,*/*",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// -----------------------------
// product -> deal
// -----------------------------
function buildDealFromProduct(product, baseSiteUrl, defaultGender) {
  const handle = normalizeWs(product?.handle);
  const brand = normalizeWs(product?.vendor);
  const title = normalizeWs(product?.title);

  const tags = Array.isArray(product?.tags) ? product.tags.join(", ") : normalizeWs(product?.tags);
  const productType = normalizeWs(product?.product_type);

  const haystack = `${brand} ${title} ${productType} ${tags}`.trim();
  if (containsBannedWord(haystack)) return { __dropped: "bannedWord" };

  const gender = overrideGenderIfUnisex(title, defaultGender);

  // Collection products.json typically includes images: [{ src, ... }]
  const imageURL =
    normalizeWs(product?.image?.src) ||
    normalizeWs(product?.images?.[0]?.src) ||
    normalizeWs(product?.images?.[0]) || // some themes expose array of strings
    null;

  let salePrice = null;
  let originalPrice = null;

  for (const v of product?.variants || []) {
    const p = toNum(v?.price);
    const c = toNum(v?.compare_at_price);

    if (Number.isFinite(p)) salePrice = salePrice == null ? p : Math.min(salePrice, p);
    if (Number.isFinite(c)) originalPrice = originalPrice == null ? c : Math.max(originalPrice, c);
  }

  const listingURL = handle ? `${baseSiteUrl}/products/${handle}` : null;

  if (!listingURL || !imageURL || !brand || !title) return { __dropped: "missingCore" };
  if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice)) return { __dropped: "missingPrices" };
  if (salePrice <= 0 || originalPrice <= 0) return { __dropped: "badPrices" };
  if (salePrice >= originalPrice) return { __dropped: "notADeal" };

  const discountPercent = computeDiscountPercent(originalPrice, salePrice);

  // Clean model (optional but recommended)
  const model = extractModelFromTitle(title);

  return {
    listingName: normalizeWs(`${brand} ${title}`),

    brand,
    model,

    salePrice,
    originalPrice,
    discountPercent,

    // ranges not used in this scraper (single-price output)
    salePriceLow: null,
    salePriceHigh: null,
    originalPriceLow: null,
    originalPriceHigh: null,
    discountPercentUpTo: null,

    store: "Gazelle Sports",

    listingURL,
    imageURL,

    gender,
    shoeType: "unknown",
  };
}

// -----------------------------
// scrape a Shopify collection via products.json
// -----------------------------
async function scrapeCollectionProductsJson(baseSiteUrl, collectionUrl, opts = {}) {
  const MAX_PAGES = Number.isFinite(opts.maxPages) ? opts.maxPages : 25;
  const LIMIT = Number.isFinite(opts.limit) ? opts.limit : 250;

  const sourceUrls = [];
  const defaultGender = deriveGenderFromCollectionUrl(collectionUrl);

  const dropCounts = {
    tilesFound: 0, // products seen across pages
    dropped_bannedWord: 0,
    dropped_missingCore: 0,
    dropped_missingPrices: 0,
    dropped_badPrices: 0,
    dropped_notADeal: 0,
    kept: 0,
  };

  const deals = [];
  const seenHandles = new Set();
  let pagesFetched = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = `${collectionUrl}/products.json?limit=${LIMIT}&page=${page}`;
    sourceUrls.push(pageUrl);

    const data = await fetchJson(pageUrl);
    const products = Array.isArray(data?.products) ? data.products : [];

    pagesFetched += 1;

    if (products.length === 0) break;

    // Track whether this page introduced any new products
    let addedThisPage = 0;

    for (const product of products) {
      const h = safeLower(product?.handle || "");
      if (h && seenHandles.has(h)) continue;
      if (h) {
        seenHandles.add(h);
        addedThisPage += 1;
      }

      dropCounts.tilesFound += 1;

      const dealOrDrop = buildDealFromProduct(product, baseSiteUrl, defaultGender);

      if (dealOrDrop && dealOrDrop.__dropped) {
        const k = dealOrDrop.__dropped;
        if (k === "bannedWord") dropCounts.dropped_bannedWord += 1;
        else if (k === "missingCore") dropCounts.dropped_missingCore += 1;
        else if (k === "missingPrices") dropCounts.dropped_missingPrices += 1;
        else if (k === "badPrices") dropCounts.dropped_badPrices += 1;
        else if (k === "notADeal") dropCounts.dropped_notADeal += 1;
        else dropCounts.dropped_missingCore += 1;
        continue;
      }

      deals.push(dealOrDrop);
      dropCounts.kept += 1;
    }

    // Early exit if the site repeats the same page over and over
    if (addedThisPage === 0) break;

    // If fewer than LIMIT returned, usually last page
    if (products.length < LIMIT) break;
  }

  return {
    sourceUrls,
    pagesFetched,
    dealsFound: dropCounts.tilesFound,
    dealsExtracted: deals.length,
    dropCounts,
    deals,
  };
}

// -----------------------------
// handler
// -----------------------------
module.exports = async function handler(req, res) {
  // ---------------------------------
  // CRON SECRET PROTECTION (commented out)
  // ---------------------------------
  // const CRON_SECRET = String(process.env.CRON_SECRET || "").trim();
  // if (CRON_SECRET) {
  //   const provided =
  //     String(req.headers["x-cron-secret"] || "").trim() ||
  //     String(req.query?.cron_secret || "").trim();
  //   if (provided !== CRON_SECRET) {
  //     return res.status(401).json({ ok: false, error: "Unauthorized: Invalid CRON_SECRET" });
  //   }
  // }

  const t0 = Date.now();

  const BASE = "https://gazellesports.com";
  const MENS = "https://gazellesports.com/collections/mens-sale-shoes";
  const WOMENS = "https://gazellesports.com/collections/womens-sale-shoes";

  const out = {
    store: "Gazelle Sports",
    schemaVersion: 1,
    lastUpdated: nowIso(),
    via: "shopify-products-json",
    sourceUrls: [],
    pagesFetched: 0,
    dealsFound: 0,
    dealsExtracted: 0,
    scrapeDurationMs: 0,
    ok: false,
    error: null,
    deals: [],
    dropCounts: {},
    blobUrl: null,
  };

  try {
    const mens = await scrapeCollectionProductsJson(BASE, MENS, { maxPages: 25, limit: 250 });
    const womens = await scrapeCollectionProductsJson(BASE, WOMENS, { maxPages: 25, limit: 250 });

    out.sourceUrls = [...mens.sourceUrls, ...womens.sourceUrls];
    out.pagesFetched = mens.pagesFetched + womens.pagesFetched;
    out.dealsFound = mens.dealsFound + womens.dealsFound;
    out.dealsExtracted = mens.dealsExtracted + womens.dealsExtracted;

    out.dropCounts = {
      mens: mens.dropCounts,
      womens: womens.dropCounts,
      total: {
        tilesFound: (mens.dropCounts.tilesFound || 0) + (womens.dropCounts.tilesFound || 0),
        dropped_soccer: mens.dropCounts.dropped_soccer + womens.dropCounts.dropped_soccer,
        dropped_missingCore: mens.dropCounts.dropped_missingCore + womens.dropCounts.dropped_missingCore,
        dropped_missingPrices: mens.dropCounts.dropped_missingPrices + womens.dropCounts.dropped_missingPrices,
        dropped_badPrices: mens.dropCounts.dropped_badPrices + womens.dropCounts.dropped_badPrices,
        dropped_notADeal: mens.dropCounts.dropped_notADeal + womens.dropCounts.dropped_notADeal,
        kept: mens.dropCounts.kept + womens.dropCounts.kept,
      },
    };

    out.deals = [...mens.deals, ...womens.deals];

    // -----------------------------
    // BLOB WRITE (env-driven path)
    // -----------------------------
    const blobUrl = String(process.env.GAZELLESPORTS_DEALS_BLOB_URL || "").trim();
    if (!blobUrl) throw new Error("Missing GAZELLESPORTS_DEALS_BLOB_URL env var");

    let blobPath;
    try {
      blobPath = new URL(blobUrl).pathname.replace(/^\//, "");
    } catch {
      throw new Error("Invalid GAZELLESPORTS_DEALS_BLOB_URL (not a URL)");
    }
    if (!blobPath) throw new Error("Invalid GAZELLESPORTS_DEALS_BLOB_URL (missing pathname)");

    const putRes = await put(blobPath, JSON.stringify(out, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    out.blobUrl = putRes?.url || blobUrl;

    out.ok = true;
    out.error = null;
  } catch (e) {
    out.ok = false;
    out.error = e?.stack || e?.message || String(e) || "Unknown error";
  } finally {
    out.scrapeDurationMs = Date.now() - t0;
  }

  // Return a summary response (no deals array), but deals ARE still in the blob.
  const responseOut = { ...out };
  delete responseOut.deals;

  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(out.ok ? 200 : 500).json(responseOut);
};
