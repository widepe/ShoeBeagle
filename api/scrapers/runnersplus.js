// /api/scrapers/runnersplus-shopify.js (CommonJS)
//
// Shopify products.json scraper for Runners Plus.
// - Scrapes 3 collections (mens-sale, womens-sale, sale/unisex)
// - MAX 12 pages per collection (per your request)
// - Stops early if a page adds 0 NEW product handles (prevents repeats)
// - Dedupes globally by listingURL
// - shoeType ALWAYS "unknown"
// - gender derived from TITLE first, fallback to collection gender
//
// Writes FULL payload (including deals[]) to Vercel Blob at /runnersplus.json,
// but returns ONLY the top-level structure + blobUrl (NO deals array).
//
// CRON_SECRET auth included but COMMENTED OUT for testing.

const { put } = require("@vercel/blob");

const STORE = "Runners Plus";
const SCHEMA_VERSION = 1;
const VIA = "shopify-products-json";
const BASE = "https://www.runnersplus.com";
const BLOB_PATHNAME = "runnersplus.json"; // stable overwrite => /runnersplus.json

const TIMEOUT_MS = 25_000;

// Your requested cap
const MAX_PAGES_PER_COLLECTION = 12;

// Stop if we hit this many consecutive pages with no new handles.
// 1 is fine; use 2 if you ever see an occasional “repeat-only” page in the middle.
const NO_NEW_PAGES_TO_STOP = 1;

const COLLECTIONS = [
  {
    id: "mens",
    fallbackGender: "mens",
    collectionHandle: "mens-sale",
    publicCollectionUrl:
      `${BASE}/collections/mens-sale?filter.v.availability=1&sort_by=created-descending`,
    query:
      "filter.p.product_type=Men+%3E+Shoes+%3E+Racing" +
      "&filter.p.product_type=Men+%3E+Shoes+%3E+Running" +
      "&filter.p.product_type=Men+%3E+Shoes+%3E+Track+%3E+Distance" +
      "&filter.p.product_type=Men+%3E+Shoes+%3E+Track+%3E+Mid-Distance" +
      "&filter.p.product_type=Men+%3E+Shoes+%3E+Track+%3E+Sprint" +
      "&filter.p.product_type=Men+%3E+Shoes+%3E+Trail" +
      "&filter.p.product_type=Men+%3E+Shoes+%3E+X-Country" +
      "&filter.v.availability=1" +
      "&sort_by=created-descending",
  },
  {
    id: "womens",
    fallbackGender: "womens",
    collectionHandle: "womens-sale",
    publicCollectionUrl:
      `${BASE}/collections/womens-sale?filter.v.availability=1&sort_by=created-descending`,
    query:
      "filter.p.product_type=Women+%3E+Shoes+%3E+Racing" +
      "&filter.p.product_type=Women+%3E+Shoes+%3E+Running" +
      "&filter.p.product_type=Women+%3E+Shoes+%3E+Track+%3E+Distance" +
      "&filter.p.product_type=Women+%3E+Shoes+%3E+Track+%3E+Mid-Distance" +
      "&filter.p.product_type=Women+%3E+Shoes+%3E+Track+%3E+Sprint" +
      "&filter.p.product_type=Women+%3E+Shoes+%3E+Trail" +
      "&filter.p.product_type=Women+%3E+Shoes+%3E+X-Country" +
      "&filter.v.availability=1" +
      "&sort_by=created-descending",
  },
  {
    id: "unisex",
    fallbackGender: "unisex",
    collectionHandle: "sale",
    publicCollectionUrl:
      `${BASE}/collections/sale?filter.v.availability=1&sort_by=created-descending`,
    query:
      "filter.p.product_type=Unisex+%3E+Shoes+%3E+Racing" +
      "&filter.p.product_type=Unisex+%3E+Shoes+%3E+Running" +
      "&filter.p.product_type=Unisex+%3E+Shoes+%3E+Track+%3E+Distance" +
      "&filter.p.product_type=Unisex+%3E+Shoes+%3E+Track+%3E+Field" +
      "&filter.p.product_type=Unisex+%3E+Shoes+%3E+Track+%3E+Mid-Distance" +
      "&filter.p.product_type=Unisex+%3E+Shoes+%3E+Track+%3E+Sprint" +
      "&filter.p.product_type=Unisex+%3E+Shoes+%3E+X-Country" +
      "&filter.v.availability=1" +
      "&sort_by=created-descending",
  },
];

