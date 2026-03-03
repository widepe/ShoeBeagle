// api/scrapers/shoebacca-clearance.js
// Scrapes Shoebacca clearance athletic running shoes using Searchspring JSON API (API-first)
// Schema: canonical 11 fields
// IMPORTANT: never edit listingName (use source name as-is)

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
  const s = String(val || "").toLowerCase();
  if (s.includes("men")) return "mens";
  if (s.includes("women")) return "womens";
  return "unisex";
}

/** -------------------- Searchspring parsing helpers -------------------- **/

function safeParseNumber(x) {
  const n = typeof x === "number" ? x : parseFloat(String(x || ""));
  return Number.isFinite(n) ? n : null;
}

// ss_size_options is a STRING that often contains &quot; entity escapes.
// We decode minimal entities then JSON.parse.
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
  // Many responses already have \u0026quot; which becomes "&quot;" after JSON parse.
  const decoded = decodeHtmlEntities(String(ssSizeOptions).trim());
  try {
    const arr = JSON.parse(decoded);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Choose best prices using your rule:
// - prefer compare_at_price if available (variant-level), else msrp
// - sale price from variant price if available, else product price
// - choose a variant that is available AND on sale when possible
function pickPricesFromResult(result) {
  const productPrice = safeParseNumber(result?.price);
  const productMsrp = safeParseNumber(result?.msrp);

  const opts = parseSizeOptions(result?.ss_size_options);

  // Filter to "available" variants if that flag exists
  const available = opts.filter((o) => {
    const avail = o?.available;
    // some feeds use 1/0
    if (avail === 1 || avail === "1" || avail === true) return true;
    if (avail === 0 || avail === "0" || avail === false) return false;
    // if missing, keep it
    return true;
  });

  const candidates = (available.length ? available : opts).map((o) => {
    const sale = safeParseNumber(o?.price);
    const compareAt = safeParseNumber(o?.compare_at_price);
    const onSaleFlag = o?.ss_on_sale === 1 || o?.ss_on_sale === "1" || o?.ss_on_sale === true;
    const isActuallyOnSale =
      Number.isFinite(sale) &&
      Number.isFinite(compareAt) &&
      sale > 0 &&
      compareAt > 0 &&
      sale < compareAt;

    return {
      salePrice: sale,
      compareAtPrice: compareAt,
      onSaleFlag,
      isActuallyOnSale,
    };
  });

  // Prefer variants that are actually on sale (sale < compare_at)
  candidates.sort((a, b) => {
    // true first
    if (a.isActuallyOnSale !== b.isActuallyOnSale) return a.isActuallyOnSale ? -1 : 1;
    if (a.onSaleFlag !== b.onSaleFlag) return a.onSaleFlag ? -1 : 1;

    // higher compare_at first (more stable original)
    const ac = a.compareAtPrice || -1;
    const bc = b.compareAtPrice || -1;
    if (ac !== bc) return bc - ac;

    // lower sale first
    const as = a.salePrice || Number.POSITIVE_INFINITY;
    const bs = b.salePrice || Number.POSITIVE_INFINITY;
    return as - bs;
  });

  const best = candidates[0] || {};

  let salePrice = round2(best.salePrice ?? productPrice);
  let originalPrice = round2(best.compareAtPrice ?? productMsrp);

  // must have sale
  if (!Number.isFinite(salePrice) || salePrice <= 0) return { salePrice: null, originalPrice: null };

  // If swapped, flip
  if (Number.isFinite(originalPrice) && originalPrice > 0 && salePrice > originalPrice) {
    [salePrice, originalPrice] = [originalPrice, salePrice];
  }

  // If original exists, require true discount
  if (Number.isFinite(originalPrice) && originalPrice > 0 && salePrice >= originalPrice) {
    // not a deal
    return { salePrice, originalPrice: null };
  }

  return { salePrice, originalPrice };
}

/** -------------------- Searchspring fetch -------------------- **/

const SEARCHSPRING_BASE = "https://x6dfgt.a.searchspring.io/api/search/search.json";

function buildBaseParams() {
  const p = new URLSearchParams();

  // Required
  p.set("siteId", "x6dfgt");
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
  p.set("resultsPerPage", "100"); // Searchspring max is typically 100
  return p;
}

async function fetchSearchspringPage(page) {
  const params = buildBaseParams();
  params.set("page", String(page));

  const url = `${SEARCHSPRING_BASE}?${params.toString()}`;
  const startedAt = Date.now();

  const res = await fetch(url, {
    headers: { accept: "application/json" },
  });

  const durationMs = Date.now() - startedAt;

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      url,
      durationMs,
      json: null,
      error: `HTTP ${res.status}`,
    };
  }

  const json = await res.json();
  return { ok: true, status: res.status, url, durationMs, json, error: null };
}

