// /api/scrapers/sportsbasement.js
//
// Sports Basement running shoe deals scraper
//
// What this does:
// - Fetches Sports Basement search result pages for running shoe deals
// - Extracts embedded search JSON from the HTML
// - Keeps only running shoe deals
// - Skips hidden-price tiles / "see price in cart/bag" style listings
// - Writes a clean blob JSON with:
//     top-level metadata
//     deals array
//
// Output shape:
// {
//   store,
//   schemaVersion,
//   lastUpdated,
//   via,
//   sourceUrls,
//   pagesFetched,
//   dealsFound,
//   dealsExtracted,
//   dealsForMens,
//   dealsForWomens,
//   dealsForUnisex,
//   dealsForUnknown,
//   scrapeDurationMs,
//   ok,
//   error,
//   dropCounts,
//   pageSummaries,
//   deals: []
// }
//
// ENV:
// - BLOB_READ_WRITE_TOKEN
//
// TEST:
// /api/scrapers/sportsbasement
//
// NOTES:
// - CRON auth block is included but commented out for testing
// - This scraper assumes the page HTML contains a JSON payload with `results[0].hits`
// - If Sports Basement changes how search data is embedded, only the extractor may need updating

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Sports Basement";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";

const BASE_URL = "https://www.sportsbasement.com/search";
const SEARCH_TERM = "shoes deals";
const ACTIVITY = "Running";

// Set this to however many pages you want to try.
// Scraper stops early if a page has no hits.
const MAX_PAGES = 3;

// -----------------------------
// Helpers
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}

function toAbsUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://www.sportsbasement.com${url}`;
  return `https://www.sportsbasement.com/${url.replace(/^\/+/, "")}`;
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function lower(value) {
  return cleanText(value).toLowerCase();
}

