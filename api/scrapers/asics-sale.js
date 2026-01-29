// api/scrapers/asics-sale.js
// Scrapes 3 ASICS sale pages using Firecrawl and writes asics-sale.json to Vercel Blob.
//
// Changes vs your last version:
// ✅ Uses the correct clearance URL patterns (mens-clearance-shoes / womens-clearance-shoes)
// ✅ More resilient product selection (no longer depends only on .productTile__root)
// ✅ Better title/link extraction fallback
// ✅ Optional DEBUG: writes debug HTML blobs when ASICS_DEBUG_HTML=1
//
// Output schema (matches your merge-deals pipeline):
// { title, brand, model, salePrice, price, store, url, image, gender, shoeType }
//
// Required env vars:
// - FIRECRAWL_API_KEY
// - BLOB_READ_WRITE_TOKEN (Vercel provides this for @vercel/blob)
// Optional env vars:
// - ASICS_DEBUG_HTML=1   (writes debug-asics-*.html blobs)

const FirecrawlApp = require("@mendable/firecrawl-js").default;
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

/** ---------------- Helpers ---------------- **/

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

function buildAsicsImageFromProductUrl(productUrl) {
  if (!productUrl || typeof productUrl !== "string") return null;

  // ASICS product URLs often contain ANA_STYLE-COLOR.html (not guaranteed)
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

function normalizeGender(raw) {
  const g = String(raw || "").trim().toLowerCase();
  if (g === "mens" || g === "men" || g === "m") return "mens";
  if (g === "womens" || g === "women" || g === "w" || g === "ladies") return "womens";
  if (g === "unisex" || g === "u") return "unisex";
  return "unisex";
}

function parseMoneyFromText(text) {
  if (!text) return null;
  const m = String(text).match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Prefer DOM-based "was/list" vs "sale/now" price extraction.
 * We DO NOT swap values.
 */
function extractPricesFromTile($product, $) {
  // ---- 1) Try obvious "was/list/strike" patterns for ORIGINAL price
  const originalCandidates = [
    $product
      .find(
        '[class*="strike"], [class*="Strike"], [class*="was"], [class*="Was"], [class*="list"], [class*="List"]'
      )
      .toArray(),
    $product
      .find('[data-testid*="list"], [data-testid*="was"], [data-testid*="original"]')
      .toArray(),
    // sometimes aria-label contains "was $"
    $product.find('[aria-label*="was"], [aria-label*="Was"]').toArray(),
  ].flat();

  let price = null;
  for (const el of originalCandidates) {
    const t = $(el).text();
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
    $product.find('[aria-label*="now"], [aria-label*="Now"], [aria-label*="sale"], [aria-label*="Sale"]').toArray(),
  ].flat();

  let salePrice = null;
  for (const el of saleCandidates) {
    const t = $(el).text();
    const v = parseMoneyFromText(t);
    if (v != null) {
      salePrice = v;
      break;
    }
  }

  // ---- 3) If we got both and they look like a valid markdown, return.
  if (price != null && salePrice != null) {
    if (salePrice < price) return { price, salePrice };

    // Not confident if sale >= price; fall back
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

    // avoid swapping: common layout is orig first, sale second
    const p = nums[0] ?? null;
    const s = nums[1] ?? null;

    if (p != null && s != null && s < p) return { price: p, salePrice: s };
  }

  // If only one price, keep it as salePrice (merge-deals will filter if needed)
  if (matches && matches.length === 1) {
    const only = parseFloat(matches[0].replace("$", ""));
    if (Number.isFinite(only)) return { price: null, salePrice: only };
  }

  return { price: null, salePrice: null };
}

/**
 * Try multiple strategies to get product "cards"/containers.
 * We use a conservative approach:
 * - primary: .productTile__root (your original selector)
 * - fallback: any anchor to a product .html page -> walk up to a reasonable container
 */
function getProductContainers($) {
  // 1) Original selector (fast)
  let $products = $(".productTile__root");
  if ($products.length) return $products;

  // 2) Fallback: find product anchors that end with .html under /us/en-us/
  const anchors = $('a[href*=".html"]').filter((_, a) => {
    const href = ($(a).attr("href") || "").toLowerCase();
    if (!href) return false;
    if (!href.includes("/us/en-us/")) return false;
    if (!href.endsWith(".html")) return false;
    // avoid random CMS links
    if (href.includes("customer-service") || href.includes("privacy") || href.includes("terms")) return false;
    return true;
  });

  const cardNodes = [];
  anchors.each((_, a) => {
    const $a = $(a);

    // climb to something that looks like a product tile/card
    const $card =
      $a.closest('[class*="Tile"], [class*="tile"], [class*="Product"], [class*="product"], li, article, div').first();

    if ($card && $card.length) {
      cardNodes.push($card[0]);
    }
  });

  // Deduplicate card nodes by reference
  const uniq = [];
  const seen = new Set();
  for (const n of cardNodes) {
    const key = n; // node reference
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(n);
  }

  return $(uniq);
}

/**
 * Extract products from ASICS HTML
 * Outputs new schema
 */
function extractAsicsProducts(html, sourceUrl) {
  const $ = cheerio.load(html);
  const products = [];

  const normalizedUrl = String(sourceUrl || "").toLowerCase();
  let gender = "unisex";

  // Women FIRST (avoid substring collisions)
  if (normalizedUrl.includes("aa20106000") || normalizedUrl.includes("womens-clearance")) {
    gender = "womens";
  } else if (
    normalizedUrl.includes("aa60101000") ||
    normalizedUrl.includes("aa10106000") ||
    normalizedUrl.includes("mens-clearance")
  ) {
    gender = "mens";
  } else if (normalizedUrl.includes("leaving-asics") || normalizedUrl.includes("aa60400001")) {
    gender = "unisex";
  }

  gender = normalizeGender(gender);

  console.log(`[ASICS] Processing URL: ${sourceUrl} -> Gender: ${gender}`);
  console.log(`[ASICS] HTML length: ${html ? html.length : 0}`);

  const $products = getProductContainers($);
  console.log(`[ASICS] Product containers found: ${$products.length}`);

  $products.each((_, el) => {
    const $product = $(el);

    // Try to find a product link
    let $link =
      $product.find('a[href*="/us/en-us/"][href$=".html"]').first() ||
      $product.find('a[href$=".html"]').first() ||
      $product.find('a[href*=".html"]').first();

    if (!$link || !$link.length) return;

    // URL
    let url = $link.attr("href");
    url = absolutizeAsicsUrl(url);
    if (!url) return;

    // Title (several fallbacks)
    const aria = $link.attr("aria-label");
    const titleFromText = $link.text();
    const titleFromHeading =
      $product.find("h1,h2,h3,[class*='name'],[class*='Name'],[data-testid*='name']").first().text();

    let cleanTitle = String(aria || titleFromHeading || titleFromText || "")
      .replace(/Next slide/gi, "")
      .replace(/Previous slide/gi, "")
      .replace(/\bSale\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    // Some tiles include "Men's/Women's" etc; strip trailing gender tokens
    cleanTitle = cleanTitle
      .replace(/\bMen'?s\b/gi, "")
      .replace(/\bWomen'?s\b/gi, "")
      .replace(/\bUnisex\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleanTitle || cleanTitle.length < 3) return;

    // Prices (no swapping)
    const { price, salePrice } = extractPricesFromTile($product, $);

    // Image extraction (robust)
    let image = null;

    const sourceSrcset =
      $product.find("picture source[srcset]").first().attr("srcset") ||
      $product.find("picture source[data-srcset]").first().attr("data-srcset") ||
      null;

    image = pickBestFromSrcset(sourceSrcset);

    if (!image) {
      const $img = $product.find("img").first();
      const imgSrcset =
        $img.attr("srcset") || $img.attr("data-srcset") || $img.attr("data-lazy-srcset") || null;
      image = pickBestFromSrcset(imgSrcset);
    }

    if (!image) {
      const $img = $product.find("img").first();
      image =
        $img.attr("src") ||
        $img.attr("data-src") ||
        $img.attr("data-lazy-src") ||
        $img.attr("data-original") ||
        null;
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
      gender,
      shoeType: detectShoeType(cleanTitle, model),
    });
  });

  return products;
}

async function scrapeAsicsUrl(app, baseUrl, description) {
  console.log(`[ASICS] Scraping ${description}...`);

  const url = baseUrl.includes("?") ? `${baseUrl}&sz=100` : `${baseUrl}?sz=100`;
  console.log(`[ASICS] Fetching: ${url}`);

  try {
    const scrapeResult = await app.scrapeUrl(url, {
      formats: ["html"],
      waitFor: 12000,
      timeout: 60000,
    });

    const html = scrapeResult?.html || "";

    // Optional debug: save HTML so you can inspect what Firecrawl returned
    if (process.env.ASICS_DEBUG_HTML === "1") {
      const safeName = description.replace(/\W+/g, "-").toLowerCase();
      await put(`debug-asics-${safeName}.html`, html, {
        access: "public",
        addRandomSuffix: false,
      });
      console.log(`[ASICS] Debug HTML written: debug-asics-${safeName}.html`);
    }

    const products = extractAsicsProducts(html, baseUrl);

    const missingImages = products.filter((p) => !p.image).length;
    console.log(`[ASICS] ${description}: Found ${products.length} products (${missingImages} missing images)`);

    return { success: true, products, count: products.length, url };
  } catch (error) {
    console.error(`[ASICS] Error scraping ${description}:`, error.message);
    return { success: false, products: [], count: 0, error: error.message, url };
  }
}

async function scrapeAllAsicsSales() {
  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

  console.log("[ASICS] Starting scrape of all sale pages (sequential)...");

  // ✅ Updated URLs: these are the ones that actually serve the grid reliably
  const pages = [
    {
      url: "https://www.asics.com/us/en-us/mens-clearance-shoes/c/aa60101000/running/",
      description: "Men's Clearance",
    },
    {
      url: "https://www.asics.com/us/en-us/womens-clearance-shoes/c/aa20106000/running/",
      description: "Women's Clearance",
    },
    {
      url: "https://www.asics.com/us/en-us/styles-leaving-asics-com/c/aa60400001/running/?prefn1=c_productGender&prefv1=Women%7CMen",
      description: "Last Chance Styles",
    },
  ];

  const results = [];
  const allProducts = [];

  for (let i = 0; i < pages.length; i++) {
    const { url, description } = pages[i];

    console.log(`[ASICS] Starting page ${i + 1}/${pages.length}: ${description}`);

    const result = await scrapeAsicsUrl(app, url, description);

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

/** ---------------- Handler ---------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // You said you commented this out to test in browser.
  // Re-enable before production cron.
  // const cronSecret = process.env.CRON_SECRET;
  // if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
  //   return res.status(401).json({ error: "Unauthorized" });
  // }

  const start = Date.now();

  try {
    const { products: deals, pageResults } = await scrapeAllAsicsSales();

    // Robust dealsByGender (counts normalized values)
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
      debugNote:
        process.env.ASICS_DEBUG_HTML === "1"
          ? "ASICS_DEBUG_HTML=1 is enabled (debug-asics-*.html blobs written)"
          : "Tip: set ASICS_DEBUG_HTML=1 to write debug-asics-*.html blobs",
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
