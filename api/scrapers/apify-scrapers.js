// /api/apify-scrapers.js
// Runs ONLY Apify-based scrapers (actors) and writes apify-deals.json to Vercel Blob
//
// Output blob: apify-deals.json
// Top-level:
//   { lastUpdated, scrapeDurationMs, scraperResults, deals }
//
// Deal schema (per deal):
//   listingName, brand, model, salePrice, originalPrice, discountPercent,
//   store, listingURL, imageURL, gender, shoeType

const { put } = require("@vercel/blob");
const { ApifyClient } = require("apify-client");

const apifyClient = new ApifyClient({
  token: process.env.APIFY_TOKEN,
});

/** -------------------- Small helpers -------------------- **/

function nowIso() {
  return new Date().toISOString();
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

// Detect gender from URL or listing text
function detectGender(listingURL, listingName) {
  const urlLower = (listingURL || "").toLowerCase();
  const nameLower = (listingName || "").toLowerCase();
  const combined = urlLower + " " + nameLower;

  // URL patterns first
  if (/\/mens?[\/-]|\/men\/|men-/.test(urlLower)) return "mens";
  if (/\/womens?[\/-]|\/women\/|women-/.test(urlLower)) return "womens";

  // Text patterns
  if (/\b(men'?s?|male)\b/i.test(combined)) return "mens";
  if (/\b(women'?s?|female|ladies)\b/i.test(combined)) return "womens";
  if (/\bunisex\b/i.test(combined)) return "unisex";

  return "unknown";
}

// Detect shoe type from listing text or model
function detectShoeType(listingName, model) {
  const combined = ((listingName || "") + " " + (model || "")).toLowerCase();

  if (
    /\b(trail|speedgoat|peregrine|hierro|wildcat|terraventure|speedcross|ultra|summit)\b/i.test(
      combined
    )
  ) {
    return "trail";
  }

  if (/\b(track|spike|dragonfly|zoom.*victory|ja fly|ld|md)\b/i.test(combined)) {
    return "track";
  }

  if (
    /\b(road|kayano|clifton|ghost|pegasus|nimbus|cumulus|gel|glycerin|kinvara|ride|triumph|novablast)\b/i.test(
      combined
    )
  ) {
    return "road";
  }

  return "road";
}

function toFiniteNumber(x) {
  if (x == null) return null;
  const n = typeof x === "string" ? parseFloat(String(x).replace(/[^0-9.]/g, "")) : x;
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalizes Apify price fields across versions.
 *
 * Supports:
 * - NEW schema: { salePrice, price } where price = MSRP/list
 * - OLD schema: { price, originalPrice } where price = current/sale and originalPrice = MSRP
 *
 * Returns:
 *   { salePrice: number|null, originalPrice: number|null }
 */
function normalizeApifyPrices(item) {
  const newSale = toFiniteNumber(item?.salePrice);
  const newOrig = toFiniteNumber(item?.price);

  // If actor is already on new schema, use it
  if (newSale != null || newOrig != null) {
    return { salePrice: newSale, originalPrice: newOrig };
  }

  // Otherwise fall back to old schema
  const oldSale = toFiniteNumber(item?.price);
  const oldOrig = toFiniteNumber(item?.originalPrice);

  return { salePrice: oldSale, originalPrice: oldOrig };
}

async function fetchActorDatasetItems(actorId, storeName) {
  if (!actorId) throw new Error(`Actor ID missing for ${storeName}`);

  const run = await apifyClient.actor(actorId).call({});

  const allItems = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const { items, total } = await apifyClient.dataset(run.defaultDatasetId).listItems({
      offset,
      limit,
    });
    allItems.push(...items);
    offset += items.length;
    if (offset >= total || items.length === 0) break;
  }

  // Ensure store name
  for (const d of allItems) {
    if (!d.store) d.store = storeName;
  }

  return allItems;
}

/** -------------------- Apify fetchers -------------------- **/

async function fetchRoadRunnerDeals() {
  const STORE = "Road Runner Sports";
  const actorId = process.env.APIFY_ROADRUNNER_ACTOR_ID;
  if (!actorId) throw new Error("APIFY_ROADRUNNER_ACTOR_ID is not set");

  const items = await fetchActorDatasetItems(actorId, STORE);

  return items.map((item) => {
    const { salePrice, originalPrice } = normalizeApifyPrices(item);
    const brand = item.brand || "Unknown";
    const model = item.model || "";
    const listingName = item.title || `${brand} ${model}`.trim() || "Running Shoe";
    const listingURL = item.url || "#";
    const imageURL = item.image ?? null;
    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    return {
      listingName,
      brand,
      model,
      salePrice: salePrice ?? null,
      originalPrice: originalPrice ?? null,
      discountPercent,
      store: item.store || STORE,
      listingURL,
      imageURL,
      gender: item.gender || detectGender(listingURL, listingName),
      shoeType: item.shoeType || detectShoeType(listingName, model),
    };
  });
}

async function fetchZapposDeals() {
  const STORE = "Zappos";
  const actorId = process.env.APIFY_ZAPPOS_ACTOR_ID;
  if (!actorId) throw new Error("APIFY_ZAPPOS_ACTOR_ID is not set");

  const items = await fetchActorDatasetItems(actorId, STORE);

  return items.map((item) => {
    const { salePrice, originalPrice } = normalizeApifyPrices(item);
    const brand = item.brand || "Unknown";
    const model = item.model || "";
    const listingName = item.title || `${brand} ${model}`.trim() || "Running Shoe";
    const listingURL = item.url || "#";
    const imageURL = item.image ?? null;
    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    return {
      listingName,
      brand,
      model,
      salePrice: salePrice ?? null,
      originalPrice: originalPrice ?? null,
      discountPercent,
      store: item.store || STORE,
      listingURL,
      imageURL,
      gender: item.gender || detectGender(listingURL, listingName),
      shoeType: item.shoeType || detectShoeType(listingName, model),
    };
  });
}

async function fetchReiDeals() {
  const STORE = "REI Outlet";
  const actorId = process.env.APIFY_REI_ACTOR_ID;
  if (!actorId) throw new Error("APIFY_REI_ACTOR_ID is not set");

  const items = await fetchActorDatasetItems(actorId, STORE);

  return items.map((item) => {
    const { salePrice, originalPrice } = normalizeApifyPrices(item);
    const brand = item.brand || "Unknown";
    const model = item.model || "";
    const listingName = item.title || `${brand} ${model}`.trim() || "REI Outlet Shoe";
    const listingURL = item.url || "#";
    const imageURL = item.image ?? null;
    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    return {
      listingName,
      brand,
      model,
      salePrice: salePrice ?? null,
      originalPrice: originalPrice ?? null,
      discountPercent,
      store: item.store || STORE,
      listingURL,
      imageURL,
      gender: item.gender || detectGender(listingURL, listingName),
      shoeType: item.shoeType || detectShoeType(listingName, model),
    };
  });
}

/** -------------------- Main handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // Cron auth (recommended)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const overallStartTime = Date.now();
  const runTimestamp = nowIso();

  console.log("[APIFY] Starting apify scrape:", runTimestamp);

  try {
    const allDeals = [];
    const scraperResults = {};

    async function runSource({ name, fn }) {
      const timestamp = nowIso();
      const scraperStart = Date.now();

      try {
        const deals = await fn();
        const durationMs = Date.now() - scraperStart;

        allDeals.push(...deals);

        scraperResults[name] = {
          scraper: name,
          ok: true,
          count: Array.isArray(deals) ? deals.length : 0,
          durationMs,
          timestamp,
          via: "apify",
          error: null,
        };

        console.log(`[APIFY] ${name}: ${scraperResults[name].count} deals in ${durationMs}ms`);
      } catch (err) {
        const durationMs = Date.now() - scraperStart;

        scraperResults[name] = {
          scraper: name,
          ok: false,
          count: 0,
          durationMs,
          timestamp,
          via: "apify",
          error: err?.message || "Unknown error",
        };

        console.error(`[APIFY] ${name} failed:`, scraperResults[name].error);
      }
    }

    await runSource({ name: "Road Runner Sports", fn: fetchRoadRunnerDeals });
    await runSource({ name: "REI Outlet", fn: fetchReiDeals });
    await runSource({ name: "Zappos", fn: fetchZapposDeals });

    const scrapeDurationMs = Date.now() - overallStartTime;

    const output = {
      lastUpdated: runTimestamp,
      scrapeDurationMs,
      scraperResults,
      deals: allDeals,
    };

    const blob = await put("apify-deals.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    console.log("[APIFY] Saved to blob:", blob.url);
    console.log(`[APIFY] Complete: ${allDeals.length} deals in ${scrapeDurationMs}ms`);

    return res.status(200).json({
      success: true,
      totalDeals: allDeals.length,
      scraperResults,
      apifyDealsBlobUrl: blob.url, // <-- your "apify-deals_blob" replacement
      duration: `${scrapeDurationMs}ms`,
      timestamp: runTimestamp,
    });
  } catch (error) {
    console.error("[APIFY] Fatal error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
      stack: process.env.NODE_ENV === "development" ? error?.stack : undefined,
    });
  }
};
