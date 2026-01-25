// /api/merge-deals.js
// Merges: (1) your daily deals scraper output + (2) the 3 Holabird scraper outputs + (3) Brooks sale scraper + (4) ASICS sale scraper
// Writes the final canonical blob: deals.json
// ALSO writes a small precomputed blob: stats.json (Phase 1 quick win)
// - stats.json is overwritten each run (addRandomSuffix: false)
//
// Env vars (recommended):
//   OTHER_DEALS_BLOB_URL
//   HOLABIRD_MENS_ROAD_BLOB_URL
//   HOLABIRD_WOMENS_ROAD_BLOB_URL
//   HOLABIRD_TRAIL_UNISEX_BLOB_URL
//   BROOKS_SALE_BLOB_URL
//   ASICS_SALE_BLOB_URL
//
// Optional fallback (if you do NOT set blob URLs):
//   Calls scraper endpoints directly:
//     /api/scrape-daily
//     /api/scrapers/holabird-mens-road
//     /api/scrapers/holabird-womens-road
//     /api/scrapers/holabird-trail-unisex
//     /api/scrapers/brooks-sale
//     /api/scrapers/asics-sale

const axios = require("axios");
const { put } = require("@vercel/blob");

/** ------------ Utilities ------------ **/

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function extractDealsFromPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload.deals)) return payload.deals;
  if (Array.isArray(payload.items)) return payload.items;

  if (payload.output && Array.isArray(payload.output.deals)) return payload.output.deals;
  if (payload.data && Array.isArray(payload.data.deals)) return payload.data.deals;

  return [];
}

function toNumber(x) {
  const n = typeof x === "string" ? parseFloat(x) : x;
  return Number.isFinite(n) ? n : null;
}

// UPDATED: Use salePrice and price (not price and originalPrice)
function computeDiscountPercent(d) {
  const sale = toNumber(d?.salePrice);
  const orig = toNumber(d?.price);
  if (!sale || !orig || orig <= 0 || sale >= orig) return 0;
  return ((orig - sale) / orig) * 100;
}

// UPDATED: Use salePrice and price
function computeDollarSavings(d) {
  const sale = toNumber(d?.salePrice);
  const orig = toNumber(d?.price);
  if (!sale || !orig || orig <= 0 || sale >= orig) return 0;
  return orig - sale;
}

/** ------------ Theme-change-resistant sanitization ------------ **/

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function stripHtmlToText(maybeHtml) {
  const s = String(maybeHtml || "");
  if (!s) return "";
  if (!/[<>]/.test(s)) return normalizeWhitespace(s);
  return normalizeWhitespace(s.replace(/<[^>]*>/g, " "));
}

