// api/scrapers/asics-sale.js
// Scrapes ASICS sale pages using Firecrawl + Cheerio
// OUTPUT SCHEMA (matches Brooks exactly, 11 fields):
//   listingName, brand, model, salePrice, originalPrice, discountPercent,
//   store, listingURL, imageURL, gender, shoeType

const FirecrawlApp = require("@mendable/firecrawl-js").default;
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

/** -------------------- Schema helpers (match Brooks style) -------------------- **/

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

/** -------------------- Image helpers (your robust logic kept) -------------------- **/

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

  // Example: .../p/ANA_1012B755-402.html
  const m = productUrl.match(/ANA_([A-Za-z0-9]+)-([A-Za-z0-9]+)\.html/i);
  if (!m) return null;

  const style = m[1];
  const color = m[2];

  return `https://images.asics.com/is/image/asics/${style}_${color}_SR_RT_GLB?$zoom$`;
}

/** -------------------- Classification helpers -------------------- **/

function detectShoeType(listingName, model) {
  const combined = `${listingName || ""} ${model || ""}`.toLowerCase();

  if (/\b(trail|trabuco|fujitrabuco|fuji)\b/i.test(combined)) return "trail";
  if (/\b(track|spike|japan|metaspeed|magic speed)\b/i.test(combined)) return "track";

  return "road";
}

/**
 * Determine gender from ASICS category codes in URL.
 * IMPORTANT: check women's FIRST because aa20106000 contains aa10106000 as substring.
 */
function detectGenderFromSourceUrl(sourceUrl) {
  const normalizedUrl = String(sourceUrl || "").toLowerCase();
  if (normalizedUrl.includes("aa20106000") || normalizedUrl.includes("womens-clearance")) return "womens";
  if (normalizedUrl.includes("aa10106000") || normalizedUrl.includes("mens-clearance")) return "mens";
  if (normalizedUrl.includes("leaving-asics") || normalizedUrl.includes("aa60400001")) return "unisex";
  return "unknown";
}

/** -------------------- Price extraction -------------------- **/

function extractTwoPricesFromText(text) {
  // ASICS tiles often contain two prices in order: original then sale
  const t = String(text || "");
  const matches = t.match(/\$(\d+(?:\.\d{2})?)/g);

  let originalPrice = null;
  let salePrice = null;

  if (matches && matches.length >= 2) {
    originalPrice = toNumber(matches[0]); // "$120.00"
    salePrice = toNumber(matches[1]);     // "$84.00"
  } else if (matches && matches.length === 1) {
    salePrice = toNumber(matches[0]);
  }

  // sanity: flip if swapped
  if (salePrice != null && originalPrice != null && salePrice > originalPrice) {
    [salePrice, originalPrice] = [originalPrice, salePrice];
  }

  return {
    salePrice: round2(salePrice),
    originalPrice: round2(originalPrice),
  };
}

/** -------------------- HTML parsing -------------------- **/

