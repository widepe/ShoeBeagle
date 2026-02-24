// /api/scrapers/puma.js   (CommonJS)
// Scrape PUMA Running Shoes on Sale (HTML + Cheerio), dedupe across pages,
// write FULL JSON (including deals array) to Vercel Blob at PUMA_DEALS_BLOB_URL,
// but DO NOT return the deals array in the API response.
//
// Env vars required:
// - PUMA_DEALS_BLOB_URL  (example: https://...public.blob.vercel-storage.com/puma.json)
// - BLOB_READ_WRITE_TOKEN  (Vercel Blob RW token)
//
// Notes:
// - Uses offset=0,24,48... pagination (the one you showed that returns 270 products total).
// - Stops automatically when a page yields 0 NEW unique listingURLs.
// - Also stops if a page returns 0 tiles (safety).
//
// Test:
//   /api/scrapers/puma
//
// Optional query params:
//   ?maxPages=50   (default 80)
//   ?pageSize=24   (default 24)

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

function nowIso() {
  return new Date().toISOString();
}

function asInt(v, fallback) {
  const n = Number.parseInt(String(v || ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function requireEnv(name) {
  const v = String(process.env[name] || "").trim();
  return v || null;
}

function safeUrlJoin(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href || null;
  }
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function parsePriceNumber(x) {
  // Handles "$34.99", "34.99", " $70.00 "
  const s = String(x || "").replace(/[,]/g, "").trim();
  const m = s.match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function computeDiscountPercent(sale, orig) {
  if (!Number.isFinite(sale) || !Number.isFinite(orig) || orig <= 0) return null;
  const pct = Math.round(((orig - sale) / orig) * 100);
  if (!Number.isFinite(pct)) return null;
  // Guard against weird negatives
  if (pct <= 0) return 0;
  return pct;
}

function detectGenderFromSubHeader(subHeader) {
  const s = String(subHeader || "").toLowerCase();
  if (s.includes("women")) return "womens";
  if (s.includes("men")) return "mens";
  if (s.includes("kid") || s.includes("youth") || s.includes("boys") || s.includes("girls")) return "kids";
  return "unknown";
}

function blobUrlToPathname(blobUrl) {
  // Converts: https://...public.blob.vercel-storage.com/puma.json  ->  "puma.json"
  try {
    const u = new URL(blobUrl);
    let p = u.pathname || "";
    if (p.startsWith("/")) p = p.slice(1);
    return p || null;
  } catch {
    return null;
  }
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      // These headers help reduce “variant HTML” / bot weirdness.
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });

  const text = await res.text();
  if (!res.ok) {
    const snippet = text ? text.slice(0, 400) : "";
    throw new Error(`HTTP ${res.status} fetching HTML. ${snippet}`);
  }
  return text;
}

function extractTilesFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);

  // The parsed “text view” shows product cards as:
  //  - h2 for product name
  //  - h3 for subheader
  //  - image links
  //
  // In practice on PUMA, the product grid cards are typically anchors to /us/en/pd/...
  // We’ll target anchors that look like PDP links and then walk upward to find nearby text/prices/images.
  //
  // This is intentionally resilient (PUMA changes classnames often).

  const pdpAnchors = [];
  $('a[href*="/us/en/pd/"]').each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    const full = safeUrlJoin("https://us.puma.com", href);
    if (!full) return;

    // Dedupe anchors on the same page
    pdpAnchors.push({ href: full, el: a });
  });

  // If their markup nests multiple anchors per card, we want “unique by href” later.
  const tiles = [];

  for (const { href, el } of pdpAnchors) {
    const $a = $(el);

    // Try to find the “card” root: closest element that contains an H2-like title and prices.
    // We’ll walk up a few levels.
    let $root = $a;
    for (let i = 0; i < 6; i++) {
      const hasPriceText =
        normalizeWhitespace($root.text()).includes("$") || $root.find('*:contains("$")').length > 0;
      const hasImg = $root.find("img").length > 0 || $root.find("picture img").length > 0;
      if (hasPriceText && hasImg) break;
      const parent = $root.parent();
      if (!parent || parent.length === 0) break;
      $root = parent;
    }

    // Title model: prefer heading text inside the root (often "## Cell Thrill Dash")
    let model = "";
    const h2 = $root.find("h2").first();
    if (h2.length) model = normalizeWhitespace(h2.text());
    if (!model) {
      // fallback: aria-label or image alt sometimes contains “<name>, <color>, large”
      const imgAlt = $root.find("img").first().attr("alt");
      if (imgAlt) {
        // e.g. "Cell Thrill Dash Men's Sneakers, PUMA Navy-PUMA White, large"
        model = normalizeWhitespace(String(imgAlt).split(",")[0]);
      }
    }

    // Subheader (gender hint): usually h3 like "Men's Sneakers" / "Women's Shoes"
    let subHeader = "";
    const h3 = $root.find("h3").first();
    if (h3.length) subHeader = normalizeWhitespace(h3.text());

    // Image: prefer puma.com image URLs in attributes
    let imageURL = null;
    const img = $root.find("img").first();
    if (img.length) {
      imageURL =
        img.attr("src") ||
        img.attr("data-src") ||
        img.attr("data-lazy") ||
        img.attr("data-original") ||
        null;
    }
    if (imageURL && imageURL.startsWith("//")) imageURL = "https:" + imageURL;

    // Prices: on the text view we saw "$34.99$70.00" adjacent.
    // We’ll extract the first two distinct $ amounts found in root text.
    const rootText = normalizeWhitespace($root.text());
    const priceMatches = rootText.match(/\$\s*\d+(?:\.\d{2})?/g) || [];
    const distinct = [];
    for (const p of priceMatches) {
      const n = parsePriceNumber(p);
      if (!Number.isFinite(n)) continue;
      if (!distinct.includes(n)) distinct.push(n);
      if (distinct.length >= 2) break;
    }

    const salePrice = distinct.length >= 1 ? distinct[0] : null;
    const originalPrice = distinct.length >= 2 ? distinct[1] : null;

    tiles.push({
      listingURL: href,
      model,
      subHeader,
      imageURL,
      salePrice,
      originalPrice,
      pageUrl,
    });
  }

  return tiles;
}

