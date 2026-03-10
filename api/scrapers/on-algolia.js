// /api/scrapers/on-algolia.js
//
// Scrapes discounted "last season/classics" On running shoes from Algolia
// and uploads standardized JSON to Vercel Blob as:
//
//   on-last-season-shoes.json
//
// IMPORTANT RULES
// - listingName is preserved exactly from Algolia `name`.
// - gender is ONLY: mens, womens, unisex, unknown
// - shoeType is ONLY: road, trail, track, unknown
// - do not include the full deals array in the API response metadata
// - keep a capped dropped-shoes log so you can inspect what was dropped and why
//
// ENV
// - BLOB_READ_WRITE_TOKEN
// - CRON_SECRET (optional, if you want auth enabled)
//
// NOTES
// - Uses Algolia directly
// - Uses only results[0].hits
// - Current query returns nbPages=1, but pagination support is included anyway

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "On";
const SCHEMA_VERSION = 1;
const VIA = "algolia";
const BASE_URL = "https://www.on.com";
const BLOB_PATH = "on-last-season-shoes.json";

// Toggle CRON auth here if needed
const REQUIRE_CRON_SECRET = true;

// Algolia config discovered from On site requests
const ALGOLIA_URL =
  "https://algolia.on.com/1/indexes/*/queries?x-algolia-agent=Algolia%20for%20JavaScript%20(4.26.0)%3B%20Browser%20(lite)%3B%20instantsearch.js%20(4.90.0)%3B%20Vue%20(3.5.29)%3B%20Vue%20InstantSearch%20(4.24.0)%3B%20JS%20Helper%20(3.28.0)&x-algolia-api-key=bff229776989d153121333c90db826b1&x-algolia-application-id=ML35QLWPOC";

const SOURCE_URL =
  "https://www.on.com/en-us/shop/classics/mens~womens/shoes/competition~marathon~road-running~track-and-field~trail-running";

const HITS_PER_PAGE = 110;
const MAX_PAGES = 10;
const MAX_DROPPED_LOG = 200;

function nowIso() {
  return new Date().toISOString();
}

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function absUrl(path) {
  if (!path || typeof path !== "string") return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

function mapGender(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "mens") return "mens";
  if (v === "womens") return "womens";
  if (v === "unisex") return "unisex";
  return "unknown";
}

function mapShoeType(productSubtype, productSubtypes) {
  const vals = [
    productSubtype,
    ...(Array.isArray(productSubtypes) ? productSubtypes : []),
  ]
    .filter(Boolean)
    .map((x) => String(x).trim().toLowerCase());

  if (vals.includes("trail_running")) return "trail";
  if (vals.includes("track") || vals.includes("track_and_field")) return "track";
  if (vals.includes("road_running")) return "road";
  return "unknown";
}

