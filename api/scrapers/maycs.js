// /api/scrapers/maycs.js
//
// Macy's sale running shoes scraper
// - Scrapes exactly 2 source URLs:
//   1) men's running shoes with sale/clearance/limited-time filters
//   2) women's running shoes with clearance/sale filters
// - Uses plain fetch + Cheerio first (no Firecrawl)
// - Parses Macy's product tiles from server HTML
// - Supports current single-price + previous single-price deals
// - Handles both:
//     "Now $60.00"
//     "$139.30" (without "Now")
// - Writes maycs-sale.json to Vercel Blob
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//
// TEST:
//   /api/scrapers/maycs
//
// Notes:
// - File name intentionally matches your requested spelling: maycs.js / maycs-sale.json
// - If Macy's later blocks normal fetches, then switch to Firecrawl and rename to maycs-firecrawl.js

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Macy's";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";

const SOURCE_URLS = [
  "https://www.macys.com/shop/featured/men%27s-running-shoes/Special_offers,Sport/Limited-Time%20Special%7CClearance%7CLast%20Act%7CSales%20%26%20Discounts,Running?ss=true",
  "https://www.macys.com/shop/featured/women%27s-running-shoes/Special_offers,Sport/Clearance%7CSales%20%26%20Discounts,Running?ss=true",
];

const BLOB_PATH = "maycs-sale.json";
const BASE = "https://www.macys.com";

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(href) {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, BASE).toString();
  } catch {
    return null;
  }
}

function extractFirstMoney(text) {
  const m = String(text || "").match(/\$?\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)/);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ""));
}

function parsePricingFromTile($tile) {
  const pricingRoot = $tile.find(".pricing.price-simplification").first();

  const srTexts = pricingRoot
    .find(".show-for-sr")
    .map((_, el) => cleanText($tile.constructor(el).text()))
    .get();

  const fullSr = cleanText(srTexts.join(" | "));

  let salePrice = null;
  let originalPrice = null;
  let discountPercent = null;

  // Preferred: parse from screen-reader text because it's the cleanest and
  // covers both "Now $60.00" and "Current price $139.30"
  for (const sr of srTexts) {
    if (/^(now|current price)\b/i.test(sr) && salePrice == null) {
      const saleMatch = sr.match(
        /(?:now|current price)\s*\$?\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)?/i
      );
      if (saleMatch?.[1]) {
        salePrice = Number(saleMatch[1].replace(/,/g, ""));
      }

      const discountMatch = sr.match(/([0-9]{1,3})\s*%\s*off/i);
      if (discountMatch?.[1]) {
        discountPercent = Number(discountMatch[1]);
      }
    }

    if (/^previous price\b/i.test(sr) && originalPrice == null) {
      const prevMatch = sr.match(
        /previous price\s*\$?\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)?/i
      );
      if (prevMatch?.[1]) {
        originalPrice = Number(prevMatch[1].replace(/,/g, ""));
      }
    }
  }

  // Fallbacks from visible pricing if sr text is missing or incomplete
  if (salePrice == null) {
    const discountText = cleanText(pricingRoot.find(".discount").first().text());
    salePrice = extractFirstMoney(discountText);
  }

  if (originalPrice == null) {
    const strikeText = cleanText(
      pricingRoot.find(".price-strike-sm, .current-prev-value-labels").first().text()
    );
    originalPrice = extractFirstMoney(strikeText);
  }

  if (discountPercent == null) {
    const visiblePricingText = cleanText(pricingRoot.text());
    const pctMatch = visiblePricingText.match(/([0-9]{1,3})\s*%\s*off/i);
    if (pctMatch?.[1]) {
      discountPercent = Number(pctMatch[1]);
    }
  }

  return {
    salePrice,
    originalPrice,
    discountPercent,
    pricingDebug: {
      srText: fullSr || null,
      visiblePricingText: cleanText(pricingRoot.text()) || null,
    },
  };
}

