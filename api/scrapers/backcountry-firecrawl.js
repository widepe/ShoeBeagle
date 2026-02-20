// /api/scrapers/backcountry.js
//
// Backcountry running-shoes sale scraper (Firecrawl -> HTML -> Cheerio parse)
// Saves to Blob as: backcountry.json
//
// Rules (per your spec):
// - Include ONLY cards that show an original price (strikethrough / "Original price:" present).
//   If no original price -> exclude.
// - Some cards have multiple current prices (ranges). Support range fields.
// - shoeType:
//    * default "road"
//    * if listing/title contains "trail" -> "trail"
//    * if contains "track" OR "spike" OR "spikes" -> "track"
// - gender is inferred from listing/title ("Men", "Men's", "Women's", etc).
//
// Output deal schema:
// listingName, brand, model,
// salePrice, originalPrice, discountPercent,
// salePriceLow, salePriceHigh, originalPriceLow, originalPriceHigh, discountPercentUpTo,
// store, listingURL, imageURL, gender, shoeType
//
// Top-level structure matches your standard.

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "Backcountry";
const OUT_BLOB_NAME = "backcountry.json";

// Your target URL (provided)
const START_URL =
  'https://www.backcountry.com/rc/footwear-on-sale?p=u_categoryPathId:%22bc-running-shoes%22';

// --------------------------
// helpers
// --------------------------
function nowIso() {
  return new Date().toISOString();
}

function toNumber(x) {
  if (x == null) return null;
  const n =
    typeof x === "string"
      ? parseFloat(String(x).replace(/[^0-9.]/g, ""))
      : Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function absolutizeUrl(href) {
  const h = String(href || "").trim();
  if (!h) return "";
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("//")) return "https:" + h;
  if (h.startsWith("/")) return "https://www.backcountry.com" + h;
  return "https://www.backcountry.com/" + h.replace(/^\/+/, "");
}

function absolutizeImg(src) {
  const s = String(src || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("/")) return "https://www.backcountry.com" + s;
  return "https://www.backcountry.com/" + s.replace(/^\/+/, "");
}

