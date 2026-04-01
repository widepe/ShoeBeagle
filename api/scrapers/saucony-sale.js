// /api/scrapers/saucony-sale.js

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Saucony";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";

const START_URL = "https://www.saucony.com/en/sale-running/";
const MAX_PAGES = 20;

function nowIso() {
  return new Date().toISOString();
}

function toAbsoluteUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, START_URL).toString();
  } catch {
    return null;
  }
}

function cleanText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(text) {
  if (!text) return null;
  const m = String(text).replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseGender(listingName) {
  const s = cleanText(listingName).toLowerCase();
  if (s.startsWith("men's ") || s.startsWith("mens ")) return "mens";
  if (s.startsWith("women's ") || s.startsWith("womens ")) return "womens";
  if (s.startsWith("unisex ")) return "unisex";
  return "unknown";
}

function parseModel(listingName) {
  let s = cleanText(listingName);

  s = s.replace(/^men'?s\s+/i, "");
  s = s.replace(/^women'?s\s+/i, "");
  s = s.replace(/^unisex\s+/i, "");

  return s || "Unknown";
}

function deriveSauconyShoeTypeFromAttrs(attrs) {
  const surfaceRaw = String(attrs?.surface || "")
    .trim()
    .toLowerCase();

  if (!surfaceRaw) return "unknown";

  const parts = surfaceRaw
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  const joined = parts.join(",");

  // Track / spikes
  if (
    joined.includes("fieldtrack") ||
    parts.includes("track") ||
    joined.includes("spike") ||
    joined.includes("spikes")
  ) {
    return "track";
  }

  // Trail
  if (parts.includes("trail")) {
    return "trail";
  }

  // Treadmill counts as road
  if (parts.includes("road") || parts.includes("treadmill")) {
    return "road";
  }

  return "unknown";
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

function buildHeaders() {
  return {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://www.saucony.com/",
    pragma: "no-cache",
    "cache-control": "no-cache",
  };
}

function getTileImageUrl($tile) {
  const img = $tile.find(".main-image img").first();

  return (
    toAbsoluteUrl(img.attr("data-main-image-url")) ||
    toAbsoluteUrl(img.attr("data-src")) ||
    toAbsoluteUrl(img.attr("src")) ||
    null
  );
}

function getTileListingUrl($tile) {
  return (
    toAbsoluteUrl($tile.find("a.thumb-link").first().attr("href")) ||
    toAbsoluteUrl($tile.find(".product-name a.name-link").first().attr("href")) ||
    null
  );
}

function getTileListingName($tile) {
  return cleanText($tile.find(".product-name a.name-link").first().text());
}

function getTileAttrs($tile) {
  const raw = $tile.attr("data-product-attributes");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getNextLoadMoreUrl($) {
  const raw = $("button.load-more-cta").first().attr("data-grid-url");
  return raw ? toAbsoluteUrl(raw) : null;
}

async function fetchHtml(url) {
  const resp = await fetch(url, {
    method: "GET",
    headers: buildHeaders(),
  });

  if (!resp.ok) {
    throw new Error(`Fetch failed ${resp.status} for ${url}`);
  }

  return await resp.text();
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  // CRON_SECRET
 //  const auth = req.headers.authorization;
//   if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
//     return res.status(401).json({ success: false, error: "Unauthorized" });
//   }

  const sourceUrls = [];
  const seenPageUrls = new Set();
  const seenDealUrls = new Set();
  const deals = [];

  const dropCounts = {
    totalTiles: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_duplicateAfterMerge: 0,
  };

  let pagesFetched = 0;
  let dealsFound = 0;
  let currentUrl = START_URL;
  let ok = true;
  let error = null;

  try {
    while (currentUrl && pagesFetched < MAX_PAGES) {
      if (seenPageUrls.has(currentUrl)) break;
      seenPageUrls.add(currentUrl);
      sourceUrls.push(currentUrl);

      const html = await fetchHtml(currentUrl);
      const $ = cheerio.load(html);

      const $tiles = $(".product-tile");
      pagesFetched += 1;
      dealsFound += $tiles.length;
      dropCounts.totalTiles += $tiles.length;

      $tiles.each((_, el) => {
        const $tile = $(el);

        const listingName = getTileListingName($tile);
        if (!listingName) {
          dropCounts.dropped_missingListingName += 1;
          return;
        }

        const listingURL = getTileListingUrl($tile);
        if (!listingURL) {
          dropCounts.dropped_missingListingURL += 1;
          return;
        }

        const imageURL = getTileImageUrl($tile);
        if (!imageURL) {
          dropCounts.dropped_missingImageURL += 1;
          return;
        }

        const salePrice = parsePrice(
          cleanText($tile.find(".product-sales-price").first().text())
        );
        if (!Number.isFinite(salePrice)) {
          dropCounts.dropped_missingSalePrice += 1;
          return;
        }

        const originalPrice = parsePrice(
          cleanText($tile.find(".product-standard-price").first().text())
        );
        if (!Number.isFinite(originalPrice)) {
          dropCounts.dropped_missingOriginalPrice += 1;
          return;
        }

        if (!(salePrice < originalPrice)) {
          dropCounts.dropped_saleNotLessThanOriginal += 1;
          return;
        }

        if (seenDealUrls.has(listingURL)) {
          dropCounts.dropped_duplicateAfterMerge += 1;
          return;
        }
        seenDealUrls.add(listingURL);

        const attrs = getTileAttrs($tile);
        const gender = parseGender(listingName);
        const shoeType = deriveSauconyShoeTypeFromAttrs(attrs);
        const model = parseModel(listingName);
        const discountPercent = computeDiscountPercent(salePrice, originalPrice);

        deals.push({
          schemaVersion: SCHEMA_VERSION,

          listingName,

          brand: "Saucony",
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

      currentUrl = getNextLoadMoreUrl($);
    }

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      dropCounts,

      deals,
    };

    const blob = await put("saucony-sale.json", JSON.stringify(payload, null, 2), {
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
      sourceUrls,
      pagesFetched,
      dealsFound,
      dealsExtracted: deals.length,
      scrapeDurationMs: payload.scrapeDurationMs,
      ok: true,
      error: null,
      dropCounts,
      blobUrl: blob.url,
    });
  } catch (err) {
    ok = false;
    error = err?.message || "Unknown error";

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok,
      error,

      dropCounts,

      deals,
    };

    try {
      const blob = await put("saucony-sale.json", JSON.stringify(payload, null, 2), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
      });

      return res.status(500).json({
        success: false,
        store: STORE,
        schemaVersion: SCHEMA_VERSION,
        lastUpdated: payload.lastUpdated,
        via: VIA,
        sourceUrls,
        pagesFetched,
        dealsFound,
        dealsExtracted: deals.length,
        scrapeDurationMs: payload.scrapeDurationMs,
        ok,
        error,
        dropCounts,
        blobUrl: blob.url,
      });
    } catch (blobErr) {
      return res.status(500).json({
        success: false,
        store: STORE,
        schemaVersion: SCHEMA_VERSION,
        lastUpdated: nowIso(),
        via: VIA,
        sourceUrls,
        pagesFetched,
        dealsFound,
        dealsExtracted: deals.length,
        scrapeDurationMs: Date.now() - startedAt,
        ok,
        error: `${error}; blob upload failed: ${blobErr?.message || "unknown blob error"}`,
        dropCounts,
      });
    }
  }
}
