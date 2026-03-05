// /api/scrapers/rununited-searchanise.js
//
// RunUnited via Searchanise /getresults (NO Firecrawl).
// - Paginates via startIndex/maxResults (maxResults up to 250)
// - Drops ALL out-of-stock
// - Writes run-united.json to Vercel Blob
//
// Env vars:
// - BLOB_READ_WRITE_TOKEN
// (No FIRECRAWL_API_KEY needed)
//
// Test:
//   /api/scrapers/rununited-searchanise
//
// CRON auth (install CRON_SECRET, but comment out for testing):
// const auth = req.headers.authorization;
// if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
//   return res.status(401).json({ success: false, error: "Unauthorized" });
// }

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Run United";
const VIA = "searchanise";

// You captured this URL. We'll use it as a template, but:
// - force output=json (not jsonp)
// - remove callback/_
// - override category, startIndex, maxResults
const TEMPLATE_URL =
  "https://searchserverapi1.com/getresults?api_key=1R3G2s3d0j&q=&sortBy=created&sortOrder=desc&restrictBy%5Bcustom_field_e70b59714528d5798b1c8adaf0d0ed15%5D=On+Sale&startIndex=20&maxResults=20&items=true&pages=true&categories=true&suggestions=true&queryCorrection=true&suggestionsMaxResults=3&pageStartIndex=0&pagesMaxResults=20&categoryStartIndex=0&categoriesMaxResults=20&facets=true&facetsShowUnavailableOptions=false&recentlyViewedProducts=&recentlyAddedToCartProducts=&recentlyPurchasedProducts=&ResultsTitleStrings=2&ResultsDescriptionStrings=2&page=2&tab=products&action=moreResults&category=https%3A%2F%2Frununited.com%2Fmens%2Ffootwear%2Froad-running-shoes%2F&displaySubcatProducts=always&CustomerGroupId=2&timeZoneName=America%2FLos_Angeles&output=jsonp&callback=jQuery37103570776640006611_1772575777504&_=1772575777506";

const SOURCES = [
  // ROAD
  {
    categoryUrl: "https://rununited.com/mens/footwear/road-running-shoes/",
    shoeType: "road",
  },
  {
    categoryUrl: "https://rununited.com/womens/footwear/road-running-shoes/",
    shoeType: "road",
  },

  // TRAIL
  {
    categoryUrl: "https://rununited.com/mens/footwear/trail-running-shoes/",
    shoeType: "trail",
  },
  {
    categoryUrl: "https://rununited.com/womens/footwear/trail-running-shoes/",
    shoeType: "trail",
  },

  // TRACK
  {
    categoryUrl: "https://rununited.com/mens/footwear/track-running-shoes/",
    shoeType: "track",
  },
  {
    categoryUrl: "https://rununited.com/womens/footwear/track-running-shoes/",
    shoeType: "track",
  },
];

