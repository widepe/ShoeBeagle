// api/scrapers/als-sale.js
const axios = require("axios");
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "ALS";
const BASE = "https://www.als.com";

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

function parseSinglePrice(text) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, " ").trim();
  if (t.includes("-")) return null; // range
  const m = t.replace(/,/g, "").match(/\$([\d]+(?:\.\d{2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Strict: accept ONLY exactly 2 distinct single prices (no ranges anywhere)
function extractTwoPricesStrict($container) {
  const text = $container.text().replace(/\s+/g, " ").trim();
  if (!text) return { price: null, salePrice: null, reason: "no_text" };

  // Range present => invalid
  if (/\$\s*\d+(?:\.\d{2})?\s*-\s*\$\s*\d+(?:\.\d{2})?/.test(text)) {
    return { price: null, salePrice: null, reason: "range" };
  }

  const matches = text.match(/\$\s*\d+(?:\.\d{2})?/g) || [];
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

  if (nums.length !== 2) {
    return {
      price: null,
      salePrice: null,
      reason: nums.length === 0 ? "no_prices" : nums.length === 1 ? "one_price" : "too_many_prices",
    };
  }

  const hi = Math.max(nums[0], nums[1]);
  const lo = Math.min(nums[0], nums[1]);
  if (!(lo < hi)) return { price: null, salePrice: null, reason: "not_a_sale" };

  return { price: hi, salePrice: lo, reason: null };
}

function detectShoeTypeFromTitle(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("trail")) return "trail";
  if (t.includes("track") || t.includes("spike")) return "track";
  return "road";
}

function cleanTitle(title) {
  return (title || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function splitBrandModel(title) {
  const t = cleanTitle(title);
  if (!t) return { brand: null, model: null };

  const brand = t.split(" ")[0];
  let model = t.replace(new RegExp("^" + brand + "\\s+", "i"), "").trim();
  model = model.replace(/\s+-\s+(men's|women's)\s*$/i, "").trim();
  return { brand, model: model || null };
}

/**
 * Returns:
 * - deals: valid deals
 * - tileCount: how many product links were found (for pagination stopping)
 * - skipStats: reasons we skipped
 */
function extractAlsDealsFromListing(html, gender) {
  const $ = cheerio.load(html);

  const skipStats = {
    range: 0,
    no_prices: 0,
    one_price: 0,
    too_many_prices: 0,
    not_a_sale: 0,
    missing_title_or_url: 0,
    missing_brand_or_model: 0,
  };

  // Product pages end with "/p" (observed on ALS product links)
  const $links = $('a[href$="/p"]').filter((_, a) => {
    const href = $(a).attr("href") || "";
    const text = cleanTitle($(a).text());
    if (!text || text.length < 5) return false;
    if (href.includes("help.als.com")) return false;
    return true;
  });

  const tileCount = $links.length;
  const deals = [];

  $links.each((_, a) => {
    const $a = $(a);
    const title = cleanTitle($a.text());
    const url = absolutizeAlsUrl($a.attr("href"));

    if (!title || !url) {
      skipStats.missing_title_or_url++;
      return;
    }

    // Card container heuristic
    let $card = $a.closest('div[class*="product"], li[class*="product"], article').first();
    if (!$card || !$card.length) $card = $a.parent();

    // Image
    let image =
      $card.find("img").first().attr("src") ||
      $card.find("img").first().attr("data-src") ||
      $card.find("img").first().attr("data-lazy-src") ||
      null;

    image = absolutizeAlsUrl(image);

    // Prices (strict)
    const { price, salePrice, reason } = extractTwoPricesStrict($card);
    if (!price || !salePrice) {
      if (reason && skipStats[reason] !== undefined) skipStats[reason]++;
      return;
    }

    const { brand, model } = splitBrandModel(title);
    if (!brand || !model) {
      skipStats.missing_brand_or_model++;
      return;
    }

    deals.push({
      title,
      brand,
      model,
      salePrice,
      price,
      store: STORE,
      url,
      image: image || null,
      gender,
      shoeType: detectShoeTypeFromTitle(title),
    });
  });

  // Dedup by URL
  const unique = [];
  const seen = new Set();
  for (const d of deals) {
    if (!d.url) continue;
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    unique.push(d);
  }

  return { deals: unique, tileCount, skipStats };
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
  return baseUrl.includes("?") ? `${baseUrl}&page=${page}` : `${baseUrl}?page=${page}`;
}

async function scrapeAlsCategoryAllPages(baseUrl, gender, description) {
  const pageResults = [];
  const allDeals = [];
  const seenUrls = new Set();

  const MAX_PAGES = 60; // still safe cap

  // Aggregate skip reasons across pages for debugging
  const skipTotals = {};

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = withPageParam(baseUrl, page);
    const pageStart = Date.now();

    try {
      const html = await fetchHtml(pageUrl);
      const { deals, tileCount, skipStats } = extractAlsDealsFromListing(html, gender);

      // merge skip stats
      for (const [k, v] of Object.entries(skipStats)) {
        skipTotals[k] = (skipTotals[k] || 0) + v;
      }

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
        tileCount, // NEW: how many product links existed (even if we skipped most)
        error: null,
        url: pageUrl,
        durationMs: duration,
      });

      // Stop when there are no tiles at all (true end), OR no new urls (loop/repeat)
      if (tileCount === 0 || newCount === 0) break;

      await sleep(800);
    } catch (err) {
      pageResults.push({
        page: `${description} (page=${page})`,
        success: false,
        count: 0,
        newCount: 0,
        tileCount: 0,
        error: err.message || String(err),
        url: pageUrl,
      });
      break;
    }
  }

  return { deals: allDeals, pageResults, skipTotals };
}

async function scrapeAllAlsSales() {
  const results = [];
  const allDeals = [];
  const skipByGender = { mens: {}, womens: {} };

  const men = await scrapeAlsCategoryAllPages(MEN_BASE_URL, "mens", "Men's Running Shoes");
  results.push(...men.pageResults);
  allDeals.push(...men.deals);
  skipByGender.mens = men.skipTotals;

  await sleep(1200);

  const women = await scrapeAlsCategoryAllPages(WOMEN_BASE_URL, "womens", "Women's Running Shoes");
  results.push(...women.pageResults);
  allDeals.push(...women.deals);
  skipByGender.womens = women.skipTotals;

  // Dedupe across categories
  const unique = [];
  const seen = new Set();
  for (const d of allDeals) {
    if (!d.url) continue;
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    unique.push(d);
  }

  return { deals: unique, pageResults: results, skipByGender };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const start = Date.now();

  try {
    const { deals, pageResults, skipByGender } = await scrapeAllAlsSales();

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
      // NEW: diagnostic so you can tell “why” strict filtering cut items
      skipStats: skipByGender,
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
      // (optional) include skipStats in response too, or remove if you want it only in blob
      skipStats: output.skipStats,
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
