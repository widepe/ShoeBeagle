// /api/scrapers/marathon-sports-cheerio.js

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");
const { canonicalBrandModelHelper } = require("../../lib/canonical-brand-models");

export const config = { maxDuration: 60 };

const STORE = "Marathon Sports";
const VIA = "cheerio";
const SCHEMA_VERSION = 1;
const MAX_DROPPED_DEALS_LOG = 200;

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function absolutizeUrl(u, base) {
  let url = String(u || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return base.replace(/\/+$/, "") + url;
  return base.replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
}

function pickBestImgUrl($, $img, base) {
  if (!$img || !$img.length) return null;

  const direct =
    $img.attr("data-src") ||
    $img.attr("data-original") ||
    $img.attr("data-lazy") ||
    $img.attr("src");

  const srcset = $img.attr("data-srcset") || $img.attr("srcset");

  let candidate = (direct || "").trim();

  if (!candidate && srcset) {
    const parts = srcset
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1] || "";
    candidate = (last.split(" ")[0] || "").trim();
  }

  if (!candidate || candidate.startsWith("data:") || candidate === "#") return null;
  return absolutizeUrl(candidate, base);
}

function parseBrandModelFromCanonical(listingName, rawBrandHint = "") {
  return canonicalBrandModelHelper.parseBrandModelFromText(listingName, rawBrandHint);
}

