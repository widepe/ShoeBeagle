// /api/scrapers/sportsbasement.js

const { put } = require("@vercel/blob");

const STORE = "Sports Basement";
const SCHEMA_VERSION = 1;
const VIA = "algolia";

const SEARCH_TERM = "shoes deals";
const ACTIVITY = "Running";

// Fetch enough pages to cover the full result set.
// 136 results / 48 per page = 3 pages.
const MAX_PAGES = 5;
const HITS_PER_PAGE = 48;

module.exports.config = { maxDuration: 60 };

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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
    !Number.isFinite(original) ||
    typeof sale !== "number" ||
    !Number.isFinite(sale) ||
    original <= 0 ||
    sale >= original
  ) {
    return null;
  }
  return Math.round(((original - sale) / original) * 100);
}

function toAbsUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/")) return `https://www.sportsbasement.com${s}`;
  return `https://www.sportsbasement.com/${s.replace(/^\/+/, "")}`;
}

function getProductText(hit) {
  return cleanText(
    [
      hit?.title,
      hit?.body_html_safe,
      hit?.vendor,
      hit?.product_type,
      Array.isArray(hit?.tags) ? hit.tags.join(" ") : "",
      hit?.option1,
      hit?.option2,
      hit?.option3,
      hit?.handle,
      hit?.named_tags ? JSON.stringify(hit.named_tags) : "",
    ].join(" ")
  );
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
    "see final price in cart",
    "see final price in bag",
  ];

  return patterns.some((p) => t.includes(p));
}

function inferGender(hit) {
  const tags = [
    ...(Array.isArray(hit?.tags) ? hit.tags : []),
    ...(Array.isArray(hit?.named_tags_names) ? hit.named_tags_names : []),
  ].map((x) => lower(x));

  const joined = [
    lower(hit?.named_tags?.["Gender/Age"]),
    lower(hit?.title),
    lower(hit?.handle),
    lower(getProductText(hit)),
    ...tags,
  ].join(" | ");

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

  if (joined.includes("unisex")) return "unisex";
  return "unknown";
}

