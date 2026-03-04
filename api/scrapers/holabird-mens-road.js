// /api/scrapers/holabird-mens-road.js
// Holabird Sports — Mens Road Running Shoe Deals via Searchanise (API-first)
// ✅ Top-level structure matches your Zappos-style metadata
// ✅ Canonical 11-field deals schema
// ✅ Pagination startIndex/maxResults
// ✅ Uses real deal test: list_price > price
// ✅ Uses broad "Running-Shoes" tag token matching (Holabird varies exact tokens)
// ✅ Forces gender=mens and shoeType=road for this collection
// ✅ Dedupe by listingURL
// ✅ CRON secret auth COMMENTED OUT for testing

const { put } = require("@vercel/blob");

const STORE = "Holabird Sports";
const SCHEMA_VERSION = 1;

const SOURCE_URL =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Mens+Type_Running-Shoes+";

const SEARCHANISE_BASE = "https://searchserverapi.com/getresults";
const API_KEY = "1T0U8M9s3R";

const PAGE_SIZE = 100;
const MAX_PAGES = 120; // you fetched 56 pages; keep a safe cap

const BROWSERISH_HEADERS = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  origin: "https://www.holabirdsports.com",
  referer: "https://www.holabirdsports.com/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
};

/** -------------------- helpers -------------------- **/

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function safeNum(x) {
  const n = typeof x === "number" ? x : parseFloat(String(x ?? ""));
  return Number.isFinite(n) ? n : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractModel(listingName, brand) {
  if (!listingName) return "";

  let m = String(listingName).trim();
  const b = String(brand || "").trim();

  if (b && b !== "Unknown") {
    const re = new RegExp(`^${escapeRegExp(b)}\\s+`, "i");
    m = m.replace(re, "");
  }

  // conservative suffix cleanup
  m = m
    .replace(/\s+running\s+shoe(s)?$/i, "")
    .replace(/\s+shoe(s)?$/i, "")
    .replace(/\s+men'?s$/i, "")
    .trim();

  return m;
}

function toAbsHolabirdUrl(pathOrUrl) {
  if (!pathOrUrl) return null;
  const s = String(pathOrUrl);
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return `https://www.holabirdsports.com${s}`;
  return `https://www.holabirdsports.com/${s}`;
}

function dedupeByUrl(deals) {
  const seen = new Set();
  const out = [];
  for (const d of deals) {
    if (!d?.listingURL) continue;
    if (seen.has(d.listingURL)) continue;
    seen.add(d.listingURL);
    out.push(d);
  }
  return out;
}

/**
 * tags is one string with delimiters: "ALLDEALS[:ATTR:]Brand_X[:ATTR:]COLLECTION-Type-..."
 */
function splitTagTokens(tagsString) {
  if (!tagsString) return [];
  return String(tagsString)
    .split("[:ATTR:]")
    .map((t) => t.trim())
    .filter(Boolean);
}

function tokenIncludes(tokens, needle) {
  const n = String(needle).toLowerCase();
  return tokens.some((t) => String(t).toLowerCase().includes(n));
}

/** -------------------- Searchanise fetch -------------------- **/

function buildUrl(startIndex) {
  const p = new URLSearchParams();
  p.set("api_key", API_KEY);
  p.set("facets", "true");
  p.set("facetsShowUnavailableOptions", "false");
  p.set("startIndex", String(startIndex));
  p.set("maxResults", String(PAGE_SIZE));
  return `${SEARCHANISE_BASE}?${p.toString()}`;
}

async function fetchPage(startIndex) {
  const url = buildUrl(startIndex);
  const startedAt = Date.now();

  const res = await fetch(url, { headers: BROWSERISH_HEADERS });
  const durationMs = Date.now() - startedAt;

  if (!res.ok) {
    return { ok: false, status: res.status, url, durationMs, json: null, items: [], error: `HTTP ${res.status}` };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, status: res.status, url, durationMs, json: null, items: [], error: "JSON parse failed" };
  }

  const items = Array.isArray(json?.items) ? json.items : [];
  return { ok: true, status: res.status, url, durationMs, json, items, error: null };
}

/** -------------------- scrape -------------------- **/

async function scrapeAll() {
  const pageNotes = [];
  const allItems = [];

  let startIndex = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await fetchPage(startIndex);

    pageNotes.push({
      page: `searchanise startIndex=${startIndex}`,
      success: r.ok,
      count: r.items.length,
      error: r.error,
      url: r.url,
      duration: `${r.durationMs}ms`,
      status: r.status,
    });

    if (!r.ok) break;
    if (!r.items.length) break;

    allItems.push(...r.items);

    if (r.items.length < PAGE_SIZE) break;
    startIndex += PAGE_SIZE;
  }

  return { allItems, pageNotes, pagesFetched: pageNotes.length };
}

