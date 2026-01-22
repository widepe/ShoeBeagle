// /api/merge-deals.js
// Merges: (1) your daily deals scraper output + (2) the 3 Holabird scraper outputs + (3) Brooks sale scraper
// Writes the final canonical blob: deals.json
//
// Env vars (recommended):
//   OTHER_DEALS_BLOB_URL
//   HOLABIRD_MENS_ROAD_BLOB_URL
//   HOLABIRD_WOMENS_ROAD_BLOB_URL
//   HOLABIRD_TRAIL_UNISEX_BLOB_URL
//   BROOKS_SALE_BLOB_URL              ← NEW: Added for Brooks Running integration
//
// Optional fallback (if you do NOT set blob URLs):
//   Calls scraper endpoints directly:
//     /api/scrape-daily
//     /api/scrapers/holabird-mens-road
//     /api/scrapers/holabird-womens-road
//     /api/scrapers/holabird-trail-unisex
//     /api/scrapers/brooks-sale         ← NEW: Added for Brooks Running integration

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

function computeDiscountPercent(d) {
  const p = toNumber(d?.price);
  const o = toNumber(d?.originalPrice);
  if (!p || !o || o <= 0 || p >= o) return 0;
  return ((o - p) / o) * 100;
}

/** ------------ Theme-change-resistant sanitization ------------ **/

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function stripHtmlToText(maybeHtml) {
  const s = String(maybeHtml || "");
  if (!s) return "";
  // fast path: no tags
  if (!/[<>]/.test(s)) return normalizeWhitespace(s);
  // safest possible without cheerio here: remove tags
  return normalizeWhitespace(s.replace(/<[^>]*>/g, " "));
}

