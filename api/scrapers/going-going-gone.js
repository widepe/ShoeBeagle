// /api/scrapers/going-going-gone.js
//
// Going, Going, Gone sale running shoes scraper via DSG catalog product API
//
// Uses direct API requests to:
//   https://prod-catalog-product-api.dickssportinggoods.com/v2/search
//
// Source scope:
// - Men's sale running athletic & sneakers
// - Women's sale running athletic & sneakers
//
// IMPORTANT RULES:
// - listingName is preserved EXACTLY as returned
// - pricing prefers productDetails[parentCatentryId].prices for honest range support
// - if exact price: use salePrice/originalPrice and exact discountPercent
// - if range price: use salePriceLow/salePriceHigh/originalPriceLow/originalPriceHigh
//   and discountPercentUpTo, with discountPercent = null
// - gender: attributes first, title fallback, default unknown
// - shoeType:
//     * attribute 5066 first: Road -> road, Trail -> trail, Track/Spike/Spikes -> track
//     * fallback title parsing:
//         - "trail running" -> trail
//         - "road running" -> road
//         - "track" / "spike" / "spikes" -> track
//         - otherwise unknown
//
// ENV:
// - BLOB_READ_WRITE_TOKEN
// - CRON_SECRET (optional)
//
// Blob written:
// - going-going-gone.json

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Going, Going, Gone";
const SCHEMA_VERSION = 1;
const VIA = "dsg-catalog-product-api";
const BASE_URL = "https://www.goinggoinggone.com";
const API_URL = "https://prod-catalog-product-api.dickssportinggoods.com/v2/search";
const BLOB_PATH = "going-going-gone.json";
const PAGE_SIZE = 24;

const REQUEST_TOGGLES = {
  REQUIRE_CRON_SECRET: true,
};

const SOURCES = [
  {
    label: "mens",
    sourceUrl:
      "https://www.goinggoinggone.com/f/shop-all-mens-sale?filterFacets=4285%253ARunning%253B5382%253AAthletic%2520%2526%2520Sneakers",
    selectedCategory: "12301_10515458",
    selectedFilters: {
      "4285": ["Running"],
      "5382": ["Athletic & Sneakers"],
    },
  },
  {
    label: "womens",
    sourceUrl:
      "https://www.goinggoinggone.com/f/shop-all-womens-sale?filterFacets=4285%253ARunning%253B5382%253AAthletic%2520%2526%2520Sneakers",
    selectedCategory: "12301_10515463",
    selectedFilters: {
      "4285": ["Running"],
      "5382": ["Athletic & Sneakers"],
    },
  },
];

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
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function normalizeText(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeGenderValue(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "");
}

function parseAttributes(raw) {
  if (!raw) return {};
  let arr = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!Array.isArray(arr)) return {};

  const out = {};
  for (const obj of arr) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k || "").trim();
      if (!key) continue;
      if (!Object.prototype.hasOwnProperty.call(out, key)) {
        out[key] = v;
      } else if (Array.isArray(out[key])) {
        out[key].push(v);
      } else {
        out[key] = [out[key], v];
      }
    }
  }
  return out;
}

function parseGenderFromName(name) {
  const s = normalizeGenderValue(name);
  if (!s) return "unknown";
  if (/\bunisex\b/.test(s)) return "unisex";
  if (/\bwomens\b/.test(s) || /\bwomen\b/.test(s) || /\bwoman\b/.test(s)) return "womens";
  if (/\bmens\b/.test(s) || /\bmen\b/.test(s) || /\bman\b/.test(s)) return "mens";
  return "unknown";
}

function parseGender(product) {
  const attrs = parseAttributes(product?.attributes);
  const rawCandidates = [attrs["5495"], attrs["2101"]].flat().filter(Boolean);

  const normalized = rawCandidates.map(normalizeGenderValue);
  const hasWomen = normalized.includes("womens") || normalized.includes("women");
  const hasMen = normalized.includes("mens") || normalized.includes("men");
  const hasUnisex = normalized.includes("unisex");

  if (hasUnisex) return "unisex";
  if (hasWomen && hasMen) return "unisex";
  if (hasWomen) return "womens";
  if (hasMen) return "mens";

  return parseGenderFromName(product?.name || "");
}

