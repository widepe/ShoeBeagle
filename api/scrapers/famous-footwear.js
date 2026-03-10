// /api/scrapers/famous-footwear.js
//
// Famous Footwear running shoes scraper via Coveo Commerce API
//
// Uses the working server-side Coveo POST request you validated.
// Source scope:
// - Men's + Women's
// - Category: Sneakers and Athletic Shoes > Running Shoes
//
// IMPORTANT RULES (per your requirement):
// - listingName is preserved EXACTLY as returned
// - shoeType is always "unknown"
// - gender is mens / womens / unisex / unknown
// - skip all "See Price in Cart" / MAP-policy items
// - skip anything without valid sale + original pricing
// - skip anything where salePrice >= originalPrice
//
// ENV:
// - BLOB_READ_WRITE_TOKEN
// - FAMOUS_FOOTWEAR_COVEO_TOKEN
// - CRON_SECRET (optional)
//
// Blob written:
// - famous-footwear.json

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Famous Footwear";
const SCHEMA_VERSION = 1;
const VIA = "coveo-commerce-api";
const BASE_URL = "https://www.famousfootwear.com";
const API_URL =
  "https://caleresproduction4uzryqju.org.coveo.com/rest/organizations/caleresproduction4uzryqju/commerce/v2/search";
const BLOB_PATH = "famous-footwear.json";
const PER_PAGE = 48;

