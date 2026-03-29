// /api/scrapers/runnersplus.js
// CommonJS
//
// Runners Plus Shopify scraper using collection products.json pagination.
// No HTML scraping. No section_id. No product-detail fetches.
//
// Writes FULL payload (including deals[]) to Vercel Blob at /runnersplus.json
// but returns ONLY top-level structure + blobUrl.
//
// Notes:
// - Uses /collections/<handle>/products.json?limit=250&page=N
// - Stops when a page returns no products
// - Keeps only discounted items with real compare_at_price > price
// - Dedupe by listingURL
// - Includes basic dropCounts + pageSummaries
//
// CRON auth included but commented out for testing.

const { put } = require("@vercel/blob");

const STORE = "Runners Plus";
const SCHEMA_VERSION = 1;
const VIA = "shopify-products-json";
const BASE = "https://www.runnersplus.com";
const BLOB_PATHNAME = "runnersplus.json";

const TIMEOUT_MS = 25_000;
const PAGE_DELAY_MS = 350;
const MAX_PAGES_PER_COLLECTION = 50;

const COLLECTIONS = [
  {
    id: "mens",
    handle: "mens-sale",
    fallbackGender: "mens",
    publicUrl: `${BASE}/collections/mens-sale?filter.v.availability=1&sort_by=created-descending`,
  },
  {
    id: "womens",
    handle: "womens-sale",
    fallbackGender: "womens",
    publicUrl: `${BASE}/collections/womens-sale?filter.v.availability=1&sort_by=created-descending`,
  },
  {
    id: "unisex",
    handle: "sale",
    fallbackGender: "unisex",
    publicUrl: `${BASE}/collections/sale?filter.v.availability=1&sort_by=created-descending`,
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function normalizeBrand(vendor) {
  const v = cleanInvisible(vendor || "");
  if (!v) return "";
  return v
    .replace(/^Hoka One One$/i, "HOKA")
    .replace(/^On Running$/i, "On")
    .replace(/^New Balance Athletics,?\s*Inc\.?$/i, "New Balance")
    .trim();
}

function deriveGenderFromTitleFirst(title, fallbackGender) {
  const t = cleanInvisible(title || "").toLowerCase();

  if (/^men['’]?s\s+/.test(t) || /^mens\s+/.test(t)) return "mens";
  if (/^women['’]?s\s+/.test(t) || /^womens\s+/.test(t)) return "womens";
  if (/^unisex\s+/.test(t)) return "unisex";

  return fallbackGender || "unknown";
}

function deriveGenderFromProductType(productType, fallbackGender) {
  const t = cleanInvisible(productType || "").toLowerCase();

  if (t.includes("men >")) return "mens";
  if (t.includes("women >")) return "womens";
  if (t.includes("unisex >")) return "unisex";

  return fallbackGender || "unknown";
}

function deriveShoeType(productType, tags, title) {
  const p = cleanInvisible(productType || "").toLowerCase();
  const joinedTags = Array.isArray(tags) ? tags.join(" ").toLowerCase() : "";
  const ttl = cleanInvisible(title || "").toLowerCase();
  const hay = `${p} ${joinedTags} ${ttl}`;

  // XC must stay separate
  if (/\bx[\s-]?country\b|\bxc\b/.test(hay)) return "XC";

  if (/\btrack\b|\bspike\b|\bmid-distance\b|\bdistance\b|\bsprint\b|\bfield\b/.test(hay)) {
    return "track";
  }

  if (/\btrail\b/.test(hay)) return "trail";

  if (/\brunning\b|\broad\b|\brace\b|\bracing\b/.test(hay)) return "road";

  return "unknown";
}

function deriveModelFromTitle(title, vendor) {
  let t = cleanInvisible(title || "");
  const brand = cleanInvisible(vendor || "");

  t = t
    .replace(/^Men['’]?s\s+/i, "")
    .replace(/^Mens\s+/i, "")
    .replace(/^Women['’]?s\s+/i, "")
    .replace(/^Womens\s+/i, "")
    .replace(/^Unisex\s+/i, "")
    .trim();

  if (brand) {
    const re = new RegExp(`^${escapeRegExp(brand)}\\s+`, "i");
    t = t.replace(re, "").trim();
  }

  return cleanInvisible(t);
}

function makeProductUrl(handle) {
  return handle ? `${BASE}/products/${handle}` : null;
}

function chooseImageUrl(product) {
  if (product?.image?.src) return product.image.src;

  if (Array.isArray(product?.images) && product.images.length) {
    const first = product.images[0];
    if (typeof first === "string") return first;
    if (first?.src) return first.src;
  }

  if (Array.isArray(product?.variants)) {
    for (const v of product.variants) {
      if (v?.featured_image?.src) return v.featured_image.src;
    }
  }

  return null;
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json,text/plain,*/*",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} (${text.slice(0, 200)})`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function initDropCounts() {
  return {
    missingTitle: 0,
    missingVendor: 0,
    missingHandle: 0,
    missingImage: 0,
    missingSalePrice: 0,
    missingOriginalPrice: 0,
    notDiscounted: 0,
    noDiscountedVariants: 0,
    duplicateListingURL: 0,
    invalidProductShape: 0,
  };
}

function summarizeGenderCounts(deals) {
  let mensDeals = 0;
  let womensDeals = 0;
  let unisexDeals = 0;
  let unknownGenderDeals = 0;

  for (const d of deals) {
    if (d.gender === "mens") mensDeals++;
    else if (d.gender === "womens") womensDeals++;
    else if (d.gender === "unisex") unisexDeals++;
    else unknownGenderDeals++;
  }

  return { mensDeals, womensDeals, unisexDeals, unknownGenderDeals };
}

function summarizeShoeTypeCounts(deals) {
  let dealsRoad = 0;
  let dealsTrail = 0;
  let dealsTrack = 0;
  let dealsXC = 0;
  let dealsUnknownType = 0;

  for (const d of deals) {
    if (d.shoeType === "road") dealsRoad++;
    else if (d.shoeType === "trail") dealsTrail++;
    else if (d.shoeType === "track") dealsTrack++;
    else if (d.shoeType === "XC") dealsXC++;
    else dealsUnknownType++;
  }

  return { dealsRoad, dealsTrail, dealsTrack, dealsXC, dealsUnknownType };
}

function buildDealFromProduct(product, fallbackGender, dropCounts) {
  if (!product || typeof product !== "object") {
    dropCounts.invalidProductShape++;
    return null;
  }

  const listingName = cleanInvisible(product.title || "");
  const brand = normalizeBrand(product.vendor || "");
  const listingURL = makeProductUrl(product.handle);
  const imageURL = chooseImageUrl(product);

  if (!listingName) {
    dropCounts.missingTitle++;
    return null;
  }

  if (!brand) {
    dropCounts.missingVendor++;
    return null;
  }

  if (!product.handle) {
    dropCounts.missingHandle++;
    return null;
  }

  if (!imageURL) {
    dropCounts.missingImage++;
    return null;
  }

  const model = deriveModelFromTitle(listingName, brand);

  const genderFromTitle = deriveGenderFromTitleFirst(listingName, null);
  const gender = genderFromTitle || deriveGenderFromProductType(product.product_type, fallbackGender);

  const shoeType = deriveShoeType(product.product_type, product.tags, listingName);

  const salePrices = [];
  const originalPrices = [];

  for (const variant of Array.isArray(product.variants) ? product.variants : []) {
    const sale = parseMoney(variant?.price);
    const original = parseMoney(variant?.compare_at_price);

    if (!Number.isFinite(sale)) {
      dropCounts.missingSalePrice++;
      continue;
    }

    if (!Number.isFinite(original)) {
      dropCounts.missingOriginalPrice++;
      continue;
    }

    if (!(original > sale)) {
      dropCounts.notDiscounted++;
      continue;
    }

    salePrices.push(sale);
    originalPrices.push(original);
  }

  if (!salePrices.length || !originalPrices.length) {
    dropCounts.noDiscountedVariants++;
    return null;
  }

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

    gender: gender || fallbackGender || "unknown",
    shoeType,
  };
}

async function fetchCollectionPages(collection, pageSummaries) {
  const products = [];
  let pagesFetched = 0;

  for (let page = 1; page <= MAX_PAGES_PER_COLLECTION; page++) {
    const url =
      `${BASE}/collections/${collection.handle}/products.json` +
      `?limit=250&page=${page}`;

    const data = await fetchJson(url, TIMEOUT_MS);
    const pageProducts = Array.isArray(data?.products) ? data.products : [];

    pageSummaries.push({
      collection: collection.id,
      page,
      url,
      productsReturned: pageProducts.length,
    });

    pagesFetched++;

    if (!pageProducts.length) break;

    products.push(...pageProducts);

    if (page < MAX_PAGES_PER_COLLECTION) {
      await sleep(PAGE_DELAY_MS);
    }
  }

  return { pagesFetched, products };
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();

  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const sourceUrls = COLLECTIONS.map((c) => c.publicUrl);
  const dropCounts = initDropCounts();
  const pageSummaries = [];

  let pagesFetched = 0;
  let dealsFound = 0;
  let dealsExtracted = 0;
  let ok = true;
  let error = null;

  try {
    const allProducts = [];

    for (const collection of COLLECTIONS) {
      const result = await fetchCollectionPages(collection, pageSummaries);
      pagesFetched += result.pagesFetched;

      for (const product of result.products) {
        allProducts.push({
          product,
          fallbackGender: collection.fallbackGender,
        });
      }
    }

    dealsFound = allProducts.length;

    const deals = [];
    const seenListingURLs = new Set();

    for (const { product, fallbackGender } of allProducts) {
      const deal = buildDealFromProduct(product, fallbackGender, dropCounts);
      if (!deal) continue;

      if (seenListingURLs.has(deal.listingURL)) {
        dropCounts.duplicateListingURL++;
        continue;
      }

      seenListingURLs.add(deal.listingURL);
      deals.push(deal);
    }

    dealsExtracted = deals.length;

    const genderCounts = summarizeGenderCounts(deals);
    const shoeTypeCounts = summarizeShoeTypeCounts(deals);

    const fullPayload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted,

      ...genderCounts,
      ...shoeTypeCounts,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      dropCounts,
      pageSummaries,
      deals,
    };

    const blob = await put(BLOB_PATHNAME, JSON.stringify(fullPayload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    return res.status(200).json({
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: fullPayload.lastUpdated,
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted,

      ...genderCounts,
      ...shoeTypeCounts,

      scrapeDurationMs: fullPayload.scrapeDurationMs,

      ok: true,
      error: null,

      dropCounts,
      pageSummaries,
      blobUrl: blob.url,
    });
  } catch (e) {
    ok = false;
    error = String(e?.message || e);

    const failurePayload = {
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

      dropCounts,
      pageSummaries,
      deals: [],
    };

    let blobUrl = null;

    try {
      const blob = await put(BLOB_PATHNAME, JSON.stringify(failurePayload, null, 2), {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
      });
      blobUrl = blob.url;
    } catch (_) {}

    return res.status(200).json({
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: failurePayload.lastUpdated,
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: 0,

      scrapeDurationMs: failurePayload.scrapeDurationMs,

      ok,
      error,

      dropCounts,
      pageSummaries,
      blobUrl,
    });
  }
};