// Gender is derived exclusively from tile content: the .type div, item_name from
// dl-item, and the listing name. The feed/browse URL is intentionally excluded —
// the same shoe can appear in both mens and womens feeds, so the tile itself is
// the authoritative source.
function detectGender(listingName, typeText = "", itemName = "") {
  const combined = `${listingName || ""} ${typeText || ""} ${itemName || ""}`.toLowerCase();

  if (/\b(men'?s?|mens|male)\b/i.test(combined)) return "mens";
  if (/\b(women'?s?|womens|female|ladies)\b/i.test(combined)) return "womens";
  if (/\bunisex\b/i.test(combined)) return "unisex";

  return "unknown";
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function parseDollar(txt) {
  const m = String(txt || "").match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function buildDeal({
  listingName,
  brand,
  model,
  salePrice,
  originalPrice,
  discountPercent,
  store,
  listingURL,
  imageURL,
  gender,
  shoeType,
}) {
  return {
    schemaVersion: 1,

    listingName: listingName || "",

    brand: brand || "Unknown",
    model: model || "",

    salePrice: Number.isFinite(salePrice) ? salePrice : null,
    originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
    discountPercent: Number.isFinite(discountPercent) ? discountPercent : null,

    salePriceLow: null,
    salePriceHigh: null,
    originalPriceLow: null,
    originalPriceHigh: null,
    discountPercentUpTo: null,

    store: store || "",

    listingURL: listingURL || "",
    imageURL: imageURL || null,

    gender: gender || "unknown",
    shoeType: shoeType || "unknown",
  };
}

function extractDlItem($tile) {
  const raw = $tile.attr("dl-item");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchTextWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} for ${url}`);
    }

    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeMarathonSports() {
  const base = "https://www.marathonsports.com";

  const seedUrls = [
    "https://www.marathonsports.com/shop/mens/shoes?sale=1",
    "https://www.marathonsports.com/shop/womens/shoes?sale=1",
  ];

  const HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  // Step 1: fetch page 1 of each seed to determine total pages, then build full URL list
  const allPageUrls = [];

  for (const seedUrl of seedUrls) {
    const html = await fetchTextWithTimeout(seedUrl, { headers: HEADERS }, 20000);
    const $ = cheerio.load(html);

    // <div class="total-hits">134 Results</div>
    const hitsText = normalizeWhitespace($(".total-hits").first().text());
    const totalHits = parseInt(hitsText) || 0;
    const hitsPerPage = $(".product-partial.partial").length || 24;
    const totalPages = Math.max(1, Math.ceil(totalHits / hitsPerPage));

    for (let p = 1; p <= totalPages; p++) {
      allPageUrls.push(p === 1 ? seedUrl : `${seedUrl}&page=${p}`);
    }
  }

  const sourceUrls = [...allPageUrls];

  // Step 2: fetch all pages in parallel (page 1s are re-fetched; simpler than caching)
  const htmlPages = await Promise.all(
    allPageUrls.map((url) =>
      fetchTextWithTimeout(url, { headers: HEADERS }, 20000).catch((err) => {
        console.error(`Failed to fetch ${url}: ${err.message}`);
        return null;
      })
    )
  );

  const pagesFetched = htmlPages.filter(Boolean).length;
  let dealsFound = 0;

  const deals = [];
  const seenUrls = new Set();

  // firstSeenOnSeed tracks which seed a listing was first encountered on,
  // so we can distinguish same-feed pagination dupes from cross-feed dupes.
  const firstSeenOnSeed = new Map();

  // duplicatesBySource counts how many dupes were dropped per seed URL
  const duplicatesBySource = {};

  const dropCounts = {
    missingHref: 0,
    missingListingURL: 0,
    duplicateUrl: 0,            // duplicate within the same seed feed
    duplicateUrlCrossSource: 0, // duplicate first seen on a different seed feed
    missingListingName: 0,
    missingPrice: 0,
    invalidPriceRelation: 0,
    invalidDiscountPercent: 0,
  };

  const droppedDeals = [];

  function logDropped(reason, payload = {}) {
    if (dropCounts[reason] == null) dropCounts[reason] = 0;
    dropCounts[reason]++;
    if (droppedDeals.length < MAX_DROPPED_DEALS_LOG) {
      droppedDeals.push({ reason, ...payload });
    }
  }

  function getSeedForUrl(pageUrl) {
    for (const s of seedUrls) {
      const seedBase = s.split("?")[0];
      if (pageUrl.startsWith(seedBase)) return s;
    }
    return pageUrl;
  }

  for (let i = 0; i < allPageUrls.length; i++) {
    const currentUrl = allPageUrls[i];
    const html = htmlPages[i];
    if (!html) continue;

    const currentSeed = getSeedForUrl(currentUrl);
    const $ = cheerio.load(html);

    $(".product-partial.partial").each((_, el) => {
      const $tile = $(el);

      const $link = $tile.find("h2.title a.link").first();
      if (!$link.length) return;

      const saleFlag = normalizeWhitespace($tile.find(".sale").first().text() || "");
      if (!/\bsale\b/i.test(saleFlag)) return;

      dealsFound++;

      const rawHref = String($link.attr("href") || "").trim();
      const rawListingName = normalizeWhitespace($link.text() || "");
      const $img = $tile.find(".image-wrap img").first();
      const imageURL = pickBestImgUrl($, $img, base);

      const compareAtFromHtml = parseDollar($tile.find(".product-price .num.-compare").first().text());
      const salePriceFromHtml = parseDollar($tile.find(".product-price .num.-price").first().text());

      const dlItem = extractDlItem($tile);
      const salePriceFromDl = Number.isFinite(Number(dlItem?.price)) ? Number(dlItem.price) : null;
      const brandHint = normalizeWhitespace(dlItem?.item_brand || "");
      const itemName = normalizeWhitespace(dlItem?.item_name || "");

      // HTML compare-at is the most reliable original price.
      // Fall back to dl-item only when it differs from the HTML sale price.
      const originalPrice = Number.isFinite(compareAtFromHtml)
        ? compareAtFromHtml
        : salePriceFromDl !== null && salePriceFromDl !== salePriceFromHtml
        ? salePriceFromDl
        : null;

      const salePrice = Number.isFinite(salePriceFromHtml) ? salePriceFromHtml : salePriceFromDl;

      if (!rawHref) {
        logDropped("missingHref", { currentUrl, listingName: rawListingName || "", listingURL: "", imageURL, saleFlag, originalPrice, salePrice, salePriceFromHtml, salePriceFromDl, brandHint });
        return;
      }

      const listingURL = absolutizeUrl(rawHref, base);
      if (!listingURL) {
        logDropped("missingListingURL", { currentUrl, listingName: rawListingName || "", rawHref, listingURL: "", imageURL, saleFlag, originalPrice, salePrice, salePriceFromHtml, salePriceFromDl, brandHint });
        return;
      }

      if (seenUrls.has(listingURL)) {
        const firstSeed = firstSeenOnSeed.get(listingURL);
        const isCrossSource = firstSeed !== undefined && firstSeed !== currentSeed;
        const reason = isCrossSource ? "duplicateUrlCrossSource" : "duplicateUrl";

        if (!duplicatesBySource[currentSeed]) duplicatesBySource[currentSeed] = 0;
        duplicatesBySource[currentSeed]++;

        logDropped(reason, { currentUrl, firstSeenOnSeed: firstSeed || null, listingName: rawListingName || "", listingURL, imageURL, saleFlag, originalPrice, salePrice, salePriceFromHtml, salePriceFromDl, brandHint });
        return;
      }

      const listingName = rawListingName;
      if (!listingName) {
        logDropped("missingListingName", { currentUrl, listingName: "", listingURL, imageURL, saleFlag, originalPrice, salePrice, salePriceFromHtml, salePriceFromDl, brandHint });
        return;
      }

      if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice)) {
        logDropped("missingPrice", { currentUrl, listingName, listingURL, imageURL, saleFlag, originalPrice, salePrice, salePriceFromHtml, salePriceFromDl, brandHint });
        return;
      }

      if (!(originalPrice > salePrice && salePrice > 0)) {
        logDropped("invalidPriceRelation", { currentUrl, listingName, listingURL, imageURL, saleFlag, originalPrice, salePrice, salePriceFromHtml, salePriceFromDl, brandHint });
        return;
      }

      const discountPercent = computeDiscountPercent(originalPrice, salePrice);
      if (!Number.isFinite(discountPercent) || discountPercent < 5 || discountPercent > 90) {
        logDropped("invalidDiscountPercent", { currentUrl, listingName, listingURL, imageURL, saleFlag, originalPrice, salePrice, salePriceFromHtml, salePriceFromDl, discountPercent, brandHint });
        return;
      }

      const typeText = normalizeWhitespace($tile.find(".type").first().text() || "");
      const { brand, model } = parseBrandModelFromCanonical(listingName, brandHint);

      // Gender from tile content only: .type div + item_name from dl-item + listing name.
      // Feed URL is not used — the same shoe can appear in both mens and womens feeds.
      const gender = detectGender(listingName, typeText, itemName);

      seenUrls.add(listingURL);
      firstSeenOnSeed.set(listingURL, currentSeed);

      deals.push(
        buildDeal({ listingName, brand, model, salePrice, originalPrice, discountPercent, store: STORE, listingURL, imageURL, gender, shoeType: "unknown" })
      );
    });
  }

  return {
    deals,
    sourceUrls,
    pagesFetched,
    dealsFound,
    dealsExtracted: deals.length,
    dropCounts,
    duplicatesBySource,
    droppedDeals,
    droppedDealsLogged: droppedDeals.length,
    droppedDealsLogCapped: dealsFound - deals.length > MAX_DROPPED_DEALS_LOG,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // CRON_SECRET
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const start = Date.now();
  const timestamp = nowIso();

  try {
    const result = await scrapeMarathonSports();
    const durationMs = Date.now() - start;

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: timestamp,
      via: VIA,

      sourceUrls: result.sourceUrls,
      pagesFetched: result.pagesFetched,

      dealsFound: result.dealsFound,
      dealsExtracted: result.dealsExtracted,

      scrapeDurationMs: durationMs,

      ok: true,
      error: null,

      dropCounts: result.dropCounts,
      duplicatesBySource: result.duplicatesBySource,
      droppedDealsLogged: result.droppedDealsLogged,
      droppedDealsLogCapped: result.droppedDealsLogCapped,
      droppedDeals: result.droppedDeals,

      deals: result.deals,
    };

    const blob = await put("marathon-sports.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobUrl: blob.url,
      dealsExtracted: output.dealsExtracted,
      dropCounts: output.dropCounts,
      duplicatesBySource: output.duplicatesBySource,
      droppedDealsLogged: output.droppedDealsLogged,
      scrapeDurationMs: durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - start;

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: timestamp,
      via: VIA,

      sourceUrls: [],
      pagesFetched: null,

      dealsFound: null,
      dealsExtracted: 0,

      scrapeDurationMs: durationMs,

      ok: false,
      error: err?.message || "Unknown error",

      dropCounts: null,
      duplicatesBySource: null,
      droppedDealsLogged: 0,
      droppedDealsLogCapped: false,
      droppedDeals: [],

      deals: [],
    };

    const blob = await put("marathon-sports.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(500).json({
      success: false,
      store: STORE,
      blobUrl: blob.url,
      error: output.error,
    });
  }
}
