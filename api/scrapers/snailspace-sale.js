// api/scrapers/snailspace-sale.js
// Scrapes A Snail's Pace Running Shop sale page using Firecrawl
// URL: https://shop.asnailspace.net/category/964/sale
// OUTPUT SCHEMA (matches Brooks/ASICS exactly, 11 fields):
//   listingName, brand, model, salePrice, originalPrice, discountPercent,
//   store, listingURL, imageURL, gender, shoeType

const FirecrawlApp = require("@mendable/firecrawl-js").default;
const cheerio = require("cheerio");
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

/**
 * Detect shoe type from title
 */
function detectShoeType(title) {
  const titleLower = (title || "").toLowerCase();

  if (/\b(trail|speedgoat|peregrine|hierro|wildcat|terraventure|speedcross|trabuco)\b/i.test(titleLower)) {
    return "trail";
  }

  if (/\b(track|spike|dragonfly|metaspeed|endorphin pro)\b/i.test(titleLower)) {
    return "track";
  }

  return "road";
}

/**
 * Detect gender from title and category/text context
 */
function detectGender(title, category) {
  const titleLower = (title || "").toLowerCase();
  const categoryLower = (category || "").toLowerCase();
  const combined = titleLower + " " + categoryLower;

  if (/\b(men'?s?|male|boys?)\b/i.test(combined)) return "mens";
  if (/\b(women'?s?|female|ladies|girls?)\b/i.test(combined)) return "womens";
  if (/\b(unisex|kids?|youth)\b/i.test(combined)) return "unisex";

  return "unisex";
}

/**
 * Extract brand from title
 */
function extractBrand(title) {
  if (!title) return "Unknown";

  const commonBrands = [
    "Nike", "Adidas", "ASICS", "Asics", "Brooks", "New Balance",
    "Hoka", "HOKA", "Saucony", "Mizuno", "On", "Altra",
    "Salomon", "Reebok", "Under Armour", "Puma", "Skechers",
    "Topo Athletic", "Karhu", "Diadora", "Newton", "Rabbit",
    "Feetures", "BALEGA", "Vuori", "OISELLE", "FLEKS"
  ];

  for (const brand of commonBrands) {
    if (title.toLowerCase().includes(brand.toLowerCase())) return brand;
  }

  const firstWord = title.trim().split(/\s+/)[0];
  if (firstWord && firstWord.length > 2) return firstWord;

  return "Unknown";
}

/**
 * Extract model name from title (remove brand)
 */
function extractModel(title, brand) {
  if (!title) return "";

  let model = title;

  if (brand && brand !== "Unknown") {
    const brandRegex = new RegExp(`^${brand}\\s+`, "i");
    model = model.replace(brandRegex, "");
  }

  model = model
    .replace(/\s+-\s+(men'?s?|women'?s?)$/i, "")
    .replace(/\s+men'?s?$/i, "")
    .replace(/\s+women'?s?$/i, "")
    .trim();

  return model;
}

/**
 * Parse price string to number
 */
function parsePrice(priceStr) {
  if (!priceStr) return null;

  const cleaned = String(priceStr).replace(/[^0-9.]/g, "").trim();
  const num = parseFloat(cleaned);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * Extract products from A Snail's Pace HTML
 * Outputs 11-field schema deals.
 */
function extractSnailsPaceProducts(html) {
  const $ = cheerio.load(html);
  const deals = [];

  console.log("[Snails Pace] Parsing HTML...");

  const $saleItems = $('*:contains("SALE")').closest("div, article, li");
  console.log(`[Snails Pace] Found ${$saleItems.length} items with SALE indicator`);

  const seenNames = new Set();

  $saleItems.each((_, el) => {
    const $item = $(el);
    const itemText = $item.text();

    if (!itemText.includes("$") || itemText.length < 10) return;

    const lines = itemText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    let title = "";
    let brandLine = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line === "SALE") continue;
      if (line.startsWith("$")) break;

      if (!title && line.length > 3 && !line.includes("$")) {
        title = line;
      } else if (title && !brandLine && line.length > 2 && !line.includes("$")) {
        brandLine = line;
        break;
      }
    }

    if (!title || title.length < 3) return;

    if (seenNames.has(title)) return;
    seenNames.add(title);

    const priceMatches = itemText.match(/\$\s*[\d,.]+/g);

    let salePrice = null;
    let originalPrice = null;

    if (priceMatches && priceMatches.length >= 2) {
      originalPrice = parsePrice(priceMatches[0]);
      salePrice = parsePrice(priceMatches[1]);
    } else if (priceMatches && priceMatches.length === 1) {
      salePrice = parsePrice(priceMatches[0]);
    }

    if (salePrice && originalPrice && salePrice > originalPrice) {
      [salePrice, originalPrice] = [originalPrice, salePrice];
    }

    salePrice = round2(salePrice);
    originalPrice = round2(originalPrice);

    if (!Number.isFinite(salePrice) || salePrice <= 0) return;

    const $link = $item.find('a[href*="/product/"]').first();
    let href = $link.attr("href") || "";
    if (href && !href.startsWith("http")) href = `https://shop.asnailspace.net${href}`;

    if (!href) return;

    let imageURL =
      $item.find("img").first().attr("src") ||
      $item.find("img").first().attr("data-src") ||
      null;

    if (imageURL && !imageURL.startsWith("http")) {
      if (imageURL.startsWith("//")) imageURL = `https:${imageURL}`;
      else if (imageURL.startsWith("/")) imageURL = `https://shop.asnailspace.net${imageURL}`;
    }

    const extractedBrand = brandLine || extractBrand(title);
    const model = extractModel(title, extractedBrand);

    const listingName = `${extractedBrand} ${model}`.trim();

    const gender = detectGender(title, itemText);
    const shoeType = detectShoeType(title);

    const isFootwear = /\b(shoe|sneaker|running|trainer|spike|boot|sandal|slide)\b/i.test(title);
    if (!isFootwear) {
      console.log(`[Snails Pace] Skipping non-footwear: ${title}`);
      return;
    }

    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    console.log(`[Snails Pace] ✓ Added: ${listingName} - $${salePrice}`);

    deals.push({
      listingName,
      brand: extractedBrand,
      model,
      salePrice,
      originalPrice,
      discountPercent,
      store: "A Snail's Pace",
      listingURL: href,
      imageURL: imageURL || null,
      gender,
      shoeType,
    });
  });

  console.log(`[Snails Pace] Extracted ${deals.length} products`);
  return deals;
}

/**
 * Scrape A Snail's Pace sale page
 */
async function scrapeSnailsPaceSale() {
  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

  console.log("[Snails Pace] Starting scrape...");

  const url = "https://shop.asnailspace.net/category/964/sale";

  try {
    console.log(`[Snails Pace] Fetching: ${url}`);

    const scrapeResult = await app.scrapeUrl(url, {
      formats: ["html"],
      waitFor: 8000,
      timeout: 45000,
    });

    const deals = extractSnailsPaceProducts(scrapeResult.html);

    const missingImages = deals.filter((p) => !p.imageURL).length;
    const missingOriginalPrices = deals.filter((p) => !p.originalPrice).length;

    console.log(`[Snails Pace] Found ${deals.length} products`);
    console.log(`[Snails Pace] Missing images: ${missingImages}`);
    console.log(`[Snails Pace] Missing original prices: ${missingOriginalPrices}`);

    return { success: true, deals, count: deals.length };
  } catch (error) {
    console.error("[Snails Pace] Error scraping:", error.message);
    return { success: false, deals: [], count: 0, error: error.message };
  }
}

/**
 * Vercel handler
 */
module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // TEMPORARILY TURNED OFF FOR DEBUGGING
  // const cronSecret = process.env.CRON_SECRET;
  // const providedSecret =
  //   req.headers["x-cron-secret"] || req.headers.authorization?.replace("Bearer ", "");
  // if (cronSecret && providedSecret !== cronSecret) {
  //   return res.status(401).json({ error: "Unauthorized" });
  // }

  const start = Date.now();

  try {
    const { deals, success, error } = await scrapeSnailsPaceSale();

    if (!success) {
      return res.status(500).json({
        success: false,
        error: error || "Scraping failed",
        duration: `${Date.now() - start}ms`,
      });
    }

    const dealsByGender = {
      mens: deals.filter((d) => d.gender === "mens").length,
      womens: deals.filter((d) => d.gender === "womens").length,
      unisex: deals.filter((d) => d.gender === "unisex").length,
    };

    const dealsByShoeType = {
      road: deals.filter((d) => d.shoeType === "road").length,
      trail: deals.filter((d) => d.shoeType === "trail").length,
      track: deals.filter((d) => d.shoeType === "track").length,
    };

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "A Snail's Pace",
      segments: ["Sale"],
      totalDeals: deals.length,
      dealsByGender,
      dealsByShoeType,
      deals,
    };

    const blob = await put("snailspace-sale.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;

    console.log(`[Snails Pace] ✓ Complete! ${deals.length} deals in ${duration}ms`);
    console.log(`[Snails Pace] Blob URL: ${blob.url}`);

    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      dealsByGender,
      dealsByShoeType,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (error) {
    console.error("[Snails Pace] Fatal error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`,
    });
  }
};