function inferGender(listingName) {
  const s = String(listingName || "").toLowerCase();

  if (/\bunisex\b/.test(s)) return "unisex";
  if (/\bmen'?s\b/.test(s)) return "mens";
  if (/\bwomen'?s\b/.test(s)) return "womens";

  return "unknown";
}

function inferShoeType(listingName) {
  const s = String(listingName || "").toLowerCase();

  if (/\btrail\b/.test(s)) return "trail";
  if (/\btrack\b|\bspike\b|\bspikes\b/.test(s)) return "track";
  if (/\brunning\b/.test(s)) return "road";

  return "unknown";
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveModel(brand, listingName) {
  let model = cleanText(listingName);

  if (!model) return "";

  // remove gender lead-in
  model = model.replace(/^(men'?s|women'?s|unisex)\s+/i, "");

  // remove brand at front if repeated
  if (brand) {
    const re = new RegExp(`^${escapeRegex(brand)}\\s+`, "i");
    model = model.replace(re, "");
  }

  // remove common tail phrases
  model = model.replace(/\s+from\s+finish\s+line$/i, "");
  model = model.replace(/\s+running\s+sneakers?$/i, "");
  model = model.replace(/\s+running\s+shoes?$/i, "");
  model = model.replace(/\s+trail\s+running\s+sneakers?$/i, "");
  model = model.replace(/\s+trail\s+running\s+shoes?$/i, "");
  model = model.replace(/\s+round\s+toe\s+running\s+shoes?$/i, "");
  model = model.replace(/\s+sneakers?$/i, "");
  model = model.replace(/\s+shoes?$/i, "");

  return cleanText(model);
}

function validImageUrl(raw) {
  const s = cleanText(raw);
  if (!s) return null;
  if (s.startsWith("data:image/svg+xml")) return null;
  return absoluteUrl(s);
}

function createEmptyDropCounts() {
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

function pushDropped(sampleArr, reason, context) {
  if (sampleArr.length >= 150) return;
  sampleArr.push({
    reason,
    ...context,
  });
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

  const allDeals = [];
  const seenListingUrls = new Set();
  const pageSummaries = [];
  const dropCounts = createEmptyDropCounts();
  const droppedDealsSample = [];
  const fetchedSourceUrls = [];

  try {
    for (const sourceUrl of SOURCE_URLS) {
      const pageSummary = {
        url: sourceUrl,
        tilesSeen: 0,
        dealsKept: 0,
        dealsDropped: 0,
        dropBreakdown: {},
        notes: [],
      };

      const resp = await fetch(sourceUrl, {
        method: "GET",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
          "accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-cache",
          pragma: "no-cache",
        },
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${sourceUrl}`);
      }

      const html = await resp.text();
      fetchedSourceUrls.push(sourceUrl);

      const $ = cheerio.load(html);

      // Try the specific tile class first; fall back to product-description parent tile shape.
      let $tiles = $(".product-thumbnail-container.vertical-alignment");

      if (!$tiles.length) {
        $tiles = $(".product-description.margin-top-xxs").parent();
        pageSummary.notes.push(
          "Primary tile selector not found; used fallback selector from product-description parent."
        );
      }

      if (!$tiles.length) {
        pageSummary.notes.push("No product tiles found on page.");
        pageSummaries.push(pageSummary);
        continue;
      }

      const tileCountText = cleanText($("body").text()).match(/Showing All\s+([0-9]+)\s+Items/i);
      if (tileCountText?.[1]) {
        pageSummary.notes.push(`Page says: Showing All ${tileCountText[1]} Items.`);
      }

      $tiles.each((_, el) => {
        dropCounts.totalTiles += 1;
        pageSummary.tilesSeen += 1;

        const $tile = $(el);

        const $link = $tile.find("a.brand-and-name").first();
        const listingName = cleanText(
          $link.find(".product-name").first().text() || $link.attr("title") || ""
        );
        const brand = cleanText($link.find(".product-brand").first().text());
        const rawHref = $link.attr("href");
        const listingURL = absoluteUrl(rawHref);

        const rawImage =
          $tile.find("img.picture-image").first().attr("data-src") ||
          $tile.find("img.picture-image").first().attr("src") ||
          $tile.find("img").first().attr("data-src") ||
          $tile.find("img").first().attr("src") ||
          "";
        const imageURL = validImageUrl(rawImage);

        const badgeText = cleanText($tile.find(".corner-badge").first().text());
        const { salePrice, originalPrice, discountPercent, pricingDebug } = parsePricingFromTile($tile);

        const gender = inferGender(listingName);
        const shoeType = inferShoeType(listingName);
        const model = deriveModel(brand, listingName);

        const pageDrop = (reason, extra = {}) => {
          dropCounts[reason] += 1;
          pageSummary.dealsDropped += 1;
          pageSummary.dropBreakdown[reason] = (pageSummary.dropBreakdown[reason] || 0) + 1;

          pushDropped(droppedDealsSample, reason, {
            sourceUrl,
            listingName: listingName || null,
            brand: brand || null,
            rawHref: rawHref || null,
            listingURL: listingURL || null,
            imageURL: imageURL || null,
            badge: badgeText || null,
            ...pricingDebug,
            ...extra,
          });
        };

        if (!listingName) return pageDrop("dropped_missingListingName");
        if (!brand) return pageDrop("dropped_missingBrand");
        if (!model) return pageDrop("dropped_missingModel");
        if (!listingURL) return pageDrop("dropped_missingListingURL");
        if (!imageURL) return pageDrop("dropped_missingImageURL");
        if (salePrice == null || Number.isNaN(salePrice)) {
          return pageDrop("dropped_missingSalePrice");
        }
        if (originalPrice == null || Number.isNaN(originalPrice)) {
          return pageDrop("dropped_missingOriginalPrice");
        }
        if (!(salePrice < originalPrice)) {
          return pageDrop("dropped_saleNotLessThanOriginal", {
            salePrice,
            originalPrice,
          });
        }

        const computedDiscount = Math.round(((originalPrice - salePrice) / originalPrice) * 100);

        if (!(computedDiscount >= 1 && computedDiscount <= 99)) {
          return pageDrop("dropped_invalidDiscountPercent", {
            salePrice,
            originalPrice,
            computedDiscount,
            discountPercentFromPage: discountPercent,
          });
        }

        if (seenListingUrls.has(listingURL)) {
          return pageDrop("dropped_duplicateListingURL");
        }
        seenListingUrls.add(listingURL);

        allDeals.push({
          schemaVersion: SCHEMA_VERSION,

          listingName,

          brand,
          model,

          salePrice,
          originalPrice,
          discountPercent: computedDiscount,

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

        pageSummary.dealsKept += 1;
      });

      if (!pageSummary.notes.length) {
        pageSummary.notes.push("Parsed with primary Macy's product tile selector.");
      }

      pageSummaries.push(pageSummary);
    }

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls: fetchedSourceUrls,
      pagesFetched: fetchedSourceUrls.length,

      dealsFound: dropCounts.totalTiles,
      dealsExtracted: allDeals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      droppedDealsSample,
      pageSummaries,

      deals: allDeals,
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
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: payload.lastUpdated,
      via: VIA,
      sourceUrls: fetchedSourceUrls,
      pagesFetched: payload.pagesFetched,
      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,
      scrapeDurationMs: payload.scrapeDurationMs,
      ok: true,
      error: null,
      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      pageSummaries,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,
      sourceUrls: fetchedSourceUrls,
      pagesFetched: fetchedSourceUrls.length,
      dealsFound: dropCounts.totalTiles,
      dealsExtracted: allDeals.length,
      scrapeDurationMs: Date.now() - startedAt,
      ok: false,
      error: err?.message || "Unknown error",
      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      droppedDealsSample,
      pageSummaries,
    });
  }
}
