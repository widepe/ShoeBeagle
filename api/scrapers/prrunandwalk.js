// /api/scrapers/prrunandwalk.js
// CommonJS Vercel function
//
// Store: PR Run & Walk
// Collections:
//   https://prrunandwalk.com/collections/mens-clearance-footwear
//   https://prrunandwalk.com/collections/womens-clearance-footwear
//
// Blob env var:
//   PRRUNANDWALK_DEALS_BLOB_URL
//
// Saves blob to:
//   .../prrunandwalk.json
//
// Response:
// - NO deals array in response
// - Includes readable drop counts
// - Includes page summaries per collection
// - Includes mens/womens/unisex/unknown totals
//
// Saved blob:
// - top-level metadata + deals array only
//
// Strategy: Shopify products.json only (two clearance collections)
//
// shoeType mapping (from product tags):
//   "Running & Walking" → road
//   "Trail"             → trail
//   "Cross Country"     → xc
//   "Track & Field"     → track
//   anything else       → unknown

const { put } = require("@vercel/blob");

export const config = { maxDuration: 60 };

const STORE = "PR Run & Walk";
const BASE = "https://prrunandwalk.com";
const BLOB_ENV_KEY = "PRRUNANDWALK_DEALS_BLOB_URL";

const COLLECTIONS = [
  {
    key: "mens",
    path: "/collections/mens-clearance-footwear",
    inferredGender: "mens",
  },
  {
    key: "womens",
    path: "/collections/womens-clearance-footwear",
    inferredGender: "womens",
  },
];

const HIDDEN_PRICE_PATTERNS = [
  /see\s+price\s+in\s+cart/i,
  /see\s+price\s+in\s+bag/i,
  /see\s+price\s+at\s+checkout/i,
  /add\s+to\s+cart\s+to\s+see\s+price/i,
  /add\s+to\s+bag\s+to\s+see\s+price/i,
  /price\s+in\s+cart/i,
  /price\s+in\s+bag/i,
  /hidden\s+price/i,
  /add\s+for\s+price/i,
  /login\s+to\s+see\s+price/i,
];

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

function inferShoeTypeFromTags(tags) {
  if (!Array.isArray(tags)) return "unknown";
  const joined = tags.join(" ").toLowerCase();

  // Order matters — check most specific first
  if (/\btrail\b/.test(joined)) return "trail";
  if (/\btrack\s*&\s*field\b/.test(joined) || /\btrack\b/.test(joined)) return "track";
  if (/\bcross\s*country\b/.test(joined)) return "xc";
  if (/\brunning\s*&\s*walking\b/.test(joined) || /\brunning\b/.test(joined)) return "road";
  return "unknown";
}

function looksLikeHiddenPrice(text) {
  const t = cleanText(text);
  return HIDDEN_PRICE_PATTERNS.some((rx) => rx.test(t));
}

