// /api/scrapers/bigshoes-findify.js
//
// Big Shoes running sale scraper via Findify JSON API
//
// FAST + SAFE + ACCURATE:
// - Direct JSON API only
// - No browser
// - No Firecrawl
// - No HTML parsing
// - Single request with limit=250
// - Hard-codes gender = "mens"
// - Hard-codes shoeType = "unknown"
//
// OUTPUT TOP LEVEL:
// {
//   store, schemaVersion,
//   lastUpdated, via,
//   sourceUrls, pagesFetched,
//   dealsFound, dealsExtracted,
//   scrapeDurationMs,
//   ok, error,
//   deals: [...]
// }
//
// ENV:
// - BLOB_READ_WRITE_TOKEN
// - BIGSHOES_FINDIFY_KEY   (optional)
//
// TEST:
//   /api/scrapers/bigshoes-findify
//
// CRON auth (temporarily commented out for testing):
// const auth = req.headers.authorization;
// if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
//   return res.status(401).json({ success: false, error: "Unauthorized" });
// }

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Big Shoes";
const VIA = "findify";
const SCHEMA_VERSION = 1;

const SITE_ORIGIN = "https://bigshoes.com";
const SOURCE_PAGE =
  "https://bigshoes.com/collections/sale?filters%5Bcustom_fields.activity%5D%5B0%5D=Running&filters%5Bcustom_fields.multiple_product_type%5D%5B0%5D=Shoes";

const FINDIFY_KEY =
  String(process.env.BIGSHOES_FINDIFY_KEY || "").trim() ||
  "2e37f6d2-562d-4501-9fc7-d32693d89a03";

const API_URL = `https://api.findify.io/v4/${FINDIFY_KEY}/smart-collection/collections/sale`;

const PAGE_LIMIT = 250;
const BLOB_PATH = "bigshoes.json";

function nowIso() {
  return new Date().toISOString();
}

