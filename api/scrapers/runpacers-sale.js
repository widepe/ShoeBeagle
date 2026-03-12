// /api/scrapers/runpacers-sale.js
//
// Pacers Running sale footwear scraper
// - Scrapes: https://runpacers.com/collections/sale-all
// - Follows pagination: ?page=2, ?page=3, etc.
// - Uses visible original price when present
// - If original price is not visible but a visible "Save $X" amount exists,
//   computes originalPrice = salePrice + saveAmount
// - Keeps deals even when only salePrice is visible
// - Skips true hidden-price tiles ("see price in cart", "add to bag to see price", etc.)
// - Sets shoeType = "unknown" for all kept deals
// - Tracks dropped reasons and page summaries in top-level metadata
// - Writes clean top-level JSON + deals array to Vercel Blob
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//
// TEST:
//   /api/scrapers/runpacers-sale
//
// Notes:
// - CRON auth is included below but commented out for testing.
// - Output structure is top-level fields + deals array only.

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Pacers Running";
const SCHEMA_VERSION = 1;
const VIA = "fetch+cheerio";
const BASE_URL = "https://runpacers.com";
const COLLECTION_URL = `${BASE_URL}/collections/sale-all`;
const BLOB_PATH = "runpacers-sale.json";
const MAX_PAGES = 30;

// ============================================================
// OPTIONAL CRON AUTH (commented out for testing)
// ============================================================
// const auth = req.headers.authorization;
// if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
//   return res.status(401).json({ success: false, error: "Unauthorized" });
// }

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/")) return `${BASE_URL}${s}`;
  return `${BASE_URL}/${s.replace(/^\/+/, "")}`;
}

