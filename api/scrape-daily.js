// api/scrape-daily.js
// Daily scraper for running shoe deals (NON-Holabird)
// Runs once per day via Vercel Cron
//
// IMPORTANT:
// - This endpoint ONLY scrapes + writes deals-other.json (raw-ish merged list)
// - NO sanitization/filtering/deduping/sorting here anymore
// - All "final shaping" happens in /api/merge-deals.js
//
// Output blob: deals-other.json
// Top-level:
//   { lastUpdated, scrapeDurationMs, scraperResults, deals }
//
// Deal schema (per deal):
//   listingName, brand, model, salePrice, originalPrice, discountPercent,
//   store, listingURL, imageURL, gender, shoeType

const axios = require("axios");
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");
const { ApifyClient } = require("apify-client");
const { cleanModelName } = require("./modelNameCleaner");

const apifyClient = new ApifyClient({
  token: process.env.APIFY_TOKEN,
});

/** -------------------- Small helpers -------------------- **/

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function cleanTitleText(raw) {
  let t = normalizeWhitespace(raw);

  // remove common promo lead-ins
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
      model = title.replace(regex, " ").trim();
      model = model.replace(/\s+/g, " ");
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

  // Check URL patterns first (most reliable)
  if (/\/mens?[\/-]|\/men\/|men-/.test(urlLower)) return "mens";
  if (/\/womens?[\/-]|\/women\/|women-/.test(urlLower)) return "womens";

  // Check title/text patterns
  if (/\b(men'?s?|male)\b/i.test(combined)) return "mens";
  if (/\b(women'?s?|female|ladies)\b/i.test(combined)) return "womens";
  if (/\bunisex\b/i.test(combined)) return "unisex";

  return "unknown";
}

// Detect shoe type from listing text or model
function detectShoeType(listingName, model) {
  const combined = ((listingName || "") + " " + (model || "")).toLowerCase();

  // Trail indicators
  if (
    /\b(trail|speedgoat|peregrine|hierro|wildcat|terraventure|speedcross|ultra|summit)\b/i.test(
      combined
    )
  ) {
    return "trail";
  }

  // Track/spike indicators
  if (/\b(track|spike|dragonfly|zoom.*victory|ja fly|ld|md)\b/i.test(combined)) {
    return "track";
  }

  // Road indicators
  if (
    /\b(road|kayano|clifton|ghost|pegasus|nimbus|cumulus|gel|glycerin|kinvara|ride|triumph|novablast)\b/i.test(
      combined
    )
  ) {
    return "road";
  }

  // Default
  return "road";
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
        if (pct >= 5 && pct <= 90 && sale < original) {
          return { salePrice: sale, originalPrice: original, valid: true };
        }
      } else if (isP2Save && !isP1Save) {
        const sale = p1;
        const pct = ((original - sale) / original) * 100;
        if (pct >= 5 && pct <= 90 && sale < original) {
          return { salePrice: sale, originalPrice: original, valid: true };
        }
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
    if (pct >= 5 && pct <= 90 && sale < original) {
      return { salePrice: sale, originalPrice: original, valid: true };
    }

    return { salePrice: null, originalPrice: null, valid: false };
  }

  return { salePrice: null, originalPrice: null, valid: false };
}

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

/** -------------------- Apify fetchers -------------------- **/

function toFiniteNumber(x) {
  if (x == null) return null;
  const n = typeof x === "string" ? parseFloat(String(x).replace(/[^0-9.]/g, "")) : x;
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalizes Apify price fields across versions.
 *
 * Supports:
 * - NEW schema: { salePrice, price } where price = MSRP/list
 * - OLD schema: { price, originalPrice } where price = current/sale and originalPrice = MSRP
 *
 * Returns:
 *   { salePrice: number|null, originalPrice: number|null }
 */
function normalizeApifyPrices(item) {
  const newSale = toFiniteNumber(item?.salePrice);
  const newOrig = toFiniteNumber(item?.price);

  // If actor is already on new schema, use it
  if (newSale != null || newOrig != null) {
    return { salePrice: newSale, originalPrice: newOrig };
  }

  // Otherwise fall back to old schema
  const oldSale = toFiniteNumber(item?.price);
  const oldOrig = toFiniteNumber(item?.originalPrice);

  return { salePrice: oldSale, originalPrice: oldOrig };
}

async function fetchActorDatasetItems(actorId, storeName) {
  if (!actorId) throw new Error(`Actor ID missing for ${storeName}`);

  const run = await apifyClient.actor(actorId).call({});

  const allItems = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const { items, total } = await apifyClient.dataset(run.defaultDatasetId).listItems({
      offset,
      limit,
    });
    allItems.push(...items);
    offset += items.length;
    if (offset >= total || items.length === 0) break;
  }

  // Ensure store name
  for (const d of allItems) {
    if (!d.store) d.store = storeName;
  }

  return allItems;
}

async function fetchRoadRunnerDeals() {
  const STORE = "Road Runner Sports";
  const actorId = process.env.APIFY_ROADRUNNER_ACTOR_ID;
  if (!actorId) throw new Error("APIFY_ROADRUNNER_ACTOR_ID is not set");

  const items = await fetchActorDatasetItems(actorId, STORE);

  return items.map((item) => {
    const { salePrice, originalPrice } = normalizeApifyPrices(item);
    const brand = item.brand || "Unknown";
    const model = item.model || "";
    const listingName = item.title || `${brand} ${model}`.trim() || "Running Shoe";
    const listingURL = item.url || "#";
    const imageURL = item.image ?? null;
    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    return {
      listingName,
      brand,
      model,
      salePrice: salePrice ?? null,
      originalPrice: originalPrice ?? null,
      discountPercent,
      store: item.store || STORE,
      listingURL,
      imageURL,
      gender: item.gender || detectGender(listingURL, listingName),
      shoeType: item.shoeType || detectShoeType(listingName, model),
    };
  });
}

async function fetchZapposDeals() {
  const STORE = "Zappos";
  const actorId = process.env.APIFY_ZAPPOS_ACTOR_ID;
  if (!actorId) throw new Error("APIFY_ZAPPOS_ACTOR_ID is not set");

  const items = await fetchActorDatasetItems(actorId, STORE);

  return items.map((item) => {
    const { salePrice, originalPrice } = normalizeApifyPrices(item);
    const brand = item.brand || "Unknown";
    const model = item.model || "";
    const listingName = item.title || `${brand} ${model}`.trim() || "Running Shoe";
    const listingURL = item.url || "#";
    const imageURL = item.image ?? null;
    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    return {
      listingName,
      brand,
      model,
      salePrice: salePrice ?? null,
      originalPrice: originalPrice ?? null,
      discountPercent,
      store: item.store || STORE,
      listingURL,
      imageURL,
      gender: item.gender || detectGender(listingURL, listingName),
      shoeType: item.shoeType || detectShoeType(listingName, model),
    };
  });
}

async function fetchReiDeals() {
  const STORE = "REI Outlet";
  const actorId = process.env.APIFY_REI_ACTOR_ID;
  if (!actorId) throw new Error("APIFY_REI_ACTOR_ID is not set");

  const items = await fetchActorDatasetItems(actorId, STORE);

  return items.map((item) => {
    const { salePrice, originalPrice } = normalizeApifyPrices(item);

    const brand = item.brand || "Unknown";
    const model = item.model || "";
    const listingName = item.title || `${brand} ${model}`.trim() || "REI Outlet Shoe";
    const listingURL = item.url || "#";
    const imageURL = item.image ?? null;
    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    return {
      listingName,
      brand,
      model,
      salePrice: salePrice ?? null,
      originalPrice: originalPrice ?? null,
      discountPercent,
      store: item.store || STORE,
      listingURL,
      imageURL,
      gender: item.gender || detectGender(listingURL, listingName),
      shoeType: item.shoeType || detectShoeType(listingName, model),
    };
  });
}

/** -------------------- Site scrapers (non-Holabird) -------------------- **/

async function scrapeRunningWarehouse() {
  const STORE = "Running Warehouse";
  console.log(`[SCRAPER] Starting ${STORE} scrape...`);

  const urls = [
    "https://www.runningwarehouse.com/catpage-SALEMS.html",
    "https://www.runningwarehouse.com/catpage-SALEWS.html",
  ];

  const deals = [];
  const seenUrls = new Set();

  for (const pageUrl of urls) {
    console.log(`[SCRAPER] Fetching RW page: ${pageUrl}`);

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

  console.log(`[SCRAPER] ${STORE} scrape complete. Found ${deals.length} deals.`);
  return deals;
}

async function scrapeFleetFeet() {
  const STORE = "Fleet Feet";
  console.log(`[SCRAPER] Starting ${STORE} scrape...`);

  const urls = [
    "https://www.fleetfeet.com/browse/shoes/mens?clearance=on",
    "https://www.fleetfeet.com/browse/shoes/womens?clearance=on",
  ];

  const deals = [];
  const seenUrls = new Set();

  for (const pageUrl of urls) {
    console.log(`[SCRAPER] Fetching ${STORE} page: ${pageUrl}`);

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

  console.log(`[SCRAPER] ${STORE} scrape complete. Found ${deals.length} deals.`);
  return deals;
}

async function scrapeLukesLocker() {
  const STORE = "Luke's Locker";
  console.log(`[SCRAPER] Starting ${STORE} scrape...`);

  const pageUrl = "https://lukeslocker.com/collections/closeout";
  const deals = [];

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

  $('a[href*="/products/"]').each((_, el) => {
    const $link = $(el);
    const href = ($link.attr("href") || "").trim();
    if (!href || !href.includes("/products/")) return;

    if (href.includes("#")) return;
    if ($link.closest("script,style,noscript").length) return;

    const fullText = normalizeWhitespace($link.text());
    if (fullText.length < 10) return;
    if (!fullText.includes("$")) return;

    const listingName = cleanTitleText(fullText);
    if (!listingName) return;

    const { salePrice, originalPrice, valid } = extractPrices($, $link, fullText);
    if (!valid || !salePrice || salePrice <= 0) return;

    let $img = $link.find("img").first();
    if (!$img.length) $img = $link.closest("div, article, li").find("img").first();
    const imageURL = pickBestImgUrl($, $img, "https://lukeslocker.com");

    const listingURL = absolutizeUrl(href, "https://lukeslocker.com");
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

  console.log(`[SCRAPER] ${STORE} scrape complete. Found ${deals.length} deals.`);
  return deals;
}

async function scrapeMarathonSports() {
  const STORE = "Marathon Sports";
  console.log(`[SCRAPER] Starting ${STORE} scrape...`);

  const urls = [
    "https://www.marathonsports.com/shop/mens/shoes?sale=1",
    "https://www.marathonsports.com/shop/womens/shoes?sale=1",
    "https://www.marathonsports.com/shop?q=running%20shoes&sort=discount",
  ];

  const deals = [];
  const seenUrls = new Set();

  for (const pageUrl of urls) {
    console.log(`[SCRAPER] Fetching ${STORE} page: ${pageUrl}`);

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
      const $titleEl = $container
        .find("h2, h3, .product-title, .product-name, [class*='title']")
        .first();

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

  console.log(`[SCRAPER] ${STORE} scrape complete. Found ${deals.length} deals.`);
  return deals;
}

/** -------------------- Main handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // Optional cron auth
  // const cronSecret = process.env.CRON_SECRET;
  // if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const overallStartTime = Date.now();
  const runTimestamp = nowIso();

  console.log("[SCRAPER] Starting daily scrape:", runTimestamp);

  try {
    const allDeals = [];
    const scraperResults = {};

    async function runSource({ name, via, fn }) {
      const timestamp = nowIso();
      const scraperStart = Date.now();

      try {
        const deals = await fn();
        const durationMs = Date.now() - scraperStart;

        allDeals.push(...deals);

        scraperResults[name] = {
          scraper: name,
          ok: true,
          count: Array.isArray(deals) ? deals.length : 0,
          durationMs,
          timestamp,
          via,
          error: null,
        };

        console.log(`[SCRAPER] ${name}: ${scraperResults[name].count} deals in ${durationMs}ms`);
      } catch (err) {
        const durationMs = Date.now() - scraperStart;

        scraperResults[name] = {
          scraper: name,
          ok: false,
          count: 0,
          durationMs,
          timestamp,
          via,
          error: err?.message || "Unknown error",
        };

        console.error(`[SCRAPER] ${name} failed:`, scraperResults[name].error);
      }
    }

    // Live scrapes
    await runSource({ name: "Running Warehouse", via: "cheerio", fn: scrapeRunningWarehouse });
    await randomDelay();
    await runSource({ name: "Fleet Feet", via: "cheerio", fn: scrapeFleetFeet });
    await randomDelay();
    await runSource({ name: "Luke's Locker", via: "cheerio", fn: scrapeLukesLocker });
    await randomDelay();
    await runSource({ name: "Marathon Sports", via: "cheerio", fn: scrapeMarathonSports });

    // Apify (actors)
    await randomDelay();
    await runSource({ name: "Road Runner Sports", via: "apify", fn: fetchRoadRunnerDeals });
    await randomDelay();
    await runSource({ name: "REI Outlet", via: "apify", fn: fetchReiDeals });
    await randomDelay();
    await runSource({ name: "Zappos", via: "apify", fn: fetchZapposDeals });

    const scrapeDurationMs = Date.now() - overallStartTime;

    // Blob write
    const output = {
      lastUpdated: runTimestamp,
      scrapeDurationMs,
      scraperResults,
      deals: allDeals,
    };

    const blob = await put("deals-other.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    // Attach blobUrl to each scraper result so your health cards can show it
    // (matches your desired structure better)
    for (const key of Object.keys(scraperResults)) {
      scraperResults[key].blobUrl = blob.url;
    }

    // Re-write with blobUrl included in scraperResults
    const finalOutput = {
      ...output,
      scraperResults,
    };

    const finalBlob = await put("deals-other.json", JSON.stringify(finalOutput, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    console.log("[SCRAPER] Saved to blob:", finalBlob.url);
    console.log(`[SCRAPER] Complete: ${allDeals.length} deals in ${scrapeDurationMs}ms`);

    return res.status(200).json({
      success: true,
      totalDeals: allDeals.length,
      scraperResults,
      blobUrl: finalBlob.url,
      duration: `${scrapeDurationMs}ms`,
      timestamp: runTimestamp,
    });
  } catch (error) {
    console.error("[SCRAPER] Fatal error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
      stack: process.env.NODE_ENV === "development" ? error?.stack : undefined,
    });
  }
};
