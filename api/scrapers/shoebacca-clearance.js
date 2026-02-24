// api/scrapers/shoebacca-clearance.js
// Scrapes Shoebacca clearance athletic running shoes using Shopify JSON API
// UPDATED: schema matches Brooks/ASICS (11 vars)
// DEBUG: cron secret check commented out

const { put } = require("@vercel/blob");

/** -------------------- Schema helpers (match Brooks/ASICS) -------------------- **/

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

/** -------------------- Classification helpers -------------------- **/

/**
 * Detect shoe type from product tags and title
 */
function detectShoeType(product) {
  const tags = (product.tags || []).map((tag) => String(tag).toLowerCase());
  const title = (product.title || "").toLowerCase();
  const combined = [...tags, title].join(" ");

  if (/\b(trail|mountain|off-road|hiking)\b/.test(combined)) return "trail";
  if (/\b(track|spike|racing|carbon)\b/.test(combined)) return "track";
  return "road";
}

/**
 * Detect gender from product tags/title/vendor
 * Returns: 'mens', 'womens', or 'unisex'
 */
function detectGender(product) {
  const tags = (product.tags || []).map((tag) => String(tag).toLowerCase());
  const title = (product.title || "").toLowerCase();
  const vendor = (product.vendor || "").toLowerCase();
  const allText = [...tags, title, vendor].join(" ");

  const hasMens =
    /\bmen'?s\b/i.test(allText) ||
    /\bmale\b/i.test(allText) ||
    tags.includes("men") ||
    tags.includes("mens");

  const hasWomens =
    /\bwomen'?s\b/i.test(allText) ||
    /\bwomans\b/i.test(allText) ||
    /\bfemale\b/i.test(allText) ||
    /\bladies\b/i.test(allText) ||
    /\bgirls\b/i.test(allText) ||
    tags.includes("women") ||
    tags.includes("womens") ||
    tags.includes("woman") ||
    tags.includes("ladies");

  if (hasMens && hasWomens) return "unisex";
  if (hasMens) return "mens";
  if (hasWomens) return "womens";
  return "unisex";
}

/** -------------------- Brand/model/image helpers -------------------- **/

function extractBrand(product) {
  const vendor = product.vendor || "";
  if (vendor && vendor !== "Unknown") return vendor;

  const title = product.title || "";
  const commonBrands = [
    "Nike",
    "Adidas",
    "ASICS",
    "Brooks",
    "New Balance",
    "Hoka",
    "HOKA",
    "Saucony",
    "Mizuno",
    "On",
    "Altra",
    "Salomon",
    "Reebok",
    "Under Armour",
    "Puma",
    "Skechers",
    "Topo Athletic",
    "Karhu",
    "Diadora",
    "Newton",
  ];

  for (const brand of commonBrands) {
    if (title.toLowerCase().includes(brand.toLowerCase())) return brand;
  }

  return "Unknown";
}

