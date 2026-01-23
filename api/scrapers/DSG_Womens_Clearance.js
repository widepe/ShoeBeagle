// api/scrapers/DSG_Womens_Clearance.js
// Dick's Sporting Goods — Women's Clearance Running
// Uses Firecrawl to fetch HTML, then extracts products primarily from embedded JSON,
// with a DOM fallback. Outputs to Vercel Blob as dsg-womens-clearance.json

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
    .map((entry) => entry.split(/\s+/)[0]) // URL part
    .filter(Boolean);

  if (!candidates.length) return null;
  return candidates[candidates.length - 1];
}

/**
 * Convert DSG-ish URLs to absolute https URLs.
 */
function absolutizeDsgUrl(url) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("data:")) return null;

  // handle HTML entities if present
  url = url.replace(/&amp;/g, "&").trim();

  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://www.dickssportinggoods.com${url}`;
  return `https://www.dickssportinggoods.com/${url}`;
}

/**
 * Recursively walk a JSON node and collect product-like objects.
 * This is heuristic-based because DSG/Next.js state shapes can vary.
 */
function findProductLikeObjects(node, out) {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const v of node) findProductLikeObjects(v, out);
    return;
  }

  if (typeof node !== "object") return;

  const name =
    node.name ||
    node.productName ||
    node.title ||
    node.displayName ||
    node.shortDescription ||
    null;

  const url =
    node.url ||
    node.seoUrl ||
    node.pdpUrl ||
    node.productUrl ||
    node.productPageUrl ||
    null;

  const hasSomePrice =
    node.price != null ||
    node.salePrice != null ||
    node.currentPrice != null ||
    node.minPrice != null ||
    node.maxPrice != null ||
    node.listPrice != null ||
    node.originalPrice != null ||
    node.msrp != null ||
    node.wasPrice != null;

  if (typeof name === "string" && typeof url === "string" && hasSomePrice) {
    out.push(node);
  }

  for (const k of Object.keys(node)) {
    findProductLikeObjects(node[k], out);
  }
}

/**
 * Very simple brand/model split.
 * If you later want to improve it, do it centrally here.
 */
function normalizeBrandModel(title) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  if (!t) return { brand: "", model: "" };
  const parts = t.split(" ");
  const brand = parts[0] || "";
  const model = parts.slice(1).join(" ").trim();
  return { brand, model };
}

function computeDiscount(originalPrice, price) {
  if (
    Number.isFinite(originalPrice) &&
    Number.isFinite(price) &&
    originalPrice > 0 &&
    price < originalPrice
  ) {
    return `${Math.round(((originalPrice - price) / originalPrice) * 100)}%`;
  }
  return null;
}

/**
 * Extract products from DSG HTML.
 * Strategy:
 *  1) Detect bot/interstitial HTML and bail early (returns empty list).
 *  2) Try to parse embedded JSON from scripts and find product-like objects.
 *  3) Fallback: broad DOM scrape of PDP-ish anchors and nearby price/img.
 */
