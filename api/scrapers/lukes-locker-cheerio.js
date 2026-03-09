// /api/scrapers/lukes-locker-cheerio.js

const { put } = require("@vercel/blob");
const canonicalBrandModels = require("../../lib/canonical-brands-models.json");

export const config = { maxDuration: 60 };

const STORE = "Luke's Locker";
const VIA = "cheerio";
const SCHEMA_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function absolutizeUrl(u, base) {
  let url = String(u || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return base.replace(/\/+$/, "") + url;
  return base.replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getCanonicalBrandKeys() {
  return Object.keys(canonicalBrandModels || {})
    .map((b) => String(b || "").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function findCanonicalBrandMatch(rawText) {
  const text = String(rawText || "");
  if (!text.trim()) return null;

  const canonicalBrands = getCanonicalBrandKeys();

  for (const brandName of canonicalBrands) {
    const escaped = escapeRegExp(brandName);
    const regex = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i");
    if (regex.test(text)) return brandName;
  }

  return null;
}

function parseBrandModelFromCanonical(listingName, rawBrandHint = "") {
  const rawTitle = String(listingName || "");
  const brandHint = String(rawBrandHint || "").trim();

  if (!rawTitle.trim()) {
    return { brand: "Unknown", model: "" };
  }

  if (brandHint) {
    const matchedHintBrand = findCanonicalBrandMatch(brandHint);
    if (matchedHintBrand) {
      const escaped = escapeRegExp(matchedHintBrand);
      const regex = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i");

      const model = regex.test(rawTitle)
        ? rawTitle.replace(regex, " ").replace(/\s+/g, " ").trim()
        : rawTitle;

      return {
        brand: matchedHintBrand,
        model: model || rawTitle,
      };
    }
  }

  const matchedTitleBrand = findCanonicalBrandMatch(rawTitle);
  if (matchedTitleBrand) {
    const escaped = escapeRegExp(matchedTitleBrand);
    const regex = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i");

    const model = rawTitle.replace(regex, " ").replace(/\s+/g, " ").trim();

    return {
      brand: matchedTitleBrand,
      model: model || rawTitle,
    };
  }

  return {
    brand: "Unknown",
    model: rawTitle,
  };
}

function detectGender(listingURL, listingName, extraText = "") {
  const urlLower = (listingURL || "").toLowerCase();
  const nameLower = (listingName || "").toLowerCase();
  const extraLower = (extraText || "").toLowerCase();
  const combined = `${urlLower} ${nameLower} ${extraLower}`;

  if (/\/mens?[\/-]|\/men\/|men-/.test(urlLower)) return "mens";
  if (/\/womens?[\/-]|\/women\/|women-/.test(urlLower)) return "womens";

  if (/\b(men'?s?|mens|male)\b/i.test(combined)) return "mens";
  if (/\b(women'?s?|womens|female|ladies)\b/i.test(combined)) return "womens";
  if (/\bunisex\b/i.test(combined)) return "unisex";

  return "unknown";
}

function detectShoeType(listingName, extraText = "") {
  const combined = `${listingName || ""} ${extraText || ""}`.toLowerCase();

  if (/\b(track|spike|spikes)\b/.test(combined)) return "track";
  if (/\b(trail|trail running|off[- ]road)\b/.test(combined)) return "trail";
  if (/\b(road|running shoe|running shoes)\b/.test(combined)) return "road";

  return "unknown";
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function randomDelay(min = 800, max = 1400) {
  const wait = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, wait));
}

function parseMoneyLike(value) {
  const n = parseFloat(String(value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function buildDeal({
  listingName,
  brand,
  model,
  salePrice,
  originalPrice,
  discountPercent,
  store,
  listingURL,
  imageURL,
  gender,
  shoeType,
}) {
  return {
    schemaVersion: 1,

    listingName: listingName || "",

    brand: brand || "Unknown",
    model: model || "",

    salePrice: Number.isFinite(salePrice) ? salePrice : null,
    originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
    discountPercent: Number.isFinite(discountPercent) ? discountPercent : null,

    salePriceLow: null,
    salePriceHigh: null,
    originalPriceLow: null,
    originalPriceHigh: null,
    discountPercentUpTo: null,

    store: store || "",

    listingURL: listingURL || "",
    imageURL: imageURL || null,

    gender: gender || "unknown",
    shoeType: shoeType || "unknown",
  };
}

function pickImageUrl(product, base) {
  const pickSrc = (img) => {
    if (!img) return null;
    if (typeof img === "string") return img;
    if (typeof img === "object") return img.src || img.url || null;
    return null;
  };

  let src =
    pickSrc(product?.image) ||
    (Array.isArray(product?.images) ? pickSrc(product.images[0]) : null);

  if (!src && Array.isArray(product?.images)) {
    for (const img of product.images) {
      src = pickSrc(img);
      if (src) break;
    }
  }

  if (!src) return null;
  return absolutizeUrl(src, base);
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} for ${url}`);
    }

    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeLukesLocker() {
  const base = "https://lukeslocker.com";
  const handle = "closeout";
  const limit = 250;

  const sourceUrls = [];
  let pagesFetched = 0;
  let dealsFound = 0;

  const deals = [];
  const seenUrls = new Set();

  for (let page = 1; page <= 10; page++) {
    const url = `${base}/collections/${handle}/products.json?limit=${limit}&page=${page}`;
    sourceUrls.push(url);

    const data = await fetchJsonWithTimeout(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      30000
    );

    const products = data?.products;
    if (!Array.isArray(products) || products.length === 0) break;

    pagesFetched++;
    dealsFound += products.length;

    for (const p of products) {
      const listingName = String(p?.title ?? "");
      if (!listingName) continue;

      const handleValue = String(p?.handle || "").trim();
      if (!handleValue) continue;

      const listingURL = absolutizeUrl(`/products/${handleValue}`, base);
      if (!listingURL) continue;
      if (seenUrls.has(listingURL)) continue;
      seenUrls.add(listingURL);

      const imageURL = pickImageUrl(p, base);

      let bestSale = null;
      let bestOriginal = null;

      const variants = Array.isArray(p?.variants) ? p.variants : [];
      for (const v of variants) {
        const sale = parseMoneyLike(v?.price);
        const orig = parseMoneyLike(v?.compare_at_price);

        if (!Number.isFinite(sale) || !Number.isFinite(orig)) continue;
        if (!(orig > sale && sale > 0)) continue;

        if (bestSale == null || sale < bestSale) {
          bestSale = sale;
          bestOriginal = orig;
        }
      }

      if (!Number.isFinite(bestSale) || !Number.isFinite(bestOriginal)) continue;

      const discountPercent = computeDiscountPercent(bestOriginal, bestSale);
      if (!Number.isFinite(discountPercent) || discountPercent < 5 || discountPercent > 90) continue;

      const brandHint =
        normalizeWhitespace(p?.vendor || "") ||
        normalizeWhitespace(p?.product_type || "") ||
        normalizeWhitespace(p?.type || "");

      const extraText = [p?.tags, p?.product_type, p?.type, p?.vendor]
        .flat()
        .filter(Boolean)
        .map((x) => String(x))
        .join(" ");

      const { brand, model } = parseBrandModelFromCanonical(listingName, brandHint);

      deals.push(
        buildDeal({
          listingName,
          brand,
          model,
          salePrice: bestSale,
          originalPrice: bestOriginal,
          discountPercent,
          store: STORE,
          listingURL,
          imageURL,
          gender: detectGender(listingURL, listingName, extraText),
          shoeType: detectShoeType(listingName, extraText),
        })
      );
    }

    if (products.length < limit) break;
    await randomDelay();
  }

  return {
    deals,
    sourceUrls,
    pagesFetched,
    dealsFound,
    dealsExtracted: deals.length,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // CRON_SECRET
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const start = Date.now();
  const timestamp = nowIso();

  try {
    const result = await scrapeLukesLocker();
    const durationMs = Date.now() - start;

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: timestamp,
      via: VIA,

      sourceUrls: result.sourceUrls,
      pagesFetched: result.pagesFetched,

      dealsFound: result.dealsFound,
      dealsExtracted: result.dealsExtracted,

      scrapeDurationMs: durationMs,

      ok: true,
      error: null,

      deals: result.deals,
    };

    const blob = await put("lukes-locker.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobUrl: blob.url,
      dealsExtracted: output.dealsExtracted,
      scrapeDurationMs: durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - start;

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: timestamp,
      via: VIA,

      sourceUrls: [],
      pagesFetched: null,

      dealsFound: null,
      dealsExtracted: 0,

      scrapeDurationMs: durationMs,

      ok: false,
      error: err?.message || "Unknown error",

      deals: [],
    };

    const blob = await put("lukes-locker.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(500).json({
      success: false,
      store: STORE,
      blobUrl: blob.url,
      error: output.error,
    });
  }
}
