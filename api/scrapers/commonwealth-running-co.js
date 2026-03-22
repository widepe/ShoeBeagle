// /api/scrapers/commonwealth-running-co.js
// CommonJS Vercel function
//
// Shopify collection JSON scraper for Commonwealth Running Co sale shoes.
//
// Rules:
// - Reads Shopify collection JSON from the filtered sale collection.
// - Trusts the activity-filtered collection heavily.
// - Keeps products unless they are obviously not shoes.
// - Keeps only products with at least one variant having BOTH price and compare_at_price.
// - Drops products with only one price.
// - Skips hidden-price products.
// - Assigns shoeType from JSON text when possible; otherwise unknown.
// - Cleans model from explicit model if present, otherwise from listingName.
// - Response JSON does NOT include deals array.
// - Saved blob JSON DOES include only top-level structure + deals array.
//
// Env:
// - BLOB_READ_WRITE_TOKEN
// - COMMONWEALTH_DEALS_BLOB_URL
// - CRON_SECRET (left commented out for testing)

const { put } = require("@vercel/blob");

const STORE = "Commonwealth Running Co";
const SCHEMA_VERSION = 1;
const BASE_URL = "https://commonwealthrunning.com";
const JSON_LIMIT = 250;
const ACTIVITY_FILTER =
  "Ultra running,Road running,Competition,Trail running,Running,Marathon";

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

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function normalizeWhitespace(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
}

