// /api/scrapers/running-warehouse-cheerio.js

const axios = require("axios");
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

export const config = { maxDuration: 60 };

const STORE = "Running Warehouse";
const VIA = "cheerio";
const SCHEMA_VERSION = 1;

const REQUEST_TOGGLES = {
  REQUIRE_CRON_SECRET: false,
};

function nowIso() {
  return new Date().toISOString();
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

function parseBrandModelRaw(title) {
  const rawTitle = String(title || "");
  if (!rawTitle.trim()) return { brand: "Unknown", model: "" };

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
  let model = rawTitle;

  for (const b of brandsSorted) {
    const escaped = escapeRegExp(b);
    const regex = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i");
    if (regex.test(rawTitle)) {
      brand = b;
      model = rawTitle.replace(regex, " ").replace(/\s+/g, " ").trim();
      break;
    }
  }

  return { brand, model: model || rawTitle };
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

function randomDelay(min = 3000, max = 5000) {
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

async function scrapeRunningWarehouse() {
  const base = "https://www.runningwarehouse.com";

  const pages = [
    { url: "https://www.runningwarehouse.com/catpage-WRSSALERONU.html", shoeType: "road" },
    { url: "https://www.runningwarehouse.com/catpage-WRSSALETR.html", shoeType: "trail" },
    { url: "https://www.runningwarehouse.com/catpage-MRSSALENEU.html", shoeType: "road" },
    { url: "https://www.runningwarehouse.com/catpage-MRSSALETR.html", shoeType: "trail" },
  ];

  const sourceUrls = pages.map((p) => p.url);
  let pagesFetched = 0;
  let dealsFound = 0;

  const deals = [];
  const seenUrls = new Set();

  const parseDollar = (txt) => {
    const m = String(txt || "").match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  for (const page of pages) {
    const resp = await axios.get(page.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    const html = String(resp.data || "");
    const $ = cheerio.load(html);

    pagesFetched++;

    $("a.cattable-wrap-cell-info").each((_, el) => {
      const $link = $(el);
      const $cell = $link.closest(".cattable-wrap-cell");
      if (!$cell.length) return;

      dealsFound++;

      const listingName = String($cell.find(".cattable-wrap-cell-info-name").first().text() || "");
      if (!listingName) return;

      const subLine = String($cell.find(".cattable-wrap-cell-info-sub").first().text() || "");

      const href = $link.attr("href") || "";
      if (!href) return;

      const listingURL = absolutizeUrl(href, base);
      if (!listingURL) return;

      if (seenUrls.has(listingURL)) return;
      seenUrls.add(listingURL);

      const $img = $cell.find("img").first();
      const imageURL = pickBestImgUrl($, $img, base);

      const saleText = $cell.find(".cattable-wrap-cell-info-price.is-sale").first().text();
      const msrpText = $cell.find(".cattable-wrap-cell-info-price-msrp").first().text();

      const salePrice = parseDollar(saleText);
      const originalPrice = parseDollar(msrpText);

      if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice)) return;
      if (!(originalPrice > salePrice && salePrice > 0)) return;

      const discountPercent = computeDiscountPercent(originalPrice, salePrice);
      if (!Number.isFinite(discountPercent) || discountPercent < 5 || discountPercent > 90) return;

      const { brand, model } = parseBrandModelRaw(listingName);
      const gender = detectGender(listingURL, `${listingName} ${subLine}`);

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
          shoeType: page.shoeType,
        })
      );
    });

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
    const result = await scrapeRunningWarehouse();
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

    const blob = await put("running-warehouse.json", JSON.stringify(output, null, 2), {
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

    const blob = await put("running-warehouse.json", JSON.stringify(output, null, 2), {
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
