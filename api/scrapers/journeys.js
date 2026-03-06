// /api/scrapers/journeys.js
//
// Journeys running-sale scraper for Vercel
//
// What it does:
// - Scrapes the two Journeys running-sale pages
// - Extracts deals into your schema
// - Builds your required top-level structure
// - Uploads to Vercel Blob at a stable pathname if BLOB_READ_WRITE_TOKEN is set
//
// Install if needed:
//   npm i cheerio @vercel/blob
//
// Test locally / in browser:
//   /api/scrapers/journeys
//
// Optional env:
//   BLOB_READ_WRITE_TOKEN
//   CRON_SECRET

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "Journeys";
const SCHEMA_VERSION = 1;
const VIA = "vercel";

const SOURCE_URLS = [
  "https://www.journeys.com/products/womens-sale-shoes?style=running+shoes",
  "https://www.journeys.com/products/mens-sale-shoes?style=running+shoes",
];

function textOf($el) {
  return ($el.text() || "").replace(/\s+/g, " ").trim();
}

function toAbsUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://www.journeys.com${url}`;
  return `https://www.journeys.com/${url.replace(/^\/+/, "")}`;
}

function parseMoney(str) {
  if (str == null) return null;
  const cleaned = String(str).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
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

function inferGenderFromListingName(listingName) {
  const s = String(listingName || "").trim();

  if (/^women'?s\b/i.test(s) || /\bwomen'?s\b/i.test(s)) return "Women";
  if (/^men'?s\b/i.test(s) || /\bmen'?s\b/i.test(s)) return "Men";
  if (/^girls'?/i.test(s) || /\bgirls'?\b/i.test(s)) return "Girls";
  if (/^boys'?/i.test(s) || /\bboys'?\b/i.test(s)) return "Boys";

  return "Unisex";
}

function cleanInvisible(str) {
  return String(str || "")
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveModel(listingName, brand) {
  let s = cleanInvisible(listingName || "");
  const b = cleanInvisible(brand || "");

  // Remove leading gender if present
  s = s.replace(/^(women'?s|men'?s|girls'?|boys'?)\s+/i, "").trim();

  // Remove leading brand
  if (b) {
    const brandRe = new RegExp(`^${escapeRegex(b)}\\s+`, "i");
    s = s.replace(brandRe, "").trim();
  }

  // Remove color suffix after " - "
  s = s.replace(/\s+-\s+.*$/i, "").trim();

  // Remove common shoe suffixes
  s = s
    .replace(/\bathletic shoe\b/i, "")
    .replace(/\brunning shoe\b/i, "")
    .replace(/\bshoe\b/i, "")
    .trim();

  return s || null;
}

function extractDealFromCard($, el, stats) {
  const $card = $(el);

  // Main product link only, not related color links
  const $mainLink = $card.find("a.item-link").first();
  if (!$mainLink.length) {
    stats.dropped_missingUrl++;
    return null;
  }

  const rawHref = $mainLink.attr("href");
  const listingURL = toAbsUrl(rawHref);

  if (!listingURL) {
    stats.dropped_missingUrl++;
    return null;
  }

  const brand =
    cleanInvisible($card.find('meta[itemprop="brand"]').attr("content")) || null;

  let listingName =
    cleanInvisible(textOf($mainLink.find('span[itemprop="name"]').first())) ||
    cleanInvisible($mainLink.attr("data-name")) ||
    null;

  if (!listingName) {
    stats.dropped_missingTitle++;
    return null;
  }

  const imageURL =
    toAbsUrl($mainLink.find('img[itemprop="image"]').attr("src")) ||
    toAbsUrl($mainLink.find("img.feature-image").attr("src")) ||
    null;

  const salePrice =
    parseMoney($card.find('.price-wrap .sale-price').first().text()) ??
    parseMoney($card.find('.price-wrap meta[itemprop="price"]').attr("content")) ??
    parseMoney($mainLink.attr("data-price"));

  const originalPrice =
    parseMoney($card.find('.price-wrap .original-price').first().text()) ??
    parseMoney($mainLink.attr("data-listprice"));

  if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice)) {
    stats.dropped_priceCouldNotParse++;
    return null;
  }

  if (salePrice >= originalPrice) {
    stats.dropped_notADeal++;
    return null;
  }

  const gender = inferGenderFromListingName(listingName);
  const model = deriveModel(listingName, brand);
  const discountPercent = computeDiscountPercent(originalPrice, salePrice);

  return {
    schemaVersion: 1,

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
    shoeType: "Running",
  };
}

function dedupeDeals(deals) {
  const seen = new Set();
  const out = [];

  for (const deal of deals) {
    const key = (deal.listingURL || "").trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(deal);
  }

  return out;
}

module.exports = async function handler(req, res) {
  const started = Date.now();

  // TEMPORARILY COMMENTED OUT FOR TESTING
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const stats = {
    totalCards: 0,
    dropped_missingTitle: 0,
    dropped_missingUrl: 0,
    dropped_priceCouldNotParse: 0,
    dropped_notADeal: 0,
    kept: 0,
  };

  const pageNotes = [];
  const allDeals = [];
  let pagesFetched = 0;
  let error = null;

  try {
    for (const url of SOURCE_URLS) {
      const resp = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          referer: "https://www.journeys.com/",
          cache: "no-store",
        },
      });

      if (!resp.ok) {
        pageNotes.push({
          url,
          note: `HTTP ${resp.status}`,
        });
        continue;
      }

      const html = await resp.text();
      const $ = cheerio.load(html);

      const $cards = $('div.product-section-column[itemscope][itemtype="http://schema.org/Product"]');
      const cardsOnPage = $cards.length;

      let keptByParser = 0;

      $cards.each((_, el) => {
        stats.totalCards++;
        const deal = extractDealFromCard($, el, stats);
        if (deal) {
          keptByParser++;
          allDeals.push(deal);
        }
      });

      pagesFetched++;

      pageNotes.push({
        url,
        cards: cardsOnPage,
        keptByParser,
      });
    }

    const dedupedDeals = dedupeDeals(allDeals);
    stats.kept = dedupedDeals.length;

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls: SOURCE_URLS,

      pagesFetched,

      dealsFound: stats.totalCards,
      dealsExtracted: dedupedDeals.length,

      scrapeDurationMs: Date.now() - started,

      ok: true,
      error: null,

      deals: dedupedDeals,
      pageNotes,
      dropCounts: stats,
    };

    let blobUrl = null;

    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const blob = await put("journeys.json", JSON.stringify(payload, null, 2), {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
      });
      blobUrl = blob.url;
      payload.blobUrl = blobUrl;
    }

    return res.status(200).json(payload);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);

    const failedPayload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls: SOURCE_URLS,

      pagesFetched,

      dealsFound: stats.totalCards,
      dealsExtracted: stats.kept,

      scrapeDurationMs: Date.now() - started,

      ok: false,
      error,

      deals: [],
      pageNotes,
      dropCounts: stats,
    };

    return res.status(500).json(failedPayload);
  }
};
