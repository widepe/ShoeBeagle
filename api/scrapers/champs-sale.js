// /api/scrapers/champs-sale.js
//
// Champs Sports sale running shoes scraper
// - Scrapes the sale running shoes page HTML directly
// - Parses product cards from returned HTML
// - Attempts light pagination discovery from page links / rel=next
// - Keeps only true sale items with BOTH salePrice and originalPrice
//   where salePrice < originalPrice
//
// OUTPUT BLOB:
// - champs-sale.json
//
// EXPECTED ENV:
// - BLOB_READ_WRITE_TOKEN
//
// REGISTRY ENV VAR FOR MERGE:
// - CHAMPS_DEALS_BLOB_URL
//
// TEST:
// - /api/scrapers/champs-sale
//
// CRON auth included but commented out for testing.

import { put } from "@vercel/blob";
import * as cheerio from "cheerio";

export const config = { maxDuration: 60 };

const STORE = "Champs Sports";
const SCHEMA_VERSION = 1;
const VIA = "html-cheerio";
const BASE = "https://www.champssports.com";

const START_URLS = [
  "https://www.champssports.com/category/sport/running/sale/shoes.html?query=%3Arelevance%3Acollection_id%3Asale-running-shoes%3Astyle%3APerformance+Running+Shoes",
];

const MAX_PAGES = 5;
const MAX_DROPPED_SAMPLE = 200;

const MULTI_WORD_BRANDS = [
  "new balance",
  "under armour",
  "topo athletic",
  "brooks running",
  "on running",
  "hoka one one",
  "hoka",
  "asics",
  "saucony",
  "adidas",
  "nike",
  "puma",
  "mizuno",
  "skechers",
  "reebok",
  "brooks",
  "altra",
  "salomon",
  "merrell",
  "on",
];