// simple concurrency pool
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
  // First page to learn totalPages
  const first = await fetchSearchspringPage(1);

  const pageResults = [
    {
      page: "searchspring page=1",
      success: first.ok,
      count: Array.isArray(first.json?.results) ? first.json.results.length : 0,
      error: first.error,
      url: first.url,
      duration: `${first.durationMs}ms`,
      status: first.status,
    },
  ];

  if (!first.ok) return { results: [], pageResults };

  const totalPages = first.json?.pagination?.totalPages ?? 1;
  const all = Array.isArray(first.json?.results) ? [...first.json.results] : [];

  if (totalPages <= 1) return { results: all, pageResults };

  const pages = [];
  for (let p = 2; p <= totalPages; p++) pages.push(p);

  // Concurrency: 3 is usually plenty and avoids hammering
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

  return { results: all, pageResults };
}

/** -------------------- Transform to 11-field schema -------------------- **/

function filterAndTransformResults(results) {
  const deals = [];

  for (const r of results) {
    // Because our API query already filters to running + athletic + shoes + mens/womens + clearance,
    // we only apply deal/price validation here.

    const { salePrice, originalPrice } = pickPricesFromResult(r);
    if (!Number.isFinite(salePrice) || salePrice <= 0) continue;

    // must have original (your “honesty rule” expectation in the pipeline)
    if (!Number.isFinite(originalPrice) || originalPrice <= 0) continue;

    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    const listingURL = r?.url ? `https://www.shoebacca.com${r.url}` : null;
    if (!listingURL) continue;

    // IMPORTANT: never edit listingName
    const listingName = String(r?.name || "").trim();
    if (!listingName) continue;

    const brand = String(r?.brand || r?.vendor || "Unknown").trim();
    const model = ""; // optional: you can derive later in merge-deals if desired, but not required here

    const imageURL = r?.imageUrl || r?.thumbnailImageUrl || null;
    const gender = normalizeGender(r?.mfield_acu_in_gender);
    const shoeType = detectShoeTypeFromText(
      `${r?.name || ""} ${(r?.tags || []).join(" ")} ${(r?.collection_handle || []).join(" ")}`
    );

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

  // Dedupe by listingURL (cleanest)
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

  const { results, pageResults } = await scrapeAllPagesSearchspring();
  console.log(`[Shoebacca] Raw Searchspring results: ${results.length}`);

  const deals = filterAndTransformResults(results);
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
    pageResults,
    sourceApi: SEARCHSPRING_BASE,
    segment:
      "clearance-athletic + class:Shoes + type:Athletic + sport:Running + gender:Mens/Womens",
  };
}

/** -------------------- Vercel handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
/*
  const CRON_SECRET = String(process.env.CRON_SECRET || "").trim();
  if (CRON_SECRET) {
    const auth = String(req.headers.authorization || "").trim();
    const xCron = String(req.headers["x-cron-secret"] || "").trim();
    const ok = auth === `Bearer ${CRON_SECRET}` || xCron === CRON_SECRET;

    if (!ok) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
  }
*/
  const start = Date.now();

  try {
    const { deals, dealsByGender, dealsByShoeType, pageResults, sourceApi, segment } =
      await scrapeShoebaccaClearance();

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "Shoebacca",
      segments: [segment],
      sourceApi,
      totalDeals: deals.length,
      dealsByGender,
      dealsByShoeType,
      pageResults,
      deals,
    };

    const blob = await put("shoebacca-clearance.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;

    console.log(`[Shoebacca] ✓ Complete! ${deals.length} deals in ${duration}ms`);
    console.log(`[Shoebacca] Blob URL: ${blob.url}`);

    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      dealsByGender,
      dealsByShoeType,
      pageResults,
      sourceApi,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (error) {
    console.error("[Shoebacca] Fatal error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
      duration: `${Date.now() - start}ms`,
    });
  }
};
