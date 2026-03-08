// /api/scrapers/running-center-api.js
//
// Running Centers scraper (API-first / faster / more reliable)
// - Scrapes these two category pages through the site's product JSON endpoint:
//   1) https://shop.runningcenter.com/category/18334/men-s-shoes
//   2) https://shop.runningcenter.com/category/18334/women-s-shoes
//
// RULES:
// - listingName preserved exactly as received
// - gender is parsed from the same line as model (the name field)
// - brand comes from brandName
// - shoeType is always "unknown"
// - ONLY true deals included:
//     * salePrice and originalPrice must both exist
//     * salePrice must be < originalPrice
// - ONLY shippable products included:
//     * inStorePurchaseOnly === false
//     * productPurchaseOnly === false
//     * brandPurchaseOnly === false
// - Stable blob path: running-center.json
//
// ENV:
// - BLOB_READ_WRITE_TOKEN
// - CRON_SECRET (commented out below for testing)
//
// OPTIONAL:
// - RUNNING_CENTERS_PAGE_SIZE=250
//
// Notes:
// - The exact endpoint shape can vary by site build. This version is structured so you only
//   need to adjust buildApiUrl() if their category JSON URL differs.
// - Start by testing with ?debug=1 if needed.
//

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Running Center";
const VIA = "api";
const SCHEMA_VERSION = 1;
const BASE = "https://shop.runningcenter.com";

const CATEGORY_PAGES = [
  {
    sourceUrl: `${BASE}/category/18334/men-s-shoes`,
    genderHint: "mens",
    slug: "men-s-shoes",
  },
  {
    sourceUrl: `${BASE}/category/18334/women-s-shoes`,
    genderHint: "womens",
    slug: "women-s-shoes",
  },
];

const PAGE_SIZE = Math.max(
  1,
  Math.min(250, Number(process.env.RUNNING_CENTER_PAGE_SIZE || 250))
);

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function toAbsoluteUrl(url) {
  const s = String(url || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/")) return `${BASE}${s}`;
  return `${BASE}/${s.replace(/^\/+/, "")}`;
}

function titleCaseBrand(v) {
  const s = cleanText(v);
  if (!s) return null;
  return s
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
    .join(" ");
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundPercent(n) {
  return Number.isFinite(n) ? Math.round(n) : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice >= originalPrice) return null;
  return roundPercent(((originalPrice - salePrice) / originalPrice) * 100);
}

function parseGenderAndModel(listingName, fallbackGender = "unknown") {
  const raw = cleanText(listingName);
  if (!raw) {
    return { gender: fallbackGender, model: null };
  }

  const lower = raw.toLowerCase();

  if (lower.startsWith("men's ")) {
    return { gender: "mens", model: raw.slice(6).trim() };
  }
  if (lower.startsWith("mens ")) {
    return { gender: "mens", model: raw.slice(5).trim() };
  }
  if (lower.startsWith("women's ")) {
    return { gender: "womens", model: raw.slice(8).trim() };
  }
  if (lower.startsWith("womens ")) {
    return { gender: "womens", model: raw.slice(7).trim() };
  }
  if (lower.startsWith("unisex ")) {
    return { gender: "unisex", model: raw.slice(7).trim() };
  }

  return { gender: fallbackGender, model: raw };
}

function isShippableProduct(row) {
  return (
    row &&
    row.isLive === true &&
    Number(row.stock || 0) > 0 &&
    row.inStorePurchaseOnly === false &&
    row.productPurchaseOnly === false &&
    row.brandPurchaseOnly === false
  );
}

function getSalePrice(row) {
  const markdown = asNumber(row.markdown ?? row.markDown);
  if (markdown != null) return markdown;

  const cost = asNumber(row.cost);
  const retail = asNumber(row.retail);

  // If marked as on sale but markdown is missing, cost often behaves like current sale price.
  if (row.isOnSale === true && cost != null && retail != null && cost < retail) {
    return cost;
  }

  return null;
}

function getOriginalPrice(row) {
  const retail = asNumber(row.retail);
  const sale = getSalePrice(row);

  if (retail != null && sale != null && retail > sale) return retail;
  return null;
}

function buildListingUrl(row) {
  // If the API ever includes a canonical path, use it.
  if (row.productUrl) return toAbsoluteUrl(row.productUrl);
  if (row.urlSlug) return toAbsoluteUrl(row.urlSlug);

  // Fallback guess:
  // /product/{productId}/{brand-lower}/{slugified-name}
  const productId = row.productId;
  const brand = cleanText(row.label || row.brandName || "").toLowerCase();
  const name = cleanText(row.name || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (productId && brand && name) {
    return `${BASE}/product/${productId}/${brand}/${name}`;
  }

  return null;
}

function buildImageUrl(row) {
  return toAbsoluteUrl(row.url || null);
}

function makeDeal(row, fallbackGender) {
  const listingName = cleanText(row.name);
  const brand = titleCaseBrand(row.label || row.brandName);
  const salePrice = getSalePrice(row);
  const originalPrice = getOriginalPrice(row);
  const listingURL = buildListingUrl(row);
  const imageURL = buildImageUrl(row);

  if (!listingName || !brand || !listingURL) return null;
  if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice)) return null;
  if (!(salePrice < originalPrice)) return null;
  if (!isShippableProduct(row)) return null;

  const { gender, model } = parseGenderAndModel(listingName, fallbackGender);
  const discountPercent = computeDiscountPercent(originalPrice, salePrice);

  return {
    schemaVersion: SCHEMA_VERSION,

    listingName,

    brand,
    model: model || listingName,

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
    shoeType: "unknown",
  };
}

