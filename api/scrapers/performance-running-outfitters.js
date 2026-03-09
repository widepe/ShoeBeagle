// /api/scrapers/performance-running.js
//
// Performance Running Outfitters Shopify collection scraper
// - Scrapes collection HTML directly
// - Paginates with ?page=N
// - Uses tile-level data only
// - Writes stable blob payload in your top-level structure
//
// OUTPUT TOP-LEVEL STRUCTURE:
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
// DEAL SCHEMA:
// {
//   schemaVersion,
//   listingName,
//   brand, model,
//   salePrice, originalPrice, discountPercent,
//   salePriceLow, salePriceHigh,
//   originalPriceLow, originalPriceHigh,
//   discountPercentUpTo,
//   store,
//   listingURL, imageURL,
//   gender, shoeType
// }
//
// NOTES:
// - listingName is built from vendor + title as shown on tile.
// - brand comes from tile vendor.
// - gender comes from product title text.
// - shoeType is always "unknown" for this scraper per your rule.
// - Uses tile-level prices only.
// - If a tile has no compare-at/original price, it is dropped.
// - If Globo availability exists and all variants are unavailable, tile is dropped.
// - This is HTML-first because the collection page already exposes the needed fields.
//
// ENV:
// - BLOB_READ_WRITE_TOKEN
//
// OPTIONAL:
// - PERFORMANCE_RUNNING_MAX_PAGES
// - PERFORMANCE_RUNNING_BLOB_PATH   (default: performance-running.json)
//
// TEST:
//   /api/scrapers/performance-running

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "Performance Running";
const SCHEMA_VERSION = 1;
const VIA = "html";

const COLLECTION_URLS = [
  "https://performancerunning.com/collections/womens-sale-shoes",
  "https://performancerunning.com/collections/mens-sale-shoes",
  "https://performancerunning.com/collections/sale-super-shoes",
];

const DEFAULT_MAX_PAGES = 12;
const MAX_PAGES = Math.max(
  1,
  Math.min(50, Number(process.env.PERFORMANCE_RUNNING_MAX_PAGES || DEFAULT_MAX_PAGES))
);

const BLOB_PATH =
  String(process.env.PERFORMANCE_RUNNING_BLOB_PATH || "").trim() ||
  "performance-running.json";