/** -------------------- filter + transform -------------------- **/

function isRunningShoeDeal(it) {
  const sale = safeNum(it?.price);
  const orig = safeNum(it?.list_price);

  // REAL deal check (most reliable)
  if (!Number.isFinite(sale) || sale <= 0) return false;
  if (!Number.isFinite(orig) || orig <= 0) return false;
  if (sale >= orig) return false;

  // Must be in running-shoes universe (Holabird uses tokens like COLLECTION-Type-Running-Shoes)
  const tokens = splitTagTokens(it?.tags);

  // Broad match: anything containing "Running-Shoes"
  // (covers Type_Running-Shoes, COLLECTION-Type-Running-Shoes, etc.)
  if (!tokenIncludes(tokens, "running-shoes")) return false;

  return true;
}

function transformItemsToDeals(items) {
  const deals = [];

  for (const it of items) {
    if (!isRunningShoeDeal(it)) continue;

    const listingName = String(it?.title || "").trim();
    if (!listingName) continue;

    const brand = String(it?.vendor || "Unknown").trim() || "Unknown";

    let salePrice = round2(safeNum(it?.price));
    let originalPrice = round2(safeNum(it?.list_price));

    // fallback to first variant if needed
    const v0 = Array.isArray(it?.shopify_variants) ? it.shopify_variants[0] : null;
    if ((!Number.isFinite(salePrice) || salePrice <= 0) && v0) salePrice = round2(safeNum(v0?.price));
    if ((!Number.isFinite(originalPrice) || originalPrice <= 0) && v0) originalPrice = round2(safeNum(v0?.list_price));

    if (!Number.isFinite(salePrice) || salePrice <= 0) continue;
    if (!Number.isFinite(originalPrice) || originalPrice <= 0) continue;

    if (salePrice > originalPrice) [salePrice, originalPrice] = [originalPrice, salePrice];
    if (salePrice >= originalPrice) continue;

    const listingURL = toAbsHolabirdUrl(it?.link);
    if (!listingURL) continue;

    const imageURL = it?.image_link || null;

    // This scraper is specifically Mens + Running Shoes collection.
    // Force classification for consistency (and avoid accidental zeroing).
    const gender = "mens";
    const shoeType = "road";

    const model = extractModel(listingName, brand);

    deals.push({
      listingName, // never edit
      brand,
      model,
      salePrice,
      originalPrice,
      discountPercent: computeDiscountPercent(originalPrice, salePrice),
      store: STORE,
      listingURL,
      imageURL,
      gender,
      shoeType,
    });
  }

  return dedupeByUrl(deals);
}

/** -------------------- handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // ✅ COMMENTED OUT FOR TESTING
  /*
  const auth = String(req.headers.authorization || "").trim();
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  */

  const startedAt = Date.now();

  try {
    const { allItems, pageNotes, pagesFetched } = await scrapeAll();
    const deals = transformItemsToDeals(allItems);

    const scrapeDurationMs = Date.now() - startedAt;

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: new Date().toISOString(),
      via: "searchanise",
      sourceUrls: [SOURCE_URL, SEARCHANISE_BASE],
      pagesFetched,
      dealsFound: allItems.length,
      dealsExtracted: deals.length,
      scrapeDurationMs,
      ok: true,
      error: null,
      pageNotes,
      deals,
    };

    const blob = await put("holabird-mens-road.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      ok: true,
      store: output.store,
      dealsExtracted: output.dealsExtracted,
      pagesFetched: output.pagesFetched,
      dealsFound: output.dealsFound,
      scrapeDurationMs: output.scrapeDurationMs,
      blobUrl: blob.url,
      lastUpdated: output.lastUpdated,
    });
  } catch (e) {
    const scrapeDurationMs = Date.now() - startedAt;

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: new Date().toISOString(),
      via: "searchanise",
      sourceUrls: [SOURCE_URL, SEARCHANISE_BASE],
      pagesFetched: 0,
      dealsFound: 0,
      dealsExtracted: 0,
      scrapeDurationMs,
      ok: false,
      error: e?.message || String(e),
      pageNotes: [],
      deals: [],
    };

    await put("holabird-mens-road.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(500).json({ ok: false, error: output.error, scrapeDurationMs });
  }
};
