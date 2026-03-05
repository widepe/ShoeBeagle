// /api/scrapers/runnersplus-shopify.js (CommonJS)
//
// "UI-truth" scraper for Runners Plus Shopify collections using section-rendered HTML.
// This matches the site's Load More behavior and stops at the end of the visible grid.
//
// - Scrapes 3 collections (mens-sale, womens-sale, sale/unisex)
// - Requests: /collections/<handle>?<filters>&page=N&section_id=template--...__main-product-grid
// - Extracts product cards from returned HTML
// - Stops when Load More is gone OR no cards OR no new product URLs
//
// Then for each product URL, fetches /products/<handle>.json to get vendor + variants prices
// to build your canonical deal schema.
//
// Writes FULL payload (including deals[]) to Vercel Blob at /runnersplus.json,
// but returns ONLY top-level structure + blobUrl (NO deals array).
//
// CRON_SECRET auth included but COMMENTED OUT for testing.

const { put } = require("@vercel/blob");

const STORE = "Runners Plus";
const SCHEMA_VERSION = 1;
const VIA = "shopify-section-html";
const BASE = "https://www.runnersplus.com";
const BLOB_PATHNAME = "runnersplus.json";

// This is the section_id you provided
const SECTION_ID = "template--17517802455216__main-product-grid";

// Network
const TIMEOUT_MS = 25_000;

// Safety guards (not the primary stopping logic; primary is UI "Load more" disappearing)
const MAX_GRID_PAGES_PER_COLLECTION = 50;
const MAX_PRODUCTS_TO_DETAIL_FETCH = 2000; // huge safety
const MAX_CONCURRENT_PRODUCT_JSON_FETCHES = 8;

