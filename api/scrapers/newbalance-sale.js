// /api/scrapers/newbalance-sale.js
//
// New Balance sale running shoes scraper
// - Scrapes men's + women's sale running shoe pages
// - Keeps only true sale items with BOTH salePrice and originalPrice,
//   where salePrice < originalPrice
// - shoeType is always unknown
// - brand is always New Balance
// - writes blob to: newbalance-sale.json
//
// ENV
// - BLOB_READ_WRITE_TOKEN
// - NEWBALANCE_DEALS_BLOB_URL (for merge-deals, not used by this scraper directly)
// - CRON_SECRET (optional; auth block included below but commented out for testing)

import { put } from "@vercel/blob";
import * as cheerio from "cheerio";

export const config = { maxDuration: 60 };

const STORE = "New Balance";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";
const BASE_URL = "https://www.newbalance.com";
const BLOB_PATH = "newbalance-sale.json";

const START_URLS = [
  "https://www.newbalance.com/sale/men/shoes/?prefn1=category&prefv1=Running",
  "https://www.newbalance.com/sale/women/shoes/?prefn1=category&prefv1=Running",
];

const MAX_PAGES_PER_SOURCE = 12;
const MAX_DROPPED_LOG = 200;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function absUrl(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `${BASE_URL}${s.startsWith("/") ? "" : "/"}${s}`;
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/[^0-9.]+/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function computeDiscountPercent(salePrice, originalPrice) {
  if (
    !Number.isFinite(salePrice) ||
    !Number.isFinite(originalPrice) ||
    originalPrice <= 0 ||
    salePrice >= originalPrice
  ) {
    return null;
  }
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function parseGender(text) {
  const s = String(text || "").toLowerCase();
  if (s.includes("women")) return "womens";
  if (s.includes("men")) return "mens";
  if (s.includes("unisex")) return "unisex";
  return "unknown";
}

function pushDropped(droppedDealsSample, item) {
  if (droppedDealsSample.length < MAX_DROPPED_LOG) {
    droppedDealsSample.push(item);
  }
}

function parseStylePriceJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getSelectedOrFirstSwatchButton($tile) {
  const $selected = $tile.find(".color-swatches button.selected[data-style-price]").first();
  if ($selected.length) return $selected;
  const $first = $tile.find(".color-swatches button[data-style-price]").first();
  if ($first.length) return $first;
  return null;
}

function extractSalePrice($tile) {
  const visibleContent = toNumber($tile.find(".price .sales [content]").first().attr("content"));
  if (Number.isFinite(visibleContent)) return visibleContent;

  const visibleText = toNumber($tile.find(".price .sales").first().text());
  if (Number.isFinite(visibleText)) return visibleText;

  const $swatch = getSelectedOrFirstSwatchButton($tile);
  if ($swatch) {
    const parsed = parseStylePriceJson($swatch.attr("data-style-price"));
    const swatchSale =
      toNumber(parsed?.sales?.value) ??
      toNumber(parsed?.sales?.decimalPrice) ??
      null;
    if (Number.isFinite(swatchSale)) return swatchSale;
  }

  return null;
}

function extractOriginalPrice($tile) {
  const visibleContent = toNumber(
    $tile.find(".strike-through .value[content]").first().attr("content")
  );
  if (Number.isFinite(visibleContent)) return visibleContent;

  const visibleText = toNumber($tile.find(".strike-through .value").first().text());
  if (Number.isFinite(visibleText)) return visibleText;

  const $swatch = getSelectedOrFirstSwatchButton($tile);
  if ($swatch) {
    const parsed = parseStylePriceJson($swatch.attr("data-style-price"));
    const swatchList =
      toNumber(parsed?.list?.value) ??
      toNumber(parsed?.list?.decimalPrice) ??
      null;
    if (Number.isFinite(swatchList)) return swatchList;
  }

  return null;
}

function extractListingUrl($tile) {
  const primaryHref = $tile.find(".image-container > a").first().attr("href");
  if (primaryHref) return absUrl(primaryHref);

  const fallbackHref = $tile.find(".pdp-link a.pname, .pdp-link a").first().attr("href");
  if (fallbackHref) return absUrl(fallbackHref);

  return null;
}

function extractImageUrl($tile) {
  const primary = $tile.find(".image-container img.tile-image").first().attr("src");
  if (primary) return absUrl(primary);

  const fallback = $tile.find(".image-container img.tile-image").first().attr("data-src");
  if (fallback) return absUrl(fallback);

  return null;
}

function summarizeTileForDrop($tile, sourceUrl) {
  return {
    sourceUrl,
    listingName: cleanText($tile.find(".pdp-link a.pname, .pdp-link a").first().text()) || null,
    listingURL: extractListingUrl($tile),
    imageURL: extractImageUrl($tile),
    genderText: cleanText($tile.find(".category-name").first().text()) || null,
    visibleSaleText: cleanText($tile.find(".price .sales").first().text()) || null,
    visibleOriginalText: cleanText($tile.find(".strike-through .value").first().text()) || null,
  };
}

function extractDeal($, el, sourceUrl, dropCounts, droppedDealsSample) {
  const $tile = $(el);

  const listingName = cleanText(
    $tile.find(".pdp-link a.pname, .pdp-link a").first().text()
  );
  const listingURL = extractListingUrl($tile);
  const imageURL = extractImageUrl($tile);
  const categoryText = cleanText($tile.find(".category-name").first().text());

  const salePrice = extractSalePrice($tile);
  const originalPrice = extractOriginalPrice($tile);
  const discountPercent = computeDiscountPercent(salePrice, originalPrice);

  const gender = parseGender(categoryText);

  if (!listingName) {
    dropCounts.dropped_missingListingName++;
    pushDropped(droppedDealsSample, {
      reason: "missingListingName",
      ...summarizeTileForDrop($tile, sourceUrl),
    });
    return null;
  }

  if (!listingURL) {
    dropCounts.dropped_missingListingURL++;
    pushDropped(droppedDealsSample, {
      reason: "missingListingURL",
      ...summarizeTileForDrop($tile, sourceUrl),
    });
    return null;
  }

  if (!imageURL) {
    dropCounts.dropped_missingImageURL++;
    pushDropped(droppedDealsSample, {
      reason: "missingImageURL",
      ...summarizeTileForDrop($tile, sourceUrl),
    });
    return null;
  }

  if (!Number.isFinite(salePrice)) {
    dropCounts.dropped_missingSalePrice++;
    pushDropped(droppedDealsSample, {
      reason: "missingSalePrice",
      ...summarizeTileForDrop($tile, sourceUrl),
    });
    return null;
  }

  if (!Number.isFinite(originalPrice)) {
    dropCounts.dropped_missingOriginalPrice++;
    pushDropped(droppedDealsSample, {
      reason: "missingOriginalPrice",
      ...summarizeTileForDrop($tile, sourceUrl),
      salePrice,
    });
    return null;
  }

  if (!(salePrice < originalPrice)) {
    dropCounts.dropped_saleNotLessThanOriginal++;
    pushDropped(droppedDealsSample, {
      reason: "saleNotLessThanOriginal",
      ...summarizeTileForDrop($tile, sourceUrl),
      salePrice,
      originalPrice,
    });
    return null;
  }

  if (!Number.isFinite(discountPercent)) {
    dropCounts.dropped_invalidDiscountPercent++;
    pushDropped(droppedDealsSample, {
      reason: "invalidDiscountPercent",
      ...summarizeTileForDrop($tile, sourceUrl),
      salePrice,
      originalPrice,
    });
    return null;
  }

  return {
    schemaVersion: SCHEMA_VERSION,

    listingName,

    brand: "New Balance",
    model: listingName,

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

function getNextPageUrl($, currentUrl) {
  const current = new URL(currentUrl);
  const currentStart = Number(current.searchParams.get("start") || "0");

  let best = null;
  let bestStart = currentStart;

  $('a[href*="start="], a[rel="next"], .pagination a').each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;

    try {
      const abs = absUrl(href);
      const u = new URL(abs);
      const nextStart = Number(u.searchParams.get("start") || "0");
      if (Number.isFinite(nextStart) && nextStart > bestStart) {
        best = abs;
        bestStart = nextStart;
      }
    } catch {}
  });

  return best;
}

async function fetchHtml(url) {
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
      referer: BASE_URL,
    },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }

  return resp.text();
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

  const dropCounts = {
    totalTiles: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_invalidDiscountPercent: 0,
    dropped_duplicateAfterMerge: 0,
  };

  const droppedDealsSample = [];
  const sourceUrls = [];
  const deals = [];
  const seenListingUrls = new Set();

  try {
    for (const startUrl of START_URLS) {
      let currentUrl = startUrl;
      let pagesForThisSource = 0;

      while (currentUrl && pagesForThisSource < MAX_PAGES_PER_SOURCE) {
        if (sourceUrls.includes(currentUrl)) break;

        const html = await fetchHtml(currentUrl);
        sourceUrls.push(currentUrl);
        pagesForThisSource++;

        const $ = cheerio.load(html);

        const $tiles = $('.product[role="region"]');

        if (!$tiles.length) break;

        $tiles.each((_, el) => {
          dropCounts.totalTiles++;

          const deal = extractDeal($, el, currentUrl, dropCounts, droppedDealsSample);
          if (!deal) return;

          if (seenListingUrls.has(deal.listingURL)) {
            dropCounts.dropped_duplicateAfterMerge++;
            pushDropped(droppedDealsSample, {
              reason: "duplicateAfterMerge",
              sourceUrl: currentUrl,
              listingName: deal.listingName,
              listingURL: deal.listingURL,
              imageURL: deal.imageURL,
            });
            return;
          }

          seenListingUrls.add(deal.listingURL);
          deals.push(deal);
        });

        const nextUrl = getNextPageUrl($, currentUrl);
        if (!nextUrl || nextUrl === currentUrl) break;
        currentUrl = nextUrl;
      }
    }

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,

      pagesFetched: sourceUrls.length,

      dealsFound: dropCounts.totalTiles,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      droppedDealsSample,

      deals,
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
      dropCounts: payload.dropCounts,
      droppedDealsLogged: payload.droppedDealsLogged,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: error?.message || "Unknown error",
      scrapeDurationMs: Date.now() - startedAt,
      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      droppedDealsSample,
    });
  }
}
