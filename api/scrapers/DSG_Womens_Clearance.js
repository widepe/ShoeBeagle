// api/scrapers/DSG_Womens_Clearance.js
// Scrapes DICK'S women's clearance running footwear pages using Firecrawl + Cheerio
// Goal: extract product URL + title + prices + image URL as reliably as possible.

const FirecrawlApp = require("@mendable/firecrawl-js").default;
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

/**
 * Pick the best (usually largest) URL from a srcset string.
 * Example: "url1 200w, url2 800w" -> returns url2
 */
function pickBestFromSrcset(srcset) {
  if (!srcset || typeof srcset !== "string") return null;

  const candidates = srcset
    .split(",")
    .map((s) => s.trim())
    .map((entry) => entry.split(/\s+/)[0])
    .filter(Boolean);

  if (!candidates.length) return null;
  return candidates[candidates.length - 1];
}

/**
 * Absolutize DSG URLs (including protocol-relative).
 */
function absolutizeDsgUrl(url) {
  if (!url || typeof url !== "string") return null;

  url = url.replace(/&amp;/g, "&").trim();
  if (!url) return null;

  if (url.startsWith("data:")) return null;
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://www.dickssportinggoods.com${url}`;
  return `https://www.dickssportinggoods.com/${url}`;
}

/**
 * Extract all prices from a block of text.
 * Returns float[] like [54.97, 74.97, 144.99]
 */
function extractPrices(text) {
  if (!text) return [];
  const matches = String(text).match(/\$(\d+(?:\.\d{2})?)/g);
  if (!matches) return [];
  return matches
    .map((m) => parseFloat(m.replace("$", "")))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Decide price/originalPrice from a list of numbers.
 * - If 1 number: price = that
 * - If >=2: price = min, original = max (only if max > min)
 */
function decidePricePair(nums) {
  const values = (nums || []).filter((n) => Number.isFinite(n));
  if (!values.length) return { price: null, originalPrice: null };

  if (values.length === 1) {
    return { price: values[0], originalPrice: null };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);

  if (max > min) return { price: min, originalPrice: max };
  return { price: min, originalPrice: null };
}

/**
 * Extract products from DSG HTML.
 * Heuristic approach:
 *  - Find all anchors that look like product pages: a[href*="/p/"]
 *  - For each anchor, use a nearby container (closest common parent) as the "card"
 *  - Pull title, prices from card text, and image from picture/source/srcset or img/src/srcset
 */
function extractDsgProducts(html, sourceUrl) {
  const $ = cheerio.load(html);
  const products = [];

  // Collect product links (dedupe by absolute URL)
  const seen = new Set();

  // DSG product pages commonly contain "/p/" in the path.
  const $links = $('a[href*="/p/"]');

  console.log(`[DSP] Found ${$links.length} candidate product links on ${sourceUrl}`);

  $links.each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    const url = absolutizeDsgUrl(href);
    if (!url) return;

    if (seen.has(url)) return;
    seen.add(url);

    // Try to get a clean title:
    // 1) aria-label
    // 2) title attribute
    // 3) text content
    let title =
      ($a.attr("aria-label") || $a.attr("title") || $a.text() || "").trim();

    // Sometimes the link text is empty and the title sits nearby; expand to card.
    // Grab a nearby card-ish container. We try a few common wrappers, then fallback.
    let $card =
      $a.closest('[data-testid*="product"]') ||
      $a.closest("li") ||
      $a.closest("div");

    if (!$card || !$card.length) $card = $a.parent();

    const cardText = ($card.text() || "").replace(/\s+/g, " ").trim();

    if (!title || title.length < 3) {
      // Try to infer title from card text (often starts with brand + model)
      // Take the first ~80 chars before "add to cart" / "Compare" if present.
      let t = cardText;
      t = t.split(/add to cart/i)[0];
      t = t.split(/compare/i)[0];
      t = t.trim();
      if (t.length > 0) title = t.slice(0, 120).trim();
    }

    if (!title || title.length < 3) return;

    // Prices (handles "See Price In Cart $149.99" and ranges)
    const priceNums = extractPrices(cardText);
    const { price, originalPrice } = decidePricePair(priceNums);

    // Image extraction:
    //  - Prefer <picture><source srcset> (or data-srcset)
    //  - Then <img srcset> (or data-*)
    //  - Then <img src> (or data-*)
    let image = null;

    const sourceSrcset =
      $card.find("picture source[srcset]").first().attr("srcset") ||
      $card.find("picture source[data-srcset]").first().attr("data-srcset") ||
      null;

    image = pickBestFromSrcset(sourceSrcset);

    if (!image) {
      const $img = $card.find("img").first();
      const imgSrcset =
        $img.attr("srcset") ||
        $img.attr("data-srcset") ||
        $img.attr("data-lazy-srcset") ||
        $img.attr("data-srcset-full") ||
        null;
      image = pickBestFromSrcset(imgSrcset);
    }

    if (!image) {
      const $img = $card.find("img").first();
      image =
        $img.attr("src") ||
        $img.attr("data-src") ||
        $img.attr("data-lazy-src") ||
        $img.attr("data-original") ||
        null;
    }

    image = absolutizeDsgUrl(image);

    // Skip obvious placeholders / data URIs
    if (image && (image.startsWith("data:") || /placeholder/i.test(image))) {
      image = null;
    }

    // Compute discount if possible
    const discountPct =
      Number.isFinite(price) &&
      Number.isFinite(originalPrice) &&
      originalPrice > price
        ? Math.round(((originalPrice - price) / originalPrice) * 100)
        : null;

    // Basic brand/model attempt (optional, harmless)
    // Example: "Brooks Women's Ghost 17 Running Shoes"
    // brand = first token up to space (but titles like "New Balance & CALIA" exist)
    let brand = null;
    let model = null;

    const cleanedTitle = title.replace(/\s+/g, " ").trim();
    if (cleanedTitle) {
      // Try to capture brand up to "Women's" or "Men's" or "Unisex"
      const m = cleanedTitle.match(/^(.+?)\s+(Women'?s|Men'?s|Unisex)\s+/i);
      if (m) {
        brand = m[1].trim();
        model = cleanedTitle.replace(new RegExp(`^${m[1]}\\s+`, "i"), "").trim();
      } else {
        // fallback: first word as brand, remainder as model
        const parts = cleanedTitle.split(" ");
        brand = parts[0] || null;
        model = parts.slice(1).join(" ").trim() || null;
      }
    }

    products.push({
      title: cleanedTitle,
      brand: brand || null,
      model: model || null,
      store: "DICK'S Sporting Goods",
      gender: "Women",
      price: Number.isFinite(price) ? price : null,
      originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
      discount: discountPct != null ? `${discountPct}%` : null,
      url,
      image: image || null,
      scrapedAt: new Date().toISOString(),
    });
  });

  console.log(`[DSP] Extracted ${products.length} unique products from ${sourceUrl}`);
  return products;
}

