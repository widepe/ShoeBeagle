// /api/scrapers/karhu-sale.js
//
// Karhu sale shoes scraper
// - Uses Karhu search result pages
// - Scrapes exactly 2 roots:
//    1) mens shoe sale search
//    2) womens shoe sale search
// - Paginates with ?page=N appended to the search URL
// - Keeps only discounted product cards
// - Drops full-price items, gift cards, non-shoe/apparel items, etc.
// - Sets shoeType = "unknown" for all extracted shoes
// - Writes ONLY top-level structure + deals array to karhu-sale.json in Vercel Blob
// - Returns ONLY metadata/debug info in API response (no deals array)
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//   - CRON_SECRET
//
// TEST:
//   /api/scrapers/karhu-sale

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Karhu";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";
const BASE = "https://us.karhu.com";

const SEARCH_ROOTS = [
  {
    key: "mens",
    label: "mens-shoe-sale-search",
    url: `${BASE}/search?q=mens+shoe+sale&type=product%2Cpage%2Carticle`,
    defaultGender: "mens",
  },
  {
    key: "womens",
    label: "womens-shoe-sale-search",
    url: `${BASE}/search?q=womens+shoe+sale&type=product%2Cpage%2Carticle`,
    defaultGender: "womens",
  },
];

const MAX_PAGES_PER_ROOT = 12;
const MAX_DROPPED_SAMPLE = 75;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function parseMoney(text) {
  if (!text) return null;
  const m = String(text).match(/([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function extractPricesFromCard($card, $) {
  const candidateTexts = [];

  const pushText = (text) => {
    const cleaned = cleanText(text);
    if (cleaned) candidateTexts.push(cleaned);
  };

  // Prefer likely price containers first
  $card.find('[class*="price"], [class*="Price"], [data-price], s, del').each((_, el) => {
    pushText($(el).text());
  });

  // Also scan common text nodes that may contain dollar values
  $card.find("p, span, div").each((_, el) => {
    const txt = cleanText($(el).text());
    if (txt && txt.includes("$")) candidateTexts.push(txt);
  });

  // Fallback: entire card text
  pushText($card.text());

  // Deduplicate while preserving order
  const uniqueTexts = [...new Set(candidateTexts)];

  for (const txt of uniqueTexts) {
    const moneyMatches = txt.match(/\$[0-9]+(?:\.[0-9]{2})?/g) || [];
    if (moneyMatches.length >= 2) {
      const nums = moneyMatches
        .map((m) => parseMoney(m))
        .filter((n) => Number.isFinite(n));

      if (nums.length >= 2) {
        return {
          priceText: txt,
          salePrice: nums[0],
          originalPrice: nums[1],
          moneyMatches,
        };
      }
    }
  }

  // If only one price is found, keep it for debugging / drop logic
  for (const txt of uniqueTexts) {
    const moneyMatches = txt.match(/\$[0-9]+(?:\.[0-9]{2})?/g) || [];
    if (moneyMatches.length === 1) {
      return {
        priceText: txt,
        salePrice: parseMoney(moneyMatches[0]),
        originalPrice: null,
        moneyMatches,
      };
    }
  }

  return {
    priceText: "",
    salePrice: null,
    originalPrice: null,
    moneyMatches: [],
  };
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

function inferModel(rawTitle) {
  let s = cleanText(rawTitle);

  s = s.replace(/^men'?s\s+/i, "");
  s = s.replace(/^women'?s\s+/i, "");
  s = s.replace(/^unisex\s+/i, "");
  s = s.replace(/\s+/g, " ").trim();

  return s || null;
}

function buildListingName(title, color) {
  return cleanText([title, color].filter(Boolean).join(" "));
}

function isGiftCard(text) {
  return /\bgift card\b|\bgift-card\b|karhu-gift-card/i.test(cleanText(text));
}

function isClearlyApparelOrAccessory(text) {
  const s = cleanText(text).toLowerCase();
  return /\blong sleeve\b|\bshort sleeve\b|\bsinglet\b|\bhalf tight\b|\btight\b|\btights\b|\bshirt\b|\bt-shirt\b|\btee\b|\bhoodie\b|\bjacket\b|\bshorts\b|\bshort\b|\bpants\b|\bsocks\b|\bcap\b|\bhat\b/.test(
    s
  );
}

function isLikelyShoe(text) {
  const s = cleanText(text).toLowerCase();

  if (isClearlyApparelOrAccessory(s)) return false;
  if (isGiftCard(s)) return false;

  if (
    /\brunning shoe\b|\brunning shoes\b|\btrail shoe\b|\btrail shoes\b|\btrack shoe\b|\btrack shoes\b|\bspike\b|\bspikes\b/.test(
      s
    )
  ) {
    return true;
  }

  if (/\bikoni\b|\bfusion\b|\bmestari\b|\bsynchron\b/.test(s)) {
    return true;
  }

  return false;
}

function safeSlice(arr, n) {
  return Array.isArray(arr) ? arr.slice(0, n) : [];
}

function makePageUrl(rootUrl, page) {
  if (page <= 1) return rootUrl;
  const joiner = rootUrl.includes("?") ? "&" : "?";
  return `${rootUrl}${joiner}page=${page}`;
}

function buildGenderCounts(deals) {
  const counts = {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };

  for (const deal of deals) {
    const g = deal?.gender;
    if (g === "mens" || g === "womens" || g === "unisex" || g === "unknown") {
      counts[g] += 1;
    } else {
      counts.unknown += 1;
    }
  }

  return counts;
}

function buildBlobPayload({
  store,
  schemaVersion,
  lastUpdated,
  via,
  sourceUrls,
  pagesFetched,
  dealsFound,
  dealsExtracted,
  scrapeDurationMs,
  ok,
  error,
  deals,
}) {
  return {
    store,
    schemaVersion,
    lastUpdated,
    via,
    sourceUrls,
    pagesFetched,
    dealsFound,
    dealsExtracted,
    scrapeDurationMs,
    ok,
    error,
    deals,
  };
}

function buildResponsePayload({
  store,
  schemaVersion,
  lastUpdated,
  via,
  sourceUrls,
  pagesFetched,
  dealsFound,
  dealsExtracted,
  scrapeDurationMs,
  ok,
  error,
  dropCounts,
  droppedDeals,
  pageSummaries,
  deals,
  blobUrl,
}) {
  return {
    store,
    schemaVersion,
    lastUpdated,
    via,
    sourceUrls,
    pagesFetched,
    dealsFound,
    dealsExtracted,
    scrapeDurationMs,
    ok,
    error,
    genderCounts: buildGenderCounts(deals),
    dropCounts,
    droppedDealsLogged: droppedDeals.length,
    droppedDealsSample: safeSlice(droppedDeals, MAX_DROPPED_SAMPLE),
    pageSummaries,
    blobUrl,
  };
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
    dropped_duplicateListingURL: 0,
    dropped_giftCard: 0,
    dropped_missingListingURL: 0,
    dropped_missingListingName: 0,
    dropped_missingImageURL: 0,
    dropped_notShoe: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_fullPriceNotOnSale: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_invalidDiscountPercent: 0,
    dropped_missingBrand: 0,
    dropped_missingModel: 0,
  };

  function logDropped(reason, context = {}) {
    if (Object.prototype.hasOwnProperty.call(dropCounts, reason)) {
      dropCounts[reason] += 1;
    }

    if (droppedDeals.length < MAX_DROPPED_SAMPLE) {
      droppedDeals.push({ reason, ...context });
    }
  }

  try {
    for (const root of SEARCH_ROOTS) {
      let priorUniqueCount = seenListingUrls.size;

      for (let page = 1; page <= MAX_PAGES_PER_ROOT; page += 1) {
        const pageUrl = makePageUrl(root.url, page);
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

        const candidateAnchors = $("a[href*='/products/']");
        const pageSeenUrls = new Set();

        let cardsFound = 0;
        let newDealsExtracted = 0;
        let droppedOnPage = 0;

        candidateAnchors.each((_, a) => {
          const $a = $(a);
          const href = cleanText($a.attr("href"));
          if (!href || !href.includes("/products/")) return;

          const listingURL = absUrl(href);
          if (!listingURL || pageSeenUrls.has(listingURL)) return;
          pageSeenUrls.add(listingURL);

          let $card =
            $a.closest("div.tw-relative.tw-max-w-full.tw-h-full.tw-flex.tw-flex-col");
          if (!$card.length) $card = $a.closest("div.tw-relative");
          if (!$card.length) $card = $a.parent();

          cardsFound += 1;
          dropCounts.totalCards += 1;

          const h3s = $card.find("h3");
          const rawTitle = cleanText(h3s.first().text());
          const rawColor = cleanText(h3s.eq(1).text());

          const firstImgAlt = cleanText($card.find("img").first().attr("alt"));
          const allImgAlt = cleanText(
            $card
              .find("img")
              .map((__, img) => $(img).attr("alt"))
              .get()
              .join(" ")
          );

          const listingName = buildListingName(rawTitle, rawColor);

          const imageURL =
            absUrl($card.find("img").first().attr("src")) ||
            absUrl($a.find("img").first().attr("src"));

          const {
            priceText,
            salePrice,
            originalPrice,
            moneyMatches,
          } = extractPricesFromCard($card, $);

          const combinedText = cleanText(
            [
              listingURL,
              rawTitle,
              rawColor,
              listingName,
              firstImgAlt,
              allImgAlt,
              priceText,
              cleanText($card.text()),
            ].join(" ")
          );

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

          if (isGiftCard(listingURL) || isGiftCard(combinedText)) {
            droppedOnPage += 1;
            logDropped("dropped_giftCard", {
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

          if (!isLikelyShoe(combinedText)) {
            droppedOnPage += 1;
            logDropped("dropped_notShoe", {
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
              priceText,
            });
            return;
          }

          if (!Number.isFinite(originalPrice)) {
            droppedOnPage += 1;

            if (moneyMatches.length === 1) {
              logDropped("dropped_fullPriceNotOnSale", {
                pageUrl,
                listingURL,
                listingName,
                priceText,
              });
            } else {
              logDropped("dropped_missingOriginalPrice", {
                pageUrl,
                listingURL,
                listingName,
                priceText,
              });
            }
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
          const gender = inferGender(
            rawTitle || firstImgAlt || listingName,
            root.defaultGender
          );

          if (!brand) {
            droppedOnPage += 1;
            logDropped("dropped_missingBrand", {
              pageUrl,
              listingURL,
              listingName,
            });
            return;
          }

          if (!model) {
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
            shoeType: "unknown",
          });

          newDealsExtracted += 1;
        });

        pageSummaries.push({
          root: root.label,
          page,
          pageUrl,
          cardsFound,
          newDealsExtracted,
          droppedOnPage,
          cumulativeDeals: deals.length,
        });

        if (cardsFound === 0) break;
        if (seenListingUrls.size === priorUniqueCount) break;
        if (newDealsExtracted === 0 && cardsFound <= 2) break;

        priorUniqueCount = seenListingUrls.size;
      }
    }

    const finishedAt = nowIso();
    const scrapeDurationMs = Date.now() - startedAt;

    const blobPayload = buildBlobPayload({
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: finishedAt,
      via: VIA,
      sourceUrls,
      pagesFetched: pageSummaries.length,
      dealsFound: dropCounts.totalCards,
      dealsExtracted: deals.length,
      scrapeDurationMs,
      ok: true,
      error: null,
      deals,
    });

    const blob = await put("karhu-sale.json", JSON.stringify(blobPayload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    const responsePayload = buildResponsePayload({
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: finishedAt,
      via: VIA,
      sourceUrls,
      pagesFetched: pageSummaries.length,
      dealsFound: dropCounts.totalCards,
      dealsExtracted: deals.length,
      scrapeDurationMs,
      ok: true,
      error: null,
      dropCounts,
      droppedDeals,
      pageSummaries,
      deals,
      blobUrl: blob.url,
    });

    return res.status(200).json(responsePayload);
  } catch (error) {
    const failedAt = nowIso();
    const scrapeDurationMs = Date.now() - startedAt;

    return res.status(500).json({
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: failedAt,
      via: VIA,
      sourceUrls,
      pagesFetched: pageSummaries.length,
      dealsFound: dropCounts.totalCards,
      dealsExtracted: deals.length,
      scrapeDurationMs,
      ok: false,
      error: error?.message || "Unknown error",
      genderCounts: buildGenderCounts(deals),
      dropCounts,
      droppedDealsLogged: droppedDeals.length,
      droppedDealsSample: safeSlice(droppedDeals, MAX_DROPPED_SAMPLE),
      pageSummaries,
    });
  }
}
