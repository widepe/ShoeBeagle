// api/scrapers/asics-sale.js
// DIAGNOSTIC VERSION - Returns diagnostic info in API response

const FirecrawlApp = require("@mendable/firecrawl-js").default;
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const diagnosticLog = []; // Collect diagnostic info

function log(...args) {
  const msg = args.join(" ");
  console.log(...args);
  diagnosticLog.push(msg);
}

/**
 * Pick the best (usually largest) URL from a srcset string.
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

function absolutizeAsicsUrl(url) {
  if (!url || typeof url !== "string") return null;

  url = url.replace(/&amp;/g, "&").trim();
  if (!url) return null;
  if (url.startsWith("data:")) return null;

  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://www.asics.com${url}`;
  return `https://www.asics.com/${url}`;
}

/**
 * Best-effort image fallback from product URL.
 */
function buildAsicsImageFromProductUrl(productUrl) {
  if (!productUrl || typeof productUrl !== "string") return null;

  const m = productUrl.match(/ANA_([A-Za-z0-9]+)-([A-Za-z0-9]+)\.html/i);
  if (!m) return null;

  const style = m[1];
  const color = m[2];

  return `https://images.asics.com/is/image/asics/${style}_${color}_SR_RT_GLB?$zoom$`;
}

function detectShoeType(title, model) {
  const combined = ((title || "") + " " + (model || "")).toLowerCase();

  if (/\b(trail|trabuco|fujitrabuco|fuji|venture)\b/i.test(combined)) return "trail";
  if (/\b(track|spike|japan|metaspeed|magic speed)\b/i.test(combined)) return "track";
  return "road";
}

/**
 * Normalize gender to one of: mens | womens | unisex
 */
function normalizeGender(raw) {
  const g = String(raw || "").trim().toLowerCase();

  if (g === "mens" || g === "men" || g === "m") return "mens";
  if (g === "womens" || g === "women" || g === "w" || g === "ladies") return "womens";
  if (g === "unisex" || g === "u") return "unisex";

  return "unisex";
}

/**
 * Extract a single money value from text like "$129.95" etc.
 */
function parseMoneyFromText(text) {
  if (!text) return null;
  const m = String(text).match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract prices from product element or its surrounding context
 */
function extractPrices($, $productLink) {
  let price = null;
  let salePrice = null;

  const linkText = $productLink.text();
  const parentText = $productLink.parent().text();
  
  const priceMatches = (linkText + " " + parentText).match(/\$\d+\.\d{2}/g);
  
  if (priceMatches && priceMatches.length >= 2) {
    const prices = priceMatches
      .map(p => parseFloat(p.replace("$", "")))
      .filter(n => Number.isFinite(n) && n > 0);
    
    if (prices.length >= 2) {
      prices.sort((a, b) => b - a);
      price = prices[0];
      salePrice = prices[1];
    }
  } else if (priceMatches && priceMatches.length === 1) {
    salePrice = parseFloat(priceMatches[0].replace("$", ""));
  }

  return { price, salePrice };
}

/**
 * DIAGNOSTIC VERSION - Tries multiple selector strategies and logs results
 */
function extractAsicsProducts(html, sourceUrl) {
  const $ = cheerio.load(html);
  const products = [];

  const normalizedUrl = String(sourceUrl || "").toLowerCase();
  let gender = "unisex";

  if (normalizedUrl.includes("aa20106000") || normalizedUrl.includes("womens-clearance")) {
    gender = "womens";
  } else if (normalizedUrl.includes("aa10106000") || normalizedUrl.includes("mens-clearance")) {
    gender = "mens";
  } else if (normalizedUrl.includes("leaving-asics") || normalizedUrl.includes("aa60400001")) {
    gender = "unisex";
  }

  gender = normalizeGender(gender);

  log(`\n[DIAGNOSTIC] Processing: ${sourceUrl}`);
  log(`[DIAGNOSTIC] Gender: ${gender}`);
  log(`[DIAGNOSTIC] HTML length: ${html.length} chars`);

  // Try multiple selector strategies
  const strategies = [
    { name: "Product links with ANA_", selector: 'a[href*="/p/ANA_"]' },
    { name: "Product links with /p/", selector: 'a[href*="/p/"]' },
    { name: "Old productTile__root", selector: '.productTile__root' },
    { name: "Any productTile class", selector: '[class*="productTile"]' },
    { name: "Any product class", selector: '[class*="product"]' },
    { name: "Article tags", selector: 'article' },
    { name: "Data-testid product", selector: '[data-testid*="product"]' },
  ];

  let bestStrategy = null;
  let maxFound = 0;

  log(`[DIAGNOSTIC] Testing selectors:`);
  for (const strategy of strategies) {
    const elements = $(strategy.selector);
    const count = elements.length;
    log(`  - ${strategy.name}: ${count} found`);
    
    if (count > maxFound) {
      maxFound = count;
      bestStrategy = strategy;
    }

    if (count > 0 && count <= 3) {
      const first = elements.first();
      const classes = first.attr("class") || "none";
      const tag = first.prop("tagName");
      const text = first.text().trim().substring(0, 80);
      log(`    First: <${tag}> class="${classes}" text="${text}..."`);
    }
  }

  const allLinks = $('a[href]').length;
  const priceElements = $('*').filter(function() {
    return $(this).text().match(/\$\d+\.\d{2}/);
  }).length;
  
  log(`[DIAGNOSTIC] Total links: ${allLinks}, Elements with prices: ${priceElements}`);

  if (!bestStrategy || maxFound === 0) {
    log(`[DIAGNOSTIC] ⚠️ NO PRODUCTS FOUND`);
    log(`[DIAGNOSTIC] HTML starts with: ${html.substring(0, 500)}`);
    return products;
  }

  log(`[DIAGNOSTIC] Best strategy: ${bestStrategy.name} (${maxFound} elements)`);

  const $elements = $(bestStrategy.selector);
  const seenUrls = new Set();

  $elements.each((_, el) => {
    const $el = $(el);
    
    let $link = $el.is('a') ? $el : $el.find('a[href*="/p/"]').first();
    
    if (!$link.length) {
      $link = $el.parent('a[href*="/p/"]');
    }

    if (!$link.length) return;

    let url = $link.attr("href");
    if (!url) return;
    
    url = absolutizeAsicsUrl(url);
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);

    let title = $link.attr("aria-label") || $el.text().trim() || $link.text().trim();
    
    title = title
      .replace(/Next slide/gi, "")
      .replace(/Previous slide/gi, "")
      .replace(/\bSale\b/gi, "")
      .replace(/\$\d+\.\d{2}/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!title || title.length < 3) return;

    const modelMatch = title.match(/^([A-Z][A-Z\-\s\d]+?)(?=\s*$|Men's|Women's|Unisex|Sportstyle|Running|Tennis|Trail)/i);
    const model = modelMatch ? modelMatch[1].trim() : title.replace(/^ASICS\s+/i, "").trim();

    const { price, salePrice } = extractPrices($, $link);

    let image = null;
    const $img = $el.find("img").first();
    
    if ($img.length > 0) {
      const srcset = $img.attr("srcset") || $img.attr("data-srcset") || $img.attr("data-lazy-srcset");
      image = pickBestFromSrcset(srcset);

      if (!image) {
        image = $img.attr("src") || $img.attr("data-src") || $img.attr("data-lazy-src");
      }
    }

    if (!image) {
      const $picture = $el.find("picture");
      if ($picture.length > 0) {
        const sourceSrcset = $picture.find("source[srcset]").first().attr("srcset");
        image = pickBestFromSrcset(sourceSrcset);
      }
    }

    image = absolutizeAsicsUrl(image);

    if (image && (image.startsWith("data:") || image.toLowerCase().includes("placeholder"))) {
      image = null;
    }

    if (image && image.includes("$variantthumbnail$")) {
      image = image.replace("$variantthumbnail$", "$zoom$");
    }

    if (!image && url) {
      const derived = buildAsicsImageFromProductUrl(url);
      if (derived) image = derived;
    }

    products.push({
      title,
      brand: "ASICS",
      model,
      salePrice: salePrice != null ? salePrice : null,
      price: price != null ? price : null,
      store: "ASICS",
      url,
      image: image || null,
      gender,
      shoeType: detectShoeType(title, model),
    });
  });

  log(`[DIAGNOSTIC] Extracted ${products.length} products`);
  
  return products;
}