function looksLikeCssOrJunk(s) {
  const t = normalizeWhitespace(s);
  if (!t) return true;
  if (t.length < 3) return true;
  if (/^#[-_a-z0-9]+/i.test(t)) return true;
  if (t.includes("{") && t.includes("}") && t.includes(":")) return true;
  if (t.startsWith("@media") || t.startsWith(":root")) return true;
  return false;
}

function cleanTitleText(raw) {
  let t = stripHtmlToText(raw);

  t = t.replace(/^(extra\s*\d+\s*%\s*off)\s+/i, "");
  t = t.replace(/^(sale|clearance|closeout)\s+/i, "");

  t = normalizeWhitespace(t);
  if (looksLikeCssOrJunk(t)) return "";
  return t;
}

function absolutizeUrl(u, base) {
  let url = String(u || "").trim();
  if (!url) return "";

  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return base.replace(/\/+$/, "") + url;

  return base.replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
}

function storeBaseUrl(store) {
  const s = String(store || "").toLowerCase();

  if (s.includes("holabird")) return "https://www.holabirdsports.com";
  if (s.includes("brooks")) return "https://www.brooksrunning.com";
  if (s.includes("asics")) return "https://www.asics.com";
  if (s.includes("running warehouse")) return "https://www.runningwarehouse.com";
  if (s.includes("fleet feet")) return "https://www.fleetfeet.com";
  if (s.includes("luke")) return "https://lukeslocker.com";
  if (s.includes("marathon sports")) return "https://www.marathonsports.com";
  if (s.includes("rei")) return "https://www.rei.com";
  if (s.includes("zappos")) return "https://www.zappos.com";
  if (s.includes("road runner")) return "https://www.roadrunnersports.com";

  return "https://example.com";
}

function sanitizeDeal(deal) {
  if (!deal) return null;

  const base = storeBaseUrl(deal.store);

  const title = cleanTitleText(deal.title);
  const brand = cleanTitleText(deal.brand) || stripHtmlToText(deal.brand) || "Unknown";
  const model = cleanTitleText(deal.model);

  let url = String(deal.url || "").trim();
  if (url) url = absolutizeUrl(url, base);

  let image = null;
  if (typeof deal.image === "string" && deal.image.trim()) {
    image = absolutizeUrl(deal.image.trim(), base);
  }

  const finalTitle = title || normalizeWhitespace(`${brand} ${model}`).trim();
  const safeTitle = looksLikeCssOrJunk(finalTitle) ? "" : finalTitle;

  return {
    ...deal,
    title: safeTitle,
    brand,
    model,
    url,
    image,
  };
}

/**
 * Centralized filter (same logic as your current scrape-daily).
 * UPDATED: Now uses salePrice and price (not price and originalPrice)
 */
function isValidRunningShoe(deal) {
  if (!deal || !deal.url || !deal.title) return false;

  const salePrice = toNumber(deal.salePrice);
  const price = toNumber(deal.price);

  if (!salePrice || !price) return false;
  if (salePrice >= price) return false;
  if (salePrice < 10 || salePrice > 1000) return false;

  const discount = ((price - salePrice) / price) * 100;
  if (discount < 5 || discount > 90) return false;

  const title = String(deal.title || "").toLowerCase();

  const excludePatterns = [
    "sock", "socks",
    "apparel", "shirt", "shorts", "tights", "pants",
    "hat", "cap", "beanie",
    "insole", "insoles",
    "laces", "lace",
    "accessories", "accessory",
    "hydration", "bottle", "flask",
    "watch", "watches",
    "gear", "equipment",
    "bag", "bags", "pack", "backpack",
    "vest", "vests",
    "jacket", "jackets",
    "bra", "bras",
    "underwear", "brief",
    "glove", "gloves", "mitt",
    "compression sleeve",
    "arm warmer", "leg warmer",
    "headband", "wristband",
    "sunglasses", "eyewear",
    "sleeve", "sleeves",
    "throw", "throws",
    "yaktrax",
    "out of stock",
    "kids", "kid",
    "youth",
    "junior", "juniors",
  ];

  for (const pattern of excludePatterns) {
    const regex = new RegExp(`\\b${pattern}\\b`, "i");
    if (regex.test(title)) return false;
  }

  return true;
}

// UPDATED: Now uses salePrice and price, and includes gender/shoeType
function normalizeDeal(d) {
  if (!d) return null;

  const sanitized = sanitizeDeal(d);
  if (!sanitized) return null;

  const salePrice = toNumber(sanitized.salePrice);
  const price = toNumber(sanitized.price);

  return {
    title: typeof sanitized.title === "string" ? sanitized.title.trim() : "",
    brand: typeof sanitized.brand === "string" ? sanitized.brand.trim() : "Unknown",
    model: typeof sanitized.model === "string" ? sanitized.model.trim() : "",
    salePrice,
    price,
    store: typeof sanitized.store === "string" ? sanitized.store.trim() : "Unknown",
    url: typeof sanitized.url === "string" ? sanitized.url.trim() : "",
    image: typeof sanitized.image === "string" ? sanitized.image.trim() : null,
    gender: typeof sanitized.gender === "string" ? sanitized.gender.trim() : "unknown",
    shoeType: typeof sanitized.shoeType === "string" ? sanitized.shoeType.trim() : "unknown",
  };
}

function dedupeDeals(deals) {
  const unique = [];
  const seen = new Set();

  for (const d of deals) {
    if (!d) continue;

    const urlKey = (d.url || "").trim();
    const storeKey = (d.store || "Unknown").trim();

    if (!urlKey) {
      unique.push(d);
      continue;
    }

    const key = `${storeKey}|${urlKey}`;
    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(d);
  }

  return unique;
}

async function fetchJson(url) {
  const resp = await axios.get(url, {
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json,text/plain,*/*",
    },
  });
  return resp.data;
}

async function loadDealsFromBlobOrEndpoint({ name, blobUrl, endpointUrl }) {
  const metadata = {
    name,
    source: null,
    deals: [],
    blobUrl: null,
    timestamp: null,
    duration: null
  };

  if (blobUrl) {
    const payload = await fetchJson(blobUrl);
    const deals = extractDealsFromPayload(payload);
    metadata.source = "blob";
    metadata.deals = deals;
    metadata.blobUrl = blobUrl;
    metadata.timestamp = payload.lastUpdated || payload.timestamp || null;
    return metadata;
  }

  if (endpointUrl) {
    const payload = await fetchJson(endpointUrl);

    let deals = extractDealsFromPayload(payload);

    if ((!deals || deals.length === 0) && payload && typeof payload.blobUrl === "string") {
      const payload2 = await fetchJson(payload.blobUrl);
      deals = extractDealsFromPayload(payload2);
      metadata.blobUrl = payload.blobUrl;
      metadata.timestamp = payload2.lastUpdated || payload2.timestamp || payload.timestamp || null;
    } else {
      metadata.blobUrl = payload.blobUrl || null;
      metadata.timestamp = payload.timestamp || payload.lastUpdated || null;
    }

    metadata.source = "endpoint";
    metadata.deals = deals;
    metadata.duration = payload.duration || null;

    return metadata;
  }

  return { name, source: "none", deals: [] };
}

/** ------------ Stats (Phase 1 quick win) ------------ **/

// UPDATED: Use salePrice (not price)
function bucketLabel(salePrice) {
  if (!Number.isFinite(salePrice)) return null;
  if (salePrice < 50) return "$0-50";
  if (salePrice < 75) return "$50-75";
  if (salePrice < 100) return "$75-100";
  if (salePrice < 125) return "$100-125";
  if (salePrice < 150) return "$125-150";
  return "$150+";
}

// UPDATED: Use salePrice and price
function dealSummary(deal) {
  if (!deal) return null;
  const salePrice = toNumber(deal.salePrice);
  const price = toNumber(deal.price);
  const percentOff = computeDiscountPercent(deal);
  const dollarSavings = computeDollarSavings(deal);

  return {
    title: deal.title || "",
    brand: deal.brand || "Unknown",
    model: deal.model || "",
    store: deal.store || "Unknown",
    url: deal.url || "",
    image: deal.image || null,
    salePrice,
    price,
    percentOff,
    dollarSavings,
    gender: deal.gender || "unknown",
    shoeType: deal.shoeType || "unknown",
  };
}

/**
 * computeStats(deals, storeMetadata)
 *
 * What it does (and why it helps):
 * - Precomputes the "dashboard math" on the server (once per merge run)
 *   so your dashboard.html can load fast by fetching a small stats.json.
 *
 * Produces:
 * - Global totals: totalDeals, totalStores, totalBrands
 * - Average discount across discounted deals
 * - Top deal cards: highest % off, biggest $ savings, lowest price, best value
 * - Store rollups: deal counts, avg discount, avg $ savings, unknown brand %
 * - Brand rollups: top brands by count + price range
 * - Price histogram buckets
 * - Basic store health checks (unknown brands, missing images/urls/models/prices)
 * - Also includes scraper-level metadata (blob urls, timestamps, durations) from merge sources
 */
function computeStats(deals, storeMetadata) {
  const nowIso = new Date().toISOString();

  // Global
  const stores = Object.create(null);
  const brands = Object.create(null);
  const uniqueStoreSet = new Set();
  const uniqueBrandSet = new Set();

  // Discount aggregation
  let discountCount = 0;
  let discountSum = 0;

  // Candidates for top deals
  let topPercent = null; // {deal, percentOff}
  let topDollar = null;  // {deal, dollarSavings}
  let lowestPrice = null;// {deal, salePrice}
  let bestValue = null;  // {deal, valueScore}

  // Price buckets
  const priceBuckets = {
    "$0-50": 0,
    "$50-75": 0,
    "$75-100": 0,
    "$100-125": 0,
    "$125-150": 0,
    "$150+": 0,
  };

  // One pass over deals
  for (const d of safeArray(deals)) {
    const store = (d.store || "Unknown").trim() || "Unknown";
    const brandRaw = (d.brand || "").trim();
    const brand = brandRaw ? brandRaw : "Unknown";

    const salePrice = toNumber(d.salePrice);
    const price = toNumber(d.price);

    uniqueStoreSet.add(store);
    uniqueBrandSet.add(brand);

    if (!stores[store]) {
      stores[store] = {
        store,
        count: 0,
        discountSum: 0,
        discountCount: 0,
        savingsSum: 0,
        unknownBrandCount: 0,
        missingImageCount: 0,
        missingUrlCount: 0,
        missingModelCount: 0,
        missingPriceCount: 0,
      };
    }

    const s = stores[store];
    s.count += 1;

    // Basic health signals
    const brandIsUnknown = brand === "Unknown" || !brandRaw;
    if (brandIsUnknown) s.unknownBrandCount += 1;

    const img = typeof d.image === "string" ? d.image : "";
    if (!img || img.includes("placehold.co")) s.missingImageCount += 1;

    const url = typeof d.url === "string" ? d.url : "";
    if (!url || url === "#") s.missingUrlCount += 1;

    const model = typeof d.model === "string" ? d.model.trim() : "";
    if (!model) s.missingModelCount += 1;

    if (!Number.isFinite(salePrice) || salePrice <= 0) s.missingPriceCount += 1;

    // Store rollups (discount/savings)
    const percentOff = computeDiscountPercent(d);
    const dollarSavings = computeDollarSavings(d);

    if (percentOff > 0) {
      s.discountSum += percentOff;
      s.discountCount += 1;
      s.savingsSum += dollarSavings;

      discountSum += percentOff;
      discountCount += 1;

      // Top percent off
      if (!topPercent || percentOff > topPercent.percentOff) {
        topPercent = { deal: d, percentOff };
      }
      // Top dollar savings
      if (!topDollar || dollarSavings > topDollar.dollarSavings) {
        topDollar = { deal: d, dollarSavings };
      }
      // Lowest salePrice among discounted deals
      if (Number.isFinite(salePrice)) {
        if (!lowestPrice || salePrice < lowestPrice.salePrice) {
          lowestPrice = { deal: d, salePrice };
        }
      }
      // Best value: percentOff + (dollarSavings * 0.5)
      const valueScore = percentOff + (dollarSavings * 0.5);
      if (!bestValue || valueScore > bestValue.valueScore) {
        bestValue = { deal: d, valueScore };
      }
    }

    // Price buckets (only valid salePrices)
    if (Number.isFinite(salePrice) && salePrice > 0) {
      const label = bucketLabel(salePrice);
      if (label) priceBuckets[label] += 1;
    }

    // Brand rollups
    if (!brands[brand]) {
      brands[brand] = {
        brand,
        count: 0,
        discountSum: 0,
        discountCount: 0,
        minPrice: Number.POSITIVE_INFINITY,
        maxPrice: 0,
      };
    }
    const b = brands[brand];
    b.count += 1;
    if (percentOff > 0) {
      b.discountSum += percentOff;
      b.discountCount += 1;
    }
    if (Number.isFinite(salePrice) && salePrice > 0) {
      b.minPrice = Math.min(b.minPrice, salePrice);
      b.maxPrice = Math.max(b.maxPrice, salePrice);
    }
  }

  // Finalize brand price ranges
  for (const b of Object.values(brands)) {
    if (!Number.isFinite(b.minPrice)) b.minPrice = 0;
  }

  // Store table array
  const storesTable = Object.values(stores)
    .map((s) => {
      const avgDiscount = s.discountCount ? s.discountSum / s.discountCount : 0;
      const avgSavings = s.discountCount ? s.savingsSum / s.discountCount : 0;
      const unknownPct = s.count ? (s.unknownBrandCount / s.count) * 100 : 0;

      // Health classification (store-level)
      let status = "healthy";
      const issues = [];

      if (s.count === 0) {
        status = "critical";
        issues.push("ZERO RESULTS");
      }

      if (unknownPct > 50) {
        status = "critical";
        issues.push(`${unknownPct.toFixed(0)}% Unknown Brands`);
      } else if (unknownPct > 20) {
        if (status !== "critical") status = "warning";
        issues.push(`${unknownPct.toFixed(0)}% Unknown Brands`);
      }

      const missingImagesPct = s.count ? (s.missingImageCount / s.count) * 100 : 0;
      if (missingImagesPct > 30) {
        if (status !== "critical") status = "warning";
        issues.push(`${missingImagesPct.toFixed(0)}% Missing Images`);
      }

      const missingUrlsPct = s.count ? (s.missingUrlCount / s.count) * 100 : 0;
      if (missingUrlsPct > 10) {
        if (status !== "critical") status = "warning";
        issues.push(`${missingUrlsPct.toFixed(0)}% Missing URLs`);
      }

      const missingModelsPct = s.count ? (s.missingModelCount / s.count) * 100 : 0;
      if (missingModelsPct > 30) {
        if (status !== "critical") status = "warning";
        issues.push(`${missingModelsPct.toFixed(0)}% Missing Models`);
      }

      if (s.count > 0 && s.count < 5) {
        if (status !== "critical") status = "warning";
        issues.push(`Low Deal Count (${s.count})`);
      }

      return {
        store: s.store,
        count: s.count,
        avgDiscount,
        avgSavings,
        unknownBrandCount: s.unknownBrandCount,
        unknownBrandPct: unknownPct,
        missingImageCount: s.missingImageCount,
        missingUrlCount: s.missingUrlCount,
        missingModelCount: s.missingModelCount,
        missingPriceCount: s.missingPriceCount,
        health: { status, issues },
      };
    })
    .sort((a, b) => b.count - a.count);

  // Brand top list (exclude Unknown by default)
  const brandsTop = Object.values(brands)
    .filter((b) => b.brand && b.brand !== "Unknown")
    .map((b) => ({
      brand: b.brand,
      count: b.count,
      avgDiscount: b.discountCount ? b.discountSum / b.discountCount : 0,
      minPrice: b.minPrice,
      maxPrice: b.maxPrice,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  // Unknown-by-store table format (what your dashboard already shows)
  const unknownByStore = storesTable.reduce((acc, s) => {
    acc[s.store] = { unknownCount: s.unknownBrandCount, total: s.count, pct: s.unknownBrandPct };
    return acc;
  }, {});

  // Health summary counts
  let healthyCount = 0, warningCount = 0, criticalCount = 0;
  for (const s of storesTable) {
    if (s.health.status === "healthy") healthyCount++;
    else if (s.health.status === "warning") warningCount++;
    else criticalCount++;
  }

  const avgDiscount = discountCount ? discountSum / discountCount : 0;

  return {
    version: 1,
    generatedAt: nowIso,

    // Global metrics
    totalDeals: safeArray(deals).length,
    totalStores: uniqueStoreSet.size,
    totalBrands: uniqueBrandSet.size,
    avgDiscount,

    // Top deal "cards" (ready for dashboard rendering)
    topDeals: {
      topPercent: topPercent ? dealSummary(topPercent.deal) : null,
      topDollar: topDollar ? dealSummary(topDollar.deal) : null,
      lowestPrice: lowestPrice ? dealSummary(lowestPrice.deal) : null,
      bestValue: bestValue ? dealSummary(bestValue.deal) : null,
    },

    // Tables / charts
    storesTable,
    brandsTop,
    unknownByStore,
    priceBuckets,

    // Store-level health (derived from the merged deals)
    health: {
      summary: { healthy: healthyCount, warning: warningCount, critical: criticalCount },
      stores: storesTable.map((s) => ({
        store: s.store,
        status: s.health.status,
        issues: s.health.issues,
        count: s.count,
        unknownBrandPct: s.unknownBrandPct,
      })),
    },

    // Scraper-level metadata (comes from your merge sources; useful for "last scraped" timestamps)
    scraperMetadata: storeMetadata || {},
  };
}

/** ------------ Handler ------------ **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const start = Date.now();
  const baseUrl = getBaseUrl(req);

  // ============================================================================
  // BLOB URLs (recommended - set these in Vercel environment variables)
  // ============================================================================
  const OTHER_DEALS_BLOB_URL = process.env.OTHER_DEALS_BLOB_URL || "";
  const HOLABIRD_MENS_ROAD_BLOB_URL = process.env.HOLABIRD_MENS_ROAD_BLOB_URL || "";
  const HOLABIRD_WOMENS_ROAD_BLOB_URL = process.env.HOLABIRD_WOMENS_ROAD_BLOB_URL || "";
  const HOLABIRD_TRAIL_UNISEX_BLOB_URL = process.env.HOLABIRD_TRAIL_UNISEX_BLOB_URL || "";
  const BROOKS_SALE_BLOB_URL = process.env.BROOKS_SALE_BLOB_URL || "";
  const ASICS_SALE_BLOB_URL = process.env.ASICS_SALE_BLOB_URL || "";
  const SHOEBACCA_CLEARANCE_BLOB_URL = process.env.SHOEBACCA_CLEARANCE_BLOB_URL || "";
  
  // ============================================================================
  // ENDPOINT FALLBACKS (only used if blob URLs are missing)
  // ============================================================================
  const OTHER_DEALS_ENDPOINT = `${baseUrl}/api/scrape-daily`;
  const HOLABIRD_MENS_ROAD_ENDPOINT = `${baseUrl}/api/scrapers/holabird-mens-road`;
  const HOLABIRD_WOMENS_ROAD_ENDPOINT = `${baseUrl}/api/scrapers/holabird-womens-road`;
  const HOLABIRD_TRAIL_UNISEX_ENDPOINT = `${baseUrl}/api/scrapers/holabird-trail-unisex`;
  const BROOKS_SALE_ENDPOINT = `${baseUrl}/api/scrapers/brooks-sale`;
  const ASICS_SALE_ENDPOINT = `${baseUrl}/api/scrapers/asics-sale`;
  const SHOEBACCA_CLEARANCE_ENDPOINT = `${baseUrl}/api/scrapers/shoebacca-clearance`;
  
  try {
    console.log("[MERGE] Starting merge:", new Date().toISOString());
    console.log("[MERGE] Base URL:", baseUrl);

    const sources = [
      {
        name: "Other (scrape-daily)",
        blobUrl: OTHER_DEALS_BLOB_URL || null,
        endpointUrl: OTHER_DEALS_BLOB_URL ? null : OTHER_DEALS_ENDPOINT,
      },
      {
        name: "Holabird Mens Road",
        blobUrl: HOLABIRD_MENS_ROAD_BLOB_URL || null,
        endpointUrl: HOLABIRD_MENS_ROAD_BLOB_URL ? null : HOLABIRD_MENS_ROAD_ENDPOINT,
      },
      {
        name: "Holabird Womens Road",
        blobUrl: HOLABIRD_WOMENS_ROAD_BLOB_URL || null,
        endpointUrl: HOLABIRD_WOMENS_ROAD_BLOB_URL ? null : HOLABIRD_WOMENS_ROAD_ENDPOINT,
      },
      {
        name: "Holabird Trail + Unisex",
        blobUrl: HOLABIRD_TRAIL_UNISEX_BLOB_URL || null,
        endpointUrl: HOLABIRD_TRAIL_UNISEX_BLOB_URL ? null : HOLABIRD_TRAIL_UNISEX_ENDPOINT,
      },
      {
        name: "Brooks Sale",
        blobUrl: BROOKS_SALE_BLOB_URL || null,
        endpointUrl: BROOKS_SALE_BLOB_URL ? null : BROOKS_SALE_ENDPOINT,
      },
      {
        name: "ASICS Sale",
        blobUrl: ASICS_SALE_BLOB_URL || null,
        endpointUrl: ASICS_SALE_BLOB_URL ? null : ASICS_SALE_ENDPOINT,
      },
      {
        name: "Shoebacca Clearance",
        blobUrl: SHOEBACCA_CLEARANCE_BLOB_URL || null,
        endpointUrl: SHOEBACCA_CLEARANCE_BLOB_URL ? null : SHOEBACCA_CLEARANCE_ENDPOINT,
      },

      
    ];

    const settled = await Promise.allSettled(
      sources.map((s) => loadDealsFromBlobOrEndpoint(s))
    );

    const perSource = {};
    const storeMetadata = {};
    const allDealsRaw = [];

    for (let i = 0; i < settled.length; i++) {
      const name = sources[i].name;

      if (settled[i].status === "fulfilled") {
        const { source, deals, blobUrl, timestamp, duration } = settled[i].value;

        perSource[name] = { ok: true, via: source, count: safeArray(deals).length };

        storeMetadata[name] = {
          blobUrl: blobUrl || null,
          timestamp: timestamp || null,
          duration: duration || null,
          count: safeArray(deals).length,
        };

        allDealsRaw.push(...safeArray(deals));
      } else {
        const msg = settled[i].reason?.message || String(settled[i].reason);
        perSource[name] = { ok: false, error: msg };
        storeMetadata[name] = { error: msg };
      }
    }

    console.log("[MERGE] Source counts:", perSource);
    console.log("[MERGE] Total raw deals:", allDealsRaw.length);

    // 1) Normalize + sanitize (theme-change resistant)
    const normalized = allDealsRaw.map(normalizeDeal).filter(Boolean);

    // 2) Filter (running shoes only, strict discount requirements)
    const filtered = normalized.filter(isValidRunningShoe);

    // 3) Dedupe across ALL sources (including Brooks + ASICS)
    const unique = dedupeDeals(filtered);

    // 4) Shuffle then sort by discount %
    unique.sort(() => Math.random() - 0.5);
    unique.sort((a, b) => computeDiscountPercent(b) - computeDiscountPercent(a));

    // 5) dealsByStore (kept in deals.json for backward compatibility)
    const dealsByStore = {};
    for (const d of unique) {
      const s = d.store || "Unknown";
      dealsByStore[s] = (dealsByStore[s] || 0) + 1;
    }

    // 6) Build canonical deals output
    const output = {
      lastUpdated: new Date().toISOString(),
      totalDeals: unique.length,
      dealsByStore,
      scraperResults: perSource,
      deals: unique,
    };

    // 7) Compute small dashboard stats and write stats.json (Phase 1)
    const stats = computeStats(unique, storeMetadata);
    // Mirror the same timestamp so dashboard can show a single "last updated"
    stats.lastUpdated = output.lastUpdated;

    // 8) Write blobs (overwrite each run)
    const [dealsBlob, statsBlob] = await Promise.all([
      put("deals.json", JSON.stringify(output, null, 2), {
        access: "public",
        addRandomSuffix: false,
      }),
      put("stats.json", JSON.stringify(stats, null, 2), {
        access: "public",
        addRandomSuffix: false,
      }),
    ]);

    const durationMs = Date.now() - start;
    console.log("[MERGE] Saved deals.json:", dealsBlob.url);
    console.log("[MERGE] Saved stats.json:", statsBlob.url);
    console.log(`[MERGE] Complete in ${durationMs}ms; totalDeals=${unique.length}`);

    return res.status(200).json({
      success: true,
      totalDeals: unique.length,
      dealsByStore,
      scraperResults: perSource,
      storeMetadata, // scraper-level metadata
      blobUrl: dealsBlob.url,
      statsBlobUrl: statsBlob.url,
      duration: `${durationMs}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (err) {
    console.error("[MERGE] Fatal error:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};