function buildDealFromTile(tile) {
  const model = normalizeWhitespace(tile.model);
  if (!model) return { ok: false, reason: "missingModel" };

  const listingURL = tile.listingURL || null;
  if (!listingURL) return { ok: false, reason: "missingUrl" };

  const imageURL = tile.imageURL || null;
  if (!imageURL) return { ok: false, reason: "missingImage" };

  const salePrice = tile.salePrice;
  const originalPrice = tile.originalPrice;

  if (!Number.isFinite(salePrice) || salePrice <= 0) return { ok: false, reason: "saleMissingOrZero" };
  if (!Number.isFinite(originalPrice) || originalPrice <= 0) return { ok: false, reason: "originalMissingOrZero" };
  if (salePrice >= originalPrice) return { ok: false, reason: "notADeal" };

  const discountPercent = computeDiscountPercent(salePrice, originalPrice);

  const gender = detectGenderFromSubHeader(tile.subHeader);

  // Keep it simple. You can run your detectShoeType() later in merge if you want.
  const deal = {
    schemaVersion: 1,
    listingName: `PUMA ${model} ${tile.subHeader ? tile.subHeader : ""}`.trim(),
    brand: "PUMA",
    model,
    salePrice,
    originalPrice,
    discountPercent,
    salePriceLow: null,
    salePriceHigh: null,
    originalPriceLow: null,
    originalPriceHigh: null,
    discountPercentUpTo: null,
    store: "PUMA",
    listingURL,
    imageURL,
    gender,
    shoeType: "unknown",
  };

  return { ok: true, deal };
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();

  const blobUrl = requireEnv("PUMA_DEALS_BLOB_URL");
  const blobToken = requireEnv("BLOB_READ_WRITE_TOKEN");

  if (!blobUrl) return res.status(500).json({ ok: false, error: "Missing env var PUMA_DEALS_BLOB_URL" });
  if (!blobToken) return res.status(500).json({ ok: false, error: "Missing env var BLOB_READ_WRITE_TOKEN" });

  const blobPath = blobUrlToPathname(blobUrl);
  if (!blobPath) return res.status(500).json({ ok: false, error: "PUMA_DEALS_BLOB_URL is not a valid URL" });

  const pageSize = asInt(req.query?.pageSize, 24);
  const maxPages = asInt(req.query?.maxPages, 80);

  // Base listing url (your filter)
  const base =
    "https://us.puma.com/us/en/sale/all-sale?filter_product_division=%3E%7Bshoes%7D&filter_sport_type=%3E%7Brunning%7D";

  const sourceUrls = [];
  const seenListingUrls = new Set();

  const dropCounts = {
    totalTiles: 0,
    dropped_duplicate: 0,
    dropped_missingUrl: 0,
    dropped_missingImage: 0,
    dropped_missingModel: 0,
    dropped_saleMissingOrZero: 0,
    dropped_originalMissingOrZero: 0,
    dropped_notADeal: 0,
    stopped_noNewFromHtml: 0,
    stopped_noTiles: 0,
  };

  const deals = [];

  let pagesFetched = 0;
  let dealsFound = 0;

  let ok = true;
  let error = null;

  try {
    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageSize;
      const url = `${base}&offset=${offset}`;
      sourceUrls.push(url);

      const html = await fetchHtml(url);
      pagesFetched++;

      const tiles = extractTilesFromHtml(html, url);
      dropCounts.totalTiles += tiles.length;
      dealsFound += tiles.length;

      if (tiles.length === 0) {
        dropCounts.stopped_noTiles += 1;
        break;
      }

      let newUniqueThisPage = 0;

      for (const tile of tiles) {
        if (!tile.listingURL) {
          dropCounts.dropped_missingUrl += 1;
          continue;
        }

        if (seenListingUrls.has(tile.listingURL)) {
          dropCounts.dropped_duplicate += 1;
          continue;
        }

        // Mark as seen early to prevent double adds from multiple anchors per card
        seenListingUrls.add(tile.listingURL);
        newUniqueThisPage++;

        const built = buildDealFromTile(tile);
        if (!built.ok) {
          const r = built.reason;
          if (r === "missingModel") dropCounts.dropped_missingModel += 1;
          else if (r === "missingUrl") dropCounts.dropped_missingUrl += 1;
          else if (r === "missingImage") dropCounts.dropped_missingImage += 1;
          else if (r === "saleMissingOrZero") dropCounts.dropped_saleMissingOrZero += 1;
          else if (r === "originalMissingOrZero") dropCounts.dropped_originalMissingOrZero += 1;
          else if (r === "notADeal") dropCounts.dropped_notADeal += 1;
          continue;
        }

        deals.push(built.deal);
      }

      // ✅ Stop condition: page produced no NEW unique URLs.
      // This is the key fix so it stops properly whether 10 products or 943.
      if (newUniqueThisPage === 0) {
        dropCounts.stopped_noNewFromHtml += 1;
        break;
      }

      // Extra safety: if fewer tiles than pageSize, likely last page.
      if (tiles.length < pageSize) {
        break;
      }
    }

    const payloadForBlob = {
      store: "PUMA",
      schemaVersion: 1,
      lastUpdated: nowIso(),
      via: "cheerio",
      sourceUrls,
      pagesFetched,
      dealsFound,
      dealsExtracted: deals.length,
      scrapeDurationMs: Date.now() - t0,
      ok: true,
      error: null,
      dropCounts: {
        ...dropCounts,
        keptUnique: seenListingUrls.size,
      },
      deals, // ✅ full array stored in blob ONLY
    };

    await put(blobPath, JSON.stringify(payloadForBlob, null, 2), {
      access: "public",
      contentType: "application/json",
      token: blobToken,
      addRandomSuffix: false, // keep exact pathname so merge can find it consistently
    });
  } catch (e) {
    ok = false;
    error = e?.message || String(e);

    // If something failed, still write a small error blob (optional).
    // Comment this out if you prefer not to overwrite.
    try {
      const errBlob = {
        store: "PUMA",
        schemaVersion: 1,
        lastUpdated: nowIso(),
        via: "cheerio",
        sourceUrls,
        pagesFetched,
        dealsFound,
        dealsExtracted: deals.length,
        scrapeDurationMs: Date.now() - t0,
        ok: false,
        error,
        dropCounts,
      };
      await put(blobPath, JSON.stringify(errBlob, null, 2), {
        access: "public",
        contentType: "application/json",
        token: blobToken,
        addRandomSuffix: false,
      });
    } catch {
      // ignore secondary failure
    }
  }

  // ✅ IMPORTANT: Do NOT include deals array in the API response.
  // Return metadata + where it was written.
  return res.status(ok ? 200 : 500).json({
    store: "PUMA",
    schemaVersion: 1,
    lastUpdated: nowIso(),
    via: "cheerio",
    sourceUrls,
    pagesFetched,
    dealsFound,
    dealsExtracted: deals.length,
    scrapeDurationMs: Date.now() - t0,
    ok,
    error,
    dropCounts: {
      ...dropCounts,
      keptUnique: seenListingUrls.size,
    },
    blobUrl, // so you can click and verify
  });
};