export default async function handler(req, res) {
  const startedAt = Date.now();

  // CRON auth (temporarily commented out for testing)
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const sourceUrls = [];
  const deals = [];
  const seen = new Set();
  const visitedPages = new Set();
  const queue = [...START_URLS];
  const pageSummaries = [];
  const droppedDealsSample = [];

  const dropCounts = {
    totalCards: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_invalidDiscountPercent: 0,
    dropped_duplicateAfterMerge: 0,
    dropped_parseError: 0,
  };

  let pagesFetched = 0;
  let dealsFound = 0;

  try {
    while (queue.length && pagesFetched < MAX_PAGES) {
      const pageUrl = queue.shift();
      if (!pageUrl || visitedPages.has(pageUrl)) continue;
      visitedPages.add(pageUrl);

      const resp = await fetch(pageUrl, {
        headers: buildHeaders(pageUrl),
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${pageUrl}`);
      }

      const html = await resp.text();
      const $ = cheerio.load(html);

      const $cards = $(".product-container .ProductCard, .product-container-mobile-v3 .ProductCard");
      const cardsFound = $cards.length;

      const summary = {
        pageUrl,
        cardsFound,
        cardsAccepted: 0,
        dropReasons: {},
        discoveredNextPages: [],
        stopReason: null,
      };

      sourceUrls.push(pageUrl);
      pagesFetched += 1;
      dealsFound += cardsFound;

      if (!cardsFound) {
        summary.stopReason = "no_product_cards_found";
        pageSummaries.push(summary);
        continue;
      }

      $cards.each((_, el) => {
        dropCounts.totalCards += 1;

        const normalized = normalizeCard($, $(el));

        if (!normalized.ok) {
          incrementDrop(dropCounts, summary, normalized.reason);
          pushDroppedSample(droppedDealsSample, normalized.sample);
          return;
        }

        const deal = normalized.deal;
        const dedupeKey = deal.listingURL;

        if (seen.has(dedupeKey)) {
          incrementDrop(dropCounts, summary, "dropped_duplicateAfterMerge");
          pushDroppedSample(droppedDealsSample, {
            reason: "dropped_duplicateAfterMerge",
            listingName: deal.listingName,
            listingURL: deal.listingURL,
          });
          return;
        }

        seen.add(dedupeKey);
        deals.push(deal);
        summary.cardsAccepted += 1;
      });

      const nextPages = discoverPaginationUrls($, pageUrl);
      for (const nextPage of nextPages) {
        if (!visitedPages.has(nextPage) && !queue.includes(nextPage) && sourceUrls.length + queue.length < MAX_PAGES + START_URLS.length) {
          queue.push(nextPage);
          summary.discoveredNextPages.push(nextPage);
        }
      }

      if (!summary.discoveredNextPages.length) {
        summary.stopReason = "no_next_page_detected";
      }

      pageSummaries.push(summary);
    }

    const body = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
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

    const blob = await put("champs-sale.json", JSON.stringify(body, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobUrl: blob.url,
      pagesFetched,
      dealsFound,
      dealsExtracted: deals.length,
      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      pageSummaries,
      scrapeDurationMs: body.scrapeDurationMs,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: error instanceof Error ? error.message : String(error),
      pagesFetched,
      dealsFound,
      dealsExtracted: deals.length,
      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      droppedDealsSample,
      pageSummaries,
      scrapeDurationMs: Date.now() - startedAt,
    });
  }
}

function buildHeaders(referer) {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer,
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  };
}

function normalizeCard($, $card) {
  try {
    const $link = $card.find("a.ProductCard-link").first();

    const rawListingName = cleanText(
      $link.find(".ProductName-primary").first().text()
    );

    if (!rawListingName) {
      return fail("dropped_missingListingName", {
        reason: "dropped_missingListingName",
      });
    }

    const href = cleanText($link.attr("href"));
    const listingURL = absoluteUrl(href);
    if (!listingURL) {
      return fail("dropped_missingListingURL", {
        reason: "dropped_missingListingURL",
        listingName: rawListingName,
        rawHref: href || null,
      });
    }

    const imageURL = pickImageUrl($card);
    if (!imageURL) {
      return fail("dropped_missingImageURL", {
        reason: "dropped_missingImageURL",
        listingName: rawListingName,
        listingURL,
      });
    }

    const pricing = extractPricing($card);

    if (!isNum(pricing.salePrice)) {
      return fail("dropped_missingSalePrice", {
        reason: "dropped_missingSalePrice",
        listingName: rawListingName,
        listingURL,
      });
    }

    if (!isNum(pricing.originalPrice)) {
      return fail("dropped_missingOriginalPrice", {
        reason: "dropped_missingOriginalPrice",
        listingName: rawListingName,
        listingURL,
      });
    }

    if (!(pricing.salePrice < pricing.originalPrice)) {
      return fail("dropped_saleNotLessThanOriginal", {
        reason: "dropped_saleNotLessThanOriginal",
        listingName: rawListingName,
        listingURL,
        salePrice: pricing.salePrice,
        originalPrice: pricing.originalPrice,
      });
    }

    const discountPercent = roundPct(
      ((pricing.originalPrice - pricing.salePrice) / pricing.originalPrice) * 100
    );

    if (!isNum(discountPercent)) {
      return fail("dropped_invalidDiscountPercent", {
        reason: "dropped_invalidDiscountPercent",
        listingName: rawListingName,
        listingURL,
        salePrice: pricing.salePrice,
        originalPrice: pricing.originalPrice,
      });
    }

    const secondaryLine = cleanText(
      $link.find(".ProductName-second, .ProductName-second-v3").first().text()
    );

    const gender = parseGender(`${rawListingName} | ${secondaryLine}`);
    const shoeType = parseShoeType(rawListingName);

    const { brand, model } = deriveBrandAndModel(rawListingName);

    return {
      ok: true,
      deal: {
        schemaVersion: SCHEMA_VERSION,

        listingName: rawListingName,

        brand,
        model,

        salePrice: pricing.salePrice,
        originalPrice: pricing.originalPrice,
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
      },
    };
  } catch (error) {
    return fail("dropped_parseError", {
      reason: "dropped_parseError",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function extractPricing($card) {
  const hiddenTexts = $card
    .find(".visually-hidden")
    .map((_, el) => cleanText($card.find(el).text()))
    .get()
    .filter(Boolean);

  for (const text of hiddenTexts) {
    const m = text.match(/price dropped from\s*\$([\d,]+(?:\.\d{1,2})?)\s*to\s*\$([\d,]+(?:\.\d{1,2})?)/i);
    if (m) {
      return {
        salePrice: toNumber(m[2]),
        originalPrice: toNumber(m[1]),
      };
    }
  }

  const saleCandidates = [];
  $card.find(".ProductPrice .text-sale_red").each((_, el) => {
    const txt = cleanText($card.find(el).text());
    if (txt.includes("$")) saleCandidates.push(txt);
  });

  const originalCandidates = [];
  $card.find(".ProductPrice .line-through").each((_, el) => {
    const txt = cleanText($card.find(el).text());
    if (txt.includes("$")) originalCandidates.push(txt);
  });

  const salePrice = toNumber(saleCandidates[0] || null);
  const originalPrice = toNumber(originalCandidates[0] || null);

  return { salePrice, originalPrice };
}

function pickImageUrl($card) {
  const $img = $card.find(".ProductCard-image img").first();
  const src = cleanText($img.attr("src"));
  if (src) return absoluteUrl(src);

  const srcset = cleanText($img.attr("srcset"));
  if (srcset) {
    const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
    if (first) return absoluteUrl(first);
  }

  return null;
}

function discoverPaginationUrls($, currentUrl) {
  const urls = new Set();

  const relNext = $('link[rel="next"]').attr("href");
  if (relNext) urls.add(absoluteUrl(relNext));

  $('a[rel="next"], a[aria-label*="Next"], a[aria-label*="next"], a[href*="page="], a[href*="start="]')
    .each((_, el) => {
      const href = cleanText($(el).attr("href"));
      const abs = absoluteUrl(href);
      if (!abs) return;

      try {
        const current = new URL(currentUrl);
        const next = new URL(abs);

        if (current.pathname === next.pathname) {
          urls.add(next.toString());
        }
      } catch {
        // ignore bad URLs
      }
    });

  return [...urls];
}

function deriveBrandAndModel(listingName) {
  const clean = cleanText(listingName);
  const lower = clean.toLowerCase();

  for (const brandName of MULTI_WORD_BRANDS) {
    if (lower.startsWith(brandName + " ") || lower === brandName) {
      const brand = toBrandCase(brandName, clean);
      const model = clean.slice(brand.length).trim() || clean;
      return { brand, model };
    }
  }

  const parts = clean.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return { brand: "", model: "" };
  }

  const brand = parts[0];
  const model = parts.slice(1).join(" ").trim() || clean;
  return { brand, model };
}

function toBrandCase(brandName, originalListingName) {
  const lowerBrand = brandName.toLowerCase();
  const originalLower = originalListingName.toLowerCase();
  const idx = originalLower.indexOf(lowerBrand);
  if (idx === 0) {
    return originalListingName.slice(0, brandName.length);
  }

  if (lowerBrand === "hoka") return "HOKA";
  if (lowerBrand === "asics") return "ASICS";
  if (lowerBrand === "puma") return "PUMA";
  if (lowerBrand === "on") return "On";
  return brandName
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function parseGender(text) {
  const s = cleanText(text).toLowerCase();

  if (s.includes("men's") || s.includes("mens") || s.includes(" men ")) return "mens";
  if (s.includes("women's") || s.includes("womens") || s.includes(" women ")) return "womens";
  if (s.includes("unisex")) return "unisex";
  return "unknown";
}

function parseShoeType(listingName) {
  const s = cleanText(listingName).toLowerCase();

  if (s.includes("trail")) return "trail";
  if (s.includes("track") || s.includes("spike") || s.includes("spikes")) return "track";
  if (s.includes("road running")) return "road";
  return "unknown";
}

function absoluteUrl(value) {
  const s = cleanText(value);
  if (!s) return null;

  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/")) return `${BASE}${s}`;

  try {
    return new URL(s, BASE).toString();
  } catch {
    return null;
  }
}

function incrementDrop(dropCounts, summary, key) {
  dropCounts[key] = (dropCounts[key] || 0) + 1;
  summary.dropReasons[key] = (summary.dropReasons[key] || 0) + 1;
}

function pushDroppedSample(arr, sample) {
  if (arr.length >= MAX_DROPPED_SAMPLE) return;
  arr.push(sample);
}

function fail(reason, sample) {
  return {
    ok: false,
    reason,
    sample,
  };
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.]/g, "").trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function roundPct(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}
