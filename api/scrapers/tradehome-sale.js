// /api/scrapers/tradehome-sale.js
//
// Tradehome sale running shoes scraper
// - Uses Algolia JSON API directly
// - Scrapes the sale collection only
// - Keeps only performance running shoes for mens / womens / unisex
// - Skips hidden-price tiles ("see price in cart", "add to bag to see price", etc.)
// - Dedupes by product id / handle so one product does not appear once per size
// - Forces shoeType to "unknown" for all deals
// - Writes ONE JSON blob with top-level metadata + deals array only
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//
// TEST:
//   /api/scrapers/tradehome-sale
//
// NOTE:
// - CRON_SECRET block is included but temporarily commented out for testing.

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Tradehome";
const SCHEMA_VERSION = 1;
const VIA = "algolia-json";
const BLOB_PATH = "tradehome-sale.json";

const ALGOLIA_APP_ID = "INGT38TQ7J";
const ALGOLIA_API_KEY = "87a03c6a728d7d1fe865930b206f75d5";
const ALGOLIA_INDEX_NAME = "shopify_products";
const ALGOLIA_BASE_URL = `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`;

const SALE_COLLECTION_ID = "275150930016";
const HITS_PER_PAGE = 48;
const SOURCE_BASE_URL = "https://tradehome.com/collections/sale";

const HIDDEN_PRICE_PATTERNS = [
  "see price in cart",
  "see price in bag",
  "add to bag to see price",
  "add to cart to see price",
  "see price at checkout",
  "price in cart",
  "price in bag",
  "special price in cart",
  "special price in bag",
  "login to see price",
  "call for price",
];

const POSITIVE_RUNNING_COLLECTIONS = new Set([
  "performance-running-shoes",
  "all-running-shoes",
  "mens-running-shoes",
  "womens-running-shoes",
  "running-shoes",
  "top-picks-running-shoes",
]);

const POSITIVE_RUNNING_TAGS = new Set(["running"]);

const NEGATIVE_COLLECTION_TERMS = [
  "casual",
  "lifestyle",
  "boots",
  "booties",
  "heels",
  "wedges",
  "dress",
  "sandals",
  "slippers",
  "accessories",
  "clothing",
  "apparel",
  "oxfords",
  "loafers",
  "work",
  "skate",
  "soccer",
  "baseball",
  "basketball",
  "golf",
  "hiking",
  "walking",
  "preschool",
  "grade-school",
  "grade school",
  "toddler",
  "kids",
  "boys",
  "girls",
  "youth",
];

const NEGATIVE_TAGS = new Set([
  "accessories",
  "casual",
  "dress",
  "boots",
  "booties",
  "sandals",
  "kids",
  "boys",
  "girls",
  "preschool",
  "youth",
]);

