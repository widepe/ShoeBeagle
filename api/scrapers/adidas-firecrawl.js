// /api/scrapers/adidas-firecrawl.js
//
// Adidas running-shoes sale scraper (Firecrawl -> HTML -> Cheerio parse)
// Saves to Blob as: adidas.json
//
// Pagination rule (safe):
// - Page size ~48 cards.
// - If a page returns >= 48 cards, try next page (?start=+48).
// - Stop when page returns < 48 cards OR when a page adds 0 new unique deals.
// - Hard cap: MAX_PAGES_PER_BASE.
//
// SECURITY (Backcountry style):
// - Requires CRON_SECRET via header:
//     Authorization: Bearer <CRON_SECRET>
//
// ENV REQUIRED:
// - FIRECRAWL_API_KEY
// - BLOB_READ_WRITE_TOKEN

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "Adidas";
const OUT_BLOB_NAME = "adidas.json";
const SCHEMA_VERSION = 1;

const BASE_URLS = [
  "https://www.adidas.com/us/women-running-shoes-sale",
  "https://www.adidas.com/us/men-running-shoes-sale",
];

const PAGE_SIZE = 48;
const MAX_PAGES_PER_BASE = 10;

// Firecrawl retry tuning (handles tunnel hiccups)
const FIRECRAWL_MAX_RETRIES = 4;
const FIRECRAWL_BASE_DELAY_MS = 900;
const FIRECRAWL_TIMEOUT_MS = 60000;
const FIRECRAWL_WAITFOR_MS = 1500;

// --------------------------
// helpers
// --------------------------
function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function toAbsUrl(href) {
  const s = String(href || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("/")) return `https://www.adidas.com${s}`;
  return `https://www.adidas.com/${s.replace(/^\/+/, "")}`;
}

function parseMoneyList(text) {
  // returns numeric values found in "$123.45" / "123.45" contexts
  const s = String(text || "").replace(/,/g, "");
  const matches = [...s.matchAll(/\$?\s*(\d{1,4}(?:\.\d{2})?)/g)];
  const nums = matches
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0);

  // de-dupe near-identical values
  const uniq = [];
  for (const n of nums) {
    if (!uniq.some((x) => Math.abs(x - n) < 0.001)) uniq.push(n);
  }
  return uniq;
}

function computeDiscountPercent(sale, orig) {
  if (!(sale > 0) || !(orig > 0) || sale >= orig) return null;
  const pct = ((orig - sale) / orig) * 100;
  return Number.isFinite(pct) ? Math.round(pct) : null;
}

function inferGenderFromSubtitle(subtitle) {
  const s = String(subtitle || "").toLowerCase();
  if (s.includes("unisex")) return "unisex";
  if (s.includes("women") || s.includes("women’s") || s.includes("women's")) return "womens";
  if (s.includes("men")) return "mens";
  return "unknown";
}

function buildPagedUrl(baseUrl, start) {
  if (!start) return baseUrl;
  const u = new URL(baseUrl);
  u.searchParams.set("start", String(start));
  return u.toString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function looksTransientFirecrawlError(message) {
  const s = String(message || "");
  return (
    /ERR_TUNNEL_CONNECTION_FAILED/i.test(s) ||
    /SCRAPE_SITE_ERROR/i.test(s) ||
    /internal proxy error/i.test(s) ||
    /timed out/i.test(s) ||
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(s)
  );
}

// --------------------------
// Firecrawl (REST) with retries
// --------------------------
async function firecrawlScrapeHtmlOnce(url, apiKey) {
  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["html"],
      waitFor: FIRECRAWL_WAITFOR_MS,
      timeout: FIRECRAWL_TIMEOUT_MS,
    }),
  });

  const json = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg = json?.error || json?.message || `Firecrawl scrape failed (${resp.status})`;
    const body = json ? JSON.stringify(json) : "";
    throw new Error(`${msg}${body ? `: ${body}` : ""}`);
  }

  const html = json?.data?.html || json?.html || null;
  if (!html) throw new Error("Firecrawl response missing HTML (expected data.html)");
  return html;
}

async function firecrawlScrapeHtmlWithRetry(url) {
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY env var");

  let lastErr = null;

  for (let attempt = 0; attempt <= FIRECRAWL_MAX_RETRIES; attempt++) {
    try {
      return await firecrawlScrapeHtmlOnce(url, apiKey);
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);

      const transient = looksTransientFirecrawlError(msg);
      const isLast = attempt === FIRECRAWL_MAX_RETRIES;

      if (!transient || isLast) break;

      const backoff = FIRECRAWL_BASE_DELAY_MS * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * 450);
      await sleep(backoff + jitter);
    }
  }

  throw lastErr || new Error("Firecrawl scrape failed (unknown error)");
}

