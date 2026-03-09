// /api/scrapers/fleet-feet-cheerio.js

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");
const canonicalBrandModels = require("../../lib/canonical-brands-models.json");

export const config = { maxDuration: 60 };

const STORE = "Fleet Feet";
const VIA = "cheerio-json-in-script";
const SCHEMA_VERSION = 1;
const BASE = "https://www.fleetfeet.com";
const MAX_PAGES_PER_SEED = 8;

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
  const combined = `${urlLower} ${listingName || ""} ${extraText || ""}`.toLowerCase();

  if (/\/mens?[\/-]|\/men\/|men-/.test(urlLower)) return "mens";
  if (/\/womens?[\/-]|\/women\/|women-/.test(urlLower)) return "womens";

  if (/\bmen'?s\b|\bmens\b|\bmale\b/.test(combined)) return "mens";
  if (/\bwomen'?s\b|\bwomens\b|\bfemale\b|\bladies\b/.test(combined)) return "womens";
  if (/\bunisex\b/.test(combined)) return "unisex";

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

async function fetchTextWithTimeout(url, options = {}, timeoutMs = 30000) {
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

    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

function buildPagedUrl(seedUrl, pageNum) {
  if (pageNum <= 1) return seedUrl;
  return `${seedUrl}&page=${pageNum}`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractTileData($tile) {
  const rawJson = $tile
    .find('script[type="application/json"][chuck-replace="product-tile_inner"]')
    .first()
    .html();

  if (!rawJson) return null;

  return safeJsonParse(rawJson);
}

function getStringField(obj, key) {
  const v = obj?.[key];
  return typeof v === "string" ? v : "";
}

function getNumberField(obj, key) {
  const v = obj?.[key];
  return Number.isFinite(v) ? v : null;
}

function getArrayField(obj, key) {
  return Array.isArray(obj?.[key]) ? obj[key] : [];
}

async function scrapeFleetFeet() {
  const seedUrls = [
    "https://www.fleetfeet.com/browse/shoes/mens?clearance=on",
    "https://www.fleetfeet.com/browse/shoes/womens?clearance=on",
  ];

  const sourceUrls = [];
  let pagesFetched = 0;
  let dealsFound = 0;

  const deals = [];
  const seenUrls = new Set();

  for (const seedUrl of seedUrls) {
    for (let page = 1; page <= MAX_PAGES_PER_SEED; page++) {
      const url = buildPagedUrl(seedUrl, page);
      sourceUrls.push(url);

      const html = await fetchTextWithTimeout(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
          },
        },
        30000
      );

      const $ = cheerio.load(html);
      pagesFetched++;

      const $tiles = $(".product-tile");
      if ($tiles.length === 0) break;

      let acceptedOnPage = 0;

      $tiles.each((_, el) => {
        const $tile = $(el);
        const data = extractTileData($tile);
        if (!data) return;

        const rawTitle =
          getStringField(data, "product.title")
            .replace(/\|/g, " ")
            .replace(/\s+/g, " ")
            .trim() || "";

        const listingName = normalizeWhitespace(rawTitle);
        if (!listingName) return;

        const slug = getStringField(data, "product.slug");
        if (!slug) return;

        const listingURL = absolutizeUrl(`/products/${slug}`, BASE);
        if (!listingURL || seenUrls.has(listingURL)) return;
        seenUrls.add(listingURL);

        const originalPrice = getNumberField(data, "computed.originalPrice");
        const salePrice = getNumberField(data, "computed.price");

        if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return;
        if (!(originalPrice > salePrice && salePrice > 0)) return;

        const discountPercent = computeDiscountPercent(originalPrice, salePrice);
        if (!Number.isFinite(discountPercent) || discountPercent < 5 || discountPercent > 90) return;

        const flags = getArrayField(data, "product.flags")
          .map((x) => normalizeWhitespace(x))
          .filter(Boolean);
        const flagText = flags.join(" ");

        const genderArray = getArrayField(data, "product.gender")
          .map((x) => normalizeWhitespace(x))
          .filter(Boolean);

        const explicitGender = genderArray.join(" ").toLowerCase();
        let gender = "unknown";
        if (/\bmen\b|\bmens\b/.test(explicitGender)) gender = "mens";
        else if (/\bwomen\b|\bwomens\b/.test(explicitGender)) gender = "womens";
        else if (/\bunisex\b/.test(explicitGender)) gender = "unisex";
        else gender = detectGender(listingURL, listingName, flagText);

        const imageRaw =
          getStringField(data, "sku.bestPhoto") ||
          getStringField(data, "sku.photo");

        const imageURL = absolutizeUrl(imageRaw, BASE) || null;

        const brandHint = "";
        const { brand, model } = parseBrandModelFromCanonical(listingName, brandHint);

        deals.push(
          buildDeal({
            listingName,
            brand,
            model,
            salePrice,
            originalPrice,
            discountPercent,
            store: STORE,
            listingURL,
            imageURL,
            gender,
            shoeType: detectShoeType(listingName, flagText),
          })
        );

        dealsFound++;
        acceptedOnPage++;
      });

      if (acceptedOnPage === 0 && page > 1) {
        break;
      }
    }
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

  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const start = Date.now();
  const timestamp = nowIso();

  try {
    const result = await scrapeFleetFeet();
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

    const blob = await put("fleet-feet.json", JSON.stringify(output, null, 2), {
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

    const blob = await put("fleet-feet.json", JSON.stringify(output, null, 2), {
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