function exactDiscountPercent(salePrice, originalPrice) {
  if (
    typeof salePrice !== "number" ||
    typeof originalPrice !== "number" ||
    !Number.isFinite(salePrice) ||
    !Number.isFinite(originalPrice) ||
    originalPrice <= 0 ||
    salePrice >= originalPrice
  ) {
    return null;
  }
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function buildMainParams(page) {
  return [
    "clickAnalytics=true",
    "distinct=true",
    'facetFilters=[["activities:competition","activities:marathon","activities:road_running","activities:track_and_field","activities:trail_running"],["genderFilter:mens","genderFilter:womens"],["productType:shoes"],["tags:classics"]]',
    'facets=["activities","collections","colorCodes","conditions","cushioning","family","features","fit","genderFilter","lacing","plpCampaigns","productSubtypeStyle","productSubtypes","productType","roadRunningStyle","sizesApparelMen","sizesApparelWomen","sizesShoesKids","sizesShoesMen","sizesShoesWomen","support","supportLevel","surface","tags","technology","terrain"]',
    "filters=NOT productUrl:NULL AND NOT imageUrl:NULL AND NOT groupingKey:NULL AND stores.us.isVisible:true AND stores.us.isHiddenFromSearch:false AND NOT tags:exclude_from_plp AND stores.us.discountPercentage > 0 AND NOT tags:lost_and_found",
    "highlightPostTag=__/ais-highlight__",
    "highlightPreTag=__ais-highlight__",
    `hitsPerPage=${HITS_PER_PAGE}`,
    "maxValuesPerFacet=50",
    `page=${page}`,
    "userToken=xxxxxxxx",
    'optionalFilters=["label:-coming_soon<score=100>","tags:-subscription<score=200>"]',
  ].join("&");
}

function buildFacetParamsActivities() {
  return [
    "analytics=false",
    "clickAnalytics=false",
    "distinct=true",
    'facetFilters=[["genderFilter:mens","genderFilter:womens"],["productType:shoes"],["tags:classics"]]',
    "facets=activities",
    "filters=NOT productUrl:NULL AND NOT imageUrl:NULL AND NOT groupingKey:NULL AND stores.us.isVisible:true AND stores.us.isHiddenFromSearch:false AND NOT tags:exclude_from_plp AND stores.us.discountPercentage > 0 AND NOT tags:lost_and_found",
    "highlightPostTag=__/ais-highlight__",
    "highlightPreTag=__ais-highlight__",
    "hitsPerPage=0",
    "maxValuesPerFacet=50",
    "page=0",
    "userToken=xxxxxxxx",
  ].join("&");
}

function buildFacetParamsGender() {
  return [
    "analytics=false",
    "clickAnalytics=false",
    "distinct=true",
    'facetFilters=[["activities:competition","activities:marathon","activities:road_running","activities:track_and_field","activities:trail_running"],["productType:shoes"],["tags:classics"]]',
    "facets=genderFilter",
    "filters=NOT productUrl:NULL AND NOT imageUrl:NULL AND NOT groupingKey:NULL AND stores.us.isVisible:true AND stores.us.isHiddenFromSearch:false AND NOT tags:exclude_from_plp AND stores.us.discountPercentage > 0 AND NOT tags:lost_and_found",
    "highlightPostTag=__/ais-highlight__",
    "highlightPreTag=__ais-highlight__",
    "hitsPerPage=0",
    "maxValuesPerFacet=50",
    "page=0",
    "userToken=xxxxxxxx",
  ].join("&");
}

function buildFacetParamsProductType() {
  return [
    "analytics=false",
    "clickAnalytics=false",
    "distinct=true",
    'facetFilters=[["activities:competition","activities:marathon","activities:road_running","activities:track_and_field","activities:trail_running"],["genderFilter:mens","genderFilter:womens"],["tags:classics"]]',
    "facets=productType",
    "filters=NOT productUrl:NULL AND NOT imageUrl:NULL AND NOT groupingKey:NULL AND stores.us.isVisible:true AND stores.us.isHiddenFromSearch:false AND NOT tags:exclude_from_plp AND stores.us.discountPercentage > 0 AND NOT tags:lost_and_found",
    "highlightPostTag=__/ais-highlight__",
    "highlightPreTag=__ais-highlight__",
    "hitsPerPage=0",
    "maxValuesPerFacet=50",
    "page=0",
    "userToken=xxxxxxxx",
  ].join("&");
}

function buildFacetParamsTags() {
  return [
    "analytics=false",
    "clickAnalytics=false",
    "distinct=true",
    'facetFilters=[["activities:competition","activities:marathon","activities:road_running","activities:track_and_field","activities:trail_running"],["genderFilter:mens","genderFilter:womens"],["productType:shoes"]]',
    "facets=tags",
    "filters=NOT productUrl:NULL AND NOT imageUrl:NULL AND NOT groupingKey:NULL AND stores.us.isVisible:true AND stores.us.isHiddenFromSearch:false AND NOT tags:exclude_from_plp AND (NOT tags:classics OR stores.us.discountPercentage:0) AND NOT tags:lost_and_found",
    "highlightPostTag=__/ais-highlight__",
    "highlightPreTag=__ais-highlight__",
    "hitsPerPage=0",
    "maxValuesPerFacet=50",
    "page=0",
    "userToken=xxxxxxxx",
  ].join("&");
}

function buildRequestBody(page) {
  return {
    requests: [
      {
        indexName: "US_products_production_v3",
        params: buildMainParams(page),
      },
      {
        indexName: "US_products_production_v3",
        params: buildFacetParamsActivities(),
      },
      {
        indexName: "US_products_production_v3",
        params: buildFacetParamsGender(),
      },
      {
        indexName: "US_products_production_v3",
        params: buildFacetParamsProductType(),
      },
      {
        indexName: "US_products_production_v3",
        params: buildFacetParamsTags(),
      },
    ],
  };
}

async function fetchAlgoliaPage(page) {
  const resp = await fetch(ALGOLIA_URL, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://www.on.com",
      referer: "https://www.on.com/",
      "user-agent": "Mozilla/5.0",
    },
    body: JSON.stringify(buildRequestBody(page)),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Algolia HTTP ${resp.status}${text ? ` - ${text.slice(0, 300)}` : ""}`);
  }

  return resp.json();
}

function pushDropped(droppedDealsSample, entry) {
  if (droppedDealsSample.length < MAX_DROPPED_LOG) {
    droppedDealsSample.push(entry);
  }
}

function summarizeHit(hit) {
  return {
    name: hit?.name || null,
    gender: hit?.gender || null,
    productSubtype: hit?.productSubtype || null,
    productSubtypes: Array.isArray(hit?.productSubtypes) ? hit.productSubtypes : [],
    productUrl: hit?.productUrl || null,
    imageUrl: hit?.imageUrl || hit?.firstGalleryImageUrl || null,
    price: hit?.stores?.us?.price ?? null,
    basePrice: hit?.stores?.us?.basePrice ?? null,
    discountPercentage: hit?.stores?.us?.discountPercentage ?? null,
    objectID: hit?.objectID || null,
  };
}

function normalizeDeal(hit, dropCounts, droppedDealsSample) {
  const listingName = hit?.name ?? null;
  const brand = "On";
  const model = hit?.name ?? null;
  const salePrice = toNumber(hit?.stores?.us?.price);
  const originalPrice = toNumber(hit?.stores?.us?.basePrice);
  const apiDiscountPercent = toNumber(hit?.stores?.us?.discountPercentage);
  const listingURL = absUrl(hit?.productUrl);
  const imageURL = hit?.imageUrl || hit?.firstGalleryImageUrl || null;
  const gender = mapGender(hit?.gender);
  const shoeType = mapShoeType(hit?.productSubtype, hit?.productSubtypes);

  if (!listingName) {
    dropCounts.dropped_missingListingName++;
    pushDropped(droppedDealsSample, {
      reason: "missingListingName",
      hit: summarizeHit(hit),
    });
    return null;
  }

  if (!listingURL) {
    dropCounts.dropped_missingListingURL++;
    pushDropped(droppedDealsSample, {
      reason: "missingListingURL",
      hit: summarizeHit(hit),
    });
    return null;
  }

  if (!imageURL) {
    dropCounts.dropped_missingImageURL++;
    pushDropped(droppedDealsSample, {
      reason: "missingImageURL",
      hit: summarizeHit(hit),
    });
    return null;
  }

  if (salePrice === null) {
    dropCounts.dropped_missingSalePrice++;
    pushDropped(droppedDealsSample, {
      reason: "missingSalePrice",
      hit: summarizeHit(hit),
    });
    return null;
  }

  if (originalPrice === null) {
    dropCounts.dropped_missingOriginalPrice++;
    pushDropped(droppedDealsSample, {
      reason: "missingOriginalPrice",
      hit: summarizeHit(hit),
    });
    return null;
  }

  if (!(salePrice < originalPrice)) {
    dropCounts.dropped_saleNotLessThanOriginal++;
    pushDropped(droppedDealsSample, {
      reason: "saleNotLessThanOriginal",
      hit: summarizeHit(hit),
    });
    return null;
  }

  const computedDiscountPercent = exactDiscountPercent(salePrice, originalPrice);
  if (computedDiscountPercent === null) {
    dropCounts.dropped_invalidDiscountPercent++;
    pushDropped(droppedDealsSample, {
      reason: "invalidDiscountPercent",
      hit: summarizeHit(hit),
    });
    return null;
  }

  // Keep exact schema. No range fields here because this API gives single prices.
  return {
    listingName,
    brand,
    model,
    salePrice,
    originalPrice,
    discountPercent: computedDiscountPercent,
    store: STORE,
    listingURL,
    imageURL,
    gender,
    shoeType,
  };
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    if (REQUIRE_CRON_SECRET) {
      const auth = req.headers.authorization;
      if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
        });
      }
    }

    const dropCounts = {
      totalHits: 0,
      dropped_missingListingName: 0,
      dropped_missingListingURL: 0,
      dropped_missingImageURL: 0,
      dropped_missingSalePrice: 0,
      dropped_missingOriginalPrice: 0,
      dropped_saleNotLessThanOriginal: 0,
      dropped_invalidDiscountPercent: 0,
      dropped_duplicateAfterMerge: 0,
    };

    const droppedDealsSample = [];
    const deals = [];
    const seenUrls = new Set();

    let pagesFetched = 0;
    let totalNbHits = null;
    let nbPages = 1;

    for (let page = 0; page < Math.min(nbPages, MAX_PAGES); page++) {
      const json = await fetchAlgoliaPage(page);
      const main = json?.results?.[0];

      if (!main || !Array.isArray(main.hits)) {
        throw new Error(`Unexpected Algolia response shape on page ${page}`);
      }

      pagesFetched++;
      if (page === 0) {
        totalNbHits = toNumber(main.nbHits);
        nbPages = Math.max(1, toNumber(main.nbPages) || 1);
      }

      for (const hit of main.hits) {
        dropCounts.totalHits++;

        const deal = normalizeDeal(hit, dropCounts, droppedDealsSample);
        if (!deal) continue;

        if (seenUrls.has(deal.listingURL)) {
          dropCounts.dropped_duplicateAfterMerge++;
          pushDropped(droppedDealsSample, {
            reason: "duplicateAfterMerge",
            hit: summarizeHit(hit),
          });
          continue;
        }

        seenUrls.add(deal.listingURL);
        deals.push(deal);
      }
    }

    const body = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,
      sourceUrls: [SOURCE_URL, ALGOLIA_URL],
      pagesFetched,
      dealsFound: totalNbHits ?? deals.length,
      dealsExtracted: deals.length,
      scrapeDurationMs: Date.now() - startedAt,
      ok: true,
      error: null,
      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      droppedDealsSample,
      deals,
    };

    const blob = await put(BLOB_PATH, JSON.stringify(body, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobUrl: blob.url,
      dealsFound: body.dealsFound,
      dealsExtracted: body.dealsExtracted,
      pagesFetched: body.pagesFetched,
      dropCounts: body.dropCounts,
      droppedDealsLogged: body.droppedDealsLogged,
      scrapeDurationMs: body.scrapeDurationMs,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: error?.message || "Unknown error",
      scrapeDurationMs: Date.now() - startedAt,
    });
  }
}
