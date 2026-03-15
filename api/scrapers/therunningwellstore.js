// /api/scrapers/therunningwellstore.js
//
// The Running Well Store sale running shoes scraper
// - Uses Shopify collection JSON endpoint directly
// - Scrapes collection: /collections/all-footwear?sale=true
// - Fetches paginated products.json from the collection
// - Keeps ONLY discounted deals: originalPrice > salePrice
// - Skips hidden-price / unavailable-price cases
// - Returns summary-only response (NO deals array in API response)
// - Saves full blob with top-level structure + deals array
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//
// TEST:
//   /api/scrapers/therunningwellstore
//
// Notes:
// - CRON auth block is included but commented out for testing
// - shoeType defaults to "unknown" unless tags/categories clearly indicate road/trail/track

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "The Running Well Store";
const SCHEMA_VERSION = 1;
const VIA = "shopify-collection-json";
const BASE = "https://therunningwellstore.com";
const COLLECTION_PATH = "/collections/all-footwear";
const PAGE_SIZE = 250;
const MAX_PAGES = 50;

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[^0-9.-]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normalizeUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, BASE).toString();
  } catch {
    return null;
  }
}

function firstImage(product) {
  if (Array.isArray(product?.images) && product.images.length) {
    const img = product.images[0];
    if (typeof img === "string") return normalizeUrl(img);
    if (img?.src) return normalizeUrl(img.src);
  }
  if (product?.image?.src) return normalizeUrl(product.image.src);
  return null;
}

