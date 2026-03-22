// /api/scrapers/super-runner-shop.js
// CommonJS Vercel function
//
// Store: Super Runners Shop
// Collection: https://superrunnersshop.com/collections/footear-sale-shoes
//
// Blob env var:
//   SUPERRUNNERSHOP_DEALS_BLOB_URL
//
// Saves blob to:
//   .../super-runner-shop.json
//
// Response:
// - NO deals array in response
// - Includes readable drop counts
// - Includes page summaries
// - Includes mens/womens/unisex/unknown totals
//
// Saved blob:
// - top-level metadata + deals array only

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

export const config = { maxDuration: 60 };

const STORE = "Super Runners Shop";
const BASE = "https://superrunnersshop.com";
const COLLECTION_PATH = "/collections/footear-sale-shoes";
const COLLECTION_URL = `${BASE}${COLLECTION_PATH}`;
const PRODUCTS_JSON_BASE = `${COLLECTION_URL}/products.json`;
const BLOB_ENV_KEY = "SUPERRUNNERSHOP_DEALS_BLOB_URL";

const HIDDEN_PRICE_PATTERNS = [
  /see\s+price\s+in\s+cart/i,
  /see\s+price\s+in\s+bag/i,
  /see\s+price\s+at\s+checkout/i,
  /add\s+to\s+cart\s+to\s+see\s+price/i,
  /add\s+to\s+bag\s+to\s+see\s+price/i,
  /price\s+in\s+cart/i,
  /price\s+in\s+bag/i,
  /hidden\s+price/i,
  /add\s+for\s+price/i,
  /login\s+to\s+see\s+price/i,
];

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function toAbsUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/")) return `${BASE}${s}`;
  return `${BASE}/${s.replace(/^\/+/, "")}`;
}

