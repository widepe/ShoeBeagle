// /api/scrapers/karhu-sale.js
//
// KARHU sale running shoes scraper
// - Scrapes 2 collection roots:
//    1) women's running sale
//    2) men's running sale
// - Uses simple HTML fetch + Cheerio
// - Paginates via ?page=N
// - Stops when a page has no product cards or yields no new product URLs
// - Writes karhu-sale.json to Vercel Blob
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//   - CRON_SECRET
//
// TEST:
//   /api/scrapers/karhu-sale
//
// Notes:
// - This appears to be Shopify / Shopify-style:
//   * product links under /products/...
//   * images under /cdn/shop/...
//   * server-rendered collection pages with ?page=N pagination
// - Prices appear to be single sale + single original, not ranges.
// - Running-sale collections may still contain non-shoe items someday, so this scraper
//   includes filtering + drop reasons instead of blindly trusting the page.

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Karhu";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";

const BASE = "https://us.karhu.com";

const COLLECTIONS = [
  {
    key: "womens",
    label: "womens-running-sale",
    url: `${BASE}/collections/womens-running-sale`,
    defaultGender: "womens",
  },
  {
    key: "mens",
    label: "mens-running-sale",
    url: `${BASE}/collections/mens-running-sale`,
    defaultGender: "mens",
  },
];

const MAX_PAGES_PER_COLLECTION = 12;

function nowIso() {
  return new Date().toISOString();
}

function absUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return `${BASE}${s}`;
  return `${BASE}/${s.replace(/^\/+/, "")}`;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoney(text) {
  if (!text) return null;
  const m = cleanText(text).match(/\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
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

function inferGender(text, fallback = "unknown") {
  const s = cleanText(text).toLowerCase();

  if (/\bmen'?s\b|\bmens\b/.test(s)) return "mens";
  if (/\bwomen'?s\b|\bwomens\b/.test(s)) return "womens";
  if (/\bunisex\b/.test(s)) return "unisex";

  return fallback;
}

function inferShoeType(text) {
  const s = cleanText(text).toLowerCase();

  if (/\btrail\b/.test(s)) return "trail";
  if (/\btrack\b|\bspike\b|\bspikes\b/.test(s)) return "track";

  // Since these are running-sale pages and product alts/titles say running shoe,
  // road is the best default unless trail/track keywords appear.
  if (/\brunning\b|\bshoe\b|\bshoes\b/.test(s)) return "road";

  return "unknown";
}

function looksLikeShoe(text) {
  const s = cleanText(text).toLowerCase();

  if (/\bshoe\b|\bshoes\b|\brunning\b|\btrainer\b|\btrainers\b|\btrail\b|\bspike\b|\bspikes\b/.test(s)) {
    return true;
  }

  if (/\btee\b|\bt-shirt\b|\bshirt\b|\bhoodie\b|\bsinglet\b|\btight\b|\btights\b|\bshort\b|\bshorts\b|\bjacket\b|\bsock\b|\bsocks\b|\bcap\b|\bhat\b/.test(s)) {
    return false;
  }

  return true;
}

function buildListingName(title, color) {
  return cleanText([title, color].filter(Boolean).join(" "));
}

function inferModel(title) {
  let s = cleanText(title);

  s = s.replace(/^men'?s\s+/i, "");
  s = s.replace(/^women'?s\s+/i, "");
  s = s.replace(/^unisex\s+/i, "");
  s = s.replace(/\s+/g, " ").trim();

  return s || "unknown";
}

function safeSlice(arr, n) {
  return Array.isArray(arr) ? arr.slice(0, n) : [];
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

  const sourceUrls = [];
  const pageSummaries = [];
  const droppedDeals = [];
  const deals = [];
  const seenListingUrls = new Set();

  const dropCounts = {
    totalCards: 0,
    dropped_notProductCard: 0,
    dropped_missingListingURL: 0,
    dropped_duplicateListingURL: 0,
    dropped_missingListingName: 0,
    dropped_missingImageURL: 0,
    dropped_notRunningShoe: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_invalidDiscountPercent: 0,
    dropped_missingBrand: 0,
    dropped_missingModel: 0,
  };

  function logDropped(reason, context = {}) {
    if (reason in dropCounts) dropCounts[reason] += 1;
    if (droppedDeals.length < 200) {
      droppedDeals.push({
        reason,
        ...context,
      });
    }
  }

  try {
    for (const collection of COLLECTIONS) {
      let prevUniqueCount = seenListingUrls.size;

      for (let page = 1; page <= MAX_PAGES_PER_COLLECTION; page += 1) {
        const pageUrl =
          page === 1 ? collection.url : `${collection.url}?page=${page}`;

        sourceUrls.push(pageUrl);

        const resp = await fetch(pageUrl, {
          headers: {
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
            accept: "text/html,application/xhtml+xml",
          },
        });

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} for ${pageUrl}`);
        }

        const html = await resp.text();
        const $ = cheerio.load(html);

        const productAnchors = $("a[href*='/products/']");
        const pageSeenUrls = new Set();
        let cardsOnPage = 0;
        let extractedOnPage = 0;
        let droppedOnPage = 0;

        // Find the nearest product card wrapper around each product link.
        productAnchors.each((_, a) => {
          const href = cleanText($(a).attr("href"));
          if (!href || !href.includes("/products/")) return;

          const listingURL = absUrl(href);
          if (!listingURL) return;

          if (pageSeenUrls.has(listingURL)) return;
          pageSeenUrls.add(listingURL);

          cardsOnPage += 1;
          dropCounts.totalCards += 1;

          // Best effort: use the nearest card-like wrapper, else parent.
          let $card = $(a).closest("div.tw-relative.tw-max-w-full.tw-h-full.tw-flex.tw-flex-col");
          if (!$card.length) $card = $(a).parent();

          const rawTitle = cleanText(
            $card.find("h3").first().text() ||
            $(a).find("img").first().attr("alt") ||
            ""
          );

          const rawColor = cleanText(
            $card.find("h3").eq(1).text()
          );

          const listingName = buildListingName(rawTitle, rawColor);

          const imageURL =
            absUrl($(a).find("img").first().attr("src")) ||
            absUrl($card.find("img").first().attr("src"));

          const priceBlockText = cleanText($card.find("p").first().text());

          // Expecting "$96.00 $160.00"
          const moneyMatches = priceBlockText.match(/\$[0-9]+(?:\.[0-9]{2})?/g) || [];
          const salePrice = moneyMatches[0] ? parseMoney(moneyMatches[0]) : null;
          const originalPrice = moneyMatches[1] ? parseMoney(moneyMatches[1]) : null;

          const combinedText = cleanText([
            listingName,
            $(a).find("img").map((__, img) => $(img).attr("alt")).get().join(" "),
            priceBlockText,
            href,
          ].join(" "));

          if (!listingURL) {
            droppedOnPage += 1;
            logDropped("dropped_missingListingURL", { pageUrl, href });
            return;
          }

          if (seenListingUrls.has(listingURL)) {
            droppedOnPage += 1;
            logDropped("dropped_duplicateListingURL", {
              pageUrl,
              listingURL,
              listingName,
            });
            return;
          }

          if (!listingName) {
            droppedOnPage += 1;
            logDropped("dropped_missingListingName", {
              pageUrl,
              listingURL,
            });
            return;
          }

          if (!imageURL) {
            droppedOnPage += 1;
            logDropped("dropped_missingImageURL", {
              pageUrl,
              listingURL,
              listingName,
            });
            return;
          }

          if (!looksLikeShoe(combinedText)) {
            droppedOnPage += 1;
            logDropped("dropped_notRunningShoe", {
              pageUrl,
              listingURL,
              listingName,
            });
            return;
          }

          if (!Number.isFinite(salePrice)) {
            droppedOnPage += 1;
            logDropped("dropped_missingSalePrice", {
              pageUrl,
              listingURL,
              listingName,
              priceBlockText,
            });
            return;
          }

          if (!Number.isFinite(originalPrice)) {
            droppedOnPage += 1;
            logDropped("dropped_missingOriginalPrice", {
              pageUrl,
              listingURL,
              listingName,
              priceBlockText,
            });
            return;
          }

          if (!(salePrice < originalPrice)) {
            droppedOnPage += 1;
            logDropped("dropped_saleNotLessThanOriginal", {
              pageUrl,
              listingURL,
              listingName,
              salePrice,
              originalPrice,
            });
            return;
          }

          const discountPercent = computeDiscountPercent(salePrice, originalPrice);
          if (!Number.isFinite(discountPercent) || discountPercent <= 0) {
            droppedOnPage += 1;
            logDropped("dropped_invalidDiscountPercent", {
              pageUrl,
              listingURL,
              listingName,
              salePrice,
              originalPrice,
              discountPercent,
            });
            return;
          }

          const brand = "Karhu";
          const model = inferModel(rawTitle);
          const gender = inferGender(rawTitle, collection.defaultGender);
          const shoeType = inferShoeType(combinedText);

          if (!brand) {
            droppedOnPage += 1;
            logDropped("dropped_missingBrand", {
              pageUrl,
              listingURL,
              listingName,
            });
            return;
          }

          if (!model || model === "unknown") {
            droppedOnPage += 1;
            logDropped("dropped_missingModel", {
              pageUrl,
              listingURL,
              listingName,
              rawTitle,
            });
            return;
          }

          seenListingUrls.add(listingURL);

          deals.push({
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
            shoeType,
          });

          extractedOnPage += 1;
        });

        pageSummaries.push({
          collection: collection.label,
          page,
          pageUrl,
          cardsFound: cardsOnPage,
          newDealsExtracted: extractedOnPage,
          droppedOnPage,
          cumulativeDeals: deals.length,
        });

        // Stop if page is empty.
        if (cardsOnPage === 0) {
          break;
        }

        // Stop if page produced no new unique product URLs.
        if (seenListingUrls.size === prevUniqueCount) {
          break;
        }

        prevUniqueCount = seenListingUrls.size;
      }
    }

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,
      pagesFetched: pageSummaries.length,

      dealsFound: dropCounts.totalCards,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      dropCounts,
      droppedDealsLogged: droppedDeals.length,
      droppedDealsSample: safeSlice(droppedDeals, 50),
      pageSummaries,

      deals,
    };

    const blob = await put("karhu-sale.json", JSON.stringify(output, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    output.blobUrl = blob.url;

    return res.status(200).json(output);
  } catch (error) {
    return res.status(500).json({
      success: false,
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,
      sourceUrls,
      pagesFetched: pageSummaries.length,
      dealsFound: dropCounts.totalCards,
      dealsExtracted: deals.length,
      scrapeDurationMs: Date.now() - startedAt,
      ok: false,
      error: error?.message || "Unknown error",
      dropCounts,
      droppedDealsLogged: droppedDeals.length,
      droppedDealsSample: safeSlice(droppedDeals, 50),
      pageSummaries,
    });
  }
}
