// /api/scrapers/_holabirdShared.js
//
// Holabird collection tile scraper (Shopify theme)
//
// Output per scrape call:
// {
//   store, schemaVersion,
//   lastUpdated, via,
//   sourceUrls, pagesFetched,
//   dealsFound, dealsExtracted,
//   scrapeDurationMs,
//   ok, error,
//   deals: [ canonical deal objects ]
// }
//
// Canonical deal fields:
//   listingName, brand, model, salePrice, originalPrice, discountPercent,
//   store, listingURL, imageURL, gender, shoeType
//
// Rules:
// - listingName must be text (NO html / attributes / outerHTML).
// - shoeType is defined by the collection being scraped (road vs trail).
// - gender is derived from listingName (card title). Fallback only if unknown.
// - no external model cleaner.

const axios = require("axios");
const cheerio = require("cheerio");

const HOLABIRD_BASE = "https://www.holabirdsports.com";
const STORE_NAME = "Holabird Sports";
const SCHEMA_VERSION = 1;

/** -------------------- small utilities -------------------- **/

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(input) {
  if (input == null) return "";
  return String(input).replace(/\s+/g, " ").trim();
}

function absolutizeUrl(url, base = HOLABIRD_BASE) {
  if (!url) return null;
  const u = String(url).trim();
  if (!u) return null;

  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return base.replace(/\/+$/, "") + u;

  return base.replace(/\/+$/, "") + "/" + u.replace(/^\/+/, "");
}