function inferGender(product) {
  const title = cleanText(product?.title).toLowerCase();
  const type = cleanText(product?.product_type).toLowerCase();
  const tags = Array.isArray(product?.tags)
    ? product.tags.map((t) => cleanText(t).toLowerCase())
    : cleanText(product?.tags)
        .split(",")
        .map((t) => cleanText(t).toLowerCase())
        .filter(Boolean);

  const haystack = [title, type, ...tags].join(" | ");

  if (/\bwomen(?:'s|s)?\b|\bwomens\b/.test(haystack)) return "womens";
  if (/\bmen(?:'s|s)?\b|\bmens\b/.test(haystack)) return "mens";
  if (/\bunisex\b/.test(haystack)) return "unisex";
  return "unknown";
}

function inferShoeType(product) {
  const type = cleanText(product?.product_type).toLowerCase();
  const tags = Array.isArray(product?.tags)
    ? product.tags.map((t) => cleanText(t).toLowerCase())
    : cleanText(product?.tags)
        .split(",")
        .map((t) => cleanText(t).toLowerCase())
        .filter(Boolean);

  const haystack = [type, ...tags].join(" | ");

  if (/\btrail\b/.test(haystack)) return "trail";
  if (/\btrack\b/.test(haystack)) return "track";
  if (/\broad\b/.test(haystack)) return "road";

  return "unknown";
}

function looksLikeRunningShoe(product) {
  const title = cleanText(product?.title).toLowerCase();
  const type = cleanText(product?.product_type).toLowerCase();
  const tags = Array.isArray(product?.tags)
    ? product.tags.map((t) => cleanText(t).toLowerCase())
    : cleanText(product?.tags)
        .split(",")
        .map((t) => cleanText(t).toLowerCase())
        .filter(Boolean);

  const haystack = [title, type, ...tags].join(" | ");

  const hasShoeSignal =
    /\bshoe\b|\bshoes\b|\bfootwear\b|\bsneaker\b|\bsneakers\b/.test(haystack);

  const hasRunningSignal =
    /\brunning\b|\brun\b|\btrainer\b|\btrainers\b|\broad\b|\btrail\b|\btrack\b/.test(haystack);

  // Keep if it clearly looks like footwear and has some running signal.
  return hasShoeSignal || hasRunningSignal;
}

function parseBrand(product) {
  const vendor = cleanText(product?.vendor);
  if (vendor) return vendor;

  const title = cleanText(product?.title);
  const firstWord = title.split(/\s+/)[0] || "";
  return firstWord || null;
}

function parseModel(product, brand, gender) {
  let title = cleanText(product?.title);
  if (!title) return null;

  const escapedBrand = brand
    ? brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : null;

  if (escapedBrand) {
    title = title.replace(new RegExp(`^${escapedBrand}\\s+`, "i"), "");
  }

  title = title
    .replace(/\bmen(?:'s|s)?\b/gi, "")
    .replace(/\bwomen(?:'s|s)?\b/gi, "")
    .replace(/\bunisex\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return title || null;
}

function hasHiddenPriceText(product) {
  const fields = [
    product?.title,
    product?.body_html,
    product?.description,
    product?.published_scope,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /see price in (cart|bag)|add to (cart|bag) to see price|price in cart|price in bag/.test(fields);
}

function makeDropCounts() {
  return {
    totalProductsSeen: 0,
    dropped_nonRunningOrNonShoe: 0,
    dropped_hiddenPrice: 0,
    dropped_missingListingName: 0,
    dropped_missingBrand: 0,
    dropped_missingModel: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_notOnSale: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_duplicateAfterMerge: 0,
    dropped_priceCouldNotParse: 0,
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

function incrementGender(counts, gender) {
  if (gender === "mens") counts.mens += 1;
  else if (gender === "womens") counts.womens += 1;
  else if (gender === "unisex") counts.unisex += 1;
  else counts.unknown += 1;
}

function pickPrices(product) {
  const salePrice =
    toNumber(product?.variants?.[0]?.price) ??
    toNumber(product?.price) ??
    toNumber(product?.price_min);

  const originalPrice =
    toNumber(product?.variants?.[0]?.compare_at_price) ??
    toNumber(product?.compare_at_price) ??
    toNumber(product?.compare_at_price_min);

  return { salePrice, originalPrice };
}

function buildDeal(product) {
  const listingName = cleanText(product?.title);
  const brand = parseBrand(product);
  const gender = inferGender(product);
  const model = parseModel(product, brand, gender);
  const shoeType = inferShoeType(product);

  const { salePrice, originalPrice } = pickPrices(product);

  const listingURL = normalizeUrl(`/products/${product?.handle || ""}`);
  const imageURL = firstImage(product);

  const discountPercent =
    salePrice != null &&
    originalPrice != null &&
    originalPrice > 0 &&
    salePrice < originalPrice
      ? Math.round(((originalPrice - salePrice) / originalPrice) * 100)
      : null;

  return {
    schemaVersion: SCHEMA_VERSION,

    listingName,

    brand,
    model,

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
  };
}

function publicResponse(payload) {
  const {
    deals,
    ...rest
  } = payload;

  return rest;
}

export default async function handler(req, res) {
  const started = Date.now();

  // // CRON_SECRET
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const sourceUrls = [];
  const pageSummaries = [];
  const dropCounts = makeDropCounts();
  const extractedGenderCounts = makeGenderCounts();
  const deals = [];
  const seen = new Set();

  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const sourceUrl = `${BASE}${COLLECTION_PATH}?sale=true&page=${page}`;
      const jsonUrl = `${BASE}${COLLECTION_PATH}/products.json?limit=${PAGE_SIZE}&page=${page}`;

      sourceUrls.push(sourceUrl);

      const resp = await fetch(jsonUrl, {
        headers: {
          "user-agent": "Mozilla/5.0",
          accept: "application/json,text/plain,*/*",
        },
      });

      if (!resp.ok) {
        throw new Error(`products.json request failed for page ${page}: ${resp.status} ${resp.statusText}`);
      }

      const data = await resp.json();
      const products = Array.isArray(data?.products) ? data.products : [];

      if (!products.length) {
        break;
      }

      const pageGenderCounts = makeGenderCounts();
      const pageDropCounts = makeDropCounts();
      let pageDealsFound = products.length;
      let pageDealsExtracted = 0;

      for (const product of products) {
        dropCounts.totalProductsSeen += 1;
        pageDropCounts.totalProductsSeen += 1;

        if (!looksLikeRunningShoe(product)) {
          dropCounts.dropped_nonRunningOrNonShoe += 1;
          pageDropCounts.dropped_nonRunningOrNonShoe += 1;
          continue;
        }

        if (hasHiddenPriceText(product)) {
          dropCounts.dropped_hiddenPrice += 1;
          pageDropCounts.dropped_hiddenPrice += 1;
          continue;
        }

        const deal = buildDeal(product);

        if (!deal.listingName) {
          dropCounts.dropped_missingListingName += 1;
          pageDropCounts.dropped_missingListingName += 1;
          continue;
        }

        if (!deal.brand) {
          dropCounts.dropped_missingBrand += 1;
          pageDropCounts.dropped_missingBrand += 1;
          continue;
        }

        if (!deal.model) {
          dropCounts.dropped_missingModel += 1;
          pageDropCounts.dropped_missingModel += 1;
          continue;
        }

        if (!deal.listingURL) {
          dropCounts.dropped_missingListingURL += 1;
          pageDropCounts.dropped_missingListingURL += 1;
          continue;
        }

        if (!deal.imageURL) {
          dropCounts.dropped_missingImageURL += 1;
          pageDropCounts.dropped_missingImageURL += 1;
          continue;
        }

        if (deal.salePrice == null) {
          dropCounts.dropped_missingSalePrice += 1;
          pageDropCounts.dropped_missingSalePrice += 1;
          continue;
        }

        if (deal.originalPrice == null) {
          dropCounts.dropped_missingOriginalPrice += 1;
          pageDropCounts.dropped_missingOriginalPrice += 1;
          continue;
        }

        if (!Number.isFinite(deal.salePrice) || !Number.isFinite(deal.originalPrice)) {
          dropCounts.dropped_priceCouldNotParse += 1;
          pageDropCounts.dropped_priceCouldNotParse += 1;
          continue;
        }

        if (deal.originalPrice <= deal.salePrice) {
          // equal price = not actually on sale
          if (deal.originalPrice === deal.salePrice) {
            dropCounts.dropped_notOnSale += 1;
            pageDropCounts.dropped_notOnSale += 1;
          } else {
            dropCounts.dropped_saleNotLessThanOriginal += 1;
            pageDropCounts.dropped_saleNotLessThanOriginal += 1;
          }
          continue;
        }

        const dedupeKey = [
          deal.store,
          deal.listingURL,
          deal.salePrice,
          deal.originalPrice,
        ].join("||");

        if (seen.has(dedupeKey)) {
          dropCounts.dropped_duplicateAfterMerge += 1;
          pageDropCounts.dropped_duplicateAfterMerge += 1;
          continue;
        }

        seen.add(dedupeKey);
        deals.push(deal);
        pageDealsExtracted += 1;
        incrementGender(extractedGenderCounts, deal.gender);
        incrementGender(pageGenderCounts, deal.gender);
      }

      pageSummaries.push({
        page,
        sourceUrl,
        jsonUrl,
        productsFound: pageDealsFound,
        dealsExtracted: pageDealsExtracted,
        genderCounts: pageGenderCounts,
        dropCounts: pageDropCounts,
      });

      if (products.length < PAGE_SIZE) {
        break;
      }
    }

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,
      pagesFetched: pageSummaries.length,

      dealsFound: dropCounts.totalProductsSeen,
      dealsExtracted: deals.length,

      dealsForMens: extractedGenderCounts.mens,
      dealsForWomens: extractedGenderCounts.womens,
      dealsForUnisex: extractedGenderCounts.unisex,
      dealsForUnknown: extractedGenderCounts.unknown,

      scrapeDurationMs: Date.now() - started,

      ok: true,
      error: null,

      pageSummaries,
      dropCounts,

      deals,
    };

    const blob = await put("therunningwellstore.json", JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      blobPath: "therunningwellstore.json",
      blobUrl: blob.url,
      ...publicResponse(payload),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,
      sourceUrls,
      pagesFetched: pageSummaries.length,
      dealsFound: dropCounts.totalProductsSeen,
      dealsExtracted: deals.length,
      dealsForMens: extractedGenderCounts.mens,
      dealsForWomens: extractedGenderCounts.womens,
      dealsForUnisex: extractedGenderCounts.unisex,
      dealsForUnknown: extractedGenderCounts.unknown,
      scrapeDurationMs: Date.now() - started,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      pageSummaries,
      dropCounts,
    });
  }
}
