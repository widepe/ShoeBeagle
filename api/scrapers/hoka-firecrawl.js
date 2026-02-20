// /api/scrapers/hoka-firecrawl.js  (CommonJS)
// Hit this route manually to test: /api/scrapers/hoka-firecrawl
//
// Purpose:
// - Fetch HOKA sale shoes page via Firecrawl
// - Extract canonical deals
// - Upload to Vercel Blob as hoka.json
//
// Env vars required:
//   FIRECRAWL_API_KEY
//   BLOB_READ_WRITE_TOKEN
//   CRON_SECRET   (required for this route; runner passes x-cron-secret)
//
// Auth:
// - Requires CRON_SECRET via header "x-cron-secret" OR query ?key=...

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "HOKA";

const SOURCES = [
  {
    key: "sale",
    url: "https://www.hoka.com/en/us/sale/?prefn1=type&prefv1=shoes",
  },
];

const BLOB_PATHNAME = "hoka.json";
const MAX_ITEMS_TOTAL = 5000;
const SCHEMA_VERSION = 1;

// -----------------------------
// DEBUG HELPERS
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}

function msSince(t0) {
  return Date.now() - t0;
}

function shortText(s, n = 220) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// -----------------------------
// CORE HELPERS
// -----------------------------
function absUrl(href) {
  if (!href) return null;
  const h = String(href).trim();
  if (!h) return null;
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("//")) return "https:" + h;
  return new URL(h, "https://www.hoka.com").toString();
}

function parseMoney(text) {
  if (!text) return null;
  const m = String(text)
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .match(/\$?\s*([\d,]+(\.\d{1,2})?)/);
  if (!m) return null;
  const num = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(num) ? num : null;
}

function calcDiscountPercent(salePrice, originalPrice) {
  if (salePrice == null || originalPrice == null) return null;
  if (!(originalPrice > 0)) return null;
  const pct = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  return Number.isFinite(pct) ? pct : null;
}

// Gender MUST come from .product-group in tile — no fallback.
// Allowed: "womens", "mens", "unisex" — anything else returns null (exclude deal).
function normalizeGender(label) {
  const s = String(label || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "women" || s === "women's" || s === "womens") return "womens";
  if (s === "men" || s === "men's" || s === "mens") return "mens";
  if (s === "unisex") return "unisex";
  return null;
}

function detectShoeType(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (s.includes("trail")) return "trail";
  if (s.includes("road")) return "road";
  if (s.includes("track")) return "track";
  return "unknown";
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqByKey(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyFn(it);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

// -----------------------------
// FIRECRAWL FETCH
// -----------------------------
async function fetchHtmlViaFirecrawl(url, runId) {
  const t0 = Date.now();
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY env var is not set");

  console.log(`[${runId}] HOKA firecrawl start: ${url}`);

  let res;
  let json;

  try {
    res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ["html"],
        onlyMainContent: false,
        waitFor: 3000,
        timeout: 60000,
      }),
    });
  } catch (e) {
    console.error(`[${runId}] HOKA firecrawl network error:`, e);
    throw e;
  }

  try {
    json = await res.json();
  } catch (e) {
    const text = await res.text().catch(() => "");
    console.error(`[${runId}] HOKA firecrawl JSON parse error. Body:`, (text || "").slice(0, 300));
    throw e;
  }

  console.log(
    `[${runId}] HOKA firecrawl done: status=${res.status} ok=${res.ok} time=${msSince(t0)}ms`
  );

  if (!res.ok || !json?.success) {
    console.log(`[${runId}] HOKA firecrawl error:`, JSON.stringify(json).slice(0, 300));
    throw new Error(`Firecrawl failed: ${res.status} — ${json?.error || "unknown error"}`);
  }

  const html = json?.data?.html || json?.html || "";
  console.log(`[${runId}] HOKA firecrawl htmlLen=${html.length}`);
  if (!html) throw new Error("Firecrawl returned empty HTML");

  return html;
}

