// /api/scrapers/skechers-sale.js

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Skechers";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";

const BASE_URL = "https://www.skechers.com";
const PAGE_SIZE = 12;
const MAX_PAGES = 40;

const START_URL =
  "https://www.skechers.com/sale/?prefn1=productLine&prefn2=gender&prefn3=cattype&prefn4=categorySport&prefv1=FOOTWEAR&prefv2=W%7CU%7CM&prefv3=Athletic&prefv4=Running&start=0&sz=12";

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toAbsoluteUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, BASE_URL).toString();
  } catch {
    return null;
  }
}

function parsePrice(value) {
  const s = String(value || "").replace(/,/g, "").trim();
  if (!s) return null;
  const m = s.match(/\d+(?:\.\d{1,2})?/);
  if (!m) return null;
  const n = Number(m[0]);
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

function parseGender(raw) {
  const s = cleanText(raw).toLowerCase();
  if (s === "men's" || s === "mens" || s === "men") return "mens";
  if (s === "women's" || s === "womens" || s === "women") return "womens";
  if (s === "unisex") return "unisex";
  return "unknown";
}

function parseModelFromListingName(listingName) {
  let s = cleanText(listingName);

  // Special Skechers rule:
  // If listingName starts with "Skechers Slip-ins:" remove that prefix
  // before parsing model so merge-deals can normalize the model better.
  // Example:
  // "Skechers Slip-ins: GO RUN Anywhere - Ember"
  // becomes:
  // "GO RUN Anywhere - Ember"
  s = s.replace(/^skechers\s+slip-ins:\s*/i, "");

  // Also remove plain leading brand name if present.
  s = s.replace(/^skechers\s+/i, "");

  return s || "Unknown";
}

function buildHeaders() {
  return {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://www.skechers.com/",
    pragma: "no-cache",
    "cache-control": "no-cache",
  };
}

function buildPageUrl(start) {
  const url = new URL(START_URL);
  url.searchParams.set("start", String(start));
  url.searchParams.set("sz", String(PAGE_SIZE));
  return url.toString();
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
   const auth = req.headers.authorization;
   if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
     return res.status(401).json({ success: false, error: "Unauthorized" });
   }

  const sourceUrls = [];
  const seenPageUrls = new Set();
  const seenDealUrls = new Set();
  const deals = [];

  const dropCounts = {
    totalTiles: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingGender: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_duplicateAfterMerge: 0,
  };

  let pagesFetched = 0;
  let dealsFound = 0;
  let ok = true;
  let error = null;

  try {
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const start = pageIndex * PAGE_SIZE;
      const pageUrl = buildPageUrl(start);

      if (seenPageUrls.has(pageUrl)) break;
      seenPageUrls.add(pageUrl);
      sourceUrls.push(pageUrl);

      const html = await fetchHtml(pageUrl);
      const $ = cheerio.load(html);

      const $tiles = $("div.product-V2");

      // stop if infinite-load endpoint returns no more tiles
      if (!$tiles.length) {
        sourceUrls.pop();
        break;
      }

      pagesFetched += 1;
      dealsFound += $tiles.length;
      dropCounts.totalTiles += $tiles.length;

      let newUniqueDealsOnPage = 0;

      $tiles.each((_, el) => {
        const $tile = $(el);

        const listingName = cleanText(
          $tile.find("a.c-product-tile-V2__title").first().text()
        );
        if (!listingName) {
          dropCounts.dropped_missingListingName += 1;
          return;
        }

        const listingURL = toAbsoluteUrl(
          $tile.find("a.c-product-tile-V2__title").first().attr("href") ||
            $tile.find(".image-container-V2 a").first().attr("href")
        );
        if (!listingURL) {
          dropCounts.dropped_missingListingURL += 1;
          return;
        }

        const imageURL = toAbsoluteUrl(
          $tile.find("img.tile-image").first().attr("src")
        );
        if (!imageURL) {
          dropCounts.dropped_missingImageURL += 1;
          return;
        }

        const genderRaw = cleanText(
          $tile.find(".c-product-V2-tile__gender").first().text()
        );
        const gender = parseGender(genderRaw);
        if (gender === "unknown") {
          dropCounts.dropped_missingGender += 1;
          return;
        }

        const salePrice =
          parsePrice($tile.find(".price-V2 .sales .value").first().attr("content")) ||
          parsePrice($tile.find(".price-V2 .sales .value").first().text());

        if (!Number.isFinite(salePrice)) {
          dropCounts.dropped_missingSalePrice += 1;
          return;
        }

        const originalPrice =
          parsePrice($tile.find(".price-V2 del .value").first().attr("content")) ||
          parsePrice($tile.find(".price-V2 del .value").first().text());

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
        newUniqueDealsOnPage += 1;

        deals.push({
          schemaVersion: SCHEMA_VERSION,

          listingName,

          brand: "Skechers",
          model: parseModelFromListingName(listingName),

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

          gender,
          shoeType: "unknown",
        });
      });

      // stop if this offset page produced nothing new
      if (newUniqueDealsOnPage === 0) break;

      // stop if returned fewer than page size
      if ($tiles.length < PAGE_SIZE) break;
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

    const blob = await put("skechers-sale.json", JSON.stringify(payload, null, 2), {
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
      const blob = await put("skechers-sale.json", JSON.stringify(payload, null, 2), {
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
