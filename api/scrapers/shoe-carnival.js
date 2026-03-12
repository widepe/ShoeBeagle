// /api/scrapers/shoe-carnival.js
//
// Shoe Carnival sale running shoes scraper
// - Uses Shoe Carnival's Algolia search endpoint
// - Scrapes ONLY men's + women's running shoes on sale
// - Drops tiles/cards if:
//   * title contains "walking shoes"
//   * hidden/MAP/restricted price
//   * "see price in cart" / "see price in bag" / "add to bag to see price" style restriction
//   * missing sale price
//   * non-running category slips through
// - shoeType is always "unknown"
// - Writes ONLY top-level fields + deals array to blob
//
// Blob output shape:
// {
//   top-level fields...,
//   deals: [ ... ]
// }
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//
// TEST:
//   /api/scrapers/shoe-carnival
//
// Notes:
// - CRON auth is included below but commented out for testing.
// - This scraper uses category ids:
//     Womens running shoes: 193
//     Mens running shoes:   194

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Shoe Carnival";
const SCHEMA_VERSION = 1;
const VIA = "algolia";
const BLOB_PATH = "shoe-carnival.json";

const SEARCH_PAGE_URL =
  "https://www.shoecarnival.com/search?gender=Women&gender=Men&q=Running%20shoes&sale=true";

const ALGOLIA_APP_ID = "FA677J9QJI";
const ALGOLIA_API_KEY = "23d75c51c43c0ea2995b94bd56048224";
const ALGOLIA_INDEX =
  "production_na02_shoecarnival_demandware_net__shoecarnival__products__default";

const HITS_PER_PAGE = 24;
const WOMENS_RUNNING_ID = "193";
const MENS_RUNNING_ID = "194";

function nowIso() {
  return new Date().toISOString();
}

