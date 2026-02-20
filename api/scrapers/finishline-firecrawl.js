// /api/scrapers/finishline-firecrawl.js  (CommonJS)
// Hit manually: /api/scrapers/finishline-firecrawl
//
// Purpose:
// - Fetch Finish Line running sale PLP pages via Firecrawl
// - Extract canonical deals
// - Upload to Vercel Blob as finishline.json (stable)
//
// Key fixes:
// - Pagination stops if a page repeats OR adds zero NEW extracted deals.
// - Selector-based "price in bag" skip (based on your outerHTML).
// - BLOB_PATHNAME is stable ("finishline.json").
//
// Env vars required:
//   FIRECRAWL_API_KEY
//   BLOB_READ_WRITE_TOKEN
//   CRON_SECRET
//
// Auth:
// - Requires CRON_SECRET via header "x-cron-secret" OR query ?key=...

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "Finish Line";
const SCHEMA_VERSION = 1;
const VIA = "firecrawl";

const BLOB_PATHNAME = "finishline.json"; // ✅ stable -> .../finishline.json

// Your intended base URL (Finish Line may canonicalize / rewrite this)
const BASE_URL = "https://www.finishline.com/plp/all-sale/activity%3Drunning";

// How many pages max to attempt (we will stop early when pagination stalls)
const MAX_PAGES = 12;
const MAX_ITEMS_TOTAL = 5000;

// -----------------------------
// DEBUG HELPERS
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}

function msSince(t0) {
  return Date.now() - t0;
}

function shortText(s, n = 160) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// -----------------------------
// CORE HELPERS
// -----------------------------
function absFinishlineUrl(href) {
  if (!href) return null;
  const h = String(href).trim();
  if (!h) return null;
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("//")) return "https:" + h;
  return new URL(h, "https://www.finishline.com").toString();
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

// Allowed ONLY: "womens", "mens", "unisex" — anything else returns null (exclude).
function normalizeGenderFromListingName(listingName) {
  const s = String(listingName || "").trim().toLowerCase();
  if (!s) return null;

  if (s.startsWith("women's") || s.startsWith("womens")) return "womens";
  if (s.startsWith("men's") || s.startsWith("mens")) return "mens";
  if (s.startsWith("unisex")) return "unisex";

  return null; // exclude kids, big kids, grade school, etc.
}

function detectShoeType(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (s.includes("trail")) return "trail";
  if (s.includes("road")) return "road";
  if (s.includes("track")) return "track";
  return "unknown";
}

function stripLeadingGender(listingName) {
  return String(listingName || "")
    .replace(/^Women’s\s+/i, "")
    .replace(/^Women's\s+/i, "")
    .replace(/^Womens\s+/i, "")
    .replace(/^Men’s\s+/i, "")
    .replace(/^Men's\s+/i, "")
    .replace(/^Mens\s+/i, "")
    .replace(/^Unisex\s+/i, "")
    .trim();
}

function parseBrandModel(listingName) {
  const s = stripLeadingGender(listingName);

  const multiWordBrands = [
    "New Balance",
    "Under Armour",
    "On Running",
    "HOKA ONE ONE",
    "Hoka One One",
  ];

  for (const b of multiWordBrands) {
    if (s.toLowerCase().startsWith(b.toLowerCase() + " ")) {
      const brand = b;
      const model = s.slice(b.length).trim();
      return { brand, model: model || s || "unknown" };
    }
  }

  const first = s.split(/\s+/)[0] || "";
  const brand = first || s || "unknown";
  const model = s.slice(brand.length).trim() || s || "unknown";
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

function buildPageUrl(baseUrl, pageNum) {
  const u = new URL(baseUrl);
  if (pageNum <= 1) {
    u.searchParams.delete("page");
  } else {
    u.searchParams.set("page", String(pageNum));
  }
  return u.toString();
}

function extractCanonicalHrefFromHtml(html) {
  // Try to detect when Finish Line drops the filter and canonicalizes
  // to /plp/all-sale (symptom you saw in the address bar).
  const m = String(html || "").match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

// -----------------------------
// FIRECRAWL FETCH
// -----------------------------
async function fetchHtmlViaFirecrawl(url, runId) {
  const t0 = Date.now();
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY env var is not set");

  console.log(`[${runId}] FINISHLINE firecrawl start: ${url}`);

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
        // If your plan supports and you want it:
        // proxy: "auto",
        // blockAds: true,
      }),
    });
  } catch (e) {
    console.error(`[${runId}] FINISHLINE firecrawl network error:`, e);
    throw e;
  }

  try {
    json = await res.json();
  } catch (e) {
    const text = await res.text().catch(() => "");
    console.error(
      `[${runId}] FINISHLINE firecrawl JSON parse error. Body:`,
      (text || "").slice(0, 300)
    );
    throw e;
  }

  console.log(
    `[${runId}] FINISHLINE firecrawl done: status=${res.status} ok=${res.ok} time=${msSince(t0)}ms`
  );

  if (!res.ok || !json?.success) {
    console.log(`[${runId}] FINISHLINE firecrawl error:`, JSON.stringify(json).slice(0, 400));
    throw new Error(`Firecrawl failed: ${res.status} — ${json?.error || "unknown error"}`);
  }

  const html = json?.data?.html || json?.html || "";
  console.log(`[${runId}] FINISHLINE firecrawl htmlLen=${html.length}`);
  if (!html) throw new Error("Firecrawl returned empty HTML");

  return html;
}