// --------------------------
// parse deals from Adidas PLP HTML (ROBUST PRICE PARSING)
// --------------------------
function parseDealsFromHtml(html) {
  const $ = cheerio.load(html);

  const cards = $("article[data-testid='plp-product-card']");
  const dealsFound = cards.length;

  const deals = [];
  const dropCounts = {
    totalCards: dealsFound,
    dropped_missingTitle: 0,
    dropped_missingUrl: 0,
    dropped_priceCouldNotParse: 0,
    dropped_notADeal: 0,
    kept: 0,
  };

  let debugFirstCard = null;

  cards.each((i, el) => {
    const $card = $(el);

    const title = normalizeWhitespace(
      $card.find("p[data-testid='product-card-title']").first().text()
    );

    if (!title) {
      dropCounts.dropped_missingTitle += 1;
      return;
    }

    const subtitle = normalizeWhitespace(
      $card.find("p[data-testid='product-card-subtitle']").first().text()
    );

    // URL: try multiple anchors
    const href =
      $card.find("a[data-testid='product-card-image-link']").first().attr("href") ||
      $card.find("a[data-testid='product-card-description-link']").first().attr("href") ||
      $card.find("a").first().attr("href") ||
      "";

    const listingURL = toAbsUrl(href);
    if (!listingURL) {
      dropCounts.dropped_missingUrl += 1;
      return;
    }

    // Image: best effort
    const imgSrc =
      ($card.find("img[data-testid='product-card-primary-image']").first().attr("src") || "").trim() ||
      ($card.find("img").first().attr("src") || "").trim() ||
      "";

    const imageURL = imgSrc ? imgSrc : null;

    // PRICE: pull text from likely price containers, then regex out numbers.
    const priceBlockText =
      normalizeWhitespace($card.find("[data-testid='main-price']").first().text()) ||
      normalizeWhitespace($card.find("[data-testid='price']").first().text()) ||
      normalizeWhitespace($card.text()); // last resort (heavier but robust)

    const nums = parseMoneyList(priceBlockText);

    // We need at least 2 distinct prices to satisfy honesty rule
    if (nums.length < 2) {
      dropCounts.dropped_priceCouldNotParse += 1;

      // Capture debug from the first card we fail on
      if (!debugFirstCard) {
        debugFirstCard = {
          title,
          subtitle,
          listingURL,
          priceBlockText: priceBlockText.slice(0, 500),
          moneyParsed: nums,
          cardHtmlSnippet: String($card.html() || "").slice(0, 1200),
        };
      }
      return;
    }

    const salePrice = Math.min(...nums);
    const originalPrice = Math.max(...nums);

    if (!(salePrice > 0) || !(originalPrice > 0) || salePrice >= originalPrice) {
      dropCounts.dropped_notADeal += 1;

      if (!debugFirstCard) {
        debugFirstCard = {
          title,
          subtitle,
          listingURL,
          priceBlockText: priceBlockText.slice(0, 500),
          moneyParsed: nums,
          salePrice,
          originalPrice,
          cardHtmlSnippet: String($card.html() || "").slice(0, 1200),
        };
      }
      return;
    }

    const discountPercent = computeDiscountPercent(salePrice, originalPrice);

    deals.push({
      listingName: title,
      brand: "Adidas",
      model: title,

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
      imageURL,

      gender: inferGenderFromSubtitle(subtitle),
      shoeType: "unknown",
    });

    dropCounts.kept += 1;

    // Keep one “good” debug example too (optional)
    if (i === 0) {
      debugFirstCard = debugFirstCard || {
        title,
        subtitle,
        listingURL,
        priceBlockText: priceBlockText.slice(0, 500),
        moneyParsed: nums,
        salePrice,
        originalPrice,
      };
    }
  });

  return {
    dealsFound,
    dealsExtracted: deals.length,
    deals,
    dropCounts,
    __debug_firstCard: debugFirstCard,
  };
}

