// api/scrapers/als-sale.js
// Scrapes ALS Men's + Women's running shoes (all pages)
// ASICS-style output ONLY — no pageResults, no tileCount, no diagnostics
//
// STRICT RULES:
// - Must have exactly ONE original price + ONE sale price
// - Skip price ranges
// - Skip if missing sale price
// - Original price = higher of the two
// - Sale price = lower of the two
//
// Output schema (10 fields):
// { title, brand, model, salePrice, price, store, url, image, gender, shoeType }
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  if (!text || text.includes("-")) return null;
  const m = text.replace(/,/g, "").match(/\$([\d]+(?:\.\d{2})?)/);
  return m ? parseFloat(m[1]) : null;
}

function extractTwoPricesStrict($el) {
  const text = $el.text().replace(/\s+/g, " ").trim();

  if (/\$\s*\d+(\.\d{2})?\s*-\s*\$\s*\d+(\.\d{2})?/.test(text)) {
    return null;
  }

  const matches = text.match(/\$\s*\d+(\.\d{2})?/g) || [];
  const prices = [...new Set(matches.map(parsePrice).filter(Boolean))];

  if (prices.length !== 2) return null;

  const hi = Math.max(...prices);
  const lo = Math.min(...prices);

  if (lo >= hi) return null;

  return { price: hi, salePrice: lo };
}

function cleanTitle(t) {
  return (t || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function splitBrandModel(title) {
  const t = cleanTitle(title);
  if (!t) return {};
  const brand = t.split(" ")[0];
  let model = t.replace(new RegExp("^" + brand + "\\s+", "i"), "").trim();
  model = model.replace(/\s+-\s+(men's|women's)\s*$/i, "").trim();
  return { brand, model };
}

function detectShoeType(title) {
  const t = title.toLowerCase();
  if (t.includes("trail")) return "trail";
  if (t.includes("track") || t.includes("spike")) return "track";
  return "road";
}

function extractDeals(html, gender) {
  const $ = cheerio.load(html);
  const deals = [];

  const links = $('a[href$="/p"]').filter((_, a) => {
    const text = cleanTitle($(a).text());
    return text.length >= 5;
  });

  links.each((_, a) => {
    const $a = $(a);
    const title = cleanTitle($a.text());
    const url = absolutize($a.attr("href"));
    if (!title || !url) return;

    let $card = $a.closest('div[class*="product"], li[class*="product"], article');
    if (!$card.length) $card = $a.parent();

    const priceData = extractTwoPricesStrict($card);
    if (!priceData) return;

    const image = absolutize(
      $card.find("img").first().attr("src") ||
      $card.find("img").first().attr("data-src")
    );

    const { brand, model } = splitBrandModel(title);
    if (!brand || !model) return;

    deals.push({
      title,
      brand,
      model,
      salePrice: priceData.salePrice,
      price: priceData.price,
      store: STORE,
      url,
      image: image || null,
      gender,
      shoeType: detectShoeType(title),
    });
  });

  // dedupe by URL
  const seen = new Set();
  return deals.filter(d => {
    if (seen.has(d.url)) return false;
    seen.add(d.url);
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
    const deals = extractDeals(html, gender);

    let added = 0;
    for (const d of deals) {
      if (!seen.has(d.url)) {
        seen.add(d.url);
        all.push(d);
        added++;
      }
    }

    if (added === 0) break;
    await sleep(800);
  }

  return all;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  //TEMPORARY COMMENTED OUT FOR DEBUGGING
  //const cronSecret = process.env.CRON_SECRET;
  //if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
  //  return res.status(401).json({ error: "Unauthorized" });
  //}

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
      error: err.message,
    });
  }
};