function parseShoeTypeFromName(name) {
  const s = String(name || "").toLowerCase();
  if (s.includes("trail running")) return "trail";
  if (s.includes("road running")) return "road";
  if (s.includes("spikes") || s.includes("spike") || s.includes("track")) return "track";
  return "unknown";
}

function parseShoeType(product) {
  const attrs = parseAttributes(product?.attributes);
  const raw = [attrs["5066"]].flat().find(Boolean);
  const s = String(raw || "").trim().toLowerCase();

  if (s === "road") return "road";
  if (s === "trail") return "trail";
  if (s === "track" || s === "spike" || s === "spikes") return "track";

  return parseShoeTypeFromName(product?.name || "");
}

function extractBrand(product) {
  const mfName = normalizeText(product?.mfName);
  if (mfName) return mfName;

  const attrs = parseAttributes(product?.attributes);
  const brand = normalizeText(attrs["X_BRAND"]);
  return brand || "";
}

function stripLeadingBrand(title, brand) {
  if (!title || !brand) return title;
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title.replace(new RegExp(`^${escaped}\\s+`, "i"), "");
}

function extractModel(listingName, brand) {
  let s = normalizeText(listingName);
  if (!s) return "";

  s = stripLeadingBrand(s, brand);
  s = s.replace(/^(men's|mens|women's|womens|unisex)\s+/i, "");
  s = s.replace(
    /\s+(road\s+running\s+shoes|trail\s+running\s+shoes|running\s+shoes|athletic\s+shoes|shoes)\s*$/i,
    ""
  );
  s = s.replace(/\s{2,}/g, " ").trim();

  return s;
}

function getListingUrl(product) {
  const path = String(product?.assetSeoUrl || product?.dsgSeoUrl || "").trim();
  if (!path) return null;
  return path.startsWith("http") ? path : `${BASE_URL}${path}`;
}

function sanitizeScene7Part(s) {
  return String(s || "")
    .trim()
    .replace(/\//g, "_")
    .replace(/\s+/g, "_");
}

function getImageUrl(product, productDetailsEntry) {
  const fullImage = sanitizeScene7Part(product?.fullImage || product?.thumbnail || "");
  if (!fullImage) return null;

  let color = null;
  const colors = productDetailsEntry?.skuAttributes?.Color;
  if (Array.isArray(colors) && colors.length) color = colors[0];
  if (!color && product?.swatchPartnumber) {
    const parts = String(product.swatchPartnumber).split("_");
    if (parts.length > 1) color = parts.slice(1).join("_");
  }

  const colorPart = color ? `_${sanitizeScene7Part(color)}` : "";
  return `https://dks.scene7.com/is/image/dkscdn/${fullImage}${colorPart}_is/?wid=252&hei=252&qlt=85,0&fmt=jpg&op_sharpen=1`;
}

function getActiveFloatFacetValue(product, identifier, nowTs) {
  const facets = Array.isArray(product?.floatFacets) ? product.floatFacets : [];
  const matches = facets
    .filter((f) => String(f?.identifier || "") === identifier)
    .filter((f) => {
      const start = toNumber(f?.startDateTime);
      const end = toNumber(f?.endDateTime);
      if (start === null || end === null) return true;
      return start <= nowTs && end >= nowTs;
    })
    .sort((a, b) => (toNumber(b?.startDateTime) || 0) - (toNumber(a?.startDateTime) || 0));

  return matches.length ? toNumber(matches[0]?.value) : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice) || originalPrice <= 0) {
    return null;
  }
  if (salePrice >= originalPrice) return null;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function computeDiscountPercentUpTo(originalHigh, saleLow) {
  if (!Number.isFinite(originalHigh) || !Number.isFinite(saleLow) || originalHigh <= 0) {
    return null;
  }
  if (saleLow >= originalHigh) return null;
  return Math.round(((originalHigh - saleLow) / originalHigh) * 100);
}

