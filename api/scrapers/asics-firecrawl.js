// api/scrapers/asics-sale.js
// Scrapes ASICS sale pages using Firecrawl + Cheerio
// Uses sitemap for product discovery to avoid bot detection
// Schema: 16 fields matching shared output contract

const FirecrawlApp = require("@mendable/firecrawl-js").default;
const cheerio = require("cheerio");
const { parseStringPromise } = require("xml2js");
const { put } = require("@vercel/blob");

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const STORE = "ASICS";
const BASE_URL = "https://www.asics.com";
const SITEMAP_INDEX = "https://www.asics.com/managed-sitemaps/asics/href-sitemap-index.xml";
const SCHEMA_VERSION = 1;

// Fallback category URLs (used if sitemap approach fails)
// NOTE: sz= and prefn/prefv params are disallowed by robots.txt — do NOT use them
const FALLBACK_URLS = [
  {
    url: "https://www.asics.com/us/en-us/mens-clearance/c/aa10106000/running/shoes/",
    gender: "mens",
    description: "Men's Clearance",
  },
  {
    url: "https://www.asics.com/us/en-us/womens-clearance/c/aa20106000/running/shoes/",
    gender: "womens",
    description: "Women's Clearance",
  },
];

// ─────────────────────────────────────────────
// Math / formatting helpers
// ─────────────────────────────────────────────

