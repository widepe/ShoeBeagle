// /api/scrapers/puma.js
//
// PUMA sale running shoes scraper (infinite scroll / FH-backed).
//
// Goals:
// - Write full output (including deals array) to the blob URL in env var PUMA_DEALS_BLOB_URL
// - API response should NOT include the deals array (only metadata + blobUrl)
// - Stop automatically when no new unique products are found (works for 10 items or 943 items)
// - Avoid "Blob not found" by deriving blob *path* from the full blob URL correctly
//
// Required env vars:
// - PUMA_DEALS_BLOB_URL   (full blob URL, e.g. https://.../puma.json)
// Optional env vars:
// - PUMA_START_URL        (override the default sale URL)
// - PUMA_MAX_PAGES        (default 60)
// - PUMA_PAGE_SIZE        (default 24)
//
// Notes:
// - PUMA uses infinite scroll. The first HTML often contains only 24 items.
// - The page uses Fredhopper (FH) style params behind the scenes.
// - This implementation tries to discover FH urlParams from the HTML and use them to page correctly.
// - If it cannot discover them, it will still stop safely when duplicates/no-new are detected.

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

function nowIso() {
  return new Date().toISOString();
}

function requireEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function optionalEnv(name, fallback = "") {
  const v = String(process.env[name] || "").trim();
  return v || fallback;
}

function safeInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function absUrl(base, href) {
  try {
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    const u = new URL(href, base);
    return u.toString();
  } catch {
    return null;
  }
}

