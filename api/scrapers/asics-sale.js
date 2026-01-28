// api/scrapers/asics-sale.js
// Scrapes all three ASICS sale pages using Firecrawl
// - Fixes dealsByGender by normalizing gender values consistently
// - Improves price extraction to prefer DOM "was/list" vs "sale/now" nodes (no swapping)
// - Leaves single-price items in output (merge-deals filters them out)

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

  if (/\b(trail|trabuco|fujitrabuco|fuji)\b/i.test(combined)) return "trail";
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
 * Prefer DOM-based "was/list" vs "sale/now" price extraction.
 * We DO NOT swap values. If we can't confidently identify both, we fall back.
 */
function extractPricesFromTile($product) {
  // ---- 1) Try obvious "was/list/strike" patterns for ORIGINAL price
  const originalCandidates = [
    // class contains strike / was / list
    $product.find('[class*="strike"], [class*="Strike"], [class*="was"], [class*="Was"], [class*="list"], [class*="List"]').toArray(),
    // common data-testid patterns (if present)
    $product.find('[data-testid*="list"], [data-testid*="was"], [data-testid*="original"]').toArray(),
  ].flat();

  let price = null;
  for (const el of originalCandidates) {
    const t = cheerio.load(el).text();
    const v = parseMoneyFromText(t);
    if (v != null) {
      price = v;
      break;
    }
  }

  // ---- 2) Try obvious "sale/now" patterns for SALE price
  const saleCandidates = [
    $product.find('[class*="sale"], [class*="Sale"], [class*="now"], [class*="Now"]').toArray(),
    $product.find('[data-testid*="sale"], [data-testid*="now"]').toArray(),
  ].flat();

  let salePrice = null;
  for (const el of saleCandidates) {
    const t = cheerio.load(el).text();
    const v = parseMoneyFromText(t);
    if (v != null) {
      salePrice = v;
      break;
    }
  }

  // ---- 3) If we got both and they look like a valid markdown, return.
  if (price != null && salePrice != null) {
    // IMPORTANT: no swapping. Just validate.
    if (salePrice < price) return { price, salePrice };

    // If DOM gave us both but they don't satisfy sale<orig, treat as "not confident"
    // and fall back to text-based extraction rather than swapping.
    price = null;
    salePrice = null;
  }

  // ---- 4) Fallback: regex from tile text (best-effort).
  const productText = $product.text();
  const matches = productText.match(/\$(\d+(?:\.\d{2})?)/g);

  if (matches && matches.length >= 2) {
    const nums = matches
      .map((m) => parseFloat(m.replace("$", "")))
      .filter((n) => Number.isFinite(n));

    // We still avoid swapping: prefer first as original, second as sale (common layout).
    const p = nums[0] ?? null;
    const s = nums[1] ?? null;

    if (p != null && s != null && s < p) return { price: p, salePrice: s };
  }

  // If only one price, we return it as salePrice (merge-deals will filter it out)
  if (matches && matches.length === 1) {
    const only = parseFloat(matches[0].replace("$", ""));
    if (Number.isFinite(only)) return { price: null, salePrice: only };
  }

  return { price: null, salePrice: null };
}

/**
 * Extract products from ASICS HTML
 * UPDATED: Outputs new schema
 */
