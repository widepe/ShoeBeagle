// /api/scrapers/lukes-locker-cheerio.js

const axios = require("axios");
const { put } = require("@vercel/blob");

export const config = { maxDuration: 60 };

const STORE = "Luke's Locker";
const VIA = "cheerio";
const SCHEMA_VERSION = 1;

const REQUEST_TOGGLES = {
  REQUIRE_CRON_SECRET: false,
};

function nowIso() {
  return new Date().toISOString();
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectGender(listingURL, listingName) {
  const urlLower = (listingURL || "").toLowerCase();
  const nameLower = (listingName || "").toLowerCase();
  const combined = `${urlLower} ${nameLower}`;

  if (/\/mens?[\/-]|\/men\/|men-/.test(urlLower)) return "mens";
  if (/\/womens?[\/-]|\/women\/|women-/.test(urlLower)) return "womens";

  if (/\b(men'?s?|male)\b/i.test(combined)) return "mens";
  if (/\b(women'?s?|female|ladies)\b/i.test(combined)) return "womens";
  if (/\bunisex\b/i.test(combined)) return "unisex";

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

    pagesFetched++;
    dealsFound += products.length;

    for (const p of products) {
      const listingName = String(p?.title ?? "");
      if (!listingName) continue;

      const brand = String(p?.vendor || "").trim() || "Unknown";

      if (!p?.handle) continue;
      const listingURL = `${base}/products/${p.handle}`;
      if (seenUrls.has(listingURL)) continue;
      seenUrls.add(listingURL);

      let imageURL = null;

      const pickSrc = (img) => {
        if (!img) return null;
        if (typeof img === "string") return img;
        if (typeof img === "object") return img.src || img.url || null;
        return null;
      };

      let src = pickSrc(p?.image) || (Array.isArray(p?.images) ? pickSrc(p.images[0]) : null);

      if (!src && Array.isArray(p?.images)) {
        for (const img of p.images) {
          src = pickSrc(img);
          if (src) break;
        }
      }

      if (src) {
        let u = String(src).trim();
        if (u.startsWith("//")) u = "https:" + u;
        else if (u.startsWith("/")) u = base + u;
        else if (/^cdn\.shopify\.com/i.test(u)) u = "https://" + u;
        if (!/^https?:\/\//i.test(u)) u = null;
        imageURL = u;
      }

      let bestSale = null;
      let bestOriginal = null;

      const variants = Array.isArray(p?.variants) ? p.variants : [];
      for (const v of variants) {
        const sale = parseFloat(String(v?.price ?? "").replace(/[^0-9.]/g, ""));
        const orig = parseFloat(String(v?.compare_at_price ?? "").replace(/[^0-9.]/g, ""));

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

      let model = listingName;
      if (brand && brand !== "Unknown") {
        const escaped = escapeRegExp(brand);
        model = listingName.replace(new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i"), " ");
        model = model.replace(/\s+/g, " ").trim() || listingName;
      }

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
          gender: detectGender(listingURL, listingName),
          shoeType: "unknown",
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

  const auth = req.headers.authorization;
  if (
    REQUEST_TOGGLES.REQUIRE_CRON_SECRET &&
    process.env.CRON_SECRET &&
    auth !== `Bearer ${process.env.CRON_SECRET}`
  ) {
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