function moneyToNumber(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function calcDiscountPercent(sale, original) {
  if (!Number.isFinite(sale) || !Number.isFinite(original) || original <= 0 || sale >= original) {
    return null;
  }
  return Math.round(((original - sale) / original) * 100);
}

function increment(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + by;
}

function stripGenderPrefix(title) {
  return cleanText(
    String(title || "")
      .replace(/^(men['’]s|mens|men)\s+/i, "")
      .replace(/^(women['’]s|womens|women)\s+/i, "")
      .replace(/^(unisex)\s+/i, "")
  );
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveModel(listingName, brand) {
  let model = stripGenderPrefix(listingName);
  if (brand) {
    model = model.replace(new RegExp(`^${escapeRegex(brand)}\\s+`, "i"), "");
  }
  return cleanText(model) || cleanText(listingName) || "Unknown";
}

function inferGenderFromText(...parts) {
  const hay = cleanText(parts.filter(Boolean).join(" ")).toLowerCase();

  if (/\bunisex\b/.test(hay)) return "unisex";
  if (/\b(women|women's|womens|wmns|ladies|lady)\b/.test(hay)) return "womens";
  if (/\b(men|men's|mens)\b/.test(hay)) return "mens";
  return "unknown";
}

function inferShoeType(product) {
  const hay = cleanText([
    product?.product_type,
    Array.isArray(product?.tags) ? product.tags.join(" ") : "",
    product?.title,
    product?.body_html
  ]).toLowerCase();

  if (/\btrail\b/.test(hay)) return "trail";
  if (/\btrack\b/.test(hay)) return "track";
  if (/\broad\b/.test(hay)) return "road";
  return "unknown";
}

function looksLikeHiddenPrice(text) {
  const t = cleanText(text);
  return HIDDEN_PRICE_PATTERNS.some((rx) => rx.test(t));
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; ShoeBeagleBot/1.0; +https://shoebeagle.com)"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; ShoeBeagleBot/1.0; +https://shoebeagle.com)",
      "accept": "application/json"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function parseTile($, $card) {
  const linkEl = $card
    .find('a[product-card-link]')
    .filter((_, el) => {
      const href = $(el).attr("href") || "";
      return /\/products\//i.test(href);
    })
    .first();

  const href = cleanText(linkEl.attr("href"));
  const listingURL = toAbsUrl(href);

  const handleMatch = href.match(/\/products\/([^/?#]+)/i);
  const handle = handleMatch ? cleanText(handleMatch[1]) : null;

  const brand = cleanText($card.find("product-card-vendor").first().text());
  const listingName = cleanText($card.find("product-card-title").first().text());

  const salePriceText = cleanText(
    $card.find(".price__number--sale .money").first().text()
  );

  const originalPriceText = cleanText(
    $card.find(".price__compare .money").first().text()
  );

  const imageURL = toAbsUrl(
    $card.find("img.product-card__img").first().attr("src") ||
    $card.find("img.product-card__img").first().attr("data-src") ||
    null
  );

  const cardText = cleanText($card.text());

  return {
    handle,
    listingURL,
    listingName,
    brand,
    salePrice: moneyToNumber(salePriceText),
    originalPrice: moneyToNumber(originalPriceText),
    imageURL,
    cardText,
    hiddenPriceFlag: looksLikeHiddenPrice(cardText),
  };
}

async function scrapeCollectionPages() {
  const pageSummaries = [];
  const tilesByHandle = new Map();
  const sourceUrls = [];
  let pagesFetched = 0;

  for (let page = 1; page <= 40; page += 1) {
    const url = page === 1 ? COLLECTION_URL : `${COLLECTION_URL}?page=${page}`;
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    const pageCards = [];
    $("product-card").each((_, el) => {
      const parsed = parseTile($(el));
      if (parsed.handle) pageCards.push(parsed);
    });

    const uniqueHandles = new Set(pageCards.map((x) => x.handle));

    if (page > 1 && uniqueHandles.size === 0) break;

    let hiddenPriceTiles = 0;
    for (const tile of pageCards) {
      if (tile.hiddenPriceFlag) hiddenPriceTiles += 1;

      if (!tilesByHandle.has(tile.handle)) {
        tilesByHandle.set(tile.handle, { ...tile, page });
      }
    }

    sourceUrls.push(url);
    pagesFetched += 1;

    pageSummaries.push({
      page,
      url,
      tilesFound: uniqueHandles.size,
      hiddenPriceTilesFound: hiddenPriceTiles,
      droppedHiddenPrice: 0,
      droppedMissingPrice: 0,
      droppedMissingOriginalPrice: 0,
      droppedNotDiscounted: 0,
      droppedMissingTitle: 0,
      droppedMissingHandle: 0,
      droppedMissingImage: 0,
      extractedDeals: 0,
    });
  }

  return {
    pageSummaries,
    tilesByHandle,
    sourceUrls,
    pagesFetched,
  };
}

async function fetchAllProductsJson() {
  const products = [];
  const sourceUrls = [];

  for (let page = 1; page <= 40; page += 1) {
    const url = `${PRODUCTS_JSON_BASE}?limit=250&page=${page}`;
    const json = await fetchJson(url);
    const batch = Array.isArray(json?.products) ? json.products : [];

    if (!batch.length) break;

    products.push(...batch);
    sourceUrls.push(url);

    if (batch.length < 250) break;
  }

  return { products, sourceUrls };
}

function uniqueProductsByHandle(products) {
  const map = new Map();
  for (const p of products) {
    const handle = cleanText(p?.handle);
    if (!handle) continue;
    if (!map.has(handle)) map.set(handle, p);
  }
  return map;
}

function prettyDropCounts(dropCounts) {
  return {
    hiddenPriceTile: dropCounts.hidden_price_tile || 0,
    missingHandle: dropCounts.missing_handle || 0,
    missingTitle: dropCounts.missing_title || 0,
    missingSalePrice: dropCounts.missing_sale_price || 0,
    missingOriginalPrice: dropCounts.missing_original_price || 0,
    notDiscounted: dropCounts.not_discounted || 0,
    missingImage: dropCounts.missing_image || 0,
    missingTileOnCollectionPage: dropCounts.missing_tile_on_collection_page || 0,
  };
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
    const collection = await scrapeCollectionPages();
    const productsJson = await fetchAllProductsJson();
    const productMap = uniqueProductsByHandle(productsJson.products);

    const deals = [];

    for (const [handle, tile] of collection.tilesByHandle.entries()) {
      const product = productMap.get(handle) || null;
      const pageSummary = collection.pageSummaries.find((p) => p.page === tile.page);

      if (!handle) {
        increment(dropCounts, "missing_handle");
        if (pageSummary) pageSummary.droppedMissingHandle += 1;
        continue;
      }

      if (tile.hiddenPriceFlag) {
        increment(dropCounts, "hidden_price_tile");
        if (pageSummary) pageSummary.droppedHiddenPrice += 1;
        continue;
      }

      if (!tile.listingName) {
        increment(dropCounts, "missing_title");
        if (pageSummary) pageSummary.droppedMissingTitle += 1;
        continue;
      }

      if (!Number.isFinite(tile.salePrice)) {
        increment(dropCounts, "missing_sale_price");
        if (pageSummary) pageSummary.droppedMissingPrice += 1;
        continue;
      }

      if (!Number.isFinite(tile.originalPrice)) {
        increment(dropCounts, "missing_original_price");
        if (pageSummary) pageSummary.droppedMissingOriginalPrice += 1;
        continue;
      }

      if (!(tile.originalPrice > tile.salePrice)) {
        increment(dropCounts, "not_discounted");
        if (pageSummary) pageSummary.droppedNotDiscounted += 1;
        continue;
      }

      if (!tile.imageURL) {
        increment(dropCounts, "missing_image");
        if (pageSummary) pageSummary.droppedMissingImage += 1;
        continue;
      }

      let gender = inferGenderFromText(
        tile.listingName,
        product?.title,
        product?.handle,
        Array.isArray(product?.tags) ? product.tags.join(" ") : ""
      );

      if (!["mens", "womens", "unisex", "unknown"].includes(gender)) {
        gender = "unknown";
      }

      let shoeType = "unknown";
      if (product) {
        shoeType = inferShoeType(product);
      }
      if (!["road", "trail", "track", "unknown"].includes(shoeType)) {
        shoeType = "unknown";
      }

      const deal = {
        schemaVersion: 1,

        listingName: tile.listingName,

        brand: cleanText(tile.brand) || cleanText(product?.vendor) || "Unknown",
        model: deriveModel(tile.listingName, cleanText(tile.brand) || cleanText(product?.vendor) || ""),

        salePrice: tile.salePrice,
        originalPrice: tile.originalPrice,
        discountPercent: calcDiscountPercent(tile.salePrice, tile.originalPrice),

        salePriceLow: null,
        salePriceHigh: null,
        originalPriceLow: null,
        originalPriceHigh: null,
        discountPercentUpTo: null,

        store: STORE,

        listingURL: tile.listingURL || toAbsUrl(`/products/${handle}`),
        imageURL: tile.imageURL,

        gender,
        shoeType,
      };

      deals.push(deal);
      genderCounts[gender] += 1;
      if (pageSummary) pageSummary.extractedDeals += 1;
    }

    const lastUpdated = nowIso();
    const blobPath = process.env[BLOB_ENV_KEY] || "deals/super-runner-shop.json";

    const blobData = {
      store: STORE,
      schemaVersion: 1,

      lastUpdated,
      via: "collection-html+shopify-products-json",

      sourceUrls: [
        ...collection.sourceUrls,
        ...productsJson.sourceUrls,
      ],

      pagesFetched: collection.pagesFetched,

      dealsFound: collection.tilesByHandle.size,
      dealsExtracted: deals.length,

      mensDeals: genderCounts.mens,
      womensDeals: genderCounts.womens,
      unisexDeals: genderCounts.unisex,
      unknownGenderDeals: genderCounts.unknown,

      scrapeDurationMs: Date.now() - started,

      ok: true,
      error: null,

      deals,
    };

    await put(blobPath, JSON.stringify(blobData, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    return res.status(200).json({
      success: true,

      store: STORE,
      schemaVersion: 1,

      lastUpdated,
      via: "collection-html+shopify-products-json",

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

      dropCounts: prettyDropCounts(dropCounts),
      pageSummaries: collection.pageSummaries,
      blobPath,

      note: "Response intentionally omits deals[]. Saved blob contains only top-level metadata and deals[].",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,

      store: STORE,
      schemaVersion: 1,

      lastUpdated: nowIso(),
      via: "collection-html+shopify-products-json",

      sourceUrls: [COLLECTION_URL, PRODUCTS_JSON_BASE],
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

      dropCounts: prettyDropCounts(dropCounts),
      pageSummaries: [],
    });
  }
}
