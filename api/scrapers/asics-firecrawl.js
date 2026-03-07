// api/scrapers/asics-firecrawl.js
// Scrapes ASICS sale running shoes using Firecrawl + Cheerio
// Safer approach: scrape combined clearance listing pages and follow Load More pagination
// Avoids heavy sitemap/product-page crawling to reduce bot pressure

const FirecrawlApp = require("@mendable/firecrawl-js").default;
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const STORE = "ASICS";
const BASE_URL = "https://www.asics.com";
const SCHEMA_VERSION = 1;

const START_URL =
  "https://www.asics.com/us/en-us/clearance/c/aa60000000/running/shoes/?prefn1=c_productGender&prefv1=Men%7CWomen%7CUnisex";

const MAX_PAGES = 12; // safety cap
const FIRECRAWL_WAIT_MS = 3500;
const FIRECRAWL_TIMEOUT_MS = 45000;

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(min = 1800, max = 3200) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

function getPageNumberFromUrl(url) {
  try {
    const u = new URL(url);
    const p = parseInt(u.searchParams.get("page") || "1", 10);
    return Number.isFinite(p) && p > 0 ? p : 1;
  } catch {
    return 1;
  }
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
  const sourceSrcset =
    $product.find("picture source[srcset]").first().attr("srcset") ||
    $product.find("picture source[data-srcset]").first().attr("data-srcset") ||
    null;

  let imageURL = pickBestFromSrcset(sourceSrcset);

  if (!imageURL) {
    const $img = $product.find("img").first();
    imageURL = pickBestFromSrcset(
      $img.attr("srcset") ||
        $img.attr("data-srcset") ||
        $img.attr("data-lazy-srcset") ||
        null
    );
  }

  if (!imageURL) {
    const $img = $product.find("img").first();
    imageURL =
      $img.attr("src") ||
      $img.attr("data-src") ||
      $img.attr("data-lazy-src") ||
      $img.attr("data-original") ||
      null;
  }

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

function normalizeText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function parseClassification(classification = "") {
  const c = normalizeText(classification).toLowerCase();

  // Default to unisex if no gender text appears
  let gender = "unisex";
  let shoeType = "unknown";

  if (c.includes("women")) {
    gender = "womens";
  } else if (c.includes("men")) {
    gender = "mens";
  }

  if (c.includes("trail running shoes")) {
    shoeType = "trail";
  } else if (c.includes("track & field shoes")) {
    shoeType = "track";
  } else if (c.includes("running shoes")) {
    shoeType = "road";
  }

  return { gender, shoeType };
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

  if (salePrice != null && originalPrice != null && salePrice > originalPrice) {
    [salePrice, originalPrice] = [originalPrice, salePrice];
  }

  return {
    salePrice: round2(salePrice),
    originalPrice: round2(originalPrice),
  };
}

// ─────────────────────────────────────────────
// Listing-page parsing
// ─────────────────────────────────────────────

function extractTotalHitCount($) {
  const raw =
    $('[data-test="total-hit-count"]').first().text() ||
    $('[data-test="total-hit-count"]').first().attr("aria-label") ||
    "";
  const n = parseInt(String(raw).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function extractNextPageUrl($) {
  const href = $('[data-test="plp-load-more"]').first().attr("href");
  if (!href) return null;
  return normalizeUrl(absolutizeUrl(href, BASE_URL));
}

function parseCategoryPage(html, sourceUrl) {
  const $ = cheerio.load(html);
  const deals = [];

  $(".productTile__root").each((_, el) => {
    const $product = $(el);

    const $link = $product.find('a[href*="/p/"]').first();
    const href = $link.attr("href") || "";
    const listingURL = absolutizeUrl(href);
    if (!listingURL) return;

    const model = normalizeText(
      $product.find('[data-test="product-name"]').first().text() ||
      $product.find(".productTile__title").first().text() ||
      ""
    );
    if (!model) return;

    const classification = normalizeText(
      $product.find('[data-test="product-classification"]').first().text() || ""
    );

    const { gender, shoeType } = parseClassification(classification);
    const { salePrice, originalPrice } = extractPricesFromText($product.text());

    // Only keep honest sale deals
    if (salePrice == null || originalPrice == null) return;
    if (salePrice >= originalPrice) return;

    const imageURL = extractImageFromTile($product, $) || deriveImageFromProductUrl(listingURL);
    const brand = "ASICS";
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
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,
      store: STORE,
      listingURL,
      imageURL,
      gender,
      shoeType,
    });
  });

  const totalHitCount = extractTotalHitCount($);
  const nextPageUrl = extractNextPageUrl($);

  return {
    deals,
    totalHitCount,
    nextPageUrl,
    rawTileCount: $(".productTile__root").length,
  };
}

// ─────────────────────────────────────────────
// Deduplication
// ─────────────────────────────────────────────

function deduplicateDeals(deals) {
  const seen = new Set();

  return deals.filter((d) => {
    const key = normalizeUrl(d.listingURL || d.listingName || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─────────────────────────────────────────────
// Scrape one listing page
// ─────────────────────────────────────────────

async function scrapeListingPage(app, url) {
  console.log(`[ASICS] Scraping listing page: ${url}`);

  const result = await app.scrapeUrl(url, {
    formats: ["html"],
    waitFor: FIRECRAWL_WAIT_MS,
    timeout: FIRECRAWL_TIMEOUT_MS,
  });

  if (!result?.html) {
    throw new Error("No HTML returned");
  }

  return parseCategoryPage(result.html, url);
}

// ─────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────

async function scrapeAllAsicsSales() {
  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
  const start = Date.now();

  let currentUrl = normalizeUrl(START_URL);
  const visited = new Set();
  const sourceUrls = [];
  const pageResults = [];
  let allDeals = [];
  let pagesFetched = 0;
  let expectedTotal = null;

  console.log("[ASICS] Starting combined-page pagination scrape...");

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    if (!currentUrl) {
      console.log("[ASICS] No next page URL. Stopping.");
      break;
    }

    if (visited.has(currentUrl)) {
      console.log("[ASICS] Repeated page URL detected. Stopping.");
      break;
    }

    visited.add(currentUrl);
    sourceUrls.push(currentUrl);

    try {
      const parsed = await scrapeListingPage(app, currentUrl);
      const pageDeals = parsed.deals || [];
      const uniqueBefore = allDeals.length;

      allDeals.push(...pageDeals);
      allDeals = deduplicateDeals(allDeals);

      const addedUnique = allDeals.length - uniqueBefore;

      if (expectedTotal == null && parsed.totalHitCount != null) {
        expectedTotal = parsed.totalHitCount;
      }

      pagesFetched++;

      const nextPageUrl = parsed.nextPageUrl ? normalizeUrl(parsed.nextPageUrl) : null;
      const pageNumber = getPageNumberFromUrl(currentUrl);

      pageResults.push({
        page: pageNumber,
        url: currentUrl,
        success: true,
        rawTileCount: parsed.rawTileCount,
        count: pageDeals.length,
        addedUnique,
        totalHitCount: parsed.totalHitCount,
        nextPageUrl,
        error: null,
      });

      console.log(
        `[ASICS] Page ${pageNumber}: ${pageDeals.length} deals, +${addedUnique} unique, total unique ${allDeals.length}`
      );

      if (pageDeals.length === 0) {
        console.log("[ASICS] Page returned 0 deals. Stopping.");
        break;
      }

      if (!nextPageUrl) {
        console.log("[ASICS] No load-more href found. Stopping.");
        break;
      }

      if (expectedTotal != null && allDeals.length >= expectedTotal) {
        console.log(`[ASICS] Reached expected total (${expectedTotal}). Stopping.`);
        break;
      }

      currentUrl = nextPageUrl;

      const delay = randomDelay();
      console.log(`[ASICS] Waiting ${delay}ms before next page...`);
      await sleep(delay);
    } catch (err) {
      const pageNumber = getPageNumberFromUrl(currentUrl);

      pageResults.push({
        page: pageNumber,
        url: currentUrl,
        success: false,
        rawTileCount: 0,
        count: 0,
        addedUnique: 0,
        totalHitCount: null,
        nextPageUrl: null,
        error: err.message,
      });

      console.error(`[ASICS] Error on page ${pageNumber}:`, err.message);
      break;
    }
  }

  const uniqueDeals = deduplicateDeals(allDeals);
  const scrapeDurationMs = Date.now() - start;

  console.log(`[ASICS] Complete. ${uniqueDeals.length} unique deals in ${scrapeDurationMs}ms`);

  return {
    deals: uniqueDeals,
    sourceUrls,
    pagesFetched,
    pageResults,
    scrapeDurationMs,
    expectedTotal,
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
  
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  

  const start = Date.now();

  try {
    const {
      deals,
      sourceUrls,
      pagesFetched,
      pageResults,
      scrapeDurationMs,
      expectedTotal,
    } = await scrapeAllAsicsSales();

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
      expectedTotal,
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
      expectedTotal: output.expectedTotal,
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