/**
 * Scrape a single DSG URL using Firecrawl
 */
async function scrapeDsgUrl(app, url, description) {
  console.log(`[DSP] Scraping: ${description}`);
  console.log(`[DSP] Fetching: ${url}`);

  try {
    const scrapeResult = await app.scrapeUrl(url, {
      formats: ["html"],
      waitFor: 9000,
      timeout: 60000,
    });

    const html = scrapeResult && scrapeResult.html ? scrapeResult.html : "";
    if (!html) {
      return {
        success: false,
        products: [],
        count: 0,
        error: "No HTML returned by Firecrawl",
        url,
      };
    }

    const products = extractDsgProducts(html, url);

    return {
      success: true,
      products,
      count: products.length,
      url,
    };
  } catch (err) {
    console.error(`[DSP] Error scraping ${description}:`, err && err.message ? err.message : err);
    return {
      success: false,
      products: [],
      count: 0,
      error: err && err.message ? err.message : String(err),
      url,
    };
  }
}

/**
 * Main: scrape your provided pageSize URLs sequentially
 */
async function scrapeAllDspClearance() {
  const app = new FirecrawlApp({
    apiKey: process.env.FIRECRAWL_API_KEY,
  });

  const pages = [
    {
      url: "https://www.dickssportinggoods.com/f/clearance-womens-footwear?filterFacets=4285%253ARunning",
      description: "Clearance Women Running (default)",
    },
    {
      url: "https://www.dickssportinggoods.com/f/clearance-womens-footwear?filterFacets=4285%253ARunning&pageSize=96",
      description: "Clearance Women Running (pageSize=96)",
    },
    {
      url: "https://www.dickssportinggoods.com/f/clearance-womens-footwear?filterFacets=4285%253ARunning&pageSize=144",
      description: "Clearance Women Running (pageSize=144)",
    },
    {
      url: "https://www.dickssportinggoods.com/f/clearance-womens-footwear?filterFacets=4285%253ARunning&pageSize=192",
      description: "Clearance Women Running (pageSize=192)",
    },
  ];

  const pageResults = [];
  const allProducts = [];

  for (let i = 0; i < pages.length; i++) {
    const { url, description } = pages[i];

    const r = await scrapeDsgUrl(app, url, description);
    pageResults.push({
      page: description,
      success: r.success,
      count: r.count,
      error: r.error || null,
      url: r.url,
    });

    if (r.success && Array.isArray(r.products)) {
      allProducts.push(...r.products);
    }

    if (i < pages.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // Deduplicate by URL
  const seenUrls = new Set();
  const unique = [];
  for (const p of allProducts) {
    const key = p && p.url ? p.url : null;
    if (!key) {
      unique.push(p);
      continue;
    }
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    unique.push(p);
  }

  console.log(`[DSP] Total unique products across pages: ${unique.length}`);
  return { products: unique, pageResults };
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
    const { products: deals, pageResults } = await scrapeAllDspClearance();

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "DICK'S Sporting Goods",
      segment: "Clearance Women's Running Footwear",
      totalDeals: deals.length,
      pageResults,
      deals,
    };

    const blob = await put("dsp-clearance.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;

    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      pageResults,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (err) {
    console.error("[DSP] Fatal error:", err);
    return res.status(500).json({
      success: false,
      error: err && err.message ? err.message : String(err),
      duration: `${Date.now() - start}ms`,
    });
  }
};
