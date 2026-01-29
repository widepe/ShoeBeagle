// api/scrapers/brooks-running.js
// Brooks Sale Scraper (Firecrawl + Cheerio)
// Output schema (per deal):
//   listing, brand, model, salePrice, originalPrice, discountPercent,
//   store, listingURL, imageURL, gender, shoeType

const FirecrawlApp = require("@mendable/firecrawl-js").default;
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

/** -------------------- Schema helpers -------------------- **/

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

function absolutizeUrl(maybeUrl, base) {
  const u = String(maybeUrl || "").trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return base.replace(/\/+$/, "") + u;
  return base.replace(/\/+$/, "") + "/" + u.replace(/^\/+/, "");
}

/** -------------------- Classification helpers -------------------- **/

function detectGender(listing, listingURL) {
  const combined = `${listing || ""} ${listingURL || ""}`.toLowerCase();

  if (/\b(men'?s?|male)\b/i.test(combined)) return "mens";
  if (/\b(women'?s?|female|ladies)\b/i.test(combined)) return "womens";
  if (/\bunisex\b/i.test(combined)) return "unisex";

  return "unknown";
}

function detectShoeType(listing, model) {
  const combined = `${listing || ""} ${model || ""}`.toLowerCase();

  // Trail indicators
  if (/\b(trail|cascadia|caldera|catamount)\b/i.test(combined)) return "trail";

  // Track/spike indicators
  if (/\b(track|spike|hyperion|elite)\b/i.test(combined)) return "track";

  // Default for Brooks
  return "road";
}

/** -------------------- Price extraction -------------------- **/

function parsePriceFromText(text) {
  const t = String(text || "");
  const m = t.match(/\$?\s*(\d+(?:\.\d{2})?)/);
  return m ? toNumber(m[1]) : null;
}

function extractPricesFromTile($product) {
  // Method 1: Common price containers/classes
  const $priceContainer = $product.find(
    ".m-product-tile__price-container, .price-container, [class*='price']"
  );

  const saleText =
    $priceContainer.find(".price-sales").text().trim() ||
    $priceContainer.find(".sales").text().trim() ||
    $priceContainer.find("[class*='sale']").text().trim() ||
    $product.find(".price-sales, .sales, [class*='sale-price']").text().trim();

  const origText =
    $priceContainer.find(".price-list").text().trim() ||
    $priceContainer.find("[class*='list']").text().trim() ||
    $priceContainer.find("[class*='original']").text().trim() ||
    $product.find(".price-list, [class*='original-price']").text().trim();

  let salePrice = parsePriceFromText(saleText);
  let originalPrice = parsePriceFromText(origText);

  // Method 2: fallback: parse multiple prices from all price-like text
  if (salePrice == null && originalPrice == null) {
    const allPriceText = $product.find("[class*='price']").text();
    const matches = allPriceText.match(/\$(\d+(?:\.\d{2})?)/g);

    if (matches && matches.length >= 2) {
      // Assume first is original, second is sale
      originalPrice = toNumber(matches[0]);
      salePrice = toNumber(matches[1]);
    } else if (matches && matches.length === 1) {
      salePrice = toNumber(matches[0]);
    }
  }

  // Sanity: if both exist but swapped, flip
  if (salePrice != null && originalPrice != null && salePrice > originalPrice) {
    [salePrice, originalPrice] = [originalPrice, salePrice];
  }

  // Round for consistency
  salePrice = round2(salePrice);
  originalPrice = round2(originalPrice);

  return { salePrice, originalPrice };
}

/** -------------------- HTML parsing -------------------- **/

function extractBrooksDeals(html) {
  const $ = cheerio.load(html);
  const deals = [];
  const base = "https://www.brooksrunning.com";

  // Brooks uses .o-products-grid__item for tiles
  $(".o-products-grid__item").each((_, el) => {
    const $tile = $(el);
    const $content = $tile.find(".o-products-grid__item-content");

    // Brooks keeps name in data attribute
    const itemName = ($content.attr("data-cnstrc-item-name") || "").trim();
    if (!itemName) return;

    // Model (data attribute often just the model name; sometimes includes "Brooks")
    const model = itemName.replace(/^Brooks\s+/i, "").trim();
    const brand = "Brooks";
    const listingName = `${brand} ${model}`.trim();

    const { salePrice, originalPrice } = extractPricesFromTile($tile);

    // URL
    const href =
      $tile.find("a.m-product-tile__link").first().attr("href") ||
      $tile.find('a[href*="/products/"]').first().attr("href") ||
      $tile.find('a[href*="/p/"]').first().attr("href") ||
      $tile.find("a").first().attr("href") ||
      "";

    const listingURL = absolutizeUrl(href, base);

    // Image
    const imgSrc =
      $tile.find("img.m-product-tile__image").first().attr("src") ||
      $tile.find("img").first().attr("src") ||
      $tile.find("img").first().attr("data-src") ||
      "";

    const imageURL = absolutizeUrl(imgSrc, base);

    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    deals.push({
  listingName,
  brand,
  model,
  salePrice,
  originalPrice,
  discountPercent,
  store: "Brooks Running",
  listingURL,
  imageURL,
  gender: detectGender(listingName, listingURL),
  shoeType: detectShoeType(listingName, model),
});

  });

  return deals;
}

/** -------------------- Scrape runner -------------------- **/

async function scrapeBrooksSale() {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set");

  const app = new FirecrawlApp({ apiKey });

  console.log("[BROOKS] Starting Firecrawl scrape...");

  const scrapeResult = await app.scrapeUrl(
    "https://www.brooksrunning.com/en_us/sale/?prefn1=productType&prefv1=Shoes",
    {
      formats: ["html"],
      waitFor: 5000,
      timeout: 30000,
    }
  );

  if (!scrapeResult || !scrapeResult.html) {
    throw new Error("Firecrawl did not return HTML");
  }

  console.log("[BROOKS] Firecrawl complete. Parsing HTML...");
  const deals = extractBrooksDeals(scrapeResult.html);
  console.log(`[BROOKS] Parsed ${deals.length} deals`);

  return deals;
}

/** -------------------- Vercel handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // Uncomment when ready:
  // const cronSecret = process.env.CRON_SECRET;
  // if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const start = Date.now();

  try {
    const deals = await scrapeBrooksSale();

    const payload = {
      lastUpdated: new Date().toISOString(),
      store: "Brooks Running",
      segment: "sale-shoes",
      totalDeals: deals.length,
      deals,
    };

    const blob = await put("brooks-running.json", JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      blobUrl: blob.url,
      duration: `${Date.now() - start}ms`,
      timestamp: payload.lastUpdated,
    });
  } catch (error) {
    console.error("[BROOKS] Error:", error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
      duration: `${Date.now() - start}ms`,
      stack: process.env.NODE_ENV === "development" ? error?.stack : undefined,
    });
  }
};
