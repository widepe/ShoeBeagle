// /api/scrapers/6pm-running.js
// CommonJS Vercel function
//
// 6pm running shoes sale scraper via exposed mobile API.
//
// Rules:
// - Scrape women's running shoes sale endpoint and men's running shoes sale endpoint.
// - Paginate using currentPage/pageCount from the API.
// - Keep only true sale items with both price and originalPrice where salePrice < originalPrice.
// - Skip hidden-price tiles.
// - shoeType is always "unknown" for this scraper.
// - Enforce source gender:
//   - womens source keeps only womens
//   - mens source keeps only mens
// - Response JSON does NOT include deals array.
// - Saved blob JSON DOES include top-level structure + deals array only.
//
// Env:
// - BLOB_READ_WRITE_TOKEN
// - SIXPM_DEALS_BLOB_URL
// - CRON_SECRET (left commented out for testing)

const { put } = require("@vercel/blob");

const STORE = "6pm";
const SCHEMA_VERSION = 1;
const BASE_URL = "https://www.6pm.com";
const API_BASE = "https://www.6pm.com/mobileapi/olympus/Search";

const SOURCE_CONFIGS = [
  {
    key: "womens",
    gender: "womens",
    pageUrl:
      "https://www.6pm.com/filters/womens/sneakers-athletic-shoes/running-shoes/ELzXARjQ7gHAAQHgAQHiAgQCAxgc.zso?t=running%20shoes&ot=running%20shoes",
    apiPath:
      "/zso/filters/womens/sneakers-athletic-shoes/running-shoes/ELzXARjQ7gHAAQHgAQHiAgQCAxgc.zso",
    params: {
      limit: "100",
      includes:
        '["productSeoUrl","pageCount","reviewCount","productRating","onSale","isNew","zsoUrls","isCouture","msaImageId","facetPrediction","phraseContext","currentPage","facets","melodySearch","styleColor","seoBlacklist","seoOptimizedData","badges","txAttrFacet_Gender","productType","onHand","imageMap","navigationV2P2","navigationV2","enableTermAutoFaceting","enableRealBrand"]',
      relativeUrls: "true",
      siteId: "2",
      subsiteId: "12",
      t: "running shoes",
      ot: "running shoes",
    },
  },
  {
    key: "mens",
    gender: "mens",
    pageUrl:
      "https://www.6pm.com/mens/shoes/sneakers-athletic-shoes/running-shoes/CK_XARC81wEY0O4BwAEC4gIEAQIDGA.zso?s=isNew%2Fdesc%2FgoLiveDate%2Fdesc%2FrecentSalesStyle%2Fdesc%2F",
    apiPath:
      "/zso/mens/shoes/sneakers-athletic-shoes/running-shoes/CK_XARC81wEY0O4BwAEC4gIEAQIDGA.zso",
    params: {
      limit: "100",
      includes:
        '["productSeoUrl","pageCount","reviewCount","productRating","onSale","isNew","zsoUrls","isCouture","msaImageId","facetPrediction","phraseContext","currentPage","facets","melodySearch","styleColor","seoBlacklist","seoOptimizedData","badges","txAttrFacet_Gender","productType","onHand","imageMap","navigationV2P2","navigationV2","enableTermAutoFaceting","enableRealBrand"]',
      relativeUrls: "true",
      siteId: "2",
      subsiteId: "12",
      s: "isNew/desc/goLiveDate/desc/recentSalesStyle/desc/",
    },
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

function buildApiUrl(source, pageIndexZeroBased) {
  const url = new URL(`${API_BASE}${source.apiPath}`);
  for (const [k, v] of Object.entries(source.params)) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("p", String(pageIndexZeroBased));
  return url.toString();
}

function pickImageUrl(result) {
  if (typeof result.thumbnailImageUrl === "string" && result.thumbnailImageUrl.trim()) {
    return result.thumbnailImageUrl.trim();
  }

  if (result.msaImageId) {
    return `https://m.media-amazon.com/images/I/${result.msaImageId}._AC_SR400,400_.jpg`;
  }

  if (result.imageMap && typeof result.imageMap === "object") {
    const preferred =
      result.imageMap.PAIR ||
      result.imageMap.MAIN ||
      result.imageMap.FRNT ||
      result.imageMap.LEFT ||
      result.imageMap.TOPP ||
      result.imageMap.BACK;
    if (preferred) {
      return `https://m.media-amazon.com/images/I/${preferred}._AC_SR400,400_.jpg`;
    }
  }

  return null;
}

function hasHiddenPrice(result) {
  const haystack = JSON.stringify({
    productName: result.productName,
    brandName: result.brandName,
    badges: result.badges,
    price: result.price,
    originalPrice: result.originalPrice,
  });

  return HIDDEN_PRICE_PATTERNS.some((re) => re.test(haystack));
}

function cleanModelName(model) {
  let s = normalizeWhitespace(model || "");
  if (!s) return "Unknown";
  s = s.replace(/\s*\([^)]*\)\s*$/i, "");
  return normalizeWhitespace(s) || "Unknown";
}

function deriveGender(result, defaultGender) {
  const facetGender = safeArray(result.txAttrFacet_Gender).map((x) => String(x).toLowerCase());
  const joined = facetGender.join(" | ");

  if (joined.includes("women")) return "womens";
  if (joined.includes("men")) return "mens";
  if (joined.includes("unisex")) return "unisex";

  return defaultGender || "unknown";
}

function parseResultToDeal(result, source, dropCounts) {
  if (hasHiddenPrice(result)) {
    dropCounts.dropped_hiddenPrice += 1;
    return null;
  }

  const listingName = normalizeWhitespace(result.productName || "");
  const brand = normalizeWhitespace(result.brandName || "") || "Unknown";
  const model = cleanModelName(listingName);
  const sale = toNumber(result.price);
  const original = toNumber(result.originalPrice);
  const listingURL = result.productSeoUrl
    ? `${BASE_URL}${result.productSeoUrl}`
    : (result.productUrl ? `${BASE_URL}${result.productUrl}` : null);
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

  if (!Number.isFinite(sale)) {
    dropCounts.dropped_missingSalePrice += 1;
    return null;
  }

  if (!Number.isFinite(original)) {
    dropCounts.dropped_missingOriginalPrice += 1;
    return null;
  }

  if (sale >= original) {
    dropCounts.dropped_saleNotLessThanOriginal += 1;
    return null;
  }

  return {
    schemaVersion: SCHEMA_VERSION,

    listingName,

    brand,
    model,

    salePrice: sale,
    originalPrice: original,
    discountPercent: discountPct(original, sale),

    salePriceLow: null,
    salePriceHigh: null,

    originalPriceLow: null,
    originalPriceHigh: null,

    discountPercentUpTo: null,

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
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_wrongGenderForSource: 0,
    dropped_duplicateAfterMerge: 0,
  };
}

function blobPathFromEnv() {
  const url = process.env.SIXPM_DEALS_BLOB_URL;
  if (!url) return "6pm-running.json";

  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/+/, "") || "6pm-running.json";
  } catch {
    return "6pm-running.json";
  }
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "*/*",
      "x-session-requested": "1",
      referer: BASE_URL,
    },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }

  return resp.json();
}

async function scrapeSource(source, combinedDropCounts) {
  const sourceUrls = [];
  const pageSummaries = [];
  const deals = [];
  const seenSourceKeys = new Set();

  let pageIndex = 0;
  let pageCount = 1;

  while (pageIndex < pageCount) {
    const url = buildApiUrl(source, pageIndex);
    sourceUrls.push(url);

    const data = await fetchJson(url);
    const results = safeArray(data.results);
    pageCount = Number(data.pageCount) || 1;

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
      page: pageIndex + 1,
      apiUrl: url,
      resultsSeen: pageSeen,
      dealsKept: pageKept,
      dealsMens: pageGenderCounts.mens,
      dealsWomens: pageGenderCounts.womens,
      dealsUnisex: pageGenderCounts.unisex,
      dealsUnknown: pageGenderCounts.unknown,
    });

    pageIndex += 1;
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
      via: "6pm-mobileapi",

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
