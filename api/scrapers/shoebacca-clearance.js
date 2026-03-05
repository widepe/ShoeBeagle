// api/scrapers/shoebacca-clearance.js
// Scrapes Shoebacca clearance athletic running shoes using Searchspring JSON API (API-first)
// ✅ Canonical 11-field deals schema
// ✅ Top-level structure matches your Zappos-style metadata
// ✅ CRON secret auth is COMMENTED OUT for testing (per request)
// ✅ FIXED: model now derived from listingName (no listingName edits)
// ✅ FIXED: gender normalization (womens contains "men")

const { put } = require("@vercel/blob");

/** -------------------- Schema helpers -------------------- **/

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

/** -------------------- Classification helpers -------------------- **/

function detectShoeTypeFromText(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(trail|mountain|off-road|hiking)\b/.test(t)) return "trail";
  if (/\b(track|spike|racing|carbon)\b/.test(t)) return "track";
  return "road";
}

function normalizeGender(val) {
  const s = String(val || "").toLowerCase().trim();
  // IMPORTANT: "womens" includes "men" -> check women first
  if (s.includes("women")) return "womens";
  if (s.includes("men")) return "mens";
  return "unisex";
}

/** -------------------- Brand/model helpers -------------------- **/

function escapeRegExp(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Derive model from listingName and brand WITHOUT modifying listingName itself.
 * This is needed because Searchspring doesn't provide a clean "model" field.
 */
function extractModelFromListingName(listingName, brand) {
  if (!listingName) return "";

  let model = String(listingName);

  const b = String(brand || "").trim();
  if (b && b !== "Unknown") {
    const brandRegex = new RegExp(`^${escapeRegExp(b)}\\s+`, "i");
    model = model.replace(brandRegex, "");
  }

  // Remove common trailing marketing terms
  model = model
    .replace(/\s+\((mens|women|womens|men's|women's|unisex)\)\s*$/i, "")
    .replace(/\s+men'?s\s*$/i, "")
    .replace(/\s+women'?s\s*$/i, "")
    .replace(/\s+unisex\s*$/i, "")
    .replace(/\s+trail\s+running\s+shoe(s)?\s*$/i, "")
    .replace(/\s+running\s+shoe(s)?\s*$/i, "")
    .replace(/\s+shoe(s)?\s*$/i, "")
    .trim();

  return model;
}

/** -------------------- Searchspring parsing helpers -------------------- **/

function safeParseNumber(x) {
  const n = typeof x === "number" ? x : parseFloat(String(x || ""));
  return Number.isFinite(n) ? n : null;
}

// ss_size_options is a STRING that often contains &quot; entity escapes.
// Decode minimal entities then JSON.parse.
function decodeHtmlEntities(str) {
  if (!str) return str;
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseSizeOptions(ssSizeOptions) {
  if (!ssSizeOptions) return [];
  const decoded = decodeHtmlEntities(String(ssSizeOptions).trim());
  try {
    const arr = JSON.parse(decoded);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Choose prices using your rule:
// - prefer compare_at_price if available (variant-level), else msrp
// - sale price from variant price if available, else product price
// - prefer available + actually-on-sale variants
function pickPricesFromResult(result) {
  const productPrice = safeParseNumber(result?.price);
  const productMsrp = safeParseNumber(result?.msrp);

  const opts = parseSizeOptions(result?.ss_size_options);

  const available = opts.filter((o) => {
    const avail = o?.available;
    if (avail === 1 || avail === "1" || avail === true) return true;
    if (avail === 0 || avail === "0" || avail === false) return false;
    return true; // missing -> keep
  });

  const list = (available.length ? available : opts).map((o) => {
    const sale = safeParseNumber(o?.price);
    const compareAt = safeParseNumber(o?.compare_at_price);
    const onSaleFlag = o?.ss_on_sale === 1 || o?.ss_on_sale === "1" || o?.ss_on_sale === true;
    const isActuallyOnSale =
      Number.isFinite(sale) &&
      Number.isFinite(compareAt) &&
      sale > 0 &&
      compareAt > 0 &&
      sale < compareAt;

    return { salePrice: sale, compareAtPrice: compareAt, onSaleFlag, isActuallyOnSale };
  });

  list.sort((a, b) => {
    if (a.isActuallyOnSale !== b.isActuallyOnSale) return a.isActuallyOnSale ? -1 : 1;
    if (a.onSaleFlag !== b.onSaleFlag) return a.onSaleFlag ? -1 : 1;

    const ac = a.compareAtPrice || -1;
    const bc = b.compareAtPrice || -1;
    if (ac !== bc) return bc - ac;

    const as = a.salePrice || Number.POSITIVE_INFINITY;
    const bs = b.salePrice || Number.POSITIVE_INFINITY;
    return as - bs;
  });

  const best = list[0] || {};

  let salePrice = round2(best.salePrice ?? productPrice);
  let originalPrice = round2(best.compareAtPrice ?? productMsrp);

  // must have sale
  if (!Number.isFinite(salePrice) || salePrice <= 0) return { salePrice: null, originalPrice: null };

  // If swapped, flip
  if (Number.isFinite(originalPrice) && originalPrice > 0 && salePrice > originalPrice) {
    [salePrice, originalPrice] = [originalPrice, salePrice];
  }

  // If original exists, require true discount; otherwise keep original as null
  if (Number.isFinite(originalPrice) && originalPrice > 0 && salePrice >= originalPrice) {
    return { salePrice, originalPrice: null };
  }

  return { salePrice, originalPrice };
}

/** -------------------- Searchspring fetch -------------------- **/

const SEARCHSPRING_SITE_ID = "x6dfgt";
const SEARCHSPRING_BASE = `https://${SEARCHSPRING_SITE_ID}.a.searchspring.io/api/search/search.json`;

// Human-facing page (good to keep in sourceUrls)
const SOURCE_COLLECTION_URL =
  "https://www.shoebacca.com/collections/clearance-athletic?tab=products#/productsFilter:mfield_acu_in_class:Shoes/productsFilter:product_type:Athletic/productsFilter:mfield_acu_in_sport:Running/productsFilter:mfield_acu_in_gender:Mens/productsFilter:mfield_acu_in_gender:Womens";

function buildBaseParams() {
  const p = new URLSearchParams();

  // Required-ish
  p.set("siteId", SEARCHSPRING_SITE_ID);
  p.set("resultsFormat", "native");
  p.set("ajaxCatalog", "Snap");
  p.set("noBeacon", "true");

  // Filters (from your working curl)
  p.append("filter.mfield_acu_in_class", "Shoes");
  p.append("filter.product_type", "Athletic");
  p.append("filter.mfield_acu_in_sport", "Running");
  p.append("filter.mfield_acu_in_gender", "Mens");
  p.append("filter.mfield_acu_in_gender", "Womens");
  p.append("bgfilter.collection_handle", "clearance-athletic");

  // Efficiency
  p.set("resultsPerPage", "100"); // typical max
  return p;
}

async function fetchSearchspringPage(page) {
  const params = buildBaseParams();
  params.set("page", String(page));

  const url = `${SEARCHSPRING_BASE}?${params.toString()}`;
  const startedAt = Date.now();

  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const durationMs = Date.now() - startedAt;

    if (!res.ok) {
      return { ok: false, status: res.status, url, durationMs, json: null, error: `HTTP ${res.status}` };
    }

    const json = await res.json();
    return { ok: true, status: res.status, url, durationMs, json, error: null };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    return { ok: false, status: null, url, durationMs, json: null, error: e?.message || "Fetch error" };
  }
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.max(1, concurrency); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function scrapeAllPagesSearchspring() {
  const pageResults = [];
  const all = [];

  // First page (learn totalPages)
  const first = await fetchSearchspringPage(1);
  pageResults.push({
    page: "searchspring page=1",
    success: first.ok,
    count: Array.isArray(first.json?.results) ? first.json.results.length : 0,
    error: first.error,
    url: first.url,
    duration: `${first.durationMs}ms`,
    status: first.status,
  });

  if (!first.ok) {
    return { results: [], rawResultsCount: 0, pagesFetched: 1, pageResults, ok: false, error: first.error };
  }

  const totalPages = first.json?.pagination?.totalPages ?? 1;
  if (Array.isArray(first.json?.results)) all.push(...first.json.results);

  if (totalPages > 1) {
    const pages = [];
    for (let p = 2; p <= totalPages; p++) pages.push(p);

    // Concurrency: safe and fast
    const fetched = await mapWithConcurrency(pages, 3, async (p) => {
      const r = await fetchSearchspringPage(p);
      pageResults.push({
        page: `searchspring page=${p}`,
        success: r.ok,
        count: Array.isArray(r.json?.results) ? r.json.results.length : 0,
        error: r.error,
        url: r.url,
        duration: `${r.durationMs}ms`,
        status: r.status,
      });
      return r;
    });

    for (const r of fetched) {
      if (r?.ok && Array.isArray(r.json?.results)) all.push(...r.json.results);
    }
  }

  return {
    results: all,
    rawResultsCount: all.length,
    pagesFetched: pageResults.length,
    pageResults,
    ok: true,
    error: null,
  };
}

/** -------------------- Transform to canonical 11-field schema -------------------- **/

function filterAndTransformResults(results) {
  const deals = [];

  for (const r of results) {
    const { salePrice, originalPrice } = pickPricesFromResult(r);

    // Must have sale and original (your honesty rule expectation)
    if (!Number.isFinite(salePrice) || salePrice <= 0) continue;
    if (!Number.isFinite(originalPrice) || originalPrice <= 0) continue;

    const listingURL = r?.url ? `https://www.shoebacca.com${r.url}` : null;
    if (!listingURL) continue;

    // IMPORTANT: never edit listingName (use source name as-is)
    const listingName = String(r?.name || "").trim();
    if (!listingName) continue;

    const brand = String(r?.brand || r?.vendor || "Unknown").trim();

    // FIX: derive model from listingName + brand
    const model = extractModelFromListingName(listingName, brand);

    const imageURL = r?.imageUrl || r?.thumbnailImageUrl || null;

    const gender = normalizeGender(r?.mfield_acu_in_gender);

    const shoeType = detectShoeTypeFromText(
      `${r?.name || ""} ${(r?.tags || []).join(" ")} ${(r?.collection_handle || []).join(" ")}`
    );

    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    deals.push({
      listingName,
      brand,
      model,
      salePrice: round2(salePrice),
      originalPrice: round2(originalPrice),
      discountPercent,
      store: "Shoebacca",
      listingURL,
      imageURL,
      gender,
      shoeType,
    });
  }

  // Dedupe by listingURL
  const seen = new Set();
  const deduped = [];
  for (const d of deals) {
    if (seen.has(d.listingURL)) continue;
    seen.add(d.listingURL);
    deduped.push(d);
  }

  return deduped;
}

/** -------------------- Main runner -------------------- **/

async function scrapeShoebaccaClearance() {
  console.log("[Shoebacca] Starting Searchspring clearance scrape...");

  const fetched = await scrapeAllPagesSearchspring();

  console.log(`[Shoebacca] Raw Searchspring results: ${fetched.rawResultsCount}`);
  const deals = filterAndTransformResults(fetched.results);
  console.log(`[Shoebacca] Deals after price filtering: ${deals.length}`);

  const dealsByGender = {
    mens: deals.filter((p) => p.gender === "mens").length,
    womens: deals.filter((p) => p.gender === "womens").length,
    unisex: deals.filter((p) => p.gender === "unisex").length,
  };

  const dealsByShoeType = {
    road: deals.filter((p) => p.shoeType === "road").length,
    trail: deals.filter((p) => p.shoeType === "trail").length,
    track: deals.filter((p) => p.shoeType === "track").length,
  };

  const missingImages = deals.filter((p) => !p.imageURL).length;
  const missingOriginalPrices = deals.filter((p) => !p.originalPrice).length;

  console.log(`[Shoebacca] By Gender:`, dealsByGender);
  console.log(`[Shoebacca] By Shoe Type:`, dealsByShoeType);
  console.log(`[Shoebacca] Missing images: ${missingImages}`);
  console.log(`[Shoebacca] Missing original prices: ${missingOriginalPrices}`);

  return {
    deals,
    dealsByGender,
    dealsByShoeType,
    pageResults: fetched.pageResults,
    pagesFetched: fetched.pagesFetched,
    dealsFound: fetched.rawResultsCount,
    ok: fetched.ok,
    error: fetched.error,
  };
}

/** -------------------- Vercel handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // CRON SECRET
  
const CRON_SECRET = String(process.env.CRON_SECRET || "").trim();
if (CRON_SECRET) {
  const auth = String(req.headers.authorization || "").trim();
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
}
  

  const start = Date.now();

  try {
    const { deals, dealsByGender, dealsByShoeType, pageResults, pagesFetched, dealsFound, ok, error } =
      await scrapeShoebaccaClearance();

    const scrapeDurationMs = Date.now() - start;

    const output = {
      store: "Shoebacca",
      schemaVersion: 1,
      lastUpdated: new Date().toISOString(),
      via: "searchspring",

      sourceUrls: [SOURCE_COLLECTION_URL, SEARCHSPRING_BASE],

      pagesFetched,
      dealsFound,
      dealsExtracted: deals.length,

      scrapeDurationMs,

      ok: Boolean(ok),
      error: error || null,

      // Optional debug detail (safe; remove if you want slimmer blobs)
      pageNotes: pageResults,

      deals,
    };

    const blob = await put("shoebacca-clearance.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    console.log(`[Shoebacca] ✓ Complete! ${deals.length} deals in ${scrapeDurationMs}ms`);
    console.log(`[Shoebacca] Blob URL: ${blob.url}`);

    return res.status(200).json({
      ok: true,
      store: output.store,
      dealsExtracted: output.dealsExtracted,
      pagesFetched: output.pagesFetched,
      dealsFound: output.dealsFound,
      scrapeDurationMs: output.scrapeDurationMs,
      blobUrl: blob.url,
      lastUpdated: output.lastUpdated,
    });
  } catch (e) {
    console.error("[Shoebacca] Fatal error:", e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
      scrapeDurationMs: Date.now() - start,
    });
  }
};
