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

        // Give Nike time to render initial products
        waitFor: 1500,

        // Scroll to trigger infinite loading
        actions: [
          { type: "scroll", direction: "down" },
          { type: "wait", milliseconds: 1200 },

          { type: "scroll", direction: "down" },
          { type: "wait", milliseconds: 1200 },

          { type: "scroll", direction: "down" },
          { type: "wait", milliseconds: 1200 },

          { type: "scroll", direction: "down" },
          { type: "wait", milliseconds: 1200 },

          { type: "scroll", direction: "down" },
          { type: "wait", milliseconds: 1200 }
        ],

        timeout: 120000
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

  const cards = $('[data-testid="product-card"]');
  const deals = [];

  let totalTiles = 0;
  let droppedSeePriceInBag = 0;

  cards.each((_, el) => {
    totalTiles++;

    const $card = $(el);

    // Detect “See Price In Bag” anywhere in the card text (Nike sometimes shows it instead of a price)
    const cardText = cleanText($card.text());
    const hasSeePriceInBag = /see price in bag/i.test(cardText);
    if (hasSeePriceInBag) {
      droppedSeePriceInBag++;
      return;
    }

    const title = cleanText($card.find(".product-card__title").first().text());
    const subtitle = cleanText($card.find(".product-card__subtitle").first().text());

    // Listing URL
    let href =
      $card.find('a[data-testid="product-card__link-overlay"]').attr("href") ||
      $card.find('a[data-testid="product-card__img-link-overlay"]').attr("href") ||
      "";
    href = cleanText(href);

    const listingURL = href
      ? href.startsWith("http")
        ? href
        : `${baseUrl}${href.startsWith("/") ? "" : "/"}${href}`
      : null;

    // Image URL
    const imageURL = cleanText($card.find('img.product-card__hero-image').attr("src") || "") || null;

    // Prices (current + original)
    const saleText = cleanText(
      $card.find('[data-testid="product-price-reduced"]').first().text()
    );
    const origText = cleanText(
      $card.find('[data-testid="product-price"]').first().text()
    );

    const salePrice = toNumPrice(saleText);
    const originalPrice = toNumPrice(origText);

    // If either is missing, skip (your merge rules require both)
    if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice)) {
      // Not requested to count these drops, so we just skip silently
      return;
    }

    const discountPercent = computeDiscountPercent(salePrice, originalPrice);

    const fullTitleForInference = `${title} ${subtitle}`.trim();
    const gender = inferGenderFromTitleText(fullTitleForInference);
    const shoeType = inferShoeTypeFromTitleText(fullTitleForInference);

    const listingName = title || cleanText($card.find("a").first().text()) || "Nike Shoe";

    // Nike brand/model (brand fixed)
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

      // Range fields: not provided by Nike cards here; keep null
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
      totalTiles,
      droppedSeePriceInBag,
    },
  };
}

// -----------------------------
// HANDLER
// -----------------------------
module.exports = async function handler(req, res) {
  const t0 = Date.now();

  // ✅ CRON protection (COMMENTED OUT FOR TESTING)
  // const cronSecret = String(process.env.CRON_SECRET || "").trim();
  // if (cronSecret) {
  //   const got = String(req.headers["x-cron-secret"] || "").trim();
  //   if (got !== cronSecret) return res.status(401).json({ ok: false, error: "Unauthorized" });
  // }

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

      // ✅ you requested this metadata
      dropCounts: {
        totalTiles: parsed.totals.totalTiles,
        dropped_seePriceInBag: parsed.totals.droppedSeePriceInBag,
      },

      deals: parsed.deals,
    };

    const blobToken = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
    if (!blobToken) throw new Error("BLOB_READ_WRITE_TOKEN env var is not set");

    // Writes to ".../nike.json" (root path name "nike.json")
    const blob = await put("nike.json", JSON.stringify(body, null, 2), {
      access: "public",
      contentType: "application/json",
      token: blobToken,
      addRandomSuffix: false, // IMPORTANT: stable path
    });

    return res.status(200).json({
      ...body,
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