function round2(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function parseNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function discountPct(original, sale) {
  if (
    typeof original !== "number" ||
    typeof sale !== "number" ||
    !Number.isFinite(original) ||
    !Number.isFinite(sale) ||
    original <= 0 ||
    sale >= original
  ) {
    return null;
  }
  return Math.round(((original - sale) / original) * 100);
}

function isHiddenPriceText(text) {
  const t = lower(text);
  if (!t) return false;

  const patterns = [
    "see price in cart",
    "see price in bag",
    "see price at checkout",
    "add to cart to see price",
    "add to bag to see price",
    "add to cart for price",
    "add to bag for price",
    "price in cart",
    "price in bag",
    "hidden price",
    "special price in cart",
    "special price in bag",
  ];

  return patterns.some((p) => t.includes(p));
}

function getProductText(hit) {
  return cleanText([
    hit?.title,
    hit?.body_html_safe,
    hit?.vendor,
    hit?.product_type,
    Array.isArray(hit?.tags) ? hit.tags.join(" ") : "",
    hit?.option1,
    hit?.option2,
    hit?.option3,
  ].join(" "));
}

function inferGender(hit) {
  const tags = [
    ...(Array.isArray(hit?.tags) ? hit.tags : []),
    ...(Array.isArray(hit?.named_tags_names) ? hit.named_tags_names : []),
  ].map((x) => lower(x));

  const genderAge = lower(hit?.named_tags?.["Gender/Age"]);
  const title = lower(hit?.title);
  const handle = lower(hit?.handle);
  const text = lower(getProductText(hit));

  const joined = [genderAge, title, handle, text, ...tags].join(" | ");

  if (
    joined.includes("women's") ||
    joined.includes("womens") ||
    joined.includes("ladies") ||
    joined.includes("female")
  ) {
    return "womens";
  }

  if (
    joined.includes("men's") ||
    joined.includes("mens") ||
    joined.includes("male")
  ) {
    return "mens";
  }

  if (joined.includes("unisex")) {
    return "unisex";
  }

  return "unknown";
}

function inferShoeType(hit) {
  const bestUse = lower(hit?.named_tags?.["Best Use"]);
  const title = lower(hit?.title);
  const handle = lower(hit?.handle);
  const text = lower(getProductText(hit));
  const joined = [bestUse, title, handle, text].join(" | ");

  if (joined.includes("trail")) return "trail";
  if (joined.includes("track spike") || joined.includes("spike")) return "track";
  if (joined.includes("road")) return "road";

  return "unknown";
}

function looksLikeShoe(hit) {
  const productType = lower(hit?.product_type);
  const title = lower(hit?.title);
  const text = lower(getProductText(hit));
  const joined = [productType, title, text].join(" | ");

  if (joined.includes("sock")) return false;
  if (joined.includes("insole")) return false;
  if (joined.includes("sandal")) return false;
  if (joined.includes("slipper")) return false;
  if (joined.includes("boot")) return false;

  const shoeSignals = [
    "shoe",
    "shoes",
    "running",
    "footwear",
    "stability",
    "neutral",
    "trail",
    "road",
    "plated",
    "track spike",
    "spike",
  ];

  return shoeSignals.some((s) => joined.includes(s));
}

function buildListingUrl(hit) {
  if (!hit?.handle) return null;
  return `https://www.sportsbasement.com/products/${hit.handle}`;
}

function pickImage(hit) {
  return toAbsUrl(hit?.image || hit?.product_image || null);
}

function normalizeBrand(vendor) {
  const brand = cleanText(vendor);
  return brand || null;
}

function normalizeModel(title, brand) {
  const t = cleanText(title);
  if (!t) return null;
  if (!brand) return t;

  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}\\s+`, "i");
  return cleanText(t.replace(re, ""));
}

function buildPageUrl(page) {
  const url = new URL(BASE_URL);
  url.searchParams.set("q", SEARCH_TERM);
  url.searchParams.set("page", String(page));
  url.searchParams.set("refinementList[named_tags.Activity][0]", ACTIVITY);
  return url.toString();
}

// Tries several extraction patterns to find the JSON payload that contains `results[0].hits`
function extractSearchJson(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);

  for (const scriptText of scripts) {
    if (!scriptText.includes('"results"') || !scriptText.includes('"hits"')) continue;

    const start = scriptText.indexOf("{");
    const end = scriptText.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) continue;

    const candidate = scriptText.slice(start, end + 1);

    try {
      const parsed = JSON.parse(candidate);
      if (parsed?.results?.[0]?.hits && Array.isArray(parsed.results[0].hits)) {
        return parsed;
      }
    } catch {
      // keep trying
    }
  }

  throw new Error("Could not find embedded results[0].hits JSON in script tags.");
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

function addStoreToDropReasonStoreMap(reasonStoreMap, reason, store) {
  if (!reasonStoreMap[reason]) reasonStoreMap[reason] = {};
  reasonStoreMap[reason][store] = (reasonStoreMap[reason][store] || 0) + 1;
}

function buildDropSummaryWithStores(reasonCounts, reasonStores) {
  const out = {};
  for (const [reason, count] of Object.entries(reasonCounts)) {
    out[reason] = {
      count,
      stores: reasonStores[reason] || {},
    };
  }
  return out;
}

// -----------------------------
// Main handler
// -----------------------------
export default async function handler(req, res) {
  const started = Date.now();

  // TEMPORARILY COMMENTED OUT FOR TESTING
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const sourceUrls = [];
  const pageSummaries = [];
  const deals = [];

  const dropCounts = {
    totalTiles: 0,
    dropped_hiddenPrice: 0,
    dropped_notShoe: 0,
    dropped_missingListingName: 0,
    dropped_missingBrand: 0,
    dropped_missingModel: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_duplicate: 0,
  };

  // Optional richer drop breakdown with store counts
  const droppedReasonCounts = {};
  const droppedReasonStores = {};

  const seen = new Set();

  let pagesFetched = 0;
  let dealsFound = 0;

  let dealsForMens = 0;
  let dealsForWomens = 0;
  let dealsForUnisex = 0;
  let dealsForUnknown = 0;

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const pageUrl = buildPageUrl(page);
      sourceUrls.push(pageUrl);

      const r = await fetch(pageUrl, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml",
        },
        cache: "no-store",
      });

      if (!r.ok) {
        throw new Error(`Fetch failed for page ${page}: ${r.status} ${r.statusText}`);
      }

      const html = await r.text();
      pagesFetched += 1;

      const payload = extractSearchJson(html);
      const hits = Array.isArray(payload?.results?.[0]?.hits)
        ? payload.results[0].hits
        : [];

      if (!hits.length) {
        pageSummaries.push({
          page,
          url: pageUrl,
          hitsReturned: 0,
          dealsExtracted: 0,
          droppedDeals: 0,
          genderCounts: {
            mens: 0,
            womens: 0,
            unisex: 0,
            unknown: 0,
          },
          dropCounts: {},
        });
        break;
      }

      dealsFound += hits.length;

      const pageDropCounts = {};
      let pageExtracted = 0;
      const pageGenderCounts = {
        mens: 0,
        womens: 0,
        unisex: 0,
        unknown: 0,
      };

      for (const hit of hits) {
        dropCounts.totalTiles += 1;

        const rawText = getProductText(hit);
        const title = cleanText(hit?.title);
        const brand = normalizeBrand(hit?.vendor);
        const model = normalizeModel(title, brand);

        const salePrice = round2(parseNumber(hit?.price ?? hit?.variants_min_price));
        const originalPrice = round2(
          parseNumber(
            hit?.compare_at_price ??
              hit?.variants_compare_at_price_min ??
              hit?.variants_compare_at_price_max
          )
        );

        const hiddenPriceSignal = isHiddenPriceText(rawText);

        if (hiddenPriceSignal) {
          increment(dropCounts, "dropped_hiddenPrice");
          increment(pageDropCounts, "dropped_hiddenPrice");
          increment(droppedReasonCounts, "hidden_price");
          addStoreToDropReasonStoreMap(droppedReasonStores, "hidden_price", STORE);
          continue;
        }

        if (!looksLikeShoe(hit)) {
          increment(dropCounts, "dropped_notShoe");
          increment(pageDropCounts, "dropped_notShoe");
          increment(droppedReasonCounts, "not_running_shoe");
          addStoreToDropReasonStoreMap(droppedReasonStores, "not_running_shoe", STORE);
          continue;
        }

        if (!title) {
          increment(dropCounts, "dropped_missingListingName");
          increment(pageDropCounts, "dropped_missingListingName");
          increment(droppedReasonCounts, "missing_listing_name");
          addStoreToDropReasonStoreMap(droppedReasonStores, "missing_listing_name", STORE);
          continue;
        }

        if (!brand || lower(brand) === "unknown") {
          increment(dropCounts, "dropped_missingBrand");
          increment(pageDropCounts, "dropped_missingBrand");
          increment(droppedReasonCounts, "missing_brand");
          addStoreToDropReasonStoreMap(droppedReasonStores, "missing_brand", STORE);
          continue;
        }

        if (!model) {
          increment(dropCounts, "dropped_missingModel");
          increment(pageDropCounts, "dropped_missingModel");
          increment(droppedReasonCounts, "missing_model");
          addStoreToDropReasonStoreMap(droppedReasonStores, "missing_model", STORE);
          continue;
        }

        const listingURL = buildListingUrl(hit);
        if (!listingURL) {
          increment(dropCounts, "dropped_missingListingURL");
          increment(pageDropCounts, "dropped_missingListingURL");
          increment(droppedReasonCounts, "missing_listing_url");
          addStoreToDropReasonStoreMap(droppedReasonStores, "missing_listing_url", STORE);
          continue;
        }

        const imageURL = pickImage(hit);
        if (!imageURL) {
          increment(dropCounts, "dropped_missingImageURL");
          increment(pageDropCounts, "dropped_missingImageURL");
          increment(droppedReasonCounts, "missing_image_url");
          addStoreToDropReasonStoreMap(droppedReasonStores, "missing_image_url", STORE);
          continue;
        }

        if (typeof salePrice !== "number" || !Number.isFinite(salePrice)) {
          increment(dropCounts, "dropped_missingSalePrice");
          increment(pageDropCounts, "dropped_missingSalePrice");
          increment(droppedReasonCounts, "missing_sale_price");
          addStoreToDropReasonStoreMap(droppedReasonStores, "missing_sale_price", STORE);
          continue;
        }

        if (
          typeof originalPrice === "number" &&
          Number.isFinite(originalPrice) &&
          salePrice >= originalPrice
        ) {
          increment(dropCounts, "dropped_saleNotLessThanOriginal");
          increment(pageDropCounts, "dropped_saleNotLessThanOriginal");
          increment(droppedReasonCounts, "sale_not_less_than_original");
          addStoreToDropReasonStoreMap(
            droppedReasonStores,
            "sale_not_less_than_original",
            STORE
          );
          continue;
        }

        const gender = inferGender(hit);
        const shoeType = inferShoeType(hit);

        const deal = {
          schemaVersion: SCHEMA_VERSION,

          listingName: title,

          brand,
          model,

          salePrice,
          originalPrice: originalPrice ?? null,
          discountPercent: discountPct(originalPrice, salePrice),

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

        const dedupeKey = [
          lower(deal.store),
          lower(deal.listingName),
          lower(deal.listingURL),
          lower(deal.gender),
          String(deal.salePrice ?? ""),
        ].join("|");

        if (seen.has(dedupeKey)) {
          increment(dropCounts, "dropped_duplicate");
          increment(pageDropCounts, "dropped_duplicate");
          increment(droppedReasonCounts, "duplicate");
          addStoreToDropReasonStoreMap(droppedReasonStores, "duplicate", STORE);
          continue;
        }

        seen.add(dedupeKey);
        deals.push(deal);
        pageExtracted += 1;

        if (gender === "mens") {
          dealsForMens += 1;
          pageGenderCounts.mens += 1;
        } else if (gender === "womens") {
          dealsForWomens += 1;
          pageGenderCounts.womens += 1;
        } else if (gender === "unisex") {
          dealsForUnisex += 1;
          pageGenderCounts.unisex += 1;
        } else {
          dealsForUnknown += 1;
          pageGenderCounts.unknown += 1;
        }
      }

      const droppedDeals = Object.values(pageDropCounts).reduce((a, b) => a + b, 0);

      pageSummaries.push({
        page,
        url: pageUrl,
        hitsReturned: hits.length,
        dealsExtracted: pageExtracted,
        droppedDeals,
        genderCounts: pageGenderCounts,
        dropCounts: pageDropCounts,
      });
    }

    const out = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,

      pagesFetched,

      dealsFound,
      dealsExtracted: deals.length,

      dealsForMens,
      dealsForWomens,
      dealsForUnisex,
      dealsForUnknown,

      scrapeDurationMs: Date.now() - started,

      ok: true,
      error: null,

      dropCounts,
      droppedReasons: buildDropSummaryWithStores(
        droppedReasonCounts,
        droppedReasonStores
      ),
      pageSummaries,

      deals,
    };

    const blob = await put("sportsbasement.json", JSON.stringify(out, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobPath: "sportsbasement.json",
      blobUrl: blob.url,
      pagesFetched: out.pagesFetched,
      dealsFound: out.dealsFound,
      dealsExtracted: out.dealsExtracted,
      dealsForMens: out.dealsForMens,
      dealsForWomens: out.dealsForWomens,
      dealsForUnisex: out.dealsForUnisex,
      dealsForUnknown: out.dealsForUnknown,
      dropCounts: out.dropCounts,
      droppedReasons: out.droppedReasons,
      pageSummaries: out.pageSummaries,
      scrapeDurationMs: out.scrapeDurationMs,
      ok: true,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: err?.message || String(err),
      scrapeDurationMs: Date.now() - started,
      pagesFetched,
      sourceUrls,
      pageSummaries,
      dropCounts,
    });
  }
}
