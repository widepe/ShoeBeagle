// /api/scrapers/performance-running-json.js
//
// Shopify JSON collection scraper
// Writes blob: pro.json
//
// Uses Shopify endpoint:
// /collections/{collection}/products.json
//
// Collections scraped:
// womens-sale-shoes
// mens-sale-shoes
// sale-super-shoes
//
// Pagination: ?limit=250&page=N

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Performance Running";
const SCHEMA_VERSION = 1;
const VIA = "shopify-json";

const BASE = "https://performancerunning.com";

const COLLECTIONS = [
  "womens-sale-shoes",
  "mens-sale-shoes",
  "sale-super-shoes",
];

const MAX_PAGES = 20;

export default async function handler(req, res) {

  const start = Date.now();

  // CRON auth (disabled for testing)
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const deals = [];
  const sourceUrls = [];

  let pagesFetched = 0;
  let dealsFound = 0;

  for (const collection of COLLECTIONS) {

    for (let page = 1; page <= MAX_PAGES; page++) {

      const url =
        `${BASE}/collections/${collection}/products.json?limit=250&page=${page}`;

      sourceUrls.push(url);

      const resp = await fetch(url);

      if (!resp.ok) break;

      const data = await resp.json();

      const products = data.products || [];

      if (!products.length) break;

      pagesFetched++;

      for (const p of products) {

        dealsFound++;

        const brand = (p.vendor || "").trim();

        const title = (p.title || "").trim();

        const listingName = `${brand} ${title}`.trim();

        const listingURL = `${BASE}/products/${p.handle}`;

        const imageURL = p.images?.[0]?.src || "";

        const variants = p.variants || [];

        let salePrice = null;
        let originalPrice = null;

        for (const v of variants) {

          if (!v.available) continue;

          const price = Number(v.price);
          const compare = Number(v.compare_at_price);

          if (!salePrice || price < salePrice) salePrice = price;

          if (compare) originalPrice = compare;
        }

        if (!salePrice || !originalPrice) continue;

        const discountPercent =
          Math.round((originalPrice - salePrice) / originalPrice * 100);

        const gender = parseGender(title);

        const model = parseModel(title);

        deals.push({
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
          shoeType: "unknown"
        });
      }
    }
  }

  const payload = {
    store: STORE,
    schemaVersion: 1,

    lastUpdated: new Date().toISOString(),
    via: VIA,

    sourceUrls,
    pagesFetched,

    dealsFound,
    dealsExtracted: deals.length,

    scrapeDurationMs: Date.now() - start,

    ok: true,
    error: null,

    deals
  };

  const blob = await put(
    "pro.json",
    JSON.stringify(payload, null, 2),
    {
      access: "public",
      addRandomSuffix: false
    }
  );

  res.json({
    success: true,
    blobUrl: blob.url,
    deals: deals.length,
    pagesFetched,
    durationMs: payload.scrapeDurationMs
  });
}

function parseGender(title) {

  const t = title.toUpperCase();

  if (t.includes("WOMEN")) return "womens";
  if (t.includes("MEN")) return "mens";
  if (t.includes("UNISEX")) return "unisex";

  return "unknown";
}

function parseModel(title) {

  return title
    .replace(/WOMEN'?S/i, "")
    .replace(/MEN'?S/i, "")
    .replace(/UNISEX/i, "")
    .trim();
}