// -----------------------------
// PARSE / EXTRACT
// -----------------------------
function extractDealsFromHtml(html, runId, sourceKey) {
  const t0 = Date.now();
  const $ = cheerio.load(html);
  const deals = [];

  const cardCount = $(".product-tile__primary").length;
  console.log(`[${runId}] HOKA parse ${sourceKey}: cardsFound=${cardCount}`);

  $(".product-tile__primary").each((_, el) => {
    const $tile = $(el);

    // Gender — MUST come from .product-group only, no fallback
    const genderLabel = $tile.find(".tile-product-name .product-group").first().text().trim();
    const gender = normalizeGender(genderLabel);
    if (!gender) return;

    // Model name — full link text minus the gender label
    const fullNameText = $tile
      .find(".tile-product-name .pdp-link a")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    const model = fullNameText
      .replace(new RegExp(`^${escapeRegExp(genderLabel)}\\s*`, "i"), "")
      .trim();
    if (!model) return;

    const listingName = `${genderLabel} ${model}`.trim();

    // Listing URL
    const href = $tile.find(".tile-product-name .pdp-link a").first().attr("href") || null;
    const listingURL = absUrl(href);
    if (!listingURL) return;

    // Prices — require BOTH sale and original
    const salePriceText = $tile.find(".price .sales").first().text().trim();
    const originalPriceText = $tile.find(".price .strike-through .value").first().text().trim();

    const salePrice = parseMoney(salePriceText);
    const originalPrice = parseMoney(originalPriceText);
    if (salePrice == null || originalPrice == null) return;
    if (salePrice <= 0 || originalPrice <= 0) return;

    const discountPercent = calcDiscountPercent(salePrice, originalPrice);
    const shoeType = detectShoeType(listingName);

    // Image URL
    const imgSrc =
      $tile.find("img.tile-image").first().attr("src") ||
      $tile.find("picture img").first().attr("src") ||
      null;

    const imageURL = absUrl(imgSrc);
    if (!imageURL) return;

    deals.push({
      schemaVersion: SCHEMA_VERSION,

      listingName,
      brand: "HOKA",
      model,

      salePrice,
      originalPrice,
      discountPercent,

      // range fields not used on HOKA currently
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,

      store: STORE,
      listingURL,
      imageURL,
      gender,
      shoeType,
    });
  });

  const deduped = uniqByKey(deals, (d) => d.listingURL || d.listingName).slice(0, MAX_ITEMS_TOTAL);

  console.log(
    `[${runId}] HOKA parse ${sourceKey}: extracted=${deals.length} deduped=${deduped.length} time=${msSince(t0)}ms`
  );

  if (deduped.length) {
    const s = deduped[0];
    console.log(`[${runId}] HOKA sample ${sourceKey}:`, {
      listingName: shortText(s.listingName, 80),
      salePrice: s.salePrice,
      originalPrice: s.originalPrice,
      listingURL: s.listingURL ? s.listingURL.slice(0, 80) : null,
    });
  } else {
    console.log(`[${runId}] HOKA sample ${sourceKey}: none`);
  }

  return deduped;
}

// -----------------------------
// SCRAPE ALL SOURCES
// -----------------------------
async function scrapeAll(runId) {
  const startedAt = Date.now();
  const sourceUrls = SOURCES.map((s) => s.url);
  const allDeals = [];

  for (const src of SOURCES) {
    console.log(`[${runId}] HOKA source start: ${src.key}`);
    const html = await fetchHtmlViaFirecrawl(src.url, runId);
    const deals = extractDealsFromHtml(html, runId, src.key);
    allDeals.push(...deals);
    console.log(`[${runId}] HOKA source done: ${src.key} deals=${deals.length}`);
  }

  const deals = uniqByKey(allDeals, (d) => d.listingURL || d.listingName).slice(0, MAX_ITEMS_TOTAL);
  const scrapeDurationMs = msSince(startedAt);

  console.log(
    `[${runId}] HOKA scrapeAll: totalBeforeDedupe=${allDeals.length} totalAfterDedupe=${deals.length} durationMs=${scrapeDurationMs}`
  );

  return {
    store: STORE,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated: nowIso(),
    via: "firecrawl",

    sourceUrls,
    pagesFetched: SOURCES.length,

    dealsFound: allDeals.length,
    dealsExtracted: deals.length,

    scrapeDurationMs,

    ok: true,
    error: null,

    deals,
  };
}

// -----------------------------
// HANDLER
// -----------------------------
module.exports = async function handler(req, res) {
  const runId = `hoka-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const t0 = Date.now();

  // ✅ REQUIRE CRON SECRET (same pattern as your other scrapers)
  const CRON_SECRET = String(process.env.CRON_SECRET || "").trim();
  if (!CRON_SECRET) {
    return res.status(500).json({ ok: false, error: "CRON_SECRET not configured" });
  }

  const provided = String(req.headers["x-cron-secret"] || req.query?.key || "").trim();
  if (provided !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  console.log(`[${runId}] HOKA handler start ${nowIso()}`);
  console.log(`[${runId}] method=${req.method} path=${req.url || ""}`);
  console.log(
    `[${runId}] env: hasBlobToken=${Boolean(process.env.BLOB_READ_WRITE_TOKEN)} hasFirecrawlKey=${Boolean(
      process.env.FIRECRAWL_API_KEY
    )} node=${process.version}`
  );

  try {
    const data = await scrapeAll(runId);

    console.log(
      `[${runId}] HOKA blob write start: ${BLOB_PATHNAME} dealsExtracted=${data.dealsExtracted}`
    );

    const blobRes = await put(BLOB_PATHNAME, JSON.stringify(data, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    console.log(`[${runId}] HOKA blob write done: url=${blobRes.url} time=${msSince(t0)}ms`);
    console.log(`[${runId}] HOKA expected env url: ${process.env.HOKA_DEALS_BLOB_URL || "not set"}`);

    res.status(200).json({
      ok: true,
      runId,
      dealsExtracted: data.dealsExtracted,
      dealsFound: data.dealsFound,
      pagesFetched: data.pagesFetched,
      blobUrl: blobRes.url,
      elapsedMs: msSince(t0),
    });
  } catch (err) {
    console.error(`[${runId}] HOKA scrape failed:`, err);
    res.status(500).json({
      ok: false,
      runId,
      error: String(err && err.message ? err.message : err),
      elapsedMs: msSince(t0),
    });
  } finally {
    console.log(`[${runId}] HOKA handler end time=${msSince(t0)}ms`);
  }
};