function parsePricing(product, productDetailsEntry, nowTs) {
  const prices = productDetailsEntry?.prices || {};

  const minList = round2(toNumber(prices.minlistprice));
  const maxList = round2(toNumber(prices.maxlistprice));
  const minOffer = round2(toNumber(prices.minofferprice));
  const maxOffer = round2(toNumber(prices.maxofferprice));

  const hasStructuredRange =
    [minList, maxList, minOffer, maxOffer].some((v) => Number.isFinite(v));

  if (hasStructuredRange) {
    const origLow = minList;
    const origHigh = maxList ?? minList;
    const saleLow = minOffer;
    const saleHigh = maxOffer ?? minOffer;

    const exact =
      Number.isFinite(origLow) &&
      Number.isFinite(origHigh) &&
      Number.isFinite(saleLow) &&
      Number.isFinite(saleHigh) &&
      origLow === origHigh &&
      saleLow === saleHigh;

    if (exact) {
      return {
        salePrice: saleLow,
        originalPrice: origLow,
        discountPercent: computeDiscountPercent(origLow, saleLow),
        salePriceLow: null,
        salePriceHigh: null,
        originalPriceLow: null,
        originalPriceHigh: null,
        discountPercentUpTo: null,
        pricingMode: "exact_structured",
      };
    }

    return {
      salePrice: null,
      originalPrice: null,
      discountPercent: null,
      salePriceLow: saleLow,
      salePriceHigh: saleHigh,
      originalPriceLow: origLow,
      originalPriceHigh: origHigh,
      discountPercentUpTo: computeDiscountPercentUpTo(origHigh, saleLow),
      pricingMode: "range_structured",
    };
  }

  const listPrice = round2(
    getActiveFloatFacetValue(product, "dickssportinggoodslistprice", nowTs)
  );
  const offerPrice = round2(
    getActiveFloatFacetValue(product, "dickssportinggoodsofferprice", nowTs)
  );

  return {
    salePrice: offerPrice,
    originalPrice: listPrice,
    discountPercent: computeDiscountPercent(listPrice, offerPrice),
    salePriceLow: null,
    salePriceHigh: null,
    originalPriceLow: null,
    originalPriceHigh: null,
    discountPercentUpTo: null,
    pricingMode: "exact_floatFacets",
  };
}

function isValidPricing(p) {
  const hasExact =
    Number.isFinite(p.salePrice) &&
    Number.isFinite(p.originalPrice) &&
    p.salePrice < p.originalPrice;

  const hasRange =
    Number.isFinite(p.salePriceLow) &&
    Number.isFinite(p.salePriceHigh) &&
    Number.isFinite(p.originalPriceLow) &&
    Number.isFinite(p.originalPriceHigh) &&
    p.salePriceLow <= p.salePriceHigh &&
    p.originalPriceLow <= p.originalPriceHigh &&
    p.salePriceLow < p.originalPriceHigh;

  return hasExact || hasRange;
}

function buildSearchUrl(source, pageNumber) {
  const searchVO = {
    pageNumber,
    pageSize: PAGE_SIZE,
    selectedSort: 5,
    selectedStore: "925",
    storeId: "15108",
    zipcode: "91710",
    isFamilyPage: true,
    mlBypass: false,
    snbAudience: "",
    includeFulfillmentFacets: false,
    selectedFilters: source.selectedFilters,
    selectedCategory: source.selectedCategory,
  };

  return `${API_URL}?searchVO=${encodeURIComponent(JSON.stringify(searchVO))}`;
}

