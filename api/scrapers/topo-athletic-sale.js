// /api/scrapers/topo-athletic-sale.js
//
// Topo Athletic sale scraper
// - Scrapes exactly 2 sale roots:
//   1) https://www.topoathletic.com/women/womens-shoes/promo/Sale
//   2) https://www.topoathletic.com/men/mens-shoes/promo/Sale
//
// - Uses Topo's items API with pagination (limit=24 / offset=N)
// - Both women and men use c=3583691, separated by commercecategoryurl + referer
//
// YOUR RULES:
// - Brand is always "Topo Athletic"
// - model = listingName
//
// Gender:
// - "Men", "Men's", "Mens"       -> "mens"
// - "Women", "Women's", "Womens" -> "womens"
// - "Unisex"                     -> "unisex"
// - otherwise                    -> "unknown"
//
// shoeType:
// - if the line says Road  -> "road"
// - if the line says Trail -> "trail"
// - otherwise              -> "unknown"
//
// This scraper infers shoeType from:
// - custitem_collection
// - custitem_bestfor_activity
//
// PRICING / HONESTY RULES:
// - Include deal only if BOTH sale and original price exist
// - discountPercent is exact only for exact prices
// - range fields remain null for this store unless later needed
//
// METADATA INCLUDED:
// - dropCounts
// - droppedDealsSample
// - pageSummaries
//
// ENV:
// - BLOB_READ_WRITE_TOKEN
//
// TEST:
// - /api/scrapers/topo-athletic-sale
//
// CRON auth included but commented out for testing.

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Topo Athletic";
const SCHEMA_VERSION = 1;
const VIA = "topo-items-api";
const BASE = "https://www.topoathletic.com";
const API_BASE = `${BASE}/api/cacheable/items`;

const ROOTS = [
  {
    key: "women",
    pageUrl: `${BASE}/women/womens-shoes/promo/Sale`,
    commerceCategoryUrl: "/women/womens-shoes",
    categoryId: "3583691",
  },
  {
    key: "men",
    pageUrl: `${BASE}/men/mens-shoes/promo/Sale`,
    commerceCategoryUrl: "/men/mens-shoes",
    categoryId: "3583691",
  },
];

const PAGE_LIMIT = 24;
const MAX_PAGES_PER_ROOT = 10;
const MAX_DROPPED_SAMPLE = 200;