function asArray(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

function cleanText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function lc(s) {
  return cleanText(s).toLowerCase();
}

function toNumber(v) {
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

function inc(map, key, by = 1) {
  map[key] = (map[key] || 0) + by;
}

function getGenderFromHit(hit) {
  const genders = asArray(hit?.gender).map((g) => lc(g));
  const name = lc(hit?.name);

  if (genders.includes("men") || genders.includes("mens") || name.startsWith("men's ")) {
    return "mens";
  }
  if (genders.includes("women") || genders.includes("womens") || name.startsWith("women's ")) {
    return "womens";
  }
  if (genders.includes("unisex") || name.startsWith("unisex ")) {
    return "unisex";
  }
  return "unknown";
}

function extractImageUrl(hit) {
  const groupImages = asArray(hit?.image_groups)
    .flatMap((g) => asArray(g?.images))
    .map((img) => img?.dis_base_link)
    .filter(Boolean);

  if (groupImages.length) return groupImages[0];

  const flatImages = asArray(hit?.images)
    .map((img) => img?.dis_base_link)
    .filter(Boolean);

  if (flatImages.length) return flatImages[0];

  return null;
}

function makeAbsoluteProductUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `https://www.shoecarnival.com${path.startsWith("/") ? path : `/${path}`}`;
}

function isHiddenPriceHit(hit) {
  const price = hit?.price || {};
  const sale = toNumber(price?.c_sale_price);
  const standard = toNumber(price?.c_standard_price);
  const mapRestricted =
    Boolean(price?.c_map_price_restriction) ||
    Boolean(hit?.c_map_price_restriction);

  const textBlob = lc(
    [
      hit?.name,
      hit?.pageDescription,
      hit?.pageTitle,
      hit?.long_description,
      JSON.stringify(hit?.promotions || []),
    ].join(" ")
  );

  const hasHiddenPriceLanguage =
    /see price in (cart|bag)|add to (cart|bag) to see price|price in cart|price in bag|hidden price|map price/i.test(
      textBlob
    );

  const noVisiblePrice = !Number.isFinite(sale) && !Number.isFinite(standard);

  return mapRestricted || hasHiddenPriceLanguage || noVisiblePrice;
}

function titleContainsWalkingShoes(title) {
  return /\bwalking shoes?\b/i.test(title || "");
}

function isAllowedRunningCategory(hit) {
  const id = String(hit?.primary_category_id || "");
  return id === WOMENS_RUNNING_ID || id === MENS_RUNNING_ID;
}

function buildModel(listingName, brand) {
  let model = cleanText(listingName);
  if (!model) return null;

  model = model.replace(/^(men's|mens|women's|womens|unisex)\s+/i, "");

  if (brand) {
    const brandEscaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    model = model.replace(new RegExp(`^${brandEscaped}\\s+`, "i"), "");
  }

  model = model.replace(/\s+running shoes?$/i, "");
  model = model.replace(/\s+/g, " ").trim();

  return model || null;
}

function emptyGenderCounts() {
  return { mens: 0, womens: 0, unisex: 0, unknown: 0 };
}

function summarizePageUrl(pageNumber) {
  return `https://www.shoecarnival.com/search?gender=Women&gender=Men&q=Running%20shoes&page=${pageNumber}&sale=true`;
}

async function fetchAlgoliaPage(page) {
  const body = {
    requests: [
      {
        indexName: ALGOLIA_INDEX,
        clickAnalytics: false,
        analytics: false,
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
        filters: `on_sale:true AND (primary_category_id:${WOMENS_RUNNING_ID} OR primary_category_id:${MENS_RUNNING_ID})`,
        highlightPreTag: "__ais-highlight__",
        highlightPostTag: "__/ais-highlight__",
        hitsPerPage: HITS_PER_PAGE,
        maxValuesPerFacet: 1000,
        page,
        query: "Running shoes",
      },
    ],
  };

  const url = `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
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
    throw new Error(`Algolia HTTP ${resp.status}: ${text.slice(0, 400)}`);
  }

  const json = await resp.json();
  const result = json?.results?.[0];

  if (!result) {
    throw new Error("Algolia response missing results[0].");
  }

  return result;
}

function mapHitToDeal(hit) {
  const listingName = cleanText(hit?.name);
  const brand = cleanText(hit?.brand || hit?.manufacturerName);
  const listingURL = makeAbsoluteProductUrl(hit?.url);
  const imageURL = extractImageUrl(hit);
  const gender = getGenderFromHit(hit);

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
    listingURL,
    imageURL,
    gender,
    shoeType: "unknown",
  };
}

function validateDeal(deal) {
  if (!deal.listingName) return "missingListingName";
  if (!deal.brand) return "missingBrand";
  if (!deal.listingURL) return "missingListingURL";
  if (!deal.imageURL) return "missingImageURL";
  if (!Number.isFinite(deal.salePrice)) return "missingSalePrice";
  return null;
}

export default async function handler(req, res) {
  const started = Date.now();

  // // CRON_SECRET
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  try {
    const firstPage = await fetchAlgoliaPage(0);
    const totalHits = toNumber(firstPage?.nbHits) || 0;
    const totalPages = toNumber(firstPage?.nbPages) || 0;

    const sourceUrls = [];
    const deals = [];
    const seen = new Set();

    const dropCounts = {};
    const dealsByGender = emptyGenderCounts();
    const pageSummaries = [];

    for (let page = 0; page < totalPages; page += 1) {
      const result = page === 0 ? firstPage : await fetchAlgoliaPage(page);
      const hits = asArray(result?.hits);

      const pageNumberHuman = page + 1;
      const pageUrl = summarizePageUrl(pageNumberHuman);
      sourceUrls.push(pageUrl);

      const pageDropCounts = {};
      const pageGenderCounts = emptyGenderCounts();

      let pageExtracted = 0;

      for (const hit of hits) {
        const title = cleanText(hit?.name);

        if (!isAllowedRunningCategory(hit)) {
          inc(dropCounts, "dropped_nonRunningCategory");
          inc(pageDropCounts, "dropped_nonRunningCategory");
          continue;
        }

        if (titleContainsWalkingShoes(title)) {
          inc(dropCounts, "dropped_walkingShoesOnCard");
          inc(pageDropCounts, "dropped_walkingShoesOnCard");
          continue;
        }

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

        const dedupeKey = `${deal.store}|||${deal.listingURL}|||${deal.listingName}|||${deal.salePrice}`;
        if (seen.has(dedupeKey)) {
          inc(dropCounts, "dropped_duplicate");
          inc(pageDropCounts, "dropped_duplicate");
          continue;
        }
        seen.add(dedupeKey);

        deals.push(deal);
        pageExtracted += 1;
        dealsByGender[deal.gender] = (dealsByGender[deal.gender] || 0) + 1;
        pageGenderCounts[deal.gender] = (pageGenderCounts[deal.gender] || 0) + 1;
      }

      pageSummaries.push({
        page: pageNumberHuman,
        url: pageUrl,
        hitsReturned: hits.length,
        dealsExtracted: pageExtracted,
        dropped: Object.values(pageDropCounts).reduce((a, b) => a + b, 0),
        genderCounts: pageGenderCounts,
        dropCounts: pageDropCounts,
      });
    }

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,
      pagesFetched: sourceUrls.length,

      dealsFound: totalHits,
      dealsExtracted: deals.length,

      dealsForMens: dealsByGender.mens,
      dealsForWomens: dealsByGender.womens,
      dealsForUnisex: dealsByGender.unisex,
      dealsForUnknown: dealsByGender.unknown,

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
