// /api/merge-deals.js
//
// Merges sources into canonical deals.json (11-field schema)
//
// Sources (by blob URL env var or endpoint fallback):
// - Cheerio (non-Holabird):        CHEERIO_DEALS_BLOB_URL   or /api/cheerio_scrapers
// - Apify (non-Holabird):          APIFY_DEALS_BLOB_URL     or /api/apify_scrapers
// - Holabird Men's Road:            HOLABIRD_MENS_ROAD_BLOB_URL      or /api/scrapers/holabird-mens-road
// - Holabird Women's Road:          HOLABIRD_WOMENS_ROAD_BLOB_URL    or /api/scrapers/holabird-womens-road
// - Holabird Trail + Unisex:       HOLABIRD_TRAIL_UNISEX_BLOB_URL   or /api/scrapers/holabird-trail-unisex
// - Brooks Running:                BROOKS_RUNNING_BLOB_URL          or /api/scrapers/brooks-running
// - ASICS Sale:                    ASICS_SALE_BLOB_URL             or /api/scrapers/asics-sale
// - ALS Sale:                      ALS_SALE_BLOB_URL               or /api/scrapers/als-sale
// - Shoebacca Clearance:           SHOEBACCA_CLEARANCE_BLOB_URL     or /api/scrapers/shoebacca-clearance
// - A Snail's Pace Sale (optional):SNAILSPACE_SALE_BLOB_URL         or /api/scrapers/snailspace-sale
//
// Writes blobs (stable names, overwritten):
// - deals.json
// - unaltered-deals.json
// - stats.json
// - twelve_daily_deals.json
// - scraper-data.json (rolling 30 days; needs SCRAPER_DATA_BLOB_URL set to persist history)

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
  if (x == null) return null;
  const n = typeof x === "string" ? parseFloat(String(x).replace(/,/g, "")) : x;
  return Number.isFinite(n) ? n : null;
}

