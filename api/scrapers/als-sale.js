// api/scrapers/als-sale.js
// Scrapes ALS Men's + Women's running shoes (all pages)
//
// Canonical deal schema in deals[]:
// {
//   schemaVersion,
//   listingName,
//   brand,
//   model,
//   salePrice,
//   originalPrice,
//   discountPercent,
//   salePriceLow,
//   salePriceHigh,
//   originalPriceLow,
//   originalPriceHigh,
//   discountPercentUpTo,
//   store,
//   listingURL,
//   imageURL,
//   gender,
//   shoeType
// }
//
// NOTES:
// - Gender is determined FROM THE TILE TEXT, not from the page/category
// - Brand is taken from the bold brand line
// - Model is taken from the title/model line
// - Price parsing uses dedicated price nodes:
//    * original: line-through gray node
//    * sale: red price node
// - Exact prices populate salePrice/originalPrice/discountPercent
// - Ranges populate *Low/*High and discountPercentUpTo
//
// Blob: als-sale.json (stable)

const axios = require("axios");
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "ALS";
const BASE = "https://www.als.com";

const MEN_URL =
  "https://www.als.com/footwear/men-s-footwear/men-s-running-shoes?filter.category-1=footwear&filter.category-2=men-s-footwear&filter.category-3=men-s-running-shoes&sort=discount%3Adesc";

const WOMEN_URL =
  "https://www.als.com/footwear/women-s-footwear/women-s-running-shoes?filter.category-1=footwear&filter.category-2=women-s-footwear&filter.category-3=women-s-running-shoes&sort=discount%3Adesc";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** -------------------- helpers -------------------- **/

