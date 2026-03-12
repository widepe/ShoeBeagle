// /api/scrapers/shoe-carnival.js
//
// Fast Shoe Carnival scraper
// - Uses Algolia directly
// - Scrapes these two searches:
//   1) womens running shoes + on_sale
//   2) men's running shoes + on_sale
// - Assumes the search pages already contain the correct products
// - Only drops:
//   * hidden/MAP price ("see price in cart/bag" style)
//   * duplicates
//   * missing required fields
// - Dedupes by masterStyle
// - Uses large hitsPerPage to keep requests very low
// - Writes top-level structure + deals array only
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//
// TEST:
//   /api/scrapers/shoe-carnival
//
// NOTE:
// - CRON auth is included below but commented out for testing.

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Shoe Carnival";
const SCHEMA_VERSION = 1;
const VIA = "algolia";
const BLOB_PATH = "shoe-carnival.json";

const WOMENS_PAGE_URL =
  "https://www.shoecarnival.com/search?styleType=Performance&q=womens%20running%20shoes&sale=true";
const MENS_PAGE_URL =
  "https://www.shoecarnival.com/search?styleType=Performance&q=men%27s%20running%20shoes&sale=true";

const ALGOLIA_APP_ID = "FA677J9QJI";
const ALGOLIA_API_KEY = "23d75c51c43c0ea2995b94bd56048224";
const ALGOLIA_INDEX =
  "production_na02_shoecarnival_demandware_net__shoecarnival__products__default";

const HITS_PER_PAGE = 1000;

function nowIso() {
  return new Date().toISOString();
}

