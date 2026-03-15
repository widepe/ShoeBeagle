// /api/scrapers/bloomingdales-sale.js
//
// Bloomingdale's running sale scraper
//
// Strategy:
// 1) Use Playwright to open the women’s + men’s sale pages
// 2) Capture outgoing analytics log payloads that contain productDetails[].product.id
// 3) Collect all candidate product IDs by offset
// 4) Fetch each PDP by generic URL: /shop/product?ID=PRODUCT_ID
// 5) Extract embedded product JSON from the PDP HTML
// 6) Keep SALE ITEMS ONLY
// 7) If a product has mixed color pricing, keep ONLY the best-price color
// 8) Response is readable and does NOT include deals[]
// 9) Saved blob contains only top-level fields + deals[]
//
// Notes:
// - This uses the log payload only as an ID source.
// - It does NOT trust the log payload as the deal source.
// - It hydrates each product from its PDP JSON.
// - Hidden-price tiles/products are dropped.
// - shoeType defaults to "unknown" unless explicitly tagged in JSON.
// - Range fields are null when price is a single value.
//
// Deps you likely need:
//   npm i @vercel/blob playwright-core @sparticuz/chromium
//
// Test:
//   /api/scrapers/bloomingdales-sale

import { put } from "@vercel/blob";
import chromium from "@sparticuz/chromium";
import playwright from "playwright-core";

export const config = { maxDuration: 60 };

const STORE = "Bloomingdale's";
const SCHEMA_VERSION = 1;
const VIA = "playwright+fetch-html";
const BLOB_PATH = "bloomingdales-sale.json";

const SOURCE_PAGES = [
  {
    key: "womens",
    label: "womens",
    searchQuery: "womens running sneakers on sale",
    url: "https://www.bloomingdales.com/shop/featured/womens-running-sneakers-on-sale?ss=true",
  },
  {
    key: "mens",
    label: "mens",
    searchQuery: "mens running sneakers on sale",
    url: "https://www.bloomingdales.com/shop/featured/mens-running-sneakers-on-sale?ss=true",
  },
];

const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const PDP_FETCH_CONCURRENCY = 8;
const LOG_ENDPOINT_SNIPPET = "/userEventsConsumer/api/userevents/log";
const HIDDEN_PRICE_PATTERNS = [
  "see price in bag",
  "see price in cart",
  "price in bag",
  "price in cart",
  "add to bag to see price",
  "add to cart to see price",
  "pricing available in bag",
  "pricing available in cart",
];

