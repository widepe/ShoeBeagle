// /api/scrapers/super-runner-shop.js
// CommonJS Vercel function
//
// Store: Super Runners Shop
// Collection: https://superrunnersshop.com/collections/footear-sale-shoes
//
// Blob env var:
//   SUPERRUNNERSHOP_DEALS_BLOB_URL
//
// Saves blob to:
//   .../super-runner-shop.json
//
// Response:
// - NO deals array in response
// - Includes readable drop counts
// - Includes mens/womens/unisex/unknown totals
//
// Saved blob:
// - top-level metadata + deals array only
//
// Strategy: products.json only (collection HTML is JS-rendered, not scrapeable with Cheerio)

const { put } = require("@vercel/blob");

export const config = { maxDuration: 60 };

const STORE = "Super Runners Shop";
const BASE = "https://superrunnersshop.com";
const COLLECTION_PATH = "/collections/footear-sale-shoes";
const COLLECTION_URL = `${BASE}${COLLECTION_PATH}`;
const PRODUCTS_JSON_BASE = `${COLLECTION_URL}/products.json`;
const BLOB_ENV_KEY = "SUPERRUNNERSHOP_DEALS_BLOB_URL";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function toAbsUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/")) return `${BASE}${s}`;
  return `${BASE}/${s.replace(/^\/+/, "")}`;
}