function asArray(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function lc(s) {
  return cleanText(s).toLowerCase();
}

function toNumber(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function calcDiscountPercent(originalPrice, salePrice) {
  if (
    !Number.isFinite(originalPrice) ||
    !Number.isFinite(salePrice) ||
    originalPrice <= 0 ||
    salePrice < 0 ||
    salePrice >= originalPrice
  ) {
    return null;
  }
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function inc(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + by;
}

function emptyGenderCounts() {
  return {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };
}

function makeAbsoluteUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `https://www.shoecarnival.com${path.startsWith("/") ? path : `/${path}`}`;
}

function getGenderFromHit(hit) {
  const genders = asArray(hit?.gender).map((g) => lc(g));
  const name = lc(hit?.name);

  if (genders.includes("men") || genders.includes("mens") || /^men's\b/.test(name)) {
    return "mens";
  }
  if (genders.includes("women") || genders.includes("womens") || /^women's\b/.test(name)) {
    return "womens";
  }
  if (genders.includes("unisex") || /^unisex\b/.test(name)) {
    return "unisex";
  }
  return "unknown";
}

function extractImageUrl(hit) {
  const groupImage = asArray(hit?.image_groups)
    .flatMap((group) => asArray(group?.images))
    .find((img) => img?.dis_base_link)?.dis_base_link;

  if (groupImage) return groupImage;

  const flatImage = asArray(hit?.images).find((img) => img?.dis_base_link)?.dis_base_link;
  if (flatImage) return flatImage;

  return null;
}

function buildModel(listingName, brand) {
  let model = cleanText(listingName);
  if (!model) return null;

  model = model.replace(/^(men's|mens|women's|womens|unisex)\s+/i, "");

  if (brand) {
    const brandEscaped = String(brand).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    model = model.replace(new RegExp(`^${brandEscaped}\\s+`, "i"), "");
  }

  model = model.replace(/\s+running shoes?$/i, "");
  model = model.replace(/\s+/g, " ").trim();

  return model || null;
}

function isHiddenPriceHit(hit) {
  const price = hit?.price || {};

  const sale = toNumber(price?.c_sale_price);
  const standard = toNumber(price?.c_standard_price);

  const mapRestricted =
    Boolean(price?.c_map_price_restriction) || Boolean(hit?.c_map_price_restriction);

  const searchableText = lc(
    [
      hit?.name,
      hit?.pageDescription,
      hit?.pageTitle,
      hit?.long_description,
      hit?.manufacturerName,
      JSON.stringify(hit?.promotions || []),
    ].join(" ")
  );

  const hiddenLanguage =
    /see price in (cart|bag)|price in (cart|bag)|add to (cart|bag) to see price|hidden price|map price/i.test(
      searchableText
    );

  const noVisibleSalePrice = !Number.isFinite(sale);

  return mapRestricted || hiddenLanguage || noVisibleSalePrice || !Number.isFinite(standard) && !Number.isFinite(sale);
}

function validateDeal(deal) {
  if (!deal.listingName) return "missingListingName";
  if (!deal.brand) return "missingBrand";
  if (!deal.model) return "missingModel";
  if (!Number.isFinite(deal.salePrice)) return "missingSalePrice";
  if (!deal.listingURL) return "missingListingURL";
  if (!deal.imageURL) return "missingImageURL";
  return null;
}

function mapHitToDeal(hit) {
  const listingName = cleanText(hit?.name);
  const brand = cleanText(hit?.brand || hit?.manufacturerName);
  const salePrice = toNumber(hit?.price?.c_sale_price);
  const standardPrice = toNumber(hit?.price?.c_standard_price);

  let originalPrice = null;
  let discountPercent = null;

  if (
    Number.isFinite(standardPrice) &&
    Number.isFinite(salePrice) &&
    standardPrice > salePrice
  ) {
    originalPrice = round2(standardPrice);
    discountPercent = calcDiscountPercent(originalPrice, salePrice);
  }

  return {
    schemaVersion: 1,

    listingName,
    brand: brand || null,
    model: buildModel(listingName, brand),

    salePrice: Number.isFinite(salePrice) ? round2(salePrice) : null,
    originalPrice,
    discountPercent,

    salePriceLow: null,
    salePriceHigh: null,
    originalPriceLow: null,
    originalPriceHigh: null,
    discountPercentUpTo: null,

    store: STORE,

    listingURL: makeAbsoluteUrl(hit?.url),
    imageURL: extractImageUrl(hit),

    gender: getGenderFromHit(hit),
    shoeType: "unknown",
  };
}

async function fetchAlgoliaPage({ query, page }) {
  const body = {
    requests: [
      {
        indexName: ALGOLIA_INDEX,
        clickAnalytics: true,
        facetFilters: [["on_sale:true"]],
        facets: [
          "age",
          "assignedCategories.id",
          "brand",
          "colorPrimary",
          "gender",
          "heelHeight",
          "on_sale",
          "sizeFilterVariations",
          "styleType",
          "widthVariations",
        ],
        filters: "",
        highlightPreTag: "__ais-highlight__",
        highlightPostTag: "__/ais-highlight__",
        hitsPerPage: HITS_PER_PAGE,
        maxValuesPerFacet: 1000,
        page,
        query,
        userToken: "41c1f231-5a8a-4015-b40a-e8089353f4e3",
      },
    ],
  };

  const url = `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-algolia-agent":
        "Algolia for JavaScript (5.49.0); Search (5.49.0); Browser; instantsearch.js (4.88.0); react (18.3.1); react-instantsearch (7.24.0); react-instantsearch-core (7.24.0); JS Helper (3.27.1)",
      "x-algolia-application-id": ALGOLIA_APP_ID,
      "x-algolia-api-key": ALGOLIA_API_KEY,
      accept: "application/json",
      "content-type": "application/json",
      origin: "https://www.shoecarnival.com",
      referer: "https://www.shoecarnival.com/",
      "user-agent": "Mozilla/5.0",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Algolia HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }

  const json = await resp.json();
  const result = json?.results?.[0];
  if (!result) throw new Error("Algolia response missing results[0].");

  return result;
}

async function collectAllHits(query) {
  const firstPage = await fetchAlgoliaPage({ query, page: 0 });

  const nbHits = toNumber(firstPage?.nbHits) || 0;
  const firstHits = asArray(firstPage?.hits);

  if (firstHits.length >= nbHits || nbHits <= HITS_PER_PAGE) {
    return {
      nbHits,
      pagesFetched: 1,
      hits: firstHits,
    };
  }

  const totalPages = Math.ceil(nbHits / HITS_PER_PAGE);
  const allHits = [...firstHits];
  let pagesFetched = 1;

  for (let page = 1; page < totalPages; page += 1) {
    const result = await fetchAlgoliaPage({ query, page });
    allHits.push(...asArray(result?.hits));
    pagesFetched += 1;
  }

  return {
    nbHits,
    pagesFetched,
    hits: allHits,
  };
}

function summarizeSearchHits({
  kind,
  pageUrl,
  hits,
  deals,
  seen,
  dropCounts,
  genderCounts,
}) {
  const pageDropCounts = {};
  const pageGenderCounts = emptyGenderCounts();
  let pageExtracted = 0;

  for (const hit of hits) {
    if (isHiddenPriceHit(hit)) {
      inc(dropCounts, "dropped_hiddenPrice");
      inc(pageDropCounts, "dropped_hiddenPrice");
      continue;
    }

    const deal = mapHitToDeal(hit);
    const invalidReason = validateDeal(deal);
    if (invalidReason) {
      inc(dropCounts, `dropped_${invalidReason}`);
      inc(pageDropCounts, `dropped_${invalidReason}`);
      continue;
    }

    const dedupeKey = String(hit?.masterStyle || hit?.url || hit?.objectID || "").trim();
    if (!dedupeKey) {
      inc(dropCounts, "dropped_missingDedupeKey");
      inc(pageDropCounts, "dropped_missingDedupeKey");
      continue;
    }

    if (seen.has(dedupeKey)) {
      inc(dropCounts, "dropped_duplicate");
      inc(pageDropCounts, "dropped_duplicate");
      continue;
    }

    seen.add(dedupeKey);
    deals.push(deal);
    pageExtracted += 1;
    inc(genderCounts, deal.gender);
    inc(pageGenderCounts, deal.gender);
  }

  return {
    searchKind: kind,
    page: 1,
    url: pageUrl,
    hitsReturned: hits.length,
    dealsExtracted: pageExtracted,
    droppedDeals: Object.values(pageDropCounts).reduce((sum, n) => sum + n, 0),
    genderCounts: pageGenderCounts,
    dropCounts: pageDropCounts,
  };
}

export default async function handler(req, res) {
  const started = Date.now();

  // // CRON_SECRET
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  try {
    const sourceUrls = [WOMENS_PAGE_URL, MENS_PAGE_URL];
    const deals = [];
    const seen = new Set();
    const pageSummaries = [];
    const dropCounts = {};
    const genderCounts = emptyGenderCounts();

    const womens = await collectAllHits("womens running shoes");
    const mens = await collectAllHits("men's running shoes");

    pageSummaries.push(
      summarizeSearchHits({
        kind: "womens",
        pageUrl: WOMENS_PAGE_URL,
        hits: womens.hits,
        deals,
        seen,
        dropCounts,
        genderCounts,
      })
    );

    pageSummaries.push(
      summarizeSearchHits({
        kind: "mens",
        pageUrl: MENS_PAGE_URL,
        hits: mens.hits,
        deals,
        seen,
        dropCounts,
        genderCounts,
      })
    );

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,
      pagesFetched: womens.pagesFetched + mens.pagesFetched,

      dealsFound: womens.nbHits + mens.nbHits,
      dealsExtracted: deals.length,

      dealsForMens: genderCounts.mens,
      dealsForWomens: genderCounts.womens,
      dealsForUnisex: genderCounts.unisex,
      dealsForUnknown: genderCounts.unknown,

      scrapeDurationMs: Date.now() - started,

      ok: true,
      error: null,

      pageSummaries,
      dropCounts,

      deals,
    };

    const blob = await put(BLOB_PATH, JSON.stringify(output, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobPath: BLOB_PATH,
      blobUrl: blob.url,
      pagesFetched: output.pagesFetched,
      dealsFound: output.dealsFound,
      dealsExtracted: output.dealsExtracted,
      dealsForMens: output.dealsForMens,
      dealsForWomens: output.dealsForWomens,
      dealsForUnisex: output.dealsForUnisex,
      dealsForUnknown: output.dealsForUnknown,
      dropCounts: output.dropCounts,
      pageSummaries: output.pageSummaries,
      scrapeDurationMs: output.scrapeDurationMs,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: err?.message || String(err),
      scrapeDurationMs: Date.now() - started,
    });
  }
}