export default async function handler(req, res) {
  const startedAt = Date.now();

  // CRON_SECRET
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  let browser;

  try {
    const collection = {
      womens: null,
      mens: null,
    };

    browser = await launchBrowser();

    for (const source of SOURCE_PAGES) {
      collection[source.key] = await collectIdsFromListingPage(browser, source);
    }

    const sourceUrls = SOURCE_PAGES.map((s) => s.url);
    const allCandidates = buildCandidateList(collection);

    const deals = [];
    const dropCounts = {};
    const perPageDropped = {
      womens: 0,
      mens: 0,
    };

    const dealCountsByPage = {
      womens: 0,
      mens: 0,
    };

    const seenDealKeys = new Set();

    for (let i = 0; i < allCandidates.length; i += PDP_FETCH_CONCURRENCY) {
      const batch = allCandidates.slice(i, i + PDP_FETCH_CONCURRENCY);

      const settled = await Promise.allSettled(
        batch.map((candidate) => processCandidate(candidate))
      );

      for (let j = 0; j < settled.length; j += 1) {
        const candidate = batch[j];
        const pageKey = candidate.sourceKey;
        const result = settled[j];

        if (result.status !== "fulfilled") {
          increment(dropCounts, "dropped_fetchOrParseError");
          perPageDropped[pageKey] += 1;
          continue;
        }

        const value = result.value;

        if (!value.ok) {
          increment(dropCounts, value.reason);
          perPageDropped[pageKey] += 1;
          continue;
        }

        const dedupeKey = makeDealKey(value.deal);
        if (seenDealKeys.has(dedupeKey)) {
          increment(dropCounts, "dropped_duplicate");
          perPageDropped[pageKey] += 1;
          continue;
        }

        seenDealKeys.add(dedupeKey);
        deals.push(value.deal);
        dealCountsByPage[pageKey] += 1;
      }
    }

    const genderCounts = countGenders(deals);

    const pageSummaries = SOURCE_PAGES.map((source) => {
      const collected = collection[source.key];
      return {
        page: source.label,
        url: source.url,
        offsetsObserved: collected.offsetsObserved,
        candidateIdsFound: collected.totalIds,
        dealsExtracted: dealCountsByPage[source.key],
        droppedDeals: perPageDropped[source.key],
      };
    });

    const blobData = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls,
      pagesFetched: SOURCE_PAGES.length,

      dealsFound: allCandidates.length,
      dealsExtracted: deals.length,

      dealsForMens: genderCounts.mens,
      dealsForWomens: genderCounts.womens,
      dealsForUnisex: genderCounts.unisex,
      dealsForUnknown: genderCounts.unknown,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      deals,
    };

    const blob = await put(BLOB_PATH, JSON.stringify(blobData, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobPath: BLOB_PATH,
      blobUrl: blob.url,

      pagesFetched: SOURCE_PAGES.length,

      dealsFound: allCandidates.length,
      dealsExtracted: deals.length,

      dealsForMens: genderCounts.mens,
      dealsForWomens: genderCounts.womens,
      dealsForUnisex: genderCounts.unisex,
      dealsForUnknown: genderCounts.unknown,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      dropCounts,
      pageSummaries,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: error?.message || "Unknown error",
      scrapeDurationMs: Date.now() - startedAt,
      pagesFetched: 0,
      dealsFound: 0,
      dealsExtracted: 0,
      dealsForMens: 0,
      dealsForWomens: 0,
      dealsForUnisex: 0,
      dealsForUnknown: 0,
      dropCounts: {},
      pageSummaries: [],
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

async function launchBrowser() {
  const executablePath = await chromium.executablePath();

  return playwright.chromium.launch({
    args: chromium.args,
    executablePath,
    headless: true,
  });
}

async function collectIdsFromListingPage(browser, source) {
  const context = await browser.newContext({
    userAgent: DEFAULT_HEADERS["user-agent"],
    viewport: { width: 1440, height: 2200 },
  });

  const page = await context.newPage();

  const batchesByOffset = new Map();

  page.on("request", async (request) => {
    try {
      if (!request.url().includes(LOG_ENDPOINT_SNIPPET)) return;

      const method = request.method().toUpperCase();
      let payload = null;

      if (method === "POST") {
        payload = safeJsonParse(request.postData());
      } else {
        return;
      }

      if (!payload || payload.eventType !== "search") return;
      if (payload.searchQuery !== source.searchQuery) return;
      if (!Array.isArray(payload.productDetails)) return;

      const offset = Number(payload.offset || 0);
      const ids = payload.productDetails
        .map((x) => String(x?.product?.id || "").trim())
        .filter(Boolean);

      if (!ids.length) return;

      batchesByOffset.set(offset, {
        offset,
        ids,
      });
    } catch {}
  });

  await page.goto(source.url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await wait(2500);
  await autoScrollToBottom(page);

  // give late analytics requests a chance to fire
  await wait(3000);

  const offsetsObserved = [...batchesByOffset.keys()].sort((a, b) => a - b);
  const allIds = [];
  const seen = new Set();

  for (const offset of offsetsObserved) {
    for (const id of batchesByOffset.get(offset).ids) {
      if (!seen.has(id)) {
        seen.add(id);
        allIds.push(id);
      }
    }
  }

  await context.close();

  return {
    sourceKey: source.key,
    label: source.label,
    url: source.url,
    offsetsObserved,
    totalIds: allIds.length,
    ids: allIds,
    batches: offsetsObserved.map((offset) => ({
      offset,
      count: batchesByOffset.get(offset).ids.length,
      first5Ids: batchesByOffset.get(offset).ids.slice(0, 5),
      last5Ids: batchesByOffset.get(offset).ids.slice(-5),
    })),
  };
}

async function autoScrollToBottom(page) {
  let previousHeight = -1;
  let stableRounds = 0;

  for (let i = 0; i < 20; i += 1) {
    const currentHeight = await page.evaluate(() => {
      return Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
    });

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    await wait(1200);

    const afterHeight = await page.evaluate(() => {
      return Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
    });

    if (afterHeight === previousHeight || afterHeight === currentHeight) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    previousHeight = afterHeight;

    if (stableRounds >= 3) break;
  }
}

function buildCandidateList(collection) {
  const all = [];

  for (const [sourceKey, collected] of Object.entries(collection)) {
    for (const id of collected.ids) {
      all.push({
        sourceKey,
        productId: id,
      });
    }
  }

  return all;
}

async function processCandidate(candidate) {
  const productId = String(candidate.productId);
  const pdpUrl = `https://www.bloomingdales.com/shop/product?ID=${encodeURIComponent(productId)}`;

  const html = await fetchText(pdpUrl);

  if (looksLikeHiddenPrice(html)) {
    return { ok: false, reason: "dropped_hiddenPriceTile" };
  }

  const parsed = extractProductPayloadFromHtml(html);
  const product = parsed?.product?.[0];

  if (!product) {
    return { ok: false, reason: "dropped_missingProductJson" };
  }

  if (!isSaleOnlyCandidate(product)) {
    return { ok: false, reason: "dropped_notOnSale" };
  }

  if (!isRunningShoe(product)) {
    return { ok: false, reason: "dropped_notRunningShoe" };
  }

  const bestColor = pickBestSaleColor(product);

  if (!bestColor) {
    return { ok: false, reason: "dropped_notOnSale" };
  }

  if (
    !isFiniteNumber(bestColor.salePrice) ||
    !isFiniteNumber(bestColor.originalPrice)
  ) {
    return { ok: false, reason: "dropped_missingPrice" };
  }

  if (!(bestColor.salePrice < bestColor.originalPrice)) {
    return { ok: false, reason: "dropped_notOnSale" };
  }

  const listingName = cleanText(product?.detail?.name || "");
  const brand = cleanText(product?.detail?.brand?.name || "");
  const listingURL = toAbsoluteProductUrl(
    product?.identifier?.productUrl || `/shop/product?ID=${productId}`
  );
  const imageURL = buildColorImageUrl(product, bestColor.colorId);
  const gender = inferGender(product);
  const shoeType = inferShoeType(product);
  const model = deriveModel(listingName, brand);

  if (!listingName) return { ok: false, reason: "dropped_missingListingName" };
  if (!brand) return { ok: false, reason: "dropped_missingBrand" };
  if (!listingURL) return { ok: false, reason: "dropped_missingListingURL" };
  if (!imageURL) return { ok: false, reason: "dropped_missingImageURL" };

  const discountPercent = computeDiscountPercent(
    bestColor.salePrice,
    bestColor.originalPrice
  );

  const deal = {
    schemaVersion: SCHEMA_VERSION,

    listingName,

    brand,
    model,

    salePrice: round2(bestColor.salePrice),
    originalPrice: round2(bestColor.originalPrice),
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
    shoeType,
  };

  return { ok: true, deal };
}

function isSaleOnlyCandidate(product) {
  const topPriceType = product?.pricing?.price?.priceType || {};
  if (topPriceType.onSale === true || topPriceType.upcOnSale === true) {
    return true;
  }

  const colorMap = product?.traits?.colors?.colorMap || {};
  for (const color of Object.values(colorMap)) {
    const type = color?.pricing?.price?.priceType || {};
    if (type.onSale === true || type.upcOnSale === true) return true;
  }

  return false;
}

function pickBestSaleColor(product) {
  const colorMap = product?.traits?.colors?.colorMap || {};
  const orderedColorIds = product?.traits?.colors?.orderedColorsById || Object.keys(colorMap);

  const candidates = [];

  for (const colorIdRaw of orderedColorIds) {
    const colorId = String(colorIdRaw);
    const color = colorMap[colorIdRaw] || colorMap[colorId];
    if (!color) continue;

    const colorPricing = extractSalePricing(color?.pricing?.price);
    if (colorPricing) {
      candidates.push({
        colorId: colorIdRaw,
        salePrice: colorPricing.salePrice,
        originalPrice: colorPricing.originalPrice,
      });
    }
  }

  // fallback: uniform sale at product level, use selected/first color
  if (!candidates.length) {
    const productPricing = extractSalePricing(product?.pricing?.price);
    if (productPricing) {
      const fallbackColorId =
        product?.traits?.colors?.selectedColor ??
        orderedColorIds?.[0] ??
        null;

      return {
        colorId: fallbackColorId,
        salePrice: productPricing.salePrice,
        originalPrice: productPricing.originalPrice,
      };
    }
    return null;
  }

  candidates.sort((a, b) => {
    if (a.salePrice !== b.salePrice) return a.salePrice - b.salePrice;
    return a.originalPrice - b.originalPrice;
  });

  return candidates[0];
}

function extractSalePricing(priceObj) {
  if (!priceObj) return null;

  const priceType = priceObj?.priceType || {};
  if (priceType.onSale !== true && priceType.upcOnSale !== true) {
    return null;
  }

  const tiers = Array.isArray(priceObj?.tieredPrice) ? priceObj.tieredPrice : [];
  const values = tiers.flatMap((tier) => (Array.isArray(tier?.values) ? tier.values : []));

  const regular =
    values.find((v) => v?.type === "regular")?.value ?? null;

  const discount =
    values.find((v) => v?.type === "discount")?.value ??
    values.find((v) => v?.type === "sale")?.value ??
    null;

  const salePrice = toNumber(discount);
  const originalPrice = toNumber(regular);

  if (!isFiniteNumber(salePrice) || !isFiniteNumber(originalPrice)) return null;
  if (!(salePrice < originalPrice)) return null;

  return { salePrice, originalPrice };
}

function extractProductPayloadFromHtml(html) {
  const scriptJsonMatches = [
    ...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi),
    ...html.matchAll(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/gi),
  ];

  for (const match of scriptJsonMatches) {
    const parsed = safeJsonParse(match[1]);
    if (parsed?.product?.[0]?.identifier?.productId) return parsed;
    const found = deepFindProductPayload(parsed);
    if (found) return found;
  }

  const inlineCandidates = html.match(/\{"product":\[\{[\s\S]*?"meta":\{[\s\S]*?\}\}/g) || [];
  for (const candidate of inlineCandidates) {
    const parsed = safeJsonParse(candidate);
    if (parsed?.product?.[0]?.identifier?.productId) return parsed;
  }

  return null;
}

function deepFindProductPayload(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 10) return null;
  if (obj?.product?.[0]?.identifier?.productId) return obj;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFindProductPayload(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const value of Object.values(obj)) {
    const found = deepFindProductPayload(value, depth + 1);
    if (found) return found;
  }

  return null;
}

function inferGender(product) {
  const text = [
    product?.detail?.name,
    product?.detail?.completeName,
    product?.detail?.seoKeywords,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/\bwomen('|’)s\b|\bwomens\b/.test(text)) return "womens";
  if (/\bmen('|’)s\b|\bmens\b/.test(text)) return "mens";
  if (/\bunisex\b/.test(text)) return "unisex";
  return "unknown";
}

function inferShoeType(product) {
  const text = [
    ...(product?.detail?.bulletText || []),
    ...(product?.detail?.dimensionsBulletText || []),
    product?.detail?.description,
    product?.detail?.secondaryDescription,
    product?.detail?.seoKeywords,
    product?.detail?.typeName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/\btrail\b/.test(text)) return "trail";
  if (/\btrack\b/.test(text)) return "track";
  if (/\broad\b/.test(text)) return "road";
  return "unknown";
}

function isRunningShoe(product) {
  const text = [
    product?.division?.name,
    product?.detail?.typeName,
    product?.detail?.name,
    product?.detail?.completeName,
    product?.detail?.seoKeywords,
    ...(product?.detail?.bulletText || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!/\bshoe|sneaker|running\b/.test(text)) return false;
  if (/\bsock|slipper|sandal|boot care|shoelace|insole\b/.test(text)) return false;

  // Sale page is already prefiltered; keep if clearly shoe/sneaker/running
  return true;
}

function deriveModel(listingName, brand) {
  let model = cleanText(listingName);

  model = model
    .replace(/^women('|’)s\s+/i, "")
    .replace(/^men('|’)s\s+/i, "")
    .replace(/^unisex\s+/i, "");

  if (brand) {
    const escaped = escapeRegex(cleanText(brand));
    model = model.replace(new RegExp(`^${escaped}\\s+`, "i"), "");
  }

  model = model
    .replace(/\s+in\s+[a-z0-9/ -]+$/i, "")
    .replace(/\s+running sneakers?$/i, "")
    .replace(/\s+sneakers?$/i, "")
    .replace(/\s+running shoes?$/i, "")
    .replace(/\s+shoes?$/i, "")
    .trim();

  return model || null;
}

function buildColorImageUrl(product, colorId) {
  const base = product?.urlTemplate?.product;
  if (!base) return null;

  const colorMap = product?.traits?.colors?.colorMap || {};
  const color = colorMap[colorId] || colorMap[String(colorId)];
  const primaryImage =
    color?.imagery?.primaryImage ||
    product?.imagery?.images?.[0] ||
    null;

  if (!primaryImage?.filePath) return null;
  return `${base}${primaryImage.filePath}`;
}

function toAbsoluteProductUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `https://www.bloomingdales.com${url}`;
  return `https://www.bloomingdales.com/${url}`;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(url, {
      headers: DEFAULT_HEADERS,
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function looksLikeHiddenPrice(text) {
  const hay = String(text || "").toLowerCase();
  return HIDDEN_PRICE_PATTERNS.some((phrase) => hay.includes(phrase));
}

function countGenders(deals) {
  const counts = {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };

  for (const deal of deals) {
    if (counts[deal.gender] == null) counts.unknown += 1;
    else counts[deal.gender] += 1;
  }

  return counts;
}

function makeDealKey(deal) {
  return [
    cleanText(deal.brand).toLowerCase(),
    cleanText(deal.model || deal.listingName).toLowerCase(),
    cleanText(deal.gender).toLowerCase(),
    String(deal.salePrice),
  ].join("::");
}

function computeDiscountPercent(salePrice, originalPrice) {
  if (!isFiniteNumber(salePrice) || !isFiniteNumber(originalPrice)) return null;
  if (!(salePrice < originalPrice)) return null;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function increment(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
