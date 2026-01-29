// api/scrapers/asics-sale.js
// Scrapes 3 ASICS sale pages using Firecrawl -> parses HTML with Cheerio -> writes asics-sale.json to Vercel Blob
//
// Output schema (per deal):
// { title, brand, model, salePrice, price, store, url, image, gender, shoeType }
//
// Notes:
// - Firecrawl returns HTML for the first page; ASICS is pagination/"load more" but your URLs + sz=100
//   usually expose more per page (still may not be "all" if ASICS hard-limits).
// - This endpoint is designed to be called by Vercel Cron or manually via browser.

const FirecrawlApp = require("@mendable/firecrawl-js").default;
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

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

// Prefer DOM-based "was/list/strike" vs "sale/now" extraction.
// No swapping.
function extractPricesFromTile($product) {
  const originalCandidates = [
    ...$product
      .find(
        '[class*="strike"], [class*="Strike"], [class*="was"], [class*="Was"], [class*="list"], [class*="List"]'
      )
      .toArray(),
    ...$product
      .find('[data-testid*="list"], [data-testid*="was"], [data-testid*="original"]')
      .toArray(),
  ];

  let price = null;
  for (const el of originalCandidates) {
    const t = cheerio.load(el).text();
    const v = parseMoneyFromText(t);
    if (v != null) {
      price = v;
      break;
    }
  }

  const saleCandidates = [
    ...$product.find('[class*="sale"], [class*="Sale"], [class*="now"], [class*="Now"]').toArray(),
    ...$product.find('[data-testid*="sale"], [data-testid*="now"]').toArray(),
  ];

  let salePrice = null;
  for (const el of saleCandidates) {
    const t = cheerio.load(el).text();
    const v = parseMoneyFromText(t);
    if (v != null) {
      salePrice = v;
      break;
    }
  }

  if (price != null && salePrice != null) {
    if (salePrice < price) return { price, salePrice };
    // not confident; fallback rather than swapping
    price = null;
    salePrice = null;
  }

  const productText = $product.text();
  const matches = productText.match(/\$(\d+(?:\.\d{2})?)/g);

  if (matches && matches.length >= 2) {
    const nums = matches
      .map((m) => parseFloat(m.replace("$", "")))
      .filter((n) => Number.isFinite(n));
    const p = nums[0] ?? null;
    const s = nums[1] ?? null;
    if (p != null && s != null && s < p) return { price: p, salePrice: s };
  }

  if (matches && matches.length === 1) {
    const only = parseFloat(matches[0].replace("$", ""));
    if (Number.isFinite(only)) return { price: null, salePrice: only };
  }

  return { price: null, salePrice: null };
}

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

    const modelMatch = cleanTitle.match(/^([A-Z][A-Z\-\s\d]+?)(?=Men's|Women's|Unisex|\$)/i);
    if (modelMatch) cleanTitle = modelMatch[1].trim();
    if (!cleanTitle || cleanTitle.length < 3) return;

    let url = $link.attr("href");
    if (url && !url.startsWith("http")) url = `https://www.asics.com${url}`;
    if (!url) return;

    const { price, salePrice } = extractPricesFromTile($product);

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
  console.log(`[ASICS] Firecrawl fetch: ${url}`);

  // Firecrawl client sometimes returns { data: { html } } depending on version.
  const result = await app.scrapeUrl(url, {
    formats: ["html"],
    waitFor: 8000,
    timeout: 45000,
  });

  const html = result?.html || result?.data?.html;
  if (!html || typeof html !== "string") {
    throw new Error("Firecrawl did not return HTML (missing result.html).");
  }

  const products = extractAsicsProducts(html, baseUrl);

  const missingImages = products.filter((p) => !p.image).length;
  console.log(`[ASICS] ${description}: ${products.length} products (${missingImages} missing images)`);

  return { success: true, products, count: products.length, url };
}

async function scrapeAllAsicsSales() {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY env var.");

  const app = new FirecrawlApp({ apiKey });

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

  console.log("[ASICS] Starting scrape of all pages (sequential)...");
  const results = [];
  const allProducts = [];

  for (let i = 0; i < pages.length; i++) {
    const { url, description } = pages[i];

    console.log(`[ASICS] Page ${i + 1}/${pages.length}: ${description}`);

    try {
      const r = await scrapeAsicsUrl(app, url, description);

      results.push({
        page: description,
        success: true,
        count: r.count,
        error: null,
        url: r.url,
      });

      allProducts.push(...r.products);
    } catch (err) {
      results.push({
        page: description,
        success: false,
        count: 0,
        error: err?.message || String(err),
        url,
      });
    }

    if (i < pages.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const uniqueProducts = [];
  for (const p of allProducts) {
    const key = p.url || `${p.title}|${p.gender}|${p.salePrice}|${p.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueProducts.push(p);
  }

  return { products: uniqueProducts, pageResults: results };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // Optional cron auth (recommended for production)
//  const cronSecret = process.env.CRON_SECRET;
//  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
//    return res.status(401).json({ error: "Unauthorized" });
//  }

  const start = Date.now();

  try {
    const { products: deals, pageResults } = await scrapeAllAsicsSales();

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
      dealsByGender,
      pageResults,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (error) {
    console.error("[ASICS] Fatal error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || String(error),
      duration: `${Date.now() - start}ms`,
    });
  }
};
