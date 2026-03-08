// /api/scrapers/running-center.js

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Running Center";
const SCHEMA_VERSION = 1;
const API_URL = "https://shop.runningcenters.com/api/products-search";

const MEN_CATEGORY_ID = 18334;     // Men's Shoes
const WOMEN_CATEGORY_ID = 18342;   // Women's Shoes
const SALE_CATEGORY_ID = 18811;    // Sale (known, but not used directly here)

function nowIso() {
  return new Date().toISOString();
}

function clean(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function titleCase(v) {
  const s = clean(v);
  if (!s) return null;
  return s
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function parseGenderModel(name) {
  const n = clean(name);
  const lower = n.toLowerCase();

  if (lower.startsWith("men's ")) {
    return { gender: "mens", model: n.slice(6).trim() };
  }
  if (lower.startsWith("mens ")) {
    return { gender: "mens", model: n.slice(5).trim() };
  }
  if (lower.startsWith("men'sm ")) {
    return { gender: "mens", model: n.slice(7).trim() };
  }
  if (lower.startsWith("women's ")) {
    return { gender: "womens", model: n.slice(8).trim() };
  }
  if (lower.startsWith("womens ")) {
    return { gender: "womens", model: n.slice(7).trim() };
  }
  if (lower.startsWith("woman's ")) {
    return { gender: "womens", model: n.slice(8).trim() };
  }
  if (lower.startsWith("unisex ")) {
    return { gender: "unisex", model: n.slice(7).trim() };
  }
  if (lower.startsWith("all gender ")) {
    return { gender: "unisex", model: n.slice(11).trim() };
  }
  if (/^u\s+/i.test(n)) {
    return { gender: "unisex", model: n.replace(/^u\s+/i, "").trim() };
  }

  // Optional shorthand handling:
  // M880v15 -> mens
  // W860v14 -> womens
  if (/^m\d/i.test(n)) {
    return { gender: "mens", model: n };
  }
  if (/^w\d/i.test(n)) {
    return { gender: "womens", model: n };
  }

  return { gender: "unknown", model: n };
}

function computeDiscountPercent(original, sale) {
  if (!Number.isFinite(original) || !Number.isFinite(sale)) return null;
  if (original <= 0 || sale >= original) return null;
  return Math.round(((original - sale) / original) * 100);
}

function asNumber(v) {
  if (v === null || v === undefined) return null;

  const s = String(v).trim();
  if (!s) return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function getSalePrice(p) {
  const markdown = asNumber(p.markdown ?? p.markDown);
  if (markdown != null) return markdown;

  const cost = asNumber(p.cost);
  const retail = asNumber(p.retail);

  if (p.isOnSale === true && cost != null && retail != null && cost < retail) {
    return cost;
  }

  return null;
}

function getOriginalPrice(p) {
  const retail = asNumber(p.retail);
  const sale = getSalePrice(p);

  if (retail != null && sale != null && retail > sale) {
    return retail;
  }

  return null;
}

function isSaleProduct(p) {
  const sale = getSalePrice(p);
  const original = getOriginalPrice(p);
  return Number.isFinite(sale) && Number.isFinite(original) && sale < original;
}

// Must be shippable.
// Store pickup may also be allowed — that is fine.
function isShippable(p) {
  return (
    p &&
    p.isLive === true &&
    Number(p.stock || 0) > 0 &&
    p.inStorePurchaseOnly === false &&
    p.productPurchaseOnly === false &&
    p.brandPurchaseOnly === false
  );
}

function listingUrl(p) {
  const productId = p.productId;
  const brand = clean(p.label || p.brandName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = clean(p.name)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!productId || !brand || !slug) return null;
  return `https://shop.runningcenters.com/product/${productId}/${brand}/${slug}`;
}

function imageUrl(p) {
  const u = clean(p.url);
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return `https://shop.runningcenters.com${u}`;
  return `https://shop.runningcenters.com/${u}`;
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

async function fetchProductsForCategory(categoryId, refererPath) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/json",
      origin: "https://shop.runningcenters.com",
      referer: `https://shop.runningcenters.com${refererPath}`,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      "x-requested-with": "XMLHttpRequest",
    },
    body: JSON.stringify({
      brand: -1,
      category: categoryId,
      collection: -1,
      search: "",
      grouped: true,
      size: 10000,
      cost: -1,
      page: 1,
      stock: -1,
      complete: -1,
      live: -1,
      sort: "brandName, name",
      sortType: "asc",
      admin: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`API fetch failed for category ${categoryId} (${response.status}): ${text.slice(0, 300)}`);
  }

  const json = await response.json();
  return Array.isArray(json?.data) ? json.data : [];
}

export default async function handler(req, res) {
  const started = Date.now();

  // CRON auth (temporarily commented out for testing)
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const payload = {
    store: STORE,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated: nowIso(),
    via: "api",

    sourceUrls: [API_URL],

    pagesFetched: 2,

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
    const [menProducts, womenProducts] = await Promise.all([
      fetchProductsForCategory(MEN_CATEGORY_ID, "/category/18334/men-s-shoes"),
      fetchProductsForCategory(WOMEN_CATEGORY_ID, "/category/18342/women-s-shoes"),
    ]);

    const allProducts = [...menProducts, ...womenProducts];
    payload.dealsFound = allProducts.length;

    const rawDeals = [];
    let skippedNotSale = 0;
    let skippedNotShippable = 0;
    let skippedBadUrl = 0;
    let keptUnknownGender = 0;
    const unknownGenderExamples = [];

    for (const p of allProducts) {
      if (!isSaleProduct(p)) {
        skippedNotSale += 1;
        continue;
      }

      if (!isShippable(p)) {
        skippedNotShippable += 1;
        continue;
      }

      const listingName = clean(p.name);
      const { gender, model } = parseGenderModel(listingName);

      if (gender === "unknown") {
        keptUnknownGender += 1;
        if (unknownGenderExamples.length < 20) {
          unknownGenderExamples.push(listingName);
        }
      }

      const salePrice = getSalePrice(p);
      const originalPrice = getOriginalPrice(p);
      const url = listingUrl(p);

      if (!url) {
        skippedBadUrl += 1;
        continue;
      }

      rawDeals.push({
        schemaVersion: SCHEMA_VERSION,

        listingName,

        brand: titleCase(p.label || p.brandName),
        model: model || listingName,

        salePrice,
        originalPrice,
        discountPercent: computeDiscountPercent(originalPrice, salePrice),

        salePriceLow: null,
        salePriceHigh: null,
        originalPriceLow: null,
        originalPriceHigh: null,
        discountPercentUpTo: null,

        store: STORE,

        listingURL: url,
        imageURL: imageUrl(p),

        gender,
        shoeType: "unknown",
      });
    }

    const deals = dedupeDeals(rawDeals);

    payload.deals = deals;
    payload.dealsExtracted = deals.length;
    payload.ok = true;
    payload.error = null;

    payload.pageNotes.push(
      {
        categoryId: MEN_CATEGORY_ID,
        label: "Men's Shoes",
        rowsReturned: menProducts.length,
      },
      {
        categoryId: WOMEN_CATEGORY_ID,
        label: "Women's Shoes",
        rowsReturned: womenProducts.length,
      }
    );

    payload.debug = {
      saleCategoryIdKnown: SALE_CATEGORY_ID,
      menRows: menProducts.length,
      womenRows: womenProducts.length,
      skippedNotSale,
      skippedNotShippable,
      skippedBadUrl,
      keptUnknownGender,
      unknownGenderExamples,
    };
  } catch (err) {
    payload.ok = false;
    payload.error = err?.message || "Unknown scraper error";
  }

  payload.scrapeDurationMs = Date.now() - started;
  payload.lastUpdated = nowIso();

  try {
    const blob = await put("running-center.json", JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    return res.status(payload.ok ? 200 : 500).json({
      ok: payload.ok,
      error: payload.error,
      store: payload.store,
      via: payload.via,
      pagesFetched: payload.pagesFetched,
      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,
      scrapeDurationMs: payload.scrapeDurationMs,
      debug: payload.debug,
      blobUrl: blob.url,
    });
  } catch (uploadErr) {
    return res.status(500).json({
      ok: false,
      error: `Scraped but blob upload failed: ${uploadErr?.message || "Unknown upload error"}`,
      payload,
    });
  }
}
