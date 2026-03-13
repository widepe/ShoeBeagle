// /api/scrapers/sierra-firecrawl.js
//
// Sierra clearance running shoes scraper
// Saves blob as: sierra.json
//
// Notes:
// - Uses Firecrawl raw HTML to avoid direct-fetch 403
// - Pulls only from the running clearance listing pages
// - Reads page count from pagination if available, otherwise falls back to MAX_PAGES
// - Tracks why deals are dropped
// - Includes page summaries
//
// ENV:
// - BLOB_READ_WRITE_TOKEN
// - FIRECRAWL_API_KEY
//
// TEST:
// /api/scrapers/sierra-clearance
//
// CRON auth (temporarily commented out for testing)

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Sierra";
const SCHEMA_VERSION = 1;
const VIA = "firecrawl-html";
const BASE = "https://www.sierra.com";

const START_URL =
  "https://www.sierra.com/clearance~1/shoes~d~4/shoes-by-activity~d~15010/running~d~15016/";

const MAX_PAGES = 10;
const BLOB_PATH = "sierra.json";
const MAX_DROPPED_SAMPLE = 200;
const PLACEHOLDER_IMAGES = new Set([
  "https://s.stpost.com/img/blank.gif",
]);export default async function handler(req, res) {
  const startedAt = Date.now();

  // CRON auth (temporarily commented out for testing)
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const dropCounts = createDropCounts();
  const droppedDealsSample = [];
  const pageSummaries = [];
  const sourceUrls = [];
  const deals = [];
  const seenUrls = new Set();

  try {
    const firstHtml = await fetchHtml(START_URL);
    const first$ = cheerio.load(firstHtml);

    const totalItemsReported = parseItemsCount(first$);
    const discoveredPageCount = detectTotalPages(first$);
    const totalPages = Math.max(1, Math.min(discoveredPageCount || 1, MAX_PAGES));

    for (let pageNum = 1; pageNum <= totalPages; pageNum += 1) {
      const pageUrl = buildPageUrl(pageNum);
      sourceUrls.push(pageUrl);

      const pageStart = Date.now();
      const html = pageNum === 1 ? firstHtml : await fetchHtml(pageUrl);
      const $ = cheerio.load(html);

      const $tiles = $(".productThumbnailContainer.js-productThumbnailParent");
      const pageDropCounts = createPerPageDropCounts();

      let pageFound = 0;
      let pageExtracted = 0;

      $tiles.each((_, el) => {
        dropCounts.totalTiles += 1;
        pageFound += 1;

        const result = extractDeal($(el));

        if (!result.ok) {
          incrementDrop(result.reason, dropCounts, pageDropCounts);
          addDroppedSample(droppedDealsSample, {
            page: pageNum,
            reason: result.reason,
            listingName: result.partial?.listingName || null,
            brand: result.partial?.brand || null,
            listingURL: result.partial?.listingURL || null,
          });
          return;
        }

        const deal = result.deal;

        if (seenUrls.has(deal.listingURL)) {
          incrementDrop("dropped_duplicateListingURL", dropCounts, pageDropCounts);
          addDroppedSample(droppedDealsSample, {
            page: pageNum,
            reason: "dropped_duplicateListingURL",
            listingName: deal.listingName,
            brand: deal.brand,
            listingURL: deal.listingURL,
          });
          return;
        }

        seenUrls.add(deal.listingURL);
        deals.push(deal);
        pageExtracted += 1;
      });

      pageSummaries.push({
        page: pageNum,
        url: pageUrl,
        foundTiles: pageFound,
        extractedDeals: pageExtracted,
        droppedDeals: pageFound - pageExtracted,
        durationMs: Date.now() - pageStart,
        ...pageDropCounts,
      });
    }

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls,
      pagesFetched: sourceUrls.length,

      totalItemsReported,
      dealsFound: dropCounts.totalTiles,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      droppedDealsSample,
      pageSummaries,

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
      totalItemsReported: payload.totalItemsReported,
      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,
      scrapeDurationMs: payload.scrapeDurationMs,
      dropCounts: payload.dropCounts,
      pageSummaries: payload.pageSummaries,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: err?.message || String(err),
      scrapeDurationMs: Date.now() - startedAt,
      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      droppedDealsSample,
      pageSummaries,
    });
  }
}