function parseMoney(value) {
  if (value == null) return null;
  const s = String(value).replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeDiscountPercent(sale, original) {
  if (!Number.isFinite(sale) || !Number.isFinite(original) || original <= 0) return null;
  if (sale >= original) return null;
  return Math.round(((original - sale) / original) * 100);
}

function normalizeGender(raw) {
  const s = cleanText(raw)
    .toLowerCase()
    .replace(/[’']/g, "'");

  if (
    s === "mens" ||
    s === "men" ||
    s.startsWith("men's ") ||
    s.startsWith("mens ") ||
    s.startsWith("men ")
  ) return "mens";

  if (
    s === "womens" ||
    s === "women" ||
    s.startsWith("women's ") ||
    s.startsWith("womens ") ||
    s.startsWith("women ")
  ) return "womens";

  if (
    s === "unisex" ||
    s.startsWith("unisex ") ||
    s.includes(" unisex ")
  ) return "unisex";

  return "unknown";
}

function inferGenderFromTitleAndHandle(title, handle = "") {
  const t = cleanText(title).toLowerCase().replace(/[’']/g, "'");
  const h = cleanText(handle).toLowerCase();

  if (
    t.startsWith("women's ") ||
    t.startsWith("womens ") ||
    t.startsWith("women ") ||
    h.startsWith("womens-") ||
    h.startsWith("womens_") ||
    h === "womens" ||
    /^womens(?:-|_|$)/.test(h)
  ) return "womens";

  if (
    t.startsWith("men's ") ||
    t.startsWith("mens ") ||
    t.startsWith("men ") ||
    h.startsWith("mens-") ||
    h.startsWith("mens_") ||
    h === "mens" ||
    /^mens(?:-|_|$)/.test(h)
  ) return "mens";

  if (
    t.startsWith("unisex ") ||
    t.includes(" unisex ") ||
    h.startsWith("unisex-") ||
    h.startsWith("unisex_") ||
    h === "unisex" ||
    /^unisex(?:-|_|$)/.test(h)
  ) return "unisex";

  return "unknown";
}

function looksLikeHiddenPrice(text) {
  const s = cleanText(text).toLowerCase();
  if (!s) return false;

  return (
    s.includes("see price in cart") ||
    s.includes("see price in bag") ||
    s.includes("add to cart to see price") ||
    s.includes("add to bag to see price") ||
    s.includes("add for price") ||
    s.includes("login to see price") ||
    s.includes("hidden price")
  );
}

function isProbablyFootwear(title) {
  const s = cleanText(title).toLowerCase();
  if (!s) return false;

  const badTerms = [
    "sock",
    "socks",
    "shirt",
    "short",
    "shorts",
    "bra",
    "jacket",
    "pant",
    "pants",
    "tight",
    "tights",
    "hat",
    "cap",
    "belt",
    "bottle",
    "vest",
    "glove",
    "gloves",
    "headband",
    "sunglasses",
  ];

  return !badTerms.some((term) => s.includes(term));
}

function deriveBrand(listingName) {
  const title = cleanText(listingName);
  if (!title) return null;

  const withoutGender = title
    .replace(/^men'?s\s+/i, "")
    .replace(/^women'?s\s+/i, "")
    .replace(/^unisex\s+/i, "")
    .trim();

  const words = withoutGender.split(/\s+/);
  if (!words.length) return null;

  const firstWord = words[0];
  const normalized = firstWord.toLowerCase();

  const map = {
    asics: "ASICS",
    brooks: "Brooks",
    hoka: "HOKA",
    hokaoneone: "HOKA",
    mizuno: "Mizuno",
    nike: "Nike",
    on: "On",
    saucony: "Saucony",
    adidas: "Adidas",
    altra: "Altra",
    topo: "Topo Athletic",
  };

  if (normalized === "new" && /^new balance\b/i.test(withoutGender)) {
    return "New Balance";
  }

  return map[normalized] || firstWord || null;
}

function deriveModel(listingName, brand) {
  let title = cleanText(listingName);
  if (!title) return null;

  title = title
    .replace(/^men'?s\s+/i, "")
    .replace(/^women'?s\s+/i, "")
    .replace(/^unisex\s+/i, "")
    .trim();

  if (!brand) return title || null;

  if (brand === "New Balance") {
    return title.replace(/^New Balance\s+/i, "").trim() || null;
  }

  const brandEscaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title.replace(new RegExp(`^${brandEscaped}\\s+`, "i"), "").trim() || null;
}

function buildDropRecorder() {
  return {
    counts: {
      totalTilesSeen: 0,
      dropped_duplicateHandle: 0,
      dropped_missingListingName: 0,
      dropped_missingListingURL: 0,
      dropped_missingImageURL: 0,
      dropped_hiddenPriceTile: 0,
      dropped_missingSalePrice: 0,
      dropped_saleNotLessThanOriginal: 0,
      dropped_nonFootwear: 0,
      dropped_unknownBrand: 0,
    },
    byReason: {},
  };
}

function noteDrop(dropState, reason, store, extra = {}) {
  if (!dropState.byReason[reason]) {
    dropState.byReason[reason] = {
      count: 0,
      stores: {},
      examples: [],
    };
  }

  dropState.byReason[reason].count += 1;
  dropState.byReason[reason].stores[store] = (dropState.byReason[reason].stores[store] || 0) + 1;

  if (dropState.byReason[reason].examples.length < 10) {
    dropState.byReason[reason].examples.push(extra);
  }
}

function getProductLinkFromCard($, $card) {
  const href =
    $card.find('a.product-card__image-wrapper[href*="/products/"]').first().attr("href") ||
    $card.find('a[href*="/products/"]').first().attr("href") ||
    null;

  return absoluteUrl(href);
}

function getImageUrlFromCard($, $card) {
  const img = $card.find("img").first();

  const raw =
    img.attr("src") ||
    img.attr("data-src") ||
    img.attr("srcset") ||
    img.attr("data-srcset") ||
    null;

  if (!raw) return null;

  const first = String(raw).split(",")[0]?.trim().split(/\s+/)[0];
  return absoluteUrl(first || raw);
}

function extractSaveAmount($card) {
  const text = cleanText($card.text());
  if (!text) return null;

  const m = text.match(/save\s*\$([\d,]+(?:\.\d{2})?)/i);
  return m ? parseMoney(m[1]) : null;
}

function extractPriceInfoFromCard($, $card) {
  const text = cleanText($card.text());

  if (!text) {
    return {
      hiddenPrice: false,
      salePrice: null,
      originalPrice: null,
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercent: null,
      discountPercentUpTo: null,
    };
  }

  if (looksLikeHiddenPrice(text)) {
    return {
      hiddenPrice: true,
      salePrice: null,
      originalPrice: null,
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercent: null,
      discountPercentUpTo: null,
    };
  }

  let salePrice = null;
  let originalPrice = null;

  const saleNodeText =
    cleanText($card.find(".price__sale .price-item--sale").first().text()) ||
    cleanText($card.find(".price-item--sale").first().text()) ||
    null;

  if (saleNodeText) {
    salePrice = parseMoney(saleNodeText);
  }

  const compareText =
    cleanText($card.find(".price__sale s.price-item--regular").first().text()) ||
    cleanText($card.find(".price__compare s").first().text()) ||
    null;

  if (compareText) {
    originalPrice = parseMoney(compareText);
  }

  if (!Number.isFinite(salePrice)) {
    const regularVisibleText =
      cleanText($card.find(".price__regular .price-item--regular").first().text()) ||
      cleanText($card.find(".price-item--regular").first().text()) ||
      null;

    salePrice = parseMoney(regularVisibleText);
  }

  if (!Number.isFinite(originalPrice)) {
    const saveAmount = extractSaveAmount($card);
    if (Number.isFinite(salePrice) && Number.isFinite(saveAmount)) {
      originalPrice = round2(salePrice + saveAmount);
    }
  }

  let discountPercent = null;
  let discountPercentUpTo = null;

  if (Number.isFinite(salePrice) && Number.isFinite(originalPrice) && salePrice < originalPrice) {
    discountPercent = computeDiscountPercent(salePrice, originalPrice);
    discountPercentUpTo = discountPercent;
  }

  return {
    hiddenPrice: false,
    salePrice: Number.isFinite(salePrice) ? salePrice : null,
    originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
    salePriceLow: null,
    salePriceHigh: null,
    originalPriceLow: null,
    originalPriceHigh: null,
    discountPercent,
    discountPercentUpTo,
  };
}

function extractProductCards($) {
  const cards = [];
  const seen = new Set();

  $("li.grid__item product-card").each((_, el) => {
    const $card = $(el);
    const href = $card.find('a[href*="/products/"]').first().attr("href");
    const abs = absoluteUrl(href);
    if (!abs) return;

    const key = abs;
    if (seen.has(key)) return;
    seen.add(key);
    cards.push($card);
  });

  return cards;
}

function serializeDroppedReasons(byReason) {
  const out = {};
  for (const [reason, info] of Object.entries(byReason)) {
    out[reason] = {
      count: info.count,
      stores: info.stores,
      examples: info.examples,
    };
  }
  return out;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return await res.text();
}

// ------------------------------------------------------------
// Main scraper
// ------------------------------------------------------------
export default async function handler(req, res) {
  const started = Date.now();

  try {
    const sourceUrls = [];
    const pageSummaries = [];
    const dropState = buildDropRecorder();

    const deals = [];
    const seenHandles = new Set();

    const genderCounts = {
      mens: 0,
      womens: 0,
      unisex: 0,
      unknown: 0,
    };

    let pagesFetched = 0;
    let dealsFound = 0;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const pageUrl = page === 1 ? COLLECTION_URL : `${COLLECTION_URL}?page=${page}`;

      const html = await fetchHtml(pageUrl);
      const $ = cheerio.load(html);

      const cards = extractProductCards($);
      if (!cards.length) {
        break;
      }

      sourceUrls.push(pageUrl);
      pagesFetched += 1;

      const pageSummary = {
        page,
        url: pageUrl,
        tilesSeen: cards.length,
        kept: 0,
        dropped: 0,
        dropsByReason: {},
        genderKept: {
          mens: 0,
          womens: 0,
          unisex: 0,
          unknown: 0,
        },
      };

      for (const $card of cards) {
        dealsFound += 1;
        dropState.counts.totalTilesSeen += 1;

        const rawText = cleanText($card.text());
        const listingURL = getProductLinkFromCard($, $card);
        const imageURL = getImageUrlFromCard($, $card);

        let listingName =
          cleanText($card.find("h1,h2,h3,h4").first().text()) ||
          cleanText($card.find('img[alt]').first().attr("alt")) ||
          null;

        if (!listingName && listingURL) {
          const handleGuess =
            listingURL.split("/products/")[1]?.split("?")[0]?.split("/").pop() || "";

          if (handleGuess) {
            listingName = handleGuess
              .replace(/-/g, " ")
              .replace(/\bmens\b/i, "Men's")
              .replace(/\bwomens\b/i, "Women's")
              .replace(/\bunisex\b/i, "Unisex")
              .replace(/\s+/g, " ")
              .trim();
          }
        }

        const handle = listingURL
          ? listingURL.split("/products/")[1]?.split("?")[0]?.split("/").pop() || null
          : null;

        if (handle && seenHandles.has(handle)) {
          dropState.counts.dropped_duplicateHandle += 1;
          pageSummary.dropped += 1;
          pageSummary.dropsByReason.dropped_duplicateHandle =
            (pageSummary.dropsByReason.dropped_duplicateHandle || 0) + 1;
          noteDrop(dropState, "dropped_duplicateHandle", STORE, { page, handle, listingName });
          continue;
        }

        if (!listingName) {
          dropState.counts.dropped_missingListingName += 1;
          pageSummary.dropped += 1;
          pageSummary.dropsByReason.dropped_missingListingName =
            (pageSummary.dropsByReason.dropped_missingListingName || 0) + 1;
          noteDrop(dropState, "dropped_missingListingName", STORE, { page, listingURL });
          continue;
        }

        if (!isProbablyFootwear(listingName)) {
          dropState.counts.dropped_nonFootwear += 1;
          pageSummary.dropped += 1;
          pageSummary.dropsByReason.dropped_nonFootwear =
            (pageSummary.dropsByReason.dropped_nonFootwear || 0) + 1;
          noteDrop(dropState, "dropped_nonFootwear", STORE, { page, listingName });
          continue;
        }

        if (!listingURL) {
          dropState.counts.dropped_missingListingURL += 1;
          pageSummary.dropped += 1;
          pageSummary.dropsByReason.dropped_missingListingURL =
            (pageSummary.dropsByReason.dropped_missingListingURL || 0) + 1;
          noteDrop(dropState, "dropped_missingListingURL", STORE, { page, listingName });
          continue;
        }

        if (!imageURL) {
          dropState.counts.dropped_missingImageURL += 1;
          pageSummary.dropped += 1;
          pageSummary.dropsByReason.dropped_missingImageURL =
            (pageSummary.dropsByReason.dropped_missingImageURL || 0) + 1;
          noteDrop(dropState, "dropped_missingImageURL", STORE, { page, listingName, listingURL });
          continue;
        }

        const priceInfo = extractPriceInfoFromCard($, $card);

        if (priceInfo.hiddenPrice || looksLikeHiddenPrice(rawText)) {
          dropState.counts.dropped_hiddenPriceTile += 1;
          pageSummary.dropped += 1;
          pageSummary.dropsByReason.dropped_hiddenPriceTile =
            (pageSummary.dropsByReason.dropped_hiddenPriceTile || 0) + 1;
          noteDrop(dropState, "dropped_hiddenPriceTile", STORE, { page, listingName, listingURL });
          continue;
        }

        if (!Number.isFinite(priceInfo.salePrice)) {
          dropState.counts.dropped_missingSalePrice += 1;
          pageSummary.dropped += 1;
          pageSummary.dropsByReason.dropped_missingSalePrice =
            (pageSummary.dropsByReason.dropped_missingSalePrice || 0) + 1;
          noteDrop(dropState, "dropped_missingSalePrice", STORE, { page, listingName, listingURL });
          continue;
        }

        if (
          Number.isFinite(priceInfo.originalPrice) &&
          !(priceInfo.salePrice < priceInfo.originalPrice)
        ) {
          dropState.counts.dropped_saleNotLessThanOriginal += 1;
          pageSummary.dropped += 1;
          pageSummary.dropsByReason.dropped_saleNotLessThanOriginal =
            (pageSummary.dropsByReason.dropped_saleNotLessThanOriginal || 0) + 1;
          noteDrop(dropState, "dropped_saleNotLessThanOriginal", STORE, {
            page,
            listingName,
            salePrice: priceInfo.salePrice,
            originalPrice: priceInfo.originalPrice,
          });
          continue;
        }

        const gender = normalizeGender(inferGenderFromTitleAndHandle(listingName, handle));
        const brand = deriveBrand(listingName);

        if (!brand || /^unknown$/i.test(brand)) {
          dropState.counts.dropped_unknownBrand += 1;
          pageSummary.dropped += 1;
          pageSummary.dropsByReason.dropped_unknownBrand =
            (pageSummary.dropsByReason.dropped_unknownBrand || 0) + 1;
          noteDrop(dropState, "dropped_unknownBrand", STORE, { page, listingName, listingURL });
          continue;
        }

        const model = deriveModel(listingName, brand);

        const deal = {
          schemaVersion: SCHEMA_VERSION,

          listingName,

          brand,
          model,

          salePrice: round2(priceInfo.salePrice),
          originalPrice: Number.isFinite(priceInfo.originalPrice) ? round2(priceInfo.originalPrice) : null,
          discountPercent: Number.isFinite(priceInfo.discountPercent) ? priceInfo.discountPercent : null,

          salePriceLow: null,
          salePriceHigh: null,
          originalPriceLow: null,
          originalPriceHigh: null,
          discountPercentUpTo: Number.isFinite(priceInfo.discountPercentUpTo) ? priceInfo.discountPercentUpTo : null,

          store: STORE,

          listingURL,
          imageURL,

          gender,
          shoeType: "unknown",
        };

        deals.push(deal);

        if (handle) {
          seenHandles.add(handle);
        }

        genderCounts[gender] = (genderCounts[gender] || 0) + 1;
        pageSummary.genderKept[gender] = (pageSummary.genderKept[gender] || 0) + 1;
        pageSummary.kept += 1;
      }

      pageSummary.dropped = pageSummary.tilesSeen - pageSummary.kept;
      pageSummaries.push(pageSummary);
    }

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,

      pagesFetched,

      dealsFound,
      dealsExtracted: deals.length,

      genderCounts,

      pageSummaries,

      dropCounts: dropState.counts,
      droppedReasons: serializeDroppedReasons(dropState.byReason),

      scrapeDurationMs: Date.now() - started,

      ok: true,
      error: null,

      deals,
    };

    const blob = await put(BLOB_PATH, JSON.stringify(output, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobUrl: blob.url,
      pagesFetched: output.pagesFetched,
      dealsFound: output.dealsFound,
      dealsExtracted: output.dealsExtracted,
      genderCounts: output.genderCounts,
      scrapeDurationMs: output.scrapeDurationMs,
      sourceUrls: output.sourceUrls,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: err?.message || String(err),
      scrapeDurationMs: Date.now() - started,
    });
  }
}
