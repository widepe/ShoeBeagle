// /api/scrape-gazelle-sports.js  (CommonJS)
//
// ✅ Vercel-only scraper for Gazelle Sports men's + women's sale shoes.
// ✅ DOES NOT rely on client-rendered tiles.
// ✅ Instead: pulls product handles from each collection page HTML (regex),
//    then fetches Shopify product JSON per handle:
//    https://gazellesports.com/products/<handle>.json
//
// Rules (per your requirements):
// - Gender comes from the collection URL (mens/womens),
//   BUT if product title contains "unisex" OR "all gender" => gender = "unisex".
// - If deal states "soccer" anywhere (title/vendor/type/tags) => DROP.
// - shoeType is always "unknown".
// - Must have both sale + original price (compare_at_price) to be included.
// - Uses min(variant.price) as salePrice, max(variant.compare_at_price) as originalPrice.
// - Range fields are null (single price output).
//
// Output blob URL env:
//   GAZELLESPORTS_DEALS_BLOB_URL = https://.../gazelle-sports.json
//
// Notes:
// - This will make many requests (1 per product handle). Concurrency is limited.

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

function containsSoccerText(haystack) {
  return /\bsoccer\b/i.test(String(haystack || ""));
}

function toNum(s) {
  // Shopify product JSON has "45.95" strings
  const n = Number(String(s || "").trim());
  return Number.isFinite(n) ? n : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0) return null;
  const pct = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  return Number.isFinite(pct) ? pct : null;
}

// -----------------------------
// network
// -----------------------------
async function fetchText(url, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; ShoeBeagleBot/1.0; +https://shoebeagle.com)",
        accept: "text/html,application/xhtml+xml,application/json",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

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
// extraction
// -----------------------------
function extractProductHandlesFromHtml(html) {
  // Looks for /products/<handle> anywhere in the HTML payload
  const handles = new Set();
  const re = /\/products\/([a-z0-9][a-z0-9-]*)/gi;
  let m;
  while ((m = re.exec(html))) {
    handles.add(String(m[1]).toLowerCase());
  }
  return Array.from(handles);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// -----------------------------
// product -> deal
// -----------------------------
function buildDealFromProduct(product, baseSiteUrl, defaultGender) {
  // product is Shopify product object
  const handle = normalizeWs(product?.handle);
  const brand = normalizeWs(product?.vendor);
  const title = normalizeWs(product?.title);

  const tags = Array.isArray(product?.tags)
    ? product.tags.join(", ")
    : normalizeWs(product?.tags);

  const productType = normalizeWs(product?.product_type);

  const haystack = `${brand} ${title} ${productType} ${tags}`.trim();
  if (containsSoccerText(haystack)) return { __dropped: "soccer" };

  const gender = overrideGenderIfUnisex(title, defaultGender);

  const imageURL =
    normalizeWs(product?.image?.src) ||
    normalizeWs(product?.images?.[0]?.src) ||
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

  return {
    listingName: normalizeWs(`${brand} ${title}`),

    brand,
    model: title,

    salePrice,
    originalPrice,
    discountPercent,

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
// collection scrape (handles + products)
// -----------------------------
async function scrapeCollection(baseSiteUrl, collectionUrl, opts = {}) {
  const MAX_PAGES = Number.isFinite(opts.maxPages) ? opts.maxPages : 25;

  // keep concurrency conservative so you don't hammer the site
  const PRODUCT_CONCURRENCY = Number.isFinite(opts.productConcurrency) ? opts.productConcurrency : 8;

  const sourceUrls = [];
  const allHandles = new Set();

  let pagesFetched = 0;

  for (let p = 1; p <= MAX_PAGES; p++) {
    const pageUrl = p === 1 ? collectionUrl : `${collectionUrl}?p=${p}`;
    sourceUrls.push(pageUrl);

    const html = await fetchText(pageUrl);
    pagesFetched += 1;

    const handles = extractProductHandlesFromHtml(html);

    // Stop when nothing found OR when this page adds no new handles
    const before = allHandles.size;
    for (const h of handles) allHandles.add(h);
    const after = allHandles.size;

    if (handles.length === 0) break;
    if (after === before) break;
  }

  const handles = Array.from(allHandles);
  const defaultGender = deriveGenderFromCollectionUrl(collectionUrl);

  const dropCounts = {
    handlesFound: handles.length,
    dropped_soccer: 0,
    dropped_missingCore: 0,
    dropped_missingPrices: 0,
    dropped_badPrices: 0,
    dropped_notADeal: 0,
    dropped_fetchError: 0,
    kept: 0,
  };

  const deals = [];

  // Fetch each product JSON and build deal
  const productsOrErrors = await mapLimit(handles, PRODUCT_CONCURRENCY, async (handle) => {
    const url = `${baseSiteUrl}/products/${handle}.json`;
    try {
      const data = await fetchJson(url);
      return { ok: true, handle, product: data?.product || null };
    } catch (e) {
      return { ok: false, handle, error: e?.message || String(e) };
    }
  });

  for (const item of productsOrErrors) {
    if (!item?.ok) {
      dropCounts.dropped_fetchError += 1;
      continue;
    }
    const product = item.product;
    if (!product) {
      dropCounts.dropped_fetchError += 1;
      continue;
    }

    const dealOrDrop = buildDealFromProduct(product, baseSiteUrl, defaultGender);

    if (dealOrDrop && dealOrDrop.__dropped) {
      const k = dealOrDrop.__dropped;
      if (k === "soccer") dropCounts.dropped_soccer += 1;
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

  return {
    sourceUrls,
    pagesFetched,
    dealsFound: handles.length, // "found" here = handles discovered
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
    via: "cheerio", // keeping your field value; although we're not using cheerio now
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
    const mens = await scrapeCollection(BASE, MENS, { maxPages: 25, productConcurrency: 8 });
    const womens = await scrapeCollection(BASE, WOMENS, { maxPages: 25, productConcurrency: 8 });

    out.sourceUrls = [...mens.sourceUrls, ...womens.sourceUrls];
    out.pagesFetched = mens.pagesFetched + womens.pagesFetched;
    out.dealsFound = mens.dealsFound + womens.dealsFound;
    out.dealsExtracted = mens.dealsExtracted + womens.dealsExtracted;

    out.dropCounts = {
      mens: mens.dropCounts,
      womens: womens.dropCounts,
      total: {
        handlesFound: (mens.dropCounts.handlesFound || 0) + (womens.dropCounts.handlesFound || 0),
        dropped_soccer: mens.dropCounts.dropped_soccer + womens.dropCounts.dropped_soccer,
        dropped_missingCore: mens.dropCounts.dropped_missingCore + womens.dropCounts.dropped_missingCore,
        dropped_missingPrices: mens.dropCounts.dropped_missingPrices + womens.dropCounts.dropped_missingPrices,
        dropped_badPrices: mens.dropCounts.dropped_badPrices + womens.dropCounts.dropped_badPrices,
        dropped_notADeal: mens.dropCounts.dropped_notADeal + womens.dropCounts.dropped_notADeal,
        dropped_fetchError: mens.dropCounts.dropped_fetchError + womens.dropCounts.dropped_fetchError,
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
    out.error = e?.stack || e?.message || String(e);
  } finally {
    out.scrapeDurationMs = Date.now() - t0;
  }

  res.status(out.ok ? 200 : 500).json(out);
};
