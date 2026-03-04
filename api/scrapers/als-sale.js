// api/scrapers/als-sale.js
// Scrapes ALS Men's + Women's running shoes (all pages)
//
// Output schema (canonical 11 fields in deals[]):
// { listingName, brand, model, salePrice, originalPrice, discountPercent,
//   store, listingURL, imageURL, gender, shoeType }
//
// STRICT RULES:
// - Must have exactly ONE original price + ONE sale price
// - Skip price ranges
// - Skip if missing sale price
// - originalPrice = higher of the two
// - salePrice = lower of the two
//
// Blob: als-sale.json (stable)

const axios = require("axios");
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "ALS";
const BASE = "https://www.als.com";

const MEN_URL =
  "https://www.als.com/footwear/men-s-footwear/men-s-running-shoes?filter.category-1=footwear&filter.category-2=men-s-footwear&filter.category-3=men-s-running-shoes&sort=discount%3Adesc";
const WOMEN_URL =
  "https://www.als.com/footwear/women-s-footwear/women-s-running-shoes?filter.category-1=footwear&filter.category-2=women-s-footwear&filter.category-3=women-s-running-shoes&sort=discount%3Adesc";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** -------------------- helpers -------------------- **/

function nowIso() {
  return new Date().toISOString();
}

function absolutize(url) {
  if (!url || typeof url !== "string") return null;
  url = url.replace(/&amp;/g, "&").trim();
  if (!url || url.startsWith("data:")) return null;
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${BASE}${url}`;
  return `${BASE}/${url}`;
}

function parsePrice(text) {
  if (!text) return null;
  const m = String(text).replace(/,/g, "").match(/\$([\d]+(?:\.\d{2})?)/);
  return m ? parseFloat(m[1]) : null;
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

function cleanTitle(t) {
  return (t || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Extract exactly 2 prices from a "card".
 * - reject explicit ranges like "$89.99 - $129.99"
 * - require exactly 2 unique prices
 */
function extractTwoPricesStrict($el) {
  const text = $el.text().replace(/\s+/g, " ").trim();

  // Explicit range like "$89.99 - $129.99"
  if (/\$\s*\d+(\.\d{2})?\s*-\s*\$\s*\d+(\.\d{2})?/.test(text)) return null;

  const matches = text.match(/\$\s*\d+(\.\d{2})?/g) || [];
  const prices = [...new Set(matches.map(parsePrice).filter(Boolean))];

  if (prices.length !== 2) return null;

  const hi = Math.max(...prices);
  const lo = Math.min(...prices);

  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  if (lo >= hi) return null;

  return { originalPrice: round2(hi), salePrice: round2(lo) };
}

function splitBrandModel(listingName) {
  const t = cleanTitle(listingName);
  if (!t) return { brand: "Unknown", model: "" };

  // Simple heuristic (ALS titles are usually "Brand Model ...")
  const brand = t.split(" ")[0] || "Unknown";
  let model = t.replace(new RegExp("^" + brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+", "i"), "").trim();

  // strip trailing gender markers in title if any
  model = model.replace(/\s+-\s+(men's|women's)\s*$/i, "").trim();

  return { brand, model: model || "" };
}

function detectShoeType(listingName) {
  const t = String(listingName || "").toLowerCase();
  if (t.includes("trail")) return "trail";
  if (t.includes("track") || t.includes("spike")) return "track";
  return "road";
}

/** -------------------- extraction -------------------- **/

function extractDeals(html, gender) {
  const $ = cheerio.load(html);
  const deals = [];

  // ALS commonly links product cards with href ending in "/p"
  const links = $('a[href$="/p"]').filter((_, a) => {
    const text = cleanTitle($(a).text());
    return text.length >= 5;
  });

  links.each((_, a) => {
    const $a = $(a);

    const listingName = cleanTitle($a.text());
    const listingURL = absolutize($a.attr("href"));
    if (!listingName || !listingURL) return;

    // Find a reasonable "card" root to look for prices/images
    let $card = $a.closest('div[class*="product"], li[class*="product"], article');
    if (!$card.length) $card = $a.parent();

    const priceData = extractTwoPricesStrict($card);
    if (!priceData) return;

    const imageURL = absolutize(
      $card.find("img").first().attr("src") || $card.find("img").first().attr("data-src")
    );

    const { brand, model } = splitBrandModel(listingName);
    if (!brand || brand === "Unknown" || !model) return;

    const discountPercent = computeDiscountPercent(priceData.originalPrice, priceData.salePrice);

    deals.push({
      listingName,
      brand,
      model,
      salePrice: priceData.salePrice,
      originalPrice: priceData.originalPrice,
      discountPercent,
      store: STORE,
      listingURL,
      imageURL: imageURL || null,
      gender,
      shoeType: detectShoeType(listingName),
    });
  });

  // Dedupe by listingURL within this page
  const seen = new Set();
  return deals.filter((d) => {
    if (!d.listingURL) return false;
    if (seen.has(d.listingURL)) return false;
    seen.add(d.listingURL);
    return true;
  });
}

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 45000,
  });
  return data;
}

async function scrapeCategory(baseUrl, gender) {
  const all = [];
  const seen = new Set();

  let pagesFetched = 0;
  let tilesFound = 0; // “dealsFound” equivalent: product links/cards encountered

  for (let page = 1; page <= 50; page++) {
    const url = `${baseUrl}&page=${page}`;
    const html = await fetchHtml(url);
    pagesFetched += 1;

    // count “tiles” as number of product links that look like products
    const $ = cheerio.load(html);
    const linkCount = $('a[href$="/p"]').filter((_, a) => cleanTitle($(a).text()).length >= 5).length;
    tilesFound += linkCount;

    const pageDeals = extractDeals(html, gender);

    let added = 0;
    for (const d of pageDeals) {
      if (d.listingURL && !seen.has(d.listingURL)) {
        seen.add(d.listingURL);
        all.push(d);
        added++;
      }
    }

    if (added === 0) break;
    await sleep(800);
  }

  return { deals: all, pagesFetched, tilesFound };
}

/** -------------------- auth (cron secret) -------------------- **/

function isAuthorized(req) {
  const CRON_SECRET = String(process.env.CRON_SECRET || "").trim();
  if (!CRON_SECRET) return true; // no secret set => open

  // Allow:
  // 1) Authorization: Bearer <secret>
  // 2) x-cron-secret: <secret>
  // 3) ?cron_secret=<secret>   ✅ browser-friendly (matches your Gazelle approach)
  const auth = String(req.headers.authorization || "").trim();
  const xCron = String(req.headers["x-cron-secret"] || "").trim();

  let qs = "";
  try {
    const urlObj = new URL(req.url, "http://localhost");
    qs = String(urlObj.searchParams.get("cron_secret") || "").trim();
  } catch {
    qs = "";
  }

  return auth === `Bearer ${CRON_SECRET}` || xCron === CRON_SECRET || qs === CRON_SECRET;
}

/** -------------------- handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized: Invalid CRON_SECRET" });
  }

  const t0 = Date.now();

  // canonical output scaffold
  const out = {
    store: STORE,
    schemaVersion: 1,

    lastUpdated: nowIso(),
    via: "cheerio",

    sourceUrls: [MEN_URL, WOMEN_URL],
    pagesFetched: 0,

    dealsFound: 0,      // tiles/cards encountered
    dealsExtracted: 0,  // deals kept

    scrapeDurationMs: 0,

    ok: false,
    error: null,

    deals: [],
  };

  try {
    const mens = await scrapeCategory(MEN_URL, "mens");
    await sleep(1200);
    const womens = await scrapeCategory(WOMEN_URL, "womens");

    const deals = [...mens.deals, ...womens.deals];

    out.pagesFetched = (mens.pagesFetched || 0) + (womens.pagesFetched || 0);
    out.dealsFound = (mens.tilesFound || 0) + (womens.tilesFound || 0);
    out.dealsExtracted = deals.length;

    out.deals = deals;

    out.ok = true;
    out.error = null;

    // duration + lastUpdated right before write (so blob includes final values)
    out.scrapeDurationMs = Date.now() - t0;
    out.lastUpdated = nowIso();

    const blob = await put("als-sale.json", JSON.stringify(out, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({
      ok: true,
      store: out.store,
      pagesFetched: out.pagesFetched,
      dealsFound: out.dealsFound,
      dealsExtracted: out.dealsExtracted,
      scrapeDurationMs: out.scrapeDurationMs,
      blobUrl: blob.url,
      lastUpdated: out.lastUpdated,
    });
  } catch (err) {
    out.ok = false;
    out.error = err?.stack || err?.message || String(err) || "Unknown error";
    out.scrapeDurationMs = Date.now() - t0;
    out.lastUpdated = nowIso();

    // On failure, we DO NOT write a blob (matches your general pattern).
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(500).json({
      ok: false,
      error: out.error,
      scrapeDurationMs: out.scrapeDurationMs,
      lastUpdated: out.lastUpdated,
    });
  }
};