function nowIso() {
  return new Date().toISOString();
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function cleanText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function absolutize(url) {
  if (!url || typeof url !== "string") return null;
  const s = url.replace(/&amp;/g, "&").trim();
  if (!s || s.startsWith("data:")) return null;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/")) return `${BASE}${s}`;
  return `${BASE}/${s}`;
}

function parsePriceNumber(text) {
  if (!text) return null;
  const m = String(text).replace(/,/g, "").match(/\$([\d]+(?:\.\d{2})?)/);
  return m ? round2(parseFloat(m[1])) : null;
}

function extractAllPriceNumbers(text) {
  const matches = String(text || "")
    .replace(/,/g, "")
    .match(/\$\s*[\d]+(?:\.\d{2})?/g) || [];
  return matches
    .map((m) => parsePriceNumber(m))
    .filter((n) => Number.isFinite(n));
}

function uniqNumbers(arr) {
  return [...new Set((arr || []).filter((n) => Number.isFinite(n)).map((n) => round2(n)))];
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function computeDiscountPercentUpTo(originalHigh, saleLow) {
  if (!Number.isFinite(originalHigh) || !Number.isFinite(saleLow)) return null;
  if (originalHigh <= 0 || saleLow <= 0) return null;
  if (saleLow >= originalHigh) return 0;
  return Math.round(((originalHigh - saleLow) / originalHigh) * 100);
}

function parseSingleOrRangePrice(text) {
  const raw = cleanText(text);
  if (!raw || !raw.includes("$")) return null;

  const nums = uniqNumbers(extractAllPriceNumbers(raw));
  if (!nums.length) return null;

  const isExplicitRange =
    /\$\s*[\d]+(?:\.\d{2})?\s*(?:-|to)\s*\$\s*[\d]+(?:\.\d{2})?/i.test(raw);

  if (isExplicitRange && nums.length >= 2) {
    const low = Math.min(...nums);
    const high = Math.max(...nums);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) return null;
    return {
      kind: "range",
      low: round2(low),
      high: round2(high),
    };
  }

  if (nums.length === 1) {
    return {
      kind: "single",
      value: round2(nums[0]),
      low: round2(nums[0]),
      high: round2(nums[0]),
    };
  }

  // If there are 2 unique numbers but no explicit range marker,
  // treat it as a range only if the raw text clearly belongs to one price node.
  if (nums.length === 2) {
    const low = Math.min(...nums);
    const high = Math.max(...nums);
    return {
      kind: "range",
      low: round2(low),
      high: round2(high),
    };
  }

  return null;
}

function normalizePriceBundle(originalParsed, saleParsed) {
  if (!originalParsed || !saleParsed) return null;

  const out = {
    salePrice: null,
    originalPrice: null,
    discountPercent: null,

    salePriceLow: null,
    salePriceHigh: null,
    originalPriceLow: null,
    originalPriceHigh: null,
    discountPercentUpTo: null,
  };

  const saleLow = Number.isFinite(saleParsed.low) ? round2(saleParsed.low) : null;
  const saleHigh = Number.isFinite(saleParsed.high) ? round2(saleParsed.high) : null;
  const originalLow = Number.isFinite(originalParsed.low) ? round2(originalParsed.low) : null;
  const originalHigh = Number.isFinite(originalParsed.high) ? round2(originalParsed.high) : null;

  if (!Number.isFinite(saleLow) || !Number.isFinite(originalHigh)) return null;
  if (saleLow > originalHigh) return null;

  const saleIsSingle = saleParsed.kind === "single" && Number.isFinite(saleParsed.value);
  const originalIsSingle = originalParsed.kind === "single" && Number.isFinite(originalParsed.value);

  if (saleIsSingle && originalIsSingle) {
    const s = round2(saleParsed.value);
    const o = round2(originalParsed.value);
    if (!Number.isFinite(s) || !Number.isFinite(o) || s > o) return null;

    out.salePrice = s;
    out.originalPrice = o;
    out.discountPercent = computeDiscountPercent(o, s);
    return out;
  }

  out.salePriceLow = saleLow;
  out.salePriceHigh = Number.isFinite(saleHigh) ? saleHigh : saleLow;
  out.originalPriceLow = Number.isFinite(originalLow) ? originalLow : originalHigh;
  out.originalPriceHigh = originalHigh;
  out.discountPercentUpTo = computeDiscountPercentUpTo(originalHigh, saleLow);

  return out;
}

function detectGenderFromTileText(text) {
  const t = cleanText(text).toLowerCase();

  if (/\bunisex\b/.test(t)) return "unisex";
  if (/\bmen'?s\b/.test(t) || /\bmens\b/.test(t)) return "mens";
  if (/\bwomen'?s\b/.test(t) || /\bwomens\b/.test(t)) return "womens";
  return "unknown";
}

function detectShoeTypeFromTileText(text) {
  const t = cleanText(text).toLowerCase();

  if (/\btrack\b/.test(t) || /\bspike\b/.test(t) || /\bspikes\b/.test(t)) {
    return "track";
  }

  if (/\btrail\b/.test(t) && /\brunning shoe\b/.test(t)) {
    return "trail";
  }

  if (/\btrail\b/.test(t) && /\bshoe\b/.test(t)) {
    return "trail";
  }

  if (/\brunning shoe\b/.test(t)) {
    return "road";
  }

  return "unknown";
}

function extractBrandAndModel($card) {
  const brand = cleanText(
    $card.find("p.font-bold").first().text()
  );

  let model = cleanText(
    $card.find("p.line-clamp-2").first().text()
  );

  // Fallback if those exact nodes are absent
  if (!brand || !model) {
    const ps = $card.find("p");
    if (!brand && ps.length >= 1) {
      const maybeBrand = cleanText($(ps[0]).text());
      if (maybeBrand) {
        // kept only as fallback
        if (!brand) {
          model = model || cleanText($(ps[1]).text());
        }
      }
    }
  }

  return {
    brand: brand || "",
    model: model || "",
  };
}

function extractListingName(brand, model) {
  const b = cleanText(brand);
  const m = cleanText(model);
  if (!b && !m) return "";
  if (!b) return m;
  if (!m) return b;
  return `${b} ${m}`.replace(/\s+/g, " ").trim();
}

function extractPriceNodes($card) {
  const originalNode = $card.find("p.line-through").first();
  const saleNode = $card.find("p.text-als-price-red").first();

  const originalText = cleanText(originalNode.text());
  const saleText = cleanText(saleNode.text());

  return {
    originalText,
    saleText,
  };
}

/** -------------------- extraction -------------------- **/

function extractDeals(html) {
  const $ = cheerio.load(html);
  const deals = [];

  const tiles = $("li").filter((_, li) => {
    const $li = $(li);
    const href = $li.find('a[href$="/p"]').first().attr("href");
    const hasBrand = $li.find("p.font-bold").length > 0;
    const hasModel = $li.find("p.line-clamp-2").length > 0;
    const hasSale = $li.find("p.text-als-price-red").length > 0;
    return !!href && hasBrand && hasModel && hasSale;
  });

  tiles.each((_, li) => {
    const $tile = $(li);

    const productLink = $tile.find('a[href$="/p"]').filter((_, a) => {
      return !!$(a).find("img").length || !!cleanText($(a).text());
    }).first();

    const listingURL = absolutize(productLink.attr("href"));
    if (!listingURL) return;

    const imageURL = absolutize(
      $tile.find("img").first().attr("src") ||
      $tile.find("img").first().attr("data-src") ||
      $tile.find("img").first().attr("data-original")
    );

    const { brand, model } = extractBrandAndModel($tile);
    if (!brand || !model) return;

    const listingName = extractListingName(brand, model);
    if (!listingName) return;

    const tileText = cleanText($tile.text());
    const gender = detectGenderFromTileText(tileText);
    const shoeType = detectShoeTypeFromTileText(tileText);

    const { originalText, saleText } = extractPriceNodes($tile);
    if (!saleText || !originalText) return;

    const originalParsed = parseSingleOrRangePrice(originalText);
    const saleParsed = parseSingleOrRangePrice(saleText);
    if (!originalParsed || !saleParsed) return;

    const priceBundle = normalizePriceBundle(originalParsed, saleParsed);
    if (!priceBundle) return;

    deals.push({
      schemaVersion: 1,

      listingName,

      brand,
      model,

      salePrice: priceBundle.salePrice,
      originalPrice: priceBundle.originalPrice,
      discountPercent: priceBundle.discountPercent,

      salePriceLow: priceBundle.salePriceLow,
      salePriceHigh: priceBundle.salePriceHigh,
      originalPriceLow: priceBundle.originalPriceLow,
      originalPriceHigh: priceBundle.originalPriceHigh,
      discountPercentUpTo: priceBundle.discountPercentUpTo,

      store: STORE,

      listingURL,
      imageURL: imageURL || null,

      gender,
      shoeType,
    });
  });

  const seen = new Set();
  return deals.filter((d) => {
    if (!d.listingURL) return false;
    if (seen.has(d.listingURL)) return false;
    seen.add(d.listingURL);
    return true;
  });
}

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
    timeout: 45000,
  });
  return data;
}