function extractAsicsProducts(html, sourceUrl) {
  const $ = cheerio.load(html);
  const products = [];

  const normalizedUrl = String(sourceUrl || "").toLowerCase();
  let gender = "unisex";

  // Women FIRST (avoid substring collisions)
  if (normalizedUrl.includes("aa20106000") || normalizedUrl.includes("womens-clearance")) {
    gender = "womens";
  } else if (normalizedUrl.includes("aa10106000") || normalizedUrl.includes("mens-clearance")) {
    gender = "mens";
  } else if (normalizedUrl.includes("leaving-asics") || normalizedUrl.includes("aa60400001")) {
    gender = "unisex";
  }

  gender = normalizeGender(gender);

  console.log(`[ASICS] Processing URL: ${sourceUrl} -> Gender: ${gender}`);

  const $products = $(".productTile__root");
  console.log(`[ASICS] Found ${$products.length} products for ${gender}`);

  $products.each((_, el) => {
    const $product = $(el);

    const $link = $product.find('a[href*="/p/"]').first();
    const linkTitle = $link.attr("aria-label") || $link.text().trim();

    let cleanTitle = String(linkTitle || "")
      .replace(/Next slide/gi, "")
      .replace(/Previous slide/gi, "")
      .replace(/\bSale\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    // Extract model-ish prefix if present
    const modelMatch = cleanTitle.match(/^([A-Z][A-Z\-\s\d]+?)(?=Men's|Women's|Unisex|\$)/i);
    if (modelMatch) cleanTitle = modelMatch[1].trim();

    if (!cleanTitle || cleanTitle.length < 3) return;

    // URL
    let url = $link.attr("href");
    if (url && !url.startsWith("http")) url = `https://www.asics.com${url}`;
    if (!url) return;

    // Prices (no swapping; prefer DOM; fallback to text)
    const { price, salePrice } = extractPricesFromTile($product);

    // IMAGE extraction (your existing robust logic)
    let image = null;

    const sourceSrcset =
      $product.find("picture source[srcset]").first().attr("srcset") ||
      $product.find("picture source[data-srcset]").first().attr("data-srcset") ||
      null;

    image = pickBestFromSrcset(sourceSrcset);

    if (!image) {
      const $img = $product.find("img").first();
      const imgSrcset = $img.attr("srcset") || $img.attr("data-srcset") || $img.attr("data-lazy-srcset") || null;
      image = pickBestFromSrcset(imgSrcset);
    }

    if (!image) {
      const $img = $product.find("img").first();
      image = $img.attr("src") || $img.attr("data-src") || $img.attr("data-lazy-src") || $img.attr("data-original") || null;
    }

    if (!image) {
      const noscriptHtml = $product.find("noscript").first().html();
      if (noscriptHtml) {
        const $$ = cheerio.load(noscriptHtml);
        image = $$("img").first().attr("src") || $$("img").first().attr("data-src") || null;
      }
    }

    image = absolutizeAsicsUrl(image);

    if (image && (image.startsWith("data:") || image.toLowerCase().includes("placeholder"))) image = null;
    if (image && image.includes("$variantthumbnail$")) image = image.replace("$variantthumbnail$", "$zoom$");

    if (!image && url) {
      const derived = buildAsicsImageFromProductUrl(url);
      if (derived) image = derived;
    }

    const model = cleanTitle.replace(/^ASICS\s+/i, "").trim();

    products.push({
      title: cleanTitle,
      brand: "ASICS",
      model,
      salePrice: salePrice != null ? salePrice : null,
      price: price != null ? price : null,
      store: "ASICS",
      url,
      image: image || null,
      gender, // normalized
      shoeType: detectShoeType(cleanTitle, model),
    });
  });

  return products;
}

async function scrapeAsicsUrlWithPagination(app, baseUrl, description) {
  console.log(`[ASICS] Scraping ${description}...`);

  try {
    const url = baseUrl.includes("?") ? `${baseUrl}&sz=100` : `${baseUrl}?sz=100`;
    console.log(`[ASICS] Fetching: ${url}`);

    const scrapeResult = await app.scrapeUrl(url, {
      formats: ["html"],
      waitFor: 8000,
      timeout: 45000,
    });

    const products = extractAsicsProducts(scrapeResult.html, baseUrl);

    const missingImages = products.filter((p) => !p.image).length;
    console.log(`[ASICS] ${description}: Found ${products.length} products (${missingImages} missing images)`);

    return { success: true, products, count: products.length, url };
  } catch (error) {
    console.error(`[ASICS] Error scraping ${description}:`, error.message);
    return { success: false, products: [], count: 0, error: error.message, url: baseUrl };
  }
}

async function scrapeAllAsicsSales() {
  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

  console.log("[ASICS] Starting scrape of all sale pages (sequential)...");

  const pages = [
    {
      url: "https://www.asics.com/us/en-us/mens-clearance/c/aa10106000/running/shoes/",
      description: "Men's Clearance",
    },
    {
      url: "https://www.asics.com/us/en-us/womens-clearance/c/aa20106000/running/shoes/",
      description: "Women's Clearance",
    },
    {
      url: "https://www.asics.com/us/en-us/styles-leaving-asics-com/c/aa60400001/running/shoes/?prefn1=c_productGender&prefv1=Women%7CMen",
      description: "Last Chance Styles",
    },
  ];

  const results = [];
  const allProducts = [];

  for (let i = 0; i < pages.length; i++) {
    const { url, description } = pages[i];

    console.log(`[ASICS] Starting page ${i + 1}/${pages.length}: ${description}`);

    const result = await scrapeAsicsUrlWithPagination(app, url, description);
    results.push({
      page: description,
      success: result.success,
      count: result.count,
      error: result.error || null,
      url: result.url,
    });

    if (result.success) allProducts.push(...result.products);

    if (i < pages.length - 1) {
      console.log("[ASICS] Waiting 2 seconds before next page...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // Deduplicate by URL
  const uniqueProducts = [];
  const seenUrls = new Set();

  for (const product of allProducts) {
    if (!product.url) {
      uniqueProducts.push(product);
      continue;
    }
    if (!seenUrls.has(product.url)) {
      seenUrls.add(product.url);
      uniqueProducts.push(product);
    }
  }

  const missingImagesTotal = uniqueProducts.filter((p) => !p.image).length;
  console.log(`[ASICS] Total unique products: ${uniqueProducts.length} (${missingImagesTotal} missing images)`);
  console.log(`[ASICS] Results per page:`, results);

  return { products: uniqueProducts, pageResults: results };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // TEMP: disabled during schema/testing phase
// Re-enable before enabling Vercel Cron in prod
//  const cronSecret = process.env.CRON_SECRET;
//  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
//    return res.status(401).json({ error: "Unauthorized" });
//  }

  const start = Date.now();

  try {
    const { products: deals, pageResults } = await scrapeAllAsicsSales();

    // Robust dealsByGender (counts normalized values, never "Men/Women" casing issues)
    const dealsByGender = { mens: 0, womens: 0, unisex: 0 };
    for (const d of deals) {
      const g = normalizeGender(d.gender);
      d.gender = g;
      dealsByGender[g] += 1;
    }

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "ASICS",
      segments: ["Men's Clearance", "Women's Clearance", "Last Chance Styles"],
      totalDeals: deals.length,
      dealsByGender,
      pageResults,
      deals,
    };

    const blob = await put("asics-sale.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;

    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      dealsByGender: output.dealsByGender,
      pageResults,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (error) {
    console.error("[ASICS] Fatal error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`,
    });
  }
};