// ---------------------------
// Helpers
// ---------------------------
function cleanInvisible(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/[\u00AD\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
}

function parseMoney(x) {
  if (x == null) return null;
  if (typeof x === "number") return x;
  const s = String(x).replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function computeDiscountPercent(original, sale) {
  if (!Number.isFinite(original) || !Number.isFinite(sale) || original <= 0) return null;
  return Math.round(((original - sale) / original) * 100);
}

function computeDiscountUpTo(originalHigh, saleLow) {
  if (!Number.isFinite(originalHigh) || !Number.isFinite(saleLow) || originalHigh <= 0) return null;
  return Math.round(((originalHigh - saleLow) / originalHigh) * 100);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveGenderFromTitleFirst(listingName, fallbackGender) {
  const t = cleanInvisible(listingName || "").toLowerCase();
  if (t.startsWith("men's ") || t.startsWith("mens ")) return "mens";
  if (t.startsWith("women's ") || t.startsWith("womens ")) return "womens";
  if (t.startsWith("unisex ")) return "unisex";
  return fallbackGender || "unisex";
}

function deriveModelFromTitle(title, vendor) {
  let t = cleanInvisible(title || "");
  const v = cleanInvisible(vendor || "");

  t = t
    .replace(/^Men['’]?s\s+/i, "")
    .replace(/^Women['’]?s\s+/i, "")
    .replace(/^Unisex\s+/i, "");

  if (v) {
    const re = new RegExp(`^${escapeRegExp(v)}\\s+`, "i");
    t = t.replace(re, "");
  }

  return cleanInvisible(t);
}

function pickImageUrl(product) {
  if (Array.isArray(product?.variants)) {
    for (const v of product.variants) {
      const src = v?.featured_image?.src;
      if (src) return src;
    }
  }
  if (Array.isArray(product?.images) && product.images.length) {
    if (typeof product.images[0] === "string") return product.images[0];
    if (product.images[0]?.src) return product.images[0].src;
  }
  if (product?.image?.src) return product.image.src;
  return null;
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} (${text.slice(0, 200)})`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function buildDealFromProduct(product, fallbackGender) {
  const listingName = cleanInvisible(product?.title || "");
  const brand = cleanInvisible(product?.vendor || "");
  const model = deriveModelFromTitle(listingName, brand);

  const listingURL = `${BASE}/products/${product.handle}`;
  const imageURL = pickImageUrl(product);

  const shoeType = "unknown";
  const gender = deriveGenderFromTitleFirst(listingName, fallbackGender);

  // HONESTY RULE: deal requires BOTH sale and original per variant (compare_at_price > price)
  const salePrices = [];
  const originalPrices = [];

  for (const v of product?.variants || []) {
    const sale = parseMoney(v?.price);
    const orig = parseMoney(v?.compare_at_price);
    if (Number.isFinite(sale) && Number.isFinite(orig) && orig > sale) {
      salePrices.push(sale);
      originalPrices.push(orig);
    }
  }

  if (!salePrices.length || !originalPrices.length) return null;

  const saleLow = Math.min(...salePrices);
  const saleHigh = Math.max(...salePrices);
  const originalLow = Math.min(...originalPrices);
  const originalHigh = Math.max(...originalPrices);

  const hasRange = saleLow !== saleHigh || originalLow !== originalHigh;

  return {
    schemaVersion: SCHEMA_VERSION,

    listingName,
    brand,
    model,

    salePrice: hasRange ? null : saleLow,
    originalPrice: hasRange ? null : originalLow,
    discountPercent: hasRange ? null : computeDiscountPercent(originalLow, saleLow),

    salePriceLow: hasRange ? saleLow : null,
    salePriceHigh: hasRange ? saleHigh : null,
    originalPriceLow: hasRange ? originalLow : null,
    originalPriceHigh: hasRange ? originalHigh : null,
    discountPercentUpTo: hasRange ? computeDiscountUpTo(originalHigh, saleLow) : null,

    store: STORE,
    listingURL,
    imageURL,

    gender,
    shoeType,
  };
}

async function scrapeCollection({ fallbackGender, collectionHandle, query }) {
  let pagesFetched = 0;
  let productsSeen = 0;

  const deals = [];
  const seenHandles = new Set();

  let consecutiveNoNew = 0;

  for (let page = 1; page <= MAX_PAGES_PER_COLLECTION; page++) {
    const url = `${BASE}/collections/${collectionHandle}/products.json?${query}&page=${page}`;
    const json = await fetchJson(url, TIMEOUT_MS);
    const products = Array.isArray(json?.products) ? json.products : [];

    pagesFetched++;

    if (!products.length) break;

    let addedThisPage = 0;

    for (const p of products) {
      const handle = cleanInvisible(p?.handle || "");
      if (!handle) continue;

      if (seenHandles.has(handle)) continue;
      seenHandles.add(handle);
      addedThisPage++;
      productsSeen++;

      const d = buildDealFromProduct(p, fallbackGender);
      if (d) deals.push(d);
    }

    if (addedThisPage === 0) {
      consecutiveNoNew++;
      if (consecutiveNoNew >= NO_NEW_PAGES_TO_STOP) break;
    } else {
      consecutiveNoNew = 0;
    }
  }

  return { pagesFetched, productsSeen, deals };
}

// ---------------------------
// Vercel handler
// ---------------------------
module.exports = async function handler(req, res) {
  const startedAt = Date.now();

  // =========================
  // CRON AUTH (TEMP DISABLED)
  // =========================
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const sourceUrls = COLLECTIONS.map((c) => c.publicCollectionUrl);

  let pagesFetched = 0;
  let dealsFound = 0; // products seen (unique per collection)
  let ok = true;
  let error = null;

  try {
    const allDeals = [];
    const seenListingUrl = new Set();

    for (const c of COLLECTIONS) {
      const r = await scrapeCollection(c);
      pagesFetched += r.pagesFetched;
      dealsFound += r.productsSeen;

      for (const d of r.deals) {
        if (!d?.listingURL) continue;
        if (seenListingUrl.has(d.listingURL)) continue;
        seenListingUrl.add(d.listingURL);
        allDeals.push(d);
      }
    }

    const fullPayload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: allDeals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      deals: allDeals,
    };

    // ✅ Pretty-print so the blob is readable (fixes "mushed together")
    const blob = await put(BLOB_PATHNAME, JSON.stringify(fullPayload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    // Response: NO deals[]
    const responsePayload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: fullPayload.lastUpdated,
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: fullPayload.dealsExtracted,

      scrapeDurationMs: fullPayload.scrapeDurationMs,

      ok: true,
      error: null,

      blobUrl: blob.url,
    };

    return res.status(200).json(responsePayload);
  } catch (e) {
    ok = false;
    error = String(e?.message || e);

    const fullPayload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: 0,

      scrapeDurationMs: Date.now() - startedAt,

      ok,
      error,

      deals: [],
    };

    let blobUrl = null;
    try {
      const blob = await put(BLOB_PATHNAME, JSON.stringify(fullPayload, null, 2), {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
      });
      blobUrl = blob.url;
    } catch (_) {}

    const responsePayload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: fullPayload.lastUpdated,
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: 0,

      scrapeDurationMs: fullPayload.scrapeDurationMs,

      ok,
      error,

      blobUrl,
    };

    return res.status(200).json(responsePayload);
  }
};