function toNumber(x) {
  if (x == null) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  const n = parseFloat(String(x).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
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

// ─────────────────────────────────────────────
// URL helpers
// ─────────────────────────────────────────────

function absolutizeUrl(maybeUrl, base = BASE_URL) {
  const u = String(maybeUrl || "").trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return base.replace(/\/+$/, "") + u;
  return base.replace(/\/+$/, "") + "/" + u.replace(/^\/+/, "");
}

function isUsProductUrl(url) {
  return typeof url === "string" && url.includes("/us/en-us/");
}

function isProductPageUrl(url) {
  // ASICS product pages end in /p/SOMETHING.html
  return typeof url === "string" && /\/p\/[A-Za-z0-9_-]+\.html$/i.test(url);
}

function isRunningShoeUrl(url) {
  // Filter to running shoe product pages only
  return (
    isProductPageUrl(url) &&
    isUsProductUrl(url)
  );
}

// ─────────────────────────────────────────────
// Image helpers
// ─────────────────────────────────────────────

function pickBestFromSrcset(srcset) {
  if (!srcset || typeof srcset !== "string") return null;
  const candidates = srcset
    .split(",")
    .map((s) => s.trim())
    .map((entry) => entry.split(/\s+/)[0])
    .filter(Boolean);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

function absolutizeAsicsUrl(url) {
  if (!url || typeof url !== "string") return null;
  url = url.replace(/&amp;/g, "&").trim();
  if (!url || url.startsWith("data:")) return null;
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${BASE_URL}${url}`;
  return `${BASE_URL}/${url}`;
}

function deriveImageFromProductUrl(productUrl) {
  if (!productUrl) return null;
  const m = productUrl.match(/ANA_([A-Za-z0-9]+)-([A-Za-z0-9]+)\.html/i);
  if (!m) return null;
  return `https://images.asics.com/is/image/asics/${m[1]}_${m[2]}_SR_RT_GLB?$zoom$`;
}

function extractImageFromTile($product, $) {
  // 1) picture source srcset
  const sourceSrcset =
    $product.find("picture source[srcset]").first().attr("srcset") ||
    $product.find("picture source[data-srcset]").first().attr("data-srcset") ||
    null;
  let imageURL = pickBestFromSrcset(sourceSrcset);

  // 2) img srcset
  if (!imageURL) {
    const $img = $product.find("img").first();
    imageURL = pickBestFromSrcset(
      $img.attr("srcset") ||
      $img.attr("data-srcset") ||
      $img.attr("data-lazy-srcset") ||
      null
    );
  }

  // 3) img src
  if (!imageURL) {
    const $img = $product.find("img").first();
    imageURL =
      $img.attr("src") ||
      $img.attr("data-src") ||
      $img.attr("data-lazy-src") ||
      $img.attr("data-original") ||
      null;
  }

  // 4) noscript fallback
  if (!imageURL) {
    const noscriptHtml = $product.find("noscript").first().html();
    if (noscriptHtml) {
      const $$ = cheerio.load(noscriptHtml);
      imageURL = $$("img").first().attr("src") || $$("img").first().attr("data-src") || null;
    }
  }

  imageURL = absolutizeAsicsUrl(imageURL);

  if (imageURL && (imageURL.startsWith("data:") || imageURL.toLowerCase().includes("placeholder"))) {
    imageURL = null;
  }
  if (imageURL && imageURL.includes("$variantthumbnail$")) {
    imageURL = imageURL.replace("$variantthumbnail$", "$zoom$");
  }

  return imageURL || null;
}

// ─────────────────────────────────────────────
// Classification helpers
// ─────────────────────────────────────────────

function detectShoeType(name = "", model = "") {
  const combined = `${name} ${model}`.toLowerCase();
  if (/\b(trail|trabuco|fujitrabuco|fuji)\b/.test(combined)) return "trail";
  if (/\b(track|spike|japan|metaspeed|magic speed)\b/.test(combined)) return "track";
  return "road";
}

function detectGenderFromUrl(url = "") {
  const u = url.toLowerCase();
  // Check womens FIRST — aa20106000 contains aa10106000 as substring
  if (u.includes("aa20106000") || u.includes("womens") || u.includes("women")) return "womens";
  if (u.includes("aa10106000") || u.includes("mens") || u.includes("men")) return "mens";
  if (u.includes("aa60400001") || u.includes("unisex")) return "unisex";
  return "unknown";
}

function detectGenderFromText(text = "") {
  const t = text.toLowerCase();
  if (t.includes("women")) return "womens";
  if (t.includes("men")) return "mens";
  return "unknown";
}

// ─────────────────────────────────────────────
// Price extraction
// ─────────────────────────────────────────────

function extractPricesFromText(text) {
  const matches = String(text || "").match(/\$(\d+(?:\.\d{2})?)/g);
  let originalPrice = null;
  let salePrice = null;

  if (matches && matches.length >= 2) {
    originalPrice = toNumber(matches[0]);
    salePrice = toNumber(matches[1]);
  } else if (matches && matches.length === 1) {
    salePrice = toNumber(matches[0]);
  }

  // Sanity check: flip if swapped
  if (salePrice != null && originalPrice != null && salePrice > originalPrice) {
    [salePrice, originalPrice] = [originalPrice, salePrice];
  }

  return {
    salePrice: round2(salePrice),
    originalPrice: round2(originalPrice),
  };
}

// ─────────────────────────────────────────────
// Sitemap fetching
// ─────────────────────────────────────────────

async function fetchSitemapProductUrls(app) {
  console.log("[ASICS] Fetching sitemap index...");

  try {
    const indexResult = await app.scrapeUrl(SITEMAP_INDEX, {
      formats: ["html"],
      timeout: 30000,
    });

    if (!indexResult?.html) throw new Error("No HTML from sitemap index");

    // Parse sitemap index to find US product sitemap
    const parsed = await parseStringPromise(indexResult.html, { explicitArray: false });
    const sitemaps = parsed?.sitemapindex?.sitemap || [];
    const sitemapList = Array.isArray(sitemaps) ? sitemaps : [sitemaps];

    // Find US-specific product sitemap
    const usProductSitemap = sitemapList
      .map((s) => s?.loc || "")
      .find((loc) => loc.includes("en-us") && loc.includes("product"));

    if (!usProductSitemap) {
      console.log("[ASICS] Could not find US product sitemap, available sitemaps:");
      sitemapList.forEach((s) => console.log(" -", s?.loc));
      return null;
    }

    console.log("[ASICS] Found US product sitemap:", usProductSitemap);

    // Fetch the actual product sitemap
    const productSitemapResult = await app.scrapeUrl(usProductSitemap, {
      formats: ["html"],
      timeout: 30000,
    });

    if (!productSitemapResult?.html) throw new Error("No HTML from product sitemap");

    const productParsed = await parseStringPromise(productSitemapResult.html, { explicitArray: false });
    const urls = productParsed?.urlset?.url || [];
    const urlList = Array.isArray(urls) ? urls : [urls];

    // Filter to US running shoe product pages only
    const runningShoeUrls = urlList
      .map((u) => u?.loc || "")
      .filter(isRunningShoeUrl);

    console.log(`[ASICS] Found ${runningShoeUrls.length} US running shoe URLs in sitemap`);
    return runningShoeUrls;

  } catch (err) {
    console.error("[ASICS] Sitemap fetch failed:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// HTML parsing — category page (fallback)
// ─────────────────────────────────────────────

function parseCategoryPage(html, sourceUrl) {
  const $ = cheerio.load(html);
  const deals = [];
  const gender = detectGenderFromUrl(sourceUrl);

  $(".productTile__root").each((_, el) => {
    const $product = $(el);

    const $link = $product.find('a[href*="/p/"]').first();
    let title = ($link.attr("aria-label") || $link.text() || "")
      .trim()
      .replace(/Next slide|Previous slide|\bSale\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!title || title.length < 3) return;

    const href = $link.attr("href") || "";
    const listingURL = absolutizeUrl(href);
    if (!listingURL) return;

    const { salePrice, originalPrice } = extractPricesFromText($product.text());
    if (salePrice == null && originalPrice == null) return;

    const imageURL = extractImageFromTile($product, $) || deriveImageFromProductUrl(listingURL);
    const brand = "ASICS";
    const model = title.replace(/^ASICS\s+/i, "").trim();
    const listingName = `${brand} ${model}`;
    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    deals.push({
      schemaVersion: SCHEMA_VERSION,
      listingName,
      brand,
      model,
      salePrice,
      originalPrice,
      discountPercent,
      // Range fields — null on category pages (single variant shown)
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,
      store: STORE,
      listingURL,
      imageURL,
      gender,
      shoeType: detectShoeType(listingName, model),
    });
  });

  return deals;
}

// ─────────────────────────────────────────────
// HTML parsing — individual product page
// ─────────────────────────────────────────────

function parseProductPage(html, sourceUrl) {
  const $ = cheerio.load(html);

  // Title
  const title = (
    $('h1[class*="product"]').first().text() ||
    $('h1').first().text() ||
    $('[class*="productName"]').first().text() ||
    ""
  ).trim();

  if (!title) return null;

  // Prices — look for structured price elements first
  let salePrice = null;
  let originalPrice = null;

  const $saleEl = $('[class*="salePrice"], [class*="sale-price"], [class*="finalPrice"]').first();
  const $origEl = $('[class*="originalPrice"], [class*="original-price"], [class*="wasPrice"], [class*="strikethrough"]').first();

  if ($saleEl.length) salePrice = round2(toNumber($saleEl.text()));
  if ($origEl.length) originalPrice = round2(toNumber($origEl.text()));

  // Fallback to text extraction
  if (!salePrice && !originalPrice) {
    const priceText = $('[class*="price"]').first().closest('[class*="product"]').text();
    const extracted = extractPricesFromText(priceText);
    salePrice = extracted.salePrice;
    originalPrice = extracted.originalPrice;
  }

  if (salePrice == null && originalPrice == null) return null;

  // Price ranges across variants
  const allPrices = [];
  $('[class*="price"]').each((_, el) => {
    const n = toNumber($(el).text());
    if (n && n > 0) allPrices.push(n);
  });

  const uniquePrices = [...new Set(allPrices)].sort((a, b) => a - b);
  const salePrices = originalPrice
    ? uniquePrices.filter((p) => p < originalPrice)
    : uniquePrices;

  const salePriceLow = salePrices.length > 1 ? round2(Math.min(...salePrices)) : null;
  const salePriceHigh = salePrices.length > 1 ? round2(Math.max(...salePrices)) : null;
  const originalPriceLow = null; // ASICS typically has one original price
  const originalPriceHigh = null;
  const discountPercentUpTo = salePriceLow
    ? computeDiscountPercent(originalPrice, salePriceLow)
    : null;

  // Image
  let imageURL =
    $('meta[property="og:image"]').attr("content") ||
    $('img[class*="mainImage"], img[class*="product-image"]').first().attr("src") ||
    null;
  imageURL = absolutizeAsicsUrl(imageURL) || deriveImageFromProductUrl(sourceUrl);

  // Gender
  const gender =
    detectGenderFromUrl(sourceUrl) !== "unknown"
      ? detectGenderFromUrl(sourceUrl)
      : detectGenderFromText(title);

  const brand = "ASICS";
  const model = title.replace(/^ASICS\s+/i, "").trim();
  const listingName = `${brand} ${model}`;
  const discountPercent = computeDiscountPercent(originalPrice, salePrice);

  return {
    schemaVersion: SCHEMA_VERSION,
    listingName,
    brand,
    model,
    salePrice,
    originalPrice,
    discountPercent,
    salePriceLow,
    salePriceHigh,
    originalPriceLow,
    originalPriceHigh,
    discountPercentUpTo,
    store: STORE,
    listingURL: sourceUrl,
    imageURL,
    gender,
    shoeType: detectShoeType(listingName, model),
  };
}

// ─────────────────────────────────────────────
// Scrape runner — category page
// ─────────────────────────────────────────────

async function scrapeCategoryPage(app, url, gender, description) {
  console.log(`[ASICS] Scraping category: ${description}`);

  try {
    const result = await app.scrapeUrl(url, {
      formats: ["html"],
      waitFor: 4000,   // reduced from 8000
      timeout: 45000,
    });

    if (!result?.html) throw new Error("No HTML returned");

    const deals = parseCategoryPage(result.html, url);
    console.log(`[ASICS] ${description}: ${deals.length} deals`);
    return { success: true, deals, url };

  } catch (err) {
    console.error(`[ASICS] Error on ${description}:`, err.message);
    return { success: false, deals: [], url, error: err.message };
  }
}

// ─────────────────────────────────────────────
// Scrape runner — individual product pages
// ─────────────────────────────────────────────

async function scrapeProductPages(app, urls) {
  const deals = [];
  const errors = [];
  const BATCH_SIZE = 3;
  const DELAY_MS = () => Math.floor(Math.random() * 2000) + 1500; // 1.5–3.5s random delay

  console.log(`[ASICS] Scraping ${urls.length} product pages in batches of ${BATCH_SIZE}...`);

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    console.log(`[ASICS] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(urls.length / BATCH_SIZE)}`);

    // Small batches run in parallel — large enough to be faster, small enough to avoid blocks
    const batchResults = await Promise.all(
      batch.map(async (url) => {
        try {
          const result = await app.scrapeUrl(url, {
            formats: ["html"],
            waitFor: 2000,  // product pages need less wait time
            timeout: 30000,
          });

          if (!result?.html) return null;
          return parseProductPage(result.html, url);

        } catch (err) {
          errors.push({ url, error: err.message });
          return null;
        }
      })
    );

    batchResults.forEach((deal) => {
      if (deal) deals.push(deal);
    });

    // Random delay between batches to avoid triggering rate limits
    if (i + BATCH_SIZE < urls.length) {
      const delay = DELAY_MS();
      console.log(`[ASICS] Waiting ${delay}ms before next batch...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.log(`[ASICS] Product pages: ${deals.length} deals, ${errors.length} errors`);
  return { deals, errors };
}

// ─────────────────────────────────────────────
// Deduplication
// ─────────────────────────────────────────────

function deduplicateDeals(deals) {
  const seen = new Set();
  return deals.filter((d) => {
    const key = d.listingURL || d.listingName || "";
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────

async function scrapeAllAsicsSales() {
  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
  const start = Date.now();
  const sourceUrls = [];
  let allDeals = [];
  let pagesFetched = 0;
  const pageResults = [];

  console.log("[ASICS] Starting scrape...");

  // ── Strategy 1: Try sitemap approach ──
  const sitemapUrls = await fetchSitemapProductUrls(app);

  if (sitemapUrls && sitemapUrls.length > 0) {
    console.log(`[ASICS] Using sitemap strategy: ${sitemapUrls.length} product URLs`);
    sourceUrls.push(SITEMAP_INDEX);

    const { deals, errors } = await scrapeProductPages(app, sitemapUrls);
    // Only keep deals that are actually on sale
    const saleDeals = deals.filter((d) => d.salePrice != null && d.originalPrice != null && d.salePrice < d.originalPrice);

    allDeals.push(...saleDeals);
    pagesFetched += sitemapUrls.length;
    pageResults.push({
      strategy: "sitemap",
      urlsFound: sitemapUrls.length,
      dealsScraped: deals.length,
      saleDeals: saleDeals.length,
      errors: errors.length,
    });

  } else {
    // ── Strategy 2: Fallback to category pages ──
    console.log("[ASICS] Sitemap failed, falling back to category pages...");

    for (let i = 0; i < FALLBACK_URLS.length; i++) {
      const { url, gender, description } = FALLBACK_URLS[i];
      sourceUrls.push(url);

      const result = await scrapeCategoryPage(app, url, gender, description);
      allDeals.push(...result.deals);
      pagesFetched++;

      pageResults.push({
        page: description,
        success: result.success,
        count: result.deals.length,
        error: result.error || null,
        url,
      });

      if (i < FALLBACK_URLS.length - 1) {
        const delay = Math.floor(Math.random() * 3000) + 2000;
        console.log(`[ASICS] Waiting ${delay}ms before next page...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  const uniqueDeals = deduplicateDeals(allDeals);

  console.log(`[ASICS] Complete. ${uniqueDeals.length} unique deals in ${Date.now() - start}ms`);

  return {
    deals: uniqueDeals,
    sourceUrls,
    pagesFetched,
    pageResults,
    scrapeDurationMs: Date.now() - start,
  };
}

// ─────────────────────────────────────────────
// Vercel handler
// ─────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
// CRON SECRET
/*  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
*/
  const start = Date.now();

  try {
    const { deals, sourceUrls, pagesFetched, pageResults, scrapeDurationMs } =
      await scrapeAllAsicsSales();

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: new Date().toISOString(),
      via: "firecrawl",
      sourceUrls,
      pagesFetched,
      dealsFound: deals.length,
      dealsExtracted: deals.filter((d) => d.salePrice != null).length,
      scrapeDurationMs,
      ok: true,
      error: null,
      dealsByGender: {
        mens: deals.filter((d) => d.gender === "mens").length,
        womens: deals.filter((d) => d.gender === "womens").length,
        unisex: deals.filter((d) => d.gender === "unisex").length,
        unknown: deals.filter((d) => d.gender === "unknown").length,
      },
      pageResults,
      deals,
    };

    const blob = await put("asics-sale.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      ok: true,
      store: STORE,
      dealsFound: output.dealsFound,
      dealsExtracted: output.dealsExtracted,
      dealsByGender: output.dealsByGender,
      pageResults,
      sourceUrls,
      pagesFetched,
      blobUrl: blob.url,
      scrapeDurationMs,
      lastUpdated: output.lastUpdated,
    });

  } catch (error) {
    console.error("[ASICS] Fatal error:", error);

    const errorOutput = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: new Date().toISOString(),
      via: "firecrawl",
      sourceUrls: [],
      pagesFetched: 0,
      dealsFound: 0,
      dealsExtracted: 0,
      scrapeDurationMs: Date.now() - start,
      ok: false,
      error: error?.message || "Unknown error",
      deals: [],
    };

    // Still save the error state to blob so consumers know something went wrong
    await put("asics-sale.json", JSON.stringify(errorOutput, null, 2), {
      access: "public",
      addRandomSuffix: false,
    }).catch(() => {});

    return res.status(500).json({
      ok: false,
      store: STORE,
      error: error?.message || "Unknown error",
      scrapeDurationMs: Date.now() - start,
      stack: process.env.NODE_ENV === "development" ? error?.stack : undefined,
    });
  }
};
