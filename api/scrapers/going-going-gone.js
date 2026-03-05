// /api/going-going-gone.js  (CommonJS)
//
// GoingGoingGone (DSG catalog API) scraper that:
//  - Fetches paginated product search JSON
//  - Filters to ONLY listings whose name contains "running shoes" (case-insensitive)
//  - Outputs your canonical deal schema (shoeType always "unknown" for this store)
//  - Writes FULL payload (including deals[]) to Vercel Blob at: going-going-gone.json
//  - Returns a SMALL SUMMARY ONLY (Option A) — NO deals[] in the HTTP response
//
// ENV you likely already use elsewhere:
//   BLOB_READ_WRITE_TOKEN  (required for Vercel Blob put)
//
// Optional ENV (only if you want to send these to DSG; otherwise omitted):
//   DSG_STORE_ID
//   DSG_SELECTED_STORE
//   DSG_ZIPCODE
//
// Optional ENV:
//   DSG_PAGE_SIZE (default 24)
//   DSG_SELECTED_SORT (default 5)
//   DSG_CATEGORY (default "12301_10515458")  // women's sale category from your sample
//
// NOTE on "filter to running":
//   We do TWO layers:
//   (1) Try to ask the API for Activity=Running via selectedFilters["4285"]=["Running"]
//   (2) Enforce your hard rule anyway: name must contain "running shoes"
//
// CRON SECRET (commented out for testing)
// const auth = req.headers.authorization;
// if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
//   return res.status(401).json({ success: false, error: "Unauthorized" });
// }

const { put } = require("@vercel/blob");

const STORE = "GoingGoingGone";
const SCHEMA_VERSION = 1;

const DSG_API =
  "https://prod-catalog-product-api.dickssportinggoods.com/v2/search?searchVO=";

function nowIso() {
  return new Date().toISOString();
}

function asNumber(x) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// DSG sends attributes as a string like: "[{\"X_BRAND\":\"Nike\"}, ...]"
function parseAttributesList(attributesStr) {
  const arr = safeJsonParse(attributesStr, []);
  return Array.isArray(arr) ? arr : [];
}

function detectGenderFromAttributes(attributesStr) {
  const attrs = parseAttributesList(attributesStr);
  // Look for "Women's" anywhere
  for (const obj of attrs) {
    if (!obj || typeof obj !== "object") continue;
    for (const v of Object.values(obj)) {
      if (typeof v === "string" && v.toLowerCase().includes("women")) return "women";
    }
  }
  return "unknown";
}

function buildListingUrl(assetSeoUrl) {
  if (!assetSeoUrl) return null;
  return `https://www.goinggoinggone.com${assetSeoUrl}`;
}

function buildImageUrl(imageId) {
  if (!imageId) return null;
  return `https://dks.scene7.com/is/image/dks/${imageId}?wid=600&fmt=png-alpha`;
}

function extractPrices(floatFacets) {
  const facets = Array.isArray(floatFacets) ? floatFacets : [];

  const offerPrices = [];
  const listPrices = [];

  for (const f of facets) {
    if (!f || typeof f !== "object") continue;
    const id = String(f.identifier || "").toLowerCase();
    const val = asNumber(f.value ?? f.stringValue);

    if (val == null) continue;

    if (id.includes("offerprice")) offerPrices.push(val);
    if (id.includes("listprice")) listPrices.push(val);
  }

  // Choose the best single prices:
  // - salePrice: min offerprice (best deal)
  // - originalPrice: max listprice (most conservative "was" price if multiple)
  const salePrice = offerPrices.length ? Math.min(...offerPrices) : null;
  const originalPrice = listPrices.length ? Math.max(...listPrices) : null;

  return { salePrice, originalPrice };
}

function computeDiscountPercent(salePrice, originalPrice) {
  if (salePrice == null || originalPrice == null) return null;
  if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice)) return null;
  if (originalPrice <= 0) return null;
  // NOTE: You said "don't worry about negative for now" (merge-deals will drop it).
  // We'll still compute it here.
  const pct = ((originalPrice - salePrice) / originalPrice) * 100;
  // Round to 2 decimals to match your sample feel
  return Math.round(pct * 100) / 100;
}