function toNumber(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function roundPct(n) {
  return Number.isFinite(n) ? Math.round(n) : null;
}

function absUrl(pathOrUrl) {
  const s = String(pathOrUrl || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return `${SITE_ORIGIN}${s}`;
  return `${SITE_ORIGIN}/${s}`;
}

function uniqNumbers(values) {
  return [...new Set(values.filter((v) => Number.isFinite(v)).map(Number))];
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice < 0 || salePrice >= originalPrice) return null;
  return roundPct(((originalPrice - salePrice) / originalPrice) * 100);
}

function getSalePrices(item) {
  const out = [];

  if (Array.isArray(item?.price)) {
    for (const p of item.price) {
      const n = toNumber(p);
      if (n != null) out.push(n);
    }
  }

  if (Array.isArray(item?.variants)) {
    for (const v of item.variants) {
      const n = toNumber(v?.price);
      if (n != null) out.push(n);
    }
  }

  return uniqNumbers(out).sort((a, b) => a - b);
}

function getOriginalPrices(item) {
  const out = [];

  const compareAt = toNumber(item?.compare_at);
  if (compareAt != null) out.push(compareAt);

  // In your sample, custom_fields.sale_price appears to behave like an original/reference price.
  if (Array.isArray(item?.custom_fields?.sale_price)) {
    for (const v of item.custom_fields.sale_price) {
      const n = toNumber(v);
      if (n != null) out.push(n);
    }
  }

  return uniqNumbers(out).sort((a, b) => a - b);
}

function chooseImage(item) {
  return absUrl(item?.image_url || item?.image_2_url);
}

function buildDeal(item) {
  const listingName = String(item?.title || "").trim();
  const brand = String(item?.brand || "").trim();
  const model = String(item?.title || "").trim();

  const listingURL = absUrl(item?.product_url);
  const imageURL = chooseImage(item);

  if (!listingName || !brand || !model || !listingURL || !imageURL) {
    return null;
  }

  const salePrices = getSalePrices(item);
  if (!salePrices.length) return null;

  let originalPrices = getOriginalPrices(item);
  originalPrices = originalPrices.filter((op) => salePrices.some((sp) => op > sp));

  // Must have real sale + real original
  if (!originalPrices.length) return null;

  const saleLow = round2(Math.min(...salePrices));
  const saleHigh = round2(Math.max(...salePrices));
  const originalLow = round2(Math.min(...originalPrices));
  const originalHigh = round2(Math.max(...originalPrices));

  const hasSaleRange = saleLow !== saleHigh;
  const hasOriginalRange = originalLow !== originalHigh;

  let salePrice = null;
  let originalPrice = null;
  let discountPercent = null;

  if (!hasSaleRange && !hasOriginalRange) {
    salePrice = saleLow;
    originalPrice = originalLow;
    discountPercent = computeDiscountPercent(originalPrice, salePrice);
  }

  let discountPercentUpTo = null;
  if (hasSaleRange || hasOriginalRange) {
    discountPercentUpTo = computeDiscountPercent(originalHigh, saleLow);
  }

  return {
    schemaVersion: SCHEMA_VERSION,

    listingName,

    brand,
    model,

    salePrice,
    originalPrice,
    discountPercent,

    salePriceLow: hasSaleRange ? saleLow : null,
    salePriceHigh: hasSaleRange ? saleHigh : null,
    originalPriceLow: hasOriginalRange ? originalLow : null,
    originalPriceHigh: hasOriginalRange ? originalHigh : null,
    discountPercentUpTo,

    store: STORE,

    listingURL,
    imageURL,

    gender: "mens",
    shoeType: "unknown",
  };
}

function dedupeDeals(deals) {
  const seen = new Set();
  const out = [];

  for (const d of deals) {
    const key = [
      d.store || "",
      d.listingURL || "",
      d.salePrice ?? "",
      d.originalPrice ?? "",
      d.salePriceLow ?? "",
      d.salePriceHigh ?? "",
      d.originalPriceLow ?? "",
      d.originalPriceHigh ?? "",
    ].join("::");

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }

  return out;
}

async function fetchFindifyProducts() {
  const body = {
    user: {
      uid: "bigshoes-vercel",
      sid: "bigshoes-vercel",
      persist: false,
      exist: true,
    },
    t_client: Date.now(),
    key: FINDIFY_KEY,
    limit: PAGE_LIMIT,
    offset: 0,
    slot: "collections/sale",
    filters: [
      {
        name: "custom_fields.activity",
        type: "text",
        values: [{ value: "Running" }],
      },
      {
        name: "custom_fields.multiple_product_type",
        type: "text",
        values: [{ value: "Shoes" }],
      },
    ],
  };

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      origin: SITE_ORIGIN,
      referer: `${SITE_ORIGIN}/`,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Findify request failed (${response.status}): ${text.slice(0, 800)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Findify returned invalid JSON: ${text.slice(0, 800)}`);
  }

  return json;
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  // CRON SECRET
   const auth = req.headers.authorization;
   if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
     return res.status(401).json({ success: false, error: "Unauthorized" });
   } 

  let pagesFetched = 0;
  let dealsFound = 0;
  let dealsExtracted = 0;
  let ok = true;
  let error = null;

  try {
    const json = await fetchFindifyProducts();
    pagesFetched = 1;

    const items = Array.isArray(json?.items) ? json.items : [];
    dealsFound = items.length;

    const mapped = [];
    for (const item of items) {
      const deal = buildDeal(item);
      if (deal) mapped.push(deal);
    }

    const deals = dedupeDeals(mapped);
    dealsExtracted = deals.length;

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls: [SOURCE_PAGE],

      pagesFetched,

      dealsFound,
      dealsExtracted,

      scrapeDurationMs: Date.now() - startedAt,

      ok,
      error,

      deals,
    };

    const blob = await put(BLOB_PATH, JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return res.status(200).json({
      ok: true,
      store: STORE,
      via: VIA,
      pagesFetched,
      dealsFound,
      dealsExtracted,
      scrapeDurationMs: payload.scrapeDurationMs,
      blobUrl: blob.url,
    });
  } catch (err) {
    ok = false;
    error = err?.message || "Unknown error";

    return res.status(500).json({
      ok,
      store: STORE,
      via: VIA,
      pagesFetched,
      dealsFound,
      dealsExtracted,
      scrapeDurationMs: Date.now() - startedAt,
      error,
    });
  }
}