function looksLikeCssOrJunk(s) {
  const t = normalizeWhitespace(s);
  if (!t) return true;
  if (t.length < 3) return true;
  if (/^#[-_a-z0-9]+/i.test(t)) return true; // "#review-stars-..."
  if (t.includes("{") && t.includes("}") && t.includes(":")) return true; // "a{margin:0}"
  if (t.startsWith("@media") || t.startsWith(":root")) return true;
  return false;
}

function cleanTitleText(raw) {
  let t = stripHtmlToText(raw);

  // remove common promo lead-ins
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

  // IMPORTANT: these are just for absolutizing relative URLs/images,
  // not for scraping.
  if (s.includes("holabird")) return "https://www.holabirdsports.com";
  if (s.includes("brooks")) return "https://www.brooksrunning.com"; // ← NEW: Added Brooks support
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

  // If title is empty but brand/model exist, fallback
  const finalTitle = title || normalizeWhitespace(`${brand} ${model}`).trim();

  // If that still looks junky, zero it out
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
 * NOTE: This requires originalPrice; it will drop any deal missing it.
 */
function isValidRunningShoe(deal) {
  if (!deal || !deal.url || !deal.title) return false;

  const price = toNumber(deal.price);
  const originalPrice = toNumber(deal.originalPrice);

  if (!price || !originalPrice) return false;
  if (price >= originalPrice) return false;
  if (price < 10 || price > 1000) return false;

  const discount = ((originalPrice - price) / originalPrice) * 100;
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
    "throw",
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
  if (!d) return null;

  // sanitize strings (theme-change resistant)
  const sanitized = sanitizeDeal(d);
  if (!sanitized) return null;

  const price = toNumber(sanitized.price);
  const originalPrice = toNumber(sanitized.originalPrice);

  return {
    ...sanitized,
    // normalize numeric fields
    price,
    originalPrice,
    // normalize blanks
    title: typeof sanitized.title === "string" ? sanitized.title.trim() : "",
    brand: typeof sanitized.brand === "string" ? sanitized.brand.trim() : "Unknown",
    model: typeof sanitized.model === "string" ? sanitized.model.trim() : "",
    store: typeof sanitized.store === "string" ? sanitized.store.trim() : "Unknown",
    url: typeof sanitized.url === "string" ? sanitized.url.trim() : "",
    image: typeof sanitized.image === "string" ? sanitized.image.trim() : null,
    scrapedAt: sanitized.scrapedAt || new Date().toISOString(),
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
  if (blobUrl) {
    const payload = await fetchJson(blobUrl);
    const deals = extractDealsFromPayload(payload);
    return { name, source: "blob", deals };
  }

  if (endpointUrl) {
    const payload = await fetchJson(endpointUrl);

    let deals = extractDealsFromPayload(payload);

    // If endpoint returns only { blobUrl }, try that blob
    if ((!deals || deals.length === 0) && payload && typeof payload.blobUrl === "string") {
      const payload2 = await fetchJson(payload.blobUrl);
      deals = extractDealsFromPayload(payload2);
    }

    return { name, source: "endpoint", deals };
  }

  return { name, source: "none", deals: [] };
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
  const BROOKS_SALE_BLOB_URL = process.env.BROOKS_SALE_BLOB_URL || ""; // ← NEW: Brooks Running

  // ============================================================================
  // ENDPOINT FALLBACKS (only used if blob URLs are missing)
  // ============================================================================
  const OTHER_DEALS_ENDPOINT = `${baseUrl}/api/scrape-daily`;
  const HOLABIRD_MENS_ROAD_ENDPOINT = `${baseUrl}/api/scrapers/holabird-mens-road`;
  const HOLABIRD_WOMENS_ROAD_ENDPOINT = `${baseUrl}/api/scrapers/holabird-womens-road`;
  const HOLABIRD_TRAIL_UNISEX_ENDPOINT = `${baseUrl}/api/scrapers/holabird-trail-unisex`;
  const BROOKS_SALE_ENDPOINT = `${baseUrl}/api/scrapers/brooks-sale`; // ← NEW: Brooks Running

  try {
    console.log("[MERGE] Starting merge:", new Date().toISOString());
    console.log("[MERGE] Base URL:", baseUrl);

    // ============================================================================
    // SOURCES ARRAY - Add all deal sources here
    // ============================================================================
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
      // ============================================================================
      // NEW: Brooks Running Sale - Uses Firecrawl to scrape JavaScript-rendered site
      // ============================================================================
      {
        name: "Brooks Sale",
        blobUrl: BROOKS_SALE_BLOB_URL || null,
        endpointUrl: BROOKS_SALE_BLOB_URL ? null : BROOKS_SALE_ENDPOINT,
      },
    ];

    const settled = await Promise.allSettled(
      sources.map((s) => loadDealsFromBlobOrEndpoint(s))
    );

    const perSource = {};
    const allDealsRaw = [];

    for (let i = 0; i < settled.length; i++) {
      const name = sources[i].name;

      if (settled[i].status === "fulfilled") {
        const { source, deals } = settled[i].value;
        perSource[name] = { ok: true, via: source, count: safeArray(deals).length };
        allDealsRaw.push(...safeArray(deals));
      } else {
        perSource[name] = { ok: false, error: settled[i].reason?.message || String(settled[i].reason) };
      }
    }

    console.log("[MERGE] Source counts:", perSource);
    console.log("[MERGE] Total raw deals:", allDealsRaw.length);

    // 1) Normalize + sanitize (theme-change resistant)
    const normalized = allDealsRaw.map(normalizeDeal).filter(Boolean);

    // 2) Filter (running shoes only, strict discount requirements)
    const filtered = normalized.filter(isValidRunningShoe);

    // 3) Dedupe across ALL sources (including Brooks)
    const unique = dedupeDeals(filtered);

    // 4) Shuffle then sort by discount %
    // (shuffle helps preserve variety among equal-discount items)
    unique.sort(() => Math.random() - 0.5);
    unique.sort((a, b) => computeDiscountPercent(b) - computeDiscountPercent(a));

    // 5) Stats
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

    // 6) Write final canonical blob used by the app
    const blob = await put("deals.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;
    console.log("[MERGE] Saved final deals.json blob:", blob.url);
    console.log(`[MERGE] Complete in ${duration}ms; totalDeals=${unique.length}`);

    return res.status(200).json({
      success: true,
      totalDeals: unique.length,
      dealsByStore,
      scraperResults: perSource,
      blobUrl: blob.url,
      duration: `${duration}ms`,
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