function deriveModelFromName(name, brand) {
  const n = String(name || "").trim();
  const b = String(brand || "").trim();
  if (!n) return "";

  // Remove leading "Brand " (case-insensitive)
  let s = n;
  if (b) {
    const re = new RegExp(`^${escapeRegExp(b)}\\s+`, "i");
    s = s.replace(re, "");
  }

  // Remove leading gender tokens if present
  s = s.replace(/^(men's|mens|women's|womens|unisex)\s+/i, "");

  // Remove trailing "Running Shoes" (and variants)
  s = s.replace(/\s+(road\s+)?running\s+shoes$/i, "");
  s = s.replace(/\s+running\s+shoe$/i, "");

  return s.trim();
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a DSG searchVO object. We omit zipcode/storeId/selectedStore unless env provided.
function buildSearchVO({ pageNumber, pageSize, selectedSort, selectedCategory }) {
  const selectedFilters = {
    // Try to ask for Running activity (your "filter to running" request)
    // This may or may not reduce results server-side depending on how DSG config is set.
    "4285": ["Running"],
  };

  const vo = {
    pageNumber,
    pageSize,
    selectedSort,
    selectedCategory,
    selectedFilters,
    isFamilyPage: true,
    mlBypass: false,
    snbAudience: "",
    includeFulfillmentFacets: false,
  };

  // Optional fields (only if you set env vars)
  if (process.env.DSG_SELECTED_STORE) vo.selectedStore = String(process.env.DSG_SELECTED_STORE);
  if (process.env.DSG_STORE_ID) vo.storeId = String(process.env.DSG_STORE_ID);
  if (process.env.DSG_ZIPCODE) vo.zipcode = String(process.env.DSG_ZIPCODE);

  return vo;
}

async function fetchDsgPage({ pageNumber, pageSize, selectedSort, selectedCategory }) {
  const searchVO = buildSearchVO({ pageNumber, pageSize, selectedSort, selectedCategory });
  const encoded = encodeURIComponent(JSON.stringify(searchVO));
  const url = `${DSG_API}${encoded}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      channel: "g3",
      "x-dsg-platform": "v2",
      // These two help mimic the real client a bit without overdoing it:
      origin: "https://www.goinggoinggone.com",
      referer: "https://www.goinggoinggone.com/",
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const msg = `DSG API HTTP ${resp.status}: ${text.slice(0, 600)}`;
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }

  return resp.json();
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const runId = `goinggoinggone-${Math.random().toString(36).slice(2, 10)}`;

  // Only allow GET for simplicity
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  const pageSize = asNumber(process.env.DSG_PAGE_SIZE) || 24;
  const selectedSort = asNumber(process.env.DSG_SELECTED_SORT) || 5;
  const selectedCategory = process.env.DSG_CATEGORY || "12301_10515458";

  // For your dashboard/sourceUrls
  // This is the user-facing page; the actual fetch uses the DSG API.
  const sourceUrls = [
    // A reasonable "running" version of your URL (the site might ignore it; still useful as reference)
    `https://www.goinggoinggone.com/f/shop-all-womens-sale?pageSize=${pageSize}`,
  ];

  const payload = {
    store: STORE,
    schemaVersion: SCHEMA_VERSION,
    lastUpdated: nowIso(),
    via: "vercel",

    sourceUrls,
    pagesFetched: 0,

    dealsFound: 0,
    dealsExtracted: 0,

    scrapeDurationMs: 0,

    ok: true,
    error: null,

    // FULL DATA ONLY IN BLOB JSON:
    deals: [],

    // Debug extras (keep; they help you troubleshoot)
    runId,
    pageNotes: [],
    dropCounts: {
      totalProducts: 0,
      dropped_notRunningShoes: 0,
      dropped_missingPrices: 0,
      dropped_missingUrl: 0,
      dropped_other: 0,
      kept: 0,
    },

    blobUrl: null,
  };

  try {
    // Fetch first page to get totalCount
    const first = await fetchDsgPage({
      pageNumber: 0,
      pageSize,
      selectedSort,
      selectedCategory,
    });

    const totalCount = asNumber(first.totalCount) ?? 0;
    payload.dealsFound = totalCount;

    const totalPages = totalCount > 0 ? Math.ceil(totalCount / pageSize) : 0;

    // Process a page response into deals
    const processPage = (pageJson, pageNumber) => {
      const productVOs = Array.isArray(pageJson.productVOs) ? pageJson.productVOs : [];
      payload.dropCounts.totalProducts += productVOs.length;

      payload.pageNotes.push({ pageNumber, cards: productVOs.length });

      for (const p of productVOs) {
        try {
          const name = String(p?.name || "").trim();
          if (!name) {
            payload.dropCounts.dropped_other += 1;
            continue;
          }

          // HARD RULE: must contain "running shoes"
          if (!/running\s+shoes/i.test(name)) {
            payload.dropCounts.dropped_notRunningShoes += 1;
            continue;
          }

          const brand = String(p?.mfName || "").trim() || "Unknown";
          const model = deriveModelFromName(name, brand);

          const listingURL = buildListingUrl(p?.assetSeoUrl || p?.dsgSeoUrl);
          if (!listingURL) {
            payload.dropCounts.dropped_missingUrl += 1;
            continue;
          }

          const imageURL = buildImageUrl(p?.thumbnail || p?.fullImage);

          const { salePrice, originalPrice } = extractPrices(p?.floatFacets);
          if (salePrice == null || originalPrice == null) {
            payload.dropCounts.dropped_missingPrices += 1;
            continue;
          }

          const discountPercent = computeDiscountPercent(salePrice, originalPrice);
          const gender = detectGenderFromAttributes(p?.attributes);

          payload.deals.push({
            schemaVersion: SCHEMA_VERSION,

            listingName: name,

            brand,
            model,

            salePrice,
            originalPrice,
            discountPercent,

            salePriceLow: null,
            salePriceHigh: null,
            originalPriceLow: null,
            originalPriceHigh: null,
            discountPercentUpTo: null,

            store: STORE,

            listingURL,
            imageURL,

            gender,
            shoeType: "unknown",
          });

          payload.dropCounts.kept += 1;
        } catch {
          payload.dropCounts.dropped_other += 1;
        }
      }
    };

    // First page
    processPage(first, 0);
    payload.pagesFetched = totalPages > 0 ? 1 : 0;

    // Remaining pages
    for (let pageNumber = 1; pageNumber < totalPages; pageNumber++) {
      const pageJson = await fetchDsgPage({
        pageNumber,
        pageSize,
        selectedSort,
        selectedCategory,
      });
      processPage(pageJson, pageNumber);
      payload.pagesFetched += 1;
    }

    payload.dealsExtracted = payload.deals.length;
    payload.scrapeDurationMs = Date.now() - t0;

    // Upload FULL JSON to blob (stable pathname)
    const blob = await put("going-going-gone.json", JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false, // IMPORTANT: stable overwrite
    });

    payload.blobUrl = blob.url;

    // ✅ Option A: SMALL SUMMARY ONLY (no deals[])
    return res.status(200).json({
      ok: payload.ok,
      store: payload.store,
      schemaVersion: payload.schemaVersion,
      lastUpdated: payload.lastUpdated,
      via: payload.via,

      sourceUrls: payload.sourceUrls,
      pagesFetched: payload.pagesFetched,

      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,

      scrapeDurationMs: payload.scrapeDurationMs,

      runId: payload.runId,
      blobUrl: payload.blobUrl,

      error: payload.error,
      dropCounts: payload.dropCounts,
      pageNotes: payload.pageNotes,
    });
  } catch (err) {
    payload.ok = false;
    payload.scrapeDurationMs = Date.now() - t0;
    payload.error = err?.message ? String(err.message) : "Unknown error";

    // Try to still write an error payload to blob (optional but useful)
    try {
      const blob = await put("going-going-gone.json", JSON.stringify(payload, null, 2), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
      });
      payload.blobUrl = blob.url;
    } catch {
      // ignore blob failure in error path
    }

    // Summary only (still no deals[])
    return res.status(200).json({
      ok: payload.ok,
      store: payload.store,
      schemaVersion: payload.schemaVersion,
      lastUpdated: payload.lastUpdated,
      via: payload.via,

      sourceUrls: payload.sourceUrls,
      pagesFetched: payload.pagesFetched,

      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,

      scrapeDurationMs: payload.scrapeDurationMs,

      runId: payload.runId,
      blobUrl: payload.blobUrl,

      error: payload.error,
    });
  }
};