function makeSummary(key, collectionUrl) {
  return {
    collection: key,
    url: collectionUrl,
    pagesFetched: 0,
    productsFound: 0,
    dealsExtracted: 0,
    dropped: {
      missingHandle: 0,
      missingTitle: 0,
      hiddenPrice: 0,
      missingSalePrice: 0,
      missingOriginalPrice: 0,
      notDiscounted: 0,
      missingImage: 0,
    },
  };
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

async function fetchCollectionProducts(collectionPath) {
  const products = [];
  const sourceUrls = [];
  const base = `${BASE}${collectionPath}/products.json`;

  for (let page = 1; page <= 40; page += 1) {
    const url = `${base}?limit=250&page=${page}`;
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

function extractDeal(product, collectionGender, summary) {
  const handle = cleanText(product?.handle);

  if (!handle) {
    increment(summary.dropped, "missingHandle");
    return null;
  }

  const listingName = cleanText(product?.title);
  if (!listingName) {
    increment(summary.dropped, "missingTitle");
    return null;
  }

  // Hidden-price check: scan title + body_html
  const textToCheck = `${listingName} ${cleanText(product?.body_html || "")}`;
  if (looksLikeHiddenPrice(textToCheck)) {
    increment(summary.dropped, "hiddenPrice");
    return null;
  }

  // Find discounted variants
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
    increment(summary.dropped, "notDiscounted");
    return null;
  }

  const allSalePrices = discountedVariants.map((v) => moneyToNumber(v.price));
  const allOriginalPrices = discountedVariants.map((v) =>
    moneyToNumber(v.compare_at_price)
  );

  const salePrice = Math.min(...allSalePrices);
  const originalPrice = Math.max(...allOriginalPrices);

  if (!Number.isFinite(salePrice)) {
    increment(summary.dropped, "missingSalePrice");
    return null;
  }

  if (!Number.isFinite(originalPrice)) {
    increment(summary.dropped, "missingOriginalPrice");
    return null;
  }

  const salePriceLow = Math.min(...allSalePrices);
  const salePriceHigh = Math.max(...allSalePrices);
  const originalPriceLow = Math.min(...allOriginalPrices);
  const originalPriceHigh = Math.max(...allOriginalPrices);

  const hasPriceRange = salePriceLow !== salePriceHigh;

  // Image — prefer first product-level image, fall back to first variant featured_image
  let imageURL =
    Array.isArray(product.images) && product.images.length
      ? toAbsUrl(product.images[0].src)
      : null;

  if (!imageURL) {
    const firstVariantImage = variants[0]?.featured_image?.src;
    imageURL = toAbsUrl(firstVariantImage || null);
  }

  if (!imageURL) {
    increment(summary.dropped, "missingImage");
    return null;
  }

  const brand = cleanText(product.vendor) || "Unknown";

  // Gender: prefer tag/title inference, fall back to collection gender
  const inferredGender = inferGenderFromText(
    listingName,
    handle,
    Array.isArray(product.tags) ? product.tags.join(" ") : ""
  );
  const gender =
    inferredGender !== "unknown" ? inferredGender : collectionGender;

  const shoeType = inferShoeTypeFromTags(product.tags);

  summary.dealsExtracted += 1;

  return {
    schemaVersion: 1,

    listingName,

    brand,
    model: deriveModel(listingName, brand),

    salePrice,
    originalPrice,
    discountPercent: calcDiscountPercent(salePrice, originalPrice),

    salePriceLow: hasPriceRange ? salePriceLow : null,
    salePriceHigh: hasPriceRange ? salePriceHigh : null,
    originalPriceLow: hasPriceRange ? originalPriceLow : null,
    originalPriceHigh: hasPriceRange ? originalPriceHigh : null,
    discountPercentUpTo: hasPriceRange
      ? calcDiscountPercent(salePriceLow, originalPriceHigh)
      : null,

    store: STORE,

    listingURL: toAbsUrl(`/products/${handle}`),
    imageURL,

    gender,
    shoeType,
  };
}

// ---------------------------------------------------------------------------
// Pretty helpers for response
// ---------------------------------------------------------------------------

function prettyDropCounts(dropped) {
  return {
    missingHandle: dropped.missingHandle || 0,
    missingTitle: dropped.missingTitle || 0,
    hiddenPrice: dropped.hiddenPrice || 0,
    missingSalePrice: dropped.missingSalePrice || 0,
    missingOriginalPrice: dropped.missingOriginalPrice || 0,
    notDiscounted: dropped.notDiscounted || 0,
    missingImage: dropped.missingImage || 0,
  };
}

function prettySummary(s) {
  return {
    collection: s.collection,
    url: s.url,
    pagesFetched: s.pagesFetched,
    productsFound: s.productsFound,
    dealsExtracted: s.dealsExtracted,
    dropped: prettyDropCounts(s.dropped),
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

  const genderCounts = {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };

  try {
    const allDeals = [];
    const allSourceUrls = [];
    const collectionSummaries = [];
    let totalPagesFetched = 0;
    let totalProductsFound = 0;

    for (const col of COLLECTIONS) {
      const collectionUrl = `${BASE}${col.path}`;
      const summary = makeSummary(col.key, collectionUrl);

      const { products, sourceUrls } = await fetchCollectionProducts(col.path);

      summary.pagesFetched = sourceUrls.length;
      summary.productsFound = products.length;
      totalPagesFetched += sourceUrls.length;
      totalProductsFound += products.length;
      allSourceUrls.push(...sourceUrls);

      for (const product of products) {
        const deal = extractDeal(product, col.inferredGender, summary);
        if (deal) {
          allDeals.push(deal);
          genderCounts[deal.gender] = (genderCounts[deal.gender] || 0) + 1;
        }
      }

      collectionSummaries.push(summary);
    }

    const lastUpdated = nowIso();
    const blobPath =
      process.env[BLOB_ENV_KEY] || "prrunandwalk.json";

    const blobData = {
      store: STORE,
      schemaVersion: 1,

      lastUpdated,
      via: "shopify-products-json",

      sourceUrls: allSourceUrls,

      pagesFetched: totalPagesFetched,

      dealsFound: totalProductsFound,
      dealsExtracted: allDeals.length,

      mensDeals: genderCounts.mens,
      womensDeals: genderCounts.womens,
      unisexDeals: genderCounts.unisex,
      unknownGenderDeals: genderCounts.unknown,

      scrapeDurationMs: Date.now() - started,

      ok: true,
      error: null,

      deals: allDeals,
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

      sourceUrls: allSourceUrls,
      pagesFetched: totalPagesFetched,

      dealsFound: totalProductsFound,
      dealsExtracted: allDeals.length,

      mensDeals: genderCounts.mens,
      womensDeals: genderCounts.womens,
      unisexDeals: genderCounts.unisex,
      unknownGenderDeals: genderCounts.unknown,

      scrapeDurationMs: Date.now() - started,

      ok: true,
      error: null,

      collectionSummaries: collectionSummaries.map(prettySummary),
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

      sourceUrls: [],
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

      collectionSummaries: [],
    });
  }
}
