// /api/scrapers/fleet-feet-cheerio.js

const axios = require("axios");
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");
const canonicalBrandModels = require("../../lib/canonical-brands-models.json");

export const config = { maxDuration: 60 };

const STORE = "Fleet Feet";
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

  if (/\b(men'?s?|male)\b/i.test(combined)) return "mens";
  if (/\b(women'?s?|female|ladies)\b/i.test(combined)) return "womens";
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

function randomDelay(min = 1200, max = 2200) {
  const wait = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, wait));
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

async function scrapeFleetFeet() {
  const base = "https://www.fleetfeet.com";

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
    let nextUrl = seedUrl;

    while (nextUrl) {
      sourceUrls.push(nextUrl);

      const response = await axios.get(nextUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 30000,
      });

      const $ = cheerio.load(response.data);
      pagesFetched++;

      $("div.product-tile").each((_, tile) => {
        const $tile = $(tile);
        const $jsonEl = $tile.find('script[type="application/json"]').first();
        if (!$jsonEl.length) return;

        let data;
        try {
          data = JSON.parse($jsonEl.html());
        } catch {
          return;
        }

        const discounted = data["computed.discounted"];
        if (!discounted) return;

        dealsFound++;

        const salePrice = parseFloat(data["computed.price"]);
        const originalPrice = parseFloat(data["computed.originalPrice"]);

        if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice)) return;
        if (!(originalPrice > salePrice && salePrice > 0)) return;

        const discountPercent = computeDiscountPercent(originalPrice, salePrice);
        if (!Number.isFinite(discountPercent) || discountPercent < 5 || discountPercent > 90) return;

        const slug = String(data["product.slug"] || "").trim();
        if (!slug) return;

        const listingURL = absolutizeUrl(`/products/${slug}`, base);
        if (!listingURL) return;
        if (seenUrls.has(listingURL)) return;
        seenUrls.add(listingURL);

        const listingName = String(data["product.title"] || "");
        if (!listingName) return;

        const imageURL =
          data["sku.bestPhoto"] ||
          data["sku.photo"] ||
          data["product.photo"] ||
          null;

        const brandHint =
          normalizeWhitespace(data["product.brand"] || "") ||
          normalizeWhitespace(data["brand.name"] || "") ||
          normalizeWhitespace(data["product.vendor"] || "");

        const genderHint =
          normalizeWhitespace(data["product.department"] || "") ||
          normalizeWhitespace(data["product.gender"] || "") ||
          normalizeWhitespace(data["sku.gender"] || "");

        const categoryHint =
          normalizeWhitespace(data["product.category"] || "") ||
          normalizeWhitespace(data["product.type"] || "");

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
            gender: detectGender(listingURL, listingName, `${genderHint} ${categoryHint}`),
            shoeType: detectShoeType(listingName, categoryHint),
          })
        );
      });

      const nextHref = ($("a#browsenext").attr("href") || "").trim();
      nextUrl = nextHref ? absolutizeUrl(nextHref, base) : null;

      if (nextUrl) {
        await randomDelay();
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

  // CRON_SECRET
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

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
