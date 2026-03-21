// /api/scrapers/front-runners-la.js
// CommonJS Vercel function
//
// Front Runners LA is Shopify.
// This scraper reads collection products.json endpoints directly.
//
// Rules implemented:
// - Keep ONLY products that have at least one variant with BOTH price and compare_at_price
// - Drop products with only one price
// - Brand = Shopify vendor
// - Model = listingName with leading gender/brand stripped
// - shoeType = road for running collections, trail for trail collections
// - gender = mens / womens from source config
// - Skip hidden-price products if any hidden-price phrase appears in text
// - Response JSON does NOT include deals array
// - Saved blob JSON DOES include top-level structure + deals array only
//
// Env:
// - BLOB_READ_WRITE_TOKEN
// - FRONTRUNNERSLA_DEALS_BLOB_URL
// - CRON_SECRET (left commented out for testing)

const { put } = require("@vercel/blob");

const STORE = "Front Runners LA";
const SCHEMA_VERSION = 1;

const COLLECTIONS = [
  {
    key: "mens-road",
    label: "Men's Road",
    gender: "mens",
    shoeType: "road",
    collectionUrl: "https://frontrunnersla.com/collections/mens-running-shoes-in-los-angeles",
  },
  {
    key: "womens-road",
    label: "Women's Road",
    gender: "womens",
    shoeType: "road",
    collectionUrl: "https://frontrunnersla.com/collections/women-tech-footwear-running",
  },
  {
    key: "mens-trail",
    label: "Men's Trail",
    gender: "mens",
    shoeType: "trail",
    collectionUrl: "https://frontrunnersla.com/collections/mens-tech-footwear-trail-los-angeles",
  },
  {
    key: "womens-trail",
    label: "Women's Trail",
    gender: "womens",
    shoeType: "trail",
    collectionUrl: "https://frontrunnersla.com/collections/women-tech-footwear-trail",
  },
];

const HIDDEN_PRICE_PATTERNS = [
  /see\s+price\s+in\s+cart/i,
  /see\s+price\s+in\s+bag/i,
  /add\s+to\s+bag\s+to\s+see\s+price/i,
  /add\s+to\s+cart\s+to\s+see\s+price/i,
  /price\s+in\s+cart/i,
  /price\s+in\s+bag/i,
  /hidden\s+price/i,
];

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function discountPct(original, sale) {
  if (
    !Number.isFinite(original) ||
    !Number.isFinite(sale) ||
    original <= 0 ||
    sale >= original
  ) {
    return null;
  }
  return round2(((original - sale) / original) * 100);
}

function uniqNumbers(values) {
  return [...new Set(values.filter((v) => Number.isFinite(v)).map((v) => round2(v)))];
}

function minOrNull(arr) {
  return arr.length ? Math.min(...arr) : null;
}

