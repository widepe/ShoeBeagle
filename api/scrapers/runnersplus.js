// /api/scrapers/runnersplus-shopify.js (CommonJS)
//
// Scrapes 3 Shopify collections via products.json, merges, dedupes,
// writes FULL payload (including deals[]) to Vercel Blob at /runnersplus.json,
// but returns ONLY top-level structure (no deals[]) when called.
//
// Rules:
// - shoeType ALWAYS "unknown"
// - gender derived from TITLE first (Men's/Women's/Unisex), fallback to collection gender
//
// CRON_SECRET auth included but COMMENTED OUT for testing.

const { put } = require("@vercel/blob");

const STORE = "Runners Plus";
const SCHEMA_VERSION = 1;
const VIA = "shopify-products-json";
const BASE = "https://www.runnersplus.com";

// Stable blob key (no random suffix => overwrite)
const BLOB_PATHNAME = "runnersplus.json"; // effectively /runnersplus.json

const DEFAULT_MAX_PAGES_PER_COLLECTION = 25;
const TIMEOUT_MS = 25_000;

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

// ---------- helpers ----------
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

  // Your honesty rule: require BOTH sale and original (compare_at_price) for a deal.
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
  let pagesFetched = 0;
  let productsSeen = 0;
  const deals = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE}/collections/${collectionHandle}/products.json?${query}&page=${page}`;

    const json = await fetchJson(url, TIMEOUT_MS);
    const products = Array.isArray(json?.products) ? json.products : [];

    pagesFetched++;

    if (!products.length) break;

    productsSeen += products.length;

    for (const p of products) {
      const d = buildDealFromProduct(p, fallbackGender);
      if (d) deals.push(d);
    }
  }

  return { pagesFetched, productsSeen, deals };
}

// ---------- handler ----------
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

  // Keep these stable + small (3 pages only)
  const sourceUrls = COLLECTIONS.map((c) => c.publicCollectionUrl);

  let pagesFetched = 0;
  let dealsFound = 0; // products seen
  let ok = true;
  let error = null;

  try {
    const allDeals = [];

    for (const c of COLLECTIONS) {
      const r = await scrapeCollection(c, maxPagesPerCollection);
      pagesFetched += r.pagesFetched;
      dealsFound += r.productsSeen;
      allDeals.push(...r.deals);
    }

    const dedupedDeals = uniqBy(allDeals, (d) => d.listingURL);

    // FULL payload (written to blob)
    const fullPayload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: dedupedDeals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      deals: dedupedDeals,
    };

    const blob = await put(BLOB_PATHNAME, JSON.stringify(fullPayload), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    // RESPONSE payload (NO deals[])
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

    // Still match your top-level structure even on failure
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
      const blob = await put(BLOB_PATHNAME, JSON.stringify(fullPayload), {
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
