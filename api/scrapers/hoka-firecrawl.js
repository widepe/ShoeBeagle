// /api/scrapers/hoka-firecrawl.js 
// Hit this route manually to test: /api/run-hoka
//
// Purpose:
// - Fetch HOKA sale shoes page via Firecrawl (scrape endpoint)
// - Extract canonical 11-field deals
// - Upload to Vercel Blob as hoka.json
//
// Debug logging:
// - Logs request start, fetch status, HTML size, extraction counts, sample deal, blob write result.

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const SOURCES = [
  {
    key: "sale",
    url: "https://www.hoka.com/en/us/sale/?prefn1=type&prefv1=shoes",
  },
];

const BLOB_PATHNAME = "hoka.json";
const MAX_ITEMS_TOTAL = 5000;

// -----------------------------
// DEBUG HELPERS
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}

function msSince(t0) {
  const ms = Date.now() - t0;
  return `${ms}ms`;
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
  if (/^https?:\/\//i.test(href)) return href;
  return new URL(href, "https://www.hoka.com").toString();
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

// Gender MUST be present in listing tile text (NO fallback to URL or elsewhere).
// Allowed: "womens", "mens", "unisex" — anything else returns null (exclude deal).
function normalizeGender(label) {
  const s = String(label || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "women" || s === "women's" || s === "womens") return "womens";
  if (s === "men" || s === "men's" || s === "mens") return "mens";
  if (s === "unisex") return "unisex";
  return null;
}

function detectShoeTypeFromListingName(listingName) {
  const s = (listingName || "").toLowerCase();
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
  const apiKey = process.env.FIRECRAWL_API_KEY;

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
        waitFor: 3000, // allow JS-rendered content to settle
      }),
    });
  } catch (e) {
    console.error(`[${runId}] HOKA firecrawl network error after ${msSince(t0)}:`, e);
    throw e;
  }

  try {
    json = await res.json();
  } catch (e) {
    console.error(`[${runId}] HOKA firecrawl parse error after ${msSince(t0)}:`, e);
    throw e;
  }

  console.log(
    `[${runId}] HOKA firecrawl done: status=${res.status} ok=${res.ok} time=${msSince(t0)}`
  );

  if (!res.ok || !json.success) {
    console.log(`[${runId}] HOKA firecrawl error response:`, JSON.stringify(json).slice(0, 300));
    throw new Error(`Firecrawl failed: ${res.status} — ${json?.error || "unknown error"}`);
  }

  const html = json?.data?.html || "";
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

    // Gender — MUST come from .product-group, no fallback
    const genderLabel = $tile.find(".tile-product-name .product-group").first().text().trim();
    const gender = normalizeGender(genderLabel);
    if (!gender) return;

    // Model name — full link text minus the gender label
    const fullNameText = $tile.find(".tile-product-name .pdp-link a").first().text().replace(/\s+/g, " ").trim();
    const model = fullNameText.replace(new RegExp(`^${escapeRegExp(genderLabel)}\\s*`, "i"), "").trim();
    if (!model) return;

    const listingName = `${genderLabel} ${model}`.trim();

    // Listing URL
    const href = $tile.find(".tile-product-name .pdp-link a").first().attr("href") || null;
    const listingURL = absUrl(href);
    if (!listingURL) return;

    // Image — already hydrated src, no data-src needed
    const imageURL = $tile.find(".image-container .tile-image").first().attr("src") || null;

    // Prices — require both
    const salePriceText = $tile.find(".price .sales").first().text().trim();
    const originalPriceText = $tile.find(".price .strike-through .value").first().text().trim();

    const salePrice = parseMoney(salePriceText);
    const originalPrice = parseMoney(originalPriceText);
    if (salePrice == null || originalPrice == null) return;
    if (salePrice <= 0 || originalPrice <= 0) return;

    const discountPercent = calcDiscountPercent(salePrice, originalPrice);
    const shoeType = detectShoeTypeFromListingName(listingName);

    deals.push({
      listingName,
      brand: "hoka",
      model,
      salePrice,
      originalPrice,
      discountPercent,
      store: "HOKA",
      listingURL,
      imageURL: imageURL ?? null,
      gender,
      shoeType,
    });
  });

  const deduped = uniqByKey(
    deals,
    (d) => d.listingURL || `${d.listingName}||${d.imageURL || ""}`
  ).slice(0, MAX_ITEMS_TOTAL);

  console.log(
    `[${runId}] HOKA parse ${sourceKey}: extracted=${deals.length} deduped=${deduped.length} time=${msSince(t0)}`
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

async function scrapeAll(runId) {
  const startedAt = nowIso();
  const t0 = Date.now();
  const perSourceCounts = {};
  const allDeals = [];

  for (const src of SOURCES) {
    console.log(`[${runId}] HOKA source start: ${src.key}`);
    const html = await fetchHtmlViaFirecrawl(src.url, runId);
    const deals = extractDealsFromHtml(html, runId, src.key);
    perSourceCounts[src.key] = deals.length;
    allDeals.push(...deals);
    console.log(`[${runId}] HOKA source done: ${src.key} deals=${deals.length}`);
  }

  const deals = uniqByKey(
    allDeals,
    (d) => d.listingURL || `${d.listingName}||${d.imageURL || ""}`
  ).slice(0, MAX_ITEMS_TOTAL);

  console.log(
    `[${runId}] HOKA scrapeAll: totalBeforeDedupe=${allDeals.length} totalAfterDedupe=${deals.length} time=${msSince(t0)}`
  );

  return {
    meta: {
      store: "HOKA",
      scrapedAt: nowIso(),
      startedAt,
      sourcePages: SOURCES,
      countsBySource: perSourceCounts,
      totalDeals: deals.length,
      notes: [
        "Gender MUST be present in tile listing label; no fallback; allowed: womens/mens/unisex.",
        "shoeType only set if listingName contains trail/road/track; otherwise 'unknown'.",
        "Both salePrice and originalPrice required — tiles missing either are excluded.",
        "Fetched via Firecrawl scrape API with waitFor:3000 to allow JS rendering.",
      ],
      runId,
    },
    deals,
  };
}

// -----------------------------
// HANDLER
// -----------------------------
module.exports = async function handler(req, res) {
  const runId = `hoka-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const t0 = Date.now();

  console.log(`[${runId}] HOKA handler start ${nowIso()}`);
  console.log(`[${runId}] method=${req.method} path=${req.url || ""}`);
  console.log(
    `[${runId}] env: hasBlobToken=${Boolean(process.env.BLOB_READ_WRITE_TOKEN)} hasFirecrawlKey=${Boolean(process.env.FIRECRAWL_API_KEY)} node=${process.version}`
  );

  try {
    const data = await scrapeAll(runId);

    console.log(
      `[${runId}] HOKA blob write start: ${BLOB_PATHNAME} totalDeals=${data.meta.totalDeals}`
    );

    const blobRes = await put(BLOB_PATHNAME, JSON.stringify(data, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    console.log(`[${runId}] HOKA blob write done: url=${blobRes.url} time=${msSince(t0)}`);

    res.status(200).json({
      ok: true,
      runId,
      totalDeals: data.meta.totalDeals,
      countsBySource: data.meta.countsBySource,
      blobUrl: blobRes.url,
      elapsedMs: Date.now() - t0,
    });
  } catch (err) {
    console.error(`[${runId}] HOKA scrape failed:`, err);
    res.status(500).json({
      ok: false,
      runId,
      error: String(err && err.message ? err.message : err),
      elapsedMs: Date.now() - t0,
    });
  } finally {
    console.log(`[${runId}] HOKA handler end time=${msSince(t0)}`);
  }
};
