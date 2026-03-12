// /api/scrapers/shoe-carnival.js

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
const RUNNING_CATEGORY_ID = "16";
const WOMENS_RUNNING_ID = "193";
const MENS_RUNNING_ID = "194";

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

function titleContainsWalkingShoes(title) {
  return /\bwalking shoes?\b/i.test(title || "");
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

function hasRunningCategory(hit) {
  const categories = asArray(hit?.categories);

  for (const cat of categories) {
    const id = String(cat?.id || "");
    const name = cleanText(cat?.name);

    if (id === RUNNING_CATEGORY_ID) return true;
    if (/^running shoes$/i.test(name)) return true;
  }

  return false;
}

function isAllowedRunningCategory(hit) {
  if (hasRunningCategory(hit)) return true;

  const primaryId = String(hit?.primary_category_id || "");
  if (primaryId === WOMENS_RUNNING_ID || primaryId === MENS_RUNNING_ID) return true;

  const assigned = asArray(hit?.assignedCategories).map((c) => String(c?.id || ""));
  if (assigned.includes(WOMENS_RUNNING_ID) || assigned.includes(MENS_RUNNING_ID)) return true;
  if (assigned.includes(RUNNING_CATEGORY_ID)) return true;

  return false;
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

  const sale = toNumber(hit?.price?.c_sale_price);
  const standard = toNumber(hit?.price?.c_standard_price);

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

  const noVisiblePrice = !Number.isFinite(sale) && !Number.isFinite(standard);

  return mapRestricted || hiddenLanguage || noVisiblePrice;
}

function getPageUrl(pageNumberHuman) {
  if (pageNumberHuman <= 1) return SEARCH_PAGE_URL;
  return `https://www.shoecarnival.com/search?gender=Women&gender=Men&q=Running%20shoes&page=${pageNumberHuman}&sale=true`;
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

async function fetchAlgoliaPage(page) {
  const body = {
    requests: [
      {
        indexName: ALGOLIA_INDEX,
        clickAnalytics: true,
        analytics: false,
        facetFilters: [["on_sale:true"], ["gender:Women", "gender:Men"]],
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
    throw new Error(`Algolia HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }

  const json = await resp.json();
  const result = json?.results?.[0];

  if (!result) {
    throw new Error("Algolia response missing results[0].");
  }

  return result;
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
    const pageSummaries = [];
    const dropCounts = {};
    const genderCounts = emptyGenderCounts();

    for (let page = 0; page < totalPages; page += 1) {
      const result = page === 0 ? firstPage : await fetchAlgoliaPage(page);
      const hits = asArray(result?.hits);

      const pageNumberHuman = page + 1;
      const pageUrl = getPageUrl(pageNumberHuman);
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

        const dedupeKey = [
          String(hit?.masterStyle || ""),
          String(hit?.url || ""),
        ].join("|||");

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

      pageSummaries.push({
        page: pageNumberHuman,
        url: pageUrl,
        hitsReturned: hits.length,
        dealsExtracted: pageExtracted,
        droppedDeals: Object.values(pageDropCounts).reduce((sum, n) => sum + n, 0),
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
