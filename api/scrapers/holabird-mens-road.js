// /api/scrapers/holabird-mens-road.js
// Scrapes Holabird Sports Mens Road Running Shoe Deals using Searchanise API (RunUnited-style)

const { put } = require("@vercel/blob");

const API_KEY = "1T0U8M9s3R";
const SEARCH_URL = "https://searchserverapi.com/getresults";

const SOURCE_URL =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Mens+Type_Running-Shoes+";

/** -------------------- helpers -------------------- **/

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function detectShoeType(text) {
  const t = String(text || "").toLowerCase();

  if (/\btrail|gtx|gore-tex\b/.test(t)) return "trail";
  if (/\bspike|spikes|track\b/.test(t)) return "track";

  return "road";
}

function extractModel(listingName, brand) {
  if (!listingName) return "";

  let model = listingName;

  if (brand) {
    const brandRegex = new RegExp(`^${brand}\\s+`, "i");
    model = model.replace(brandRegex, "");
  }

  model = model
    .replace(/\s+running\s+shoe(s)?$/i, "")
    .replace(/\s+men'?s$/i, "")
    .replace(/\s+women'?s$/i, "")
    .trim();

  return model;
}

function dedupeByUrl(deals) {
  const seen = new Set();
  const out = [];

  for (const d of deals) {
    if (!d.listingURL) continue;

    if (!seen.has(d.listingURL)) {
      seen.add(d.listingURL);
      out.push(d);
    }
  }

  return out;
}

/** -------------------- Searchanise fetch -------------------- **/

async function fetchPage(startIndex) {
  const params = new URLSearchParams();

  params.set("api_key", API_KEY);
  params.set("startIndex", startIndex);
  params.set("maxResults", 100);

  const url = `${SEARCH_URL}?${params.toString()}`;

  const start = Date.now();

  const res = await fetch(url, {
    headers: { accept: "application/json" },
  });

  const duration = Date.now() - start;

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const json = await res.json();

  return {
    json,
    url,
    duration,
  };
}

/** -------------------- main scrape -------------------- **/

async function scrapeHolabird() {
  const pageNotes = [];
  const results = [];

  let startIndex = 0;

  while (true) {
    const { json, url, duration } = await fetchPage(startIndex);

    const items = json?.results || [];

    pageNotes.push({
      page: `searchanise startIndex=${startIndex}`,
      success: true,
      count: items.length,
      error: null,
      url,
      duration: `${duration}ms`,
      status: 200,
    });

    if (!items.length) break;

    results.push(...items);

    startIndex += 100;

    if (startIndex > 2000) break;
  }

  return {
    results,
    pageNotes,
  };
}

/** -------------------- transform -------------------- **/

function transformResults(results) {
  const deals = [];

  for (const r of results) {
    const listingName = String(r?.title || "").trim();

    if (!listingName) continue;

    const brand = String(r?.brand || "").trim() || "Unknown";

    const model = extractModel(listingName, brand);

    const salePrice = round2(parseFloat(r?.price));
    const originalPrice = round2(parseFloat(r?.compare_at_price));

    if (!salePrice || !originalPrice) continue;

    const listingURL = r?.link
      ? `https://www.holabirdsports.com${r.link}`
      : null;

    if (!listingURL) continue;

    const shoeType = detectShoeType(listingName);

    if (shoeType !== "road") continue;

    const discountPercent = computeDiscountPercent(originalPrice, salePrice);

    deals.push({
      listingName,
      brand,
      model,
      salePrice,
      originalPrice,
      discountPercent,
      store: "Holabird Sports",
      listingURL,
      imageURL: r?.image_link || null,
      gender: "mens",
      shoeType,
    });
  }

  return dedupeByUrl(deals);
}

/** -------------------- handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const start = Date.now();

  try {
    const { results, pageNotes } = await scrapeHolabird();

    const deals = transformResults(results);

    const duration = Date.now() - start;

    const output = {
      store: "Holabird Sports",
      schemaVersion: 1,

      lastUpdated: new Date().toISOString(),
      via: "searchanise",

      sourceUrls: [SOURCE_URL, SEARCH_URL],

      pagesFetched: pageNotes.length,

      dealsFound: results.length,
      dealsExtracted: deals.length,

      scrapeDurationMs: duration,

      ok: true,
      error: null,

      pageNotes,

      deals,
    };

    const blob = await put(
      "holabird-mens-road.json",
      JSON.stringify(output, null, 2),
      { access: "public", addRandomSuffix: false }
    );

    return res.status(200).json({
      ok: true,
      store: output.store,
      dealsExtracted: deals.length,
      pagesFetched: pageNotes.length,
      dealsFound: results.length,
      scrapeDurationMs: duration,
      blobUrl: blob.url,
      lastUpdated: output.lastUpdated,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
};
