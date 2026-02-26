// /api/scrapers/nike.js  (CommonJS)
// Firecrawl + Cheerio scraper for Nike sale running shoes (1 page for now)
// Writes blob: .../nike.json

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

// -----------------------------
// CONFIG
// -----------------------------
const STORE = "Nike";
const SCHEMA_VERSION = 1;

const SOURCE_URL =
  "https://www.nike.com/w/sale-running-shoes-37v7jz3rauvz3yaepz5e1x6znik1zy7ok";

function nowIso() {
  return new Date().toISOString();
}

function toNumPrice(s) {
  const n = String(s || "")
    .replace(/[^\d.]/g, "")
    .trim();
  if (!n) return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function computeDiscountPercent(sale, original) {
  if (!Number.isFinite(sale) || !Number.isFinite(original) || original <= 0) return null;
  const pct = Math.round(((original - sale) / original) * 100);
  return Number.isFinite(pct) ? pct : null;
}

function inferGenderFromTitleText(t) {
  const s = String(t || "").toLowerCase();
  if (s.includes("women's") || s.includes("womens")) return "womens";
  if (s.includes("men's") || s.includes("mens")) return "mens";
  if (s.includes("unisex")) return "unisex";
  return "unknown";
}

function inferShoeTypeFromTitleText(t) {
  const s = String(t || "").toLowerCase();
  if (s.includes("road")) return "road";
  if (s.includes("trail")) return "trail";
  if (s.includes("track")) return "track";
  return "unknown";
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// -----------------------------
// FIRECRAWL FETCH (HTML)
// -----------------------------
async function fetchHtmlViaFirecrawl(url) {
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY env var is not set");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const resp = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        url,
        formats: ["html"],
        onlyMainContent: false,

        // ✅ IMPORTANT: avoid cached snapshots
        maxAge: 0,

        // give first render time
        waitFor: 2000,

        // scroll + wait for product cards to load
        actions: [
          { type: "wait", selector: '[data-testid="product-card"]' },

          { type: "scroll", direction: "down" },
          { type: "wait", milliseconds: 1200 },

          { type: "scroll", direction: "down" },
          { type: "wait", milliseconds: 1200 },

          { type: "scroll", direction: "down" },
          { type: "wait", milliseconds: 1200 },

          { type: "scroll", direction: "down" },
          { type: "wait", milliseconds: 1200 },

          { type: "scroll", direction: "down" },
          { type: "wait", milliseconds: 1200 },
        ],

        timeout: 120000,
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Firecrawl failed: ${resp.status} — ${txt || resp.statusText}`);
    }

    const json = await resp.json();
    const html = json?.data?.html || "";
    if (!html) throw new Error("Firecrawl returned empty HTML");

    return html;
  } finally {
    clearTimeout(timeout);
  }
}

// -----------------------------
// PARSE
// -----------------------------
function parseNikeCardsFromHtml(html, baseUrl = "https://www.nike.com") {
  const $ = cheerio.load(html);

  // Nike cards contain a very reliable unique link overlay
  const linkEls = $('a[data-testid="product-card__link-overlay"]');

  const deals = [];
  const seen = new Set();

  let domLinkCount = 0;
  let droppedDuplicates = 0;
  let droppedSeePriceInBag = 0;
  let droppedMissingPrice = 0;

  // Optional debug: track max position if present on a parent wrapper
  let maxPosition = 0;

  linkEls.each((_, a) => {
    domLinkCount++;

    const $a = $(a);
    let href = cleanText($a.attr("href") || "");
    if (!href) return;

    const listingURL = href.startsWith("http")
      ? href
      : `${baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;

    // ✅ hard de-dupe by listingURL BEFORE touching anything else
    if (seen.has(listingURL)) {
      droppedDuplicates++;
      return;
    }
    seen.add(listingURL);

    // Walk up to the closest "card-ish" root.
    // In your snippet, <figure> is the natural card root.
    const $root = $a.closest("figure").length ? $a.closest("figure") : $a.closest('[data-testid="product-card"]');

    // Track product position if it exists on some wrapper (won’t break if missing)
    const pos = Number($root.attr("data-product-position") || 0);
    if (Number.isFinite(pos) && pos > maxPosition) maxPosition = pos;

    // Detect “See Price In Bag” at the card level
    const cardText = cleanText($root.text());
    if (/see price in bag/i.test(cardText)) {
      droppedSeePriceInBag++;
      return;
    }

    const title = cleanText($root.find(".product-card__title").first().text());
    const subtitle = cleanText($root.find(".product-card__subtitle").first().text());

    // Image URL (try hero image first)
    const imageURL =
      cleanText($root.find("img.product-card__hero-image").attr("src") || "") ||
      cleanText($root.find("img").first().attr("src") || "") ||
      null;

    // Prices
    const saleText = cleanText($root.find('[data-testid="product-price-reduced"]').first().text());
    const origText = cleanText($root.find('[data-testid="product-price"]').first().text());

    const salePrice = toNumPrice(saleText);
    const originalPrice = toNumPrice(origText);

    if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice)) {
      droppedMissingPrice++;
      return;
    }

    const discountPercent = computeDiscountPercent(salePrice, originalPrice);

    const fullTitleForInference = `${title} ${subtitle}`.trim();
    const gender = inferGenderFromTitleText(fullTitleForInference);
    const shoeType = inferShoeTypeFromTitleText(fullTitleForInference);

    const listingName = title || cleanText($a.text()) || "Nike Shoe";
    const brand = "Nike";
    const model = title || listingName;

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

  return {
    deals,
    totals: {
      // "domLinkCount" is what was in the DOM snapshot
      domTiles: domLinkCount,

      // "totalTiles" should be UNIQUE cards, not maxPosition/dom count
      totalTiles: seen.size,

      maxPosition,

      droppedSeePriceInBag,
      droppedDuplicates,
      droppedMissingPrice,
    },
  };
}
// -----------------------------
// HANDLER
// -----------------------------
module.exports = async function handler(req, res) {
  const t0 = Date.now();

  // ✅ CRON protection 
const secret = process.env.CRON_SECRET;
if (secret && req.headers["authorization"] !== `Bearer ${secret}`) {
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

  try {
    const html = await fetchHtmlViaFirecrawl(SOURCE_URL);
    const parsed = parseNikeCardsFromHtml(html, "https://www.nike.com");

    const body = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: "firecrawl",

      sourceUrls: [SOURCE_URL],
      pagesFetched: 1,

      dealsFound: parsed.totals.totalTiles,
      dealsExtracted: parsed.deals.length,

      scrapeDurationMs: Date.now() - t0,

      ok: true,
      error: null,

dropCounts: {
  totalTiles: parsed.totals.totalTiles,
  domTiles: parsed.totals.domTiles,
  dropped_duplicates: parsed.totals.droppedDuplicates,
  dropped_seePriceInBag: parsed.totals.droppedSeePriceInBag,
  dropped_missingPrice: parsed.totals.droppedMissingPrice,
},

      deals: parsed.deals,
    };

    const blobToken = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
    if (!blobToken) throw new Error("BLOB_READ_WRITE_TOKEN env var is not set");

    const blob = await put("nike.json", JSON.stringify(body, null, 2), {
      access: "public",
      contentType: "application/json",
      token: blobToken,
      addRandomSuffix: false,
    });

    // ✅ Return META ONLY (no deals array)
    // eslint-disable-next-line no-unused-vars
    const { deals, ...metaOnly } = body;

    return res.status(200).json({
      ...metaOnly,
      blobUrl: blob?.url || null,
    });
  } catch (err) {
    return res.status(500).json({
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: "firecrawl",
      sourceUrls: [SOURCE_URL],
      pagesFetched: 0,
      dealsFound: 0,
      dealsExtracted: 0,
      scrapeDurationMs: Date.now() - t0,
      ok: false,
      error: err?.message || String(err),
    });
  }
};
