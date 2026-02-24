// /api/puma.js  (CommonJS)
// Cheerio scraper for PUMA sale running shoes, writes blob to /puma.json
//
// Env vars you likely want:
// - BLOB_READ_WRITE_TOKEN           (required to write to Vercel Blob)
// - PUMA_BLOB_PATH                 (optional; default: "puma.json")
// - PUMA_SOURCE_URL                (optional; default is the URL you gave)
//
// Merge env var (in your merge-deals.js) would point to the blob URL produced:
// - PUMA_DEALS_BLOB_URL = https://...public.blob.vercel-storage.com/puma.json

const cheerio = require("cheerio");

let put; // lazy-load @vercel/blob only when needed

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(s) {
  // good-enough decoding for common entities we see in product names
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function parseMoney(text) {
  // "$48.99" -> 48.99
  const t = String(text || "").replace(/[^\d.]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function computeDiscountPercent(sale, original) {
  if (!Number.isFinite(sale) || !Number.isFinite(original) || original <= 0) return null;
  if (sale >= original) return null;
  return Math.round(((original - sale) / original) * 100);
}

function inferGenderAndType(h3Text) {
  const t = normalizeWhitespace(h3Text).toLowerCase();

  let gender = "unknown";
  if (t.includes("men's") || t.includes("mens")) gender = "mens";
  else if (t.includes("women's") || t.includes("womens")) gender = "womens";

  let shoeType = "unknown";
  // Your rule: if AFTER gender it states road running => road; trail running => trail; else unknown.
  // We’ll simply search the whole string for these phrases.
  if (t.includes("road running")) shoeType = "road";
  else if (t.includes("trail running")) shoeType = "trail";

  return { gender, shoeType };
}

function absolutizeUrl(href) {
  const h = String(href || "").trim();
  if (!h) return null;
  if (h.startsWith("http://") || h.startsWith("https://")) return h;
  if (h.startsWith("/")) return `https://us.puma.com${h}`;
  return `https://us.puma.com/${h}`;
}

async function fetchHtml(url) {
  // Basic “looks like a browser” headers (helps with some ecomm stacks)
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`PUMA fetch failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }

  return await res.text();
}

function extractDealsFromHtml(html, sourceUrl) {
  const $ = cheerio.load(html);
  const tiles = $('li[data-test-id="product-list-item"]');

  // If for any reason the attribute-based tiles aren't present in the server HTML,
  // you can still sometimes find product cards via headings/links — but we’ll
  // keep that fallback minimal and safe.
  const found = tiles.length;

  const deals = [];
  for (const el of tiles.toArray()) {
    const $el = $(el);

    // URL
    const href =
      $el.find('a[data-test-id="product-list-item-link"]').attr("href") ||
      $el.find("a[href*='/us/en/pd/']").first().attr("href") ||
      null;
    const listingURL = absolutizeUrl(href);

    // Image
    const img =
      $el.find("img").first().attr("src") ||
      $el.find("img").first().attr("data-src") ||
      null;
    const imageURL = img ? String(img).trim() : null;

    // Model
    const modelRaw = $el.find("h2").first().text();
    const model = decodeHtmlEntities(normalizeWhitespace(modelRaw));

    // Category line (gender/type lives here)
    const h3Raw = $el.find("h3").first().text();
    const h3Text = decodeHtmlEntities(normalizeWhitespace(h3Raw));
    const { gender, shoeType } = inferGenderAndType(h3Text);

    // Prices
    const saleText = $el.find('[data-test-id="sale-price"]').first().text();
    const origText = $el.find('[data-test-id="price"]').first().text();
    const salePrice = parseMoney(saleText);
    const originalPrice = parseMoney(origText);

    // Only accept “real deals” with both prices
    if (!listingURL || !imageURL || !model) continue;
    if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice) || salePrice <= 0 || originalPrice <= 0) continue;
    if (salePrice >= originalPrice) continue;

    const brand = "Puma";
    const store = "PUMA";

    // listingName: keep it simple + close to what PUMA presents
    // (your merge step can parse brand/model from it if needed)
    const listingName = normalizeWhitespace(`${brand} ${model} ${h3Text}`.trim());

    deals.push({
      schemaVersion: 1,

      listingName,

      brand,
      model,

      salePrice,
      originalPrice,
      discountPercent: computeDiscountPercent(salePrice, originalPrice),

      // Range fields: not provided on tiles (single prices here)
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,

      store,

      listingURL,
      imageURL,

      gender,
      shoeType,
    });
  }

  return { dealsFound: found, deals };
}

async function writeBlobJson(blobPath, jsonObj) {
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
  if (!token) return { blobUrl: null, wrote: false, warning: "Missing BLOB_READ_WRITE_TOKEN; skipping blob write." };

  if (!put) {
    // lazy import so the route still works without blob writing during local tests
    ({ put } = require("@vercel/blob"));
  }

  const body = JSON.stringify(jsonObj, null, 2);
  const blob = await put(blobPath, body, {
    access: "public",
    contentType: "application/json",
    token,
  });

  return { blobUrl: blob?.url || null, wrote: true, warning: null };
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();

  // allow override for testing
  const url =
    String(req.query?.url || "").trim() ||
    String(process.env.PUMA_SOURCE_URL || "").trim() ||
    "https://us.puma.com/us/en/sale/all-sale?filter_product_division=%3E{shoes}&filter_sport_type=%3E{running}&offset=264";

  const blobPath = String(process.env.PUMA_BLOB_PATH || "puma.json").trim();

  const meta = {
    store: "PUMA",
    schemaVersion: 1,
    lastUpdated: nowIso(),
    via: "cheerio",
    sourceUrls: [url],
    pagesFetched: 1,
    dealsFound: 0,
    dealsExtracted: 0,
    scrapeDurationMs: 0,
    ok: false,
    error: null,
  };

  try {
    const html = await fetchHtml(url);

    const { dealsFound, deals } = extractDealsFromHtml(html, url);

    meta.dealsFound = dealsFound;
    meta.dealsExtracted = deals.length;
    meta.scrapeDurationMs = Date.now() - t0;
    meta.ok = true;

    const out = { ...meta, deals };

    const blobWrite = await writeBlobJson(blobPath, out);
    if (blobWrite.blobUrl) out.blobUrl = blobWrite.blobUrl;
    if (blobWrite.warning) out.blobWriteWarning = blobWrite.warning;

    res.setHeader("content-type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify(out, null, 2));
  } catch (err) {
    meta.scrapeDurationMs = Date.now() - t0;
    meta.ok = false;
    meta.error = String(err?.message || err);

    res.setHeader("content-type", "application/json; charset=utf-8");
    res.status(500).send(JSON.stringify(meta, null, 2));
  }
};
