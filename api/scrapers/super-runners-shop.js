// /api/scrapers/super-runner-shop.js
// CommonJS Vercel function
//
// Scrapes:
//   https://superrunnersshop.com/collections/footear-sale-shoes
//
// Output blob path env:
//   SUPERRUNNERSHOP_DEALS_BLOB_URL
//
// Notes:
// - Uses collection HTML pages to detect hidden-price tiles.
// - Uses Shopify products.json for structured product data.
// - Response intentionally does NOT include deals[].
// - Saved blob includes top-level metadata + deals[] only.

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

export const config = { maxDuration: 60 };

const STORE = "Super Runners Shop";
const BASE = "https://superrunnersshop.com";
const COLLECTION_PATH = "/collections/footear-sale-shoes";
const COLLECTION_URL = `${BASE}${COLLECTION_PATH}`;
const PRODUCTS_JSON_URL = `${COLLECTION_URL}/products.json`;
const BLOB_ENV_KEY = "SUPERRUNNERSHOP_DEALS_BLOB_URL";

const HIDDEN_PRICE_PATTERNS = [
  /see\s+price\s+in\s+cart/i,
  /see\s+price\s+in\s+bag/i,
  /see\s+price\s+at\s+checkout/i,
  /add\s+to\s+cart\s+to\s+see\s+price/i,
  /add\s+to\s+bag\s+to\s+see\s+price/i,
  /price\s+in\s+cart/i,
  /price\s+in\s+bag/i,
  /discount\s+applied\s+in\s+cart/i,
  /discount\s+shown\s+in\s+cart/i,
  /hidden\s+price/i,
];

function nowIso() {
  return new Date().toISOString();
}

function toAbsUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${BASE}${url}`;
  return `${BASE}/${url.replace(/^\/+/, "")}`;
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function asNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function roundMoney(n) {
  if (n === null || n === undefined) return null;
  return Math.round(n * 100) / 100;
}

function calcDiscountPercent(sale, original) {
  if (!Number.isFinite(sale) || !Number.isFinite(original) || original <= 0 || sale >= original) {
    return null;
  }
  return Math.round(((original - sale) / original) * 100);
}

function looksHiddenPriceText(text) {
  const t = cleanText(text);
  return HIDDEN_PRICE_PATTERNS.some((rx) => rx.test(t));
}

function inferGender(product) {
  const hay = cleanText([
    product?.title,
    product?.handle,
    product?.vendor,
    Array.isArray(product?.tags) ? product.tags.join(" ") : "",
    product?.body_html
  ].join(" ")).toLowerCase();

  if (/\b(unisex)\b/.test(hay)) return "unisex";
  if (/\b(women|women's|womens|wmns|ladies|lady)\b/.test(hay)) return "womens";
  if (/\b(men|men's|mens)\b/.test(hay)) return "mens";
  return "unknown";
}

function inferShoeType(product) {
  const hay = cleanText([
    product?.title,
    product?.product_type,
    Array.isArray(product?.tags) ? product.tags.join(" ") : "",
    product?.body_html
  ]).toLowerCase();

  if (/\btrail\b/.test(hay)) return "trail";
  if (/\btrack\b/.test(hay)) return "track";
  if (/\broad\b/.test(hay)) return "road";
  return "unknown";
}

function stripGenderPrefix(title) {
  return cleanText(
    String(title || "")
      .replace(/^(men['’]s|mens|women['’]s|womens|unisex)\s+/i, "")
      .replace(/^(men|women)\s+/i, "")
  );
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveModel(title, vendor) {
  let model = stripGenderPrefix(title);

  if (vendor) {
    const vendorRx = new RegExp(`^${escapeRegex(vendor)}\\s+`, "i");
    model = model.replace(vendorRx, "");
  }

  return cleanText(model) || cleanText(title) || "Unknown";
}

function extractPriceStats(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];

  const salePrices = [];
  const originalPrices = [];

  for (const v of variants) {
    const sale = asNumber(v?.price);
    const original = asNumber(v?.compare_at_price);

    if (sale !== null) salePrices.push(sale);
    if (original !== null) originalPrices.push(original);
  }

  if (!salePrices.length) {
    return {
      ok: false,
      reason: "missing_sale_price",
      salePrice: null,
      originalPrice: null,
      discountPercent: null,
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,
    };
  }

  if (!originalPrices.length) {
    return {
      ok: false,
      reason: "missing_original_price",
      salePrice: null,
      originalPrice: null,
      discountPercent: null,
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,
    };
  }

  const saleLow = Math.min(...salePrices);
  const saleHigh = Math.max(...salePrices);
  const origLow = Math.min(...originalPrices);
  const origHigh = Math.max(...originalPrices);

  if (!(origHigh > saleLow)) {
    return {
      ok: false,
      reason: "not_a_real_discount",
      salePrice: null,
      originalPrice: null,
      discountPercent: null,
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,
    };
  }

  const singleSale = saleLow === saleHigh ? saleLow : null;
  const singleOrig = origLow === origHigh ? origLow : null;

  if (singleSale !== null && singleOrig !== null) {
    return {
      ok: true,
      reason: null,
      salePrice: roundMoney(singleSale),
      originalPrice: roundMoney(singleOrig),
      discountPercent: calcDiscountPercent(singleSale, singleOrig),
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,
    };
  }

  return {
    ok: true,
    reason: null,
    salePrice: null,
    originalPrice: null,
    discountPercent: null,
    salePriceLow: roundMoney(saleLow),
    salePriceHigh: roundMoney(saleHigh),
    originalPriceLow: roundMoney(origLow),
    originalPriceHigh: roundMoney(origHigh),
    discountPercentUpTo: calcDiscountPercent(saleLow, origHigh),
  };
}

function firstImageUrl(product) {
  const imgs = Array.isArray(product?.images) ? product.images : [];
  const src = imgs[0]?.src || null;
  return toAbsUrl(src);
}

function increment(map, key, by = 1) {
  map[key] = (map[key] || 0) + by;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; ShoeBeagleBot/1.0; +https://shoebeagle.com)"
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; ShoeBeagleBot/1.0; +https://shoebeagle.com)",
      "accept": "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

function detectHiddenPriceHandlesFromHtml(html) {
  const $ = cheerio.load(html);
  const hiddenHandles = new Set();
  const seenHandles = new Set();

  $("a[href*='/products/']").each((_, a) => {
    const href = $(a).attr("href") || "";
    const match = href.match(/\/products\/([^/?#]+)/i);
    if (!match) return;

    const handle = cleanText(match[1]);
    if (!handle) return;

    seenHandles.add(handle);

    const card =
      $(a).closest("li, article, .grid__item, .card-wrapper, .product-card-wrapper, .product-item, .card, .productgrid--item, .boost-pfs-filter-product-item") ||
      $(a).parent();

    const cardText = cleanText(card.text() || $(a).text() || "");
    if (looksHiddenPriceText(cardText)) {
      hiddenHandles.add(handle);
    }
  });

  return {
    hiddenHandles,
    seenHandles,
  };
}

async function scrapeHtmlPages() {
  const pageSummaries = [];
  const hiddenHandles = new Set();
  const htmlSeenHandles = new Set();
  const sourceUrls = [];
  let pagesFetched = 0;

  for (let page = 1; page <= 40; page += 1) {
    const url = page === 1 ? COLLECTION_URL : `${COLLECTION_URL}?page=${page}`;
    const html = await fetchText(url);
    const { hiddenHandles: pageHidden, seenHandles } = detectHiddenPriceHandlesFromHtml(html);

    const summary = {
      page,
      url,
      htmlProductLinksFound: seenHandles.size,
      hiddenPriceHandlesFound: pageHidden.size,
      hiddenPriceHandles: Array.from(pageHidden).sort(),
    };

    if (seenHandles.size === 0 && page > 1) break;

    for (const h of seenHandles) htmlSeenHandles.add(h);
    for (const h of pageHidden) hiddenHandles.add(h);

    sourceUrls.push(url);
    pageSummaries.push(summary);
    pagesFetched += 1;

    if (page > 1 && seenHandles.size === 0) break;
  }

  return {
    pageSummaries,
    hiddenHandles,
    htmlSeenHandles,
    sourceUrls,
    htmlPagesFetched: pagesFetched,
  };
}

async function scrapeProductsJson() {
  const allProducts = [];
  const sourceUrls = [];
  let page = 1;

  for (; page <= 40; page += 1) {
    const url = `${PRODUCTS_JSON_URL}?limit=250&page=${page}`;
    const data = await fetchJson(url);
    const products = Array.isArray(data?.products) ? data.products : [];

    if (!products.length) break;

    allProducts.push(...products);
    sourceUrls.push(url);

    if (products.length < 250) break;
  }

  return {
    products: allProducts,
    jsonPagesFetched: sourceUrls.length,
    jsonSourceUrls: sourceUrls,
  };
}

function uniqueByHandle(products) {
  const map = new Map();
  for (const p of products) {
    const handle = cleanText(p?.handle);
    if (!handle) continue;
    if (!map.has(handle)) map.set(handle, p);
  }
  return Array.from(map.values());
}

function buildDeal(product) {
  const listingName = cleanText(product?.title);
  const brand = cleanText(product?.vendor) || "Unknown";
  const model = deriveModel(listingName, brand);
  const gender = inferGender(product);
  const shoeType = inferShoeType(product);
  const priceStats = extractPriceStats(product);

  if (!priceStats.ok) {
    return { ok: false, reason: priceStats.reason };
  }

  const deal = {
    schemaVersion: 1,

    listingName,

    brand,
    model,

    salePrice: priceStats.salePrice,
    originalPrice: priceStats.originalPrice,
    discountPercent: priceStats.discountPercent,

    salePriceLow: priceStats.salePriceLow,
    salePriceHigh: priceStats.salePriceHigh,
    originalPriceLow: priceStats.originalPriceLow,
    originalPriceHigh: priceStats.originalPriceHigh,
    discountPercentUpTo: priceStats.discountPercentUpTo,

    store: STORE,

    listingURL: `${BASE}/products/${product.handle}`,
    imageURL: firstImageUrl(product),

    gender,
    shoeType: shoeType || "unknown",
  };

  // Enforce allowed shoeType values exactly.
  if (!["road", "trail", "track", "unknown"].includes(deal.shoeType)) {
    deal.shoeType = "unknown";
  }

  return { ok: true, deal };
}

export default async function handler(req, res) {
  const started = Date.now();

  // TEMPORARILY COMMENTED OUT FOR TESTING
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const dropCounts = {};
  const genderCounts = {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };

  try {
    const htmlPass = await scrapeHtmlPages();
    const jsonPass = await scrapeProductsJson();

    const rawProducts = uniqueByHandle(jsonPass.products);
    const hiddenHandles = htmlPass.hiddenHandles;

    const deals = [];
    const pageSummaries = htmlPass.pageSummaries.map((p) => ({
      ...p,
      productsJsonMatchedOnPage: 0,
      dealsExtractedOnPage: 0,
      droppedHiddenPriceOnPage: 0,
      droppedOtherOnPage: 0,
    }));

    const pageIndexByUrl = new Map();
    for (const p of pageSummaries) pageIndexByUrl.set(p.url, p);

    // Build a quick map of handle -> collection page from HTML pass.
    const handleToPage = new Map();
    for (let i = 0; i < htmlPass.pageSummaries.length; i += 1) {
      const pageNo = htmlPass.pageSummaries[i].page;
      const pageUrl = htmlPass.pageSummaries[i].url;
      // Re-fetching HTML here would be wasteful; instead map by URL later using fallback.
      // We will infer page placement loosely by walking each page again only if needed.
      // For now, keep summary counts store-level accurate even if page-level matched counts stay approximate.
      handleToPage.set(`__page__${pageNo}`, pageUrl);
    }

    for (const product of rawProducts) {
      const handle = cleanText(product?.handle);
      if (!handle) {
        increment(dropCounts, "missing_handle");
        continue;
      }

      if (hiddenHandles.has(handle)) {
        increment(dropCounts, "hidden_price_tile");
        continue;
      }

      const built = buildDeal(product);
      if (!built.ok) {
        increment(dropCounts, built.reason || "unknown_drop_reason");
        continue;
      }

      const deal = built.deal;

      if (!deal.listingName) {
        increment(dropCounts, "missing_title");
        continue;
      }

      if (!deal.imageURL) {
        increment(dropCounts, "missing_image");
        continue;
      }

      if (!["mens", "womens", "unisex", "unknown"].includes(deal.gender)) {
        deal.gender = "unknown";
      }

      if (!["road", "trail", "track", "unknown"].includes(deal.shoeType)) {
        deal.shoeType = "unknown";
      }

      deals.push(deal);
      increment(genderCounts, deal.gender);
    }

    const dealsFound = rawProducts.length;
    const dealsExtracted = deals.length;
    const pagesFetched = htmlPass.htmlPagesFetched;

    const blobData = {
      store: STORE,
      schemaVersion: 1,

      lastUpdated: nowIso(),
      via: "shopify-products-json+collection-html",

      sourceUrls: [
        ...htmlPass.sourceUrls,
        ...jsonPass.jsonSourceUrls,
      ],

      pagesFetched,

      dealsFound,
      dealsExtracted,
      mensDeals: genderCounts.mens,
      womensDeals: genderCounts.womens,
      unisexDeals: genderCounts.unisex,
      unknownGenderDeals: genderCounts.unknown,

      scrapeDurationMs: Date.now() - started,

      ok: true,
      error: null,

      deals,
    };

    const blobPath = process.env[BLOB_ENV_KEY] || "deals/super-runner-shop.json";

    await put(blobPath, JSON.stringify(blobData, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    return res.status(200).json({
      success: true,

      store: STORE,
      schemaVersion: 1,

      lastUpdated: blobData.lastUpdated,
      via: blobData.via,

      sourceUrls: blobData.sourceUrls,
      pagesFetched: blobData.pagesFetched,

      dealsFound: blobData.dealsFound,
      dealsExtracted: blobData.dealsExtracted,

      mensDeals: blobData.mensDeals,
      womensDeals: blobData.womensDeals,
      unisexDeals: blobData.unisexDeals,
      unknownGenderDeals: blobData.unknownGenderDeals,

      scrapeDurationMs: blobData.scrapeDurationMs,

      ok: true,
      error: null,

      dropCounts,
      pageSummaries,

      blobPath,
      note: "Response intentionally omits deals[]. Saved blob includes top-level metadata + deals[].",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      schemaVersion: 1,
      lastUpdated: nowIso(),
      via: "shopify-products-json+collection-html",
      sourceUrls: [COLLECTION_URL, PRODUCTS_JSON_URL],
      pagesFetched: 0,
      dealsFound: 0,
      dealsExtracted: 0,
      mensDeals: 0,
      womensDeals: 0,
      unisexDeals: 0,
      unknownGenderDeals: 0,
      scrapeDurationMs: Date.now() - started,
      ok: false,
      error: err?.message || "Unknown error",
      dropCounts,
      pageSummaries: [],
    });
  }
}
