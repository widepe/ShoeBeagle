// api/scrapers/als-sale.js
// Scrapes ALS Men's + Women's running shoes pages (all pages) using axios+cheerio
// STRICT RULES:
// - Only include products with exactly ONE original price and ONE sale price (no ranges)
// - If either price is missing OR contains a range like "$81.99 - $131.99" => SKIP
// - Original price = higher of the two, sale price = lower of the two
//
// Outputs 10-field schema per deal:
// { title, brand, model, salePrice, price, store, url, image, gender, shoeType }
//
// Saves blob: als-sale.json (public, stable name)

const axios = require("axios");
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "ALS";
const BASE = "https://www.als.com";

// Your category URLs (page param added by scraper)
const MEN_BASE_URL =
  "https://www.als.com/footwear/men-s-footwear/men-s-running-shoes?filter.category-1=footwear&filter.category-2=men-s-footwear&filter.category-3=men-s-running-shoes&sort=discount%3Adesc";
const WOMEN_BASE_URL =
  "https://www.als.com/footwear/women-s-footwear/women-s-running-shoes?filter.category-1=footwear&filter.category-2=women-s-footwear&filter.category-3=women-s-running-shoes&sort=discount%3Adesc";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function absolutizeAlsUrl(url) {
  if (!url || typeof url !== "string") return null;
  url = url.replace(/&amp;/g, "&").trim();
  if (!url) return null;
  if (url.startsWith("data:")) return null;
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${BASE}${url}`;
  return `${BASE}/${url}`;
}

// Returns null if range or not parseable
function parseSinglePrice(text) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, " ").trim();

  // skip ranges like "$80.00 - $85.00"
  if (t.includes("-")) return null;

  const m = t.replace(/,/g, "").match(/\$([\d]+(?:\.\d{2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Collect ALL dollar amounts in a container's text.
// If ANY range is present, treat as invalid.
function extractTwoPricesStrict($container) {
  const text = $container.text().replace(/\s+/g, " ").trim();
  if (!text) return { price: null, salePrice: null };

  // If the container text includes a range pattern, bail early.
  // Examples seen on ALS listing: "$81.99 - $131.99" or "$80.00 - $85.00"
  if (/\$\s*\d+(?:\.\d{2})?\s*-\s*\$\s*\d+(?:\.\d{2})?/.test(text)) {
    return { price: null, salePrice: null };
  }

  const matches = text.match(/\$\s*\d+(?:\.\d{2})?/g) || [];
  // Normalize and unique while preserving order
  const seen = new Set();
  const nums = [];
  for (const raw of matches) {
    const n = parseSinglePrice(raw);
    if (n == null) continue;
    const key = String(n);
    if (seen.has(key)) continue;
    seen.add(key);
    nums.push(n);
  }

  // We ONLY accept exactly 2 distinct single prices
  if (nums.length !== 2) return { price: null, salePrice: null };

  const hi = Math.max(nums[0], nums[1]);
  const lo = Math.min(nums[0], nums[1]);

  // Must actually be a sale
  if (!(lo < hi)) return { price: null, salePrice: null };

  return { price: hi, salePrice: lo };
}

function detectShoeTypeFromTitle(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("trail")) return "trail";
  if (t.includes("road")) return "road";
  if (t.includes("track") || t.includes("spike")) return "track";
  // default for these categories
  return "road";
}

function cleanTitle(title) {
  return (title || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function splitBrandModel(title) {
  const t = cleanTitle(title);
  if (!t) return { brand: null, model: null };

  // brand = first token (works well for Nike, Brooks, adidas, etc.)
  const brand = t.split(" ")[0];

  // model = remove brand + remove trailing gender chunk
  // Titles commonly end with " - Men's" or " - Women's"
  let model = t.replace(new RegExp("^" + brand + "\\s+", "i"), "").trim();
  model = model.replace(/\s+-\s+(men's|women's)\s*$/i, "").trim();

  return { brand, model: model || null };
}

/**
 * Extract deals from one ALS listing page HTML.
 * Uses heuristic: product cards are anchors ending in "/p" (product pages).
 * We take the nearest likely container and then extract:
 * - title: link text
 * - url: href
 * - image: first img within container
 * - prices: strict 2-price extraction (no ranges)
 */
function extractAlsDealsFromListing(html, gender) {
  const $ = cheerio.load(html);
  const deals = [];

  // Candidate product links look like: /some-product-slug-12345/p
  // (Seen in clicks: https://www.als.com/.../p) :contentReference[oaicite:1]{index=1}
  const $links = $('a[href$="/p"]').filter((_, a) => {
    const href = $(a).attr("href") || "";
    // exclude weird anchors without text
    const text = cleanTitle($(a).text());
    if (!text || text.length < 5) return false;
    // exclude obvious nav/footer junk
    if (href.includes("help.als.com")) return false;
    return true;
  });

  $links.each((_, a) => {
    const $a = $(a);
    const title = cleanTitle($a.text());
    const url = absolutizeAlsUrl($a.attr("href"));

    if (!title || !url) return;

    // Find a "card-like" container around this link
    // We try a few common container shapes
    let $card =
      $a.closest('div[class*="product"], li[class*="product"], article').first();

    if (!$card || !$card.length) $card = $a.parent();

    // Image: first <img> inside the card
    let image =
      $card.find("img").first().attr("src") ||
      $card.find("img").first().attr("data-src") ||
      $card.find("img").first().attr("data-lazy-src") ||
      null;

    image = absolutizeAlsUrl(image);

    // Prices: STRICT extraction from card text (and skip if range or not exactly 2)
    const { price, salePrice } = extractTwoPricesStrict($card);
    if (!price || !salePrice) return;

    const { brand, model } = splitBrandModel(title);
    if (!brand || !model) return;

    deals.push({
      title,
      brand,
      model,
      salePrice,
      price,
      store: STORE,
      url,
      image: image || null,
      gender, // "mens" or "womens"
      shoeType: detectShoeTypeFromTitle(title),
    });
  });

  // Deduplicate by URL (listing pages can repeat links due to nested anchors)
  const unique = [];
  const seen = new Set();
  for (const d of deals) {
    if (!d.url) continue;
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    unique.push(d);
  }

  return unique;
}

async function fetchHtml(url) {
  const resp = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    timeout: 45000,
  });
  return resp.data;
}

function withPageParam(baseUrl, page) {
  // baseUrl already has query params; add &page=N (or ?page= if none)
  if (baseUrl.includes("?")) return `${baseUrl}&page=${page}`;
  return `${baseUrl}?page=${page}`;
}

async function scrapeAlsCategoryAllPages(baseUrl, gender, description) {
  const pageResults = [];
  const allDeals = [];
  const seenUrls = new Set();

  // Hard safety cap
  const MAX_PAGES = 40;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = withPageParam(baseUrl, page);
    const pageStart = Date.now();

    try {
      const html = await fetchHtml(pageUrl);
      const deals = extractAlsDealsFromListing(html, gender);

      // Add only new URLs
      let newCount = 0;
      for (const d of deals) {
        if (d.url && !seenUrls.has(d.url)) {
          seenUrls.add(d.url);
          allDeals.push(d);
          newCount++;
        }
      }

      const duration = Date.now() - pageStart;

      pageResults.push({
        page: `${description} (page=${page})`,
        success: true,
        count: deals.length,
        newCount,
        error: null,
        url: pageUrl,
        durationMs: duration,
      });

      // Stop conditions:
      // - If this page had zero valid deals (given strict filters), it might still have items,
      //   but in practice it usually means we're past the end.
      // - Also stop if we got 0 NEW items (we're looping/repeating)
      if (deals.length === 0 || newCount === 0) {
        break;
      }

      // Small delay to be polite / reduce chance of blocking
      await sleep(800);
    } catch (err) {
      pageResults.push({
        page: `${description} (page=${page})`,
        success: false,
        count: 0,
        newCount: 0,
        error: err.message || String(err),
        url: pageUrl,
      });
      // On error, stop this category (don’t hammer)
      break;
    }
  }

  return { deals: allDeals, pageResults };
}

async function scrapeAllAlsSales() {
  const results = [];
  const allDeals = [];

  // Men
  const men = await scrapeAlsCategoryAllPages(
    MEN_BASE_URL,
    "mens",
    "Men's Running Shoes"
  );
  results.push(...men.pageResults);
  allDeals.push(...men.deals);

  // Women (small pause between categories)
  await sleep(1200);

  const women = await scrapeAlsCategoryAllPages(
    WOMEN_BASE_URL,
    "womens",
    "Women's Running Shoes"
  );
  results.push(...women.pageResults);
  allDeals.push(...women.deals);

  // Final dedupe by URL across both categories
  const unique = [];
  const seen = new Set();
  for (const d of allDeals) {
    if (!d.url) continue;
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    unique.push(d);
  }

  return { deals: unique, pageResults: results };
}

/**
 * Vercel handler
 */
module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const start = Date.now();

  try {
    const { deals, pageResults } = await scrapeAllAlsSales();

    const output = {
      lastUpdated: new Date().toISOString(),
      store: STORE,
      segments: ["Men's Running Shoes", "Women's Running Shoes"],
      totalDeals: deals.length,
      dealsByGender: {
        mens: deals.filter((d) => d.gender === "mens").length,
        womens: deals.filter((d) => d.gender === "womens").length,
        unisex: deals.filter((d) => d.gender === "unisex").length,
      },
      pageResults,
      deals,
    };

    const blob = await put("als-sale.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;

    return res.status(200).json({
      success: true,
      totalDeals: output.totalDeals,
      dealsByGender: output.dealsByGender,
      pageResults,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (error) {
    console.error("[ALS] Fatal error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`,
    });
  }
};
