// /api/scrape-puma.js  (CommonJS)
// PUMA sale running shoes scraper (Cheerio) + offset pagination + dropCounts + mandatory blob write

const cheerio = require("cheerio");
let put; // lazy-load @vercel/blob

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(s) {
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

function extractDealsFromHtml(html, dropCounts) {
  const $ = cheerio.load(html);
  const tiles = $('li[data-test-id="product-list-item"]');
  dropCounts.totalTiles += tiles.length;

  // helpful debug: snapshot first tile structure
  if (!dropCounts.__debug_firstTile && tiles.length) {
    const $t = $(tiles.first());
    dropCounts.__debug_firstTile = {
      tileExists: true,
      firstModel: decodeHtmlEntities(normalizeWhitespace($t.find("h2").first().text())),
      firstH3: decodeHtmlEntities(normalizeWhitespace($t.find("h3").first().text())),
      firstHref:
        $t.find('a[data-test-id="product-list-item-link"]').attr("href") ||
        $t.find("a[href*='/us/en/pd/']").first().attr("href") ||
        null,
      firstImg: $t.find("img").first().attr("src") || null,
      firstSale: normalizeWhitespace($t.find('[data-test-id="sale-price"]').first().text()),
      firstOrig: normalizeWhitespace($t.find('[data-test-id="price"]').first().text()),
    };
  }

  const deals = [];

  for (const el of tiles.toArray()) {
    const $el = $(el);

    const href =
      $el.find('a[data-test-id="product-list-item-link"]').attr("href") ||
      $el.find("a[href*='/us/en/pd/']").first().attr("href") ||
      null;
    const listingURL = absolutizeUrl(href);
    if (!listingURL) {
      dropCounts.dropped_missingUrl++;
      continue;
    }

    const img = $el.find("img").first().attr("src") || $el.find("img").first().attr("data-src") || null;
    const imageURL = img ? String(img).trim() : null;
    if (!imageURL) {
      dropCounts.dropped_missingImage++;
      continue;
    }

    const modelRaw = $el.find("h2").first().text();
    const model = decodeHtmlEntities(normalizeWhitespace(modelRaw));
    if (!model) {
      dropCounts.dropped_missingModel++;
      continue;
    }

    const h3Raw = $el.find("h3").first().text();
    const h3Text = decodeHtmlEntities(normalizeWhitespace(h3Raw));
    const { gender, shoeType } = inferGenderAndType(h3Text);

    const saleText = $el.find('[data-test-id="sale-price"]').first().text();
    const origText = $el.find('[data-test-id="price"]').first().text();
    const salePrice = parseMoney(saleText);
    const originalPrice = parseMoney(origText);

    if (!Number.isFinite(salePrice) || salePrice <= 0) {
      dropCounts.dropped_saleMissingOrZero++;
      continue;
    }
    if (!Number.isFinite(originalPrice) || originalPrice <= 0) {
      dropCounts.dropped_originalMissingOrZero++;
      continue;
    }
    if (salePrice >= originalPrice) {
      dropCounts.dropped_notADeal++;
      continue;
    }

    const brand = "Puma";
    const store = "PUMA";

    const listingName = normalizeWhitespace(`${brand} ${model} ${h3Text}`.trim());

    deals.push({
      schemaVersion: 1,

      listingName,

      brand,
      model,

      salePrice,
      originalPrice,
      discountPercent: computeDiscountPercent(salePrice, originalPrice),

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

    dropCounts.kept++;
  }

  return { dealsFoundThisPage: tiles.length, deals };
}

async function writeBlobJsonOrThrow(blobPath, jsonObj) {
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
  if (!token) throw new Error("Missing BLOB_READ_WRITE_TOKEN (blob write is required).");

  if (!put) ({ put } = require("@vercel/blob"));

  const body = JSON.stringify(jsonObj, null, 2);

  // If this fails, we WANT to throw so you see it immediately
  const blob = await put(blobPath, body, {
    access: "public",
    contentType: "application/json",
    token,
  });

  if (!blob?.url) throw new Error("Blob write returned no url.");
  return blob.url;
}

function buildPagedUrl(baseUrl, offset) {
  const u = new URL(baseUrl);
  u.searchParams.set("offset", String(offset));
  return u.toString();
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();

  // Base URL should NOT hardcode offset; we’ll paginate it.
  const baseUrl =
    String(req.query?.url || "").trim() ||
    String(process.env.PUMA_SOURCE_URL || "").trim() ||
    "https://us.puma.com/us/en/sale/all-sale?filter_product_division=%3E{shoes}&filter_sport_type=%3E{running}";

  const blobPath = String(process.env.PUMA_BLOB_PATH || "puma.json").trim();

  // Pagination controls
  const pageSize = Number(req.query?.pageSize || process.env.PUMA_PAGE_SIZE || 24);
  const maxPages = Number(req.query?.maxPages || process.env.PUMA_MAX_PAGES || 20); // safety cap

  const out = {
    store: "PUMA",
    schemaVersion: 1,
    lastUpdated: nowIso(),
    via: "cheerio",
    sourceUrls: [],
    pagesFetched: 0,
    dealsFound: 0,
    dealsExtracted: 0,
    scrapeDurationMs: 0,
    ok: false,
    error: null,
    dropCounts: {
      totalTiles: 0,
      dropped_missingUrl: 0,
      dropped_missingImage: 0,
      dropped_missingModel: 0,
      dropped_saleMissingOrZero: 0,
      dropped_originalMissingOrZero: 0,
      dropped_notADeal: 0,
      kept: 0,
      __debug_firstTile: null,
    },
    deals: [],
  };

  try {
    const seen = new Set();

    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageSize;
      const url = buildPagedUrl(baseUrl, offset);
      out.sourceUrls.push(url);

      const html = await fetchHtml(url);
      const { dealsFoundThisPage, deals } = extractDealsFromHtml(html, out.dropCounts);

      out.pagesFetched += 1;
      out.dealsFound += dealsFoundThisPage;

      // de-dupe by listingURL
      for (const d of deals) {
        if (seen.has(d.listingURL)) continue;
        seen.add(d.listingURL);
        out.deals.push(d);
      }

      // Stop when a page yields no product tiles
      if (dealsFoundThisPage === 0) break;
    }

    out.dealsExtracted = out.deals.length;
    out.scrapeDurationMs = Date.now() - t0;

    // mandatory blob write
    out.blobUrl = await writeBlobJsonOrThrow(blobPath, out);

const { put } = require("@vercel/blob");

const token = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
if (!token) throw new Error("Missing BLOB_READ_WRITE_TOKEN");

const blobPath = String(process.env.PUMA_BLOB_PATH || "puma.json").trim();

const blob = await put(blobPath, JSON.stringify(out, null, 2), {
  access: "public",
  contentType: "application/json",
  token,
});

out.blobUrl = blob.url;
out.ok = true;

res.setHeader("content-type", "application/json; charset=utf-8");
res.status(200).send(JSON.stringify(out, null, 2));
  } catch (err) {
    out.scrapeDurationMs = Date.now() - t0;
    out.ok = false;
    out.error = String(err?.message || err);

    res.setHeader("content-type", "application/json; charset=utf-8");
    res.status(500).send(JSON.stringify(out, null, 2));
  }
};
