// /api/scrape-gazelle-sports.js   (CommonJS)
// Scrapes Gazelle Sports men's + women's sale shoes pages on Vercel (Cheerio),
// follows "Load More" pagination via ?p=2, ?p=3, ...
//
// Rules (per your requirements):
// - Gender comes from the URL (mens/womens), BUT if the tile/title contains
//   "unisex" OR "all gender" => gender = "unisex".
// - If a deal states "soccer" anywhere in brand/title/color/aria-label => DROP.
// - shoeType is always "unknown".
// - Uses strike price as originalPrice and non-strike as salePrice.
// - Range fields are null (this site shows single prices in tiles).
//
// Output blob path: .../gazelle-sports.json

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

function nowIso() {
  return new Date().toISOString();
}

function absUrl(base, href) {
  if (!href) return null;
  const s = String(href).trim();
  if (!s) return null;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (!s.startsWith("/")) return `${base}/${s}`;
  return `${base}${s}`;
}

function parseMoneyToNumber(s) {
  // "$149.95" -> 149.95
  const raw = String(s || "").replace(/[\s,]/g, "").trim();
  const m = raw.match(/\$?(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0) return null;
  const pct = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  if (!Number.isFinite(pct)) return null;
  return pct;
}

function normalizeWs(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function containsSoccer(text) {
  return /\bsoccer\b/i.test(String(text || ""));
}

function deriveGenderFromUrl(url) {
  const u = String(url || "").toLowerCase();
  if (u.includes("/mens-")) return "mens";
  if (u.includes("/womens-")) return "womens";
  // fallback
  if (u.includes("/mens")) return "mens";
  if (u.includes("/womens")) return "womens";
  return "unknown";
}

function overrideGenderIfUnisex(text, defaultGender) {
  const t = String(text || "").toLowerCase();
  if (t.includes("unisex") || t.includes("all gender") || t.includes("all-gender")) {
    return "unisex";
  }
  return defaultGender;
}

function parseTilesFromHtml(html, pageUrl, baseSiteUrl) {
  const $ = cheerio.load(html);

  const tiles = $("article.ss__result");
  const deals = [];

  // we count every tile as "found" (before filtering), per your usual pattern
  const found = tiles.length;

  tiles.each((_, el) => {
    const tile = $(el);

    const a = tile.find("a.ss__result-link").first();
    const href = a.attr("href");
    const listingURL = absUrl(baseSiteUrl, href);

    const aria = normalizeWs(a.attr("aria-label") || "");

    const brand = normalizeWs(tile.find(".ss__result__details__brand").first().text());
    const title = normalizeWs(tile.find(".ss__result__details__title").first().text());
    const color = normalizeWs(tile.find(".ss__result__details__color").first().text());

    // Pricing: strike == original, non-strike == sale (based on your tile HTML)
    const originalText = normalizeWs(
      tile
        .find(".ss__result__details__pricing .ss__price--strike")
        .first()
        .text()
    );
    // sale is the first non-strike price in pricing area
    // (some themes include multiple spans; we intentionally exclude strike)
    let saleText = null;
    tile
      .find(".ss__result__details__pricing .ss__price")
      .each((__, sp) => {
        const klass = String($(sp).attr("class") || "");
        if (klass.includes("ss__price--strike")) return;
        const t = normalizeWs($(sp).text());
        if (t && !saleText) saleText = t;
      });

    const originalPrice = parseMoneyToNumber(originalText);
    const salePrice = parseMoneyToNumber(saleText);

    // image: prefer main image
    const imgSrc =
      tile.find("img.product__img--main").first().attr("src") ||
      tile.find("img.product__img").first().attr("src") ||
      null;
    const imageURL = imgSrc ? String(imgSrc).trim() : null;

    const defaultGender = deriveGenderFromUrl(pageUrl);
    const unisexTextHaystack = `${aria} ${brand} ${title} ${color}`.trim();
    const gender = overrideGenderIfUnisex(unisexTextHaystack, defaultGender);

    const soccerHaystack = `${aria} ${brand} ${title} ${color}`.trim();
    if (containsSoccer(soccerHaystack)) {
      deals.push({ __dropped: "soccer" });
      return;
    }

    // Enforce deal honesty: need both original + sale
    if (!listingURL || !imageURL || !brand || !title) {
      deals.push({ __dropped: "missingCore" });
      return;
    }
    if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) {
      deals.push({ __dropped: "missingPrices" });
      return;
    }
    if (salePrice <= 0 || originalPrice <= 0) {
      deals.push({ __dropped: "badPrices" });
      return;
    }
    if (salePrice >= originalPrice) {
      deals.push({ __dropped: "notADeal" });
      return;
    }

    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    // listingName: keep stable + descriptive; DO NOT edit later in merge.
    const listingName = normalizeWs(
      `${brand} ${title}${color ? ` - ${color}` : ""}`
    );

    deals.push({
      listingName,

      brand,
      model: title,

      salePrice,
      originalPrice,
      discountPercent,

      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,

      store: "Gazelle Sports",

      listingURL,
      imageURL,

      gender,
      shoeType: "unknown",
    });
  });

  return { found, parsed: deals };
}

async function fetchHtml(url, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; ShoeBeagleBot/1.0; +https://shoebeagle.com)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function scrapeCollection(baseSiteUrl, collectionUrl) {
  const sourceUrls = [];
  const allDeals = [];
  const dropCounts = {
    totalTiles: 0,
    dropped_soccer: 0,
    dropped_missingCore: 0,
    dropped_missingPrices: 0,
    dropped_badPrices: 0,
    dropped_notADeal: 0,
    kept: 0,
  };

  let pagesFetched = 0;
  let p = 1;

  // Safety cap
  const MAX_PAGES = 25;

  while (p <= MAX_PAGES) {
    const pageUrl = p === 1 ? collectionUrl : `${collectionUrl}?p=${p}`;
    sourceUrls.push(pageUrl);

    const html = await fetchHtml(pageUrl);
    pagesFetched += 1;

    const { found, parsed } = parseTilesFromHtml(html, pageUrl, baseSiteUrl);

    // If no tiles on this page, stop.
    if (!found) break;

    dropCounts.totalTiles += found;

    // Split kept vs dropped markers
    let keptThisPage = 0;
    for (const item of parsed) {
      if (item && item.__dropped) {
        const k = item.__dropped;
        if (k === "soccer") dropCounts.dropped_soccer += 1;
        else if (k === "missingCore") dropCounts.dropped_missingCore += 1;
        else if (k === "missingPrices") dropCounts.dropped_missingPrices += 1;
        else if (k === "badPrices") dropCounts.dropped_badPrices += 1;
        else if (k === "notADeal") dropCounts.dropped_notADeal += 1;
        else dropCounts.dropped_missingCore += 1;
        continue;
      }
      allDeals.push(item);
      keptThisPage += 1;
    }

    dropCounts.kept += keptThisPage;

    // Heuristic: if Shopify/theme stops returning new pages, next page often repeats
    // or becomes empty; we already stop on empty. Also stop if page seems "short".
    // (You said Load More adds 24; so < 5 is a good "end" signal)
    if (found < 5) break;

    p += 1;
  }

  return {
    sourceUrls,
    pagesFetched,
    dealsFound: dropCounts.totalTiles,
    dealsExtracted: allDeals.length,
    dropCounts,
    deals: allDeals,
  };
}

module.exports = async function handler(req, res) {

  // ---------------------------------
  // CRON SECRET PROTECTION
  // ---------------------------------
//  const CRON_SECRET = String(process.env.CRON_SECRET || "").trim();

//  if (CRON_SECRET) {
//    const provided =
//      String(req.headers["x-cron-secret"] || "").trim() ||
//      String(req.query?.cron_secret || "").trim();

//    if (provided !== CRON_SECRET) {
//      return res.status(401).json({
 //       ok: false,
 //       error: "Unauthorized: Invalid CRON_SECRET",
//      });
//    }
 // }

  // ⬇️ Everything else in your file continues below here
  const t0 = Date.now();

  const BASE = "https://gazellesports.com";
  const MENS = "https://gazellesports.com/collections/mens-sale-shoes";
  const WOMENS = "https://gazellesports.com/collections/womens-sale-shoes";

  const out = {
    store: "Gazelle Sports",
    schemaVersion: 1,
    lastUpdated: nowIso(),
    via: "cheerio",
    sourceUrls: [],
    pagesFetched: 0,
    dealsFound: 0,
    dealsExtracted: 0,
    scrapeDurationMs: 0,
    ok: false,
    error: null,
    deals: [],
    // helpful debug summary
    dropCounts: {},
    blobUrl: null,
  };

  try {
    const mens = await scrapeCollection(BASE, MENS);
    const womens = await scrapeCollection(BASE, WOMENS);

    out.sourceUrls = [...mens.sourceUrls, ...womens.sourceUrls];
    out.pagesFetched = mens.pagesFetched + womens.pagesFetched;
    out.dealsFound = mens.dealsFound + womens.dealsFound;
    out.dealsExtracted = mens.dealsExtracted + womens.dealsExtracted;

    out.dropCounts = {
      mens: mens.dropCounts,
      womens: womens.dropCounts,
      total: {
        totalTiles: mens.dropCounts.totalTiles + womens.dropCounts.totalTiles,
        dropped_soccer: mens.dropCounts.dropped_soccer + womens.dropCounts.dropped_soccer,
        dropped_missingCore: mens.dropCounts.dropped_missingCore + womens.dropCounts.dropped_missingCore,
        dropped_missingPrices: mens.dropCounts.dropped_missingPrices + womens.dropCounts.dropped_missingPrices,
        dropped_badPrices: mens.dropCounts.dropped_badPrices + womens.dropCounts.dropped_badPrices,
        dropped_notADeal: mens.dropCounts.dropped_notADeal + womens.dropCounts.dropped_notADeal,
        kept: mens.dropCounts.kept + womens.dropCounts.kept,
      },
    };

    out.deals = [...mens.deals, ...womens.deals];

// -----------------------------
// BLOB WRITE (env-driven path)
// -----------------------------
const blobUrl = String(process.env.GAZELLESPORTS_DEALS_BLOB_URL || "").trim();
if (!blobUrl) {
  throw new Error("Missing GAZELLESPORTS_DEALS_BLOB_URL env var");
}

// Extract just the pathname from the full public URL
// e.g. https://...public.blob.vercel-storage.com/gazelle-sports.json
// -> "gazelle-sports.json"
const blobPath = blobUrl.split(".com/")[1];
if (!blobPath) {
  throw new Error("Invalid GAZELLESPORTS_DEALS_BLOB_URL format");
}

const putRes = await put(blobPath, JSON.stringify(out, null, 2), {
  access: "public",
  contentType: "application/json",
  addRandomSuffix: false,
});

out.blobUrl = blobUrl;

    out.ok = true;
    out.error = null;
  } catch (e) {
    out.ok = false;
    out.error = e?.message || String(e);
  } finally {
    out.scrapeDurationMs = Date.now() - t0;
  }

  res.status(out.ok ? 200 : 500).json(out);
};