function inferShoeType(hit) {
  const bestUse = lower(hit?.named_tags?.["Best Use"]);

  if (bestUse.includes("trail")) return "trail";
  if (bestUse.includes("track")) return "track";
  if (bestUse.includes("road")) return "road";

  return "unknown";
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

function buildListingUrl(hit) {
  if (!hit?.handle) return null;
  return `https://www.sportsbasement.com/products/${hit.handle}`;
}

function pickImage(hit) {
  return toAbsUrl(hit?.image || hit?.product_image || null);
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

function buildSourceUrl(page1Based) {
  const url = new URL("https://www.sportsbasement.com/search");
  url.searchParams.set("q", SEARCH_TERM);
  url.searchParams.set("page", String(page1Based));
  url.searchParams.set("refinementList[named_tags.Activity][0]", ACTIVITY);
  return url.toString();
}

async function fetchAlgoliaHits({ page0Based }) {
  const appId = process.env.SPORTSBASEMENT_ALGOLIA_APP_ID || "04IE0383AT";
  const apiKey =
    process.env.SPORTSBASEMENT_ALGOLIA_API_KEY || "9ed10129c47364d3d9a37b6d381261b4";
  const indexName = process.env.SPORTSBASEMENT_ALGOLIA_INDEX_NAME || "products";

  const endpoint = `https://${appId}-dsn.algolia.net/1/indexes/*/queries`;

  const params = new URLSearchParams({
    query: SEARCH_TERM,
    page: String(page0Based),
    hitsPerPage: String(HITS_PER_PAGE),
    clickAnalytics: "false",
    facets: JSON.stringify([
      "named_tags.Activity",
      "named_tags.Gender/Age",
      "named_tags.Best Use",
      "vendor",
      "tags",
    ]),
    facetFilters: JSON.stringify([["named_tags.Activity:Running"]]),
  }).toString();

  const body = {
    requests: [
      {
        indexName,
        params,
      },
    ],
  };

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-algolia-application-id": appId,
      "x-algolia-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Algolia request failed: ${r.status} ${r.statusText} ${text}`);
  }

  const payload = await r.json();
  const result = payload?.results?.[0];
  const hits = Array.isArray(result?.hits) ? result.hits : [];
  const nbPages = Number.isFinite(result?.nbPages) ? result.nbPages : null;
  const nbHits = Number.isFinite(result?.nbHits) ? result.nbHits : null;

  return { hits, nbPages, nbHits };
}

module.exports = async function handler(req, res) {
  const started = Date.now();

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
    dropped_missingListingName: 0,
    dropped_missingBrand: 0,
    dropped_missingModel: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_duplicate: 0,
  };

  const droppedReasonCounts = {};
  const droppedReasonStores = {};
  const seen = new Set();

  let pagesFetched = 0;
  let dealsFound = 0;
  let reportedNbHits = null;

  let dealsForMens = 0;
  let dealsForWomens = 0;
  let dealsForUnisex = 0;
  let dealsForUnknown = 0;

  try {
    for (let page1 = 1; page1 <= MAX_PAGES; page1++) {
      const page0 = page1 - 1;
      const sourceUrl = buildSourceUrl(page1);
      sourceUrls.push(sourceUrl);

      const { hits, nbHits, nbPages } = await fetchAlgoliaHits({ page0Based: page0 });
      pagesFetched += 1;

      if (page1 === 1 && Number.isFinite(nbHits)) {
        reportedNbHits = nbHits;
        dealsFound = nbHits;
      }

      if (!hits.length) {
        pageSummaries.push({
          page: page1,
          url: sourceUrl,
          hitsReturned: 0,
          dealsExtracted: 0,
          droppedDeals: 0,
          genderCounts: { mens: 0, womens: 0, unisex: 0, unknown: 0 },
          dropCounts: {},
        });
        break;
      }

      const pageDropCounts = {};
      let pageExtracted = 0;
      const pageGenderCounts = { mens: 0, womens: 0, unisex: 0, unknown: 0 };

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

        if (isHiddenPriceText(rawText)) {
          increment(dropCounts, "dropped_hiddenPrice");
          increment(pageDropCounts, "dropped_hiddenPrice");
          increment(droppedReasonCounts, "hidden_price");
          addStoreToDropReasonStoreMap(droppedReasonStores, "hidden_price", STORE);
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
          addStoreToDropReasonStoreMap(droppedReasonStores, "sale_not_less_than_original", STORE);
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

      const droppedDeals = Object.values(pageDropCounts).reduce((sum, value) => sum + value, 0);

      pageSummaries.push({
        page: page1,
        url: sourceUrl,
        hitsReturned: hits.length,
        dealsExtracted: pageExtracted,
        droppedDeals,
        genderCounts: pageGenderCounts,
        dropCounts: pageDropCounts,
      });

      if (Number.isFinite(nbPages) && page1 >= nbPages) {
        break;
      }
    }

    const out = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,
      sourceUrls,
      pagesFetched,
      dealsFound,
      reportedNbHits,
      dealsExtracted: deals.length,
      dealsForMens,
      dealsForWomens,
      dealsForUnisex,
      dealsForUnknown,
      scrapeDurationMs: Date.now() - started,
      ok: true,
      error: null,
      dropCounts,
      droppedReasons: buildDropSummaryWithStores(droppedReasonCounts, droppedReasonStores),
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
      reportedNbHits: out.reportedNbHits,
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
    console.error(`[${STORE}] SCRAPER ERROR`, err);

    return res.status(500).json({
      success: false,
      store: STORE,
      error: err?.message || String(err),
      stack: err?.stack || null,
      scrapeDurationMs: Date.now() - started,
      pagesFetched,
      sourceUrls,
      pageSummaries,
      dropCounts,
    });
  }
};
