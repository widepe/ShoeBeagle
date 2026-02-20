// /api/scrapers/finishline-firecrawl.js  (CommonJS)
// Hit this route manually to test: /api/scrapers/finishline-firecrawl
//
// Purpose:
// - Fetch Finish Line running sale PLP pages via Firecrawl
// - Extract canonical deals
// - Upload to Vercel Blob as finishline.json (stable)
// - Pagination fix: STOP when page repeats (Finish Line often serves page 1 again)
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

const STORE = "Finish Line";
const SCHEMA_VERSION = 1;
const VIA = "firecrawl";

const BLOB_PATHNAME = "finishline.json"; // ✅ stable blob name -> .../finishline.json

// Canonical running-sale base (page param pattern: ?page=2, ?page=3, ...)
// NOTE: You already confirmed this is your base.
const BASE_URL = "https://www.finishline.com/plp/all-sale/activity%3Drunning";

// How many pages max to attempt before repeat/empty stops us
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

function shortText(s, n = 220) {
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

// Allowed ONLY: "womens", "mens", "unisex" — anything else returns null (exclude deal).
function normalizeGenderFromListingName(listingName) {
  const s = String(listingName || "").trim().toLowerCase();

  // Finish Line tiles often start with:
  // "Men's ...", "Women's ...", "Unisex ..."
  if (s.startsWith("women's") || s.startsWith("womens")) return "womens";
  if (s.startsWith("men's") || s.startsWith("mens")) return "mens";
  if (s.startsWith("unisex")) return "unisex";

  // Explicitly exclude kids/grade school etc (your example: "Big Kids' ...")
  // If it doesn't match allowed set, return null anyway.
  return null;
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

// Simple brand/model heuristic:
// - Remove leading gender label
// - Brand is first token (with a few multiword brands handled)
// - Model is rest
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
        // (Optional) If your plan supports it and you want it:
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

  // Stable selector from your outerHTML
  const $cards = $('div[data-testid="product-item"]');
  const cardsFound = $cards.length;

  console.log(`[${runId}] FINISHLINE parse: cardsFound=${cardsFound} url=${pageUrl}`);

  // Pagination fingerprint: if page repeats, first item tends to match exactly
  const firstHref = $cards.first().find('a[href*="/pdp/"]').first().attr("href") || "";
  const firstTitle = $cards.first().find("h4").first().text().replace(/\s+/g, " ").trim() || "";
  const fingerprint = `${cardsFound}|${firstHref}|${firstTitle}`.slice(0, 600);

  const deals = [];
  let priceInBagSkipped = 0;

  $cards.each((_, el) => {
    const $card = $(el);

    const listingName = $card.find("h4").first().text().replace(/\s+/g, " ").trim();
    if (!listingName) return;

    // Gender must be womens/mens/unisex else EXCLUDE
    const gender = normalizeGenderFromListingName(listingName);
    if (!gender) return;

    const shoeType = detectShoeType(listingName);

    const href = $card.find('a[href*="/pdp/"]').first().attr("href") || null;
    const listingURL = absFinishlineUrl(href);
    if (!listingURL) return;

    const imgSrc = $card.find("img").first().attr("src") || null;
    const imageURL = absFinishlineUrl(imgSrc); // handles https already; fine
    if (!imageURL) return;

    // Prices:
    // - sale node: h4.text-default-onSale
    // - original: p.line-through
    //
    // Price-in-bag cards have:
    //   <h4 class="... text-default-onSale">See price in bag</h4>
    // So: if sale node exists AND isn't a $ price -> skip + count
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

    // Require BOTH
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

      // range fields unused here
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

  if (deals.length) {
    const s = deals[0];
    console.log(`[${runId}] FINISHLINE sample:`, {
      listingName: shortText(s.listingName, 80),
      salePrice: s.salePrice,
      originalPrice: s.originalPrice,
      listingURL: s.listingURL ? s.listingURL.slice(0, 80) : null,
    });
  }

  return { deals, cardsFound, fingerprint, firstHref, firstTitle, priceInBagSkipped };
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

  // Pagination stall protection:
  // - break if no cards
  // - break if fingerprint repeats (same content page served again)
  const seenFingerprints = new Set();

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const pageUrl = buildPageUrl(BASE_URL, pageNum);
    sourceUrls.push(pageUrl);

    console.log(`[${runId}] FINISHLINE page start: page=${pageNum} url=${pageUrl}`);

    const html = await fetchHtmlViaFirecrawl(pageUrl, runId);
    pagesFetched += 1;

    const { deals, cardsFound, fingerprint, firstHref, firstTitle, priceInBagSkipped } =
      extractDealsFromHtml(html, runId, pageUrl);

    // If no products, stop (past end)
    if (cardsFound === 0) {
      console.log(`[${runId}] FINISHLINE stop: cardsFound=0 page=${pageNum}`);
      break;
    }

    // If fingerprint repeats, stop (pagination not advancing; repeats page 1 behavior)
    if (seenFingerprints.has(fingerprint)) {
      console.log(`[${runId}] FINISHLINE stop: pagination stalled (repeat fingerprint) page=${pageNum}`);
      console.log(`[${runId}] FINISHLINE repeat details:`, {
        pageNum,
        cardsFound,
        firstHref: (firstHref || "").slice(0, 90),
        firstTitle: shortText(firstTitle, 90),
      });
      break;
    }
    seenFingerprints.add(fingerprint);

    dealsFound += cardsFound;
    priceInBagSkippedTotal += priceInBagSkipped;

    allDeals.push(...deals);

    console.log(
      `[${runId}] FINISHLINE page done: page=${pageNum} cardsFound=${cardsFound} extracted=${deals.length} priceInBagSkipped=${priceInBagSkipped}`
    );

    // Hard cap just in case
    if (allDeals.length >= MAX_ITEMS_TOTAL) {
      console.log(`[${runId}] FINISHLINE stop: MAX_ITEMS_TOTAL reached (${MAX_ITEMS_TOTAL})`);
      break;
    }
  }

  const deduped = uniqByKey(allDeals, (d) => d.listingURL || d.listingName).slice(0, MAX_ITEMS_TOTAL);
  const scrapeDurationMs = msSince(startedAt);

  console.log(
    `[${runId}] FINISHLINE scrapeAll: totalBeforeDedupe=${allDeals.length} totalAfterDedupe=${deduped.length} pagesFetched=${pagesFetched} durationMs=${scrapeDurationMs}`
  );

  return {
    store: STORE,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated: nowIso(),
    via: VIA,

    sourceUrls,
    pagesFetched,

    dealsFound, // total cards found across fetched pages (not just extracted)
    dealsExtracted: deduped.length,

    scrapeDurationMs,

    ok: true,
    error: null,

    // helpful counter you asked for
    priceInBagSkipped: priceInBagSkippedTotal,

    deals: deduped,
  };
}

// -----------------------------
// HANDLER
// -----------------------------
module.exports = async function handler(req, res) {
  const runId = `finishline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const t0 = Date.now();

  // ✅ REQUIRE CRON SECRET (same pattern as your HOKA scraper)
 /* const CRON_SECRET = String(process.env.CRON_SECRET || "").trim();
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
    console.log(
      `[${runId}] FINISHLINE expected public url endswith: /${BLOB_PATHNAME} (yours: .../finishline.json)`
    );

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