// -----------------------------
// PARSE / EXTRACT (one page)
// -----------------------------
function extractDealsFromHtml(html, runId, pageUrl) {
  const t0 = Date.now();
  const $ = cheerio.load(html);

  const canonical = extractCanonicalHrefFromHtml(html);

  // Stable selector from your outerHTML
  const $cards = $('div[data-testid="product-item"]');
  const cardsFound = $cards.length;

  // Fingerprint for "same page again" detection
  const firstHref = $cards.first().find('a[href*="/pdp/"]').first().attr("href") || "";
  const firstTitle = $cards.first().find("h4").first().text().replace(/\s+/g, " ").trim() || "";
  const fingerprint = `${cardsFound}|${firstHref}|${firstTitle}`.slice(0, 700);

  console.log(`[${runId}] FINISHLINE parse: cardsFound=${cardsFound} url=${pageUrl}`);
  if (canonical) console.log(`[${runId}] FINISHLINE canonical: ${canonical}`);

  const deals = [];
  let priceInBagSkipped = 0;

  $cards.each((_, el) => {
    const $card = $(el);

    const listingName = $card.find("h4").first().text().replace(/\s+/g, " ").trim();
    if (!listingName) return;

    const gender = normalizeGenderFromListingName(listingName);
    if (!gender) return;

    const shoeType = detectShoeType(listingName);

    const href = $card.find('a[href*="/pdp/"]').first().attr("href") || null;
    const listingURL = absFinishlineUrl(href);
    if (!listingURL) return;

    const imgSrc = $card.find("img").first().attr("src") || null;
    const imageURL = absFinishlineUrl(imgSrc);
    if (!imageURL) return;

    // Price-in-bag detection (based on your real card):
    // <h4 class="... text-default-onSale">See price in bag</h4>
    const saleTextRaw = $card
      .find("h4.text-default-onSale")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    if (saleTextRaw && !/\$\s*\d/.test(saleTextRaw)) {
      priceInBagSkipped += 1;
      return;
    }

    const originalText = $card
      .find("p.line-through")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    const salePrice = parseMoney(saleTextRaw);
    const originalPrice = parseMoney(originalText);

    if (salePrice == null || originalPrice == null) return;
    if (salePrice <= 0 || originalPrice <= 0) return;

    const discountPercent = calcDiscountPercent(salePrice, originalPrice);
    const { brand, model } = parseBrandModel(listingName);

    deals.push({
      schemaVersion: SCHEMA_VERSION,

      listingName,
      brand,
      model,

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

      gender,
      shoeType,
    });
  });

  console.log(
    `[${runId}] FINISHLINE parse done: extracted=${deals.length} priceInBagSkipped=${priceInBagSkipped} time=${msSince(
      t0
    )}ms`
  );

  return {
    deals,
    cardsFound,
    fingerprint,
    firstHref,
    firstTitle,
    priceInBagSkipped,
    canonical,
  };
}

