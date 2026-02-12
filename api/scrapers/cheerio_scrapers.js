// api/cheerio_scrapers.js
// Daily scraper for running shoe deals (CHEERIO ONLY)
// Runs via Vercel Cron
//
// OUTPUT (per store blob):
//   { lastUpdated, scrapeDurationMs, scraperResult, deals }
//
// Blobs (public, stable names):
//   running-warehouse.json
//   fleet-feet.json
//   lukes-locker.json
//   marathon-sports.json
//
// -----------------------------------------------------------------------------
// ✅ SCRAPER TOGGLES (edit these booleans to enable/disable stores)
// -----------------------------------------------------------------------------
// - Set a store to true  => it will run and write its blob
// - Set a store to false => it will be skipped (NO scrape, NO blob write)
// - The API response will still include a "skipped" entry for disabled stores.
// -----------------------------------------------------------------------------
const SCRAPER_TOGGLES = {
  RUNNING_WAREHOUSE: false,
  FLEET_FEET: false,
  LUKES_LOCKER: true,
  MARATHON_SPORTS: false,
};

const axios = require("axios");
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");
const { cleanModelName } = require("../modelNameCleaner");

/** -------------------- Small helpers -------------------- **/

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function cleanTitleText(raw) {
  let t = normalizeWhitespace(raw);
  t = t.replace(/^(extra\s*\d+\s*%\s*off)\s+/i, "");
  t = t.replace(/^(sale|clearance|closeout)\s+/i, "");
  return normalizeWhitespace(t);
}