function parseDurationMs(dur) {
  if (dur == null) return null;
  if (typeof dur === "number" && Number.isFinite(dur)) return dur;

  const s = String(dur).trim();
  if (!s) return null;

  let m = s.match(/^(\d+(?:\.\d+)?)\s*ms$/i);
  if (m) return Math.round(parseFloat(m[1]));

  m = s.match(/^(\d+(?:\.\d+)?)\s*s$/i);
  if (m) return Math.round(parseFloat(m[1]) * 1000);

  m = s.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (m) {
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const ss = parseFloat(m[3]);
    if (Number.isFinite(hh) && Number.isFinite(mm) && Number.isFinite(ss)) {
      return Math.round(hh * 3600000 + mm * 60000 + ss * 1000);
    }
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Compute discount percent from canonical 11-schema fields:
 * - originalPrice and salePrice
 */
function computeDiscountPercent(deal) {
  const sale = toNumber(deal?.salePrice);
  const orig = toNumber(deal?.originalPrice);
  if (!Number.isFinite(sale) || !Number.isFinite(orig) || orig <= 0) return 0;
  if (sale >= orig) return 0;
  return ((orig - sale) / orig) * 100;
}

function computeDollarSavings(deal) {
  const sale = toNumber(deal?.salePrice);
  const orig = toNumber(deal?.originalPrice);
  if (!Number.isFinite(sale) || !Number.isFinite(orig) || orig <= 0) return 0;
  if (sale >= orig) return 0;
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

/**
 * Strict cleaner for listingName/title
 */
function cleanTitleText(raw) {
  let t = stripHtmlToText(raw);
  t = t.replace(/^(extra\s*\d+\s*%\s*off)\s+/i, "");
  t = t.replace(/^(sale|clearance|closeout)\s+/i, "");
  t = normalizeWhitespace(t);
  if (looksLikeCssOrJunk(t)) return "";
  return t;
}

/**
 * Loose cleaner for brand/model (keeps short brands like "On")
 */
function cleanLooseText(raw) {
  return normalizeWhitespace(stripHtmlToText(raw));
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
  if (s.includes("rei outlet")) return "https://www.rei.com/rei-garage";
  if (s === "rei") return "https://www.rei.com";
  if (s.includes("rei")) return "https://www.rei.com";
  if (s.includes("zappos")) return "https://www.zappos.com";
  if (s.includes("road runner")) return "https://www.roadrunnersports.com";
  if (s.includes("shoebacca")) return "https://www.shoebacca.com";
  if (s.includes("snail")) return "https://shop.asnailspace.net";
  if (s === "als") return "https://www.als.com";

  return "https://example.com";
}

/**
 * Canonical 11 fields used across the app:
 * listingName, brand, model, salePrice, originalPrice, discountPercent,
 * store, listingURL, imageURL, gender, shoeType
 */
function sanitizeDeal(raw) {
  if (!raw) return null;

  // Store
  const store = raw.store || raw.retailer || raw.site || "Unknown";
  const base = storeBaseUrl(store);

  // Names (accept old + new variants)
  const listingNameRaw =
    raw.listingName ?? raw.listing ?? raw.title ?? raw.name ?? "";
  const brandRaw = raw.brand ?? raw.vendor ?? "";
  const modelRaw = raw.model ?? "";

  const listingName = cleanTitleText(listingNameRaw);
  const brand = cleanLooseText(brandRaw) || "Unknown";
  const model = cleanLooseText(modelRaw) || "";

  // URLs (accept aliases)
  let listingURL = String(
    raw.listingURL ?? raw.listingUrl ?? raw.url ?? raw.href ?? ""
  ).trim();
  if (listingURL) listingURL = absolutizeUrl(listingURL, base);

  let imageURL = null;
  const imgCandidate =
    raw.imageURL ?? raw.imageUrl ?? raw.image ?? raw.img ?? raw.thumbnail ?? null;

  if (typeof imgCandidate === "string" && imgCandidate.trim()) {
    imageURL = absolutizeUrl(imgCandidate.trim(), base);
  }

  // Prices (accept lots of variants, including old "price" field)
  const salePrice =
    toNumber(raw.salePrice) ??
    toNumber(raw.currentPrice) ??
    toNumber(raw.sale_price) ??
    toNumber(raw.price) ?? // old/current
    null;

  const originalPrice =
    toNumber(raw.originalPrice) ??
    toNumber(raw.original_price) ??
    toNumber(raw.compareAtPrice) ??
    toNumber(raw.compare_at_price) ??
    toNumber(raw.msrp) ??
    toNumber(raw.listPrice) ??
    toNumber(raw.wasPrice) ??
    null;

  const gender = typeof raw.gender === "string" ? raw.gender.trim() : "unknown";
  const shoeType = typeof raw.shoeType === "string" ? raw.shoeType.trim() : "unknown";

  // Discount (prefer numeric if present; else compute)
  let discountPercent = toNumber(raw.discountPercent);
  if (!Number.isFinite(discountPercent)) {
    if (typeof raw.discount === "string") {
      const m = raw.discount.match(/(\d{1,2})/);
      if (m) discountPercent = toNumber(m[1]);
    }
  }

  const safeListingName =
    listingName || normalizeWhitespace(`${brand} ${model}`) || "Running Shoe";
  const safeName = looksLikeCssOrJunk(safeListingName) ? "" : safeListingName;

  const canonical = {
    listingName: safeName,
    brand: brand || "Unknown",
    model: model || "",
    salePrice: Number.isFinite(salePrice) ? salePrice : null,
    originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
    discountPercent: null,
    store: typeof store === "string" ? store.trim() : "Unknown",
    listingURL: listingURL || "",
    imageURL: imageURL || null,
    gender,
    shoeType,
  };

  const computed = computeDiscountPercent(canonical);
  const hasNumericDiscount =
    Number.isFinite(discountPercent) && discountPercent >= 0 && discountPercent <= 95;

  canonical.discountPercent = hasNumericDiscount ? Math.round(discountPercent) : Math.round(computed);
  return canonical;
}

function isValidRunningShoe(deal) {
  if (!deal) return false;

  const listingURL = String(deal.listingURL || "").trim();
  const listingName = String(deal.listingName || "").trim();
  if (!listingURL || !listingName) return false;

  const salePrice = toNumber(deal.salePrice);
  const originalPrice = toNumber(deal.originalPrice);

  if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice)) return false;
  if (salePrice >= originalPrice) return false;
  if (salePrice < 10 || salePrice > 1000) return false;

  const discount = computeDiscountPercent(deal);
  if (discount < 5 || discount > 90) return false;

  const title = listingName.toLowerCase();

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

function normalizeDeal(d) {
  const c = sanitizeDeal(d);
  if (!c) return null;

  return {
    listingName: typeof c.listingName === "string" ? c.listingName.trim() : "",
    brand: typeof c.brand === "string" ? c.brand.trim() : "Unknown",
    model: typeof c.model === "string" ? c.model.trim() : "",
    salePrice: toNumber(c.salePrice),
    originalPrice: toNumber(c.originalPrice),
    discountPercent: Number.isFinite(toNumber(c.discountPercent))
      ? Math.round(toNumber(c.discountPercent))
      : 0,
    store: typeof c.store === "string" ? c.store.trim() : "Unknown",
    listingURL: typeof c.listingURL === "string" ? c.listingURL.trim() : "",
    imageURL: typeof c.imageURL === "string" ? c.imageURL.trim() : null,
    gender: typeof c.gender === "string" ? c.gender.trim() : "unknown",
    shoeType: typeof c.shoeType === "string" ? c.shoeType.trim() : "unknown",
  };
}

function dedupeDeals(deals) {
  const unique = [];
  const seen = new Set();

  for (const d of deals) {
    if (!d) continue;

    const urlKey = (d.listingURL || "").trim();
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
    duration: null,
    payloadMeta: null,
    error: null,
  };

  try {
    if (blobUrl) {
      const payload = await fetchJson(blobUrl);
      const deals = extractDealsFromPayload(payload);
      metadata.source = "blob";
      metadata.deals = deals;
      metadata.blobUrl = blobUrl;
      metadata.timestamp = payload.lastUpdated || payload.timestamp || null;
      metadata.duration = payload.scrapeDurationMs ?? payload.duration ?? null;
      metadata.payloadMeta = payload;
      return metadata;
    }

    if (endpointUrl) {
      const payload = await fetchJson(endpointUrl);

      let deals = extractDealsFromPayload(payload);

      // If endpoint returns a blobUrl, pull the blob for the actual array
      if ((!deals || deals.length === 0) && payload && typeof payload.blobUrl === "string") {
        const payload2 = await fetchJson(payload.blobUrl);
        deals = extractDealsFromPayload(payload2);
        metadata.blobUrl = payload.blobUrl;
        metadata.timestamp = payload2.lastUpdated || payload2.timestamp || payload.timestamp || null;
        metadata.duration = payload2.scrapeDurationMs ?? payload.duration ?? payload2.duration ?? null;
        metadata.payloadMeta = payload2;
      } else {
        metadata.blobUrl = payload.blobUrl || null;
        metadata.timestamp = payload.timestamp || payload.lastUpdated || null;
        metadata.duration = payload.scrapeDurationMs ?? payload.duration ?? null;
        metadata.payloadMeta = payload;
      }

      metadata.source = "endpoint";
      metadata.deals = deals;
      return metadata;
    }
  } catch (e) {
    metadata.source = "error";
    metadata.error = e?.message || String(e);
    return metadata;
  }

  metadata.source = "none";
  return metadata;
}

/** ------------ Stats ------------ **/

function bucketLabel(salePrice) {
  if (!Number.isFinite(salePrice)) return null;
  if (salePrice < 50) return "$0-50";
  if (salePrice < 75) return "$50-75";
  if (salePrice < 100) return "$75-100";
  if (salePrice < 125) return "$100-125";
  if (salePrice < 150) return "$125-150";
  return "$150+";
}

function dealSummary(deal) {
  if (!deal) return null;

  return {
    listingName: deal.listingName || "",
    brand: deal.brand || "Unknown",
    model: deal.model || "",
    store: deal.store || "Unknown",
    listingURL: deal.listingURL || "",
    imageURL: deal.imageURL || null,
    salePrice: toNumber(deal.salePrice),
    originalPrice: toNumber(deal.originalPrice),
    discountPercent: Math.round(computeDiscountPercent(deal)),
    dollarSavings: computeDollarSavings(deal),
    gender: deal.gender || "unknown",
    shoeType: deal.shoeType || "unknown",
  };
}

function computeStats(deals, storeMetadata) {
  const nowIsoStr = new Date().toISOString();

  const stores = Object.create(null);
  const brands = Object.create(null);
  const uniqueStoreSet = new Set();
  const uniqueBrandSet = new Set();

  let discountCount = 0;
  let discountSum = 0;

  let topPercent = null;
  let topDollar = null;
  let lowestPrice = null;
  let bestValue = null;

  const priceBuckets = {
    "$0-50": 0,
    "$50-75": 0,
    "$75-100": 0,
    "$100-125": 0,
    "$125-150": 0,
    "$150+": 0,
  };

  for (const d of safeArray(deals)) {
    const store = (d.store || "Unknown").trim() || "Unknown";
    const brandRaw = (d.brand || "").trim();
    const brand = brandRaw ? brandRaw : "Unknown";

    const salePrice = toNumber(d.salePrice);

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

    const brandIsUnknown = brand === "Unknown" || !brandRaw;
    if (brandIsUnknown) s.unknownBrandCount += 1;

    const img = typeof d.imageURL === "string" ? d.imageURL : "";
    if (!img || img.includes("placehold.co")) s.missingImageCount += 1;

    const url = typeof d.listingURL === "string" ? d.listingURL : "";
    if (!url || url === "#") s.missingUrlCount += 1;

    const model = typeof d.model === "string" ? d.model.trim() : "";
    if (!model) s.missingModelCount += 1;

    if (!Number.isFinite(salePrice) || salePrice <= 0) s.missingPriceCount += 1;

    const percentOff = computeDiscountPercent(d);
    const dollarSavings = computeDollarSavings(d);

    if (percentOff > 0) {
      s.discountSum += percentOff;
      s.discountCount += 1;
      s.savingsSum += dollarSavings;

      discountSum += percentOff;
      discountCount += 1;

      if (!topPercent || percentOff > topPercent.percentOff) topPercent = { deal: d, percentOff };
      if (!topDollar || dollarSavings > topDollar.dollarSavings) topDollar = { deal: d, dollarSavings };

      if (Number.isFinite(salePrice)) {
        if (!lowestPrice || salePrice < lowestPrice.salePrice) lowestPrice = { deal: d, salePrice };
      }

      const valueScore = percentOff + dollarSavings * 0.5;
      if (!bestValue || valueScore > bestValue.valueScore) bestValue = { deal: d, valueScore };
    }

    if (Number.isFinite(salePrice) && salePrice > 0) {
      const label = bucketLabel(salePrice);
      if (label) priceBuckets[label] += 1;
    }

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

  for (const b of Object.values(brands)) {
    if (!Number.isFinite(b.minPrice)) b.minPrice = 0;
  }

  const storesTable = Object.values(stores)
    .map((s) => {
      const avgDiscount = s.discountCount ? s.discountSum / s.discountCount : 0;
      const avgSavings = s.discountCount ? s.savingsSum / s.discountCount : 0;
      const unknownPct = s.count ? (s.unknownBrandCount / s.count) * 100 : 0;

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

  const unknownByStore = storesTable.reduce((acc, s) => {
    acc[s.store] = { unknownCount: s.unknownBrandCount, total: s.count, pct: s.unknownBrandPct };
    return acc;
  }, {});

  let healthyCount = 0, warningCount = 0, criticalCount = 0;
  for (const s of storesTable) {
    if (s.health.status === "healthy") healthyCount++;
    else if (s.health.status === "warning") warningCount++;
    else criticalCount++;
  }

  const avgDiscount = discountCount ? discountSum / discountCount : 0;

  return {
    version: 1,
    generatedAt: nowIsoStr,
    totalDeals: safeArray(deals).length,
    totalStores: uniqueStoreSet.size,
    totalBrands: uniqueBrandSet.size,
    avgDiscount,

    topDeals: {
      topPercent: topPercent ? dealSummary(topPercent.deal) : null,
      topDollar: topDollar ? dealSummary(topDollar.deal) : null,
      lowestPrice: lowestPrice ? dealSummary(lowestPrice.deal) : null,
      bestValue: bestValue ? dealSummary(bestValue.deal) : null,
    },

    storesTable,
    brandsTop,
    unknownByStore,
    priceBuckets,

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

    scraperMetadata: storeMetadata || {},
  };
}

/** ------------ Daily Deals (computed at merge time) ------------ **/

function seededRandom(seed) {
  const x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

function getDateSeedStringUTC() {
  return new Date().toISOString().split("T")[0];
}

function seedFromString(str) {
  let seed = 0;
  for (let i = 0; i < str.length; i++) seed += str.charCodeAt(i);
  return seed;
}

function getRandomSample(array, count, seedBaseStr) {
  if (!array || array.length === 0) return [];
  const dateStr = seedBaseStr || getDateSeedStringUTC();
  const seedBase = seedFromString(dateStr);

  const copy = [...array];
  const picked = [];
  const n = Math.min(count, copy.length);

  for (let i = 0; i < n; i++) {
    const rng = seededRandom(seedBase + i);
    const idx = Math.floor(rng * copy.length);
    picked.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return picked;
}

function parseMoney(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.]/g, "");
    const num = parseFloat(cleaned);
    return Number.isFinite(num) ? num : 0;
  }
  return 0;
}

function hasGoodImage(deal) {
  return (
    deal &&
    deal.imageURL &&
    typeof deal.imageURL === "string" &&
    deal.imageURL.trim() &&
    !deal.imageURL.includes("no-image") &&
    !deal.imageURL.includes("placeholder") &&
    !deal.imageURL.includes("placehold.co")
  );
}

function isDiscountedDeal(deal) {
  const salePrice = parseMoney(deal.salePrice);
  const originalPrice = parseMoney(deal.originalPrice);
  return Number.isFinite(salePrice) && Number.isFinite(originalPrice) && originalPrice > salePrice;
}

function shuffleWithDateSeed(items, seedStr) {
  const dateStr = seedStr || getDateSeedStringUTC();
  let shuffleSeed = 999;
  for (let i = 0; i < dateStr.length; i++) {
    shuffleSeed += dateStr.charCodeAt(i) * 7;
  }

  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const rng = seededRandom(shuffleSeed + i);
    const j = Math.floor(rng * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function toDailyDealShape(deal) {
  const salePrice = parseMoney(deal.salePrice);
  const originalPrice = parseMoney(deal.originalPrice);

  return {
    listingName: deal.listingName || "Running Shoe Deal",
    brand: deal.brand || "",
    model: deal.model || "",
    salePrice: Number.isFinite(salePrice) ? salePrice : 0,
    originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
    discountPercent: Math.round(computeDiscountPercent(deal)),
    store: deal.store || "Store",
    listingURL: deal.listingURL || "#",
    imageURL: deal.imageURL || "",
    gender: deal.gender || "unknown",
    shoeType: deal.shoeType || "unknown",
  };
}

function computeTwelveDailyDeals(allDeals, seedStr) {
  const dateStr = seedStr || getDateSeedStringUTC();

  const qualityDeals = (allDeals || []).filter(
    (d) => hasGoodImage(d) && isDiscountedDeal(d) && d.originalPrice && d.salePrice
  );

  const workingPool =
    qualityDeals.length >= 12 ? qualityDeals : (allDeals || []).filter(hasGoodImage);

  if (!workingPool.length) return [];

  if (workingPool.length < 12) {
    const picked = getRandomSample(workingPool, workingPool.length, dateStr);
    return shuffleWithDateSeed(picked, dateStr).map(toDailyDealShape);
  }

  const top20ByPercent = [...workingPool]
    .sort((a, b) => computeDiscountPercent(b) - computeDiscountPercent(a))
    .slice(0, Math.min(20, workingPool.length));

  const byPercent = getRandomSample(top20ByPercent, Math.min(4, top20ByPercent.length), dateStr);
  const pickedUrls = new Set(byPercent.map((d) => d.listingURL).filter(Boolean));

  const top20ByDollar = [...workingPool]
    .filter((d) => !pickedUrls.has(d.listingURL))
    .sort((a, b) => computeDollarSavings(b) - computeDollarSavings(a))
    .slice(0, 20);

  const byDollar = getRandomSample(top20ByDollar, Math.min(4, top20ByDollar.length), dateStr);
  byDollar.forEach((d) => pickedUrls.add(d.listingURL));

  const remaining = workingPool.filter((d) => !pickedUrls.has(d.listingURL));
  const randomPicks = getRandomSample(remaining, Math.min(4, remaining.length), dateStr);

  const selectedRaw = [...byPercent, ...byDollar, ...randomPicks];
  const shuffled = shuffleWithDateSeed(selectedRaw, dateStr);

  return shuffled.map(toDailyDealShape);
}

/** ------------ scraper-data.json (rolling 30 days) ------------ **/

function toIsoDayUTC(isoOrDate) {
  const d = isoOrDate ? new Date(isoOrDate) : new Date();
  if (Number.isNaN(d.getTime())) return getDateSeedStringUTC();
  return d.toISOString().split("T")[0];
}

function buildTodayScraperRecords({ sourceName, meta, perSourceOk }) {
  const payload = meta?.payloadMeta || null;
  const timestamp = meta?.timestamp || payload?.lastUpdated || payload?.timestamp || null;
  const durationMs = parseDurationMs(meta?.duration || payload?.scrapeDurationMs || payload?.duration || null);
  const via = meta?.source || null;
  const blobUrl = meta?.blobUrl || null;

  if (!perSourceOk) {
    return [{
      scraper: sourceName,
      ok: false,
      count: 0,
      durationMs,
      timestamp,
      via,
      blobUrl,
      error: meta?.error || "Unknown error",
    }];
  }

  if (payload && payload.scraperResults && typeof payload.scraperResults === "object") {
    const records = [];
    for (const [name, r] of Object.entries(payload.scraperResults)) {
      const ok =
        typeof r?.success === "boolean" ? r.success :
        typeof r?.ok === "boolean" ? r.ok :
        true;

      const count = Number.isFinite(r?.count) ? r.count : 0;
      const dMs = parseDurationMs(r?.durationMs || r?.duration || null) ?? durationMs ?? null;

      records.push({
        scraper: name,
        ok,
        count,
        durationMs: dMs,
        timestamp: payload.lastUpdated || payload.timestamp || timestamp || null,
        via,
        blobUrl,
      });
    }
    if (records.length) return records;
  }

  return [{
    scraper: sourceName,
    ok: true,
    count: safeArray(meta?.deals).length,
    durationMs,
    timestamp,
    via,
    blobUrl,
  }];
}

function mergeRollingScraperHistory(existing, todayDayUTC, todayRecords, maxDays = 30) {
  const history = safeArray(existing?.days).filter(Boolean);

  const filtered = history.filter((d) => d?.dayUTC !== todayDayUTC);

  filtered.push({
    dayUTC: todayDayUTC,
    generatedAt: new Date().toISOString(),
    scrapers: safeArray(todayRecords),
  });

  filtered.sort((a, b) => String(a.dayUTC).localeCompare(String(b.dayUTC)));

  const trimmed = filtered.slice(Math.max(0, filtered.length - maxDays));

  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    days: trimmed,
  };
}

/** ------------ Handler ------------ **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // Optional auth gate
  // const cronSecret = process.env.CRON_SECRET;
  // if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const start = Date.now();
  const baseUrl = getBaseUrl(req);

  // ============================================================================
  // BLOB URLs (recommended)
  // ============================================================================
  const CHEERIO_DEALS_BLOB_URL = process.env.CHEERIO_DEALS_BLOB_URL || "";
  const APIFY_DEALS_BLOB_URL = process.env.APIFY_DEALS_BLOB_URL || "";

  const HOLABIRD_MENS_ROAD_BLOB_URL = process.env.HOLABIRD_MENS_ROAD_BLOB_URL || "";
  const HOLABIRD_WOMENS_ROAD_BLOB_URL = process.env.HOLABIRD_WOMENS_ROAD_BLOB_URL || "";
  const HOLABIRD_TRAIL_UNISEX_BLOB_URL = process.env.HOLABIRD_TRAIL_UNISEX_BLOB_URL || "";

  const BROOKS_RUNNING_BLOB_URL = process.env.BROOKS_RUNNING_BLOB_URL || "";
  const ASICS_SALE_BLOB_URL = process.env.ASICS_SALE_BLOB_URL || "";
  const ALS_SALE_BLOB_URL = process.env.ALS_SALE_BLOB_URL || "";
  const SHOEBACCA_CLEARANCE_BLOB_URL = process.env.SHOEBACCA_CLEARANCE_BLOB_URL || "";
  const SNAILSPACE_SALE_BLOB_URL = process.env.SNAILSPACE_SALE_BLOB_URL || "";

  const SCRAPER_DATA_BLOB_URL = process.env.SCRAPER_DATA_BLOB_URL || "";

  // ============================================================================
  // ENDPOINT FALLBACKS (only used if blob URLs missing)
  // ============================================================================
  const CHEERIO_DEALS_ENDPOINT = `${baseUrl}/api/scrapers/cheerio_scrapers`;
  const APIFY_DEALS_ENDPOINT = `${baseUrl}/api/scrapers/apify_scrapers`;

  const HOLABIRD_MENS_ROAD_ENDPOINT = `${baseUrl}/api/scrapers/holabird-mens-road`;
  const HOLABIRD_WOMENS_ROAD_ENDPOINT = `${baseUrl}/api/scrapers/holabird-womens-road`;
  const HOLABIRD_TRAIL_UNISEX_ENDPOINT = `${baseUrl}/api/scrapers/holabird-trail-unisex`;

  const BROOKS_RUNNING_ENDPOINT = `${baseUrl}/api/scrapers/brooks-running`;
  const ASICS_SALE_ENDPOINT = `${baseUrl}/api/scrapers/asics-sale`;
  const ALS_SALE_ENDPOINT = `${baseUrl}/api/scrapers/als-sale`;
  const SHOEBACCA_CLEARANCE_ENDPOINT = `${baseUrl}/api/scrapers/shoebacca-clearance`;
  const SNAILSPACE_SALE_ENDPOINT = `${baseUrl}/api/scrapers/snailspace-sale`;

  try {
    console.log("[MERGE] Starting merge:", new Date().toISOString());
    console.log("[MERGE] Base URL:", baseUrl);

    const sources = [
      {
        name: "Cheerio (non-Holabird)",
        blobUrl: CHEERIO_DEALS_BLOB_URL || null,
        endpointUrl: CHEERIO_DEALS_BLOB_URL ? null : CHEERIO_DEALS_ENDPOINT,
      },
      {
        name: "Apify (non-Holabird)",
        blobUrl: APIFY_DEALS_BLOB_URL || null,
        endpointUrl: APIFY_DEALS_BLOB_URL ? null : APIFY_DEALS_ENDPOINT,
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
        name: "Brooks Running",
        blobUrl: BROOKS_RUNNING_BLOB_URL || null,
        endpointUrl: BROOKS_RUNNING_BLOB_URL ? null : BROOKS_RUNNING_ENDPOINT,
      },
      {
        name: "ASICS Sale",
        blobUrl: ASICS_SALE_BLOB_URL || null,
        endpointUrl: ASICS_SALE_BLOB_URL ? null : ASICS_SALE_ENDPOINT,
      },
      {
        name: "ALS Sale",
        blobUrl: ALS_SALE_BLOB_URL || null,
        endpointUrl: ALS_SALE_BLOB_URL ? null : ALS_SALE_ENDPOINT,
      },
      {
        name: "Shoebacca Clearance",
        blobUrl: SHOEBACCA_CLEARANCE_BLOB_URL || null,
        endpointUrl: SHOEBACCA_CLEARANCE_BLOB_URL ? null : SHOEBACCA_CLEARANCE_ENDPOINT,
      },
      {
        name: "A Snail's Pace Sale",
        blobUrl: SNAILSPACE_SALE_BLOB_URL || null,
        endpointUrl: SNAILSPACE_SALE_BLOB_URL ? null : SNAILSPACE_SALE_ENDPOINT,
      },
    ];

    const settled = await Promise.allSettled(sources.map((s) => loadDealsFromBlobOrEndpoint(s)));

    const perSource = {};
    const storeMetadata = {};
    const allDealsRaw = [];
    const perSourceMeta = {};

    for (let i = 0; i < settled.length; i++) {
      const name = sources[i].name;

      if (settled[i].status === "fulfilled") {
        const { source, deals, blobUrl, timestamp, duration, payloadMeta, error } = settled[i].value;

        if (source === "error") {
          perSource[name] = { ok: false, error: error || "Unknown error" };
          storeMetadata[name] = { error: error || "Unknown error" };
          perSourceMeta[name] = { name, error: error || "Unknown error", source: "error", deals: [] };
          continue;
        }

        perSource[name] = { ok: true, via: source, count: safeArray(deals).length };

        storeMetadata[name] = {
          blobUrl: blobUrl || null,
          timestamp: timestamp || null,
          duration: duration || null,
          count: safeArray(deals).length,
        };

        perSourceMeta[name] = {
          name,
          source,
          deals,
          blobUrl,
          timestamp,
          duration,
          payloadMeta,
        };

        allDealsRaw.push(...safeArray(deals));
      } else {
        const msg = settled[i].reason?.message || String(settled[i].reason);
        perSource[name] = { ok: false, error: msg };
        storeMetadata[name] = { error: msg };
        perSourceMeta[name] = { name, error: msg, source: "error", deals: [] };
      }
    }

    console.log("[MERGE] Source counts:", perSource);
    console.log("[MERGE] Total raw deals:", allDealsRaw.length);

    const unalteredPayload = {
      lastUpdated: new Date().toISOString(),
      totalDealsRaw: allDealsRaw.length,
      scraperResults: perSource,
      storeMetadata,
      deals: allDealsRaw,
    };

    const normalized = allDealsRaw.map(normalizeDeal).filter(Boolean);
    const filtered = normalized.filter(isValidRunningShoe);
    const unique = dedupeDeals(filtered);

    unique.sort(() => Math.random() - 0.5);
    unique.sort((a, b) => computeDiscountPercent(b) - computeDiscountPercent(a));

    const dealsByStore = {};
    for (const d of unique) {
      const s = d.store || "Unknown";
      dealsByStore[s] = (dealsByStore[s] || 0) + 1;
    }

    const output = {
      lastUpdated: new Date().toISOString(),
      totalDeals: unique.length,
      dealsByStore,
      scraperResults: perSource,
      deals: unique,
    };

    const stats = computeStats(unique, storeMetadata);
    stats.lastUpdated = output.lastUpdated;

    const dailySeedUTC = getDateSeedStringUTC();
    const twelveDailyDeals = computeTwelveDailyDeals(unique, dailySeedUTC);

    const dailyDealsPayload = {
      lastUpdated: output.lastUpdated,
      daySeedUTC: dailySeedUTC,
      total: twelveDailyDeals.length,
      deals: twelveDailyDeals,
    };

    const todayDayUTC = toIsoDayUTC(output.lastUpdated);

    const todayRecords = [];
    for (const src of sources) {
      const name = src.name;
      const ok = !!perSource[name]?.ok;
      const meta = perSourceMeta[name] || null;
      todayRecords.push(...buildTodayScraperRecords({ sourceName: name, meta, perSourceOk: ok }));
    }

    let existingScraperData = null;
    if (SCRAPER_DATA_BLOB_URL) {
      try {
        existingScraperData = await fetchJson(SCRAPER_DATA_BLOB_URL);
      } catch (e) {
        console.log("[MERGE] Could not read SCRAPER_DATA_BLOB_URL (starting fresh):", e.message);
        existingScraperData = null;
      }
    }

    const scraperData = mergeRollingScraperHistory(existingScraperData, todayDayUTC, todayRecords, 30);

    const [dealsBlob, unalteredBlob, statsBlob, dailyDealsBlob, scraperDataBlob] = await Promise.all([
      put("deals.json", JSON.stringify(output, null, 2), { access: "public", addRandomSuffix: false }),
      put("unaltered-deals.json", JSON.stringify(unalteredPayload, null, 2), { access: "public", addRandomSuffix: false }),
      put("stats.json", JSON.stringify(stats, null, 2), { access: "public", addRandomSuffix: false }),
      put("twelve_daily_deals.json", JSON.stringify(dailyDealsPayload, null, 2), { access: "public", addRandomSuffix: false }),
      put("scraper-data.json", JSON.stringify(scraperData, null, 2), { access: "public", addRandomSuffix: false }),
    ]);

    const durationMs = Date.now() - start;

    return res.status(200).json({
      success: true,
      totalDeals: unique.length,
      totalRawDeals: allDealsRaw.length,
      dealsByStore,
      scraperResults: perSource,
      storeMetadata,

      dealsBlobUrl: dealsBlob.url,
      unalteredBlobUrl: unalteredBlob.url,
      statsBlobUrl: statsBlob.url,
      dailyDealsBlobUrl: dailyDealsBlob.url,
      scraperDataBlobUrl: scraperDataBlob.url,

      duration: `${durationMs}ms`,
      timestamp: output.lastUpdated,

      note:
        SCRAPER_DATA_BLOB_URL
          ? "scraper-data history appended (SCRAPER_DATA_BLOB_URL was set)"
          : "scraper-data written, but to persist rolling 30-day history you should set SCRAPER_DATA_BLOB_URL to scraperDataBlobUrl",
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