// -----------------------------
// SCRAPE PAGINATED
// -----------------------------
async function scrapeAll(runId) {
  const startedAt = Date.now();

  const sourceUrls = [];
  const allDeals = [];

  let pagesFetched = 0;
  let dealsFound = 0;
  let priceInBagSkippedTotal = 0;

  const seenFingerprints = new Set();
  const seenListingUrls = new Set();

  // Optional debug to prove pagination behavior in the blob
  const pageDebug = [];

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const pageUrl = buildPageUrl(BASE_URL, pageNum);
    sourceUrls.push(pageUrl);

    console.log(`[${runId}] FINISHLINE page start: page=${pageNum} url=${pageUrl}`);

    const html = await fetchHtmlViaFirecrawl(pageUrl, runId);
    pagesFetched += 1;

    const {
      deals,
      cardsFound,
      fingerprint,
      firstHref,
      firstTitle,
      priceInBagSkipped,
      canonical,
    } = extractDealsFromHtml(html, runId, pageUrl);

    pageDebug.push({
      pageNum,
      pageUrl,
      canonical: canonical || null,
      cardsFound,
      extractedThisPage: deals.length,
      firstHref: firstHref ? absFinishlineUrl(firstHref) : null,
      firstTitle: firstTitle || null,
    });

    // Stop if no cards
    if (cardsFound === 0) {
      console.log(`[${runId}] FINISHLINE stop: cardsFound=0 page=${pageNum}`);
      break;
    }

    // Stop if exact same page repeats
    if (seenFingerprints.has(fingerprint)) {
      console.log(`[${runId}] FINISHLINE stop: pagination stalled (repeat fingerprint) page=${pageNum}`);
      break;
    }
    seenFingerprints.add(fingerprint);

    dealsFound += cardsFound;
    priceInBagSkippedTotal += priceInBagSkipped;

    // Add deals, but track whether the page contributed anything NEW.
    let newOnThisPage = 0;
    for (const d of deals) {
      const key = d.listingURL;
      if (!key) continue;
      if (seenListingUrls.has(key)) continue;
      seenListingUrls.add(key);
      allDeals.push(d);
      newOnThisPage += 1;

      if (allDeals.length >= MAX_ITEMS_TOTAL) break;
    }

    console.log(
      `[${runId}] FINISHLINE page done: page=${pageNum} cardsFound=${cardsFound} extracted=${deals.length} newUnique=${newOnThisPage}`
    );

    // ✅ Critical stop condition for your exact scenario:
    // If there is no real page 2, Finish Line serves page 1 again or serves a page
    // that contributes zero NEW extracted deals — so stop.
    if (pageNum > 1 && newOnThisPage === 0) {
      console.log(`[${runId}] FINISHLINE stop: page contributed 0 new unique deals page=${pageNum}`);
      break;
    }

    if (allDeals.length >= MAX_ITEMS_TOTAL) {
      console.log(`[${runId}] FINISHLINE stop: MAX_ITEMS_TOTAL reached (${MAX_ITEMS_TOTAL})`);
      break;
    }
  }

  const deduped = uniqByKey(allDeals, (d) => d.listingURL || d.listingName).slice(0, MAX_ITEMS_TOTAL);
  const scrapeDurationMs = msSince(startedAt);

  return {
    store: STORE,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated: nowIso(),
    via: VIA,

    sourceUrls,
    pagesFetched,

    dealsFound, // total product cards seen across fetched pages
    dealsExtracted: deduped.length,

    scrapeDurationMs,

    ok: true,
    error: null,

    priceInBagSkipped: priceInBagSkippedTotal,

    // helpful proof of behavior (remove if you want it ultra-minimal)
    pageDebug,

    deals: deduped,
  };
}

// -----------------------------
// HANDLER
// -----------------------------
module.exports = async function handler(req, res) {
  const runId = `finishline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const t0 = Date.now();

  /*  CRON_SECRET
  const CRON_SECRET = String(process.env.CRON_SECRET || "").trim();
  if (!CRON_SECRET) {
    return res.status(500).json({ ok: false, error: "CRON_SECRET not configured" });
  }

  const provided = String(req.headers["x-cron-secret"] || req.query?.key || "").trim();
  if (provided !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
*/
  console.log(`[${runId}] FINISHLINE handler start ${nowIso()}`);
  console.log(`[${runId}] method=${req.method} path=${req.url || ""}`);
  console.log(
    `[${runId}] env: hasBlobToken=${Boolean(process.env.BLOB_READ_WRITE_TOKEN)} hasFirecrawlKey=${Boolean(
      process.env.FIRECRAWL_API_KEY
    )} node=${process.version}`
  );

  try {
    const data = await scrapeAll(runId);

    console.log(
      `[${runId}] FINISHLINE blob write start: ${BLOB_PATHNAME} dealsExtracted=${data.dealsExtracted}`
    );

    const blobRes = await put(BLOB_PATHNAME, JSON.stringify(data, null, 2), {
      access: "public",
      addRandomSuffix: false, // ✅ stable
      contentType: "application/json",
    });

    console.log(`[${runId}] FINISHLINE blob write done: url=${blobRes.url} time=${msSince(t0)}ms`);

    res.status(200).json({
      ok: true,
      runId,
      store: STORE,
      dealsExtracted: data.dealsExtracted,
      dealsFound: data.dealsFound,
      pagesFetched: data.pagesFetched,
      priceInBagSkipped: data.priceInBagSkipped,
      blobUrl: blobRes.url,
      elapsedMs: msSince(t0),
    });
  } catch (err) {
    console.error(`[${runId}] FINISHLINE scrape failed:`, err);
    res.status(500).json({
      ok: false,
      runId,
      error: String(err && err.message ? err.message : err),
      elapsedMs: msSince(t0),
    });
  } finally {
    console.log(`[${runId}] FINISHLINE handler end time=${msSince(t0)}ms`);
  }
};
