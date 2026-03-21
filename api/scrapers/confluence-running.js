// /api/scrapers/confluence-running.js
// CommonJS Vercel function
//
// Shopify collection JSON scraper for Confluence Running sale footwear.
//
// Rules:
// - Read unfiltered collection JSON from /collections/sale-footwear/products.json
// - Keep ONLY products that belong to allowed sale running-footwear categories
// - Keep ONLY products with at least one variant having BOTH price and compare_at_price
// - Drop products with only one price
// - Brand = Shopify vendor
// - listingName = product title
// - model = listingName with leading brand/gender pipes stripped
// - gender = mens / womens / unisex / unknown from product_type/title/tags
// - shoeType = trail if category says trail, track if spikes/spike/racing flat category,
//              otherwise road if category is one of the allowed running-footwear categories,
//              otherwise unknown
// - Skip hidden-price products
// - Skip non-shoe sale items like socks/apparel/accessories/recovery sandals if category does not qualify
// - Response JSON does NOT include deals array
// - Saved blob JSON DOES include top-level structure + deals array only
//
// Env:
// - BLOB_READ_WRITE_TOKEN
// - CONFLUENCERUNNING_DEALS_BLOB_URL
// - CRON_SECRET (left commented out for testing)

const { put } = require("@vercel/blob");

const STORE = "Confluence Running";
const SCHEMA_VERSION = 1;
const BASE_URL = "https://www.confluencerunning.com";
const COLLECTION_URL = `${BASE_URL}/collections/sale-footwear`;
const JSON_LIMIT = 250;