async function fetchPage(source, pageNumber) {
  const url = buildSearchUrl(source, pageNumber);

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      channel: "g3",
      "disable-pinning": "false",
      origin: BASE_URL,
      referer: source.sourceUrl,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      "x-dsg-platform": "v2",
    },
  });

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!resp.ok) {
    const err = new Error(`Going, Going, Gone API failed with status ${resp.status}`);
    err.status = resp.status;
    err.responseText = text.slice(0, 3000);
    throw err;
  }

  if (!json || typeof json !== "object") {
    const err = new Error("Going, Going, Gone API returned invalid JSON");
    err.responseText = text.slice(0, 3000);
    throw err;
  }

  return json;
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    if (REQUEST_TOGGLES.REQUIRE_CRON_SECRET) {
      const auth = req.headers.authorization;
      if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }
    }

    const deals = [];
    const seen = new Set();
    const nowTs = Date.now();

    const dropCounts = {
      totalProductsSeen: 0,
      dropped_missingListingName: 0,
      dropped_missingBrand: 0,
      dropped_missingListingURL: 0,
      dropped_missingImageURL: 0,
      dropped_invalidPricing: 0,
      dropped_invalidGender: 0,
      dropped_duplicateAfterMerge: 0,
    };

    const genderCounts = {
      mens: 0,
      womens: 0,
      unisex: 0,
      unknown: 0,
    };

    let pagesFetched = 0;
    let dealsFound = 0;
    const sourceUrls = SOURCES.map((s) => s.sourceUrl);

    for (const source of SOURCES) {
      let pageNumber = 0;
      let totalCount = null;
      let collectedForSource = 0;

      while (true) {
        const json = await fetchPage(source, pageNumber);
        pagesFetched += 1;

        const productVOs = Array.isArray(json?.productVOs) ? json.productVOs : [];
        const productDetails = json?.productDetails || {};

        if (Number.isFinite(toNumber(json?.totalCount))) {
          totalCount = Number(json.totalCount);
        }

        dealsFound += productVOs.length;
        dropCounts.totalProductsSeen += productVOs.length;
        collectedForSource += productVOs.length;

        for (const product of productVOs) {
          const listingName = normalizeText(product?.name);
          const brand = extractBrand(product);
          const listingURL = getListingUrl(product);

          const parentKey =
            String(product?.parentCatentryId || product?.catentryId || "").trim();
          const detailsEntry = parentKey ? productDetails[parentKey] : null;

          const imageURL = getImageUrl(product, detailsEntry);
          const pricing = parsePricing(product, detailsEntry, nowTs);
          const gender = parseGender(product);
          const shoeType = parseShoeType(product);
          const model = extractModel(listingName, brand);

          if (!listingName) {
            dropCounts.dropped_missingListingName += 1;
            continue;
          }

          if (!brand) {
            dropCounts.dropped_missingBrand += 1;
            continue;
          }

          if (!listingURL) {
            dropCounts.dropped_missingListingURL += 1;
            continue;
          }

          if (!imageURL) {
            dropCounts.dropped_missingImageURL += 1;
            continue;
          }

          if (!isValidPricing(pricing)) {
            dropCounts.dropped_invalidPricing += 1;
            continue;
          }

          if (!["mens", "womens", "unisex", "unknown"].includes(gender)) {
            dropCounts.dropped_invalidGender += 1;
            continue;
          }

          const dedupeKey = listingURL;
          if (seen.has(dedupeKey)) {
            dropCounts.dropped_duplicateAfterMerge += 1;
            continue;
          }
          seen.add(dedupeKey);

          genderCounts[gender] += 1;

          deals.push({
            listingName,
            brand,
            model,
            salePrice: pricing.salePrice,
            originalPrice: pricing.originalPrice,
            discountPercent: pricing.discountPercent,
            store: STORE,
            listingURL,
            imageURL,
            gender,
            shoeType,
            salePriceLow: pricing.salePriceLow,
            salePriceHigh: pricing.salePriceHigh,
            originalPriceLow: pricing.originalPriceLow,
            originalPriceHigh: pricing.originalPriceHigh,
            discountPercentUpTo: pricing.discountPercentUpTo,
          });
        }

        if (!productVOs.length) break;
        if (totalCount !== null && collectedForSource >= totalCount) break;

        pageNumber += 1;
        await sleep(150);
      }
    }

    const totalDropped =
      dropCounts.dropped_missingListingName +
      dropCounts.dropped_missingBrand +
      dropCounts.dropped_missingListingURL +
      dropCounts.dropped_missingImageURL +
      dropCounts.dropped_invalidPricing +
      dropCounts.dropped_invalidGender +
      dropCounts.dropped_duplicateAfterMerge;

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

      metadata: {
        genderCounts,
        dropSummary: {
          totalResultsSeen: dropCounts.totalProductsSeen,
          totalDropped,
          totalKept: deals.length,
          reasons: dropCounts,
        },
      },

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
      genderCounts: output.metadata.genderCounts,
      dropSummary: output.metadata.dropSummary,
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
