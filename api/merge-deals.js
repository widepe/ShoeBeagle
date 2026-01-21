// /api/merge-deals.js
// Merges: (1) your daily deals scraper output + (2) the 3 Holabird scraper outputs
// Writes the final canonical blob: deals.json
//
// ✅ Works whether your sources are saved blobs or API endpoints.
// Recommended: set the BLOB URL env vars below so this function just downloads + merges.
//
// Env vars (recommended):
//   OTHER_DEALS_BLOB_URL
//   HOLABIRD_MENS_ROAD_BLOB_URL
//   HOLABIRD_WOMENS_ROAD_BLOB_URL
//   HOLABIRD_TRAIL_UNISEX_BLOB_URL
//
// Optional fallback (if you do NOT set blob URLs):
//   This endpoint will call your scraper endpoints directly to fetch deals:
//     /api/scrape-daily
//     /api/scrapers/holabird-mens-road
//     /api/scrapers/holabird-womens-road
//     /api/scrapers/holabird-trail-unisex
//
// IMPORTANT: if you still want /api/scrape-daily to run, make sure it writes deals-other.json
// (so it doesn’t overwrite the final deals.json that this merger creates).

const axios = require("axios");
const { put } = require("@vercel/blob");

/** ------------ Utilities ------------ **/

function getBaseUrl(req) {
  // Works for Vercel cron + normal requests
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

// Accepts many shapes:
// - raw array: [deal, deal]
// - { deals: [...] }
// - { items: [...] }
// - { output: { deals: [...] } }
// - { data: { deals: [...] } }
function extractDealsFromPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload.deals)) return payload.deals;
  if (Array.isArray(payload.items)) return payload.items;

  if (payload.output && Array.isArray(payload.output.deals)) return payload.output.deals;
  if (payload.data && Array.isArray(payload.data.deals)) return payload.data.deals;

  // Some endpoints might return { success, blobUrl, ... } only. No deals available.
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

/**
 * Your existing centralized filter, copied here so the merged output is clean.
 * Keep this consistent with your app.
 */
function isValidRunningShoe(deal) {
  if (!deal || !deal.url || !deal.title) return false;

  const price = toNumber(deal.price);
  const originalPrice = toNumber(deal.originalPrice);

  // Must have valid prices
  if (!price || !originalPrice) return false;

  // Sale price must be less than original price
  if (price >= originalPrice) return false;

  // Price must be in reasonable range for shoes ($10-$1000)
  if (price < 10 || price > 1000) return false;

  // Discount must be between 5% and 90%
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
    "throw", // track & field throw shoes
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

  // Normalize key fields (avoid strings that look like numbers, etc.)
  const price = toNumber(d.price);
  const originalPrice = toNumber(d.originalPrice);

  const title = typeof d.title === "string" ? d.title.trim() : "";
  const brand = typeof d.brand === "string" ? d.brand.trim() : "Unknown";
  const model = typeof d.model === "string" ? d.model.trim() : "";
  const store = typeof d.store === "string" ? d.store.trim() : "Unknown";
  const url = typeof d.url === "string" ? d.url.trim() : "";
  const image = typeof d.image === "string" ? d.image.trim() : null;

  return {
    ...d,
    title,
    brand,
    model,
    store,
    url,
    image,
    price,
    originalPrice,
    scrapedAt: d.scrapedAt || new Date().toISOString(),
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
  // Try blob first if provided
  if (blobUrl) {
    const payload = await fetchJson(blobUrl);
    const deals = extractDealsFromPayload(payload);
    return { name, source: "blob", deals };
  }

  // Fallback to endpoint if provided
  if (endpointUrl) {
    const payload = await fetchJson(endpointUrl);

    // If endpoint returns deals directly
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

  // Optional cron secret check (matches your existing pattern)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const start = Date.now();
  const baseUrl = getBaseUrl(req);

  // Blob URLs (recommended)
  const OTHER_DEALS_BLOB_URL = process.env.OTHER_DEALS_BLOB_URL || "";
  const HOLABIRD_MENS_ROAD_BLOB_URL = process.env.HOLABIRD_MENS_ROAD_BLOB_URL || "";
  const HOLABIRD_WOMENS_ROAD_BLOB_URL = process.env.HOLABIRD_WOMENS_ROAD_BLOB_URL || "";
  const HOLABIRD_TRAIL_UNISEX_BLOB_URL = process.env.HOLABIRD_TRAIL_UNISEX_BLOB_URL || "";

  // Endpoint fallbacks (only used if blob URLs are missing)
  const OTHER_DEALS_ENDPOINT = `${baseUrl}/api/scrape-daily`;
  const HOLABIRD_MENS_ROAD_ENDPOINT = `${baseUrl}/api/scrapers/holabird-mens-road`;
  const HOLABIRD_WOMENS_ROAD_ENDPOINT = `${baseUrl}/api/scrapers/holabird-womens-road`;
  const HOLABIRD_TRAIL_UNISEX_ENDPOINT = `${baseUrl}/api/scrapers/holabird-trail-unisex`;

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
    ];

    // Load all sources in parallel, but don’t fail the whole merge if one is down
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

    // Normalize
    const normalized = allDealsRaw.map(normalizeDeal).filter(Boolean);

    // Filter
    const filtered = normalized.filter(isValidRunningShoe);

    // Dedupe
    const unique = dedupeDeals(filtered);

    // Sort by discount desc (stable-ish)
    unique.sort((a, b) => computeDiscountPercent(b) - computeDiscountPercent(a));

    // Stats
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

    // Write final canonical blob used by the app
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
