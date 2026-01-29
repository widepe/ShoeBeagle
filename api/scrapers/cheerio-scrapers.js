// api/cheerio-scrapers.js
// Cheerio-based scrapers for non-Holabird sites
// Outputs per-deal schema:
//   listingName, brand, model, salePrice, originalPrice, discountPercent,
//   store, listingURL, imageURL, gender, shoeType

const axios = require("axios");
const cheerio = require("cheerio");
const { cleanModelName } = require("./modelNameCleaner");

/** -------------------- Shared helpers -------------------- **/

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
  if (!url) return null;

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

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

// Detect gender from URL or title
function detectGender(listingURL, listingName) {
  const urlLower = (listingURL || "").toLowerCase();
  const titleLower = (listingName || "").toLowerCase();
  const combined = urlLower + " " + titleLower;

  if (/\/mens?[\/-]|\/men\/|men-/.test(urlLower)) return "mens";
  if (/\/womens?[\/-]|\/women\/|women-/.test(urlLower)) return "womens";

  if (/\b(men'?s?|male)\b/i.test(combined)) return "mens";
  if (/\b(women'?s?|female|ladies)\b/i.test(combined)) return "womens";
  if (/\bunisex\b/i.test(combined)) return "unisex";

  return "unknown";
}

// Detect shoe type from title or model
function detectShoeType(listingName, model) {
  const combined = ((listingName || "") + " " + (model || "")).toLowerCase();

  if (/\b(trail|speedgoat|peregrine|hierro|wildcat|terraventure|speedcross|ultra|summit)\b/i.test(combined)) {
    return "trail";
  }

  if (/\b(track|spike|dragonfly|zoom.*victory|ja fly|ld|md)\b/i.test(combined)) {
    return "track";
  }

  if (/\b(road|kayano|clifton|ghost|pegasus|nimbus|cumulus|gel|glycerin|kinvara|ride|triumph|novablast)\b/i.test(combined)) {
    return "road";
  }

  return "road";
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBrandModel(listingName) {
  const title = cleanTitleText(listingName);
  if (!title) return { brand: "Unknown", model: "" };

  const brands = [
    "361 Degrees", "adidas", "Allbirds", "Altra", "ASICS", "Brooks", "Craft", "Diadora",
    "HOKA", "Hylo Athletics", "INOV8", "Inov-8", "Karhu", "La Sportiva", "Lems", "Merrell",
    "Mizuno", "New Balance", "Newton", "Nike", "norda", "Nnormal", "On Running", "On",
    "Oofos", "Pearl Izumi", "Puma", "Reebok", "Salomon", "Saucony", "Saysh", "Skechers",
    "Skora", "The North Face", "Topo Athletic", "Topo", "Tyr", "Under Armour",
    "Vibram FiveFingers", "Vibram", "Vivobarefoot", "VJ Shoes", "VJ", "X-Bionic",
    "Xero Shoes", "Xero",
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

/**
 * UNIVERSAL PRICE EXTRACTOR
 * Returns: { salePrice: number|null, originalPrice: number|null, valid: boolean }
 */
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

    const sale = Math.max(...remaining);
    const pct = ((original - sale) / original) * 100;
    if (pct >= 5 && pct <= 90 && sale < original) {
      return { salePrice: sale, originalPrice: original, valid: true };
    }

    return { salePrice: null, originalPrice: null, valid: false };
  }

  return { salePrice: null, originalPrice: null, valid: false };
}

function randomDelay(min = 3000, max = 5000) {
  const wait = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, wait));
}

function makeDeal({
  listingName,
  brand,
  model,
  salePrice,
  originalPrice,
  store,
  listingURL,
  imageURL,
}) {
  const discountPercent = computeDiscountPercent(originalPrice, salePrice);

  return {
    listingName,
    brand,
    model,
    salePrice: Number.isFinite(salePrice) ? salePrice : null,
    originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
    discountPercent,
    store,
    listingURL: listingURL || null,
    imageURL: imageURL || null,
    gender: detectGender(listingURL, listingName),
    shoeType: detectShoeType(listingName, model),
  };
}

/** -------------------- Scrapers -------------------- **/

async function scrapeRunningWarehouse() {
  const store = "Running Warehouse";

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
      let text = normalizeWhitespace(anchor.text()).replace(/\*\s*$/, "").trim();

      const href = anchor.attr("href") || "";
      if (!href) return;

      const { salePrice, originalPrice, valid } = extractPrices($, anchor, text);
      if (!valid || !Number.isFinite(salePrice)) return;

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

      deals.push(
        makeDeal({
          listingName,
          brand,
          model,
          salePrice,
          originalPrice,
          store,
          listingURL,
          imageURL,
        })
      );
    });

    await randomDelay();
  }

  return deals;
}

async function scrapeFleetFeet() {
  const store = "Fleet Feet";

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
      if (!valid || !Number.isFinite(salePrice)) return;

      const listingURL = absolutizeUrl(href, "https://www.fleetfeet.com");
      if (!listingURL || seenUrls.has(listingURL)) return;
      seenUrls.add(listingURL);

      let $img = $link.find("img").first();
      if (!$img.length) $img = $link.closest("div, article, li").find("img").first();
      const imageURL = pickBestImgUrl($, $img, "https://www.fleetfeet.com");

      const { brand, model } = parseBrandModel(listingName);

      deals.push(
        makeDeal({
          listingName,
          brand,
          model,
          salePrice,
          originalPrice,
          store,
          listingURL,
          imageURL,
        })
      );
    });

    await randomDelay();
  }

  return deals;
}

async function scrapeLukesLocker() {
  const store = "Luke's Locker";

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
    if (!valid || !Number.isFinite(salePrice)) return;

    let $img = $link.find("img").first();
    if (!$img.length) $img = $link.closest("div, article, li").find("img").first();
    const imageURL = pickBestImgUrl($, $img, "https://lukeslocker.com");

    const listingURL = absolutizeUrl(href, "https://lukeslocker.com");

    const { brand, model } = parseBrandModel(listingName);

    deals.push(
      makeDeal({
        listingName,
        brand,
        model,
        salePrice,
        originalPrice,
        store,
        listingURL,
        imageURL,
      })
    );
  });

  return deals;
}

async function scrapeMarathonSports() {
  const store = "Marathon Sports";

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
      if (!listingURL || seenUrls.has(listingURL)) return;

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
      if (!valid || !Number.isFinite(salePrice)) return;

      let $img = $link.find("img").first();
      if (!$img.length) $img = $container.find("img").first();
      const imageURL = pickBestImgUrl($, $img, "https://www.marathonsports.com");

      seenUrls.add(listingURL);

      const { brand, model } = parseBrandModel(listingName);

      deals.push(
        makeDeal({
          listingName,
          brand,
          model,
          salePrice,
          originalPrice,
          store,
          listingURL,
          imageURL,
        })
      );
    });

    await randomDelay();
  }

  return deals;
}

/** -------------------- Exports -------------------- **/

module.exports = {
  nowIso,
  randomDelay,
  detectGender,
  detectShoeType,
  computeDiscountPercent,

  // scrapers
  scrapeRunningWarehouse,
  scrapeFleetFeet,
  scrapeLukesLocker,
  scrapeMarathonSports,
};