function dedupeDeals(deals) {
  const seen = new Set();
  const out = [];

  for (const d of deals) {
    const key = `${d.listingURL}__${d.salePrice}__${d.originalPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }

  return out;
}

// IMPORTANT:
// This is the one function you may need to tweak if the site's JSON endpoint differs.
// A lot of these storefronts expose category products from an ajax endpoint.
// Try this first. If the site responds differently, only update this URL builder.
function buildApiUrl({ sourceUrl, startIndex = 0, maxResults = PAGE_SIZE }) {
  const u = new URL(sourceUrl);

  // Common pattern used by this storefront family:
  // /api/products?category=<full category url>&startIndex=0&maxResults=250&preview=false
  const api = new URL(`${BASE}/api/products`);
  api.searchParams.set("category", u.pathname);
  api.searchParams.set("startIndex", String(startIndex));
  api.searchParams.set("maxResults", String(maxResults));
  api.searchParams.set("preview", "false");

  return api.toString();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json,text/plain,*/*",
      referer: BASE,
      "x-requested-with": "XMLHttpRequest",
    },
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}: ${text.slice(0, 300)}`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Non-JSON response for ${url}: ${text.slice(0, 300)}`);
  }
}

async function fetchAllCategoryRows(category) {
  const firstUrl = buildApiUrl({
    sourceUrl: category.sourceUrl,
    startIndex: 0,
    maxResults: PAGE_SIZE,
  });

  const first = await fetchJson(firstUrl);

  const firstRows = Array.isArray(first?.data) ? first.data : [];
  const total = Number(first?.total || firstRows[0]?.totalRows || firstRows.length || 0);

  let rows = [...firstRows];
  let pagesFetched = 1;
  const sourceUrls = [firstUrl];

  for (let startIndex = firstRows.length; startIndex < total; startIndex += PAGE_SIZE) {
    const url = buildApiUrl({
      sourceUrl: category.sourceUrl,
      startIndex,
      maxResults: PAGE_SIZE,
    });

    const page = await fetchJson(url);
    const pageRows = Array.isArray(page?.data) ? page.data : [];

    rows.push(...pageRows);
    pagesFetched += 1;
    sourceUrls.push(url);

    if (!pageRows.length) break;
  }

  return {
    rows,
    pagesFetched,
    sourceUrls,
    totalRows: total,
  };
}

export default async function handler(req, res) {
  const started = Date.now();

  // CRON auth (temporarily commented out for testing)
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const payload = {
    store: STORE,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated: nowIso(),
    via: VIA,

    sourceUrls: [],

    pagesFetched: 0,

    dealsFound: 0,
    dealsExtracted: 0,

    scrapeDurationMs: 0,

    ok: false,
    error: null,

    deals: [],

    pageNotes: [],
    debug: {},
  };

  try {
    let allDeals = [];
    let allRows = 0;

    for (const category of CATEGORY_PAGES) {
      const result = await fetchAllCategoryRows(category);

      payload.sourceUrls.push(...result.sourceUrls);
      payload.pagesFetched += result.pagesFetched;
      allRows += result.rows.length;

      const categoryDeals = result.rows
        .map((row) => makeDeal(row, category.genderHint))
        .filter(Boolean);

      allDeals.push(...categoryDeals);

      payload.pageNotes.push({
        url: category.sourceUrl,
        apiCalls: result.pagesFetched,
        rowsReturned: result.rows.length,
        keptByParser: categoryDeals.length,
      });
    }

    const deduped = dedupeDeals(allDeals);

    payload.dealsFound = allRows;
    payload.dealsExtracted = deduped.length;
    payload.deals = deduped;
    payload.ok = true;
    payload.error = null;
  } catch (err) {
    payload.ok = false;
    payload.error = err?.message || "Unknown scraper error";
  }

  payload.scrapeDurationMs = Date.now() - started;
  payload.lastUpdated = nowIso();

  try {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const blob = await put("running-center.json", JSON.stringify(payload, null, 2), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
      });

      return res.status(payload.ok ? 200 : 500).json({
        ok: payload.ok,
        error: payload.error,
        store: payload.store,
        pagesFetched: payload.pagesFetched,
        dealsFound: payload.dealsFound,
        dealsExtracted: payload.dealsExtracted,
        scrapeDurationMs: payload.scrapeDurationMs,
        blobUrl: blob.url,
      });
    }

    return res.status(payload.ok ? 200 : 500).json(payload);
  } catch (uploadErr) {
    return res.status(500).json({
      ok: false,
      error: `Scraped but blob upload failed: ${uploadErr?.message || "Unknown upload error"}`,
      payload,
    });
  }
}
