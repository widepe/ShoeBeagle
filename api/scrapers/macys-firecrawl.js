// /api/scrapers/macys-firecrawl.js
//
// Macy's sale running shoes scraper
// - Uses Firecrawl raw HTML to bypass direct-fetch 403
// - Scrapes exactly 2 source URLs:
//   1) men's running shoes with sale/clearance/limited-time filters
//   2) women's running shoes with clearance/sale filters
// - Parses Macy's product tiles from HTML
// - Supports pricing patterns like:
//     "Now $60.00"
//     "$139.30" (no "Now", but discounted)
// - Writes macys-sale.json to Vercel Blob
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//   - FIRECRAWL_API_KEY
//
// TEST:
//   /api/scrapers/maycs-firecrawl
//
// Notes:
// - File name intentionally remains maycs-firecrawl.js if you want
// - Blob path is corrected to macys-sale.json

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Macy's";
const SCHEMA_VERSION = 1;
const VIA = "firecrawl-raw-html";
const BASE = "https://www.macys.com";
const BLOB_PATH = "macys-sale.json";

const SOURCE_URLS = [
  "https://www.macys.com/shop/featured/men%27s-running-shoes/Special_offers,Sport/Limited-Time%20Special%7CClearance%7CLast%20Act%7CSales%20%26%20Discounts,Running?ss=true",
  "https://www.macys.com/shop/featured/women%27s-running-shoes/Special_offers,Sport/Clearance%7CSales%20%26%20Discounts,Running?ss=true",
];

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

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function deriveModel(brand, listingName) {
  let model = cleanText(listingName);
  if (!model) return "";

  model = model.replace(/^(men'?s|women'?s|unisex)\s+/i, "");

  if (brand) {
    const re = new RegExp(`^${escapeRegex(brand)}\\s+`, "i");
    model = model.replace(re, "");
  }

  model = model.replace(/\s+from\s+finish\s+line$/i, "");
  model = model.replace(/\s+trail\s+running\s+sneakers?$/i, "");
  model = model.replace(/\s+trail\s+running\s+shoes?$/i, "");
  model = model.replace(/\s+round\s+toe\s+running\s+shoes?$/i, "");
  model = model.replace(/\s+running\s+sneakers?$/i, "");
  model = model.replace(/\s+running\s+shoes?$/i, "");
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

function parsePricingFromTile($, $tile) {
  const pricingRoot = $tile.find(".pricing.price-simplification").first();

  const srTexts = pricingRoot
    .find(".show-for-sr")
    .map((_, el) => cleanText($(el).text()))
    .get();

  const fullSr = cleanText(srTexts.join(" | "));

  let salePrice = null;
  let originalPrice = null;
  let discountPercent = null;

  for (const sr of srTexts) {
    if (/^(now|current price)\b/i.test(sr) && salePrice == null) {
      const saleMatch = sr.match(
        /(?:now|current price)\s*\$?\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i
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
        /previous price\s*\$?\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i
      );
      if (prevMatch?.[1]) {
        originalPrice = Number(prevMatch[1].replace(/,/g, ""));
      }
    }
  }

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

async function fetchViaFirecrawl(url) {
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
      waitFor: 2000,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Firecrawl HTTP ${resp.status} for ${url}${text ? ` :: ${text}` : ""}`);
  }

  const json = await resp.json();

  const html =
    json?.data?.html ||
    json?.html ||
    null;

  if (!html || typeof html !== "string") {
    throw new Error(`Firecrawl returned no HTML for ${url}`);
  }

  return html;
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  // CRON auth (temporarily commented out for testing)
  
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  

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

      const html = await fetchViaFirecrawl(sourceUrl);
      fetchedSourceUrls.push(sourceUrl);

      const $ = cheerio.load(html);

      let $tiles = $(".product-thumbnail-container.vertical-alignment");

      if (!$tiles.length) {
        $tiles = $(".product-description.margin-top-xxs").closest(".product-thumbnail-container");
        if ($tiles.length) {
          pageSummary.notes.push(
            "Primary selector missing; recovered tiles from product-description closest product container."
          );
        }
      }

      if (!$tiles.length) {
        $tiles = $(".product-description.margin-top-xxs").parent();
        if ($tiles.length) {
          pageSummary.notes.push(
            "Primary selector missing; used product-description parent as fallback."
          );
        }
      }

      const bodyText = cleanText($("body").text());
      const showingAllMatch = bodyText.match(/Showing All\s+([0-9]+)\s+Items/i);
      if (showingAllMatch?.[1]) {
        pageSummary.notes.push(`Page says: Showing All ${showingAllMatch[1]} Items.`);
      }

      if (!$tiles.length) {
        pageSummary.notes.push("No product tiles found in Firecrawl HTML.");
        pageSummaries.push(pageSummary);
        continue;
      }

      $tiles.each((_, el) => {
        dropCounts.totalTiles += 1;
        pageSummary.tilesSeen += 1;

        const $tile = $(el);
        const $link = $tile.find("a.brand-and-name").first();

        const listingName = cleanText(
          $link.find(".product-name").first().text() ||
          $link.attr("title") ||
          $tile.find(".product-name").first().text() ||
          ""
        );

        const brand = cleanText(
          $link.find(".product-brand").first().text() ||
          $tile.find(".product-brand").first().text() ||
          ""
        );

        const rawHref =
          $link.attr("href") ||
          $tile.find("a[href*='/shop/product/']").first().attr("href") ||
          "";
        const listingURL = absoluteUrl(rawHref);

        const rawImage =
          $tile.find("img.picture-image").first().attr("data-src") ||
          $tile.find("img.picture-image").first().attr("src") ||
          $tile.find("img").first().attr("data-src") ||
          $tile.find("img").first().attr("src") ||
          "";
        const imageURL = validImageUrl(rawImage);

        const badgeText = cleanText($tile.find(".corner-badge").first().text());

        const { salePrice, originalPrice, discountPercent, pricingDebug } = parsePricingFromTile(
          $,
          $tile
        );

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
        pageSummary.notes.push("Parsed with primary Macy's product tile selector from Firecrawl HTML.");
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
      blobUrl: blob.url,
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
