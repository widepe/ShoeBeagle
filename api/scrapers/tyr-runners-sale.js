// /api/scrapers/tyr-runners-sale.js
//
// TYR running footwear sale scraper
// - Uses Shopify collection products.json directly
// - Scrapes the TYR runners collection
// - Paginates products.json pages until empty
// - Keeps only true sale deals (salePrice < originalPrice)
// - Skips hidden-price items if any hidden-price language appears
// - Response includes readable metadata, dropCounts, and pageSummaries
// - Saved blob contains only top-level metadata + deals array
// - shoeType is unknown unless explicitly defined in JSON/tags/category text
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//
// TEST:
//   /api/scrapers/tyr-runners-sale
//
// NOTE:
// - CRON_SECRET block is included but temporarily commented out for testing.

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "TYR";
const SCHEMA_VERSION = 1;
const VIA = "shopify-products-json";
const BLOB_PATH = "tyr-runners-sale.json";

const BASE_URL = "https://tyr.com";
const COLLECTION_PATH = "/collections/footwear-runners";
const PRODUCTS_LIMIT = 250;

const HIDDEN_PRICE_PATTERNS = [
  "see price in cart",
  "see price in bag",
  "add to bag to see price",
  "add to cart to see price",
  "price in cart",
  "price in bag",
  "see price at checkout",
  "call for price",
  "login to see price",
];

function nowIso() {
  return new Date().toISOString();
}

function cleanWhitespace(str) {
  return String(str ?? "").replace(/\s+/g, " ").trim();
}