function extractAsicsDeals(html, sourceUrl) {
  const $ = cheerio.load(html);
  const deals = [];
  const base = "https://www.asics.com";

  const gender = detectGenderFromSourceUrl(sourceUrl);
  console.log(`[ASICS] Processing URL: ${sourceUrl} -> Gender: ${gender}`);

  const $products = $(".productTile__root");
  console.log(`[ASICS] Found ${$products.length} products for ${gender}`);

  $products.each((_, el) => {
    const $product = $(el);

    // Link + title
    const $link = $product.find('a[href*="/p/"]').first();
    const linkTitleRaw = ($link.attr("aria-label") || $link.text() || "").trim();

    let cleanTitle = linkTitleRaw
      .replace(/Next slide/gi, "")
      .replace(/Previous slide/gi, "")
      .replace(/\bSale\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    // Try to isolate model-ish portion (optional heuristic)
    const modelMatch = cleanTitle.match(/^([A-Z][A-Z\-\s\d]+?)(?=Men's|Women's|Unisex|\$)/i);
    if (modelMatch) cleanTitle = modelMatch[1].trim();

    if (!cleanTitle || cleanTitle.length < 3) return;

    // Prices
    const { salePrice, originalPrice } = extractTwoPricesFromText($product.text());

    // listingURL
    const href = $link.attr("href") || "";
    const listingURL = absolutizeUrl(href, base);
    if (!listingURL) return;

    // imageURL (robust)
    let imageURL = null;

    // 1) picture source srcset
    const sourceSrcset =
      $product.find("picture source[srcset]").first().attr("srcset") ||
      $product.find("picture source[data-srcset]").first().attr("data-srcset") ||
      null;

    imageURL = pickBestFromSrcset(sourceSrcset);

    // 2) img srcset variants
    if (!imageURL) {
      const $img = $product.find("img").first();
      const imgSrcset =
        $img.attr("srcset") ||
        $img.attr("data-srcset") ||
        $img.attr("data-lazy-srcset") ||
        null;
      imageURL = pickBestFromSrcset(imgSrcset);
    }

    // 3) img src variants
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

    // skip placeholders
    if (imageURL && (imageURL.startsWith("data:") || imageURL.toLowerCase().includes("placeholder"))) {
      imageURL = null;
    }

    // upgrade thumbnails
    if (imageURL && imageURL.includes("$variantthumbnail$")) {
      imageURL = imageURL.replace("$variantthumbnail$", "$zoom$");
    }

    // 5) final fallback: derive from product URL
    if (!imageURL) {
      const derived = buildAsicsImageFromProductUrl(listingURL);
      if (derived) imageURL = derived;
    }

    // Model + listingName
    const brand = "ASICS";
    const model = cleanTitle.replace(/^ASICS\s+/i, "").trim();
    const listingName = `${brand} ${model}`.trim();

    // Require at least one usable price
    if (salePrice == null && originalPrice == null) return;

    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    deals.push({
      listingName,
      brand,
      model,
      salePrice,
      originalPrice,
      discountPercent,
      store: "ASICS",
      listingURL,
      imageURL: imageURL || null,
      gender,
      shoeType: detectShoeType(listingName, model),
    });
  });

  return deals;
}

/** -------------------- Scrape runner -------------------- **/

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

    if (!scrapeResult || !scrapeResult.html) {
      throw new Error("Firecrawl did not return HTML");
    }

    const deals = extractAsicsDeals(scrapeResult.html, baseUrl);

    const missingImages = deals.filter((d) => !d.imageURL).length;
    console.log(`[ASICS] ${description}: Parsed ${deals.length} deals (${missingImages} missing images)`);

    return { success: true, deals, count: deals.length, url };
  } catch (error) {
    console.error(`[ASICS] Error scraping ${description}:`, error.message);
    return { success: false, deals: [], count: 0, error: error.message, url: baseUrl };
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
  const allDeals = [];

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

    if (result.success) allDeals.push(...result.deals);

    if (i < pages.length - 1) {
      console.log("[ASICS] Waiting 2 seconds before next page...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // Deduplicate by listingURL (schema-matched)
  const uniqueDeals = [];
  const seen = new Set();

  for (const d of allDeals) {
    const key = d.listingURL || "";
    if (!key) {
      uniqueDeals.push(d);
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      uniqueDeals.push(d);
    }
  }

  const missingImagesTotal = uniqueDeals.filter((d) => !d.imageURL).length;
  console.log(`[ASICS] Total unique deals: ${uniqueDeals.length} (${missingImagesTotal} missing images)`);
  console.log(`[ASICS] Results per page:`, results);

  return { deals: uniqueDeals, pageResults: results };
}

/** -------------------- Vercel handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // const cronSecret = process.env.CRON_SECRET;
  // if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
  //   return res.status(401).json({ error: "Unauthorized" });
  // }

  const start = Date.now();

  try {
    const { deals, pageResults } = await scrapeAllAsicsSales();

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "ASICS",
      segments: ["Men's Clearance", "Women's Clearance", "Last Chance Styles"],
      totalDeals: deals.length,
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
      success: true,
      totalDeals: deals.length,
      dealsByGender: output.dealsByGender,
      pageResults,
      blobUrl: blob.url,
      duration: `${Date.now() - start}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (error) {
    console.error("[ASICS] Fatal error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
      duration: `${Date.now() - start}ms`,
      stack: process.env.NODE_ENV === "development" ? error?.stack : undefined,
    });
  }
};