// Toggle if you want to temporarily bypass CRON auth for testing.
const REQUEST_TOGGLES = {
  REQUIRE_CRON_SECRET: true,
};

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice) || originalPrice <= 0) {
    return null;
  }
  if (salePrice >= originalPrice) return null;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function parseGenderFromName(name) {
  const s = String(name || "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s.includes("women's") || s.includes("womens")) return "womens";
  if (s.includes("men's") || s.includes("mens")) return "mens";
  if (s.includes("unisex")) return "unisex";
  return "unknown";
}

function parseGender(result) {
  const arr = result?.additionalFields?.webgenders;
  if (Array.isArray(arr) && arr.length) {
    const lowered = arr.map((x) => String(x || "").trim().toLowerCase());
    const hasWomen = lowered.some((x) => x.includes("women"));
    const hasMen = lowered.some((x) => x.includes("men"));
    if (hasWomen && hasMen) return "unisex";
    if (hasWomen) return "womens";
    if (hasMen) return "mens";
  }
  return parseGenderFromName(result?.ec_name || result?.additionalFields?.name || "");
}

function extractModel(listingName) {
  let s = String(listingName || "").trim();
  if (!s) return "";

  s = s.replace(/^(men's|mens|women's|womens|unisex)\s+/i, "");
  s = s.replace(/\s+(running\s+shoe|running\s+sneaker|retro\s+sneaker|sneaker|shoe)\s*$/i, "");
  s = s.replace(/\s{2,}/g, " ").trim();

  return s;
}

function isMapSeePriceInCart(result) {
  const af = result?.additionalFields || {};
  const isMapEligible = String(af.ismapeligible || "").toLowerCase() === "true";
  const isMapPolicyCart = String(af.ismappolicycart || "").toLowerCase() === "true";

  // For this site, MAP/cart-policy items are the closest reliable API proxy
  // for "See Price in Cart" tiles.
  return isMapEligible || isMapPolicyCart;
}

function getImageUrl(result) {
  if (Array.isArray(result?.ec_images) && result.ec_images.length) {
    return result.ec_images[0];
  }

  const af = result?.additionalFields || {};
  return (
    af.imagepairmedium ||
    af.imagerightmedium ||
    af.imageleftmedium ||
    af.imagesinglemedium ||
    null
  );
}

function getListingUrl(result) {
  const clickUri = String(result?.clickUri || "").trim();
  if (clickUri) return clickUri;

  const productUri = String(result?.additionalFields?.producturi || "").trim();
  if (!productUri) return null;

  return productUri.startsWith("http") ? productUri : `${BASE_URL}${productUri}`;
}

function isRunningResult(result) {
  const categories = Array.isArray(result?.ec_category)
    ? result.ec_category
    : Array.isArray(result?.additionalFields?.categories)
      ? result.additionalFields.categories
      : [];

  return categories.some((c) => String(c || "").toLowerCase().includes("running shoes"));
}

function buildBody(page) {
  return {
    trackingId: "FamousFootwear",
    clientId:
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `ff-${Date.now()}-${page}`,
    context: {
      user: {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      },
      view: {
        url: "https://www.famousfootwear.com/browse/sale",
        referrer: "https://www.famousfootwear.com/",
      },
      capture: true,
      cart: [],
      source: ["@coveo/headless@3.42.1"],
    },
    language: "en",
    country: "US",
    currency: "USD",
    query: "",
    page,
    perPage: PER_PAGE,
    facets: [
      {
        initialNumberOfValues: 12,
        facetId: "webgenders",
        displayName: "Gender",
        numberOfValues: 12,
        field: "webgenders",
        type: "regular",
        freezeCurrentValues: true,
        preventAutoSelect: true,
        values: [
          { value: "Women's", state: "selected" },
          { value: "Men's", state: "selected" },
        ],
      },
      {
        initialNumberOfValues: 30,
        facetId: "categories",
        displayName: "Category",
        numberOfValues: 30,
        field: "categories",
        type: "hierarchical",
        freezeCurrentValues: false,
        preventAutoSelect: false,
        retrieveCount: 30,
        delimitingCharacter: "|",
        values: [
          { value: "Sandals", state: "idle", children: [] },
          { value: "Boots", state: "idle", children: [] },
          {
            value: "Sneakers and Athletic Shoes",
            state: "idle",
            children: [
              {
                value: "Running Shoes",
                state: "selected",
                children: [
                  { value: "Performance Running", state: "idle", children: [] },
                  { value: "Lifestyle Running", state: "idle", children: [] },
                ],
              },
            ],
          },
          { value: "Heels", state: "idle", children: [] },
          { value: "Loafers and Oxfords", state: "idle", children: [] },
          { value: "Slip On Shoes", state: "idle", children: [] },
          { value: "Flats", state: "idle", children: [] },
          { value: "Work and Safety", state: "idle", children: [] },
          { value: "Clogs and Mules", state: "idle", children: [] },
          { value: "Mary Janes", state: "idle", children: [] },
          { value: "Slippers", state: "idle", children: [] },
          { value: "Socks", state: "idle", children: [] },
          { value: "Boat Shoes", state: "idle", children: [] },
          { value: "Hats and Gloves", state: "idle", children: [] },
          { value: "Bags", state: "idle", children: [] },
          { value: "Hair Accessories", state: "idle", children: [] },
          { value: "Shoe Charms", state: "idle", children: [] },
        ],
      },
    ],
    sort: {
      sortCriteria: "relevance",
    },
    enableResults: true,
  };
}

async function fetchPage(page, token) {
  const body = buildBody(page);

  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      accept: "*/*",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      origin: "https://www.famousfootwear.com",
      referer: "https://www.famousfootwear.com/",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!resp.ok) {
    const msg =
      json?.message ||
      `Famous Footwear Coveo request failed with status ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.responseText = text.slice(0, 3000);
    throw err;
  }

  if (!json) {
    const err = new Error("Famous Footwear Coveo returned non-JSON response");
    err.responseText = text.slice(0, 3000);
    throw err;
  }

  return json;
}

function mapResultToDeal(result) {
  const listingName = String(result?.ec_name || "").trim();
  const brand = String(result?.ec_brand || "").trim();
  const listingURL = getListingUrl(result);
  const imageURL = getImageUrl(result);
  const originalPrice = round2(toNumber(result?.ec_price));
  const salePrice = round2(toNumber(result?.ec_promo_price));
  const gender = parseGender(result);
  const model = extractModel(listingName);
  const discountPercent = computeDiscountPercent(originalPrice, salePrice);

  return {
    listingName,
    brand,
    model,
    salePrice,
    originalPrice,
    discountPercent,
    store: STORE,
    listingURL,
    imageURL,
    gender,
    shoeType: "unknown",
  };
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    // CRON auth
    if (REQUEST_TOGGLES.REQUIRE_CRON_SECRET) {
      const auth = req.headers.authorization;
      if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }
    }

    const token = String(process.env.FAMOUS_FOOTWEAR_COVEO_TOKEN || "").trim();
    if (!token) {
      return res.status(500).json({
        success: false,
        error: "Missing FAMOUS_FOOTWEAR_COVEO_TOKEN",
      });
    }

    const sourceUrls = [
      "https://www.famousfootwear.com/browse/sale?icid=sdd_vwall#sortCriteria=relevance&f-webgenders=Women's,Men's&cf-categories=Sneakers%20and%20Athletic%20Shoes,Running%20Shoes",
    ];

    const deals = [];
    const seen = new Set();

    const dropCounts = {
      totalResults: 0,
      dropped_notRunningCategory: 0,
      dropped_mapOrSeePriceInCart: 0,
      dropped_missingListingName: 0,
      dropped_missingBrand: 0,
      dropped_missingListingURL: 0,
      dropped_missingImageURL: 0,
      dropped_missingOriginalPrice: 0,
      dropped_missingSalePrice: 0,
      dropped_saleNotLessThanOriginal: 0,
      dropped_invalidGender: 0,
      dropped_duplicateAfterMerge: 0,
    };

    let page = 1;
    let totalPages = null;
    let pagesFetched = 0;
    let dealsFound = 0;

    while (true) {
      const json = await fetchPage(page, token);
      pagesFetched += 1;

      const results = Array.isArray(json?.results) ? json.results : [];
      const pagination = json?.pagination || null;

      dealsFound += results.length;
      dropCounts.totalResults += results.length;

      if (pagination && Number.isFinite(Number(pagination.totalPages))) {
        totalPages = Number(pagination.totalPages);
      }

      for (const result of results) {
        if (!isRunningResult(result)) {
          dropCounts.dropped_notRunningCategory += 1;
          continue;
        }

        if (isMapSeePriceInCart(result)) {
          dropCounts.dropped_mapOrSeePriceInCart += 1;
          continue;
        }

        const deal = mapResultToDeal(result);

        if (!deal.listingName) {
          dropCounts.dropped_missingListingName += 1;
          continue;
        }

        if (!deal.brand) {
          dropCounts.dropped_missingBrand += 1;
          continue;
        }

        if (!deal.listingURL) {
          dropCounts.dropped_missingListingURL += 1;
          continue;
        }

        if (!deal.imageURL) {
          dropCounts.dropped_missingImageURL += 1;
          continue;
        }

        if (!Number.isFinite(deal.originalPrice)) {
          dropCounts.dropped_missingOriginalPrice += 1;
          continue;
        }

        if (!Number.isFinite(deal.salePrice)) {
          dropCounts.dropped_missingSalePrice += 1;
          continue;
        }

        if (!(deal.salePrice < deal.originalPrice)) {
          dropCounts.dropped_saleNotLessThanOriginal += 1;
          continue;
        }

        if (!["mens", "womens", "unisex", "unknown"].includes(deal.gender)) {
          dropCounts.dropped_invalidGender += 1;
          continue;
        }

        const dedupeKey = deal.listingURL;
        if (seen.has(dedupeKey)) {
          dropCounts.dropped_duplicateAfterMerge += 1;
          continue;
        }
        seen.add(dedupeKey);

        deals.push(deal);
      }

      if (!results.length) break;
      if (totalPages && page >= totalPages) break;

      page += 1;
      await sleep(125);
    }

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      deals,
    };

    const blob = await put(BLOB_PATH, JSON.stringify(output, null, 2), {
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
      scrapeDurationMs: output.scrapeDurationMs,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: err?.message || "Unknown error",
      status: err?.status || null,
      responseTextPreview: err?.responseText || null,
      scrapeDurationMs: Date.now() - startedAt,
    });
  }
}