function extractModel(title, brand) {
  if (!title) return "";

  let model = title;

  if (brand && brand !== "Unknown") {
    const brandRegex = new RegExp(`^${brand}\\s+`, "i");
    model = model.replace(brandRegex, "");
  }

  return model
    .replace(/\s+men's$/i, "")
    .replace(/\s+women's$/i, "")
    .replace(/\s+unisex$/i, "")
    .replace(/\s+running\s+shoe(s)?$/i, "")
    .trim();
}

function getBestImageUrl(product) {
  if (product.image?.src) return product.image.src;

  if (product.images && product.images.length > 0) {
    const firstImg = product.images[0];
    return typeof firstImg === "string" ? firstImg : firstImg.src || null;
  }

  if (product.featured_image) return product.featured_image;

  return null;
}

/** -------------------- Shopify page fetch -------------------- **/

async function scrapeShoebaccaPage(baseUrl, page = 1) {
  const fetchUrl = `${baseUrl}/products.json?page=${page}&limit=250`;

  console.log(`[Shoebacca] Fetching page ${page}: ${fetchUrl}`);

  const startedAt = Date.now();

  try {
    const response = await fetch(fetchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const fetchDurationMs = Date.now() - startedAt;

    if (!response.ok) {
      console.error(`[Shoebacca] HTTP ${response.status} for page ${page}`);
      return {
        products: [],
        hasMore: false,
        success: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        url: fetchUrl,
        durationMs: fetchDurationMs,
      };
    }

    const data = await response.json();
    const products = data.products || [];
    const hasMore = products.length > 0;

    console.log(
      `[Shoebacca] Page ${page}: Found ${products.length} raw products (${fetchDurationMs}ms)`
    );

    return {
      products,
      hasMore,
      success: true,
      status: response.status,
      error: null,
      url: fetchUrl,
      durationMs: fetchDurationMs,
    };
  } catch (error) {
    const fetchDurationMs = Date.now() - startedAt;
    console.error(`[Shoebacca] Error fetching page ${page}:`, error.message);
    return {
      products: [],
      hasMore: false,
      success: false,
      status: null,
      error: error.message,
      url: fetchUrl,
      durationMs: fetchDurationMs,
    };
  }
}

async function scrapeAllPages(collectionUrl) {
  const allProducts = [];
  const pageResults = [];

  let page = 1;
  let hasMore = true;

  while (hasMore && page <= 10) {
    const result = await scrapeShoebaccaPage(collectionUrl, page);

    pageResults.push({
      page: `products.json page=${page}`,
      success: result.success,
      count: result.products.length,
      error: result.error || null,
      url: result.url,
      duration: `${result.durationMs}ms`,
      status: result.status,
    });

    if (result.products.length > 0) {
      allProducts.push(...result.products);
      page++;
    }

    hasMore = result.hasMore;

    // polite delay if there may be another page
    if (hasMore) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log(`[Shoebacca] Scraped ${page - 1} pages, ${allProducts.length} total products`);
  return { allProducts, pageResults };
}

/** -------------------- Filter + transform to 11-field schema -------------------- **/

function filterAndTransformProducts(products) {
  const filtered = [];

  for (const product of products) {
    const tags = (product.tags || []).map((tag) => String(tag).toLowerCase());
    const productType = (product.product_type || "").toLowerCase();
    const titleLower = (product.title || "").toLowerCase();

    const isRunning =
      tags.includes("running") ||
      productType.includes("running") ||
      titleLower.includes("running");

    if (!isRunning) continue;

    const variant = product.variants?.[0];
    if (!variant) continue;

    let salePrice = variant.price ? parseFloat(variant.price) : null;
    let originalPrice = variant.compare_at_price ? parseFloat(variant.compare_at_price) : null;

    salePrice = round2(salePrice);
    originalPrice = round2(originalPrice);

    // must have a valid sale price
    if (!Number.isFinite(salePrice) || salePrice <= 0) continue;

    // If both exist but swapped, flip
    if (Number.isFinite(originalPrice) && originalPrice > 0 && salePrice > originalPrice) {
      [salePrice, originalPrice] = [originalPrice, salePrice];
    }

    // If compare_at exists, require true discount (common Shopify semantics)
    if (Number.isFinite(originalPrice) && salePrice >= originalPrice) continue;

    const listingURL = `https://www.shoebacca.com/products/${product.handle}`;

    const brand = extractBrand(product);
    const model = extractModel(product.title, brand);
    const listingName = `${brand} ${model}`.trim();

    const imageURL = getBestImageUrl(product);
    const gender = detectGender(product);
    const shoeType = detectShoeType(product);

    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    filtered.push({
      listingName,
      brand,
      model,
      salePrice,
      originalPrice,
      discountPercent,
      store: "Shoebacca",
      listingURL,
      imageURL: imageURL || null,
      gender,
      shoeType,
    });
  }

  return filtered;
}

/** -------------------- Main runner -------------------- **/

async function scrapeShoebaccaClearance() {
  console.log("[Shoebacca] Starting clearance scrape...");

  const collectionUrl = "https://www.shoebacca.com/collections/clearance-athletic";

  const { allProducts: rawProducts, pageResults } = await scrapeAllPages(collectionUrl);
  console.log(`[Shoebacca] Total raw products scraped: ${rawProducts.length}`);

  const deals = filterAndTransformProducts(rawProducts);
  console.log(`[Shoebacca] Filtered to ${deals.length} running shoes`);

  const dealsByGender = {
    mens: deals.filter((p) => p.gender === "mens").length,
    womens: deals.filter((p) => p.gender === "womens").length,
    unisex: deals.filter((p) => p.gender === "unisex").length,
  };

  const dealsByShoeType = {
    road: deals.filter((p) => p.shoeType === "road").length,
    trail: deals.filter((p) => p.shoeType === "trail").length,
    track: deals.filter((p) => p.shoeType === "track").length,
  };

  const missingImages = deals.filter((p) => !p.imageURL).length;
  const missingOriginalPrices = deals.filter((p) => !p.originalPrice).length;

  console.log(`[Shoebacca] By Gender:`, dealsByGender);
  console.log(`[Shoebacca] By Shoe Type:`, dealsByShoeType);
  console.log(`[Shoebacca] Missing images: ${missingImages}`);
  console.log(`[Shoebacca] Missing original prices: ${missingOriginalPrices}`);

  return {
    deals,
    dealsByGender,
    dealsByShoeType,
    pageResults,
    sourceCollectionUrl: collectionUrl,
  };
}

/** -------------------- Vercel handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

const CRON_SECRET = String(process.env.CRON_SECRET || "").trim();
if (CRON_SECRET) {
  const auth = String(req.headers.authorization || "").trim();
  const xCron = String(req.headers["x-cron-secret"] || "").trim();
  const ok = auth === `Bearer ${CRON_SECRET}` || xCron === CRON_SECRET;

  if (!ok) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
}


  const start = Date.now();

  try {
    const { deals, dealsByGender, dealsByShoeType, pageResults, sourceCollectionUrl } =
      await scrapeShoebaccaClearance();

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "Shoebacca",
      segments: ["Clearance Athletic - Running Shoes"],
      sourceCollectionUrl,
      totalDeals: deals.length,
      dealsByGender,
      dealsByShoeType,
      pageResults,
      deals,
    };

    const blob = await put("shoebacca-clearance.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;

    console.log(`[Shoebacca] ✓ Complete! ${deals.length} deals in ${duration}ms`);
    console.log(`[Shoebacca] Blob URL: ${blob.url}`);

    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      dealsByGender,
      dealsByShoeType,
      pageResults,
      sourceCollectionUrl,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (error) {
    console.error("[Shoebacca] Fatal error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
      duration: `${Date.now() - start}ms`,
    });
  }
};