function stripHtml(html) {
  return normalizeWhitespace(
    String(html || "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
  );
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

function firstImageUrl(product) {
  const images = safeArray(product.images);
  const src = images[0] && images[0].src;
  return typeof src === "string" && src.trim() ? src.trim() : null;
}

function makeListingUrl(handle) {
  return handle ? `${BASE_URL}/products/${handle}` : null;
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBrand(brand, listingName = "") {
  const rawBrand = normalizeWhitespace(brand || "");
  const rawListing = normalizeWhitespace(listingName || "");

  if (!rawBrand && rawListing.includes("|")) {
    return normalizeWhitespace(rawListing.split("|")[0]);
  }

  if (/^hoka one one$/i.test(rawBrand)) return "Hoka";

  return rawBrand || "Unknown";
}

function deriveModel(listingName, brand, explicitModel = "") {
  const cleanExplicit = normalizeWhitespace(explicitModel || "");
  if (cleanExplicit) return cleanExplicit;

  let s = normalizeWhitespace(listingName || "");
  const cleanBrand = normalizeBrand(brand, listingName);

  if (!s) return "Unknown";

  s = s.replace(/^women['’]s\s+/i, "");
  s = s.replace(/^men['’]s\s+/i, "");
  s = s.replace(/^womens\s+/i, "");
  s = s.replace(/^mens\s+/i, "");
  s = s.replace(/^unisex\s+/i, "");

  if (cleanBrand) {
    const escapedBrand = escapeRegex(cleanBrand);
    s = s.replace(new RegExp(`^${escapedBrand}\\s+`, "i"), "");
    s = s.replace(new RegExp(`^${escapedBrand}\\s*\\|\\s*`, "i"), "");
  }

  if (s.includes("|")) {
    s =
      s
        .split("|")
        .map((p) => normalizeWhitespace(p))
        .filter(Boolean)[0] || s;
  }

  s = s.replace(/\s*\(clearance\)\s*$/i, "");

  return normalizeWhitespace(s) || "Unknown";
}

function buildHaystack(product) {
  const tags = safeArray(product.tags).join(" | ");
  return [
    normalizeWhitespace(product.title),
    normalizeWhitespace(product.vendor),
    normalizeWhitespace(product.product_type),
    tags,
    stripHtml(product.body_html),
  ]
    .filter(Boolean)
    .join(" | ")
    .toLowerCase();
}

function hasHiddenPrice(product) {
  const haystack = buildHaystack(product);
  return HIDDEN_PRICE_PATTERNS.some((re) => re.test(haystack));
}

function detectGender(product) {
  const haystack = buildHaystack(product);

  if (/women['’]?s|womens|women\b/.test(haystack)) return "womens";
  if (/men['’]?s|mens|men\b/.test(haystack)) return "mens";
  if (/unisex/.test(haystack)) return "unisex";
  return "unknown";
}

function detectShoeType(product) {
  const haystack = buildHaystack(product);

  if (/\b(spike|spikes|xc|cross country|track)\b/.test(haystack)) return "track";
  if (/\b(trail|hiking|gore-tex|gtx)\b/.test(haystack)) return "trail";
  if (
    /\b(road running|road runners|road runner|racer|race shoe|daily trainer|neutral trainer|stability trainer)\b/.test(
      haystack
    )
  ) {
    return "road";
  }

  return "unknown";
}

function isObviouslyNotShoe(product) {
  const haystack = buildHaystack(product);
  const productType = normalizeWhitespace(product.product_type).toLowerCase();
  const title = normalizeWhitespace(product.title).toLowerCase();

  if (
    /\b(sock|socks|apparel|shirt|shorts|pants|tight|tights|jacket|bra|hat|cap|visor|glove|bottle|belt|pack|nutrition|gel|singlet|hoodie|crewneck|tee|t-shirt)\b/.test(
      haystack
    )
  ) {
    return true;
  }

  if (/\b(sandal|slide|recovery footwear)\b/.test(haystack)) return true;

  if (
    /\b(insole|insoles|sunglasses|watch|watches|mittens|gloves|hydration|handhelds)\b/.test(
      haystack
    )
  ) {
    return true;
  }

  // If Shopify clearly says Shoes/Footwear, trust it.
  if (/\bshoe|shoes|footwear\b/.test(productType)) return false;
  if (/\bshoe|shoes|footwear\b/.test(title)) return false;

  // In the filtered sale collection, keep ambiguous items unless they are clearly non-shoes.
  return false;
}

function buildJsonUrl(page) {
  const u = new URL(`${BASE_URL}/collections/sale/products.json`);
  u.searchParams.set("activity", ACTIVITY_FILTER);
  u.searchParams.set("limit", String(JSON_LIMIT));
  u.searchParams.set("page", String(page));
  return u.toString();
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json,text/plain,*/*",
    },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }

  return resp.json();
}

function initialDropCounts() {
  return {
    totalProductsSeen: 0,
    dropped_hiddenPrice: 0,
    dropped_obviousNonShoes: 0,
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
  const url = process.env.COMMONWEALTH_DEALS_BLOB_URL;
  if (!url) return "commonwealth-running-co.json";

  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/+/, "") || "commonwealth-running-co.json";
  } catch {
    return "commonwealth-running-co.json";
  }
}

function parseProductToDeal(product, dropCounts) {
  if (hasHiddenPrice(product)) {
    dropCounts.dropped_hiddenPrice += 1;
    return null;
  }

  if (isObviouslyNotShoe(product)) {
    dropCounts.dropped_obviousNonShoes += 1;
    return null;
  }

  const listingName = normalizeWhitespace(product.title || "");
  const listingURL = makeListingUrl(product.handle);
  const imageURL = firstImageUrl(product);
  const brand = normalizeBrand(product.vendor, listingName);
  const model = deriveModel(listingName, brand, product.model || "");
  const gender = detectGender(product);
  const shoeType = detectShoeType(product);

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

  const variants = safeArray(product.variants);
  if (!variants.length) {
    dropCounts.dropped_noVariants += 1;
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

    pricedVariants.push({
      sale,
      original,
      discount: discountPct(original, sale),
    });
  }

  if (!pricedVariants.length) {
    if (sawMissingSale) dropCounts.dropped_missingSalePrice += 1;
    if (sawMissingOriginal) dropCounts.dropped_missingOriginalPrice += 1;
    if (!sawMissingSale && !sawMissingOriginal) {
      dropCounts.dropped_saleNotLessThanOriginal += 1;
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

    gender,
    shoeType,
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
    const dropCounts = initialDropCounts();
    const pageSummaries = [];
    const sourceUrls = [];
    const allDeals = [];
    const seenProductIds = new Set();

    for (let page = 1; page <= 50; page += 1) {
      const jsonUrl = buildJsonUrl(page);
      sourceUrls.push(jsonUrl);

      const data = await fetchJson(jsonUrl);
      const products = safeArray(data.products);
      if (!products.length) break;

      let pageSeen = 0;
      let pageKept = 0;

      const pageGenderCounts = {
        mens: 0,
        womens: 0,
        unisex: 0,
        unknown: 0,
      };

      const pageTypeCounts = {
        road: 0,
        trail: 0,
        track: 0,
        unknown: 0,
      };

      for (const product of products) {
        if (!product || seenProductIds.has(product.id)) continue;
        seenProductIds.add(product.id);

        pageSeen += 1;
        dropCounts.totalProductsSeen += 1;

        const deal = parseProductToDeal(product, dropCounts);
        if (!deal) continue;

        allDeals.push(deal);
        pageKept += 1;

        pageGenderCounts[deal.gender] = (pageGenderCounts[deal.gender] || 0) + 1;
        pageTypeCounts[deal.shoeType] = (pageTypeCounts[deal.shoeType] || 0) + 1;
      }

      pageSummaries.push({
        page,
        jsonUrl,
        productsSeen: pageSeen,
        dealsKept: pageKept,
        dealsMens: pageGenderCounts.mens,
        dealsWomens: pageGenderCounts.womens,
        dealsUnisex: pageGenderCounts.unisex,
        dealsUnknown: pageGenderCounts.unknown,
        road: pageTypeCounts.road,
        trail: pageTypeCounts.trail,
        track: pageTypeCounts.track,
        unknownType: pageTypeCounts.unknown,
      });

      if (products.length < JSON_LIMIT) break;
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

    const typeCounts = {
      road: 0,
      trail: 0,
      track: 0,
      unknown: 0,
    };

    for (const deal of dedupedDeals) {
      genderCounts[deal.gender] = (genderCounts[deal.gender] || 0) + 1;
      typeCounts[deal.shoeType] = (typeCounts[deal.shoeType] || 0) + 1;
    }

    const body = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: "shopify-collection-json",

      sourceUrls,
      pagesFetched: pageSummaries.length,

      dealsFound: dropCounts.totalProductsSeen,
      dealsExtracted: dedupedDeals.length,

      dealsMens: genderCounts.mens,
      dealsWomens: genderCounts.womens,
      dealsUnisex: genderCounts.unisex,
      dealsUnknown: genderCounts.unknown,

      dealsRoad: typeCounts.road,
      dealsTrail: typeCounts.trail,
      dealsTrack: typeCounts.track,
      dealsUnknownType: typeCounts.unknown,

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

      dealsRoad: body.dealsRoad,
      dealsTrail: body.dealsTrail,
      dealsTrack: body.dealsTrack,
      dealsUnknownType: body.dealsUnknownType,

      scrapeDurationMs: body.scrapeDurationMs,

      ok: true,
      error: null,

      dropCounts,
      pageSummaries,

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