async function scrapeCategory(baseUrl) {
  const all = [];
  const seen = new Set();

  let pagesFetched = 0;
  let tilesFound = 0;

  for (let page = 1; page <= 50; page++) {
    const url = `${baseUrl}&page=${page}`;
    const html = await fetchHtml(url);
    pagesFetched += 1;

    const $ = cheerio.load(html);

    const pageTiles = $("li").filter((_, li) => {
      const $li = $(li);
      return (
        $li.find('a[href$="/p"]').length > 0 &&
        $li.find("p.font-bold").length > 0 &&
        $li.find("p.line-clamp-2").length > 0
      );
    });

    tilesFound += pageTiles.length;

    const pageDeals = extractDeals(html);

    let added = 0;
    for (const d of pageDeals) {
      if (d.listingURL && !seen.has(d.listingURL)) {
        seen.add(d.listingURL);
        all.push(d);
        added++;
      }
    }

    if (pageTiles.length === 0) break;
    if (pageDeals.length === 0 && page > 1) break;

    await sleep(800);
  }

  return { deals: all, pagesFetched, tilesFound };
}

/** -------------------- handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // CRON_SECRET
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const t0 = Date.now();

  const out = {
    store: STORE,
    schemaVersion: 1,

    lastUpdated: nowIso(),
    via: "cheerio",

    sourceUrls: [MEN_URL, WOMEN_URL],
    pagesFetched: 0,

    dealsFound: 0,
    dealsExtracted: 0,

    scrapeDurationMs: 0,

    ok: false,
    error: null,

    deals: [],
  };

  try {
    const mens = await scrapeCategory(MEN_URL);
    await sleep(1200);
    const womens = await scrapeCategory(WOMEN_URL);

    const deals = [...mens.deals, ...womens.deals];

    out.pagesFetched = (mens.pagesFetched || 0) + (womens.pagesFetched || 0);
    out.dealsFound = (mens.tilesFound || 0) + (womens.tilesFound || 0);
    out.dealsExtracted = deals.length;
    out.deals = deals;

    out.ok = true;
    out.error = null;
    out.scrapeDurationMs = Date.now() - t0;
    out.lastUpdated = nowIso();

    const blob = await put("als-sale.json", JSON.stringify(out, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({
      ok: true,
      store: out.store,
      pagesFetched: out.pagesFetched,
      dealsFound: out.dealsFound,
      dealsExtracted: out.dealsExtracted,
      scrapeDurationMs: out.scrapeDurationMs,
      blobUrl: blob.url,
      lastUpdated: out.lastUpdated,
    });
  } catch (err) {
    out.ok = false;
    out.error = err?.stack || err?.message || String(err) || "Unknown error";
    out.scrapeDurationMs = Date.now() - t0;
    out.lastUpdated = nowIso();

    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(500).json({
      ok: false,
      error: out.error,
      scrapeDurationMs: out.scrapeDurationMs,
      lastUpdated: out.lastUpdated,
    });
  }
};