export default async function handler(req, res) {
  const startedAt = Date.now();

  // CRON auth (temporarily commented out for testing)
  
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  

  const sourceUrls = [];
  const deals = [];
  const seen = new Set();

  const dropCounts = {
    totalCards: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_invalidDiscountPercent: 0,
    dropped_duplicateAfterMerge: 0,
    dropped_parseError: 0,
  };

  const droppedDealsSample = [];
  const pageSummaries = [];

  let pagesFetched = 0;
  let dealsFound = 0;

  try {
    for (const root of ROOTS) {
      let offset = 0;
      let pageNumber = 1;

      while (pageNumber <= MAX_PAGES_PER_ROOT) {
        const apiUrl = buildApiUrl({
          categoryId: root.categoryId,
          commerceCategoryUrl: root.commerceCategoryUrl,
          offset,
          limit: PAGE_LIMIT,
        });

        sourceUrls.push(apiUrl);

        const resp = await fetch(apiUrl, {
          headers: buildHeaders(root.pageUrl),
        });

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} for ${apiUrl}`);
        }

        const json = await resp.json();
        const items = Array.isArray(json?.items) ? json.items : [];

        const summary = {
          root: root.key,
          pageUrl: root.pageUrl,
          apiUrl,
          categoryId: root.categoryId,
          pageNumber,
          offset,
          cardsFound: items.length,
          cardsAccepted: 0,
          dropReasons: {},
          stopReason: null,
        };

        pagesFetched += 1;

        if (!items.length) {
          summary.stopReason = "no_items_returned";
          pageSummaries.push(summary);
          break;
        }

        dealsFound += items.length;

        for (const item of items) {
          dropCounts.totalCards += 1;

          const normalized = normalizeItem(item);

          if (!normalized.ok) {
            incrementDrop(dropCounts, summary, normalized.reason);
            pushDroppedSample(droppedDealsSample, normalized.sample);
            continue;
          }

          const deal = normalized.deal;
          const dedupeKey = deal.listingURL;

          if (seen.has(dedupeKey)) {
            incrementDrop(dropCounts, summary, "dropped_duplicateAfterMerge");
            pushDroppedSample(droppedDealsSample, {
              reason: "dropped_duplicateAfterMerge",
              listingName: deal.listingName,
              listingURL: deal.listingURL,
            });
            continue;
          }

          seen.add(dedupeKey);
          deals.push(deal);
          summary.cardsAccepted += 1;
        }

        if (items.length < PAGE_LIMIT) {
          summary.stopReason = "short_page";
          pageSummaries.push(summary);
          break;
        }

        pageSummaries.push(summary);
        pageNumber += 1;
        offset += PAGE_LIMIT;
      }
    }

    const body = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      droppedDealsSample,
      pageSummaries,

      deals,
    };

    const blob = await put("topo-athletic-sale.json", JSON.stringify(body, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobUrl: blob.url,
      pagesFetched,
      dealsFound,
      dealsExtracted: deals.length,
      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      pageSummaries,
      scrapeDurationMs: body.scrapeDurationMs,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: error instanceof Error ? error.message : String(error),
      pagesFetched,
      dealsFound,
      dealsExtracted: deals.length,
      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      droppedDealsSample,
      pageSummaries,
      scrapeDurationMs: Date.now() - startedAt,
    });
  }
}

function buildHeaders(referer) {
  return {
    accept: "application/json, text/javascript, */*; q=0.01",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    "x-requested-with": "XMLHttpRequest",
    "x-sc-touchpoint": "shopping",
  };
}

function buildApiUrl({ categoryId, commerceCategoryUrl, offset, limit }) {
  const url = new URL(API_BASE);
  url.searchParams.set("c", String(categoryId));
  url.searchParams.set("commercecategoryurl", commerceCategoryUrl);
  url.searchParams.set("country", "US");
  url.searchParams.set("currency", "USD");
  url.searchParams.set("fieldset", "search");
  url.searchParams.set("include", "facets");
  url.searchParams.set("language", "en");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("matrixchilditems_fieldset", "matrixchilditems_search");
  url.searchParams.set("n", "3");
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("pricelevel", "5");
  url.searchParams.set("promo", "Sale");
  url.searchParams.set("sort", "custitem_sg_best_seller_sorting:asc");
  url.searchParams.set("use_pcv", "F");
  return url.toString();
}

function normalizeItem(item) {
  try {
    const listingName = cleanText(
      item?.displayname ||
        item?.storedisplayname ||
        item?.name ||
        item?.itemid ||
        null
    );

    if (!listingName) {
      return fail("dropped_missingListingName", {
        reason: "dropped_missingListingName",
        itemid: item?.itemid || null,
      });
    }

    const listingURL = normalizeListingUrl(
      item?.urlcomponent ||
        item?.url ||
        item?.urlfragment ||
        null
    );

    if (!listingURL) {
      return fail("dropped_missingListingURL", {
        reason: "dropped_missingListingURL",
        itemid: item?.itemid || null,
        listingName,
        rawUrl: item?.urlcomponent || item?.url || null,
      });
    }

    const imageURL = buildTopoImageUrl(item);

    if (!imageURL) {
      return fail("dropped_missingImageURL", {
        reason: "dropped_missingImageURL",
        itemid: item?.itemid || null,
        listingName,
        listingURL,
        rawColorTopLevel: item?.custitem_sca_shoe_colors ?? null,
        rawColorMatrixFirst:
          Array.isArray(item?.matrixchilditems_detail) && item.matrixchilditems_detail[0]
            ? item.matrixchilditems_detail[0]?.custitem_sca_shoe_colors ?? null
            : null,
      });
    }

    const salePrice = pickSalePrice(item);
    const originalPrice = pickOriginalPrice(item);

    if (!isNum(salePrice)) {
      return fail("dropped_missingSalePrice", {
        reason: "dropped_missingSalePrice",
        itemid: item?.itemid || null,
        listingName,
        listingURL,
        rawSalePrice: {
          onlinecustomerprice_detail: item?.onlinecustomerprice_detail || null,
          pricelevel5: item?.pricelevel5 ?? null,
        },
      });
    }

    if (!isNum(originalPrice)) {
      return fail("dropped_missingOriginalPrice", {
        reason: "dropped_missingOriginalPrice",
        itemid: item?.itemid || null,
        listingName,
        listingURL,
        rawOriginalPrice: item?.custitem_sca_original_price ?? null,
      });
    }

    if (!(salePrice < originalPrice)) {
      return fail("dropped_saleNotLessThanOriginal", {
        reason: "dropped_saleNotLessThanOriginal",
        itemid: item?.itemid || null,
        listingName,
        listingURL,
        salePrice,
        originalPrice,
      });
    }

    const discountPercent = roundPct(((originalPrice - salePrice) / originalPrice) * 100);

    if (!isNum(discountPercent)) {
      return fail("dropped_invalidDiscountPercent", {
        reason: "dropped_invalidDiscountPercent",
        itemid: item?.itemid || null,
        listingName,
        listingURL,
        salePrice,
        originalPrice,
      });
    }

    const gender = parseGender(
      item?.custitem_gender ||
        item?.gender ||
        ""
    );

    const shoeType = parseShoeType(item);

    return {
      ok: true,
      deal: {
        schemaVersion: SCHEMA_VERSION,

        listingName,
        brand: "Topo Athletic",
        // Topo API prefixes models with gender codes like "M-" and "W-"
// Example: "M-Phantom 3", "W-Pursuit 2"
// The storefront HTML does NOT show these prefixes.
// We keep listingName untouched (raw source truth) but normalize
// the model field so canonical brand/model matching works correctly.
model: stripTopoModelPrefix(listingName),

        salePrice,
        originalPrice,
        discountPercent,

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
      },
    };
  } catch (error) {
    return fail("dropped_parseError", {
      reason: "dropped_parseError",
      itemid: item?.itemid || null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function pickSalePrice(item) {
  const direct = toNumber(item?.onlinecustomerprice_detail?.onlinecustomerprice);
  if (isNum(direct)) return direct;

  const fallback = toNumber(item?.pricelevel5);
  if (isNum(fallback)) return fallback;

  const matrix = Array.isArray(item?.matrixchilditems_detail) ? item.matrixchilditems_detail : [];
  for (const child of matrix) {
    const n =
      toNumber(child?.onlinecustomerprice_detail?.onlinecustomerprice) ??
      toNumber(child?.pricelevel5);
    if (isNum(n)) return n;
  }

  return null;
}

function pickOriginalPrice(item) {
  const direct = toNumber(item?.custitem_sca_original_price);
  if (isNum(direct)) return direct;

  const matrix = Array.isArray(item?.matrixchilditems_detail) ? item.matrixchilditems_detail : [];
  for (const child of matrix) {
    const n =
      toNumber(child?.custitem_sca_original_price) ??
      toNumber(child?.compareprice) ??
      toNumber(child?.originalprice);
    if (isNum(n)) return n;
  }

  return null;
}

function buildTopoImageUrl(item) {
  const code = cleanText(item?.itemid);
  if (!code) return null;

  const color =
    firstTopoColor(item?.custitem_sca_shoe_colors) ||
    firstMatrixTopoColor(item?.matrixchilditems_detail) ||
    null;

  if (!color) return null;

  return `${BASE}/sca-product-images/${code}.${topoImageColorSlug(color)}_00.jpg`;
}

function firstTopoColor(value) {
  const s = cleanText(value);
  if (!s) return null;

  return (
    s
      .split(",")
      .map((x) => cleanText(x))
      .filter(Boolean)[0] || null
  );
}

function firstMatrixTopoColor(matrix) {
  if (!Array.isArray(matrix)) return null;

  for (const child of matrix) {
    const c = cleanText(child?.custitem_sca_shoe_colors);
    if (c) return c;
  }

  return null;
}

function topoImageColorSlug(color) {
  const s = cleanText(color);
  if (!s) return null;

  return s
    .split("-")
    .map((part) => cleanText(part).replace(/\s+/g, ""))
    .filter(Boolean)
    .join("-");
}

function parseGender(raw) {
  const s = cleanText(raw).toLowerCase();

  if (s.includes("men's") || s.includes("mens") || s === "men") return "mens";
  if (s.includes("women's") || s.includes("womens") || s === "women") return "womens";
  if (s.includes("unisex")) return "unisex";
  return "unknown";
}

function parseShoeType(item) {
  const text = [
    cleanText(item?.custitem_collection),
    cleanText(item?.custitem_bestfor_activity),
    `${cleanText(item?.custitem_gender)} ${cleanText(item?.custitem_collection)}`.trim(),
  ]
    .filter(Boolean)
    .join(" | ")
    .toLowerCase();

  if (text.includes("road")) return "road";
  if (text.includes("trail")) return "trail";
  if (text.includes("track") || text.includes("spike")) return "track";
  return "unknown";
}

function normalizeListingUrl(rawUrl) {
  const s = cleanText(rawUrl);
  if (!s) return null;

  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return `${BASE}${s}`;
  return `${BASE}/${s}`;
}

function incrementDrop(dropCounts, summary, key) {
  dropCounts[key] = (dropCounts[key] || 0) + 1;
  summary.dropReasons[key] = (summary.dropReasons[key] || 0) + 1;
}

function pushDroppedSample(arr, sample) {
  if (arr.length >= MAX_DROPPED_SAMPLE) return;
  arr.push(sample);
}

function fail(reason, sample) {
  return {
    ok: false,
    reason,
    sample,
  };
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.]/g, "").trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function roundPct(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}
function stripTopoModelPrefix(value) {
  const s = cleanText(value);
  if (!s) return "";

  // Remove leading "M-" or "W-" used in Topo's internal catalog naming
  // but not shown on the storefront product name.
  return s.replace(/^(M|W)-\s*/i, "").trim();
}