function absolutizeUrl(u, base) {
  let url = String(u || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return base.replace(/\/+$/, "") + url;
  return base.replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
}

function pickBestImgUrl($, $img, base) {
  if (!$img || !$img.length) return null;

  const direct =
    $img.attr("data-src") ||
    $img.attr("data-original") ||
    $img.attr("data-lazy") ||
    $img.attr("src");

  const srcset = $img.attr("data-srcset") || $img.attr("srcset");

  let candidate = (direct || "").trim();

  if (!candidate && srcset) {
    const parts = srcset
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1] || "";
    candidate = (last.split(" ")[0] || "").trim();
  }

  if (!candidate || candidate.startsWith("data:") || candidate === "#") return null;
  return absolutizeUrl(candidate, base);
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBrandModel(title) {
  title = cleanTitleText(title);
  if (!title) return { brand: "Unknown", model: "" };

  const brands = [
    "361 Degrees",
    "adidas",
    "Allbirds",
    "Altra",
    "ASICS",
    "Brooks",
    "Craft",
    "Diadora",
    "HOKA",
    "Hylo Athletics",
    "INOV8",
    "Inov-8",
    "Karhu",
    "La Sportiva",
    "Lems",
    "Merrell",
    "Mizuno",
    "New Balance",
    "Newton",
    "Nike",
    "norda",
    "Nnormal",
    "On Running",
    "On",
    "Oofos",
    "Pearl Izumi",
    "Puma",
    "Reebok",
    "Salomon",
    "Saucony",
    "Saysh",
    "Skechers",
    "Skora",
    "The North Face",
    "Topo Athletic",
    "Topo",
    "Tyr",
    "Under Armour",
    "Vibram FiveFingers",
    "Vibram",
    "Vivobarefoot",
    "VJ Shoes",
    "VJ",
    "X-Bionic",
    "Xero Shoes",
    "Xero",
  ];

  const brandsSorted = [...brands].sort((a, b) => b.length - a.length);

  let brand = "Unknown";
  let model = title;

  for (const b of brandsSorted) {
    const escaped = escapeRegExp(b);
    const regex = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i");
    if (regex.test(title)) {
      brand = b;
      model = title.replace(regex, " ").trim().replace(/\s+/g, " ");
      break;
    }
  }

  model = cleanModelName(model);
  return { brand, model };
}

// Detect gender from URL or listing text
function detectGender(listingURL, listingName) {
  const urlLower = (listingURL || "").toLowerCase();
  const nameLower = (listingName || "").toLowerCase();
  const combined = urlLower + " " + nameLower;

  if (/\/mens?[\/-]|\/men\/|men-/.test(urlLower)) return "mens";
  if (/\/womens?[\/-]|\/women\/|women-/.test(urlLower)) return "womens";

  if (/\b(men'?s?|male)\b/i.test(combined)) return "mens";
  if (/\b(women'?s?|female|ladies)\b/i.test(combined)) return "womens";
  if (/\bunisex\b/i.test(combined)) return "unisex";

  return "unknown";
}

// Detect shoe type from listing text or model
function detectShoeType(listingName, model) {
  const combined = ((listingName || "") + " " + (model || "")).toLowerCase();

  if (/\b(trail|speedgoat|peregrine|hierro|wildcat|terraventure|speedcross|ultra|summit)\b/i.test(combined)) {
    return "trail";
  }

  if (/\b(track|spike|dragonfly|zoom.*victory|ja fly|ld|md)\b/i.test(combined)) {
    return "track";
  }

  if (
    /\b(road|kayano|clifton|ghost|pegasus|nimbus|cumulus|gel|glycerin|kinvara|ride|triumph|novablast)\b/i.test(
      combined
    )
  ) {
    return "road";
  }

  // If unstated, you said you'd rather not guess — use unknown.
  return "unknown";
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function randomDelay(min = 3000, max = 5000) {
  const wait = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, wait));
}

/** -------------------- UNIVERSAL PRICE EXTRACTOR -------------------- **/

function extractDollarAmounts(text) {
  if (!text) return [];
  const matches = text.match(/\$\s*[\d,]+(?:\.\d{1,2})?/g);
  if (!matches) return [];
  return matches
    .map((m) => parseFloat(m.replace(/[$,\s]/g, "")))
    .filter((n) => Number.isFinite(n));
}

function extractSuperscriptPrices($, $element) {
  const prices = [];
  if (!$ || !$element || !$element.find) return prices;

  $element.find("sup, .cents, .price-cents, small").each((_, el) => {
    const $centsEl = $(el);
    const centsText = $centsEl.text().trim();
    if (!/^\d{1,2}$/.test(centsText)) return;

    const $parent = $centsEl.parent();
    const parentTextWithoutChildren = $parent.clone().children().remove().end().text();
    const dollarMatch = parentTextWithoutChildren.match(/\$\s*(\d+)/);
    if (!dollarMatch) return;

    const dollars = parseInt(dollarMatch[1], 10);
    const cents = parseInt(centsText, 10);
    if (!Number.isFinite(dollars) || !Number.isFinite(cents)) return;

    const price = dollars + cents / 100;
    if (price >= 10 && price < 1000) prices.push(price);
  });

  return prices;
}

function findSaveAmount(text) {
  if (!text) return null;
  const match = text.match(/save\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const amount = parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

function findPercentOff(text) {
  if (!text) return null;
  const match = text.match(/(\d+)\s*%\s*off/i);
  if (!match) return null;
  const percent = parseInt(match[1], 10);
  return percent > 0 && percent < 100 ? percent : null;
}

/**
 * Returns: { salePrice: number|null, originalPrice: number|null, valid: boolean }
 */
function extractPrices($, $element, fullText) {
  let prices = extractDollarAmounts(fullText);

  const supPrices = extractSuperscriptPrices($, $element);
  if (supPrices.length) prices = prices.concat(supPrices);

  prices = prices.filter((p) => Number.isFinite(p) && p >= 10 && p < 1000);
  if (!prices.length) return { salePrice: null, originalPrice: null, valid: false };

  prices = [...new Set(prices.map((p) => p.toFixed(2)))].map((s) => parseFloat(s));

  if (prices.length < 2) return { salePrice: null, originalPrice: null, valid: false };
  if (prices.length > 3) return { salePrice: null, originalPrice: null, valid: false };

  prices.sort((a, b) => b - a);

  // 2 prices: [original, sale]
  if (prices.length === 2) {
    const original = prices[0];
    const sale = prices[1];
    if (!(sale < original)) return { salePrice: null, originalPrice: null, valid: false };

    const discountPercent = ((original - sale) / original) * 100;
    if (discountPercent < 5 || discountPercent > 90) {
      return { salePrice: null, originalPrice: null, valid: false };
    }
    return { salePrice: sale, originalPrice: original, valid: true };
  }

  // 3 prices: try to detect "save $X" or "% off"
  if (prices.length === 3) {
    const original = prices[0];
    const remaining = prices.slice(1);
    const [p1, p2] = remaining;
    const tol = 1;

    const saveAmount = findSaveAmount(fullText);
    if (saveAmount != null) {
      const isP1Save = Math.abs(p1 - saveAmount) <= tol;
      const isP2Save = Math.abs(p2 - saveAmount) <= tol;

      if (isP1Save && !isP2Save) {
        const sale = p2;
        const pct = ((original - sale) / original) * 100;
        if (pct >= 5 && pct <= 90 && sale < original) return { salePrice: sale, originalPrice: original, valid: true };
      } else if (isP2Save && !isP1Save) {
        const sale = p1;
        const pct = ((original - sale) / original) * 100;
        if (pct >= 5 && pct <= 90 && sale < original) return { salePrice: sale, originalPrice: original, valid: true };
      }
    }

    const percentOff = findPercentOff(fullText);
    if (percentOff != null) {
      const expectedSale = original * (1 - percentOff / 100);
      let saleCandidate = null;
      let bestDiff = Infinity;

      for (const p of remaining) {
        const diff = Math.abs(p - expectedSale);
        if (diff <= tol && diff < bestDiff) {
          bestDiff = diff;
          saleCandidate = p;
        }
      }

      if (saleCandidate != null) {
        const pct = ((original - saleCandidate) / original) * 100;
        if (pct >= 5 && pct <= 90 && saleCandidate < original) {
          return { salePrice: saleCandidate, originalPrice: original, valid: true };
        }
      }
    }

    // fallback: choose the larger of remaining as sale
    const sale = Math.max(...remaining);
    const pct = ((original - sale) / original) * 100;
    if (pct >= 5 && pct <= 90 && sale < original) return { salePrice: sale, originalPrice: original, valid: true };

    return { salePrice: null, originalPrice: null, valid: false };
  }

  return { salePrice: null, originalPrice: null, valid: false };
}

/** -------------------- Site scrapers (CHEERIO) -------------------- **/

 async function scrapeRunningWarehouse() {
  const STORE = "Running Warehouse";

  const urls = [
    "https://www.runningwarehouse.com/catpage-SALEMS.html",
    "https://www.runningwarehouse.com/catpage-SALEWS.html",
  ];

  const deals = [];
  const seenUrls = new Set();

  for (const pageUrl of urls) {
    const response = await axios.get(pageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: 30000,
    });

    const $ = cheerio.load(response.data);

    $("a").each((_, el) => {
      const anchor = $(el);
      let text = normalizeWhitespace(anchor.text());
      text = text.replace(/\*\s*$/, "").trim();

      const href = anchor.attr("href") || "";
      if (!href) return;

      const { salePrice, originalPrice, valid } = extractPrices($, anchor, text);
      if (!valid || !salePrice || !Number.isFinite(salePrice)) return;

      const listingName = cleanTitleText(text);
      if (!listingName) return;

      let listingURL = href.trim();
      if (!/^https?:\/\//i.test(listingURL)) {
        listingURL = listingURL.startsWith("//")
          ? "https:" + listingURL
          : `https://www.runningwarehouse.com/${listingURL.replace(/^\/+/, "")}`;
      }

      if (seenUrls.has(listingURL)) return;
      seenUrls.add(listingURL);

      let imageURL = null;
      const container = anchor.closest("tr,td,div,li,article");
      if (container.length) {
        const imgEl = container.find("img").first();
        imageURL = pickBestImgUrl($, imgEl, "https://www.runningwarehouse.com");
      }

      const { brand, model } = parseBrandModel(listingName);
      const discountPercent = computeDiscountPercent(originalPrice, salePrice);

      deals.push({
        listingName,
        brand,
        model,
        salePrice,
        originalPrice: Number.isFinite(originalPrice) && originalPrice > salePrice ? originalPrice : null,
        discountPercent,
        store: STORE,
        listingURL,
        imageURL,
        gender: detectGender(listingURL, listingName),
        shoeType: detectShoeType(listingName, model),
      });
    });

    await randomDelay();
  }

  return deals;
}

 async function scrapeFleetFeet() {
  const STORE = "Fleet Feet";

  const urls = [
    "https://www.fleetfeet.com/browse/shoes/mens?clearance=on",
    "https://www.fleetfeet.com/browse/shoes/womens?clearance=on",
  ];

  const deals = [];
  const seenUrls = new Set();

  for (const pageUrl of urls) {
    const response = await axios.get(pageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 30000,
    });

    const $ = cheerio.load(response.data);

    $('a[href^="/products/"]').each((_, el) => {
      const $link = $(el);
      const href = ($link.attr("href") || "").trim();
      if (!href || !href.startsWith("/products/")) return;

      const fullText = normalizeWhitespace($link.text());
      const listingName = cleanTitleText(fullText);
      if (!listingName) return;

      const { salePrice, originalPrice, valid } = extractPrices($, $link, fullText);
      if (!valid || !salePrice || salePrice <= 0) return;

      const listingURL = absolutizeUrl(href, "https://www.fleetfeet.com");
      if (seenUrls.has(listingURL)) return;
      seenUrls.add(listingURL);

      let $img = $link.find("img").first();
      if (!$img.length) $img = $link.closest("div, article, li").find("img").first();
      const imageURL = pickBestImgUrl($, $img, "https://www.fleetfeet.com");

      const { brand, model } = parseBrandModel(listingName);
      const discountPercent = computeDiscountPercent(originalPrice, salePrice);

      deals.push({
        listingName,
        brand,
        model,
        salePrice,
        originalPrice: originalPrice || null,
        discountPercent,
        store: STORE,
        listingURL,
        imageURL,
        gender: detectGender(listingURL, listingName),
        shoeType: detectShoeType(listingName, model),
      });
    });

    await randomDelay();
  }

  return deals;
}

async function scrapeLukesLocker() {
  const STORE = "Luke's Locker";
  const base = "https://lukeslocker.com";
  const handle = "closeout";

  const deals = [];
  const seenUrls = new Set();

  // Shopify collection JSON endpoint (does NOT require the page to be server-rendered)
  // Pages are 1-based. Stop when we get < limit products.
  const limit = 250;

  for (let page = 1; page <= 10; page++) {
    const url = `${base}/collections/${handle}/products.json?limit=${limit}&page=${page}`;

    const resp = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 30000,
    });

    const products = resp?.data?.products;
    if (!Array.isArray(products) || products.length === 0) break;

    for (const p of products) {
      const titleRaw = normalizeWhitespace(p?.title || "");
      const listingName = cleanTitleText(titleRaw);
      if (!listingName) continue;

      // Shopify vendor is the brand line you said is on the page
      const brand = normalizeWhitespace(p?.vendor || "") || "Unknown";

      const listingURL = `${base}/products/${p?.handle || ""}`;
      if (!p?.handle) continue;
      if (seenUrls.has(listingURL)) continue;
      seenUrls.add(listingURL);

      // image
      let imageURL = null;
      if (Array.isArray(p?.images) && p.images.length) {
        imageURL = String(p.images[0]).trim() || null;
      } else if (p?.image && p.image.src) {
        imageURL = String(p.image.src).trim() || null;
      }

      // prices from variants: choose the best "on sale" variant
      // requirement: must have BOTH sale + original and original > sale
      let bestSale = null;
      let bestOriginal = null;

      const variants = Array.isArray(p?.variants) ? p.variants : [];
      for (const v of variants) {
        const sale = parseFloat(String(v?.price ?? "").replace(/[^0-9.]/g, ""));
        const orig = parseFloat(String(v?.compare_at_price ?? "").replace(/[^0-9.]/g, ""));

        if (!Number.isFinite(sale) || !Number.isFinite(orig)) continue;
        if (!(orig > sale && sale > 0)) continue;

        // pick the lowest sale (best deal for users)
        if (bestSale == null || sale < bestSale) {
          bestSale = sale;
          bestOriginal = orig;
        }
      }

      if (!Number.isFinite(bestSale) || !Number.isFinite(bestOriginal)) continue;

      const discountPercent = computeDiscountPercent(bestOriginal, bestSale);
      if (!Number.isFinite(discountPercent) || discountPercent < 5 || discountPercent > 90) continue;

      // model: title minus brand, then cleaned
      let model = listingName;
      if (brand && brand !== "Unknown") {
        const escaped = escapeRegExp(brand);
        model = model.replace(new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i"), " ");
        model = normalizeWhitespace(model);
      }
      model = cleanModelName(model);

      deals.push({
        listingName,
        brand,
        model,
        salePrice: bestSale,
        originalPrice: bestOriginal,
        discountPercent,
        store: STORE,
        listingURL,
        imageURL,

        // Gender is mixed on page: detect from title ONLY
        gender: detectGender("", listingName),

        // per your requirement
        shoeType: "unknown",
      });
    }

    if (products.length < limit) break;
    await randomDelay(800, 1400); // lighter delay for JSON paging
  }

  return deals;
}

async function scrapeMarathonSports() {
  const STORE = "Marathon Sports";

  const urls = [
    "https://www.marathonsports.com/shop/mens/shoes?sale=1",
    "https://www.marathonsports.com/shop/womens/shoes?sale=1",
    "https://www.marathonsports.com/shop?q=running%20shoes&sort=discount",
  ];

  const deals = [];
  const seenUrls = new Set();

  for (const pageUrl of urls) {
    const response = await axios.get(pageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 30000,
    });

    const $ = cheerio.load(response.data);

    $('a[href^="/products/"]').each((_, el) => {
      const $link = $(el);
      const href = ($link.attr("href") || "").trim();
      if (!href) return;

      const listingURL = absolutizeUrl(href, "https://www.marathonsports.com");
      if (seenUrls.has(listingURL)) return;

      const $container = $link.closest("div, article, li").filter(function () {
        return $(this).text().toLowerCase().includes("price");
      });

      if (!$container.length) return;

      const containerText = normalizeWhitespace($container.text());
      if (!containerText.includes("$") || !containerText.toLowerCase().includes("price")) return;

      let listingName = "";
      const $titleEl = $container.find("h2, h3, .product-title, .product-name, [class*='title']").first();

      if ($titleEl.length) listingName = normalizeWhitespace($titleEl.text());
      listingName = cleanTitleText(listingName);
      if (!listingName) return;

      const { salePrice, originalPrice, valid } = extractPrices($, $container, containerText);
      if (!valid || !salePrice || salePrice <= 0) return;

      let $img = $link.find("img").first();
      if (!$img.length) $img = $container.find("img").first();
      const imageURL = pickBestImgUrl($, $img, "https://www.marathonsports.com");

      seenUrls.add(listingURL);

      const { brand, model } = parseBrandModel(listingName);
      const discountPercent = computeDiscountPercent(originalPrice, salePrice);

      deals.push({
        listingName,
        brand,
        model,
        salePrice,
        originalPrice: originalPrice || null,
        discountPercent,
        store: STORE,
        listingURL,
        imageURL,
        gender: detectGender(listingURL, listingName),
        shoeType: detectShoeType(listingName, model),
      });
    });

    await randomDelay();
  }

  return deals;
}

/** -------------------- Per-store blob writer -------------------- **/

async function runAndSaveStore({ storeName, blobName, via, fn }) {
  const start = Date.now();
  const timestamp = nowIso();

  try {
    const deals = await fn();
    const durationMs = Date.now() - start;

    const scraperResult = {
      scraper: storeName,
      ok: true,
      count: Array.isArray(deals) ? deals.length : 0,
      durationMs,
      timestamp,
      via,
      error: null,
    };

    const output = {
      lastUpdated: timestamp,
      scrapeDurationMs: durationMs,
      scraperResult,
      deals: Array.isArray(deals) ? deals : [],
    };

    const blob = await put(blobName, JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return { ...scraperResult, blobUrl: blob.url };
  } catch (err) {
    const durationMs = Date.now() - start;

    const scraperResult = {
      scraper: storeName,
      ok: false,
      count: 0,
      durationMs,
      timestamp,
      via,
      error: err?.message || "Unknown error",
    };

    // Still write an output blob so merge-deals can see "ok:false" and 0 deals.
    const output = {
      lastUpdated: timestamp,
      scrapeDurationMs: durationMs,
      scraperResult,
      deals: [],
    };

    const blob = await put(blobName, JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return { ...scraperResult, blobUrl: blob.url };
  }
}

function skippedResult(storeName, blobName) {
  return {
    scraper: storeName,
    ok: true,
    skipped: true,
    count: 0,
    durationMs: 0,
    timestamp: nowIso(),
    via: "toggle-disabled",
    error: null,
    blobUrl: null, // intentionally not writing a blob when skipped
    blobName,
  };
}

/** -------------------- Main handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // Optional cron auth (recommended)
  // const cronSecret = process.env.CRON_SECRET;
  // if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const overallStartTime = Date.now();
  const runTimestamp = nowIso();

  try {
    const results = {};

    // ---------------- RUNNING WAREHOUSE ----------------
    if (SCRAPER_TOGGLES.RUNNING_WAREHOUSE) {
      results["Running Warehouse"] = await runAndSaveStore({
        storeName: "Running Warehouse",
        blobName: "running-warehouse.json",
        via: "cheerio",
        fn: scrapeRunningWarehouse,
      });
      await randomDelay();
    } else {
      results["Running Warehouse"] = skippedResult("Running Warehouse", "running-warehouse.json");
    }

    // ---------------- FLEET FEET ----------------
    if (SCRAPER_TOGGLES.FLEET_FEET) {
      results["Fleet Feet"] = await runAndSaveStore({
        storeName: "Fleet Feet",
        blobName: "fleet-feet.json",
        via: "cheerio",
        fn: scrapeFleetFeet,
      });
      await randomDelay();
    } else {
      results["Fleet Feet"] = skippedResult("Fleet Feet", "fleet-feet.json");
    }

    // ---------------- LUKE'S LOCKER ----------------
    if (SCRAPER_TOGGLES.LUKES_LOCKER) {
      results["Luke's Locker"] = await runAndSaveStore({
        storeName: "Luke's Locker",
        blobName: "lukes-locker.json",
        via: "cheerio",
        fn: scrapeLukesLocker,
      });
      await randomDelay();
    } else {
      results["Luke's Locker"] = skippedResult("Luke's Locker", "lukes-locker.json");
    }

    // ---------------- MARATHON SPORTS ----------------
    if (SCRAPER_TOGGLES.MARATHON_SPORTS) {
      results["Marathon Sports"] = await runAndSaveStore({
        storeName: "Marathon Sports",
        blobName: "marathon-sports.json",
        via: "cheerio",
        fn: scrapeMarathonSports,
      });
    } else {
      results["Marathon Sports"] = skippedResult("Marathon Sports", "marathon-sports.json");
    }

    const durationMs = Date.now() - overallStartTime;

    return res.status(200).json({
      success: true,
      timestamp: runTimestamp,
      duration: `${durationMs}ms`,
      toggles: SCRAPER_TOGGLES,
      stores: results,
      note:
        "Disabled stores are skipped (no scrape + no blob write). Enable/disable at top via SCRAPER_TOGGLES.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
      stack: process.env.NODE_ENV === "development" ? error?.stack : undefined,
    });
  }
};
