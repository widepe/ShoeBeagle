// /api/run-kohls.js  (CommonJS)
// Hit this route manually to test: /api/run-kohls
//
// Purpose:
// - Fetch 2 Kohl's catalog pages (Sale + Clearance running shoes)
// - Extract canonical 11-field deals
// - Upload to Vercel Blob as kohls.json
//
// Debug logging:
// - Logs request start, fetch status, HTML size, response headers (safe subset),
//   body preview on errors, extraction counts, sample deal, and blob write result.
// - Logs are designed to be removable later.

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const SOURCES = [
  {
    key: "sale",
    url: "https://www.kohls.com/catalog/sale-adult-running-shoes.jsp?CN=Promotions:Sale+AgeAppropriate:Adult+Activity:Running+Department:Shoes",
  },
  {
    key: "clearance",
    url: "https://www.kohls.com/catalog/clearance-adult-running-shoes.jsp?CN=Promotions:Clearance+AgeAppropriate:Adult+Activity:Running+Department:Shoes",
  },
];

const BLOB_PATHNAME = "kohls.json";
const MAX_ITEMS_TOTAL = 5000;

// Keep headers simple; Kohl's may still block Vercel IPs.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  // Sometimes helps, sometimes not. Safe to include.
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

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

function safeHeaderSnapshot(res) {
  // Only log a small safe subset of headers that help debug blocking.
  // Avoid logging cookies/set-cookie contents.
  const pick = ["content-type", "content-length", "server", "date", "x-cache", "via"];
  const out = {};
  for (const k of pick) {
    const v = res.headers.get(k);
    if (v) out[k] = v;
  }
  // Add location if present (redirects)
  const loc = res.headers.get("location");
  if (loc) out.location = loc;
  return out;
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
  if (href.startsWith("http")) return href;
  return `https://www.kohls.com${href}`;
}

