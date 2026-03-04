// /api/scrapers/holabird-mens-road.js
// Holabird Sports — Mens Road Running Shoe Deals via Searchanise (RunUnited-style)
// ✅ Uses Searchanise JSON (items[], totalItems, startIndex, itemsPerPage)
// ✅ Filters using Holabird tag tokens like: Gender_Mens, Type_Running-Shoes, ALLDEALS
// ✅ Canonical 11-field deals schema
// ✅ Your top-level structure (store/schemaVersion/lastUpdated/via/sourceUrls/pagesFetched/dealsFound/dealsExtracted/scrapeDurationMs/ok/error)
// ✅ Model extracted from listingName
// ✅ Dedupe by listingURL
// ✅ CRON secret auth is COMMENTED OUT for testing (you can re-enable later)

const { put } = require("@vercel/blob");

const STORE = "Holabird Sports";
const SCHEMA_VERSION = 1;

const SOURCE_URL =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Mens+Type_Running-Shoes+";

const SEARCHANISE_BASE = "https://searchserverapi.com/getresults";
const API_KEY = "1T0U8M9s3R";

const PAGE_SIZE = 100;     // try 100; if Holabird caps lower, it’ll just return fewer
const MAX_PAGES = 80;      // safety cap

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

// Keep this conservative: remove brand prefix + common suffixes, don’t over-strip
function extractModel(listingName, brand) {
  if (!listingName) return "";

  let m = String(listingName).trim();
  const b = String(brand || "").trim();

  if (b && b !== "Unknown") {
    const re = new RegExp(`^${escapeRegExp(b)}\\s+`, "i");
    m = m.replace(re, "");
  }

  // remove common trailing category words
  m = m
    .replace(/\s+running\s+shoe(s)?$/i, "")
    .replace(/\s+men'?s$/i, "")
    .replace(/\s+women'?s$/i, "")
    .trim();

  return m;
}

function detectShoeType(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(trail|gore-tex|gtx|off-road|mountain)\b/.test(t)) return "trail";
  if (/\b(track|spike|spikes)\b/.test(t)) return "track";
  return "road";
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
 * Holabird Searchanise "tags" field is a single string like:
 * "ALLDEALS[:ATTR:]bis-hidden[:ATTR:]Brand_HEAD[:ATTR:]...[:ATTR:]Gender_Unisex..."
 *
 * We’ll split on "[:ATTR:]" and match tokens exactly.
 */
function splitTagTokens(tagsString) {
  if (!tagsString) return [];
  return String(tagsString)
    .split("[:ATTR:]")
    .map((t) => t.trim())
    .filter(Boolean);
}

function hasToken(tokens, wantedPrefixOrExact) {
  // allow exact match or "Prefix_" patterns
  // e.g. "Gender_Mens" exact, or "Brand_" prefix
  if (!wantedPrefixOrExact) return false;
  const w = String(wantedPrefixOrExact);

  if (w.endsWith("_")) {
    return tokens.some((t) => t.startsWith(w));
  }
  return tokens.includes(w);
}

/** -------------------- Searchanise fetch -------------------- **/

function buildSearchaniseUrl(startIndex) {
  const p = new URLSearchParams();
  p.set("api_key", API_KEY);

  // these exist in many Searchanise setups; harmless if ignored
  p.set("output", "json");
  p.set("items", "true");
  p.set("facets", "true");
  p.set("facetsShowUnavailableOptions", "false");

  // pagination
  p.set("startIndex", String(startIndex));
  p.set("maxResults", String(PAGE_SIZE));

  // IMPORTANT: force “deals” collection behavior by restricting to shoe-deals collection tag
  // Holabird encodes collection in tags as "COLLECTION-..."
  // We don't know the exact Searchanise restrictBy keys, so we instead filter client-side,
  // but we still include q=* to get items back.
  p.set("q", "*");

  return `${SEARCHANISE_BASE}?${p.toString()}`;
}

async function fetchPage(startIndex) {
  const url = buildSearchaniseUrl(startIndex);
  const startedAt = Date.now();

  const res = await fetch(url, { headers: { accept: "application/json" } });
  const durationMs = Date.now() - startedAt;

  if (!res.ok) {
    return { ok: false, status: res.status, url, durationMs, json: null, error: `HTTP ${res.status}` };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, status: res.status, url, durationMs, json: null, error: "JSON parse failed" };
  }

  const items = Array.isArray(json?.items) ? json.items : [];
  const totalItems = safeNum(json?.totalItems) ?? null;

  return { ok: true, status: res.status, url, durationMs, json, items, totalItems, error: null };
}

/** -------------------- scrape all pages -------------------- **/

async function scrapeAll() {
  const pageNotes = [];
  const allItems = [];

  let startIndex = 0;
  let pagesFetched = 0;

  while (pagesFetched < MAX_PAGES) {
    const r = await fetchPage(startIndex);

    pageNotes.push({
      page: `searchanise startIndex=${startIndex}`,
      success: r.ok,
      count: r.items?.length || 0,
      error: r.error,
      url: r.url,
      duration: `${r.durationMs}ms`,
      status: r.status,
    });

    pagesFetched++;

    if (!r.ok) break;
    if (!r.items.length) break;

    allItems.push(...r.items);

    // last page detection: fewer than PAGE_SIZE usually means end
    if (r.items.length < PAGE_SIZE) break;

    startIndex += PAGE_SIZE;
  }

  return { allItems, pageNotes, pagesFetched };
}

/** -------------------- transform -------------------- **/

function isMensRunningDeal(item) {
  const tokens = splitTagTokens(item?.tags);

  // Must be a deal
  const isDeal = hasToken(tokens, "ALLDEALS");

  // Must be mens running shoes (Holabird uses Type_Running-Shoes and Gender_Mens in URL)
  // BUT tokens may sometimes vary, so we accept either:
  // - exact Gender_Mens token
  // - or title contains "Men" (fallback)
  const genderTokenMens = hasToken(tokens, "Gender_Mens");

  // Running shoes type token (exact in URL: Type_Running-Shoes)
  const runningType = hasToken(tokens, "Type_Running-Shoes") || hasToken(tokens, "Type_Running Shoes");

  // Must be shoe-ish: sometimes "COLLECTION-Type-Running-Shoes" exists too
  const hasShoeHint =
    runningType ||
    hasToken(tokens, "COLLECTION-Type-Running-Shoes") ||
    hasToken(tokens, "COLLECTION-Type-Running Shoes");

  const title = String(item?.title || "").toLowerCase();
  const titleMens = /\bmen\b|\bmen's\b/.test(title);

  return isDeal && hasShoeHint && (genderTokenMens || titleMens);
}

function transformItems(items) {
  const deals = [];

  for (const it of items) {
    if (!isMensRunningDeal(it)) continue;

    const listingName = String(it?.title || "").trim();
    if (!listingName) continue;

    const brand = String(it?.vendor || it?.brand || "Unknown").trim();

    // Holabird format in your sample:
    // price = sale (string "11.0000")
    // list_price = original (string "20.0000")
    let salePrice = round2(safeNum(it?.price));
    let originalPrice = round2(safeNum(it?.list_price));

    // fallback: choose from first variant if present (often more reliable)
    const v0 = Array.isArray(it?.shopify_variants) ? it.shopify_variants[0] : null;
    if ((!Number.isFinite(salePrice) || salePrice <= 0) && v0) salePrice = round2(safeNum(v0?.price));
    if ((!Number.isFinite(originalPrice) || originalPrice <= 0) && v0) originalPrice = round2(safeNum(v0?.list_price));

    // honesty rule: must have both, must be a real deal
    if (!Number.isFinite(salePrice) || salePrice <= 0) continue;
    if (!Number.isFinite(originalPrice) || originalPrice <= 0) continue;

    // swap if needed
    if (salePrice > originalPrice) [salePrice, originalPrice] = [originalPrice, salePrice];

    if (salePrice >= originalPrice) continue;

    const listingURL = toAbsHolabirdUrl(it?.link);
    if (!listingURL) continue;

    const imageURL = it?.image_link || null;

    // classify
    const shoeType = detectShoeType(listingName);
    if (shoeType !== "road") continue;

    const model = extractModel(listingName, brand);

    deals.push({
      listingName,               // NEVER EDIT
      brand,
      model,
      salePrice,
      originalPrice,
      discountPercent: computeDiscountPercent(originalPrice, salePrice),
      store: STORE,
      listingURL,
      imageURL,
      gender: "mens",
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

  // ✅ COMMENT OUT FOR TESTING if you want
  /*
  const auth = String(req.headers.authorization || "").trim();
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  */

  const startedAt = Date.now();

  try {
    const { allItems, pageNotes, pagesFetched } = await scrapeAll();
    const deals = transformItems(allItems);

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