// --------------------------
// scrapeAll (women + men + pagination)
// --------------------------
async function scrapeAll(runId) {
  const start = Date.now();
  const lastUpdated = nowIso();

  let ok = true;
  let error = null;

  const seen = new Set();
  const deals = [];

  const sourceUrls = [];
  let pagesFetched = 0;
  let dealsFound = 0;

  const pageNotes = [];
  const totalDropCounts = {
    totalCards: 0,
    dropped_missingTitle: 0,
    dropped_missingUrl: 0,
    dropped_priceCouldNotParse: 0,
    dropped_notADeal: 0,
    kept: 0,
  };

  let debugFirstCard = null;

  try {
    for (const baseUrl of BASE_URLS) {
      for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_BASE; pageIndex++) {
        const startOffset = pageIndex * PAGE_SIZE;
        const url = buildPagedUrl(baseUrl, startOffset);

        if (pageIndex > 0) await sleep(650 + Math.floor(Math.random() * 650));

        let html = null;
        try {
          html = await firecrawlScrapeHtmlWithRetry(url);
        } catch (e) {
          const msg = e?.message || String(e);
          if (pageIndex === 0) throw e; // base page failing should fail run
          pageNotes.push({ url, note: `Stopping pagination for this base due to error: ${msg}` });
          break;
        }

        pagesFetched += 1;
        sourceUrls.push(url);

        const parsed = parseDealsFromHtml(html);
        dealsFound += parsed.dealsFound;

        // accumulate drop counts + capture debug once
        for (const k of Object.keys(totalDropCounts)) {
          totalDropCounts[k] += Number(parsed.dropCounts?.[k] || 0);
        }
        if (!debugFirstCard && parsed.__debug_firstCard) debugFirstCard = parsed.__debug_firstCard;

        const before = deals.length;
        for (const d of parsed.deals) {
          const key = d.listingURL || `${d.listingName}::${d.salePrice}::${d.originalPrice}`;
          if (seen.has(key)) continue;
          seen.add(key);
          deals.push(d);
        }
        const newDealsThisPage = deals.length - before;

        pageNotes.push({
          url,
          cards: parsed.dealsFound,
          keptByParser: parsed.dealsExtracted,
          addedUnique: newDealsThisPage,
        });

        // Stop if not full OR no new unique deals
        if (parsed.dealsFound < PAGE_SIZE || newDealsThisPage === 0) break;
      }
    }
  } catch (e) {
    ok = false;
    error = e?.message || String(e);
  }

  return {
    store: STORE,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated,
    via: "firecrawl",

    sourceUrls,
    pagesFetched,

    dealsFound,
    dealsExtracted: deals.length,

    scrapeDurationMs: Date.now() - start,

    ok,
    error,

    deals,
    runId,

    pageNotes,
    dropCounts: totalDropCounts,
    __debug_firstCard: debugFirstCard,
  };
}

// --------------------------
// handler (Backcountry-style response)
// --------------------------
module.exports = async function handler(req, res) {
  const runId = `adidas-${Date.now().toString(36)}`;
  const t0 = Date.now();
/*
  // REQUIRE CRON SECRET (exact pattern you wanted)
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers["authorization"] !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
*/
  let payload = null;

  try {
    const blobToken = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
    if (!blobToken) {
      return res.status(500).json({ ok: false, error: "Missing BLOB_READ_WRITE_TOKEN" });
    }

    payload = await scrapeAll(runId);

    const blobRes = await put(OUT_BLOB_NAME, JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      token: blobToken,
    });

    return res.status(200).json({
      ok: payload.ok,
      runId,
      store: STORE,
      savedAs: OUT_BLOB_NAME,
      blobUrl: blobRes.url,
      pagesFetched: payload.pagesFetched,
      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,
      elapsedMs: Date.now() - t0,
      error: payload.error || null,
    });
  } catch (err) {
    const lastUpdated = nowIso();
    const fallbackError = err?.message || String(err);

    const failPayload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated,
      via: "firecrawl",
      sourceUrls: payload?.sourceUrls || [],
      pagesFetched: payload?.pagesFetched || 0,
      dealsFound: payload?.dealsFound || 0,
      dealsExtracted: payload?.dealsExtracted || 0,
      scrapeDurationMs: Date.now() - t0,
      ok: false,
      error: fallbackError,
      deals: [],
      runId,
    };

    try {
      const blobToken = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
      const blobRes = await put(OUT_BLOB_NAME, JSON.stringify(failPayload, null, 2), {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
        token: blobToken,
      });

      return res.status(200).json({
        ok: false,
        runId,
        store: STORE,
        savedAs: OUT_BLOB_NAME,
        blobUrl: blobRes.url,
        error: fallbackError,
        elapsedMs: Date.now() - t0,
      });
    } catch (writeErr) {
      return res.status(500).json({
        ok: false,
        runId,
        store: STORE,
        error: `${fallbackError} | plus failed to write blob: ${writeErr?.message || String(writeErr)}`,
        elapsedMs: Date.now() - t0,
      });
    }
  }
};