function parseMoney(text) {
  if (!text) return null;
  const m = String(text).replace(/\s+/g, " ").match(/\$?\s*([\d,]+(\.\d{2})?)/);
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

function detectGenderFromListingName(listingName) {
  const s = (listingName || "").toLowerCase();
  if (s.includes("men's") || s.includes("mens ")) return "mens";
  if (s.includes("women's") || s.includes("womens ")) return "womens";
  return "unknown";
}

// Your rule: unknown unless explicitly says trail/road/track in the listing text
function detectShoeTypeFromListingName(listingName) {
  const s = (listingName || "").toLowerCase();
  if (s.includes("trail")) return "trail";
  if (s.includes("road")) return "road";
  if (s.includes("track")) return "track";
  return "unknown";
}

function parseBrandModel(listingName) {
  const name = (listingName || "").trim();
  if (!name) return { brand: "unknown", model: "unknown" };

  const parts = name.split(/\s+/);
  const brand = parts[0] ? parts[0].trim() : "unknown";

  let rest = parts.slice(1).join(" ").trim();
  if (!rest) return { brand, model: "unknown" };

  rest = rest
    .replace(/\bmen'?s\b/gi, "")
    .replace(/\bwomen'?s\b/gi, "")
    .replace(/\bunisex\b/gi, "")
    .replace(/\brunning shoes?\b/gi, "")
    .replace(/\bshoes?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const model = rest ? rest : "unknown";
  return { brand, model };
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
// FETCH (WITH DEBUG)
// -----------------------------
async function fetchHtml(url, runId) {
  const t0 = Date.now();
  console.log(`[${runId}] KOHLS fetch start: ${url}`);

  let res;
  let text = "";

  try {
    res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  } catch (e) {
    console.error(`[${runId}] KOHLS fetch network error after ${msSince(t0)}:`, e);
    throw e;
  }

  try {
    text = await res.text();
  } catch (e) {
    console.error(`[${runId}] KOHLS read body error after ${msSince(t0)}:`, e);
    throw e;
  }

  console.log(
    `[${runId}] KOHLS fetch done: status=${res.status} ok=${res.ok} time=${msSince(t0)} htmlLen=${text.length}`
  );
  console.log(`[${runId}] KOHLS headers:`, safeHeaderSnapshot(res));

  if (!res.ok) {
    console.log(`[${runId}] KOHLS body preview:`, shortText(text, 300));
    // Helpful: detect common block words
    const lower = text.toLowerCase();
    const hints = [];
    if (lower.includes("access denied")) hints.push("contains 'access denied'");
    if (lower.includes("forbidden")) hints.push("contains 'forbidden'");
    if (lower.includes("akamai")) hints.push("contains 'akamai'");
    if (lower.includes("perimeterx") || lower.includes("px-captcha") || lower.includes("px")) hints.push("looks like PX");
    if (lower.includes("captcha")) hints.push("contains 'captcha'");
    if (hints.length) console.log(`[${runId}] KOHLS block hints:`, hints.join(", "));
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return text;
}

// -----------------------------
// PARSE / EXTRACT
// -----------------------------
function extractDealsFromHtml(html, runId, sourceKey) {
  const t0 = Date.now();
  const $ = cheerio.load(html);
  const deals = [];

  // Count how many potential cards exist (even if we end up skipping)
  const cardCount = $('div[data-webid]').length;
  console.log(`[${runId}] KOHLS parse ${sourceKey}: cardsFound=${cardCount}`);

  $("div[data-webid]").each((_, el) => {
    const card = $(el);

    // listingName MUST come from the highlighted listing text
    const listingName = card.find('a[data-dte="product-title"]').first().text().trim();
    if (!listingName) return;

    const href = card.find('a[href^="/product/prd-"]').first().attr("href") || null;
    const listingURL = absUrl(href);

    const imageURL = card.find('img[data-dte="product-image"]').first().attr("src") || null;

    const salePriceText = card
      .find('span[data-dte="product-sub-sale-price"]')
      .first()
      .text()
      .trim();
    const regPriceText = card
      .find('span[data-dte="product-sub-regular-price"]')
      .first()
      .text()
      .trim();

    const salePrice = parseMoney(salePriceText);
    const originalPrice = parseMoney(regPriceText);
    const discountPercent = calcDiscountPercent(salePrice, originalPrice);

    const gender = detectGenderFromListingName(listingName);
    const shoeType = detectShoeTypeFromListingName(listingName);

    const { brand, model } = parseBrandModel(listingName);

    deals.push({
      listingName,
      brand: brand || "unknown",
      model: model || "unknown",
      salePrice: salePrice ?? null,
      originalPrice: originalPrice ?? null,
      discountPercent: discountPercent ?? null,
      store: "Kohls",
      listingURL: listingURL ?? null,
      imageURL: imageURL ?? null,
      gender,
      shoeType,
    });
  });

  const deduped = uniqByKey(deals, (d) => d.listingURL || `${d.listingName}||${d.imageURL || ""}`)
    .slice(0, MAX_ITEMS_TOTAL);

  console.log(
    `[${runId}] KOHLS parse ${sourceKey}: extracted=${deals.length} deduped=${deduped.length} time=${msSince(t0)}`
  );

  // Log one sample (safe) to verify selectors quickly
  if (deduped.length) {
    const s = deduped[0];
    console.log(`[${runId}] KOHLS sample ${sourceKey}:`, {
      listingName: shortText(s.listingName, 80),
      salePrice: s.salePrice,
      originalPrice: s.originalPrice,
      listingURL: s.listingURL ? s.listingURL.slice(0, 80) : null,
    });
  } else {
    console.log(`[${runId}] KOHLS sample ${sourceKey}: none`);
  }

  return deduped;
}

async function scrapeAll(runId) {
  const startedAt = nowIso();
  const t0 = Date.now();
  const perSourceCounts = {};
  const allDeals = [];

  for (const src of SOURCES) {
    console.log(`[${runId}] KOHLS source start: ${src.key}`);
    const html = await fetchHtml(src.url, runId);
    const deals = extractDealsFromHtml(html, runId, src.key);
    perSourceCounts[src.key] = deals.length;
    allDeals.push(...deals);
    console.log(`[${runId}] KOHLS source done: ${src.key} deals=${deals.length}`);
  }

  const deals = uniqByKey(allDeals, (d) => d.listingURL || `${d.listingName}||${d.imageURL || ""}`)
    .slice(0, MAX_ITEMS_TOTAL);

  console.log(
    `[${runId}] KOHLS scrapeAll: totalBeforeDedupe=${allDeals.length} totalAfterDedupe=${deals.length} time=${msSince(t0)}`
  );

  return {
    meta: {
      store: "Kohls",
      scrapedAt: nowIso(),
      startedAt,
      sourcePages: SOURCES,
      countsBySource: perSourceCounts,
      totalDeals: deals.length,
      notes: [
        "Defaults: gender and shoeType are 'unknown' unless explicitly present in listingName.",
        "shoeType only set if listingName contains trail/road/track.",
        "listingName comes from a[data-dte='product-title'] (not img alt).",
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
  const runId = `kohls-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const t0 = Date.now();

  console.log(`[${runId}] KOHLS handler start ${nowIso()}`);
  console.log(`[${runId}] method=${req.method} path=${req.url || ""}`);
  console.log(
    `[${runId}] env: hasBlobToken=${Boolean(process.env.BLOB_READ_WRITE_TOKEN)} node=${process.version}`
  );

  try {
    const data = await scrapeAll(runId);

    console.log(
      `[${runId}] KOHLS blob write start: ${BLOB_PATHNAME} totalDeals=${data.meta.totalDeals}`
    );

    const blobRes = await put(BLOB_PATHNAME, JSON.stringify(data, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    console.log(`[${runId}] KOHLS blob write done: url=${blobRes.url} time=${msSince(t0)}`);

    res.status(200).json({
      ok: true,
      runId,
      totalDeals: data.meta.totalDeals,
      countsBySource: data.meta.countsBySource,
      blobUrl: blobRes.url,
      elapsedMs: Date.now() - t0,
    });
  } catch (err) {
    console.error(`[${runId}] Kohls scrape failed:`, err);
    res.status(500).json({
      ok: false,
      runId,
      error: String(err && err.message ? err.message : err),
      elapsedMs: Date.now() - t0,
    });
  } finally {
    console.log(`[${runId}] KOHLS handler end time=${msSince(t0)}`);
  }
};
