// /api/going-going-gone.js  (CommonJS)
//
// GoingGoingGone Firecrawl scraper (Vercel)
//
// Rules you required:
// - ONLY running shoes: listingName MUST contain "running shoes" (case-insensitive)
// - No sneakers/other products
// - shoeType is road/trail/track/unknown -> for this site ALWAYS "unknown"
// - Store is "GoingGoingGone"
// - Upload blob to STABLE name: "going-going-gone.json"
// - Top-level structure matches your standard
// - HTTP response must be a SMALL SUMMARY (no big deals array)
//
// Env vars:
// - FIRECRAWL_API_KEY
// - BLOB_READ_WRITE_TOKEN
// - (optional) CRON_SECRET
//
// Note: This intentionally does NOT use any DSG internal API endpoints (no zipcode/storeId).

const { put } = require("@vercel/blob");
const cheerio = require("cheerio");

const STORE = "GoingGoingGone";
const SCHEMA_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function makeRunId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `goinggoinggone-${rand}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeDiscountPercent(sale, original) {
  if (!Number.isFinite(sale) || !Number.isFinite(original) || original <= 0) return null;
  const pct = ((original - sale) / original) * 100;
  return round2(pct);
}

function isRunningShoeTitle(title) {
  return /running shoes/i.test(title);
}

function parseMoneyToNumber(text) {
  if (!text) return null;
  const m = String(text).match(/([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function guessGenderFromTitle(title) {
  if (/women/i.test(title)) return "women";
  if (/men/i.test(title)) return "men";
  return "unknown";
}

function extractBrandModel(listingName) {
  const cleaned = String(listingName || "").trim().replace(/\s+/g, " ");
  const lower = cleaned.toLowerCase();
  const knownTwoWordBrands = ["new balance"];

  for (const b of knownTwoWordBrands) {
    if (lower.startsWith(b + " ")) {
      const brand = b
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      const rest = cleaned.slice(b.length).trim();
      return {
        brand,
        model: rest.replace(/\s+running shoes$/i, "").trim() || rest,
      };
    }
  }

  const first = cleaned.split(" ")[0] || "Unknown";
  const rest = cleaned.slice(first.length).trim();

  return {
    brand: first,
    model: rest.replace(/\s+running shoes$/i, "").trim() || rest || first,
  };
}

// Firecrawl scrape helper (HTML)
async function firecrawlGetHtml(url, apiKey) {
  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["html"],
      // keep broad so we can parse product grids
      onlyMainContent: false,
    }),
  });

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Firecrawl non-JSON response (status ${resp.status}): ${text.slice(0, 200)}`);
  }

  if (!resp.ok || !json.success) {
    const msg = json.error || json.message || `Firecrawl error (status ${resp.status})`;
    throw new Error(msg);
  }

  const html = json?.data?.html;
  if (!html || typeof html !== "string") {
    throw new Error("Firecrawl returned no HTML");
  }

  return html;
}

// Parse a GoingGoingGone listing page HTML
function parseDealsFromHtml(html) {
  const $ = cheerio.load(html);

  // Collect anchors to product pages (/p/...)
  // We'll de-dupe by href.
  const uniq = new Map();

  $('a[href^="/p/"]').each((_, a) => {
    const href = ($(a).attr("href") || "").trim();
    if (!href) return;

    if (uniq.has(href)) return;

    // Title sources: aria-label often contains full product name
    const aria = ($(a).attr("aria-label") || "").trim();
    const textTitle = ($(a).text() || "").replace(/\s+/g, " ").trim();
    const title = (aria || textTitle || "").trim();

    // Image
    const img = $(a).find("img").first();
    const imageURL = (img.attr("src") || img.attr("data-src") || "").trim();

    // Nearby text for prices: use closest reasonably-sized container
    // We try a few parent levels to find price text.
    let container = $(a).closest("div");
    if (!container || container.length === 0) container = $(a).parent();

    const blobText = (container.text() || "").replace(/\s+/g, " ").trim();
    const priceMatches = blobText.match(/\$[0-9]+(?:\.[0-9]{1,2})?/g) || [];

    uniq.set(href, { href, title, imageURL, priceMatches });
  });

  return Array.from(uniq.values());
}