// ---------------------------
// Collections (same three)
// ---------------------------
const COLLECTIONS = [
  {
    id: "mens",
    fallbackGender: "mens",
    handle: "mens-sale",
    publicUrl:
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
    handle: "womens-sale",
    publicUrl:
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
    handle: "sale",
    publicUrl:
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

function makeAbsoluteUrl(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return "https:" + href;
  if (href.startsWith("/")) return BASE + href;
  return BASE + "/" + href;
}

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "text/html,*/*", "user-agent": "Mozilla/5.0" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} (${text.slice(0, 200)})`);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
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

// Extract product URLs from section HTML.
// Based on your outerHTML: product cards contain <a href="/products/<handle>...">
function extractProductUrlsFromSectionHtml(html) {
  const urls = new Set();

  // Grab /products/<handle> links
  const re = /href="(\/products\/[^"?]+)(?:\?[^"]*)?"/g;
  let m;
  while ((m = re.exec(html))) {
    const path = m[1];
    if (!path.startsWith("/products/")) continue;
    urls.add(BASE + path);
  }

  return Array.from(urls);
}

// Detect if "Load more" exists in section HTML
function hasLoadMore(html) {
  // Your example: <a ... class="button button-primary ...">Load more</a>
  // Make it tolerant:
  return /Load more/i.test(html) && /page=\d+/i.test(html);
}

// Fetch product details from /products/<handle>.json
async function fetchProductJsonByProductUrl(productUrl) {
  // productUrl: https://www.runnersplus.com/products/mens-hoka-bondi-14
  const u = new URL(productUrl);
  const parts = u.pathname.split("/").filter(Boolean);
  const handle = parts[1]; // ["products", "<handle>"]
  if (!handle) throw new Error(`Could not parse handle from ${productUrl}`);
  const url = `${BASE}/products/${handle}.json`;
  const json = await fetchJson(url, TIMEOUT_MS);
  // Shopify returns { product: {...} }
  return json?.product || null;
}

function buildDealFromProductJson(product, fallbackGender) {
  const listingName = cleanInvisible(product?.title || "");
  const brand = cleanInvisible(product?.vendor || "");
  const model = deriveModelFromTitle(listingName, brand);

  const listingURL = `${BASE}/products/${product.handle}`;
  const imageURL =
    product?.image?.src ||
    (Array.isArray(product?.images) && product.images[0] ? product.images[0].src || product.images[0] : null) ||
    null;

  const shoeType = "unknown";
  const gender = deriveGenderFromTitleFirst(listingName, fallbackGender);

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

async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;

  async function runOne() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await worker(items[idx], idx);
    }
  }

  const workers = [];
  for (let k = 0; k < Math.max(1, limit); k++) workers.push(runOne());
  await Promise.all(workers);
  return out;
}

// Scrape UI grid pages for one collection until Load More ends / no cards / repeats.
async function scrapeCollectionGrid(collection, pageNotes) {
  const { handle, query } = collection;

  const seenProductUrls = new Set();
  const orderedUrls = [];

  let pagesFetched = 0;

  for (let page = 1; page <= MAX_GRID_PAGES_PER_COLLECTION; page++) {
    const url = `${BASE}/collections/${handle}?${query}&page=${page}&section_id=${SECTION_ID}`;

    const html = await fetchText(url, TIMEOUT_MS);
    pagesFetched++;

    const productUrls = extractProductUrlsFromSectionHtml(html);

    // add only new product URLs
    let added = 0;
    for (const pu of productUrls) {
      if (seenProductUrls.has(pu)) continue;
      seenProductUrls.add(pu);
      orderedUrls.push(pu);
      added++;
    }

    pageNotes.push({
      url,
      cards: productUrls.length,
      addedUnique: added,
      hasLoadMore: hasLoadMore(html),
    });

    // Stop conditions (UI-truth + repeat-safety)
    if (productUrls.length === 0) break;
    if (added === 0) break; // repeating grid
    if (!hasLoadMore(html)) break; // UI says no more
  }

  return { pagesFetched, productUrls: orderedUrls };
}

// ---------------------------
// Handler
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

  const sourceUrls = COLLECTIONS.map((c) => c.publicUrl);

  let pagesFetched = 0;
  let dealsFound = 0; // product cards (unique URLs) discovered across grids
  let ok = true;
  let error = null;

  const pageNotes = [];

  try {
    // 1) Collect product URLs using UI grid pagination
    const allProductUrls = [];
    for (const c of COLLECTIONS) {
      const r = await scrapeCollectionGrid(c, pageNotes);
      pagesFetched += r.pagesFetched;
      allProductUrls.push(
        ...r.productUrls.map((u) => ({ url: u, fallbackGender: c.fallbackGender }))
      );
    }

    // global dedupe by product URL
    const seenUrl = new Set();
    const dedupedProductUrls = [];
    for (const item of allProductUrls) {
      if (seenUrl.has(item.url)) continue;
      seenUrl.add(item.url);
      dedupedProductUrls.push(item);
    }

    dealsFound = dedupedProductUrls.length;

    if (dealsFound > MAX_PRODUCTS_TO_DETAIL_FETCH) {
      throw new Error(
        `Too many products discovered (${dealsFound}). Increase MAX_PRODUCTS_TO_DETAIL_FETCH only if intended.`
      );
    }

    // 2) Fetch product JSON details (concurrent) and build deals
    const products = await mapWithConcurrency(
      dedupedProductUrls,
      MAX_CONCURRENT_PRODUCT_JSON_FETCHES,
      async (item) => {
        const p = await fetchProductJsonByProductUrl(item.url);
        return { product: p, fallbackGender: item.fallbackGender };
      }
    );

    const deals = [];
    const seenListingUrl = new Set();

    for (const { product, fallbackGender } of products) {
      if (!product) continue;
      const d = buildDealFromProductJson(product, fallbackGender);
      if (!d) continue;
      if (seenListingUrl.has(d.listingURL)) continue;
      seenListingUrl.add(d.listingURL);
      deals.push(d);
    }

    const fullPayload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      deals,

      // optional debugging aid; remove if you want it strictly lean
      pageNotes,
    };

    const blob = await put(BLOB_PATHNAME, JSON.stringify(fullPayload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

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

      pageNotes,
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

    return res.status(200).json({
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
    });
  }
};
