// /api/scrapers/running-company.js
//
// Running Company sale running shoes scraper
//
// What this does
// - Fetches JSON from https://shop.runningcompany.com/api/products-search
// - Supports both shapes:
//   1) { data: [...] , total: N }
//   2) { data: { "Product Name": [ ...variants ] , ... } }
// - Keeps ONLY sale running shoe deals
// - Skips hidden-price / see-price-in-cart style rows
// - Builds listingURL from productId + brand slug + product slug
// - Returns an easy-to-read response with NO deals array
// - Saves blob JSON with ONLY top-level structure + deals array
//
// ENV
// - BLOB_READ_WRITE_TOKEN
//
// TEST
// /api/scrapers/running-company

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Running Company";
const SCHEMA_VERSION = 1;
const SHOP_URL = "https://shop.runningcompany.com/shop/";
const API_URL = "https://shop.runningcompany.com/api/products-search";
const SITE_ORIGIN = "https://shop.runningcompany.com";

// Commented out for testing, per your request.
// // CRON_SECRET
// const auth = req.headers.authorization;
// if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
//   return res.status(401).json({ success: false, error: "Unauthorized" });
// }

function nowIso() {
  return new Date().toISOString();
}

function cleanString(v) {
  return typeof v === "string" ? v.trim() : "";
}

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function toAbsoluteUrl(pathOrUrl) {
  if (!pathOrUrl || typeof pathOrUrl !== "string") return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (pathOrUrl.startsWith("/")) return `${SITE_ORIGIN}${pathOrUrl}`;
  return `${SITE_ORIGIN}/${pathOrUrl}`;
}

