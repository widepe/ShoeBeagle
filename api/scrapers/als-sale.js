// api/scrapers/als-sale.js
// Scrapes ALS Men's + Women's running shoes (all pages)
//
// Output schema (11 fields) — MATCHES BROOKS:
// { listing, brand, model, salePrice, originalPrice, discountPercent,
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

/** -------------------- small helpers -------------------- **/

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
  if (!text || text.includes("-")) return null; // ranges excluded
  const m = text.replace(/,/g, "").match(/\$([\d]+(?:\.\d{2})?)/);
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

function cleanTitle(t) {
  return (t || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function splitBrandModel(listing) {
  const t = cleanTitle(listing);
  if (!t) return {};
  const brand = t.split(" ")[0];
  let model = t.replace(new RegExp("^" + brand + "\\s+", "i"), "").trim();
  model = model.replace(/\s+-\s+(men's|women's)\s*$/i, "").trim();
  return { brand, model };
}

function detectShoeType(listing) {
  const t = String(listing || "").toLowerCase();
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

    const listing = cleanTitle($a.text());
    const listingURL = absolutize($a.attr("href"));
    if (!listing || !listingURL) return;

    // Find a reasonable "card" root to look for prices/images
    let $card = $a.closest('div[class*="product"], li[class*="product"], article');
    if (!$card.length) $card = $a.parent();

    const priceData = extractTwoPricesStrict($card);
    if (!priceData) return; // must have exactly 2 prices

    const imageURL = absolutize(
      $card.find("img").first().attr("src") ||
        $card.find("img").first().attr("data-src")
    );

    const { brand, model } = splitBrandModel(listing);
    if (!brand || !model) return;

    const discountPercent = computeDiscountPercent(
      priceData.originalPrice,
      priceData.salePrice
    );

    deals.push({
      listing,
      brand,
      model,
      salePrice: priceData.salePrice,
      originalPrice: priceData.originalPrice,
      discountPercent,
      store: STORE,
      listingURL,
      imageURL: imageURL || null,
      gender,
      shoeType: detectShoeType(listing),
    });
  });

  // Dedupe by listingURL
  const seen = new Set();
  return deals.filter((d) => {
    if (seen.has(d.listingURL)) return false;
    seen.add(d.listingURL);
    return true;
  });
}

async function fetch(url) {
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 45000,
  });
  return data;
}

async function scrapeCategory(baseUrl, gender) {
  const all = [];
  const seen = new Set();

  for (let page = 1; page <= 50; page++) {
    const url = `${baseUrl}&page=${page}`;
    const html = await fetch(url);

    const pageDeals = extractDeals(html, gender);

    let added = 0;
    for (const d of pageDeals) {
      if (!seen.has(d.listingURL)) {
        seen.add(d.listingURL);
        all.push(d);
        added++;
      }
    }

    if (added === 0) break;
    await sleep(800);
  }

  return all;
}

/** -------------------- handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Uncomment when ready:
  // const cronSecret = process.env.CRON_SECRET;
  // if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
  //   return res.status(401).json({ error: "Unauthorized" });
  // }

  const start = Date.now();

  try {
    const mens = await scrapeCategory(MEN_URL, "mens");
    await sleep(1200);
    const womens = await scrapeCategory(WOMEN_URL, "womens");

    const deals = [...mens, ...womens];

    const output = {
      lastUpdated: new Date().toISOString(),
      store: STORE,
      segments: ["Men's Running Shoes", "Women's Running Shoes"],
      totalDeals: deals.length,
      dealsByGender: {
        mens: mens.length,
        womens: womens.length,
        unisex: 0,
      },
      deals,
    };

    const blob = await put("als-sale.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      totalDeals: output.totalDeals,
      dealsByGender: output.dealsByGender,
      blobUrl: blob.url,
      duration: `${Date.now() - start}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err?.message || "Unknown error",
      duration: `${Date.now() - start}ms`,
      stack: process.env.NODE_ENV === "development" ? err?.stack : undefined,
    });
  }
};