function inferGenderFromTitle(title) {
  const t = String(title || "").toLowerCase();
  if (/\bmen'?s\b|\bmens\b|\bmen\b/.test(t)) return "mens";
  if (/\bwomen'?s\b|\bwomens\b|\bwomen\b/.test(t)) return "womens";
  if (/\bunisex\b/.test(t)) return "unisex";
  return "unknown";
}

function inferShoeTypeFromTitle(title) {
  const t = String(title || "").toLowerCase();
  if (/\btrail\b/.test(t)) return "trail";
  if (/\btrack\b|\bspike\b|\bspikes\b/.test(t)) return "track";
  return "road";
}

// Remove trailing gender suffixes from model (but keep listingName intact)
function modelFromTitle(title) {
  let t = normalizeWhitespace(title);
  t = t.replace(/\s*-\s*men'?s\b/i, "").replace(/\s*-\s*women'?s\b/i, "");
  t = t.replace(/\bmen'?s\b/i, "").replace(/\bwomen'?s\b/i, "");
  t = normalizeWhitespace(t);
  return t;
}

/**
 * Extract current/original prices.
 * Backcountry card snippet includes:
 *  "Current price: $99.00 Original price: $165.00"
 *
 * Some cards may have:
 *  "Current price: $89.00 - $129.00 Original price: $165.00"
 * or multiple occurrences (we take min/max).
 */
function extractPriceShapeFromPriceText(priceText) {
  const text = normalizeWhitespace(priceText);

  // Require original price to be present (your exclude rule)
  const origMatches = [...text.matchAll(/Original price:\s*\$([\d.,]+)(?:\s*-\s*\$([\d.,]+))?/gi)];
  if (!origMatches.length) return null;

  const curMatches = [...text.matchAll(/Current price:\s*\$([\d.,]+)(?:\s*-\s*\$([\d.,]+))?/gi)];
  if (!curMatches.length) return null;

  // Collect possible ranges across matches
  const curVals = [];
  for (const m of curMatches) {
    const a = toNumber(m[1]);
    const b = toNumber(m[2]);
    if (a != null) curVals.push(a);
    if (b != null) curVals.push(b);
  }

  const origVals = [];
  for (const m of origMatches) {
    const a = toNumber(m[1]);
    const b = toNumber(m[2]);
    if (a != null) origVals.push(a);
    if (b != null) origVals.push(b);
  }

  if (!curVals.length || !origVals.length) return null;

  const saleLow = Math.min(...curVals);
  const saleHigh = Math.max(...curVals);
  const origLow = Math.min(...origVals);
  const origHigh = Math.max(...origVals);

  // sanitize
  if (!(saleLow > 0 && origHigh > 0)) return null;
  if (saleLow >= origHigh) return null;

  const saleIsRange = saleLow !== saleHigh;
  const origIsRange = origLow !== origHigh;
  const anyRange = saleIsRange || origIsRange;

  // Legacy anchors (kept)
  const salePrice = saleLow;
  const originalPrice = origLow;

  let discountPercent = null;
  let discountPercentUpTo = null;

  if (!anyRange) {
    const pct = ((originalPrice - salePrice) / originalPrice) * 100;
    if (Number.isFinite(pct) && pct > 0) discountPercent = Math.round(Math.min(pct, 95));
  } else {
    const pctUpTo = ((origHigh - saleLow) / origHigh) * 100;
    if (Number.isFinite(pctUpTo) && pctUpTo > 0) discountPercentUpTo = Math.round(Math.min(pctUpTo, 95));
  }

  return {
    salePrice,
    originalPrice,
    salePriceLow: saleLow,
    salePriceHigh: saleIsRange ? saleHigh : null,
    originalPriceLow: origLow,
    originalPriceHigh: origIsRange ? origHigh : null,
    discountPercent,
    discountPercentUpTo,
  };
}

function parseDealsFromHtml(html) {
  const $ = cheerio.load(html);

  // Card root (from your outerHTML): <div data-id="PLI" class="chakra-linkbox ...">
  const cards = $('div[data-id="PLI"]');

  const dealsFound = cards.length;
  const deals = [];

  cards.each((_, el) => {
    const $card = $(el);

    const brand = normalizeWhitespace($card.find('[data-id="brandName"]').first().text()) || "Unknown";
    const title = normalizeWhitespace($card.find('[data-id="title"]').first().text());
    if (!title) return;

    // href is in the overlay link
    const href = $card.find("a.chakra-linkbox__overlay").first().attr("href") || "";
    const listingURL = absolutizeUrl(href);
    if (!listingURL) return;

    // Image
    const imgSrc =
      $card.find('img[data-id="image"]').first().attr("src") ||
      $card.find("img").first().attr("src") ||
      "";
    const imageURL = absolutizeImg(imgSrc);

    // Price text (contains current+original in one node in your example)
    const priceText = $card.find('[data-id="price"]').first().text();
    const priceShape = extractPriceShapeFromPriceText(priceText);

    // EXCLUDE: no original price / no strikethrough equivalent
    if (!priceShape) return;

    const listingName = title; // keep as-is
    const model = modelFromTitle(title);

    const gender = inferGenderFromTitle(title);
    const shoeType = inferShoeTypeFromTitle(title);

    deals.push({
      schemaVersion: 1,

      listingName,

      brand,
      model,

      salePrice: priceShape.salePrice,
      originalPrice: priceShape.originalPrice,
      discountPercent: priceShape.discountPercent,

      salePriceLow: priceShape.salePriceLow,
      salePriceHigh: priceShape.salePriceHigh,
      originalPriceLow: priceShape.originalPriceLow,
      originalPriceHigh: priceShape.originalPriceHigh,
      discountPercentUpTo: priceShape.discountPercentUpTo,

      store: STORE,

      listingURL,
      imageURL,

      gender,
      shoeType,
    });
  });

  return { dealsFound, dealsExtracted: deals.length, deals };
}

// --------------------------
// Firecrawl (REST)
// --------------------------
async function firecrawlScrapeHtml(url) {
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY env var");

  // Firecrawl scrape endpoint (HTML format)
  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      // Most Firecrawl accounts support formats like: ["html"] / ["markdown","html"]
      formats: ["html"],
      // Best-effort; ignore if not supported by your plan
      waitFor: 1500,
      timeout: 60000,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Firecrawl scrape failed (${resp.status}): ${text || resp.statusText}`);
  }

  const json = await resp.json();
  const html = json?.data?.html || json?.html || null;
  if (!html) throw new Error("Firecrawl response missing HTML (expected data.html)");
  return html;
}

// --------------------------
// handler
// --------------------------
module.exports = async function handler(req, res) {
  const runId = `backcountry-${Date.now().toString(36)}`;
  const t0 = Date.now();

  // REQUIRE CRON SECRET
  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) {
    return res.status(500).json({
      ok: false,
      error: "CRON_SECRET not configured"
    });
  }

  const provided =
    req.headers["x-cron-secret"] ||
    req.query?.key ||
    "";

  if (provided !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const payload = await scrapeAll(runId);

    const blobRes = await put("backcountry.json", JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    res.status(200).json({
      ok: true,
      runId,
      dealsExtracted: payload.dealsExtracted,
      blobUrl: blobRes.url,
      elapsedMs: Date.now() - t0,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
};


    const payload = {
      store: STORE,
      schemaVersion: 1,

      lastUpdated,
      via: "firecrawl",

      sourceUrls,
      pagesFetched,

      dealsFound: 0,
      dealsExtracted: 0,

      scrapeDurationMs: Date.now() - start,

      ok,
      error,

      deals: [],
    };

    // Still write a blob so dashboards can see failure metadata
    try {
      const blob = await put(OUT_BLOB_NAME, JSON.stringify(payload, null, 2), {
        access: "public",
        addRandomSuffix: false,
      });
      return res.status(200).json({
        ok: false,
        store: STORE,
        savedAs: OUT_BLOB_NAME,
        blobUrl: blob.url,
        error,
        lastUpdated,
      });
    } catch (writeErr) {
      return res.status(500).json({
        ok: false,
        store: STORE,
        error: `${error} | plus failed to write blob: ${writeErr?.message || String(writeErr)}`,
        lastUpdated,
      });
    }
  }
};