const SOURCE_URLS_FOR_STORE_LIST = [
  "https://www.confluencerunning.com/collections/sale-footwear?filter.p.product_type=Unisex+Spikes&filter.p.product_type=Women%27s+Neutral+High+Cushion+Footwear&filter.p.product_type=Women%27s+Neutral+Mid+Cushion+Footwear&filter.p.product_type=Women%27s+Neutral+Performance+Footwear&filter.p.product_type=Women%27s+Neutral+Race+Footwear&filter.p.product_type=Women%27s+Neutral+Trail+Footwear&filter.p.product_type=Women%27s+Neutral+Trail+WP+Footwear&filter.p.product_type=Women%27s+Spikes&filter.p.product_type=Women%27s+Stability+High+Cushion+Footwear&filter.p.product_type=Women%27s+Stability+Mid+Cushion+Footwear&sort_by=best-selling",
  "https://www.confluencerunning.com/collections/sale-footwear?filter.p.product_type=Men%27s%20Neutral%20High%20Cushion%20Footwear&filter.p.product_type=Men%27s%20Neutral%20Mid%20Cushion%20Footwear&filter.p.product_type=Men%27s%20Neutral%20Mid%20Cushion%20WP%20Footwear&filter.p.product_type=Men%27s%20Neutral%20Performance%20Footwear&filter.p.product_type=Men%27s%20Neutral%20Race%20Footwear&filter.p.product_type=Men%27s%20Neutral%20Trail%20Footwear&filter.p.product_type=Men%27s%20Neutral%20Trail%20WP%20Footwear&filter.p.product_type=Men%27s%20Stability%20High%20Cushion%20Footwear&filter.p.product_type=Men%27s%20Stability%20Mid%20Cushion%20Footwear&filter.p.product_type=Men%27s%20Stability%20Mid%20Cushion%20WP%20Footwear&filter.p.product_type=Unisex%20Spikes&sort_by=best-selling"
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

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function normalizeWhitespace(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
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
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingGenderWords(s) {
  return normalizeWhitespace(
    s
      .replace(/^Men['’]s\s*\|\s*/i, "")
      .replace(/^Women['’]s\s*\|\s*/i, "")
      .replace(/^Unisex\s*\|\s*/i, "")
      .replace(/^Men['’]s\s+/i, "")
      .replace(/^Women['’]s\s+/i, "")
      .replace(/^Unisex\s+/i, "")
  );
}

function deriveModel(listingName, brand) {
  let s = normalizeWhitespace(listingName);
  s = stripLeadingGenderWords(s);

  if (brand) {
    s = s.replace(new RegExp(`^${escapeRegex(brand)}\\s*\\|\\s*`, "i"), "");
    s = s.replace(new RegExp(`^${escapeRegex(brand)}\\s+`, "i"), "");
  }

  return normalizeWhitespace(s) || "Unknown";
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

function buildJsonUrl(page) {
  const u = new URL(`${COLLECTION_URL}/products.json`);
  u.searchParams.set("limit", String(JSON_LIMIT));
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

function detectGender(product) {
  const type = normalizeWhitespace(product.product_type).toLowerCase();
  const title = normalizeWhitespace(product.title).toLowerCase();
  const tags = safeArray(product.tags).map((t) => String(t).toLowerCase());

  const haystack = [type, title, ...tags].join(" | ");

  if (/unisex/.test(haystack) || /m\d+\s*\/\s*w\d+/.test(haystack)) return "unisex";
  if (/women['’]?s|womens|women\b/.test(haystack)) return "womens";
  if (/men['’]?s|mens|men\b/.test(haystack)) return "mens";
  return "unknown";
}

function detectShoeType(product) {
  const type = normalizeWhitespace(product.product_type).toLowerCase();
  const title = normalizeWhitespace(product.title).toLowerCase();
  const tags = safeArray(product.tags).map((t) => String(t).toLowerCase());
  const haystack = [type, title, ...tags].join(" | ");

  if (/spikes?|racing flats?/.test(haystack)) return "track";
  if (/trail/.test(haystack)) return "trail";

  // Under your rule, if trail and spikes/track are explicitly categorized,
  // then the other qualifying running-footwear categories count as road.
  if (
    /footwear/.test(type) &&
    (
      /neutral/.test(type) ||
      /stability/.test(type) ||
      /performance/.test(type) ||
      /race/.test(type)
    )
  ) {
    return "road";
  }

  return "unknown";
}

function isAllowedRunningFootwear(product) {
  const type = normalizeWhitespace(product.product_type).toLowerCase();
  const title = normalizeWhitespace(product.title).toLowerCase();
  const tags = safeArray(product.tags).map((t) => String(t).toLowerCase());
  const haystack = [type, title, ...tags].join(" | ");

  // Explicit excludes
  if (
    /socks?/.test(type) ||
    /apparel/.test(type) ||
    /bra/.test(type) ||
    /shirt/.test(type) ||
    /shorts?/.test(type) ||
    /pants?/.test(type) ||
    /jacket/.test(type) ||
    /vest/.test(type) ||
    /hat/.test(type) ||
    /glove/.test(type) ||
    /nutrition/.test(type) ||
    /gel/.test(type) ||
    /bottle/.test(type) ||
    /sandal/.test(title) ||
    /slide/.test(title) ||
    /recovery footwear/.test(type)
  ) {
    return false;
  }

  // Explicit running-footwear allow
  if (/spikes?/.test(type)) return true;
  if (/trail footwear/.test(type)) return true;
  if (
    /neutral .*footwear/.test(type) ||
    /stability .*footwear/.test(type) ||
    /performance .*footwear/.test(type) ||
    /race .*footwear/.test(type)
  ) {
    return true;
  }

  // Fallback: if product_type itself looks like sale running footwear
  if (/footwear/.test(type) && /running|race|trail|neutral|stability|performance/.test(haystack)) {
    return true;
  }

  return false;
}

function initialDropCounts() {
  return {
    totalProductsSeen: 0,
    dropped_hiddenPrice: 0,
    dropped_notRunningFootwear: 0,
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
  const url = process.env.CONFLUENCERUNNING_DEALS_BLOB_URL;
  if (!url) return "confluence-running.json";

  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/+/, "") || "confluence-running.json";
  } catch {
    return "confluence-running.json";
  }
}

function parseProductToDeal(product, dropCounts) {
  if (hasHiddenPrice(product)) {
    dropCounts.dropped_hiddenPrice += 1;
    return null;
  }

  if (!isAllowedRunningFootwear(product)) {
    dropCounts.dropped_notRunningFootwear += 1;
    return null;
  }

  const listingName = normalizeWhitespace(product.title || "");
  const listingURL = makeListingUrl(product.handle);
  const imageURL = firstImageUrl(product);
  const brand = normalizeWhitespace(product.vendor || "") || "Unknown";
  const model = deriveModel(listingName, brand);
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
