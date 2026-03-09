// /api/scrapers/performance-running-outfitters.js

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

const MAX_PAGES = 15;

export default async function handler(req, res) {
  const start = Date.now();

  // CRON auth (temporarily commented out for testing)
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  try {
    const deals = [];
    const seen = new Set();
    const sourceUrls = [];
    const pageNotes = [];
    const dealsByCollection = {};

    const dropCounts = {
      totalProductsSeen: 0,
      dropped_missingTitle: 0,
      dropped_missingBrand: 0,
      dropped_missingHandle: 0,
      dropped_missingPrice: 0,
      dropped_notADeal: 0,
      dropped_duplicate: 0,
      kept: 0,
    };

    let pagesFetched = 0;
    let dealsFound = 0;

    for (const collection of COLLECTIONS) {
      dealsByCollection[collection] = 0;

      let noNewPagesInARow = 0;

      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = `${BASE}/collections/${collection}/products.json?limit=250&page=${page}`;
        sourceUrls.push(url);

        const resp = await fetch(url, {
          headers: {
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
            "accept": "application/json,text/plain,*/*",
          },
        });

        if (!resp.ok) {
          pageNotes.push({
            collection,
            page,
            url,
            status: resp.status,
            productsReturned: 0,
            uniqueAdded: 0,
            note: `Stopping collection: HTTP ${resp.status}`,
          });
          break;
        }

        const data = await resp.json();
        const products = Array.isArray(data?.products) ? data.products : [];

        pagesFetched += 1;
        dealsFound += products.length;
        dropCounts.totalProductsSeen += products.length;

        if (!products.length) {
          pageNotes.push({
            collection,
            page,
            url,
            status: resp.status,
            productsReturned: 0,
            uniqueAdded: 0,
            note: "Stopping collection: empty products array",
          });
          break;
        }

        let uniqueAdded = 0;

        for (const p of products) {
          const brand = String(p.vendor || "").trim();
          const title = String(p.title || "").trim();
          const handle = String(p.handle || "").trim();

          if (!title) {
            dropCounts.dropped_missingTitle += 1;
            continue;
          }
          if (!brand) {
            dropCounts.dropped_missingBrand += 1;
            continue;
          }
          if (!handle) {
            dropCounts.dropped_missingHandle += 1;
            continue;
          }

          const listingURL = `${BASE}/products/${handle}`;

          if (seen.has(listingURL)) {
            dropCounts.dropped_duplicate += 1;
            continue;
          }

          const variants = Array.isArray(p.variants) ? p.variants : [];
          const availableVariants = variants.filter(v => v && v.available);

          let salePrice = null;
          let originalPrice = null;

          for (const v of availableVariants) {
            const price = toNumber(v.price);
            const compare = toNumber(v.compare_at_price);

            if (price != null && (salePrice == null || price < salePrice)) {
              salePrice = price;
            }

            if (compare != null && (originalPrice == null || compare > originalPrice)) {
              originalPrice = compare;
            }
          }

          if (salePrice == null || originalPrice == null) {
            dropCounts.dropped_missingPrice += 1;
            continue;
          }

          if (!(originalPrice > salePrice)) {
            dropCounts.dropped_notADeal += 1;
            continue;
          }

          const listingName = `${brand} ${title}`.trim();
          const model = parseModel(title);
          const gender = parseGender(title);
          const imageURL = firstImageUrl(p);
          const discountPercent = calcDiscountPercent(originalPrice, salePrice);

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
            shoeType: "unknown",
          });

          seen.add(listingURL);
          uniqueAdded += 1;
          dealsByCollection[collection] += 1;
          dropCounts.kept += 1;
        }

        pageNotes.push({
          collection,
          page,
          url,
          status: resp.status,
          productsReturned: products.length,
          uniqueAdded,
        });

        if (uniqueAdded === 0) {
          noNewPagesInARow += 1;
        } else {
          noNewPagesInARow = 0;
        }

        if (noNewPagesInARow >= 2) {
          pageNotes.push({
            collection,
            page,
            url,
            status: resp.status,
            productsReturned: products.length,
            uniqueAdded,
            note: "Stopping collection: 2 consecutive pages with no new unique products",
          });
          break;
        }
      }
    }

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - start,

      ok: true,
      error: null,

      deals,

      pageNotes,
      dealsByCollection,
      dropCounts,
    };

    const blob = await put(
      "pro.json",
      JSON.stringify(payload, null, 2),
      {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
      }
    );

    return res.status(200).json({
      success: true,
      blobUrl: blob.url,
      deals: deals.length,
      pagesFetched,
      durationMs: payload.scrapeDurationMs,
      dealsByCollection,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
      durationMs: Date.now() - start,
    });
  }
}

function toNumber(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseGender(title) {
  const t = String(title || "").toUpperCase();
  if (/\bWOMEN'?S\b/.test(t) || /\bWOMENS\b/.test(t)) return "womens";
  if (/\bMEN'?S\b/.test(t) || /\bMENS\b/.test(t)) return "mens";
  if (/\bUNISEX\b/.test(t)) return "unisex";
  return "unknown";
}

function parseModel(title) {
  return String(title || "")
    .replace(/^WOMEN'?S\s+/i, "")
    .replace(/^WOMENS\s+/i, "")
    .replace(/^MEN'?S\s+/i, "")
    .replace(/^MENS\s+/i, "")
    .replace(/^UNISEX\s+/i, "")
    .trim();
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

function firstImageUrl(product) {
  if (Array.isArray(product?.images) && product.images.length) {
    const img = product.images[0];
    if (typeof img === "string") return img;
    if (img?.src) return img.src;
  }
  if (product?.image?.src) return product.image.src;
  return "";
}