module.exports = async function handler(req, res) {
  const startedAt = Date.now();

  // CRON auth (temporarily commented out for testing)
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(500).json({
        success: false,
        error: "Missing BLOB_READ_WRITE_TOKEN",
      });
    }

    const sourceUrls = [];
    const pageNotes = [];
    const dropCounts = {
      totalTiles: 0,
      dropped_missingUrl: 0,
      dropped_missingTitle: 0,
      dropped_missingBrand: 0,
      dropped_missingPrice: 0,
      dropped_notADeal: 0,
      dropped_allVariantsUnavailable: 0,
      dropped_duplicate: 0,
      kept: 0,
    };

    const deals = [];
    const seen = new Set();

    for (const baseUrl of COLLECTION_URLS) {
      let pagesWithNoNewTilesInARow = 0;

      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;
        sourceUrls.push(url);

        const html = await fetchText(url);
        const $ = cheerio.load(html);

        const tiles = $('div.product--root.globo-swatch-product-item[data-product-item]');
        const pageTileCount = tiles.length;

        // Some Shopify themes may render fewer/more product cards via other wrappers.
        // Fallback if needed.
        const fallbackTiles = pageTileCount
          ? tiles
          : $('a[href*="/products/"]').filter((_, el) => {
              const text = $(el).text().replace(/\s+/g, " ").trim();
              return /\$\d/.test(text);
            });

        const activeTiles = pageTileCount ? tiles : fallbackTiles;

        let pageAdded = 0;
        let pageParsed = 0;

        activeTiles.each((_, el) => {
          dropCounts.totalTiles += 1;
          pageParsed += 1;

          const deal = parseTile($, el);
          if (!deal) return;

          if (seen.has(deal.listingURL)) {
            dropCounts.dropped_duplicate += 1;
            return;
          }

          seen.add(deal.listingURL);
          deals.push(deal);
          pageAdded += 1;
          dropCounts.kept += 1;
        });

        pageNotes.push({
          url,
          tilesFound: activeTiles.length,
          parsed: pageParsed,
          addedUnique: pageAdded,
        });

        // Stop conditions:
        // 1) no tiles on page
        // 2) repeated empty/newless pages
        if (!activeTiles.length) {
          pagesWithNoNewTilesInARow += 1;
        } else if (pageAdded === 0) {
          pagesWithNoNewTilesInARow += 1;
        } else {
          pagesWithNoNewTilesInARow = 0;
        }

        if (!activeTiles.length) {
          pageNotes.push({
            url,
            note: "Stopping: no product tiles found on page",
          });
          break;
        }

        if (pagesWithNoNewTilesInARow >= 2) {
          pageNotes.push({
            url,
            note: "Stopping: consecutive pages produced no new tiles",
          });
          break;
        }

        // Soft pagination detection: if there is no hint of a next page and pageAdded is small,
        // allow normal fallback logic to stop us soon. We do not hard-stop on pagination markup
        // because themes vary and the parsed HTML may omit some controls.
      }
    }

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls,
      pagesFetched: pageNotes.filter((x) => x.tilesFound !== undefined || x.note === undefined).length,

      dealsFound: dropCounts.totalTiles,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      deals,

      // optional debug you often like
      pageNotes,
      dropCounts,
    };

    const blob = await put(BLOB_PATH, JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobUrl: blob.url,
      pagesFetched: payload.pagesFetched,
      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,
      scrapeDurationMs: payload.scrapeDurationMs,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: error?.message || "Unknown error",
      scrapeDurationMs: Date.now() - startedAt,
    });
  }

  function parseTile($, el) {
    const $tile = $(el);

    // URL
    const href =
      $tile.find('a[href*="/products/"]').first().attr("href") ||
      $tile.attr("href") ||
      null;

    if (!href) {
      dropCounts.dropped_missingUrl += 1;
      return null;
    }

    const listingURL = absoluteUrl(href, "https://performancerunning.com");

    // Brand
    const brand = cleanText(
      $tile.find(".product--vendor").first().text()
    );

    if (!brand) {
      dropCounts.dropped_missingBrand += 1;
      return null;
    }

    // Title
    const rawTitle = cleanText(
      $tile.find(".product--title").first().text()
    );

    if (!rawTitle) {
      dropCounts.dropped_missingTitle += 1;
      return null;
    }

    // listingName: vendor + title as seen on tile
    const listingName = cleanText(`${brand} ${rawTitle}`);

    // Image
    let imageURL =
      $tile.find(".product--image picture img").first().attr("src") ||
      $tile.find(".product--image img").first().attr("src") ||
      $tile.find("img").first().attr("src") ||
      "";

    imageURL = normalizeImageUrl(imageURL);

    // Prices
    const compareText = cleanText(
      $tile.find(".product--compare-price").first().text()
    );
    const saleText = cleanText(
      $tile.find(".product--price").first().text()
    );

    const originalPrice = parsePrice(compareText);
    const salePrice = parsePrice(saleText);

    if (salePrice == null || originalPrice == null) {
      dropCounts.dropped_missingPrice += 1;
      return null;
    }

    if (!(originalPrice > salePrice)) {
      dropCounts.dropped_notADeal += 1;
      return null;
    }

    // Availability (optional but useful)
    const variantOptions = $tile.find("select.globo-selector-all option");
    if (variantOptions.length) {
      const anyAvailable = variantOptions
        .toArray()
        .some((opt) => String($(opt).attr("data-available")).trim().toLowerCase() === "true");

      if (!anyAvailable) {
        dropCounts.dropped_allVariantsUnavailable += 1;
        return null;
      }
    }

    const gender = parseGender(rawTitle);
    const model = parseModelFromTitle(rawTitle);
    const discountPercent = calcDiscountPercent(originalPrice, salePrice);

    return {
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
    };
  }
};

async function fetchText(url) {
  const resp = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }

  return await resp.text();
}

function cleanText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(href, origin) {
  try {
    return new URL(href, origin).toString();
  } catch {
    return href;
  }
}

function normalizeImageUrl(src) {
  let s = String(src || "").trim();
  if (!s) return "";

  if (s.startsWith("//")) s = `https:${s}`;
  else if (s.startsWith("/")) s = `https://performancerunning.com${s}`;

  return s;
}

function parsePrice(text) {
  const m = String(text || "").match(/\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
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

function parseGender(title) {
  const t = String(title || "").toUpperCase();

  if (/\bWOMEN'?S\b/.test(t) || /\bWOMENS\b/.test(t)) return "womens";
  if (/\bMEN'?S\b/.test(t) || /\bMENS\b/.test(t)) return "mens";
  if (/\bUNISEX\b/.test(t)) return "unisex";

  return "unknown";
}

function parseModelFromTitle(title) {
  let t = cleanText(title);

  // remove leading gender token
  t = t.replace(/^WOMEN'?S\s+/i, "");
  t = t.replace(/^WOMENS\s+/i, "");
  t = t.replace(/^MEN'?S\s+/i, "");
  t = t.replace(/^MENS\s+/i, "");
  t = t.replace(/^UNISEX\s+/i, "");

  // strip trailing color/width/size fragments if present
  // examples:
  // "ADRENALINE GTS 24 - WIDE D - 019 ALLOY/WHITE/ZEPHYR"
  // "860 V11 - B -BLACK/WHITE - SIZE 5.0"
  t = t.split(/\s+-\s+/)[0].trim();

  return t || cleanText(title);
}