function extractDsgProducts(html, sourceUrl, gender = "Women") {
  const products = [];
  const lower = String(html || "").toLowerCase();

  const looksBlocked =
    lower.includes("verify you are human") ||
    lower.includes("access denied") ||
    lower.includes("captcha") ||
    lower.includes("akamai") ||
    lower.includes("bot") ||
    lower.includes("incident id") ||
    lower.includes("request blocked") ||
    lower.includes("your request has been blocked");

  if (looksBlocked) {
    console.log("[DSG] Looks like bot/interstitial page, not product HTML:", sourceUrl);
    return products;
  }

  const $ = cheerio.load(html);

  // -----------------------------------------
  // 1) Embedded JSON extraction (preferred)
  // -----------------------------------------
  try {
    const jsonCandidates = [];

    $("script").each((_, el) => {
      const type = ($(el).attr("type") || "").toLowerCase();
      const id = ($(el).attr("id") || "").toLowerCase();
      const txt = $(el).html();

      if (!txt || txt.length < 200) return;

      // likely state containers
      if (
        type.includes("application/json") ||
        type.includes("application/ld+json") ||
        id.includes("next_data") ||
        txt.includes("__NEXT_DATA__") ||
        txt.includes("window.__INITIAL_STATE__") ||
        txt.includes("initialState") ||
        txt.includes("apolloState")
      ) {
        jsonCandidates.push(txt.trim());
      }
    });

    const productLike = [];
    for (const raw of jsonCandidates) {
      let jsonText = raw;

      // If it's JS assignment, attempt to slice to JSON object bounds
      const firstBrace = jsonText.indexOf("{");
      const lastBrace = jsonText.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonText = jsonText.slice(firstBrace, lastBrace + 1);
      }

      try {
        const parsed = JSON.parse(jsonText);
        findProductLikeObjects(parsed, productLike);
      } catch {
        // ignore parse failures
      }
    }

    // Build deals from product-like objects
    const seen = new Set();
    for (const p of productLike) {
      const name =
        p.name || p.productName || p.title || p.displayName || p.shortDescription || "";
      const rawUrl =
        p.url || p.seoUrl || p.pdpUrl || p.productUrl || p.productPageUrl || "";

      if (!name || !rawUrl) continue;

      const key = `${String(name).trim()}::${String(rawUrl).trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const absUrl = absolutizeDsgUrl(rawUrl);

      // prices (try common fields)
      const saleCandidate = p.salePrice ?? p.currentPrice ?? p.price ?? p.minPrice ?? null;
      const origCandidate = p.originalPrice ?? p.listPrice ?? p.msrp ?? p.wasPrice ?? null;

      const saleNum = Number(saleCandidate);
      const origNum = Number(origCandidate);

      let price = Number.isFinite(saleNum) ? saleNum : null;
      let originalPrice = Number.isFinite(origNum) ? origNum : null;

      if (price && originalPrice && price > originalPrice) {
        [price, originalPrice] = [originalPrice, price];
      }

      // image fields (varies)
      let image =
        p.imageUrl ||
        p.image ||
        p.primaryImageUrl ||
        p.thumbnailUrl ||
        p.heroImageUrl ||
        null;

      image = absolutizeDsgUrl(image);

      const { brand, model } = normalizeBrandModel(name);

      products.push({
        title: String(name).replace(/\s+/g, " ").trim(),
        brand: brand || null,
        model: model || null,
        store: "Dick's Sporting Goods",
        gender,
        price,
        originalPrice,
        discount: computeDiscount(originalPrice, price),
        url: absUrl,
        image,
        scrapedAt: new Date().toISOString(),
      });
    }

    if (products.length) {
      console.log(`[DSG] Extracted ${products.length} products from embedded JSON.`);
      // de-dupe by url
      const uniq = [];
      const seenUrl = new Set();
      for (const p of products) {
        if (!p.url) continue;
        if (seenUrl.has(p.url)) continue;
        seenUrl.add(p.url);
        uniq.push(p);
      }
      return uniq;
    }
  } catch (e) {
    console.error("[DSG] Embedded JSON parse error:", e.message);
  }

  // -----------------------------------------
  // 2) DOM fallback extraction
  // -----------------------------------------
  try {
    // Try to find PDP-like anchors
    const $links = $('a[href*="/p/"], a[href*="/product/"], a[href*="/products/"]');
    console.log(`[DSG] DOM fallback link candidates: ${$links.length}`);

    $links.each((_, a) => {
      const $a = $(a);
      const href = $a.attr("href");
      if (!href) return;

      const absUrl = absolutizeDsgUrl(href);

      // find a nearby container that likely holds title/price/img
      const $card = $a.closest("li, article, [data-testid], div");

      const cardText = $card.text().replace(/\s+/g, " ").trim();

      // title guess
      const title =
        ($a.attr("aria-label") || $a.attr("title") || "").trim() ||
        ($card.find("[aria-label]").first().attr("aria-label") || "").trim() ||
        ($card.find("h2,h3,h4").first().text() || "").replace(/\s+/g, " ").trim() ||
        "";

      if (!title || title.length < 6) return;

      // price guess: take last $ as sale, first $ as original (common but not guaranteed)
      const matches = cardText.match(/\$(\d+(?:\.\d{2})?)/g);
      let price = null;
      let originalPrice = null;

      if (matches && matches.length >= 1) {
        price = Number(matches[matches.length - 1].replace("$", ""));
      }
      if (matches && matches.length >= 2) {
        originalPrice = Number(matches[0].replace("$", ""));
      }

      if (price && originalPrice && price > originalPrice) {
        [price, originalPrice] = [originalPrice, price];
      }

      // image
      const $img = $card.find("img").first();
      let image =
        $img.attr("src") ||
        pickBestFromSrcset($img.attr("srcset")) ||
        $img.attr("data-src") ||
        pickBestFromSrcset($img.attr("data-srcset")) ||
        null;

      image = absolutizeDsgUrl(image);

      const { brand, model } = normalizeBrandModel(title);

      products.push({
        title: String(title).replace(/\s+/g, " ").trim(),
        brand: brand || null,
        model: model || null,
        store: "Dick's Sporting Goods",
        gender,
        price: Number.isFinite(price) ? price : null,
        originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
        discount: computeDiscount(
          Number.isFinite(originalPrice) ? originalPrice : null,
          Number.isFinite(price) ? price : null
        ),
        url: absUrl,
        image,
        scrapedAt: new Date().toISOString(),
      });
    });

    // de-dupe by url
    const uniq = [];
    const seenUrl = new Set();
    for (const p of products) {
      if (!p.url) continue;
      if (seenUrl.has(p.url)) continue;
      seenUrl.add(p.url);
      uniq.push(p);
    }

    console.log(`[DSG] DOM fallback extracted ${uniq.length} products.`);
    return uniq;
  } catch (e) {
    console.error("[DSG] DOM fallback error:", e.message);
    return [];
  }
}

/**
 * Scrape a single DSG URL via Firecrawl
 */
async function scrapeDsgUrl(app, url, description, gender = "Women") {
  console.log(`[DSG] Scraping ${description}...`);
  try {
    const scrapeResult = await app.scrapeUrl(url, {
      formats: ["html"],
      waitFor: 8000,
      timeout: 60000,
    });

    // Minimal diagnostic: first chars of HTML (useful to detect interstitials)
    const head = String(scrapeResult.html || "").slice(0, 220).replace(/\s+/g, " ");
    console.log(`[DSG] HTML head (${description}):`, head);

    const products = extractDsgProducts(scrapeResult.html, url, gender);

    console.log(`[DSG] ${description}: Found ${products.length} products`);
    return { success: true, products, count: products.length, url };
  } catch (error) {
    console.error(`[DSG] Error scraping ${description}:`, error.message);
    return {
      success: false,
      products: [],
      count: 0,
      error: error.message,
      url,
    };
  }
}

/**
 * Main scraper - women clearance running
 * You can add mens later; start with these pageSize variants.
 */
async function scrapeAllDsgWomensClearance() {
  const app = new FirecrawlApp({
    apiKey: process.env.FIRECRAWL_API_KEY,
  });

  console.log("[DSG] Starting scrape: Women's Clearance Running...");

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

  const results = [];
  const allProducts = [];

  for (let i = 0; i < pages.length; i++) {
    const { url, description } = pages[i];

    console.log(`[DSG] Page ${i + 1}/${pages.length}: ${description}`);
    const result = await scrapeDsgUrl(app, url, description, "Women");

    results.push({
      page: description,
      success: result.success,
      count: result.count,
      error: result.error || null,
      url: result.url,
    });

    if (result.success) {
      allProducts.push(...result.products);
    }

    if (i < pages.length - 1) {
      console.log("[DSG] Waiting 2 seconds before next page...");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Deduplicate by URL
  const uniqueProducts = [];
  const seenUrls = new Set();

  for (const product of allProducts) {
    if (!product.url) continue;
    if (seenUrls.has(product.url)) continue;
    seenUrls.add(product.url);
    uniqueProducts.push(product);
  }

  console.log(`[DSG] Total unique products: ${uniqueProducts.length}`);
  return { products: uniqueProducts, pageResults: results };
}

/**
 * Vercel handler
 * GET only; optional CRON secret.
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
    const { products: deals, pageResults } = await scrapeAllDsgWomensClearance();

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "Dick's Sporting Goods",
      segment: "Women's Clearance Running",
      totalDeals: deals.length,
      pageResults,
      deals,
    };

    const blob = await put("dsg-womens-clearance.json", JSON.stringify(output, null, 2), {
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
  } catch (error) {
    console.error("[DSG] Fatal error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`,
    });
  }
};