async function scrapeAsicsUrlWithPagination(app, baseUrl, description) {
  log(`\n[ASICS] ===== ${description} =====`);

  try {
    const url = baseUrl.includes("?") ? `${baseUrl}&sz=100` : `${baseUrl}?sz=100`;
    log(`[ASICS] Fetching: ${url}`);

    const scrapeResult = await app.scrapeUrl(url, {
      formats: ["html"],
      waitFor: 8000,
      timeout: 45000,
    });

    log(`[ASICS] Response received, HTML: ${scrapeResult.html?.length || 0} chars`);

    const products = extractAsicsProducts(scrapeResult.html, baseUrl);

    log(`[ASICS] Result: ${products.length} products`);

    return { success: true, products, count: products.length, url };
  } catch (error) {
    log(`[ASICS] ERROR: ${error.message}`);
    return { success: false, products: [], count: 0, error: error.message, url: baseUrl };
  }
}

async function scrapeAllAsicsSales() {
  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

  log("[ASICS] Starting DIAGNOSTIC scrape...");

  const pages = [
    {
      url: "https://www.asics.com/us/en-us/mens-clearance/c/aa10106000/running/shoes/",
      description: "Men's Clearance",
    },
  ];

  // Only scrape first page for diagnostic
  const results = [];
  const allProducts = [];

  for (let i = 0; i < pages.length; i++) {
    const { url, description } = pages[i];
    const result = await scrapeAsicsUrlWithPagination(app, url, description);
    results.push({
      page: description,
      success: result.success,
      count: result.count,
      error: result.error || null,
      url: result.url,
    });

    if (result.success) allProducts.push(...result.products);
  }

  log(`\n[ASICS] FINAL: ${allProducts.length} products`);

  return { products: allProducts, pageResults: results };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  diagnosticLog.length = 0; // Clear log
  const start = Date.now();

  try {
    const { products: deals, pageResults } = await scrapeAllAsicsSales();

    const dealsByGender = { mens: 0, womens: 0, unisex: 0 };
    for (const d of deals) {
      const g = normalizeGender(d.gender);
      d.gender = g;
      dealsByGender[g] += 1;
    }

    const duration = Date.now() - start;

    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      dealsByGender: dealsByGender,
      pageResults,
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
      // DIAGNOSTIC INFO BELOW
      diagnosticLog: diagnosticLog,
      sampleProducts: deals.slice(0, 3), // First 3 products if any
    });
  } catch (error) {
    console.error("[ASICS] Fatal error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`,
      diagnosticLog: diagnosticLog,
    });
  }
};
