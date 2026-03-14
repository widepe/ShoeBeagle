// /api/scrapers/scheels-search-api.js
//
// Scheels sale running shoes scraper
// - Uses Scheels internal search API directly
// - No Firecrawl
// - No Playwright
// - Paginates through API pages
// - Handles normal pricing and range pricing
// - Tracks drop reasons, page summaries, and gender counts
// - Writes top-level metadata + deals array to Vercel Blob only
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//   - optional CRON_SECRET (commented out for testing)
//
// TEST:
//   /api/scrapers/scheels-search-api
//
// NOTES:
// - shoeType is always "unknown"
// - listingURL is built as /p/<primarySKU>
// - imageURL is built from first useful image ID
// - we filter to actual running shoes only
// - this endpoint already gives much cleaner results than scraping HTML

import { put } from "@vercel/blob";

export const config = { maxDuration: 300 };

const STORE = "Scheels";
const SCHEMA_VERSION = 1;
const VIA = "search-api";
const API_URL = "https://search.scheels.com/api/search";
const SITE_BASE = "https://www.scheels.com";
const BLOB_PATH = "scheels-sale.json";

const PAGE_SIZE = 24;
const SEARCH_QUERY = "shoes";

const FACET_FILTERS = [
  ["attributes.activity:Running"],
  ["attributes.runningType:Everyday", "attributes.runningType:Tempo"],
  ["pricing.groups.default.onSale:true"],
];

const ATTRIBUTES_TO_RETRIEVE = [
  "title",
  "variants.sku",
  "variants.images",
  "variants.inStock",
  "variants.attributes.refinementColor",
  "attributes.productBadge",
  "attributes.inStockStatus",
  "attributes.specialPricing",
  "attributes.discountMessage",
  "attributes.rebate",
  "attributes.isAmmo",
  "attributes.quantity",
  "isProductBundle",
  "image",
  "pricing.groups.default",
  "pricing.groups.canada",
  "pricing.minRetail",
  "swatchImages",
  "averageRating",
  "reviewCount",
  "primarySKU",
  "shop",
  "class",
  "displayAsOnSale",
  "subclass",
  "primaryCategory",
];

const BRAND_PREFIXES = [
  "New Balance",
  "Under Armour",
  "Topo Athletic",
  "La Sportiva",
  "Brooks",
  "Saucony",
  "ASICS",
  "HOKA",
  "Nike",
  "adidas",
  "Adidas",
  "On",
  "Mizuno",
  "PUMA",
  "Altra",
  "Salomon",
  "Merrell",
  "Craft",
  "Diadora",
  "Reebok",
  "Karhu",
  "361",
  "Newton",
  "Norda",
  "Scarpa",
  "inov-8",
  "Inov-8",
  "rabbit",
];