const NEGATIVE_PRODUCT_TYPE_TERMS = [
  "accessories",
  "boots",
  "booties",
  "oxfords",
  "casual",
  "lifestyle",
  "fashion",
  "canvas",
  "dress",
  "sandals",
  "slippers",
  "walking",
  "hiking",
];

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundMoney(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function roundPercent(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function lc(value) {
  return asString(value).toLowerCase();
}

function cleanWhitespace(str) {
  return asString(str).replace(/\s+/g, " ").trim();
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function containsAny(haystack, needles) {
  return needles.some((needle) => haystack.includes(needle));
}

function getCollections(hit) {
  return asArray(hit?.collections).map((x) => String(x));
}

function getCollectionsLc(hit) {
  return getCollections(hit).map((x) => x.toLowerCase());
}

function getTags(hit) {
  return asArray(hit?.tags).map((x) => String(x));
}

function getTagsLc(hit) {
  return getTags(hit).map((x) => x.toLowerCase());
}

function productCategory(hit) {
  return cleanWhitespace(hit?.meta?.custom?.product_category);
}

function bodyText(hit) {
  return lc(hit?.body_html_safe);
}

function titleText(hit) {
  return lc(hit?.title);
}

function productTypeText(hit) {
  return lc(hit?.product_type);
}

function textBlob(hit) {
  return [
    titleText(hit),
    bodyText(hit),
    productTypeText(hit),
    lc(productCategory(hit)),
    lc(hit?.vendor),
    ...getCollectionsLc(hit),
    ...getTagsLc(hit),
  ]
    .filter(Boolean)
    .join(" ");
}

function hasHiddenPriceLanguage(hit) {
  const blob = textBlob(hit);
  return HIDDEN_PRICE_PATTERNS.some((p) => blob.includes(p));
}

function inferGender(hit) {
  const collections = getCollectionsLc(hit);
  const tags = getTagsLc(hit);
  const category = lc(productCategory(hit));
  const title = titleText(hit);
  const productType = productTypeText(hit);
  const blob = [category, title, productType, ...collections, ...tags].join(" ");

  const hasWomen =
    category === "womens" ||
    collections.includes("womens") ||
    collections.includes("womens-running-shoes") ||
    collections.includes("womens-athletic-sneakers") ||
    tags.includes("womens") ||
    /\bwomen'?s\b/.test(blob) ||
    /\bwomens\b/.test(blob);

  const hasMen =
    category === "mens" ||
    collections.includes("mens") ||
    collections.includes("mens-running-shoes") ||
    collections.includes("mens-athletic-sneakers") ||
    tags.includes("mens") ||
    /\bmen'?s\b/.test(blob) ||
    /\bmens\b/.test(blob);

  const hasUnisex =
    category === "unisex" ||
    collections.includes("unisex") ||
    tags.includes("unisex") ||
    /\bunisex\b/.test(blob);

  if (hasUnisex) return "unisex";
  if (hasWomen && !hasMen) return "womens";
  if (hasMen && !hasWomen) return "mens";
  if (hasMen && hasWomen) return "unisex";
  return "unknown";
}

function hasNegativeCollections(hit) {
  const collections = getCollectionsLc(hit);
  return collections.some((c) => containsAny(c, NEGATIVE_COLLECTION_TERMS));
}

function hasNegativeTags(hit) {
  const tags = getTagsLc(hit);
  return tags.some((t) => NEGATIVE_TAGS.has(t) || containsAny(t, [...NEGATIVE_TAGS]));
}

function hasNegativeProductType(hit) {
  const pt = productTypeText(hit);
  return containsAny(pt, NEGATIVE_PRODUCT_TYPE_TERMS);
}

function isAdultCategory(hit) {
  const category = lc(productCategory(hit));
  if (category === "kids") return false;

  const ageGroup = lc(hit?.meta?.custom?.age_group);
  if (["preschool", "toddler", "grade school", "grade-school", "youth"].includes(ageGroup)) {
    return false;
  }

  const collections = getCollectionsLc(hit);
  if (collections.some((c) => ["kids", "boys", "girls"].includes(c))) return false;

  const tags = getTagsLc(hit);
  if (tags.some((t) => ["kids", "boys", "girls", "preschool", "youth"].includes(t))) return false;

  return true;
}

function hasPositiveRunningSignal(hit) {
  const collections = getCollectionsLc(hit);
  const tags = getTagsLc(hit);
  const productType = productTypeText(hit);
  const title = titleText(hit);
  const body = bodyText(hit);

  if (collections.some((c) => POSITIVE_RUNNING_COLLECTIONS.has(c))) return true;
  if (tags.some((t) => POSITIVE_RUNNING_TAGS.has(t))) return true;

  if (productType.includes("performance")) return true;
  if (productType.includes("running")) return true;

  if (title.includes("running shoe") || title.includes("running shoes")) return true;
  if (body.includes("running shoe") || body.includes("running shoes")) return true;
  if (body.includes("for every run")) return true;
  if (body.includes("on every run")) return true;

  return false;
}

function isRunningShoe(hit) {
  if (!isAdultCategory(hit)) return false;
  if (!hasPositiveRunningSignal(hit)) return false;
  if (hasNegativeProductType(hit)) return false;
  if (hasNegativeTags(hit)) return false;

  const collections = getCollectionsLc(hit);
  const hasStrongRunningCollection = collections.some((c) => POSITIVE_RUNNING_COLLECTIONS.has(c));
  if (!hasStrongRunningCollection && hasNegativeCollections(hit)) return false;

  return true;
}

function getNotRunningReason(hit) {
  const category = lc(productCategory(hit));
  const ageGroup = lc(hit?.meta?.custom?.age_group);
  const collections = getCollectionsLc(hit);
  const tags = getTagsLc(hit);
  const productType = productTypeText(hit);
  const title = titleText(hit);
  const body = bodyText(hit);
  const blob = [category, ageGroup, productType, title, body, ...collections, ...tags].join(" ");

  const isKids =
    category === "kids" ||
    ["preschool", "toddler", "grade school", "grade-school", "youth"].includes(ageGroup) ||
    collections.some((c) => ["kids", "boys", "girls"].includes(c)) ||
    tags.some((t) => ["kids", "boys", "girls", "preschool", "youth"].includes(t)) ||
    /\bkid'?s\b/.test(blob) ||
    /\bkids\b/.test(blob) ||
    /\bboys\b/.test(blob) ||
    /\bgirls\b/.test(blob) ||
    /\bpreschool\b/.test(blob) ||
    /\btoddler\b/.test(blob) ||
    /\byouth\b/.test(blob);

  if (isKids) return "dropped_kids";

  const isAccessory =
    collections.some((c) => c.includes("accessories") || c.includes("clothing") || c.includes("apparel")) ||
    tags.some((t) => t === "accessories" || t === "clothing" || t === "apparel") ||
    productType.includes("accessories") ||
    productType.includes("clothing") ||
    productType.includes("apparel") ||
    blob.includes("crossbody bag") ||
    blob.includes("backpack") ||
    blob.includes("wallet") ||
    /\bbag\b/.test(blob) ||
    /\bsock\b/.test(blob) ||
    /\bsocks\b/.test(blob) ||
    /\bhat\b/.test(blob) ||
    /\bbeanie\b/.test(blob) ||
    /\bglove\b/.test(blob) ||
    /\bgloves\b/.test(blob) ||
    /\bshirt\b/.test(blob) ||
    /\bshorts\b/.test(blob) ||
    /\bjacket\b/.test(blob) ||
    /\bbra\b/.test(blob) ||
    /\blegging\b/.test(blob) ||
    /\bleggings\b/.test(blob);

  if (isAccessory) return "dropped_accessories";

  const isBoot =
    collections.some((c) => c.includes("boots") || c.includes("booties")) ||
    tags.some((t) => t === "boots" || t === "booties") ||
    productType.includes("boots") ||
    productType.includes("booties") ||
    /\bboot\b/.test(blob) ||
    /\bbootie\b/.test(blob) ||
    /\bboots\b/.test(blob) ||
    /\bbooties\b/.test(blob);

  if (isBoot) return "dropped_boots";

  const isCasualLifestyle =
    collections.some((c) => containsAny(c, ["casual", "lifestyle", "oxfords", "loafers", "dress", "walking"])) ||
    tags.some((t) => NEGATIVE_TAGS.has(t) || containsAny(t, ["casual", "lifestyle", "oxford", "loafer", "dress", "walking"])) ||
    containsAny(productType, NEGATIVE_PRODUCT_TYPE_TERMS) ||
    /\bcasual\b/.test(blob) ||
    /\blifestyle\b/.test(blob) ||
    /\boxford\b/.test(blob) ||
    /\boxfords\b/.test(blob) ||
    /\bloafer\b/.test(blob) ||
    /\bloafers\b/.test(blob) ||
    /\bdress\b/.test(blob) ||
    /\bwalking\b/.test(blob) ||
    /\bfashion\b/.test(blob) ||
    /\bcanvas\b/.test(blob) ||
    blob.includes("everyday wear");

  if (isCasualLifestyle) return "dropped_casualLifestyle";

  return "dropped_notRunning";
}

function buildListingUrl(hit) {
  const handle = cleanWhitespace(hit?.handle);
  return handle ? `https://tradehome.com/products/${handle}` : null;
}

function buildImageUrl(hit) {
  return cleanWhitespace(hit?.product_image || hit?.image) || null;
}

function inferBrand(hit) {
  return cleanWhitespace(hit?.vendor) || null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferModel(hit) {
  const title = cleanWhitespace(hit?.title);
  const brand = cleanWhitespace(hit?.vendor);

  let model = title
    .replace(/^(men's|mens|women's|womens|kid's|kids|unisex)\s+/i, "")
    .replace(/\s+(running shoe|running shoes)$/i, "")
    .trim();

  if (brand) {
    model = model.replace(new RegExp(`^${escapeRegex(brand)}\\s+`, "i"), "").trim();
  }

  return model || title || null;
}

function getProductKey(hit) {
  if (hit?.id != null) return `product:${hit.id}`;
  const handle = cleanWhitespace(hit?.handle);
  if (handle) return `handle:${handle}`;
  return `object:${cleanWhitespace(hit?.objectID)}`;
}

function initDropCounts() {
  return {
    totalTiles: 0,
    dropped_notRunning: 0,
    dropped_kids: 0,
    dropped_accessories: 0,
    dropped_boots: 0,
    dropped_casualLifestyle: 0,
    dropped_wrongGenderCategory: 0,
    dropped_hiddenPrice: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingBrand: 0,
    dropped_missingModel: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_duplicateProduct: 0,
    dropped_saleNotLessThanOriginal: 0,
  };
}

function initGenderCounts() {
  return {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };
}

function increment(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + by;
}

function addGenderCount(obj, gender) {
  if (!obj[gender]) obj[gender] = 0;
  obj[gender] += 1;
}

async function fetchAlgoliaPage(page) {
  const params = new URLSearchParams({
    clickAnalytics: "true",
    facetingAfterDistinct: "false",
    facets: JSON.stringify([
      "meta.custom.age_group",
      "meta.custom.product_category",
      "options.color",
      "options.size",
      "price",
      "price_range",
      "product_type",
      "vendor",
    ]),
    filters: `collection_ids:"${SALE_COLLECTION_ID}" AND inventory_available:true`,
    highlightPostTag: "__/ais-highlight__",
    highlightPreTag: "__ais-highlight__",
    hitsPerPage: String(HITS_PER_PAGE),
    maxValuesPerFacet: "100",
    page: String(page),
    query: "",
    ruleContexts: JSON.stringify(["sale", "shopify_default_collection"]),
    userToken: "anonymous-chatgpt-scraper",
  });

  const body = JSON.stringify({
    requests: [
      {
        indexName: ALGOLIA_INDEX_NAME,
        params: params.toString(),
      },
    ],
  });

  const res = await fetch(ALGOLIA_BASE_URL, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Algolia-API-Key": ALGOLIA_API_KEY,
      "X-Algolia-Application-Id": ALGOLIA_APP_ID,
      Origin: "https://tradehome.com",
      Referer: "https://tradehome.com/",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    },
    body,
  });

  const text = await res.text();
  const json = safeJson(text);

  if (!res.ok || !json) {
    throw new Error(
      `Algolia request failed for page ${page}: ${res.status} ${text.slice(0, 500)}`
    );
  }

  const result = json?.results?.[0];
  if (!result) {
    throw new Error(`Algolia response missing results[0] for page ${page}`);
  }

  return result;
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  // CRON_SECRET
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const dropCounts = initDropCounts();
  const storeGenderCounts = initGenderCounts();
  const pageSummaries = [];
  const deals = [];
  const sourceUrls = [];
  const seenProductKeys = new Set();

  let pagesFetched = 0;
  let dealsFound = 0;

  try {
    const first = await fetchAlgoliaPage(0);
    const nbPages = Number(first?.nbPages) || 0;
    const allResults = [first];

    for (let page = 1; page < nbPages; page += 1) {
      const next = await fetchAlgoliaPage(page);
      allResults.push(next);
    }

    for (let i = 0; i < allResults.length; i += 1) {
      const result = allResults[i];
      const hits = asArray(result?.hits);

      const pageSummary = {
        page: i + 1,
        url: `${SOURCE_BASE_URL}?page=${i + 1}`,
        hitsReturned: hits.length,
        dealsExtracted: 0,
        droppedDeals: 0,
        genderCounts: initGenderCounts(),
        dropCounts: initDropCounts(),
      };

      sourceUrls.push(pageSummary.url);
      pagesFetched += 1;
      dealsFound += hits.length;
      pageSummary.dropCounts.totalTiles = hits.length;
      dropCounts.totalTiles += hits.length;

      for (const hit of hits) {
        const productKey = getProductKey(hit);
        const gender = inferGender(hit);

        const fail = (reasonKey) => {
          increment(dropCounts, reasonKey);
          increment(pageSummary.dropCounts, reasonKey);
          pageSummary.droppedDeals += 1;
        };

        if (!isRunningShoe(hit)) {
          fail(getNotRunningReason(hit));
          continue;
        }

        if (!(gender === "mens" || gender === "womens" || gender === "unisex")) {
          fail("dropped_wrongGenderCategory");
          continue;
        }

        if (hasHiddenPriceLanguage(hit)) {
          fail("dropped_hiddenPrice");
          continue;
        }

        if (seenProductKeys.has(productKey)) {
          fail("dropped_duplicateProduct");
          continue;
        }

        const listingName = cleanWhitespace(hit?.title);
        const brand = inferBrand(hit);
        const model = inferModel(hit);
        const listingURL = buildListingUrl(hit);
        const imageURL = buildImageUrl(hit);

        const salePrice = roundMoney(toNumber(hit?.price));
        const originalPrice = roundMoney(
          toNumber(
            hit?.compare_at_price ??
              hit?.variants_compare_at_price_max ??
              hit?.variants_compare_at_price_min
          )
        );

        if (!listingURL) {
          fail("dropped_missingListingURL");
          continue;
        }

        if (!imageURL) {
          fail("dropped_missingImageURL");
          continue;
        }

        if (!brand || /^unknown$/i.test(brand)) {
          fail("dropped_missingBrand");
          continue;
        }

        if (!model) {
          fail("dropped_missingModel");
          continue;
        }

        if (!Number.isFinite(salePrice)) {
          fail("dropped_missingSalePrice");
          continue;
        }

        if (!Number.isFinite(originalPrice)) {
          fail("dropped_missingOriginalPrice");
          continue;
        }

        if (!(salePrice < originalPrice)) {
          fail("dropped_saleNotLessThanOriginal");
          continue;
        }

        const discountPercent = roundPercent(
          ((originalPrice - salePrice) / originalPrice) * 100
        );

        deals.push({
          schemaVersion: SCHEMA_VERSION,

          listingName,

          brand,
          model,

          salePrice,
          originalPrice,
          discountPercent,

          salePriceLow: salePrice,
          salePriceHigh: salePrice,
          originalPriceLow: originalPrice,
          originalPriceHigh: originalPrice,
          discountPercentUpTo: discountPercent,

          store: STORE,

          listingURL,
          imageURL,

          gender,
          shoeType: "unknown",
        });

        seenProductKeys.add(productKey);
        pageSummary.dealsExtracted += 1;
        addGenderCount(pageSummary.genderCounts, gender);
        addGenderCount(storeGenderCounts, gender);
      }

      pageSummaries.push(pageSummary);
    }

const payload = {
  store: STORE,
  schemaVersion: SCHEMA_VERSION,

  lastUpdated: nowIso(),
  via: VIA,

  sourceUrls,

  pagesFetched,

  dealsFound,
  dealsExtracted: deals.length,
  dealsForMens: storeGenderCounts.mens,
  dealsForWomens: storeGenderCounts.womens,
  dealsForUnisex: storeGenderCounts.unisex,
  dealsForUnknown: storeGenderCounts.unknown,

  scrapeDurationMs: Date.now() - startedAt,

  ok: true,
  error: null,

  dropCounts,

  deals,
};

    const blob = await put(BLOB_PATH, JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobPath: BLOB_PATH,
      blobUrl: blob.url,
      pagesFetched,
      dealsFound,
      dealsExtracted: deals.length,
      dealsForMens: storeGenderCounts.mens,
      dealsForWomens: storeGenderCounts.womens,
      dealsForUnisex: storeGenderCounts.unisex,
      dealsForUnknown: storeGenderCounts.unknown,
      dropCounts,
      pageSummaries,
      sourceUrls,
      scrapeDurationMs: Date.now() - startedAt,
      ok: true,
      error: null,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: err?.message || "Unknown error",
      scrapeDurationMs: Date.now() - startedAt,
      pagesFetched,
      dealsFound,
      dealsExtracted: deals.length,
      dealsForMens: storeGenderCounts.mens,
      dealsForWomens: storeGenderCounts.womens,
      dealsForUnisex: storeGenderCounts.unisex,
      dealsForUnknown: storeGenderCounts.unknown,
      dropCounts,
      pageSummaries,
      sourceUrls,
      ok: false,
    });
  }
}