function extractDollar(text) {
  const m = String(text || "").match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

/** -------------------- image helpers -------------------- **/

function pickLargestFromSrcset(srcset) {
  if (!srcset) return null;

  const parts = String(srcset)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  let best = null;
  let bestScore = -1;

  for (const part of parts) {
    const [url, desc] = part.split(/\s+/);
    if (!url) continue;

    let score = 0;
    const mW = desc?.match(/(\d+)w/i);
    const mX = desc?.match(/(\d+(?:\.\d+)?)x/i);

    if (mW) score = parseInt(mW[1], 10);
    else if (mX) score = Math.round(parseFloat(mX[1]) * 1000);

    if (score >= bestScore) {
      bestScore = score;
      best = url;
    }
  }

  return best;
}

function bestImgUrlFrom($img) {
  if (!$img || !$img.length) return null;

  const src = $img.attr("data-src") || $img.attr("data-original") || $img.attr("src");
  const srcset = $img.attr("data-srcset") || $img.attr("srcset");
  const picked = pickLargestFromSrcset(srcset);

  return absolutizeUrl(String(picked || src || "").trim(), HOLABIRD_BASE);
}

function findBestImageURL($tile) {
  const $primary = $tile.find("img.product-item__primary-image").first();
  const $any = $tile.find("img").first();
  return bestImgUrlFrom($primary) || bestImgUrlFrom($any) || null;
}

/** -------------------- title / gender / brand / model -------------------- **/

function extractHolabirdTitleText($tile) {
  // IMPORTANT: .text() returns text (decodes entities, ignores tags like <br>)
  const t =
    $tile.find("a.product-item__title").first().text() ||
    $tile.find("img.product-item__primary-image").first().attr("alt") ||
    $tile.find("a.product-item__title").first().attr("title") ||
    "";

  // Normalize whitespace so <br> doesn’t create odd spacing.
  return normalizeText(t);
}

function detectGenderFromTitle(listingName) {
  const s = String(listingName || "").toLowerCase();

  // common Holabird patterns: "Men's", "Women's", sometimes "Unisex"
  if (/\bmen'?s\b/.test(s) || /\bmens\b/.test(s)) return "mens";
  if (/\bwomen'?s\b/.test(s) || /\bwomens\b/.test(s)) return "womens";
  if (/\bunisex\b/.test(s)) return "unisex";

  return "unknown";
}

// Brand list: longest-first match to avoid "On" beating "On Running".
const BRANDS = [
  "Mount to Coast",
  "New Balance",
  "Under Armour",
  "The North Face",
  "La Sportiva",
  "Pearl Izumi",
  "Topo Athletic",
  "Vibram FiveFingers",
  "On Running",
  "361 Degrees",
  "ASICS",
  "Brooks",
  "Saucony",
  "Mizuno",
  "adidas",
  "Nike",
  "HOKA",
  "Puma",
  "Salomon",
  "Diadora",
  "Skechers",
  "Reebok",
  "Altra",
  "Karhu",
  "norda",
  "Nnormal",
  "inov8",
  "Inov-8",
  "VEJA",
  "APL",
  "On",
];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBrand(title) {
  const t = String(title || "");
  if (!t) return "Unknown";

  const brandsSorted = [...BRANDS].sort((a, b) => b.length - a.length);

  for (const b of brandsSorted) {
    if (b === "On") {
      // avoid "on sale" false positives
      if (/\bOn\b/.test(t)) return "On";
      continue;
    }
    const re = new RegExp(`\\b${escapeRegex(b)}\\b`, "i");
    if (re.test(t)) return b;
  }

  // fallback: first word as brand if title looks like "Brand Model..."
  const parts = normalizeText(t).split(" ");
  return parts[0] || "Unknown";
}

function cleanModelFromTitle(title, brand) {
  let t = normalizeText(title);

  // Remove brand token once
  if (brand && brand !== "Unknown") {
    const re = brand === "On"
      ? /\bOn\b/
      : new RegExp(`\\b${escapeRegex(brand)}\\b`, "i");
    t = normalizeText(t.replace(re, " "));
  }

  // Cut off at explicit gender token (keeps model clean; colorway often follows)
  // Examples:
  // "Sonicblast Men's Arctic Blue/Grey Blue" => "Sonicblast"
  // "Mafate 5 Women's Black/Gold" => "Mafate 5"
  t = t.replace(/\b(Men'?s|Mens|Women'?s|Womens|Unisex)\b.*$/i, "").trim();

  // Remove common trailing junk that sometimes appears before gender or standalone
  t = t.replace(/\b(Running Shoe|Trail Running Shoe|Shoe)\b\s*$/i, "").trim();

  // Remove "Item #xxxxxx" if ever present in text fallback
  t = t.replace(/\bItem\s*#\s*\d+\b/i, "").trim();

  // Final whitespace normalize
  return normalizeText(t);
}

/** -------------------- price extraction -------------------- **/

function extractPricesStructured($tile) {
  const saleText = normalizeText($tile.find(".product-item__price-list .price--highlight").first().text());
  const origText = normalizeText($tile.find(".product-item__price-list .price--compare").first().text());

  const sale = extractDollar(saleText);
  const orig = extractDollar(origText);

  if (!Number.isFinite(sale) || !Number.isFinite(orig)) return { valid: false };
  if (!(sale < orig)) return { valid: false };

  return { salePrice: round2(sale), originalPrice: round2(orig), valid: true };
}

/** -------------------- delay -------------------- **/

function randomDelay(min = 250, max = 700) {
  const wait = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, wait));
}

/** -------------------- core scraper -------------------- **/

/**
 * Scrape one Holabird collection.
 *
 * Params:
 * - collectionUrl: string (base collection URL)
 * - shoeType: "road" | "trail" | "unknown"  (defined by the page/collection)
 * - fallbackGender: "mens"|"womens"|"unisex"|null  (ONLY used if title-based gender is unknown)
 * - maxPages, stopAfterEmptyPages
 * - excludeGiftCard: boolean
 * - requireStructuredSaleCompare: boolean (recommended true)
 */
async function scrapeHolabirdCollection({
  collectionUrl,
  shoeType = "unknown",
  fallbackGender = null,

  maxPages = 80,
  stopAfterEmptyPages = 2,

  excludeGiftCard = true,
  requireStructuredSaleCompare = true,
} = {}) {
  const deals = [];
  const seen = new Set();

  let pagesFetched = 0;
  let dealsFound = 0;      // products found on pages (tiles)
  let emptyPages = 0;

  const visitedForSourceUrls = [];

  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = collectionUrl.includes("?")
      ? `${collectionUrl}&page=${page}`
      : `${collectionUrl}?page=${page}`;

    const resp = await axios.get(pageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 20000,
      validateStatus: () => true,
    });

    // If we get blocked / non-200, stop early but report what happened
    if (resp.status < 200 || resp.status >= 400) {
      throw new Error(`Holabird HTTP ${resp.status} on ${pageUrl}`);
    }

    pagesFetched++;
    if (visitedForSourceUrls.length < 2) visitedForSourceUrls.push(pageUrl);

    const $ = cheerio.load(resp.data);

    let foundThisPage = 0;

    $(".product-item").each((_, el) => {
      const $tile = $(el);

      if (excludeGiftCard && $tile.find(".gift-card-message").length) return;

      const href = $tile.find('a[href^="/products/"]').first().attr("href");
      if (!href || href.includes("#")) return;

      const listingURL = absolutizeUrl(href);
      if (!listingURL || seen.has(listingURL)) return;

      const listingName = extractHolabirdTitleText($tile);
      if (!listingName) return;

      // This counts as a product found on the page(s) regardless of whether we later filter it out.
      foundThisPage++;
      dealsFound++;

      // Require sale + compare price elements if requested
      if (requireStructuredSaleCompare) {
        const hasSale = $tile.find(".price--highlight").length > 0;
        const hasCompare = $tile.find(".price--compare").length > 0;
        if (!hasSale || !hasCompare) return;
      }

      const prices = extractPricesStructured($tile);
      if (!prices.valid) return;

      const brand = extractBrand(listingName);
      const model = cleanModelFromTitle(listingName, brand);

      let gender = detectGenderFromTitle(listingName);
      if (gender === "unknown" && fallbackGender) gender = fallbackGender;

      const salePrice = prices.salePrice;
      const originalPrice = prices.originalPrice;

      deals.push({
        listingName,
        brand,
        model,
        salePrice,
        originalPrice,
        discountPercent: computeDiscountPercent(originalPrice, salePrice),
        store: STORE_NAME,
        listingURL,
        imageURL: findBestImageURL($tile),
        gender,
        shoeType,
      });

      seen.add(listingURL);
    });

    if (foundThisPage === 0) {
      emptyPages++;
      if (emptyPages >= stopAfterEmptyPages) break;
    } else {
      emptyPages = 0;
    }

    await randomDelay();
  }

  return {
    pagesFetched,
    dealsFound,
    dealsExtracted: deals.length,
    sourceUrls: visitedForSourceUrls.length ? visitedForSourceUrls : [collectionUrl],
    deals,
  };
}

function dedupeByUrl(deals) {
  const out = [];
  const seen = new Set();
  for (const d of deals || []) {
    if (!d?.listingURL || seen.has(d.listingURL)) continue;
    seen.add(d.listingURL);
    out.push(d);
  }
  return out;
}

function buildTopLevel({ via, sourceUrls, pagesFetched, dealsFound, dealsExtracted, scrapeDurationMs, ok, error, deals }) {
  return {
    store: STORE_NAME,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated: nowIso(),
    via: via || "cheerio",

    sourceUrls: Array.isArray(sourceUrls) && sourceUrls.length ? sourceUrls : [],
    pagesFetched: Number.isFinite(pagesFetched) ? pagesFetched : 0,

    dealsFound: Number.isFinite(dealsFound) ? dealsFound : 0,
    dealsExtracted: Number.isFinite(dealsExtracted) ? dealsExtracted : (Array.isArray(deals) ? deals.length : 0),

    scrapeDurationMs: Number.isFinite(scrapeDurationMs) ? scrapeDurationMs : 0,

    ok: !!ok,
    error: error || null,

    deals: Array.isArray(deals) ? deals : [],
  };
}

module.exports = {
  scrapeHolabirdCollection,
  dedupeByUrl,
  buildTopLevel,
};