function nowIso() {
  return new Date().toISOString();
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function toNumberFromMoney(x) {
  if (x == null) return null;
  const cleaned = String(x).replace(/[^\d.]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseTitleForBrandGenderModel(listingName) {
  const s = cleanText(listingName);
  const m = s.match(/^(.*?)\s+(Men's|Women's|Unisex|Kids')\s+(.*)$/i);
  if (!m) return { brand: "", gender: "", model: "" };

  const brand = cleanText(m[1]);
  const genderRaw = cleanText(m[2]);
  let rest = cleanText(m[3]);

  rest = rest.replace(/\s+Running Shoes\s*$/i, "").trim();
  rest = rest.replace(/\s+Shoes\s*$/i, "").trim();

  const gender =
    /^men/i.test(genderRaw)
      ? "mens"
      : /^women/i.test(genderRaw)
      ? "womens"
      : /^kids/i.test(genderRaw)
      ? "kids"
      : /^unisex/i.test(genderRaw)
      ? "unisex"
      : "";

  return { brand, gender, model: rest };
}

function computeDiscountPercent(salePrice, originalPrice) {
  if (
    typeof salePrice === "number" &&
    typeof originalPrice === "number" &&
    originalPrice > 0 &&
    salePrice >= 0 &&
    salePrice < originalPrice
  ) {
    return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  }
  return null;
}

function buildBaseUrlForCategory(categoryUrl) {
  const u = new URL(TEMPLATE_URL);

  // Force plain JSON (server-side fetch; no need for JSONP)
  u.searchParams.set("output", "json");
  u.searchParams.delete("callback");
  u.searchParams.delete("_");

  // Make sure items are returned; keep other sections off to shrink response
  u.searchParams.set("items", "true");
  u.searchParams.set("pages", "false");
  u.searchParams.set("categories", "false");
  u.searchParams.set("suggestions", "false");
  u.searchParams.set("facets", "false");

  // Ensure we're filtering by the correct category
  u.searchParams.set("category", categoryUrl);

  // Remove page/action UI noise (not needed for API pagination)
  u.searchParams.delete("page");
  u.searchParams.delete("tab");
  u.searchParams.delete("action");

  // We will set startIndex/maxResults per request
  u.searchParams.delete("startIndex");
  u.searchParams.delete("maxResults");

  return u.toString();
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Searchanise failed (${resp.status}): ${txt}`);
  }
  const text = await resp.text();

  // Safety: if server still sends JSONP despite output=json, unwrap it.
  // Typical JSONP: callbackName({...});
  const trimmed = text.trim();
  const looksJsonp =
    trimmed.includes("(") && trimmed.endsWith(");") && trimmed.indexOf("{") > -1;

  if (looksJsonp) {
    const start = trimmed.indexOf("(");
    const end = trimmed.lastIndexOf(")");
    const inner = trimmed.slice(start + 1, end);
    return JSON.parse(inner);
  }

  return JSON.parse(text);
}

function pickField(item, keys) {
  for (const k of keys) {
    if (item && item[k] != null && String(item[k]).trim() !== "") return item[k];
  }
  return null;
}

function isOutOfStockItem(item) {
  // We drop ALL out-of-stock no matter where it appears.
  // Searchanise item fields vary per integration; check multiple signals.
  const blob = JSON.stringify(item || "");
  if (/out\s*of\s*stock/i.test(blob)) return true;

  const qty = pickField(item, ["quantity", "qty", "stock", "inventory"]);
  if (qty === 0 || qty === "0") return true;

  const inStock = pickField(item, ["in_stock", "instock", "available"]);
  if (inStock === false || inStock === "false") return true;

  return false;
}

async function fetchAllItemsForCategory(baseUrl) {
  const maxResults = 250; // Searchanise supports 0..250 :contentReference[oaicite:2]{index=2}
  let startIndex = 0;

  const all = [];
  let totalItems = null;

  while (true) {
    const u = new URL(baseUrl);
    u.searchParams.set("startIndex", String(startIndex));
    u.searchParams.set("maxResults", String(maxResults));

    const json = await fetchJson(u.toString());

    if (totalItems == null) {
      const t = Number(json?.totalItems ?? json?.total_items ?? 0);
      totalItems = Number.isFinite(t) ? t : 0;
    }

    const items = Array.isArray(json?.items) ? json.items : [];
    if (!items.length) break;

    all.push(...items);
    startIndex += items.length;

    if (totalItems && startIndex >= totalItems) break;
    if (items.length < maxResults) break; // safety
  }

  return { totalItems: totalItems ?? all.length, items: all };
}

export default async function handler(req, res) {
  const t0 = Date.now();

  try {
    // CRON SECRET
     const auth = req.headers.authorization;
     if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
       return res.status(401).json({ success: false, error: "Unauthorized" });
     }

    let dealsFound = 0;
    let droppedOutOfStock = 0;
    let droppedMissingPrices = 0;

    const deals = [];
    const sourceUrls = [];

    for (const src of SOURCES) {
      const baseUrl = buildBaseUrlForCategory(src.categoryUrl);
      sourceUrls.push(baseUrl);

      const { totalItems, items } = await fetchAllItemsForCategory(baseUrl);
      dealsFound += totalItems;

      for (const it of items) {
        if (isOutOfStockItem(it)) {
          droppedOutOfStock++;
          continue;
        }

        const listingName = cleanText(
          pickField(it, ["title", "name", "product_title"]) || ""
        );
        const listingURL = cleanText(
          pickField(it, ["link", "url", "product_url"]) || ""
        );
        const imageURL = cleanText(
          pickField(it, ["image_link", "image", "img", "thumbnail"]) || ""
        );

        // Field names vary; try several common ones.
        const salePrice =
          toNumberFromMoney(pickField(it, ["price", "product_price", "sale_price"])) ??
          null;

        const originalPrice =
          toNumberFromMoney(pickField(it, ["list_price", "old_price", "compare_at_price"])) ??
          null;

        if (!listingName || !listingURL || salePrice == null || originalPrice == null) {
          droppedMissingPrices++;
          continue;
        }

        const discountPercent = computeDiscountPercent(salePrice, originalPrice);
        const { brand, gender, model } = parseTitleForBrandGenderModel(listingName);

        deals.push({
          schemaVersion: 1,

          listingName,
          brand: brand || "",
          model: model || "",

          salePrice,
          originalPrice,
          discountPercent,

          // No ranges expected here
          salePriceLow: null,
          salePriceHigh: null,
          originalPriceLow: null,
          originalPriceHigh: null,
          discountPercentUpTo: null,

          store: STORE,

          listingURL,
          imageURL: imageURL || "",

          gender: gender || "unknown",
          shoeType: src.shoeType,
        });
      }
    }

    const payload = {
      store: STORE,
      schemaVersion: 1,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,
      pagesFetched: SOURCES.length,

      dealsFound,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - t0,

      ok: true,
      error: null,

      droppedOutOfStock,
      droppedMissingPrices,

      deals,
    };

    const blob = await put("run-united.json", JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    return res.status(200).json({
      ok: true,
      store: STORE,
      via: VIA,
      pagesFetched: SOURCES.length,
      dealsFound,
      dealsExtracted: deals.length,
      droppedOutOfStock,
      droppedMissingPrices,
      blobUrl: blob.url,
      expectedBlobUrl: process.env.RUNUNITED_DEALS_BLOB_URL || null,
      elapsedMs: Date.now() - t0,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      store: STORE,
      error: err?.message || String(err),
      elapsedMs: Date.now() - t0,
    });
  }
}