function computeDiscountPercent(salePrice, originalPrice) {
  if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice) || originalPrice <= 0) {
    return null;
  }
  if (salePrice >= originalPrice) return null;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function inferGender(listingName = "") {
  const s = listingName.toLowerCase();
  if (/\bmen'?s\b|\bmens\b/.test(s)) return "mens";
  if (/\bwomen'?s\b|\bwomens\b/.test(s)) return "womens";
  if (/\bunisex\b/.test(s)) return "unisex";
  return "unknown";
}

function stripGenderWords(s = "") {
  return s
    .replace(/\bmen'?s\b/gi, "")
    .replace(/\bmens\b/gi, "")
    .replace(/\bwomen'?s\b/gi, "")
    .replace(/\bwomens\b/gi, "")
    .replace(/\bunisex\b/gi, "")
    .replace(/\bkid'?s\b/gi, "")
    .replace(/\bkids\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBrand(rawBrand, listingName, label) {
  const raw = cleanString(rawBrand);
  const lbl = cleanString(label);
  const title = cleanString(listingName);

  if (lbl && /^[A-Za-z][A-Za-z0-9 .&'+-]*$/.test(lbl)) return lbl;

  if (raw) {
    const prefix = raw.split("-")[0].trim().toUpperCase();
    const map = {
      ADI: "Adidas",
      ALT: "Altra",
      ASI: "Asics",
      BRO: "Brooks",
      HOK: "Hoka",
      NEW: "New Balance",
      NIK: "Nike",
      ONR: "On",
      OOF: "Oofos",
      PUM: "Puma",
      SAU: "Saucony",
      UND: "Under Armour",
    };
    if (map[prefix]) return map[prefix];
    if (!/\s-\s\d+$/.test(raw)) return raw;
  }

  const lower = title.toLowerCase();
  const titleMap = [
    ["new balance", "New Balance"],
    ["asics", "Asics"],
    ["brooks", "Brooks"],
    ["hoka one one", "Hoka"],
    ["hoka", "Hoka"],
    ["nike", "Nike"],
    ["adidas", "Adidas"],
    ["puma", "Puma"],
    ["saucony", "Saucony"],
    ["on running", "On"],
    ["on ", "On"],
    ["altra", "Altra"],
    ["under armour", "Under Armour"],
    ["oofos", "Oofos"],
  ];

  for (const [needle, normalized] of titleMap) {
    if (lower.startsWith(needle)) return normalized;
  }

  return raw || null;
}

function deriveModel(listingName, brand) {
  const title = cleanString(listingName);
  const brandClean = cleanString(brand);
  if (!title) return null;
  if (!brandClean) return stripGenderWords(title) || title;

  const escapedBrand = brandClean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutBrand = title.replace(new RegExp(`^${escapedBrand}\\s+`, "i"), "").trim();
  return stripGenderWords(withoutBrand) || title;
}

function looksLikeHiddenPriceText(row) {
  const text = [
    row?.name,
    row?.label,
    row?.blurb,
    row?.price,
    row?.priceText,
    row?.saleText,
    row?.metaTitle,
    row?.metaDescription,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!text) return false;

  return (
    text.includes("see price in cart") ||
    text.includes("see price in bag") ||
    text.includes("add to bag to see price") ||
    text.includes("add to cart to see price") ||
    text.includes("price in cart") ||
    text.includes("price in bag") ||
    text.includes("see price at checkout")
  );
}

function isKidsItem(rowOrName) {
  const text =
    typeof rowOrName === "string"
      ? rowOrName.toLowerCase()
      : `${rowOrName?.name || ""}`.toLowerCase();

  return /\bkid'?s\b|\bkids\b|\byouth\b|\bboys\b|\bgirls\b/.test(text);
}

function isLikelyNonShoe(row) {
  const text = `${row?.name || ""}`.toLowerCase();

  const banned = [
    "sock",
    "socks",
    "sunglass",
    "sunglasses",
    "slide",
    "thong",
    "crew",
    "quarter",
    "no show",
    "nosho",
    "insole",
    "support low",
    "belt",
    "bra",
    "shirt",
    "short",
    "tight",
    "hat",
    "glove",
    "sandal",
    "recovery",
    "ooahh",
    "ooriginal",
    "oolala",
    "thermal",
  ];

  if (banned.some((w) => text.includes(w))) return true;

  const shoeSignals = [
    "shoe",
    "running",
    "trainer",
    "spike",
    "xc",
    "track",
    "road",
    "trail",
    "ghost",
    "glycerin",
    "adrenaline",
    "cumulus",
    "nimbus",
    "novablast",
    "superblast",
    "megablast",
    "clifton",
    "bondi",
    "mach",
    "arahi",
    "pegasus",
    "vomero",
    "structure",
    "ride",
    "hurricane",
    "deviate",
    "velocity",
    "magnify",
    "alphafly",
    "dragonfly",
    "rebel",
    "fuelcell",
    "cloud",
    "cloudmonster",
    "cloudrunner",
    "cloudsurfer",
    "cloudboom",
    "1080",
    "880",
    "860",
    "2000",
  ];

  return !shoeSignals.some((w) => text.includes(w));
}

function emptyGenderCounts() {
  return { mens: 0, womens: 0, unisex: 0, unknown: 0 };
}

function addGenderCount(counts, gender) {
  if (gender === "mens") counts.mens += 1;
  else if (gender === "womens") counts.womens += 1;
  else if (gender === "unisex") counts.unisex += 1;
  else counts.unknown += 1;
}

function makeDropCounts() {
  return {
    totalRowsSeen: 0,
    dropped_notLive: 0,
    dropped_notSale: 0,
    dropped_kids: 0,
    dropped_nonShoe: 0,
    dropped_hiddenPrice: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_missingBrand: 0,
    dropped_duplicateProductId: 0,
  };
}

function inc(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

function compactCounts(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v > 0));
}

function flattenApiPayload(payload) {
  if (Array.isArray(payload?.data)) {
    return payload.data.map((row) => ({ ...row }));
  }

  if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    const out = [];
    for (const [groupName, arr] of Object.entries(payload.data)) {
      if (!Array.isArray(arr)) continue;
      for (const row of arr) {
        out.push({
          ...row,
          __groupName: groupName,
        });
      }
    }
    return out;
  }

  return [];
}

function slugify(s) {
  return cleanString(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/®|™/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function brandToSlug(brand) {
  const b = cleanString(brand).toLowerCase();

  const special = {
    "new balance": "new-balance",
    "under armour": "under-armour",
    "on": "on",
    "hoka": "hoka",
    "asics": "asics",
    "brooks": "brooks",
    "nike": "nike",
    "saucony": "saucony",
    "puma": "puma",
    "adidas": "adidas",
    "altra": "altra",
    "oofos": "oofos",
  };

  return special[b] || slugify(brand);
}

function buildListingUrl(productId, brand, listingName) {
  if (!productId || !brand || !listingName) return null;
  const brandSlug = brandToSlug(brand);
  const productSlug = slugify(listingName);
  return `${SITE_ORIGIN}/product/${productId}/${brandSlug}/${productSlug}`;
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    const response = await fetch(API_URL, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": "Mozilla/5.0",
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`API request failed: ${response.status} ${response.statusText} ${text.slice(0, 300)}`);
    }

    const raw = await response.json();
    const rows = flattenApiPayload(raw);
    const reportedTotal =
      Number.isFinite(raw?.total) ? raw.total :
      Number.isFinite(rows?.[0]?.totalRows) ? rows[0].totalRows :
      rows.length;

    const dropCounts = makeDropCounts();
    const storeGenderCounts = emptyGenderCounts();
    const pageGenderCounts = emptyGenderCounts();
    const pageSummaries = [];
    const deals = [];
    const seenProductIds = new Set();

    for (const row of rows) {
      dropCounts.totalRowsSeen += 1;

      const productId = Number(row?.productId);
      const listingName = cleanString(row?.name || row?.__groupName);
      const brand = normalizeBrand(row?.brandName, listingName, row?.label);
      const listingURL = buildListingUrl(productId, brand, listingName);
      const imageURL = toAbsoluteUrl(row?.url);
      const salePrice = toNumber(row?.cost);
      const originalPrice = toNumber(row?.retail);

      if (row?.isLive === false) {
        inc(dropCounts, "dropped_notLive");
        continue;
      }

      if (row?.isOnSale !== true) {
        inc(dropCounts, "dropped_notSale");
        continue;
      }

      if (isKidsItem(listingName)) {
        inc(dropCounts, "dropped_kids");
        continue;
      }

      if (isLikelyNonShoe({ name: listingName })) {
        inc(dropCounts, "dropped_nonShoe");
        continue;
      }

      if (looksLikeHiddenPriceText(row)) {
        inc(dropCounts, "dropped_hiddenPrice");
        continue;
      }

      if (!listingName) {
        inc(dropCounts, "dropped_missingListingName");
        continue;
      }

      if (!listingURL) {
        inc(dropCounts, "dropped_missingListingURL");
        continue;
      }

      if (!imageURL) {
        inc(dropCounts, "dropped_missingImageURL");
        continue;
      }

      if (!Number.isFinite(salePrice) || salePrice <= 0) {
        inc(dropCounts, "dropped_missingSalePrice");
        continue;
      }

      if (!Number.isFinite(originalPrice) || originalPrice <= 0) {
        inc(dropCounts, "dropped_missingOriginalPrice");
        continue;
      }

      if (salePrice >= originalPrice) {
        inc(dropCounts, "dropped_saleNotLessThanOriginal");
        continue;
      }

      if (!brand || /^unknown$/i.test(brand)) {
        inc(dropCounts, "dropped_missingBrand");
        continue;
      }

      if (seenProductIds.has(productId)) {
        inc(dropCounts, "dropped_duplicateProductId");
        continue;
      }
      seenProductIds.add(productId);

      const gender = inferGender(listingName);
      const model = deriveModel(listingName, brand);
      const discountPercent = computeDiscountPercent(salePrice, originalPrice);

      const deal = {
        schemaVersion: SCHEMA_VERSION,

        listingName,
        brand,
        model,

        salePrice: round2(salePrice),
        originalPrice: round2(originalPrice),
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

      deals.push(deal);
      addGenderCount(storeGenderCounts, gender);
      addGenderCount(pageGenderCounts, gender);
    }

    const pageSummary = {
      page: 1,
      url: API_URL,
      rowsReturned: rows.length,
      reportedTotalRows: reportedTotal,
      dealsExtracted: deals.length,
      droppedDeals: rows.length - deals.length,
      genderCounts: pageGenderCounts,
      dropCounts: compactCounts(dropCounts),
    };

    pageSummaries.push(pageSummary);

    const blobData = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: "direct-json",

      sourceUrls: [SHOP_URL, API_URL],

      pagesFetched: 1,

      dealsFound: rows.length,
      dealsExtracted: deals.length,
      dealsForMens: storeGenderCounts.mens,
      dealsForWomens: storeGenderCounts.womens,
      dealsForUnisex: storeGenderCounts.unisex,
      dealsForUnknown: storeGenderCounts.unknown,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      deals,
    };

    const blob = await put("running-company.json", JSON.stringify(blobData, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobPath: "running-company.json",
      blobUrl: blob.url,

      schemaVersion: SCHEMA_VERSION,
      lastUpdated: blobData.lastUpdated,
      via: blobData.via,

      sourceUrls: blobData.sourceUrls,
      pagesFetched: blobData.pagesFetched,

      dealsFound: blobData.dealsFound,
      dealsExtracted: blobData.dealsExtracted,
      dealsForMens: blobData.dealsForMens,
      dealsForWomens: blobData.dealsForWomens,
      dealsForUnisex: blobData.dealsForUnisex,
      dealsForUnknown: blobData.dealsForUnknown,

      scrapeDurationMs: blobData.scrapeDurationMs,
      ok: blobData.ok,
      error: blobData.error,

      dropCounts: compactCounts(dropCounts),
      pageSummaries,

      notes: [
        "Response intentionally omits deals array.",
        "Saved blob contains only top-level structure plus deals array.",
        "listingURL is constructed from productId + brand slug + listingName slug.",
        "shoeType is set to 'unknown' unless the source explicitly tags it.",
        "Hidden-price / see-price-in-cart style rows are skipped.",
      ],
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: err?.message || "Unknown error",
      scrapeDurationMs: Date.now() - startedAt,
      ok: false,
    });
  }
}