async function fetchHtml(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error("Missing FIRECRAWL_API_KEY");
  }

  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["html"],
      onlyMainContent: false,
      waitFor: 3000,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Firecrawl HTTP ${resp.status} for ${url} :: ${text}`);
  }

  const json = await resp.json();
  const html = json?.data?.html || json?.html || "";

  if (!html || typeof html !== "string") {
    throw new Error(`No HTML returned by Firecrawl for ${url}`);
  }

  return html;
}

function buildPageUrl(pageNum) {
  if (pageNum <= 1) return START_URL;
  return `${START_URL}${pageNum}/`;
}

function parseItemsCount($) {
  const raw =
    $("#numberOfItems").text().trim() ||
    $('span[id="numberOfItems"]').text().trim();

  const m = raw.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function detectTotalPages($) {
  let maxPage = 1;

  $('.productListingPagination a.pageLink[href]').each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const aria = ($(el).attr("aria-label") || "").trim();
    const text = $(el).text().trim();

    if (!href || href === "javascript:void(0)") return;

    const pathMatch = href.match(/\/(\d+)\/?$/);
    if (pathMatch) {
      const n = Number(pathMatch[1]);
      if (Number.isFinite(n) && n > maxPage) maxPage = n;
    }

    const combined = `${aria} ${text}`;
    const numMatch = combined.match(/(\d+)/);
    if (numMatch) {
      const n = Number(numMatch[1]);
      if (Number.isFinite(n) && n > maxPage) maxPage = n;
    }
  });

  return maxPage || 1;
}

function extractDeal($tile) {
  const partial = {};

  const ga = $tile.find(".js-gaShoppingAndMarketing").first();

  const rawBrand =
    cleanText(ga.attr("data-brand")) ||
    cleanText(ga.attr("data-Brand")) ||
    cleanText($tile.find(".productBrand").first().text());

  const rawName =
    cleanText(ga.attr("data-name")) ||
    cleanText(ga.attr("data-Name")) ||
    cleanText($tile.find(".productCard-title-name a").first().text());

  const rawDepartment =
    cleanText(ga.attr("data-department")) ||
    cleanText(ga.attr("data-Department")) ||
    "";

  const href =
    $tile.find(".productCard-title-name a[href]").first().attr("href") ||
    $tile.find("a.js-productThumbnail[href]").first().attr("href") ||
    "";

  const imgSrc =
    $tile.find("img.productThumbnail").first().attr("src") ||
    $tile.find("img.productThumbnail").first().attr("data-src") ||
    "";

  const saleText = cleanText($tile.find(".ourPrice.text-sale").first().text());
  const compareText = cleanText($tile.find(".savingsBlock .retailPrice").first().text());

  partial.brand = normalizeWhitespace(rawBrand);
  partial.listingName = normalizeWhitespace(rawName);
  partial.listingURL = absolutizeUrl(href);
  partial.imageURL = absolutizeUrl(imgSrc);

  if (!partial.listingName) {
    return { ok: false, reason: "dropped_missingListingName", partial };
  }

  if (!partial.brand) {
    return { ok: false, reason: "dropped_missingBrand", partial };
  }

  const model = deriveModel(partial.listingName, partial.brand);
  partial.model = model;

  if (!model) {
    return { ok: false, reason: "dropped_missingModel", partial };
  }

  if (!partial.listingURL) {
    return { ok: false, reason: "dropped_missingListingURL", partial };
  }

if (!partial.imageURL || PLACEHOLDER_IMAGES.has(partial.imageURL)) {
  return { ok: false, reason: "dropped_missingImageURL", partial };
}

  const salePrice = parseMoney(saleText);
  if (salePrice == null) {
    return { ok: false, reason: "dropped_missingSalePrice", partial };
  }

  const originalPrice = parseCompareAt(compareText);
  if (originalPrice == null) {
    return { ok: false, reason: "dropped_missingOriginalPrice", partial };
  }

  if (!(salePrice < originalPrice)) {
    return { ok: false, reason: "dropped_saleNotLessThanOriginal", partial };
  }

  const discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);

  if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent >= 100) {
    return { ok: false, reason: "dropped_invalidDiscountPercent", partial };
  }

  const gender = deriveGender(partial.listingName, rawDepartment);
  const shoeType = deriveShoeType(partial.listingName, rawDepartment);

  const deal = {
    schemaVersion: SCHEMA_VERSION,

    listingName: partial.listingName,

    brand: partial.brand,
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

    listingURL: partial.listingURL,
    imageURL: partial.imageURL,

    gender,
    shoeType,
  };

  return { ok: true, deal };
}

function deriveModel(listingName, brand) {
  let s = listingName || "";

  s = s.replace(/\s*\([^)]*\)\s*$/i, "");
  s = s.replace(/\s+in\s+.+$/i, "");
  s = s.trim();

  if (!s) return null;

  if (brand) {
    const escaped = escapeRegex(brand.trim());
    s = s.replace(new RegExp(`^${escaped}\\s+`, "i"), "").trim();
  }

  return s || null;
}

function deriveGender(listingName, departmentText) {
  const hay = `${listingName || ""} ${departmentText || ""}`.toLowerCase();

  if (
    /\bfor men and women\b/.test(hay) ||
    /\bmen and women\b/.test(hay) ||
    /\bunisex\b/.test(hay)
  ) {
    return "unisex";
  }

  if (/\bmen'?s\b/.test(hay) || /\bfor men\b/.test(hay)) return "mens";
  if (/\bwomen'?s\b/.test(hay) || /\bfor women\b/.test(hay)) return "womens";

  return "unknown";
}

function deriveShoeType(listingName, departmentText) {
  const hay = `${listingName || ""} ${departmentText || ""}`.toLowerCase();

  if (/\btrail\b/.test(hay)) return "trail";
  if (/\btrack\b/.test(hay) || /\bspike\b/.test(hay) || /\bspikes\b/.test(hay)) return "track";
  if (/\brunning\b/.test(hay)) return "road";

  return "unknown";
}

function parseMoney(text) {
  if (!text) return null;

  const cleaned = text.replace(/,/g, "");
  const m = cleaned.match(/\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/);

  if (!m) return null;

  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseCompareAt(text) {
  return parseMoney(text);
}

function absolutizeUrl(url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${BASE}${url}`;
  return `${BASE}/${url}`;
}

function cleanText(s) {
  return decodeHtmlEntities((s || "").replace(/\s+/g, " ").trim());
}

function normalizeWhitespace(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(str) {
  return (str || "")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&reg;/gi, "®")
    .replace(/&#174;/g, "®")
    .replace(/&trade;/gi, "™")
    .replace(/&#8482;/g, "™")
    .trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createDropCounts() {
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
    dropped_duplicateListingURL: 0,
  };
}

function createPerPageDropCounts() {
  return {
    dropped_missingListingName: 0,
    dropped_missingBrand: 0,
    dropped_missingModel: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_invalidDiscountPercent: 0,
    dropped_duplicateListingURL: 0,
  };
}

function incrementDrop(reason, totalCounts, pageCounts) {
  if (reason in totalCounts) totalCounts[reason] += 1;
  if (reason in pageCounts) pageCounts[reason] += 1;
}

function addDroppedSample(arr, item) {
  if (arr.length < MAX_DROPPED_SAMPLE) {
    arr.push(item);
  }
}