function nowIso() {
  return new Date().toISOString();
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function roundPct(n) {
  return Number.isFinite(n) ? Math.round(n) : null;
}

function computeDiscountPercent(original, sale) {
  if (
    !Number.isFinite(original) ||
    !Number.isFinite(sale) ||
    original <= 0 ||
    sale >= original
  ) {
    return null;
  }
  return roundPct(((original - sale) / original) * 100);
}

function parseGender(title) {
  const t = cleanText(title).toLowerCase();
  if (/\bwomen'?s\b|\bwomens\b/.test(t)) return "womens";
  if (/\bmen'?s\b|\bmens\b/.test(t)) return "mens";
  if (/\bunisex\b/.test(t)) return "unisex";
  return "unknown";
}

function stripGenderPrefix(title) {
  return cleanText(
    String(title || "")
      .replace(/^(women'?s|womens)\s+/i, "")
      .replace(/^(men'?s|mens)\s+/i, "")
      .replace(/^unisex\s+/i, "")
  );
}

function parseBrandAndModel(listingName) {
  const title = stripGenderPrefix(listingName)
    .replace(/\bRunning Shoes\b/i, "")
    .replace(/\bRunning Shoe\b/i, "")
    .trim();

  const brandMatch = [...BRAND_PREFIXES]
    .sort((a, b) => b.length - a.length)
    .find((brand) => title.toLowerCase().startsWith(brand.toLowerCase()));

  if (brandMatch) {
    return {
      brand: brandMatch,
      model: cleanText(title.slice(brandMatch.length)) || null,
    };
  }

  const parts = title.split(/\s+/).filter(Boolean);
  return {
    brand: parts[0] || null,
    model: cleanText(parts.slice(1).join(" ")) || null,
  };
}

function increment(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + by;
}

function makeDropCounts() {
  return {
    totalTiles: 0,
    dropped_notShoesCategory: 0,
    dropped_notRunningShoesTitle: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingPricing: 0,
    dropped_missingSalePrice: 0,
    dropped_notOnSale: 0,
    dropped_duplicateAfterMerge: 0,
  };
}

function makeGenderCounts() {
  return {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };
}

function getDefaultPricing(hit) {
  return hit?.data?.pricing?.groups?.default || null;
}

function buildListingUrl(hit) {
  const sku = hit?.data?.primarySKU || null;
  if (!sku) return null;
  return `${SITE_BASE}/p/${encodeURIComponent(String(sku))}`;
}

function normalizeImageId(raw) {
  if (!raw) return null;
  return String(raw).split("?")[0].trim() || null;
}

function buildImageUrlFromId(imageId) {
  const id = normalizeImageId(imageId);
  if (!id) return null;
  return `https://cdn.media.amplience.net/i/scheelspoc/${id}?w=1200&h=1200&fmt=auto&v=1`;
}

function buildImageUrl(hit) {
  const variantImage =
    hit?.data?.variants?.find((v) => Array.isArray(v?.images) && v.images.length)
      ?.images?.[0] || null;

  const swatchImage = hit?.data?.swatchImages?.[0]?.swatchURL || null;
  const directImage = hit?.data?.image || null;

  return (
    buildImageUrlFromId(variantImage) ||
    buildImageUrlFromId(directImage) ||
    buildImageUrlFromId(swatchImage) ||
    null
  );
}

function isRunningShoeHit(hit) {
  const title = cleanText(hit?.data?.title);
  const primaryCategory = cleanText(hit?.data?.primaryCategory).toLowerCase();

  if (primaryCategory !== "sneakers-athletic-shoes") return false;
  if (!/running shoe/i.test(title)) return false;

  return true;
}

function buildDeal(hit) {
  const title = cleanText(hit?.data?.title);
  const pricing = getDefaultPricing(hit);

  const minRetail = Number(pricing?.minRetail);
  const maxRetail = Number(pricing?.maxRetail);
  const minSale = Number(pricing?.minSale);
  const maxSale = Number(pricing?.maxSale);
  const onSale = Boolean(pricing?.onSale);

  const { brand, model } = parseBrandAndModel(title);
  const gender = parseGender(title);

  const hasRetailRange =
    Number.isFinite(minRetail) && Number.isFinite(maxRetail) && minRetail !== maxRetail;
  const hasSaleRange =
    Number.isFinite(minSale) && Number.isFinite(maxSale) && minSale !== maxSale;

  const salePrice =
    Number.isFinite(minSale) && Number.isFinite(maxSale) && minSale === maxSale
      ? minSale
      : null;

  const originalPrice =
    Number.isFinite(minRetail) && Number.isFinite(maxRetail) && minRetail === maxRetail
      ? minRetail
      : null;

  const salePriceLow = hasSaleRange ? minSale : null;
  const salePriceHigh = hasSaleRange ? maxSale : null;

  const originalPriceLow = hasRetailRange ? minRetail : null;
  const originalPriceHigh = hasRetailRange ? maxRetail : null;

  const discountPercent =
    Number.isFinite(originalPrice) && Number.isFinite(salePrice)
      ? computeDiscountPercent(originalPrice, salePrice)
      : null;

  const discountPercentUpTo =
    (hasRetailRange || hasSaleRange) && Number.isFinite(maxRetail) && Number.isFinite(minSale)
      ? computeDiscountPercent(maxRetail, minSale)
      : null;

  return {
    schemaVersion: SCHEMA_VERSION,

    listingName: title,

    brand,
    model,

    salePrice,
    originalPrice,
    discountPercent,

    salePriceLow,
    salePriceHigh,
    originalPriceLow,
    originalPriceHigh,
    discountPercentUpTo,

    store: STORE,

    listingURL: buildListingUrl(hit),
    imageURL: buildImageUrl(hit),

    gender,
    shoeType: "unknown",

    _debug: {
      onSale,
      primaryCategory: hit?.data?.primaryCategory || null,
      primarySKU: hit?.data?.primarySKU || null,
    },
  };
}

function hasAnySalePrice(deal) {
  return (
    Number.isFinite(deal.salePrice) ||
    Number.isFinite(deal.salePriceLow) ||
    Number.isFinite(deal.salePriceHigh)
  );
}

async function fetchScheelsPage(page) {
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      "x-client-source": "www.scheels.com",
    },
    body: JSON.stringify({
      queries: [
        {
          indexName: "commercetools_products",
          page,
          pageSize: PAGE_SIZE,
          trackEvents: true,
          query: SEARCH_QUERY,
          filters: "(inStock:true OR variants.attributes.comingSoon:true) AND searchable:1",
          facetFilters: FACET_FILTERS,
          attributesToRetrieve: ATTRIBUTES_TO_RETRIEVE,
          dynamicRerank: true,
          branchName: "single_term",
          facets: ["*"],
        },
      ],
    }),
  });

  const json = await resp.json().catch(() => null);

  if (!resp.ok) {
    throw new Error(
      `Scheels search API failed: ${resp.status} ${json?.error || resp.statusText}`
    );
  }

  const result = json?.results?.[0];
  if (!result) {
    throw new Error("Scheels search API returned no results[0]");
  }

  return result;
}

function buildSourceUrl(page) {
  if (page <= 1) {
    return "https://www.scheels.com/search/sale/?r=activity%3ARunning%3BrunningType%3ATempo%7CEveryday%7CRace&q=shoes";
  }
  return `https://www.scheels.com/search/sale/?r=activity%3ARunning%3BrunningType%3ATempo%7CEveryday%7CRace&q=shoes&page=${page}`;
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  // TEMPORARILY COMMENTED OUT FOR TESTING:
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error("Missing BLOB_READ_WRITE_TOKEN");
    }

    const sourceUrls = [];
    const pageSummaries = [];
    const dropCounts = makeDropCounts();
    const genderCounts = makeGenderCounts();

    const deals = [];
    const seen = new Set();

    let pagesFetched = 0;
    let dealsFound = 0;
    let totalHits = null;
    let totalPages = null;

    for (let page = 1; page <= 50; page++) {
      const result = await fetchScheelsPage(page);
      const hits = Array.isArray(result?.hits) ? result.hits : [];

      if (page === 1) {
        totalHits = Number(result?.totalHits) || 0;
        totalPages = Math.max(1, Math.ceil(totalHits / PAGE_SIZE));
      }

      if (!hits.length) {
        if (page === 1) {
          throw new Error("Scheels search API returned zero hits on page 1.");
        }
        break;
      }

      pagesFetched += 1;
      sourceUrls.push(buildSourceUrl(page));

      const pageDropCounts = makeDropCounts();
      const pageGenderCounts = makeGenderCounts();
      let pageDealsExtracted = 0;

      dealsFound += hits.length;

      for (const hit of hits) {
        increment(dropCounts, "totalTiles");
        increment(pageDropCounts, "totalTiles");

        const title = cleanText(hit?.data?.title);

        if (!title) {
          increment(dropCounts, "dropped_missingListingName");
          increment(pageDropCounts, "dropped_missingListingName");
          continue;
        }

        if (!isRunningShoeHit(hit)) {
          const primaryCategory = cleanText(hit?.data?.primaryCategory).toLowerCase();
          if (primaryCategory !== "sneakers-athletic-shoes") {
            increment(dropCounts, "dropped_notShoesCategory");
            increment(pageDropCounts, "dropped_notShoesCategory");
          } else {
            increment(dropCounts, "dropped_notRunningShoesTitle");
            increment(pageDropCounts, "dropped_notRunningShoesTitle");
          }
          continue;
        }

        const deal = buildDeal(hit);

        if (!deal._debug.onSale) {
          increment(dropCounts, "dropped_notOnSale");
          increment(pageDropCounts, "dropped_notOnSale");
          continue;
        }

        if (!deal.listingURL) {
          increment(dropCounts, "dropped_missingListingURL");
          increment(pageDropCounts, "dropped_missingListingURL");
          continue;
        }

        if (!deal.imageURL) {
          increment(dropCounts, "dropped_missingImageURL");
          increment(pageDropCounts, "dropped_missingImageURL");
          continue;
        }

        const pricing = getDefaultPricing(hit);
        if (!pricing) {
          increment(dropCounts, "dropped_missingPricing");
          increment(pageDropCounts, "dropped_missingPricing");
          continue;
        }

        if (!hasAnySalePrice(deal)) {
          increment(dropCounts, "dropped_missingSalePrice");
          increment(pageDropCounts, "dropped_missingSalePrice");
          continue;
        }

        const dedupeKey = deal.listingURL;
        if (seen.has(dedupeKey)) {
          increment(dropCounts, "dropped_duplicateAfterMerge");
          increment(pageDropCounts, "dropped_duplicateAfterMerge");
          continue;
        }

        seen.add(dedupeKey);

        delete deal._debug;
        deals.push(deal);
        pageDealsExtracted += 1;

        increment(genderCounts, deal.gender);
        increment(pageGenderCounts, deal.gender);
      }

      pageSummaries.push({
        page,
        url: buildSourceUrl(page),
        apiPage: Number(result?.page) || page,
        totalCount: Number(result?.totalHits) || null,
        pageSize: Number(result?.pageSize) || PAGE_SIZE,
        tilesSeenThisPage: hits.length,
        dealsExtracted: pageDealsExtracted,
        genderCounts: pageGenderCounts,
        dropCounts: pageDropCounts,
      });

      if (totalPages && page >= totalPages) {
        break;
      }
    }

    if (!deals.length) {
      throw new Error("Scheels scrape returned zero deals.");
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

      dealsForMens: genderCounts.mens,
      dealsForWomens: genderCounts.womens,
      dealsForUnisex: genderCounts.unisex,
      dealsForUnknown: genderCounts.unknown,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      pageSummaries,
      dropCounts,

      deals,
    };

    const blob = await put(BLOB_PATH, JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobPath: BLOB_PATH,
      blobUrl: blob.url,
      pagesFetched: payload.pagesFetched,
      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,
      dealsForMens: payload.dealsForMens,
      dealsForWomens: payload.dealsForWomens,
      dealsForUnisex: payload.dealsForUnisex,
      dealsForUnknown: payload.dealsForUnknown,
      dropCounts: payload.dropCounts,
      pageSummaries: payload.pageSummaries,
      scrapeDurationMs: payload.scrapeDurationMs,
      ok: true,
      error: null,
    });
  } catch (err) {
    console.error("SCHEELS SEARCH API SCRAPER ERROR:", err);

    return res.status(500).json({
      success: false,
      store: STORE,
      error: err?.message || String(err),
      scrapeDurationMs: Date.now() - startedAt,
      ok: false,
    });
  }
}
