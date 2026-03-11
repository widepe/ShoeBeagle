// /api/scrapers/hibbett-sale.js
//
// Hibbett sale running shoes scraper
// - Uses Firecrawl raw HTML because Hibbett appears to have bot protection
// - Scrapes exactly 2 category roots:
//   1) men's sale running shoes
//   2) women's sale running shoes
// - Derives pagination from results count + sz param
// - Skips "See Price In Bag" / "See Price In Cart"
// - shoeType = "unknown" for all deals
// - Writes hibbett-sale.json to Vercel Blob
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//   - FIRECRAWL_API_KEY
//   - CRON_SECRET (optional; sample auth is included but commented out)
//
// TEST:
//   /api/scrapers/hibbett-sale

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

export const config = { maxDuration: 300 };

const STORE = "Hibbett";
const SCHEMA_VERSION = 1;
const VIA = "firecrawl-raw-html";

const START_URLS = [
  "https://www.hibbett.com/men/mens-shoes/running-shoes/?prefn1=sale&prefv1=Sale",
  "https://www.hibbett.com/women/womens-shoes/running-shoes/?prefn1=sale&prefv1=Sale",
];

const BASE_URL = "https://www.hibbett.com";
const MAX_PAGES_PER_ROOT = 8;
const FIRECRAWL_TIMEOUT_MS = 45000;
const FIRECRAWL_WAIT_MS = 6000;
const FIRECRAWL_RETRY_LIMIT = 2;
const DEFAULT_PAGE_SIZE = 24;
const MAX_DROPPED_LOGS = 200;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function absoluteUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, BASE_URL).toString();
  } catch {
    return null;
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoney(text) {
  if (!text) return null;
  const m = cleanText(text).match(/\$?\s*([0-9]+(?:\.[0-9]{2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function toPercent(originalPrice, salePrice) {
  if (
    !Number.isFinite(originalPrice) ||
    !Number.isFinite(salePrice) ||
    originalPrice <= 0 ||
    salePrice >= originalPrice
  ) {
    return null;
  }
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function parseJsonAttr(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractBrand(gtmData, listingName) {
  const fromGtm = cleanText(gtmData?.brand);
  if (fromGtm) return fromGtm;

  const name = cleanText(listingName);
  if (!name) return "";

  const firstWord = name.split(/\s+/)[0] || "";
  return firstWord;
}

function normalizeGenderFromArray(gtmGender) {
  if (!Array.isArray(gtmGender) || gtmGender.length === 0) return null;

  const vals = gtmGender.map((v) => cleanText(v).toLowerCase());
  const hasMens = vals.some((v) => v.includes("men"));
  const hasWomens = vals.some((v) => v.includes("women"));

  if (hasMens && hasWomens) return "unisex";
  if (hasMens) return "mens";
  if (hasWomens) return "womens";
  return null;
}

function inferGender(listingName, gtmData) {
  const fromArray = normalizeGenderFromArray(gtmData?.gender);
  if (fromArray) return fromArray;

  const name = cleanText(listingName).toLowerCase();
  if (/\bunisex\b/.test(name)) return "unisex";
  if (/\bmen'?s\b|\bmens\b/.test(name)) return "mens";
  if (/\bwomen'?s\b|\bwomens\b/.test(name)) return "womens";

  return "unknown";
}

function deriveModel(listingName, brand) {
  let model = cleanText(listingName);
  if (!model) return "";

  if (brand) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    model = model.replace(new RegExp(`^${escaped}\\s+`, "i"), "");
  }

  model = model.replace(/"[^"]*"/g, " ");
  model = model.replace(/\bMen'?s Running Shoe\b/gi, " ");
  model = model.replace(/\bWomen'?s Running Shoe\b/gi, " ");
  model = model.replace(/\bUnisex Running Shoe\b/gi, " ");
  model = model.replace(/\bMen'?s Shoe\b/gi, " ");
  model = model.replace(/\bWomen'?s Shoe\b/gi, " ");
  model = model.replace(/\bUnisex Shoe\b/gi, " ");
  model = model.replace(/\bRunning Shoe\b/gi, " ");
  model = model.replace(/\bShoe\b/gi, " ");

  return cleanText(model);
}

function getImageUrl($tile) {
  const src =
    $tile.find("img.main-image-thumb").attr("src") ||
    $tile.find("img.main-image-thumb").attr("data-src") ||
    $tile.find(".product-image img").first().attr("src") ||
    $tile.find(".product-image img").first().attr("data-src") ||
    "";

  return absoluteUrl(src);
}

function getListingUrl($tile) {
  const href =
    $tile.find("a.name-link").attr("href") ||
    $tile.find(".product-image a.thumb-link").attr("href") ||
    $tile.find("a.select").attr("href") ||
    "";

  return absoluteUrl(href);
}

function getListingName($tile) {
  return cleanText(
    $tile.find(".product-name .full-name").text() ||
      $tile.find(".product-name .normalized-name").text() ||
      $tile.find(".product-name").text()
  );
}

function shouldDropForBagPrice($tile) {
  const wholeTileText = cleanText($tile.text()).toLowerCase();
  return (
    wholeTileText.includes("see price in bag") ||
    wholeTileText.includes("see price in cart")
  );
}

function extractPrices($tile) {
  const standardText = cleanText($tile.find(".product-standard-price").text());
  const saleText = cleanText($tile.find(".product-sales-price").text());

  const originalPrice = parseMoney(standardText);
  const salePrice = parseMoney(saleText);

  return { originalPrice, salePrice, standardText, saleText };
}

function parseResultsCount($) {
  const texts = $(".results-hits h2")
    .map((_, el) => cleanText($(el).text()))
    .get();

  for (const text of texts) {
    const m = text.match(/(\d+)\s+Results?/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }

  return null;
}

function parsePageSizeFromDocument($, rootUrl) {
  const optionValues = $("select.grid-paging-header option, select.grid-sort-header option")
    .map((_, el) => $(el).attr("value"))
    .get()
    .filter(Boolean);

  for (const val of optionValues) {
    try {
      const u = new URL(val, BASE_URL);
      const sz = Number(u.searchParams.get("sz"));
      if (Number.isFinite(sz) && sz > 0) return sz;
    } catch {}
  }

  try {
    const u = new URL(rootUrl);
    const sz = Number(u.searchParams.get("sz"));
    if (Number.isFinite(sz) && sz > 0) return sz;
  } catch {}

  return DEFAULT_PAGE_SIZE;
}

function buildPagedUrls(rootUrl, totalResults, pageSize) {
  const urls = [];
  const total =
    Number.isFinite(totalResults) && totalResults > 0 ? totalResults : 0;
  const size =
    Number.isFinite(pageSize) && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE;

  if (total === 0) return [rootUrl];

  for (let start = 0; start < total; start += size) {
    const u = new URL(rootUrl);
    u.searchParams.set("start", String(start));
    u.searchParams.set("sz", String(size));
    urls.push(u.toString());
  }

  return urls.length ? urls : [rootUrl];
}

async function fetchFirecrawlHtml(url) {
  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({
      url,
      formats: ["html"],
      onlyMainContent: false,
      waitFor: FIRECRAWL_WAIT_MS,
      timeout: FIRECRAWL_TIMEOUT_MS,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Firecrawl HTTP ${resp.status} for ${url} :: ${text.slice(0, 300)}`
    );
  }

  const json = await resp.json();
  const html = json?.data?.html || "";

  if (!html || typeof html !== "string") {
    throw new Error(`No HTML returned by Firecrawl for ${url}`);
  }

  return html;
}

async function fetchFirecrawlHtmlWithRetry(url) {
  let lastErr = null;

  for (let i = 0; i <= FIRECRAWL_RETRY_LIMIT; i++) {
    try {
      return await fetchFirecrawlHtml(url);
    } catch (err) {
      lastErr = err;
      if (i < FIRECRAWL_RETRY_LIMIT) {
        await sleep(1000 * (i + 1));
      }
    }
  }

  throw lastErr;
}

function makeDropCounts() {
  return {
    totalTiles: 0,
    dropped_missingListingName: 0,
    dropped_missingBrand: 0,
    dropped_missingModel: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_invalidDiscountPercent: 0,
    dropped_seePriceInBagOrCart: 0,
    dropped_duplicateAfterMerge: 0,
  };
}

function pushDropped(droppedDeals, reason, context) {
  if (droppedDeals.length < MAX_DROPPED_LOGS) {
    droppedDeals.push({
      reason,
      ...context,
    });
  }
}

const tilesSeenThisPage = parseTilesFromPage({
  $,
  deals,
  dropCounts,
  droppedDeals,
  seenDealKeys,
});

pageSummaries.push({
  url: currentUrl,
  tilesSeen: tilesSeenThisPage,
});
const $tiles = $("li.grid-tile > .product-tile");

  if (!$tiles.length) {
    return 0;
  }

  let tilesSeenThisPage = 0;

  $tiles.each((_, el) => {
    const $tile = $(el);
    tilesSeenThisPage += 1;
    dropCounts.totalTiles += 1;

    const listingName = getListingName($tile);
    const listingURL = getListingUrl($tile);
    const imageURL = getImageUrl($tile);
    const gtmData = parseJsonAttr($tile.attr("data-gtmdata"));
    const brand = extractBrand(gtmData, listingName);
    const model = deriveModel(listingName, brand);
    const gender = inferGender(listingName, gtmData);
    const shoeType = "unknown";

    if (shouldDropForBagPrice($tile)) {
      dropCounts.dropped_seePriceInBagOrCart += 1;
      pushDropped(droppedDeals, "see_price_in_bag_or_cart", {
        listingName,
        listingURL,
      });
      return;
    }

    if (!listingName) {
      dropCounts.dropped_missingListingName += 1;
      pushDropped(droppedDeals, "missing_listingName", {
        listingURL,
      });
      return;
    }

    if (!brand) {
      dropCounts.dropped_missingBrand += 1;
      pushDropped(droppedDeals, "missing_brand", {
        listingName,
        listingURL,
      });
      return;
    }

    if (!model) {
      dropCounts.dropped_missingModel += 1;
      pushDropped(droppedDeals, "missing_model", {
        listingName,
        listingURL,
      });
      return;
    }

    if (!listingURL) {
      dropCounts.dropped_missingListingURL += 1;
      pushDropped(droppedDeals, "missing_listingURL", {
        listingName,
      });
      return;
    }

    if (!imageURL) {
      dropCounts.dropped_missingImageURL += 1;
      pushDropped(droppedDeals, "missing_imageURL", {
        listingName,
        listingURL,
      });
      return;
    }

    const { originalPrice, salePrice } = extractPrices($tile);

    if (!Number.isFinite(originalPrice)) {
      dropCounts.dropped_missingOriginalPrice += 1;
      pushDropped(droppedDeals, "missing_originalPrice", {
        listingName,
        listingURL,
      });
      return;
    }

    if (!Number.isFinite(salePrice)) {
      dropCounts.dropped_missingSalePrice += 1;
      pushDropped(droppedDeals, "missing_salePrice", {
        listingName,
        listingURL,
      });
      return;
    }

    if (!(salePrice < originalPrice)) {
      dropCounts.dropped_saleNotLessThanOriginal += 1;
      pushDropped(droppedDeals, "sale_not_less_than_original", {
        listingName,
        listingURL,
        salePrice,
        originalPrice,
      });
      return;
    }

    const discountPercent = toPercent(originalPrice, salePrice);
    if (!Number.isFinite(discountPercent) || discountPercent <= 0) {
      dropCounts.dropped_invalidDiscountPercent += 1;
      pushDropped(droppedDeals, "invalid_discountPercent", {
        listingName,
        listingURL,
        salePrice,
        originalPrice,
        discountPercent,
      });
      return;
    }

    const dedupeKey = listingURL;
    if (seenDealKeys.has(dedupeKey)) {
      dropCounts.dropped_duplicateAfterMerge += 1;
      pushDropped(droppedDeals, "duplicate_listingURL", {
        listingName,
        listingURL,
      });
      return;
    }
    seenDealKeys.add(dedupeKey);

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
      shoeType,
    });
  });

  return tilesSeenThisPage;
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  // CRON auth (temporarily commented out for testing)
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: "Missing BLOB_READ_WRITE_TOKEN",
    });
  }

  if (!process.env.FIRECRAWL_API_KEY) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: "Missing FIRECRAWL_API_KEY",
    });
  }

const dropCounts = makeDropCounts();
const droppedDeals = [];
const deals = [];
const sourceUrls = [];
const pageSummaries = [];   // ADD THIS
const seenPageUrls = new Set();
const seenDealKeys = new Set();

  try {
    for (const rootUrl of START_URLS) {
      const firstHtml = await fetchFirecrawlHtmlWithRetry(rootUrl);
      const $first = cheerio.load(firstHtml);

      const totalResults = parseResultsCount($first);
      const pageSize = parsePageSizeFromDocument($first, rootUrl);
      const pagedUrls = buildPagedUrls(rootUrl, totalResults, pageSize).slice(
        0,
        MAX_PAGES_PER_ROOT
      );

      for (let i = 0; i < pagedUrls.length; i += 1) {
        const currentUrl = pagedUrls[i];
        if (seenPageUrls.has(currentUrl)) continue;

        seenPageUrls.add(currentUrl);
        sourceUrls.push(currentUrl);

        const html = i === 0 ? firstHtml : await fetchFirecrawlHtmlWithRetry(currentUrl);
        const $ = i === 0 ? $first : cheerio.load(html);

        parseTilesFromPage({
          $,
          deals,
          dropCounts,
          droppedDeals,
          seenDealKeys,
        });
      }
    }

   const output = {
  store: STORE,
  schemaVersion: SCHEMA_VERSION,

  lastUpdated: nowIso(),
  via: VIA,

  sourceUrls,
  pageSummaries,   // ADD THIS
  pagesFetched: sourceUrls.length,

  dealsFound: dropCounts.totalTiles,
  dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      dropCounts,
      droppedDealsLogged: droppedDeals.length,
      droppedDealsSample: droppedDeals,

      deals,
    };

    const blob = await put("hibbett-sale.json", JSON.stringify(output, null, 2), {
      access: "public",
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobUrl: blob.url,
      pagesFetched: output.pagesFetched,
      dealsFound: output.dealsFound,
      dealsExtracted: output.dealsExtracted,
      scrapeDurationMs: output.scrapeDurationMs,
      dropCounts: output.dropCounts,
      droppedDealsLogged: output.droppedDealsLogged,
      ok: true,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      scrapeDurationMs: Date.now() - startedAt,
      error: err?.message || String(err),
      dropCounts,
      droppedDealsLogged: droppedDeals.length,
      droppedDealsSample: droppedDeals,
    });
  }
}
