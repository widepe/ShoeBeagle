// /api/scrapers/runnersplus-shopify.js  (CommonJS)
//
// Runners Plus Shopify scraper using products.json (FAST).
// Scrapes 3 collections (mens / womens / unisex), merges, dedupes, returns your top-level structure,
// AND uploads the full payload JSON to Vercel Blob at a STABLE pathname: /runnersplus.json
//
// Rules per you:
// - shoeType ALWAYS "unknown"
// - gender derived from TITLE first (Men's/Women's/Unisex), fallback to collection gender
// - brand from product.vendor
// - model from title (strip gender prefix + brand prefix)
//
// CRON_SECRET auth included but COMMENTED OUT for testing.

const { put } = require("@vercel/blob");

const STORE = "Runners Plus";
const SCHEMA_VERSION = 1;
const VIA = "shopify-products-json";

const BASE = "https://www.runnersplus.com";

// Safety + runtime limits
const DEFAULT_MAX_PAGES_PER_COLLECTION = 25;
const TIMEOUT_MS = 25_000;

// Where to write in Vercel Blob (stable overwrite)
const BLOB_PATHNAME = "runnersplus.json"; // corresponds to /runnersplus.json

// ---------------------------
// Collections to scrape
// ---------------------------
const COLLECTIONS = [
  {
    id: "mens",
    fallbackGender: "mens",
    collectionHandle: "mens-sale",
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
  // Remove soft hyphen, zero-width chars, BOM, NBSP, etc.
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
  const pct = ((original - sale) / original) * 100;
  return Math.round(pct);
}

function computeDiscountUpTo(originalHigh, saleLow) {
  if (!Number.isFinite(originalHigh) || !Number.isFinite(saleLow) || originalHigh <= 0) return null;
  const pct = ((originalHigh - saleLow) / originalHigh) * 100;
  return Math.round(pct);
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

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0",
      },
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

  // HONESTY RULE: require BOTH sale + original per *variant*
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

async function scrapeCollection({ fallbackGender, collectionHandle, query }, maxPages) {
  const sourceUrls = [];
  let pagesFetched = 0;
  let productsFound = 0;
  const deals = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE}/collections/${collectionHandle}/products.json?${query}&page=${page}`;

    const json = await fetchJson(url, TIMEOUT_MS);
    const products = Array.isArray(json?.products) ? json.products : [];

    sourceUrls.push(url);
    pagesFetched++;

    if (!products.length) break;

    productsFound += products.length;

    for (const p of products) {
      const d = buildDealFromProduct(p, fallbackGender);
      if (d) deals.push(d);
    }
  }

  return { sourceUrls, pagesFetched, productsFound, deals };
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

  const maxPagesPerCollection = Math.min(
    Number(req.query.maxPages || DEFAULT_MAX_PAGES_PER_COLLECTION) || DEFAULT_MAX_PAGES_PER_COLLECTION,
    100
  );

  const allSourceUrls = [];
  let pagesFetchedTotal = 0;
  let dealsFound = 0;

  try {
    const allDeals = [];

    for (const c of COLLECTIONS) {
      const result = await scrapeCollection(c, maxPagesPerCollection);
      allSourceUrls.push(...result.sourceUrls);
      pagesFetchedTotal += result.pagesFetched;
      dealsFound += result.productsFound; // "dealsFound" as "products seen" (matches your prior usage)
      allDeals.push(...result.deals);
    }

    const dedupedDeals = uniqBy(allDeals, (d) => d.listingURL);

    // ---------------------------
    // TOP-LEVEL STRUCTURE (yours)
    // ---------------------------
    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls: allSourceUrls,
      pagesFetched: pagesFetchedTotal,

      dealsFound,
      dealsExtracted: dedupedDeals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      // extra (your other scrapers often include deals in the payload)
      deals: dedupedDeals,
    };

    // ---------------------------
    // WRITE TO VERCEL BLOB
    // ---------------------------
    // Stable overwrite at /runnersplus.json (pathname runnersplus.json)
    const blob = await put(BLOB_PATHNAME, JSON.stringify(payload), {
      access: "public",
      addRandomSuffix: false, // CRITICAL: stable overwrite
      contentType: "application/json",
    });

    // You didn’t require blobUrl in top-level, but it's useful and non-breaking.
    payload.blobUrl = blob.url;

    return res.status(200).json(payload);
  } catch (e) {
    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls: allSourceUrls,
      pagesFetched: pagesFetchedTotal,

      dealsFound,
      dealsExtracted: 0,

      scrapeDurationMs: Date.now() - startedAt,

      ok: false,
      error: String(e?.message || e),

      deals: [],
    };

    // Try to write the error payload too (optional, but keeps blob updated)
    try {
      const blob = await put(BLOB_PATHNAME, JSON.stringify(payload), {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
      });
      payload.blobUrl = blob.url;
    } catch (_) {
      // ignore blob write errors in failure response
    }

    return res.status(200).json(payload);
  }
};
