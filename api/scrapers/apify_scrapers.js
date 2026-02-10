// api/apify_scrapers.js
// Daily scraper for running shoe deals (APIFY ONLY)
// Runs via Vercel Cron
//
// NEW (per your change):
// - We DO NOT write apify-deals_blob.json anymore.
// - Each store writes to its OWN blob path, derived from env var URL:
//
//   Brooks Running:      BROOKS_DEALS_BLOB_URL
//   REI Outlet:          REI_DEALS_BLOB_URL
//   Road Runner Sports:  ROADRUNNER_DEALS_BLOB_URL
//   Zappos:              ZAPPOS_DEALS_BLOB_URL
//
// IMPORTANT:
// - The env vars above should contain the FULL PUBLIC blob URL
//   (e.g. https://<your>.public.blob.vercel-storage.com/<filename>.json)
// - We parse the filename/path from that URL and write to that blob path via put().
// - Each blob payload top-level:
//     { lastUpdated, scrapeDurationMs, scraperResult, deals }
//
// Deal schema (per deal) - 11 fields:
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

function toFiniteNumber(x) {
  if (x == null) return null;
  const n = typeof x === "string" ? parseFloat(String(x).replace(/[^0-9.]/g, "")) : x;
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalizes Apify price fields across versions.
 * Supports:
 * - NEW schema: { salePrice, price } where price = MSRP/list
 * - OLD schema: { price, originalPrice } where price = current/sale and originalPrice = MSRP
 */
function normalizeApifyPrices(item) {
  const newSale = toFiniteNumber(item?.salePrice);
  const newOrig = toFiniteNumber(item?.price);

  if (newSale != null || newOrig != null) {
    return { salePrice: newSale, originalPrice: newOrig };
  }

  const oldSale = toFiniteNumber(item?.price);
  const oldOrig = toFiniteNumber(item?.originalPrice);

  return { salePrice: oldSale, originalPrice: oldOrig };
}

// Detect gender from URL or listing text
function detectGender(listingURL, listingName) {
  const urlLower = (listingURL || "").toLowerCase();
  const nameLower = (listingName || "").toLowerCase();
  const combined = urlLower + " " + nameLower;

  if (/\/mens?[\/-]|\/men\/|men-/.test(urlLower)) return "mens";
  if (/\/womens?[\/-]|\/women\/|women-/.test(urlLower)) return "womens";

  if (/\b(men'?s?|male)\b/i.test(combined)) return "mens";
  if (/\b(women'?s?|female|ladies)\b/i.test(combined)) return "womens";
  if (/\bunisex\b/i.test(combined)) return "unisex";

  return "unknown";
}

// Detect shoe type from listing text or model
function detectShoeType(listingName, model) {
  const combined = ((listingName || "") + " " + (model || "")).toLowerCase();

  if (/\b(trail|speedgoat|peregrine|hierro|wildcat|terraventure|speedcross|ultra|summit)\b/i.test(combined)) {
    return "trail";
  }

  if (/\b(track|spike|dragonfly|zoom.*victory|ja fly|ld|md)\b/i.test(combined)) {
    return "track";
  }

  if (/\b(road|kayano|clifton|ghost|pegasus|nimbus|cumulus|gel|glycerin|kinvara|ride|triumph|novablast)\b/i.test(combined)) {
    return "road";
  }

  // IMPORTANT: if unstated, keep unknown (safer)
  return "unknown";
}

/**
 * Env var holds the *public blob URL*.
 * We need the blob "pathname" to pass to put(), e.g.:
 *   https://.../brooks.json  ->  "brooks.json"
 *   https://.../folder/brooks.json -> "folder/brooks.json"
 *
 * Accepts either:
 * - full URL, or
 * - a plain pathname like "brooks.json"
 */
function blobPathFromEnv(envVal) {
  const raw = String(envVal || "").trim();
  if (!raw) return null;

  // If it's already a relative-ish path, just use it
  if (!/^https?:\/\//i.test(raw)) {
    const p = raw.replace(/^\/+/, "").trim();
    return p || null;
  }

  try {
    const u = new URL(raw);
    const p = String(u.pathname || "").replace(/^\/+/, "").trim();
    return p || null;
  } catch {
    return null;
  }
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

async function fetchBrooksDeals() {
  const STORE = "Brooks Running";
  const actorId = process.env.APIFY_BROOKS_ACTOR_ID;
  if (!actorId) throw new Error("APIFY_BROOKS_ACTOR_ID is not set");

  const items = await fetchActorDatasetItems(actorId, STORE);

  return items.map((item) => {
    const { salePrice, originalPrice } = normalizeApifyPrices(item);

    const brand = item.brand || "Brooks";
    const model = item.model || "";
    const listingName = item.title || `${brand} ${model}`.trim() || "Brooks Running Shoe";
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

/** -------------------- Main handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // Optional cron auth (recommended)
  // const cronSecret = process.env.CRON_SECRET;
  // if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const overallStartTime = Date.now();
  const runTimestamp = nowIso();

  // Store -> env var containing blob URL (or pathname)
  const TARGETS = [
    { name: "Brooks Running", env: "BROOKS_DEALS_BLOB_URL", fn: fetchBrooksDeals },
    { name: "REI Outlet", env: "REI_DEALS_BLOB_URL", fn: fetchReiDeals },
    { name: "Road Runner Sports", env: "ROADRUNNER_DEALS_BLOB_URL", fn: fetchRoadRunnerDeals },
    { name: "Zappos", env: "ZAPPOS_DEALS_BLOB_URL", fn: fetchZapposDeals },
  ];

  try {
    const scraperResults = {};

    async function runStore({ name, env, fn }) {
      const timestamp = nowIso();
      const scraperStart = Date.now();

      try {
        const blobPath = blobPathFromEnv(process.env[env]);
        if (!blobPath) {
          throw new Error(`${env} is not set (or not a valid blob URL/path).`);
        }

        const deals = await fn();
        const durationMs = Date.now() - scraperStart;

        const payload = {
          lastUpdated: timestamp,
          scrapeDurationMs: durationMs,
          scraperResult: {
            scraper: name,
            ok: true,
            count: Array.isArray(deals) ? deals.length : 0,
            durationMs,
            timestamp,
            via: "apify",
            error: null,
          },
          deals: Array.isArray(deals) ? deals : [],
        };

        const blob = await put(blobPath, JSON.stringify(payload, null, 2), {
          access: "public",
          addRandomSuffix: false,
        });

        scraperResults[name] = {
          scraper: name,
          ok: true,
          count: payload.scraperResult.count,
          durationMs,
          timestamp,
          via: "apify",
          error: null,
          blobUrl: blob.url,
          blobPath,
          env,
        };
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
          blobUrl: null,
          blobPath: blobPathFromEnv(process.env[env]),
          env,
        };
      }
    }

    // Run sequentially (safer for rate limits); can be parallelized later if you want.
    for (const t of TARGETS) {
      // eslint-disable-next-line no-await-in-loop
      await runStore(t);
    }

    const scrapeDurationMs = Date.now() - overallStartTime;

    return res.status(200).json({
      success: true,
      timestamp: runTimestamp,
      duration: `${scrapeDurationMs}ms`,
      scraperResults,
      note: "Per-store blobs written (no apify-deals_blob.json).",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
      stack: process.env.NODE_ENV === "development" ? error?.stack : undefined,
    });
  }
};