// Pagination
function buildPageUrl(baseUrl, pageNumber) {
  return pageNumber === 0 ? baseUrl : `${baseUrl}&page=${pageNumber + 1}`;
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  const runId = makeRunId();

  // -----------------------------------
  // CRON SECRET (COMMENTED OUT FOR TEST)
  // -----------------------------------
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  // Only allow GET/POST
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
  if (!FIRECRAWL_API_KEY) {
    return res.status(500).json({ success: false, error: "Missing FIRECRAWL_API_KEY" });
  }

  const BASE_URL = "https://www.goinggoinggone.com/f/shop-all-womens-sale?pageSize=24";
  const MAX_PAGES = 6;

  const sourceUrls = [];
  const pageNotes = [];
  const deals = [];

  const dropCounts = {
    totalProducts: 0,
    dropped_notRunningShoes: 0,
    dropped_missingPrices: 0,
    dropped_missingUrl: 0,
    dropped_other: 0,
    kept: 0,
  };

  let ok = true;
  let error = null;

  // Build URLs
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    sourceUrls.push(buildPageUrl(BASE_URL, pageNumber));
  }

  // Scrape sequentially (gentler)
  try {
    for (let i = 0; i < sourceUrls.length; i++) {
      const url = sourceUrls[i];

      const html = await firecrawlGetHtml(url, FIRECRAWL_API_KEY);
      const items = parseDealsFromHtml(html);

      pageNotes.push({ pageNumber: i, cards: items.length });

      for (const it of items) {
        dropCounts.totalProducts += 1;

        const href = String(it.href || "").trim();
        const listingURL = href.startsWith("http")
          ? href
          : href
          ? `https://www.goinggoinggone.com${href}`
          : "";

        if (!listingURL || listingURL === "https://www.goinggoinggone.com") {
          dropCounts.dropped_missingUrl += 1;
          continue;
        }

        const listingName = String(it.title || "").replace(/\s+/g, " ").trim();
        if (!listingName) {
          dropCounts.dropped_other += 1;
          continue;
        }

        // RULE: must explicitly say "running shoes"
        if (!isRunningShoeTitle(listingName)) {
          dropCounts.dropped_notRunningShoes += 1;
          continue;
        }

        const priceMatches = Array.isArray(it.priceMatches) ? it.priceMatches : [];
        const salePrice = priceMatches.length >= 1 ? parseMoneyToNumber(priceMatches[0]) : null;
        const originalPrice = priceMatches.length >= 2 ? parseMoneyToNumber(priceMatches[1]) : null;

        if (salePrice == null || originalPrice == null) {
          dropCounts.dropped_missingPrices += 1;
          continue;
        }

        const discountPercent = computeDiscountPercent(salePrice, originalPrice);

        // Drop negative/zero “discount”
        if (discountPercent == null || discountPercent <= 0) {
          dropCounts.dropped_other += 1;
          continue;
        }

        const { brand, model } = extractBrandModel(listingName);
        const gender = guessGenderFromTitle(listingName);

        deals.push({
          schemaVersion: 1,

          listingName,

          brand: String(brand || "").trim(),
          model: String(model || "").trim(),

          salePrice,
          originalPrice,
          discountPercent,

          salePriceLow: null,
          salePriceHigh: null,
          originalPriceLow: null,
          originalPriceHigh: null,
          discountPercentUpTo: null,

          store: STORE,

          listingURL,
          imageURL: String(it.imageURL || "").trim(),

          gender,
          shoeType: "unknown",
        });

        dropCounts.kept += 1;
      }
    }
  } catch (e) {
    ok = false;
    error = String(e && e.message ? e.message : e);
  }

  const payload = {
    store: STORE,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated: nowIso(),
    via: "vercel",

    sourceUrls,
    pagesFetched: pageNotes.length,

    dealsFound: dropCounts.totalProducts,
    dealsExtracted: deals.length,

    scrapeDurationMs: Date.now() - startedAt,

    ok,
    error,

    deals,

    runId,
    pageNotes,
    dropCounts,

    blobUrl: null,
  };

  // Upload to Vercel Blob (stable filename)
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) throw new Error("Missing BLOB_READ_WRITE_TOKEN");

    const blob = await put("going-going-gone.json", JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      token,
    });

    payload.blobUrl = blob.url;
  } catch (e) {
    payload.ok = false;
    payload.error = payload.error
      ? `${payload.error} | blob upload failed: ${String(e && e.message ? e.message : e)}`
      : `blob upload failed: ${String(e && e.message ? e.message : e)}`;
  }

  // IMPORTANT: Response is SMALL SUMMARY ONLY (no deals array in response)
  return res.status(payload.ok ? 200 : 500).json({
    store: payload.store,
    schemaVersion: payload.schemaVersion,
    lastUpdated: payload.lastUpdated,
    via: payload.via,
    sourceUrls: payload.sourceUrls,
    pagesFetched: payload.pagesFetched,
    dealsFound: payload.dealsFound,
    dealsExtracted: payload.dealsExtracted,
    scrapeDurationMs: payload.scrapeDurationMs,
    ok: payload.ok,
    error: payload.error,
    runId: payload.runId,
    pageNotes: payload.pageNotes,
    dropCounts: payload.dropCounts,
    blobUrl: payload.blobUrl,
  });
};