function moneyToNumber(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function calcDiscountPercent(sale, original) {
  if (
    !Number.isFinite(sale) ||
    !Number.isFinite(original) ||
    original <= 0 ||
    sale >= original
  ) {
    return null;
  }
  return Math.round(((original - sale) / original) * 100);
}

function increment(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + by;
}

function stripGenderPrefix(title) {
  return cleanText(
    String(title || "")
      .replace(/^(men['']s|mens|men)\s+/i, "")
      .replace(/^(women['']s|womens|women)\s+/i, "")
      .replace(/^(unisex)\s+/i, "")
  );
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveModel(listingName, brand) {
  let model = stripGenderPrefix(listingName);
  if (brand) {
    model = model.replace(new RegExp(`^${escapeRegex(brand)}\\s+`, "i"), "");
  }
  return cleanText(model) || cleanText(listingName) || "Unknown";
}

function inferGenderFromText(...parts) {
  const hay = cleanText(parts.filter(Boolean).join(" ")).toLowerCase();
  if (/\bunisex\b/.test(hay)) return "unisex";
  if (/\b(women|women's|womens|wmns|ladies|lady)\b/.test(hay)) return "womens";
  if (/\b(men|men's|mens)\b/.test(hay)) return "mens";
  return "unknown";
}

function inferShoeType(product) {
  const hay = cleanText([
    product?.product_type,
    Array.isArray(product?.tags) ? product.tags.join(" ") : "",
    product?.title,
    product?.body_html,
  ]).toLowerCase();

  if (/\btrail\b/.test(hay)) return "trail";
  if (/\btrack\b/.test(hay)) return "track";
  if (/\broad\b/.test(hay)) return "road";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; ShoeBeagleBot/1.0; +https://shoebeagle.com)",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchAllProductsJson() {
  const products = [];
  const sourceUrls = [];

  for (let page = 1; page <= 40; page += 1) {
    const url = `${PRODUCTS_JSON_BASE}?limit=250&page=${page}`;
    const json = await fetchJson(url);
    const batch = Array.isArray(json?.products) ? json.products : [];

    if (!batch.length) break;

    products.push(...batch);
    sourceUrls.push(url);

    if (batch.length < 250) break;
  }

  return { products, sourceUrls };
}

// ---------------------------------------------------------------------------
// Deal extraction
// ---------------------------------------------------------------------------

function extractDealFromProduct(product, dropCounts, genderCounts) {
  const handle = cleanText(product?.handle);

  if (!handle) {
    increment(dropCounts, "missing_handle");
    return null;
  }

  const listingName = cleanText(product?.title);
  if (!listingName) {
    increment(dropCounts, "missing_title");
    return null;
  }

  // Find variants that are genuinely discounted
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const discountedVariants = variants.filter((v) => {
    const sale = moneyToNumber(v.price);
    const original = moneyToNumber(v.compare_at_price);
    return (
      Number.isFinite(sale) &&
      Number.isFinite(original) &&
      original > 0 &&
      sale < original
    );
  });

  if (!discountedVariants.length) {
    increment(dropCounts, "not_discounted");
    return null;
  }

  // Use the lowest sale price and the highest compare_at as the headline numbers
  const salePrice = Math.min(
    ...discountedVariants.map((v) => moneyToNumber(v.price))
  );
  const originalPrice = Math.max(
    ...discountedVariants.map((v) => moneyToNumber(v.compare_at_price))
  );

  if (!Number.isFinite(salePrice)) {
    increment(dropCounts, "missing_sale_price");
    return null;
  }

  if (!Number.isFinite(originalPrice)) {
    increment(dropCounts, "missing_original_price");
    return null;
  }

  // Price range fields (useful when variants span a range)
  const allSalePrices = discountedVariants.map((v) => moneyToNumber(v.price));
  const allOriginalPrices = discountedVariants.map((v) =>
    moneyToNumber(v.compare_at_price)
  );

  const salePriceLow = Math.min(...allSalePrices);
  const salePriceHigh = Math.max(...allSalePrices);
  const originalPriceLow = Math.min(...allOriginalPrices);
  const originalPriceHigh = Math.max(...allOriginalPrices);

  // Image — use first product image
  const imageURL = toAbsUrl(
    Array.isArray(product.images) && product.images.length
      ? product.images[0].src
      : null
  );

  if (!imageURL) {
    increment(dropCounts, "missing_image");
    return null;
  }

  const brand =
    cleanText(product.vendor) || "Unknown";

  const gender = inferGenderFromText(
    listingName,
    handle,
    Array.isArray(product.tags) ? product.tags.join(" ") : ""
  );

  const shoeType = inferShoeType(product);

  genderCounts[gender] = (genderCounts[gender] || 0) + 1;

  return {
    schemaVersion: 1,

    listingName,

    brand,
    model: deriveModel(listingName, brand),

    salePrice,
    originalPrice,
    discountPercent: calcDiscountPercent(salePrice, originalPrice),

    salePriceLow: salePriceLow !== salePriceHigh ? salePriceLow : null,
    salePriceHigh: salePriceLow !== salePriceHigh ? salePriceHigh : null,
    originalPriceLow:
      originalPriceLow !== originalPriceHigh ? originalPriceLow : null,
    originalPriceHigh:
      originalPriceLow !== originalPriceHigh ? originalPriceHigh : null,
    discountPercentUpTo:
      salePriceLow !== salePriceHigh
        ? calcDiscountPercent(salePriceLow, originalPriceHigh)
        : null,

    store: STORE,

    listingURL: toAbsUrl(`/products/${handle}`),
    imageURL,

    gender,
    shoeType,
  };
}

function prettyDropCounts(dropCounts) {
  return {
    missingHandle: dropCounts.missing_handle || 0,
    missingTitle: dropCounts.missing_title || 0,
    missingSalePrice: dropCounts.missing_sale_price || 0,
    missingOriginalPrice: dropCounts.missing_original_price || 0,
    notDiscounted: dropCounts.not_discounted || 0,
    missingImage: dropCounts.missing_image || 0,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  const started = Date.now();

  // TEMPORARILY COMMENTED OUT FOR TESTING
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const dropCounts = {};
  const genderCounts = {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };

  try {
    const { products, sourceUrls } = await fetchAllProductsJson();

    const deals = [];

    for (const product of products) {
      const deal = extractDealFromProduct(product, dropCounts, genderCounts);
      if (deal) deals.push(deal);
    }

    const lastUpdated = nowIso();
    const blobPath =
      process.env[BLOB_ENV_KEY] || "super-runner-shop.json";

    const blobData = {
      store: STORE,
      schemaVersion: 1,

      lastUpdated,
      via: "shopify-products-json",

      sourceUrls,

      pagesFetched: sourceUrls.length,

      dealsFound: products.length,
      dealsExtracted: deals.length,

      mensDeals: genderCounts.mens,
      womensDeals: genderCounts.womens,
      unisexDeals: genderCounts.unisex,
      unknownGenderDeals: genderCounts.unknown,

      scrapeDurationMs: Date.now() - started,

      ok: true,
      error: null,

      deals,
    };

    await put(blobPath, JSON.stringify(blobData, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    return res.status(200).json({
      success: true,

      store: STORE,
      schemaVersion: 1,

      lastUpdated,
      via: "shopify-products-json",

      sourceUrls: blobData.sourceUrls,
      pagesFetched: blobData.pagesFetched,

      dealsFound: blobData.dealsFound,
      dealsExtracted: blobData.dealsExtracted,

      mensDeals: blobData.mensDeals,
      womensDeals: blobData.womensDeals,
      unisexDeals: blobData.unisexDeals,
      unknownGenderDeals: blobData.unknownGenderDeals,

      scrapeDurationMs: blobData.scrapeDurationMs,

      ok: true,
      error: null,

      dropCounts: prettyDropCounts(dropCounts),
      blobPath,

      note: "Response intentionally omits deals[]. Saved blob contains only top-level metadata and deals[].",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,

      store: STORE,
      schemaVersion: 1,

      lastUpdated: nowIso(),
      via: "shopify-products-json",

      sourceUrls: [PRODUCTS_JSON_BASE],
      pagesFetched: 0,

      dealsFound: 0,
      dealsExtracted: 0,

      mensDeals: 0,
      womensDeals: 0,
      unisexDeals: 0,
      unknownGenderDeals: 0,

      scrapeDurationMs: Date.now() - started,

      ok: false,
      error: err?.message || "Unknown error",

      dropCounts: prettyDropCounts(dropCounts),
    });
  }
}
