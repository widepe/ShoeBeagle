// /api/scrapers/footprintusa.js
// CommonJS Vercel function
//
// Footprint USA running clearance footwear scraper via Retail Connect search API.
//
// Rules:
// - Scrape women's running clearance footwear collection
// - Scrape men's running clearance footwear collection
// - Correctly unwrap API responses returned as { status, value: { results, pagination } }
// - Keep only true sale items with both salePrice and originalPrice where salePrice < originalPrice
// - Skip hidden-price items
// - shoeType is always "unknown"
// - Response JSON does NOT include deals array
// - Saved blob JSON DOES include top-level structure + deals array only
//
// Env:
// - BLOB_READ_WRITE_TOKEN
// - FOOTPRINTUSA_DEALS_BLOB_URL
// - CRON_SECRET (left commented out for testing)

const { put } = require("@vercel/blob");

const STORE = "Footprint USA";
const SCHEMA_VERSION = 1;
const BASE_URL = "https://footprintusa.co";
const API_URL = "https://storefront.retailconnect.app/v1/search";
const PAGE_SIZE = 48;

const SOURCE_CONFIGS = [
  {
    key: "womens",
    gender: "womens",
    collectionId: "189135519883",
    pageUrl:
      "https://footprintusa.co/collections/clearance-womens-footwear?attributes.shop_by_sport=Running",
  },
  {
    key: "mens",
    gender: "mens",
    collectionId: "189135454347",
    pageUrl:
      "https://footprintusa.co/collections/men-clearance-footwear?attributes.shop_by_sport=Running",
  },
];

const FILTER_FIELDS = [
  "sizes",
  "brands",
  "colors",
  "attributes.occasion",
  "attributes.style",
  "attributes.category_name_level_1",
  "attributes.category_name_level_2",
  "attributes.category_name_level_3",
  "attributes.shop_by_sport",
  "attributes.width",
  "genders",
  "ageGroups",
  "price",
  "attributes.product_type",
  "availability",
];

const PLACEMENT =
  "projects/rc-3eb512d1-134d-4afe-8407-5bf/locations/global/catalogs/default_catalog/servingConfigs/default_search";

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

function normalizeWhitespace(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
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
  return [...new Set(values.filter(Number.isFinite).map((v) => round2(v)))];
}

function minOrNull(arr) {
  return arr.length ? Math.min(...arr) : null;
}

function maxOrNull(arr) {
  return arr.length ? Math.max(...arr) : null;
}

