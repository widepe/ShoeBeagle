// /api/scrapers/allbirds-sale.js

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Allbirds";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";
const BASE = "https://www.allbirds.com";

const SOURCE_URLS = [
  "https://www.allbirds.com/collections/sale-mens?sort_by=manual&filter.p.m.allbirds_v2.category_subtypes=Running+Shoes",
  "https://www.allbirds.com/collections/sale-womens?sort_by=manual&filter.p.m.allbirds_v2.category_subtypes=Running+Shoes",
];

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function toAbsoluteUrl(url) {
  const s = String(url || "").trim();
  if (!s) return null;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return `${BASE}${s}`;
  return `${BASE}/${s.replace(/^\/+/, "")}`;
}

function parsePriceText(text) {
  const s = cleanText(text);
  if (!s) return null;
  const match = s.match(/\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  return match ? Number(match[1]) : null;
}

function computeDiscountPercent(salePrice, originalPrice) {
  if (
    typeof salePrice !== "number" ||
    typeof originalPrice !== "number" ||
    !Number.isFinite(salePrice) ||
    !Number.isFinite(originalPrice) ||
    originalPrice <= 0 ||
    salePrice >= originalPrice
  ) {
    return null;
  }
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function inferGender(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (s.startsWith("men's ") || s.startsWith("mens ")) return "mens";
  if (s.startsWith("women's ") || s.startsWith("womens ")) return "womens";
  if (s.startsWith("unisex ")) return "unisex";
  return "unknown";
}

function extractModel(listingName) {
  let s = cleanText(listingName);
  s = s.replace(/^men'?s\s+/i, "");
  s = s.replace(/^women'?s\s+/i, "");
  s = s.replace(/^unisex\s+/i, "");
  return s || "Unknown";
}

function inferShoeType(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (/\btrail\b/.test(s)) return "trail";
  if (/\btrack\b/.test(s) || /\bspike\b/.test(s) || /\bspikes\b/.test(s)) return "track";
  return "road";
}

function makeDropCounts() {
  return {
    totalTiles: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_duplicateAfterMerge: 0,
    dropped_parseError: 0,
  };
}

async function fetchHtml(url) {
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      referer: "https://www.allbirds.com/",
      "cache-control": "no-cache",
    },
  });

  if (!resp.ok) {
    throw new Error(`Fetch failed for ${url}: HTTP ${resp.status}`);
  }

  return await resp.text();
}

function extractListingUrl($, $card) {
  const directHref =
    $card.find("a[data-product-link]").first().attr("href") ||
    $card.find('a[href*="/products/"]').first().attr("href") ||
    $card.find("input[data-product-url]").first().attr("data-product-url") ||
    "";

  return toAbsoluteUrl(directHref);
}

function firstUrlFromSrcset(srcset) {
  const s = String(srcset || "").trim();
  if (!s) return null;
  const firstPart = s.split(",")[0]?.trim() || "";
  const firstUrl = firstPart.split(/\s+/)[0]?.trim() || "";
  return toAbsoluteUrl(firstUrl);
}

function extractImageUrl($, $card) {
  const $img = $card.find("img").first();

  const direct =
    toAbsoluteUrl($img.attr("src")) ||
    toAbsoluteUrl($img.attr("data-src")) ||
    firstUrlFromSrcset($img.attr("srcset")) ||
    firstUrlFromSrcset($img.attr("data-srcset"));

  if (direct) return direct;

  const analyticsImage =
    $card.find("a[data-analytics-collection-product-grid-image-name]").first().attr("data-analytics-collection-product-grid-image-name") ||
    $card.find("a[data-product-link]").first().attr("data-analytics-collection-product-grid-image-name") ||
    "";

  if (analyticsImage) {
    const cleaned = analyticsImage.split("&")[0].trim();
    const abs = toAbsoluteUrl(cleaned);
    if (abs) return abs;
  }

  const productImageJson = $card.find("input[data-product-image]").first().attr("data-product-image");
  if (productImageJson) {
    try {
      const decoded = decodeHtmlEntities(productImageJson);
      const parsed = JSON.parse(decoded);
      const src = parsed?.src || parsed?.image?.src || "";
      const abs = toAbsoluteUrl(src);
      if (abs) return abs;
    } catch {
      // ignore and continue
    }
  }

  return null;
}

function extractPrices($, $card) {
  let salePrice = null;
  let originalPrice = null;

  const $priceInput = $card.find("input[data-product-price][data-product-compare-at-price]").first();
  if ($priceInput.length) {
    salePrice = parsePriceText($priceInput.attr("data-product-price"));
    originalPrice = parsePriceText($priceInput.attr("data-product-compare-at-price"));
  }

  if (salePrice == null || originalPrice == null) {
    const spans = $card.find("p span");
    if (spans.length >= 2) {
      salePrice = salePrice ?? parsePriceText($(spans[0]).text());
      originalPrice = originalPrice ?? parsePriceText($(spans[1]).text());
    }
  }

  return { salePrice, originalPrice };
}

function extractDealFromCard($, el, seenKeys, dropCounts) {
  const $card = $(el);
  dropCounts.totalTiles += 1;

  try {
    const listingName = cleanText($card.attr("data-product-name"));

    if (!listingName) {
      dropCounts.dropped_missingListingName += 1;
      return null;
    }

    const listingURL = extractListingUrl($, $card);
    if (!listingURL) {
      dropCounts.dropped_missingListingURL += 1;
      return null;
    }

    const dedupeKey = `${STORE}||${listingURL}`;
    if (seenKeys.has(dedupeKey)) {
      dropCounts.dropped_duplicateAfterMerge += 1;
      return null;
    }

    const imageURL = extractImageUrl($, $card);
    if (!imageURL) {
      dropCounts.dropped_missingImageURL += 1;
      return null;
    }

    const { salePrice, originalPrice } = extractPrices($, $card);

    if (salePrice == null) {
      dropCounts.dropped_missingSalePrice += 1;
      return null;
    }

    if (originalPrice == null) {
      dropCounts.dropped_missingOriginalPrice += 1;
      return null;
    }

    if (!(salePrice < originalPrice)) {
      dropCounts.dropped_saleNotLessThanOriginal += 1;
      return null;
    }

    seenKeys.add(dedupeKey);

    return {
      schemaVersion: SCHEMA_VERSION,

      listingName,

      brand: "Allbirds",
      model: extractModel(listingName),

      salePrice,
      originalPrice,
      discountPercent: computeDiscountPercent(salePrice, originalPrice),

      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,

      store: STORE,

      listingURL,
      imageURL,

      gender: inferGender(listingName),
      shoeType: inferShoeType(listingName),
    };
  } catch (err) {
    dropCounts.dropped_parseError += 1;
    return null;
  }
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  // CRON_SECRET
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const dropCounts = makeDropCounts();
  const seenKeys = new Set();
  const deals = [];
  let pagesFetched = 0;

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error("Missing BLOB_READ_WRITE_TOKEN");
    }

    const cheerio = await import("cheerio");

    for (const url of SOURCE_URLS) {
      const html = await fetchHtml(url);
      pagesFetched += 1;

      const $ = cheerio.load(html);

      const $cards = $('[data-product-card][data-product-name]');

      $cards.each((_, el) => {
        const deal = extractDealFromCard($, el, seenKeys, dropCounts);
        if (deal) deals.push(deal);
      });
    }

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls: SOURCE_URLS,
      pagesFetched,

      dealsFound: dropCounts.totalTiles,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      dropCounts,
      deals,
    };

    const blob = await put("allbirds-sale.json", JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: payload.lastUpdated,
      via: VIA,

      sourceUrls: SOURCE_URLS,
      pagesFetched: payload.pagesFetched,

      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,

      scrapeDurationMs: payload.scrapeDurationMs,

      ok: true,
      error: null,

      dropCounts,
      blobUrl: blob.url,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls: SOURCE_URLS,
      pagesFetched,

      dealsFound: dropCounts.totalTiles,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: false,
      error: err?.message || "Unknown error",
      stack: err?.stack || null,

      dropCounts,
    });
  }
}