function maxOrNull(arr) {
  return arr.length ? Math.max(...arr) : null;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstImageUrl(product) {
  const images = safeArray(product.images);
  const src = images[0] && images[0].src;
  return typeof src === "string" && src.trim() ? src.trim() : null;
}

function makeListingUrl(handle) {
  if (!handle) return null;
  return `https://frontrunnersla.com/products/${handle}`;
}

function normalizeWhitespace(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
}

function stripGenderPrefix(title) {
  let s = normalizeWhitespace(title);

  s = s.replace(/^Men['’]s\s+/i, "");
  s = s.replace(/^Women['’]s\s+/i, "");
  s = s.replace(/^Mens\s+/i, "");
  s = s.replace(/^Womens\s+/i, "");
  s = s.replace(/^Unisex\s+/i, "");

  return normalizeWhitespace(s);
}

function stripLeadingBrand(model, brand) {
  if (!brand) return model;
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return normalizeWhitespace(model.replace(new RegExp(`^${escaped}\\s+`, "i"), ""));
}

function deriveModel(listingName, brand) {
  const noGender = stripGenderPrefix(listingName);
  return stripLeadingBrand(noGender, brand) || noGender || "Unknown";
}

function hasHiddenPrice(product) {
  const haystack = JSON.stringify({
    title: product.title,
    body_html: product.body_html,
    tags: product.tags,
    product_type: product.product_type,
  });

  return HIDDEN_PRICE_PATTERNS.some((re) => re.test(haystack));
}

function buildJsonUrl(collectionUrl, page) {
  const u = new URL(collectionUrl);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/products.json`;
  u.searchParams.set("limit", "250");
  u.searchParams.set("page", String(page));
  return u.toString();
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept": "application/json,text/plain,*/*",
    },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }

  return resp.json();
}

function parseProductToDeal(product, source, dropCounts) {
  const listingName = normalizeWhitespace(product.title || "");
  const listingURL = makeListingUrl(product.handle);
  const imageURL = firstImageUrl(product);
  const brand = normalizeWhitespace(product.vendor || "") || "Unknown";
  const model = deriveModel(listingName, brand);

  if (hasHiddenPrice(product)) {
    dropCounts.dropped_hiddenPrice = (dropCounts.dropped_hiddenPrice || 0) + 1;
    return null;
  }

  if (!listingName) {
    dropCounts.dropped_missingListingName = (dropCounts.dropped_missingListingName || 0) + 1;
    return null;
  }

  if (!listingURL) {
    dropCounts.dropped_missingListingURL = (dropCounts.dropped_missingListingURL || 0) + 1;
    return null;
  }

  if (!imageURL) {
    dropCounts.dropped_missingImageURL = (dropCounts.dropped_missingImageURL || 0) + 1;
    return null;
  }

  const variants = safeArray(product.variants);
  if (!variants.length) {
    dropCounts.dropped_noVariants = (dropCounts.dropped_noVariants || 0) + 1;
    return null;
  }

  const pricedVariants = [];
  let sawMissingSale = false;
  let sawMissingOriginal = false;

  for (const variant of variants) {
    const sale = toNumber(variant.price);
    const original = toNumber(variant.compare_at_price);

    if (!Number.isFinite(sale)) sawMissingSale = true;
    if (!Number.isFinite(original)) sawMissingOriginal = true;

    if (!Number.isFinite(sale) || !Number.isFinite(original)) continue;
    if (sale >= original) continue;

    pricedVariants.push({ sale, original, discount: discountPct(original, sale) });
  }

  if (!pricedVariants.length) {
    if (sawMissingSale) {
      dropCounts.dropped_missingSalePrice =
        (dropCounts.dropped_missingSalePrice || 0) + 1;
    }
    if (sawMissingOriginal) {
      dropCounts.dropped_missingOriginalPrice =
        (dropCounts.dropped_missingOriginalPrice || 0) + 1;
    }
    if (!sawMissingSale && !sawMissingOriginal) {
      dropCounts.dropped_saleNotLessThanOriginal =
        (dropCounts.dropped_saleNotLessThanOriginal || 0) + 1;
    }
    return null;
  }

  const saleValues = uniqNumbers(pricedVariants.map((v) => v.sale));
  const originalValues = uniqNumbers(pricedVariants.map((v) => v.original));
  const discountValues = uniqNumbers(pricedVariants.map((v) => v.discount));

  const singleSale = saleValues.length === 1 ? saleValues[0] : null;
  const singleOriginal = originalValues.length === 1 ? originalValues[0] : null;
  const singleDiscount = discountValues.length === 1 ? discountValues[0] : null;

  return {
    schemaVersion: SCHEMA_VERSION,

    listingName,

    brand,
    model,

    salePrice: singleSale,
    originalPrice: singleOriginal,
    discountPercent: singleDiscount,

    salePriceLow: saleValues.length > 1 ? minOrNull(saleValues) : null,
    salePriceHigh: saleValues.length > 1 ? maxOrNull(saleValues) : null,

    originalPriceLow: originalValues.length > 1 ? minOrNull(originalValues) : null,
    originalPriceHigh: originalValues.length > 1 ? maxOrNull(originalValues) : null,

    discountPercentUpTo: discountValues.length > 1 ? maxOrNull(discountValues) : null,

    store: STORE,

    listingURL,
    imageURL,

    gender: source.gender,
    shoeType: source.shoeType,
  };
}

function initialDropCounts() {
  return {
    totalProductsSeen: 0,
    dropped_hiddenPrice: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_duplicateAfterMerge: 0,
    dropped_noVariants: 0,
  };
}

function blobPathFromEnv() {
  const url = process.env.FRONTRUNNERSLA_DEALS_BLOB_URL;
  if (!url) {
    return "front-runners-la.json";
  }

  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/+/, "") || "front-runners-la.json";
  } catch {
    return "front-runners-la.json";
  }
}

async function scrapeCollection(source) {
  const pageSummaries = [];
  const dropCounts = initialDropCounts();
  const deals = [];

  const seenProductIds = new Set();
  const sourceUrls = [];

  for (let page = 1; page <= 50; page += 1) {
    const jsonUrl = buildJsonUrl(source.collectionUrl, page);
    sourceUrls.push(jsonUrl);

    const data = await fetchJson(jsonUrl);
    const products = safeArray(data.products);

    if (!products.length) {
      break;
    }

    let pageSeen = 0;
    let pageKept = 0;

    for (const product of products) {
      if (!product || seenProductIds.has(product.id)) continue;
      seenProductIds.add(product.id);

      pageSeen += 1;
      dropCounts.totalProductsSeen += 1;

      const deal = parseProductToDeal(product, source, dropCounts);
      if (!deal) continue;

      deals.push(deal);
      pageKept += 1;
    }

    pageSummaries.push({
      collection: source.label,
      page,
      jsonUrl,
      productsSeen: pageSeen,
      dealsKept: pageKept,
      gender: source.gender,
      shoeType: source.shoeType,
    });

    if (products.length < 250) {
      break;
    }
  }

  return {
    sourceUrls,
    deals,
    pageSummaries,
    dropCounts,
  };
}

module.exports = async function handler(req, res) {
  const started = Date.now();

  // Temporarily commented out for testing.
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  try {
    const allDeals = [];
    const allSourceUrls = [];
    const allPageSummaries = [];
    const combinedDropCounts = initialDropCounts();

    for (const source of COLLECTIONS) {
      const result = await scrapeCollection(source);

      allDeals.push(...result.deals);
      allSourceUrls.push(...result.sourceUrls);
      allPageSummaries.push(...result.pageSummaries);

      for (const [k, v] of Object.entries(result.dropCounts)) {
        combinedDropCounts[k] = (combinedDropCounts[k] || 0) + (v || 0);
      }
    }

    const dedupedDeals = [];
    const seenKeys = new Set();

    for (const deal of allDeals) {
      const key = deal.listingURL;
      if (seenKeys.has(key)) {
        combinedDropCounts.dropped_duplicateAfterMerge += 1;
        continue;
      }
      seenKeys.add(key);
      dedupedDeals.push(deal);
    }

    const genderCounts = {
      mens: 0,
      womens: 0,
      unisex: 0,
      unknown: 0,
    };

    for (const deal of dedupedDeals) {
      if (!genderCounts.hasOwnProperty(deal.gender)) {
        genderCounts.unknown += 1;
      } else {
        genderCounts[deal.gender] += 1;
      }
    }

    const blobBody = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: "shopify-collections-json",

      sourceUrls: allSourceUrls,
      pagesFetched: allPageSummaries.length,

      dealsFound: combinedDropCounts.totalProductsSeen,
      dealsExtracted: dedupedDeals.length,

      dealsMens: genderCounts.mens,
      dealsWomens: genderCounts.womens,
      dealsUnisex: genderCounts.unisex,
      dealsUnknown: genderCounts.unknown,

      scrapeDurationMs: Date.now() - started,

      ok: true,
      error: null,

      deals: dedupedDeals,
    };

    const pathname = blobPathFromEnv();

    const blob = await put(pathname, JSON.stringify(blobBody, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: blobBody.lastUpdated,
      via: blobBody.via,

      sourceUrls: blobBody.sourceUrls,
      pagesFetched: blobBody.pagesFetched,

      dealsFound: blobBody.dealsFound,
      dealsExtracted: blobBody.dealsExtracted,

      dealsMens: blobBody.dealsMens,
      dealsWomens: blobBody.dealsWomens,
      dealsUnisex: blobBody.dealsUnisex,
      dealsUnknown: blobBody.dealsUnknown,

      scrapeDurationMs: blobBody.scrapeDurationMs,

      ok: true,
      error: null,

      dropCounts: combinedDropCounts,
      pageSummaries: allPageSummaries,

      blobUrl: blob.url,
      blobPathname: pathname,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      error: err && err.message ? err.message : "Unknown error",
      scrapeDurationMs: Date.now() - started,
    });
  }
};