function cleanBrand(brand) {
  const s = normalizeWhitespace(brand || "");
  if (!s) return "Unknown";
  if (/^on running$/i.test(s)) return "On";
  if (/^hoka one one$/i.test(s)) return "Hoka";
  return s;
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveModel(listingName, brand) {
  let s = normalizeWhitespace(listingName || "");
  const cleanBrandName = cleanBrand(brand);

  if (!s) return "Unknown";

  s = s.replace(/^women['’]s\s+/i, "");
  s = s.replace(/^men['’]s\s+/i, "");
  s = s.replace(/^womens\s+/i, "");
  s = s.replace(/^mens\s+/i, "");
  s = s.replace(/^unisex\s+/i, "");

  if (cleanBrandName) {
    const escapedBrand = escapeRegex(cleanBrandName);
    s = s.replace(new RegExp(`^${escapedBrand}\\s+`, "i"), "");
  }

  s = s.replace(/\s*\([^)]*\)\s*$/i, "");

  return normalizeWhitespace(s) || "Unknown";
}

function buildListingUrl(result) {
  const url =
    result?.product?.uri || safeArray(result?.product?.variants)[0]?.uri || "";
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

function pickImageUrl(result) {
  const productImages = safeArray(result?.product?.images);
  if (productImages[0]?.uri) return String(productImages[0].uri).trim();

  const firstVariant = safeArray(result?.product?.variants)[0];
  const variantImages = safeArray(firstVariant?.images);
  if (variantImages[0]?.uri) return String(variantImages[0].uri).trim();

  return null;
}

function buildHaystack(result) {
  const product = result?.product || {};
  const variants = safeArray(product?.variants);
  const firstVariant = variants[0] || {};

  return JSON.stringify({
    title: product.title,
    brands: safeArray(product.brands).join(" "),
    categories: safeArray(product.categories).join(" "),
    description: product.description,
    genders: safeArray(firstVariant.genders).join(" "),
    ageGroups: safeArray(firstVariant.ageGroups).join(" "),
  });
}

function hasHiddenPrice(result) {
  const haystack = buildHaystack(result);
  return HIDDEN_PRICE_PATTERNS.some((re) => re.test(haystack));
}

function deriveGender(result, sourceGender) {
  const firstVariant = safeArray(result?.product?.variants)[0] || {};
  const genders = safeArray(firstVariant.genders).map((x) => String(x).toLowerCase());
  const joined = genders.join(" | ");

  if (joined.includes("female")) return "womens";
  if (joined.includes("male")) return "mens";
  if (joined.includes("unisex")) return "unisex";

  return sourceGender || "unknown";
}

function collectVariantPrices(result) {
  const variants = safeArray(result?.product?.variants);
  const priced = [];

  for (const variant of variants) {
    const priceInfo = variant?.priceInfo || {};
    const sale = toNumber(priceInfo.price);
    const original = toNumber(priceInfo.originalPrice);

    if (!Number.isFinite(sale) || !Number.isFinite(original)) continue;
    if (sale >= original) continue;

    priced.push({
      sale,
      original,
      discount: discountPct(original, sale),
    });
  }

  return priced;
}

function parseResultToDeal(result, source, dropCounts) {
  if (hasHiddenPrice(result)) {
    dropCounts.dropped_hiddenPrice += 1;
    return null;
  }

  const product = result?.product || {};
  const listingName = normalizeWhitespace(product.title || "");
  const rawBrand = safeArray(product.brands)[0] || "";
  const brand = cleanBrand(rawBrand);
  const model = deriveModel(listingName, brand);
  const listingURL = buildListingUrl(result);
  const imageURL = pickImageUrl(result);
  const gender = deriveGender(result, source.gender);
  const shoeType = "unknown";

  if (!listingName) {
    dropCounts.dropped_missingListingName += 1;
    return null;
  }

  if (!listingURL) {
    dropCounts.dropped_missingListingURL += 1;
    return null;
  }

  if (!imageURL) {
    dropCounts.dropped_missingImageURL += 1;
    return null;
  }

  if (source.gender === "womens" && gender !== "womens") {
    dropCounts.dropped_wrongGenderForSource += 1;
    return null;
  }

  if (source.gender === "mens" && gender !== "mens") {
    dropCounts.dropped_wrongGenderForSource += 1;
    return null;
  }

  const pricedVariants = collectVariantPrices(result);

  if (!pricedVariants.length) {
    const variants = safeArray(result?.product?.variants);
    let sawMissingSale = false;
    let sawMissingOriginal = false;
    let sawSaleNotLower = false;

    for (const variant of variants) {
      const priceInfo = variant?.priceInfo || {};
      const sale = toNumber(priceInfo.price);
      const original = toNumber(priceInfo.originalPrice);

      if (!Number.isFinite(sale)) sawMissingSale = true;
      if (!Number.isFinite(original)) sawMissingOriginal = true;
      if (Number.isFinite(sale) && Number.isFinite(original) && sale >= original) {
        sawSaleNotLower = true;
      }
    }

    if (sawMissingSale) dropCounts.dropped_missingSalePrice += 1;
    if (sawMissingOriginal) dropCounts.dropped_missingOriginalPrice += 1;
    if (!sawMissingSale && !sawMissingOriginal && sawSaleNotLower) {
      dropCounts.dropped_saleNotLessThanOriginal += 1;
    }
    if (!sawMissingSale && !sawMissingOriginal && !sawSaleNotLower) {
      dropCounts.dropped_noPricedVariants += 1;
    }
    return null;
  }

  const saleValues = uniqNumbers(pricedVariants.map((v) => v.sale));
  const originalValues = uniqNumbers(pricedVariants.map((v) => v.original));
  const discountValues = uniqNumbers(pricedVariants.map((v) => v.discount));

  return {
    schemaVersion: SCHEMA_VERSION,

    listingName,

    brand,
    model,

    salePrice: saleValues.length === 1 ? saleValues[0] : null,
    originalPrice: originalValues.length === 1 ? originalValues[0] : null,
    discountPercent: discountValues.length === 1 ? discountValues[0] : null,

    salePriceLow: saleValues.length > 1 ? minOrNull(saleValues) : null,
    salePriceHigh: saleValues.length > 1 ? maxOrNull(saleValues) : null,

    originalPriceLow: originalValues.length > 1 ? minOrNull(originalValues) : null,
    originalPriceHigh: originalValues.length > 1 ? maxOrNull(originalValues) : null,

    discountPercentUpTo: discountValues.length > 1 ? maxOrNull(discountValues) : null,

    store: STORE,

    listingURL,
    imageURL,

    gender,
    shoeType,
  };
}

function initialDropCounts() {
  return {
    totalResultsSeen: 0,
    dropped_hiddenPrice: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_wrongGenderForSource: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_noPricedVariants: 0,
    dropped_duplicateAfterMerge: 0,
  };
}

function blobPathFromEnv() {
  const url = process.env.FOOTPRINTUSA_DEALS_BLOB_URL;
  if (!url) return "footprintusa.json";

  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/+/, "") || "footprintusa.json";
  } catch {
    return "footprintusa.json";
  }
}

function makeRequestBody(source, page, nextPageToken = null) {
  const body = {
    pageSize: PAGE_SIZE,
    page,
    placement: PLACEMENT,
    query: "",
    filters: [
      { field: "attributes.rcc_collection_id", value: [source.collectionId] },
      { field: "attributes.shop_by_sport", value: ["Running"] },
    ],
    filterFields: FILTER_FIELDS,
    visitorId: "64e382e1-84ef-4621-90e2-9def7b866aaa",
    languageCode: "en-US",
  };

  if (nextPageToken) {
    body.nextPage = nextPageToken;
  }

  return body;
}

async function fetchSearchPage(source, page, nextPageToken = null) {
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      "content-type": "application/json",
      pragma: "no-cache",
      origin: BASE_URL,
      referer: `${BASE_URL}/`,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    },
    body: JSON.stringify(makeRequestBody(source, page, nextPageToken)),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for Footprint USA search page ${page} (${source.key})`);
  }

  return resp.json();
}

async function scrapeSource(source, combinedDropCounts) {
  const sourceUrls = [];
  const pageSummaries = [];
  const deals = [];
  const seenSourceKeys = new Set();

  let page = 1;
  let nextPageToken = null;
  let totalPages = 1;

  while (true) {
    const data = await fetchSearchPage(source, page, nextPageToken);
    const payload = data?.value || data || {};
    const results = safeArray(payload?.results);
    const pagination = payload?.pagination || {};
    totalPages = Number(pagination.totalPages) || totalPages;

    sourceUrls.push(
      `${source.pageUrl}${page > 1 ? `${source.pageUrl.includes("?") ? "&" : "?"}page=${page}` : ""}`
    );

    let pageSeen = 0;
    let pageKept = 0;

    const pageGenderCounts = {
      mens: 0,
      womens: 0,
      unisex: 0,
      unknown: 0,
    };

    for (const result of results) {
      pageSeen += 1;
      combinedDropCounts.totalResultsSeen += 1;

      const deal = parseResultToDeal(result, source, combinedDropCounts);
      if (!deal) continue;

      const key = deal.listingURL;
      if (seenSourceKeys.has(key)) {
        combinedDropCounts.dropped_duplicateAfterMerge += 1;
        continue;
      }
      seenSourceKeys.add(key);

      deals.push(deal);
      pageKept += 1;
      pageGenderCounts[deal.gender] = (pageGenderCounts[deal.gender] || 0) + 1;
    }

    pageSummaries.push({
      source: source.key,
      page,
      sourceUrl: sourceUrls[sourceUrls.length - 1],
      resultsSeen: pageSeen,
      dealsKept: pageKept,
      dealsMens: pageGenderCounts.mens,
      dealsWomens: pageGenderCounts.womens,
      dealsUnisex: pageGenderCounts.unisex,
      dealsUnknown: pageGenderCounts.unknown,
    });

    nextPageToken = pagination.nextPage || null;
    if (!nextPageToken || page >= totalPages) break;

    page += 1;
  }

  return { sourceUrls, pageSummaries, deals };
}

module.exports = async function handler(req, res) {
  const started = Date.now();

  // Temporarily commented out for testing.
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  try {
    const dropCounts = initialDropCounts();
    const allDeals = [];
    const allSourceUrls = [];
    const allPageSummaries = [];

    for (const source of SOURCE_CONFIGS) {
      const result = await scrapeSource(source, dropCounts);
      allDeals.push(...result.deals);
      allSourceUrls.push(...result.sourceUrls);
      allPageSummaries.push(...result.pageSummaries);
    }

    const dedupedDeals = [];
    const seenKeys = new Set();

    for (const deal of allDeals) {
      const key = deal.listingURL;
      if (seenKeys.has(key)) {
        dropCounts.dropped_duplicateAfterMerge += 1;
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
      genderCounts[deal.gender] = (genderCounts[deal.gender] || 0) + 1;
    }

    const body = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: "retailconnect-search-api",

      sourceUrls: allSourceUrls,
      pagesFetched: allPageSummaries.length,

      dealsFound: dropCounts.totalResultsSeen,
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

    const blob = await put(pathname, JSON.stringify(body, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: body.lastUpdated,
      via: body.via,

      sourceUrls: body.sourceUrls,
      pagesFetched: body.pagesFetched,

      dealsFound: body.dealsFound,
      dealsExtracted: body.dealsExtracted,

      dealsMens: body.dealsMens,
      dealsWomens: body.dealsWomens,
      dealsUnisex: body.dealsUnisex,
      dealsUnknown: body.dealsUnknown,

      scrapeDurationMs: body.scrapeDurationMs,

      ok: true,
      error: null,

      dropCounts,
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