function parseMoney(text) {
  const s = String(text || "").replace(/[\s,]/g, "");
  const m = s.match(/\$?(\d+(\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function computeDiscountPercent(sale, original) {
  if (!Number.isFinite(sale) || !Number.isFinite(original) || original <= 0) return null;
  const pct = Math.round(((original - sale) / original) * 100);
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return pct;
}

// Vercel Blob: you have a FULL url in env. put() wants a PATH/key (e.g. "puma.json").
// We derive it from the URL pathname.
function blobPathFromFullUrl(fullUrl) {
  const u = new URL(fullUrl);
  // pathname like "/puma.json" or "/folder/puma.json"
  const path = u.pathname.replace(/^\/+/, "");
  if (!path) throw new Error(`PUMA_DEALS_BLOB_URL has no pathname: ${fullUrl}`);
  return path;
}

// ------------------------------
// Tile extraction from HTML
// ------------------------------
//
// We keep this intentionally tolerant.
// PUMA markup changes; we try multiple selectors/strategies.

function extractTilesFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const tiles = [];

  // Strategy A: anchor tags that look like PDP links
  // Common: /us/en/pd/<slug>/<style>?swatch=xx
  const anchors = $('a[href*="/us/en/pd/"], a[href*="/us/en/pd/"]').toArray();

  // Deduplicate anchors by href, then try to read surrounding info.
  const seenHref = new Set();
  for (const a of anchors) {
    const href = $(a).attr("href");
    const full = absUrl("https://us.puma.com", href);
    if (!full) continue;
    if (seenHref.has(full)) continue;
    seenHref.add(full);

    // Heuristics: the tile usually contains image + name + pricing near the link.
    const $a = $(a);
    const container = $a.closest("article, li, div").first();

    // Name/model candidates
    const name =
      container.find("h3, h2").first().text().trim() ||
      container.find('[data-test-id*="product-name"]').first().text().trim() ||
      $a.text().trim();

    // Image
    const img =
      container.find("img").first().attr("src") ||
      container.find("img").first().attr("data-src") ||
      null;

    // Prices (try to find two prices)
    const priceTexts = container
      .find('*:contains("$")')
      .toArray()
      .map((el) => $(el).text().trim())
      .filter(Boolean);

    // pick best 2 money values found
    const moneyVals = [];
    for (const t of priceTexts) {
      const n = parseMoney(t);
      if (Number.isFinite(n)) moneyVals.push(n);
      if (moneyVals.length >= 4) break;
    }

    // naive: sale is min, original is max (works for typical sale tiles)
    let salePrice = null;
    let originalPrice = null;
    if (moneyVals.length >= 2) {
      salePrice = Math.min(...moneyVals);
      originalPrice = Math.max(...moneyVals);
      if (salePrice === originalPrice) {
        // could be only one price repeated
        salePrice = null;
        originalPrice = null;
      }
    }

    tiles.push({
      listingURL: full,
      imageURL: img ? absUrl(pageUrl, img) : null,
      name: name || null,
      salePrice,
      originalPrice,
    });
  }

  return tiles;
}

// ------------------------------
// Discover FH urlParams for real pagination
// ------------------------------
//
// The JSON you pasted shows `itemsSection.results.urlParams` which contains:
// - fh_location=...
// - fh_view_size=24
// - fh_start_index=...
//
// We try to find a urlParams-like string inside the HTML.
// If we find it, we can request subsequent "pages" by changing fh_start_index.

function findFhUrlParamsInHtml(html) {
  // Look for something that resembles "fh_location=%2f%2f..." and includes fh_view_size
  const patterns = [
    /fh_location=[^"'\\\s]+/g,
    /fh_view_size=\d+/g,
    /fh_start_index=\d+/g,
  ];

  const hasAll = (s) =>
    s.includes("fh_location=") && s.includes("fh_view_size=") && (s.includes("fh_start_index=") || true);

  // Grab a wider snippet around fh_location if present
  const idx = html.indexOf("fh_location=");
  if (idx === -1) return null;

  const snippet = html.slice(Math.max(0, idx - 2000), Math.min(html.length, idx + 4000));

  // In that snippet, try to capture a joined param string (often within quotes)
  // We try the longest run of URL-parameter-safe characters.
  const m = snippet.match(/fh_location=[A-Za-z0-9%._\-\/]+[A-Za-z0-9%&=._\-\/]+/);
  if (!m) return null;

  const candidate = m[0];
  if (!hasAll(candidate)) return null;

  // Ensure fh_view_size exists; if not, we can add it later.
  return candidate;
}

function setOrReplaceQueryParam(paramString, key, value) {
  // paramString is like "fh_location=...&country=us&...&fh_view_size=24&fh_start_index=48"
  const parts = paramString.split("&").filter(Boolean);
  const out = [];
  let replaced = false;

  for (const p of parts) {
    const [k] = p.split("=");
    if (k === key) {
      out.push(`${key}=${encodeURIComponent(String(value))}`);
      replaced = true;
    } else {
      out.push(p);
    }
  }

  if (!replaced) out.push(`${key}=${encodeURIComponent(String(value))}`);
  return out.join("&");
}

// ------------------------------
// Build a canonical deal from a tile
// ------------------------------

function detectGenderFromName(name) {
  const s = String(name || "").toLowerCase();
  if (s.includes("women")) return "womens";
  if (s.includes("men")) return "mens";
  if (s.includes("kid") || s.includes("youth") || s.includes("junior") || s.includes("girls") || s.includes("boys"))
    return "kids";
  return "unknown";
}

function buildDealFromTile(tile) {
  const listingName = tile.name ? `PUMA ${tile.name}` : null;
  const model = tile.name || null;

  const salePrice = Number.isFinite(tile.salePrice) ? tile.salePrice : null;
  const originalPrice = Number.isFinite(tile.originalPrice) ? tile.originalPrice : null;

  // Your merge rules require BOTH sale + original to treat as a real deal.
  if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice)) return null;
  if (originalPrice <= salePrice) return null;

  const discountPercent = computeDiscountPercent(salePrice, originalPrice);

  return {
    schemaVersion: 1,
    listingName,
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
    listingURL: tile.listingURL,
    imageURL: tile.imageURL,
    gender: detectGenderFromName(tile.name),
    shoeType: "unknown",
  };
}

// ------------------------------
// Main handler
// ------------------------------

module.exports = async function handler(req, res) {
  const t0 = Date.now();

  // Required blob URL
  let blobFullUrl;
  try {
    blobFullUrl = requireEnv("PUMA_DEALS_BLOB_URL");
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  const blobPath = (() => {
    try {
      return blobPathFromFullUrl(blobFullUrl);
    } catch (e) {
      return null;
    }
  })();
  if (!blobPath) {
    return res.status(500).json({ ok: false, error: `Invalid PUMA_DEALS_BLOB_URL: ${blobFullUrl}` });
  }

  const startUrl =
    String(req.query?.url || "").trim() ||
    optionalEnv(
      "PUMA_START_URL",
      "https://us.puma.com/us/en/sale/all-sale?filter_product_division=%3E{shoes}&filter_sport_type=%3E{running}"
    );

  const PAGE_SIZE = safeInt(optionalEnv("PUMA_PAGE_SIZE", "24"), 24);
  const MAX_PAGES = safeInt(optionalEnv("PUMA_MAX_PAGES", "60"), 60);

  const meta = {
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
      dropped_duplicate: 0,
      dropped_missingUrl: 0,
      dropped_missingImage: 0,
      dropped_missingModel: 0,
      dropped_saleMissingOrZero: 0,
      dropped_originalMissingOrZero: 0,
      dropped_notADeal: 0,
      stopped_noNewUnique: 0,
      stopped_noTiles: 0,
      keptUnique: 0,
    },
  };

  const seenUrls = new Set();
  const deals = [];

  // Fetch page 1 HTML
  let firstHtml;
  try {
    meta.sourceUrls.push(startUrl);
    meta.pagesFetched += 1;

    const r = await fetch(startUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    firstHtml = await r.text();
  } catch (e) {
    meta.ok = false;
    meta.error = `Failed to fetch startUrl: ${e?.message || String(e)}`;
    meta.scrapeDurationMs = Date.now() - t0;
    return res.status(500).json({ ok: false, ...meta, blobUrl: blobFullUrl });
  }

  // Discover FH urlParams for real pagination
  const fhParams = findFhUrlParamsInHtml(firstHtml);

  // Helper: fetch a "page" of results by HTML with FH params
  async function fetchPageHtmlByIndex(startIndex) {
    // If we discovered FH params, use them (more likely to return *actual* next items)
    if (fhParams) {
      const withSize = setOrReplaceQueryParam(fhParams, "fh_view_size", PAGE_SIZE);
      const withIndex = setOrReplaceQueryParam(withSize, "fh_start_index", startIndex);

      // We can request the same route but with full FH params appended.
      // The base page accepts these query params.
      const url = `${startUrl}${startUrl.includes("?") ? "&" : "?"}${withIndex}`;
      meta.sourceUrls.push(url);
      meta.pagesFetched += 1;

      const r = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      return await r.text();
    }

    // Fallback: try "offset" style (often returns duplicates; we’ll stop safely)
    const url = `${startUrl}${startUrl.includes("?") ? "&" : "?"}offset=${encodeURIComponent(String(startIndex))}`;
    meta.sourceUrls.push(url);
    meta.pagesFetched += 1;

    const r = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    return await r.text();
  }

  // Process one html page worth of tiles
  function processHtml(html, pageUrl) {
    const tiles = extractTilesFromHtml(html, pageUrl);
    meta.dropCounts.totalTiles += tiles.length;
    meta.dealsFound += tiles.length;

    let newUnique = 0;

    for (const t of tiles) {
      if (!t.listingURL) {
        meta.dropCounts.dropped_missingUrl += 1;
        continue;
      }
      if (seenUrls.has(t.listingURL)) {
        meta.dropCounts.dropped_duplicate += 1;
        continue;
      }
      seenUrls.add(t.listingURL);
      newUnique += 1;

      if (!t.imageURL) meta.dropCounts.dropped_missingImage += 1;
      if (!t.name) meta.dropCounts.dropped_missingModel += 1;

      const deal = buildDealFromTile(t);
      if (!deal) {
        // classify why it failed
        if (!Number.isFinite(t.salePrice) || t.salePrice <= 0) meta.dropCounts.dropped_saleMissingOrZero += 1;
        else if (!Number.isFinite(t.originalPrice) || t.originalPrice <= 0) meta.dropCounts.dropped_originalMissingOrZero += 1;
        else meta.dropCounts.dropped_notADeal += 1;
        continue;
      }

      deals.push(deal);
    }

    return { tilesCount: tiles.length, newUnique };
  }

  // Page 1
  const p1 = processHtml(firstHtml, startUrl);

  // Crawl more “pages” (indexes) until stop
  // stop when:
  // - no tiles returned, OR
  // - no new unique URLs returned
  let startIndex = PAGE_SIZE;
  let safetyPages = 0;

  while (safetyPages < MAX_PAGES) {
    safetyPages += 1;

    // If page 1 already had a lot, we still attempt paging; we’ll stop when no-new happens.
    let html;
    try {
      html = await fetchPageHtmlByIndex(startIndex);
    } catch (e) {
      // stop on fetch failure
      meta.error = `Fetch failed at startIndex=${startIndex}: ${e?.message || String(e)}`;
      break;
    }

    const info = processHtml(html, startUrl);

    if (info.tilesCount === 0) {
      meta.dropCounts.stopped_noTiles += 1;
      break;
    }
    if (info.newUnique === 0) {
      meta.dropCounts.stopped_noNewUnique += 1;
      break;
    }

    startIndex += PAGE_SIZE;
  }

  meta.dealsExtracted = deals.length;
  meta.dropCounts.keptUnique = seenUrls.size;
  meta.scrapeDurationMs = Date.now() - t0;

  // Write full payload (including deals) to blob
  const blobPayload = {
    ...meta,
    ok: true,
    error: null,
    deals,
  };

  try {
    const putResult = await put(blobPath, JSON.stringify(blobPayload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    meta.ok = true;
    meta.error = null;

    // Return metadata ONLY (no deals array)
    return res.status(200).json({
      ...meta,
      blobUrl: putResult.url,
    });
  } catch (e) {
    meta.ok = false;
    meta.error = `Blob write failed: ${e?.message || String(e)}`;
    // Return metadata ONLY (no deals array)
    return res.status(500).json({
      ...meta,
      blobUrl: blobFullUrl,
    });
  }
};