function lc(str) {
  return cleanWhitespace(str).toLowerCase();
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function roundMoney(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function roundPercent(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function inferBrand(product) {
  const vendor = cleanWhitespace(product?.vendor);
  if (!vendor) return null;
  if (/^tyr(\s+us)?$/i.test(vendor)) return "TYR";
  return vendor;
}

function inferGender(product) {
  const title = lc(product?.title);
  const tags = asArray(product?.tags).map(lc).join(" ");

  const blob = `${title} ${tags}`;

  const hasWomen =
    /\bwomen'?s\b/.test(blob) ||
    /\bwomens\b/.test(blob) ||
    /\bfemale\b/.test(blob) ||
    asArray(product?.tags).some((t) => /^women$/i.test(String(t)));

  const hasMen =
    /\bmen'?s\b/.test(blob) ||
    /\bmens\b/.test(blob) ||
    /\bmale\b/.test(blob) ||
    asArray(product?.tags).some((t) => /^men$/i.test(String(t)));

  const hasUnisex =
    /\bunisex\b/.test(blob) ||
    asArray(product?.tags).some((t) => /^unisex$/i.test(String(t)));

  if (hasUnisex) return "unisex";
  if (hasWomen && !hasMen) return "womens";
  if (hasMen && !hasWomen) return "mens";
  if (hasMen && hasWomen) return "unisex";
  return "unknown";
}

function inferShoeType(product) {
  const productType = lc(product?.product_type);
  const tags = asArray(product?.tags).map(lc).join(" ");
  const body = lc(product?.body_html);

  const blob = `${productType} ${tags} ${body}`;

  if (
    /\btrail\b/.test(blob) ||
    /\btrail running\b/.test(blob)
  ) {
    return "trail";
  }

  if (
    /\btrack\b/.test(blob) ||
    /\btrack and field\b/.test(blob) ||
    /\bspike\b/.test(blob) ||
    /\bspikes\b/.test(blob)
  ) {
    return "track";
  }

  if (
    /\broad\b/.test(blob) ||
    /\broad running\b/.test(blob)
  ) {
    return "road";
  }

  return "unknown";
}

function inferModel(product, brand) {
  const title = cleanWhitespace(product?.title);
  if (!title) return null;

  let model = title.replace(/^(men's|mens|women's|womens|unisex)\s+/i, "").trim();

  if (brand) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    model = model.replace(new RegExp(`^${escaped}\\s+`, "i"), "").trim();
  }

  return model || title;
}

function buildListingUrl(product) {
  const handle = cleanWhitespace(product?.handle);
  if (!handle) return null;
  return `${BASE_URL}/products/${handle}`;
}

function buildImageUrl(product) {
  const primaryImage =
    product?.image?.src ||
    product?.images?.[0]?.src ||
    product?.variants?.[0]?.featured_image?.src ||
    null;

  const imageUrl = cleanWhitespace(primaryImage);
  if (!imageUrl) return null;

  if (imageUrl.startsWith("//")) return `https:${imageUrl}`;
  return imageUrl;
}

function textBlob(product) {
  return [
    lc(product?.title),
    lc(product?.body_html),
    lc(product?.product_type),
    ...asArray(product?.tags).map(lc),
  ]
    .filter(Boolean)
    .join(" ");
}

function hasHiddenPriceLanguage(product) {
  const blob = textBlob(product);
  return HIDDEN_PRICE_PATTERNS.some((p) => blob.includes(p));
}

function getSalePricing(product) {
  const variants = asArray(product?.variants);

  const pricedVariants = variants
    .map((v) => {
      const sale = toNumber(v?.price);
      const original = toNumber(v?.compare_at_price);
      return {
        sale,
        original,
        available: !!v?.available,
      };
    })
    .filter((v) => Number.isFinite(v.sale) && Number.isFinite(v.original) && v.sale < v.original);

  if (!pricedVariants.length) return null;

  const salePrices = pricedVariants.map((v) => v.sale);
  const originalPrices = pricedVariants.map((v) => v.original);

  const salePriceLow = roundMoney(Math.min(...salePrices));
  const salePriceHigh = roundMoney(Math.max(...salePrices));
  const originalPriceLow = roundMoney(Math.min(...originalPrices));
  const originalPriceHigh = roundMoney(Math.max(...originalPrices));

  const exactSale = salePriceLow === salePriceHigh ? salePriceLow : null;
  const exactOriginal = originalPriceLow === originalPriceHigh ? originalPriceLow : null;

  const discountPercent =
    exactSale != null && exactOriginal != null
      ? roundPercent(((exactOriginal - exactSale) / exactOriginal) * 100)
      : null;

  const discountPercentUpTo = roundPercent(
    ((originalPriceHigh - salePriceLow) / originalPriceHigh) * 100
  );

  return {
    salePrice: exactSale,
    originalPrice: exactOriginal,
    discountPercent,
    salePriceLow,
    salePriceHigh,
    originalPriceLow,
    originalPriceHigh,
    discountPercentUpTo,
  };
}

function initDropCounts() {
  return {
    totalProducts: 0,
    dropped_hiddenPrice: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingBrand: 0,
    dropped_missingModel: 0,
    dropped_wrongGenderCategory: 0,
    dropped_notSale: 0,
    dropped_duplicateProduct: 0,
  };
}

function initGenderCounts() {
  return {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };
}

function increment(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + by;
}

function addGenderCount(counts, gender) {
  if (!counts[gender]) counts[gender] = 0;
  counts[gender] += 1;
}

async function fetchProductsPage(page) {
  const url = `${BASE_URL}${COLLECTION_PATH}/products.json?limit=${PRODUCTS_LIMIT}&page=${page}&sort_by=manual`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    },
  });

  const text = await resp.text();
  const json = safeJson(text);

  if (!resp.ok || !json) {
    throw new Error(`TYR products.json failed for page ${page}: ${resp.status} ${text.slice(0, 400)}`);
  }

  return {
    url,
    products: asArray(json?.products),
  };
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  // CRON_SECRET
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const sourceUrls = [];
  const pageSummaries = [];
  const dropCounts = initDropCounts();
  const genderCounts = initGenderCounts();
  const deals = [];
  const seen = new Set();

  let pagesFetched = 0;
  let dealsFound = 0;

  try {
    let page = 1;

    while (true) {
      const { url, products } = await fetchProductsPage(page);

      sourceUrls.push(url);

      const pageSummary = {
        page,
        url,
        productsReturned: products.length,
        dealsExtracted: 0,
        droppedDeals: 0,
        genderCounts: initGenderCounts(),
        dropCounts: initDropCounts(),
      };

      pageSummaries.push(pageSummary);

      if (!products.length) {
        break;
      }

      pagesFetched += 1;
      dealsFound += products.length;
      dropCounts.totalProducts += products.length;
      pageSummary.dropCounts.totalProducts = products.length;

      for (const product of products) {
        const fail = (reason) => {
          increment(dropCounts, reason);
          increment(pageSummary.dropCounts, reason);
          pageSummary.droppedDeals += 1;
        };

        const key = product?.id != null
          ? `product:${product.id}`
          : `handle:${cleanWhitespace(product?.handle)}`;

        if (seen.has(key)) {
          fail("dropped_duplicateProduct");
          continue;
        }

        if (hasHiddenPriceLanguage(product)) {
          fail("dropped_hiddenPrice");
          continue;
        }

        const listingName = cleanWhitespace(product?.title);
        const brand = inferBrand(product);
        const model = inferModel(product, brand);
        const listingURL = buildListingUrl(product);
        const imageURL = buildImageUrl(product);
        const gender = inferGender(product);
        const pricing = getSalePricing(product);

        if (!listingURL) {
          fail("dropped_missingListingURL");
          continue;
        }

        if (!imageURL) {
          fail("dropped_missingImageURL");
          continue;
        }

        if (!brand) {
          fail("dropped_missingBrand");
          continue;
        }

        if (!model) {
          fail("dropped_missingModel");
          continue;
        }

        if (!(gender === "mens" || gender === "womens" || gender === "unisex" || gender === "unknown")) {
          fail("dropped_wrongGenderCategory");
          continue;
        }

        if (!pricing) {
          fail("dropped_notSale");
          continue;
        }

        deals.push({
          schemaVersion: SCHEMA_VERSION,

          listingName,

          brand,
          model,

          salePrice: pricing.salePrice,
          originalPrice: pricing.originalPrice,
          discountPercent: pricing.discountPercent,

          salePriceLow: pricing.salePriceLow,
          salePriceHigh: pricing.salePriceHigh,
          originalPriceLow: pricing.originalPriceLow,
          originalPriceHigh: pricing.originalPriceHigh,
          discountPercentUpTo: pricing.discountPercentUpTo,

          store: STORE,

          listingURL,
          imageURL,

          gender,
          shoeType: inferShoeType(product),
        });

        seen.add(key);
        pageSummary.dealsExtracted += 1;
        addGenderCount(pageSummary.genderCounts, gender);
        addGenderCount(genderCounts, gender);
      }

      if (products.length < PRODUCTS_LIMIT) {
        break;
      }

      page += 1;
    }

    const scrapeDurationMs = Date.now() - startedAt;

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,

      pagesFetched,

      dealsFound,
      dealsExtracted: deals.length,
      dealsForMens: genderCounts.mens,
      dealsForWomens: genderCounts.womens,
      dealsForUnisex: genderCounts.unisex,
      dealsForUnknown: genderCounts.unknown,

      scrapeDurationMs,

      ok: true,
      error: null,

      dropCounts,

      deals,
    };

    const blob = await put(BLOB_PATH, JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobPath: BLOB_PATH,
      blobUrl: blob.url,

      pagesFetched,
      dealsFound,
      dealsExtracted: deals.length,
      dealsForMens: genderCounts.mens,
      dealsForWomens: genderCounts.womens,
      dealsForUnisex: genderCounts.unisex,
      dealsForUnknown: genderCounts.unknown,

      scrapeDurationMs,
      ok: true,
      error: null,

      dropCounts,
      pageSummaries,
      sourceUrls,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: error?.message || "Unknown error",
      scrapeDurationMs: Date.now() - startedAt,
      pagesFetched,
      dealsFound,
      dealsExtracted: deals.length,
      dealsForMens: genderCounts.mens,
      dealsForWomens: genderCounts.womens,
      dealsForUnisex: genderCounts.unisex,
      dealsForUnknown: genderCounts.unknown,
      dropCounts,
      pageSummaries,
      sourceUrls,
      ok: false,
    });
  }
}
