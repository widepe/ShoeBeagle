// /api/scrapers/kohls-firecrawl.js  (CommonJS)
// Hit this route manually to test (must include secret):
//   /api/scrapers/kohls-firecrawl?key=YOUR_CRON_SECRET
//
// Purpose:
// - Fetch Kohl's sale + clearance running shoes pages via Firecrawl
// - Extract canonical deals with optional range fields (imageURL included)
// - Upload to Vercel Blob as kohls.json
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

const STORE = "Kohls";

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
  return new URL(h, "https://www.kohls.com").toString();
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

// For ranges: "up to" based on (originalHigh - saleLow) / originalHigh
function calcDiscountPercentUpTo(saleLow, originalHigh) {
  if (saleLow == null || originalHigh == null) return null;
  if (!(originalHigh > 0)) return null;
  const pct = Math.round(((originalHigh - saleLow) / originalHigh) * 100);
  return Number.isFinite(pct) ? pct : null;
}

function detectGender(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (s.includes("women's") || s.includes("womens")) return "womens";
  if (s.includes("men's") || s.includes("mens")) return "mens";
  if (s.includes("unisex")) return "unisex";
  return "unknown";
}

function detectShoeType(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (s.includes("trail")) return "trail";
  if (s.includes("track") || s.includes("spike")) return "track";
  if (s.includes("road")) return "road";
  return "unknown";
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

function firstUrlFromSrcset(srcset) {
  if (!srcset) return null;
  const first = String(srcset).split(",")[0]?.trim();
  if (!first) return null;
  return first.split(/\s+/)[0] || null;
}

function getImageUrlFromCard($card) {
  const $img = $card.find('img[data-dte="product-image"]').first();
  if (!$img.length) return null;

  const src = $img.attr("src") || $img.attr("data-src") || $img.attr("data-original") || null;

  const srcset = $img.attr("srcset") || $img.attr("data-srcset") || null;

  const fromSrcset = firstUrlFromSrcset(srcset);

  return absUrl(src || fromSrcset);
}

function collectMoneyValues($, $elements) {
  const nums = [];
  $elements.each((_, el) => {
    const t = $(el).text();
    const n = parseMoney(t);
    if (n != null && Number.isFinite(n)) nums.push(n);
  });

  // de-dupe exact duplicates (common with nested spans)
  const uniq = Array.from(new Set(nums.map((x) => Number(x.toFixed(2))))).map(Number);
  uniq.sort((a, b) => a - b);
  return uniq;
}

// -----------------------------
// FIRECRAWL FETCH
// -----------------------------
async function fetchHtmlViaFirecrawl(url, runId) {
  const t0 = Date.now();
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY env var is not set");

  console.log(`[${runId}] KOHLS firecrawl start: ${url}`);

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
    console.error(`[${runId}] KOHLS firecrawl network error:`, e);
    throw e;
  }

  try {
    json = await res.json();
  } catch (e) {
    const text = await res.text().catch(() => "");
    console.error(`[${runId}] KOHLS firecrawl JSON parse error. Body:`, (text || "").slice(0, 300));
    throw e;
  }

  console.log(
    `[${runId}] KOHLS firecrawl done: status=${res.status} ok=${res.ok} time=${msSince(t0)}ms`
  );

  if (!res.ok || !json?.success) {
    console.log(`[${runId}] KOHLS firecrawl error:`, JSON.stringify(json).slice(0, 300));
    throw new Error(`Firecrawl failed: ${res.status} — ${json?.error || "unknown error"}`);
  }

  const html = json?.data?.html || json?.html || "";
  console.log(`[${runId}] KOHLS firecrawl htmlLen=${html.length}`);
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

  const cardCount = $("[data-webid]").length;
  console.log(`[${runId}] KOHLS parse ${sourceKey}: cardsFound=${cardCount}`);

  $("[data-webid]").each((_, el) => {
    const $card = $(el);

    // Listing name + URL
    const $title = $card.find('a[data-dte="product-title"]').first();
    const listingName = $title.text().replace(/\s+/g, " ").trim();
    if (!listingName) return;

    const href = $title.attr("href") || null;
    const listingURL = absUrl(href);
    if (!listingURL) return;

    // Image URL
    const imageURL = getImageUrlFromCard($card);
    if (!imageURL) return;

    // Price values (support multiple)
    const saleValues = collectMoneyValues($, $card.find('[data-dte="product-sub-sale-price"]'));
    const originalValues = collectMoneyValues($, $card.find('[data-dte="product-sub-regular-price"]'));

    // Require BOTH
    if (!saleValues.length || !originalValues.length) return;

    const saleLow = saleValues[0];
    const saleHigh = saleValues[saleValues.length - 1];
    const origLow = originalValues[0];
    const origHigh = originalValues[originalValues.length - 1];

    if (!(saleLow > 0) || !(origLow > 0)) return;

    const isSaleRange = saleValues.length > 1 && saleLow !== saleHigh;
    const isOrigRange = originalValues.length > 1 && origLow !== origHigh;
    const isAnyRange = isSaleRange || isOrigRange;

    // Legacy + range fields
    let salePrice = null;
    let originalPrice = null;
    let discountPercent = null;

    let salePriceLow = null;
    let salePriceHigh = null;
    let originalPriceLow = null;
    let originalPriceHigh = null;
    let discountPercentUpTo = null;

    if (!isAnyRange) {
      salePrice = saleLow;
      originalPrice = origLow;
      discountPercent = calcDiscountPercent(salePrice, originalPrice);
    } else {
      salePriceLow = saleLow;
      salePriceHigh = saleHigh;
      originalPriceLow = origLow;
      originalPriceHigh = origHigh;
      discountPercentUpTo = calcDiscountPercentUpTo(salePriceLow, originalPriceHigh);
    }

    const gender = detectGender(listingName);
    const shoeType = detectShoeType(listingName);

    // Brand/model heuristic
    const brand = listingName.split(/\s+/)[0] || "unknown";
    const model =
      listingName
        .slice(brand.length)
        .replace(/\bwomen'?s\b/gi, "")
        .replace(/\bmen'?s\b/gi, "")
        .replace(/\bunisex\b/gi, "")
        .replace(/\brunning shoes?\b/gi, "")
        .replace(/\bshoes?\b/gi, "")
        .replace(/\s+/g, " ")
        .trim() || "unknown";

    deals.push({
      schemaVersion: SCHEMA_VERSION,

      listingName,
      brand,
      model,

      salePrice,
      originalPrice,
      discountPercent,

      salePriceLow,
      salePriceHigh,
      originalPriceLow,
      originalPriceHigh,
      discountPercentUpTo,

      store: STORE,

      listingURL,
      imageURL,

      gender,
      shoeType,
    });
  });

  const deduped = uniqByKey(deals, (d) => d.listingURL || d.listingName).slice(0, MAX_ITEMS_TOTAL);

  console.log(
    `[${runId}] KOHLS parse ${sourceKey}: extracted=${deals.length} deduped=${deduped.length} time=${msSince(
      t0
    )}ms`
  );

  if (deduped.length) {
    const s = deduped[0];
    console.log(`[${runId}] KOHLS sample ${sourceKey}:`, {
      listingName: shortText(s.listingName, 80),
      listingURL: s.listingURL ? s.listingURL.slice(0, 80) : null,
      imageURL: s.imageURL ? s.imageURL.slice(0, 80) : null,
      salePrice: s.salePrice,
      originalPrice: s.originalPrice,
      salePriceLow: s.salePriceLow,
      salePriceHigh: s.salePriceHigh,
      originalPriceLow: s.originalPriceLow,
      originalPriceHigh: s.originalPriceHigh,
      discountPercent: s.discountPercent,
      discountPercentUpTo: s.discountPercentUpTo,
      gender: s.gender,
      shoeType: s.shoeType,
    });
  } else {
    console.log(`[${runId}] KOHLS sample ${sourceKey}: none`);
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
    console.log(`[${runId}] KOHLS source start: ${src.key}`);
    const html = await fetchHtmlViaFirecrawl(src.url, runId);
    const deals = extractDealsFromHtml(html, runId, src.key);
    allDeals.push(...deals);
    console.log(`[${runId}] KOHLS source done: ${src.key} deals=${deals.length}`);
  }

  const deals = uniqByKey(allDeals, (d) => d.listingURL || d.listingName).slice(0, MAX_ITEMS_TOTAL);
  const scrapeDurationMs = msSince(startedAt);

  console.log(
    `[${runId}] KOHLS scrapeAll: totalBeforeDedupe=${allDeals.length} totalAfterDedupe=${deals.length} durationMs=${scrapeDurationMs}`
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
// HANDLER (WITH CRON SECRET)
// -----------------------------
module.exports = async function handler(req, res) {
  const runId = `kohls-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const t0 = Date.now();

  // ✅ REQUIRE CRON SECRET (same pattern as your other scrapers)
const secret = process.env.CRON_SECRET;
if (secret && req.headers["authorization"] !== `Bearer ${secret}`) {
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

  console.log(`[${runId}] KOHLS handler start ${nowIso()}`);
  console.log(`[${runId}] method=${req.method} path=${req.url || ""}`);
  console.log(
    `[${runId}] env: hasBlobToken=${Boolean(process.env.BLOB_READ_WRITE_TOKEN)} hasFirecrawlKey=${Boolean(
      process.env.FIRECRAWL_API_KEY
    )} node=${process.version}`
  );

  try {
    const data = await scrapeAll(runId);

    console.log(
      `[${runId}] KOHLS blob write start: ${BLOB_PATHNAME} dealsExtracted=${data.dealsExtracted}`
    );

    const blobRes = await put(BLOB_PATHNAME, JSON.stringify(data, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    console.log(`[${runId}] KOHLS blob write done: url=${blobRes.url} time=${msSince(t0)}ms`);

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
    console.error(`[${runId}] KOHLS scrape failed:`, err);
    res.status(500).json({
      ok: false,
      runId,
      error: String(err && err.message ? err.message : err),
      elapsedMs: msSince(t0),
    });
  } finally {
    console.log(`[${runId}] KOHLS handler end time=${msSince(t0)}ms`);
  }
};
