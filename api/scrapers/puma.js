// /api/scrape-puma.js  (CommonJS)
// Scrapes PUMA "All Sale" filtered to Running Shoes, paginates with `offset=`,
// dedupes by URL, writes FULL JSON (including deals[]) to your blob, and
// returns ONLY metadata (no deals array) in the HTTP response.
//
// REQUIRED ENV VARS
// - PUMA_DEALS_BLOB_URL   (example: https://...public.blob.vercel-storage.com/puma.json)
// - BLOB_READ_WRITE_TOKEN (or VERCEL_BLOB_READ_WRITE_TOKEN, depending on your setup)
//
// Optional
// - PUMA_MAX_PAGES        (default 25)
// - PUMA_PAGE_SIZE        (default 24)
// - PUMA_CONCURRENCY      (default 4)

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

// -----------------------------
// helpers
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}

function envStr(name) {
  const v = String(process.env[name] || "").trim();
  return v || null;
}

function getBlobToken() {
  return (
    envStr("BLOB_READ_WRITE_TOKEN") ||
    envStr("VERCEL_BLOB_READ_WRITE_TOKEN") ||
    null
  );
}

function blobPathFromPublicBlobUrl(publicUrl) {
  // Example:
  // https://xxxxx.public.blob.vercel-storage.com/puma.json  -> "puma.json"
  // https://xxxxx.public.blob.vercel-storage.com/folder/puma.json -> "folder/puma.json"
  try {
    const u = new URL(publicUrl);
    let p = (u.pathname || "").replace(/^\/+/, "");
    if (!p) return null;
    return p;
  } catch {
    return null;
  }
}

function absUrl(href) {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  // PUMA uses /us/en/...
  if (href.startsWith("/")) return `https://us.puma.com${href}`;
  return `https://us.puma.com/${href}`;
}

function cleanText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseUsdNumber(x) {
  // accepts "$34.99", "34.99", "$70.00"
  const m = String(x || "").replace(/,/g, "").match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function computeDiscountPercent(sale, orig) {
  if (
    typeof sale !== "number" ||
    typeof orig !== "number" ||
    !Number.isFinite(sale) ||
    !Number.isFinite(orig) ||
    orig <= 0 ||
    sale <= 0 ||
    sale >= orig
  ) {
    return null;
  }
  return Math.round(((orig - sale) / orig) * 100);
}

function detectGenderFromText(t) {
  const s = String(t || "").toLowerCase();
  if (/\bmen['’]s\b/.test(s) || /\bmens\b/.test(s)) return "mens";
  if (/\bwomen['’]s\b/.test(s) || /\bwomens\b/.test(s)) return "womens";
  if (/\bkid['’]s\b/.test(s) || /\bkids\b/.test(s) || /\byouth\b/.test(s))
    return "kids";
  return "unknown";
}

// -----------------------------
// fetch
// -----------------------------
async function fetchHtml(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
  });

  const html = await res.text().catch(() => "");
  if (!res.ok) {
    const msg = `HTTP ${res.status} ${res.statusText}`.trim();
    throw new Error(`${msg} while fetching ${url}`);
  }
  if (!html || html.length < 500) {
    throw new Error(`Empty/short HTML while fetching ${url}`);
  }
  return html;
}

// -----------------------------
// parse one page
// -----------------------------
function extractDealsFromHtml(html) {
  const $ = cheerio.load(html);

  // PUMA list pages are fairly consistent: product tiles contain a link to /us/en/pd/...
  // We’ll grab any anchor with /pd/ inside, then walk up a bit to find nearby text for pricing.
  const tiles = [];

  const anchors = Array.from($('a[href*="/us/en/pd/"]'));
  for (const a of anchors) {
    const href = $(a).attr("href");
    const url = absUrl(href);
    if (!url) continue;

    // walk up to a reasonable container (product card)
    const $card =
      $(a).closest("li, article, div").first().length ? $(a).closest("li, article, div").first() : $(a);

    const cardText = cleanText($card.text());

    // Title/model heuristics: prefer the anchor text; fallback to nearby headings
    let model =
      cleanText($(a).attr("aria-label")) ||
      cleanText($(a).text()) ||
      cleanText($card.find("h2,h3").first().text());

    // Many PUMA tiles show "## <header>" and "### <subheader>" in accessible text;
    // we just need something consistent for `model`.
    model = model || null;

    // Image
    let imageURL =
      $(a).find("img").attr("src") ||
      $(a).find("img").attr("data-src") ||
      $card.find("img").first().attr("src") ||
      $card.find("img").first().attr("data-src") ||
      null;

    imageURL = imageURL ? String(imageURL).trim() : null;

    // Price heuristics: look for two dollar amounts in the card text
    // usually: "$34.99$70.00" or "$34.99 $70.00"
    const money = cardText.match(/\$\s*\d+(?:\.\d+)?/g) || [];
    const sale = parseUsdNumber(money[0] || null);
    const orig = parseUsdNumber(money[1] || null);

    // Gender hint often present like "Men's Sneakers" / "Women's Shoes"
    const gender = detectGenderFromText(cardText);

    tiles.push({
      url,
      model,
      imageURL,
      sale,
      orig,
      gender,
      cardText,
    });
  }

  // de-dupe within page by URL (anchors repeat a lot)
  const seen = new Set();
  const unique = [];
  for (const t of tiles) {
    if (!t.url || seen.has(t.url)) continue;
    seen.add(t.url);
    unique.push(t);
  }

  return { tilesSeen: tiles.length, tilesUnique: unique.length, tiles: unique };
}

// -----------------------------
// build canonical deal
// -----------------------------
function toCanonicalDeal(t) {
  const model = t.model ? cleanText(t.model) : null;
  if (!model) return { deal: null, drop: "missingModel" };

  if (typeof t.sale !== "number" || t.sale <= 0) return { deal: null, drop: "saleMissingOrZero" };
  if (typeof t.orig !== "number" || t.orig <= 0) return { deal: null, drop: "originalMissingOrZero" };

  // must be a deal (sale < orig)
  if (!(t.sale < t.orig)) return { deal: null, drop: "notADeal" };

  const listingURL = t.url;
  if (!listingURL) return { deal: null, drop: "missingUrl" };

  const imageURL = t.imageURL || null;
  if (!imageURL) return { deal: null, drop: "missingImage" };

  const discountPercent = computeDiscountPercent(t.sale, t.orig);

  return {
    drop: null,
    deal: {
      schemaVersion: 1,
      listingName: `PUMA ${model}`,
      brand: "PUMA",
      model,
      salePrice: t.sale,
      originalPrice: t.orig,
      discountPercent: discountPercent,

      // optional range fields (not used here)
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,

      store: "PUMA",
      listingURL,
      imageURL,
      gender: t.gender || "unknown",
      shoeType: "unknown",
    },
  };
}

// -----------------------------
// main handler
// -----------------------------
module.exports = async function handler(req, res) {
  const t0 = Date.now();

  const PUMA_DEALS_BLOB_URL = envStr("PUMA_DEALS_BLOB_URL");
  const blobToken = getBlobToken();

  if (!PUMA_DEALS_BLOB_URL) {
    return res.status(500).json({ ok: false, error: "Missing env var PUMA_DEALS_BLOB_URL" });
  }
  if (!blobToken) {
    return res.status(500).json({
      ok: false,
      error: "Missing blob token env var (BLOB_READ_WRITE_TOKEN or VERCEL_BLOB_READ_WRITE_TOKEN)",
    });
  }

  const blobPath = blobPathFromPublicBlobUrl(PUMA_DEALS_BLOB_URL);
  if (!blobPath) {
    return res.status(500).json({
      ok: false,
      error: "PUMA_DEALS_BLOB_URL must be a valid public blob URL ending in a filename (e.g. .../puma.json)",
    });
  }

  const pageSize = Math.max(1, Number(envStr("PUMA_PAGE_SIZE") || 24));
  const maxPages = Math.max(1, Number(envStr("PUMA_MAX_PAGES") || 25));
  const concurrency = Math.max(1, Number(envStr("PUMA_CONCURRENCY") || 4));

  const base =
    "https://us.puma.com/us/en/sale/all-sale?filter_product_division=%3E%7Bshoes%7D&filter_sport_type=%3E%7Brunning%7D";

  const sourceUrls = [];
  const dropCounts = {
    totalTiles: 0,
    dropped_duplicate: 0,
    dropped_missingUrl: 0,
    dropped_missingImage: 0,
    dropped_missingModel: 0,
    dropped_saleMissingOrZero: 0,
    dropped_originalMissingOrZero: 0,
    dropped_notADeal: 0,
    keptUnique: 0,
    stopReason: null,
    __debug_firstTile: null,
  };

  const seenUrls = new Set();
  const deals = [];

  let page = 0;
  let stop = false;

  async function scrapeOneOffset(offset) {
    const url = `${base}&offset=${offset}`;
    sourceUrls.push(url);

    const html = await fetchHtml(url);
    const { tilesSeen, tilesUnique, tiles } = extractDealsFromHtml(html);

    dropCounts.totalTiles += tilesUnique;

    if (!dropCounts.__debug_firstTile && tiles && tiles.length) {
      const ft = tiles[0];
      dropCounts.__debug_firstTile = {
        tileExists: true,
        firstModel: ft.model || null,
        firstHref: ft.url || null,
        firstImg: ft.imageURL || null,
        firstSale: ft.sale || null,
        firstOrig: ft.orig || null,
      };
    }

    let newUniqueUrls = 0;

    for (const t of tiles) {
      if (!t.url) {
        dropCounts.dropped_missingUrl += 1;
        continue;
      }
      if (seenUrls.has(t.url)) {
        dropCounts.dropped_duplicate += 1;
        continue;
      }
      seenUrls.add(t.url);
      newUniqueUrls += 1;

      const { deal, drop } = toCanonicalDeal(t);
      if (!deal) {
        if (drop === "missingModel") dropCounts.dropped_missingModel += 1;
        else if (drop === "saleMissingOrZero") dropCounts.dropped_saleMissingOrZero += 1;
        else if (drop === "originalMissingOrZero") dropCounts.dropped_originalMissingOrZero += 1;
        else if (drop === "notADeal") dropCounts.dropped_notADeal += 1;
        else if (drop === "missingUrl") dropCounts.dropped_missingUrl += 1;
        else if (drop === "missingImage") dropCounts.dropped_missingImage += 1;
        continue;
      }

      deals.push(deal);
      dropCounts.keptUnique += 1;
    }

    return { url, tilesSeen, tilesUnique, newUniqueUrls };
  }

  try {
    // Paginate offsets: 0, 24, 48, ...
    // We stop when a page yields 0 new unique URLs.
    while (!stop && page < maxPages) {
      // batch offsets
      const batch = [];
      for (let i = 0; i < concurrency && page < maxPages; i += 1) {
        const offset = page * pageSize;
        batch.push(scrapeOneOffset(offset));
        page += 1;
      }

      const results = await Promise.all(batch);

      // if *every* page in this batch produced no new unique URLs, stop
      const anyNew = results.some((r) => r.newUniqueUrls > 0);
      if (!anyNew) {
        dropCounts.stopReason = "no_new_unique_urls";
        stop = true;
      }
    }

    // Write full payload (WITH deals[]) to blob
    const payload = {
      store: "PUMA",
      schemaVersion: 1,
      lastUpdated: nowIso(),
      via: "cheerio",
      sourceUrls,
      pagesFetched: sourceUrls.length,
      dealsFound: dropCounts.totalTiles,
      dealsExtracted: deals.length,
      scrapeDurationMs: Date.now() - t0,
      ok: true,
      error: null,
      dropCounts,
      deals, // <-- stays in blob only; NOT returned in HTTP response below
    };

    const putRes = await put(blobPath, JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      token: blobToken,
    });

    // Respond with metadata ONLY (no deals array)
    return res.status(200).json({
      store: "PUMA",
      schemaVersion: 1,
      lastUpdated: payload.lastUpdated,
      via: payload.via,
      sourceUrls: payload.sourceUrls,
      pagesFetched: payload.pagesFetched,
      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,
      scrapeDurationMs: payload.scrapeDurationMs,
      ok: true,
      error: null,
      dropCounts: payload.dropCounts,
      blobUrl: putRes?.url || PUMA_DEALS_BLOB_URL,
    });
  } catch (e) {
    // On error, do NOT include deals array in response.
    return res.status(500).json({
      store: "PUMA",
      schemaVersion: 1,
      lastUpdated: nowIso(),
      via: "cheerio",
      sourceUrls,
      pagesFetched: sourceUrls.length,
      dealsFound: dropCounts.totalTiles,
      dealsExtracted: deals.length,
      scrapeDurationMs: Date.now() - t0,
      ok: false,
      error: e?.message || "Unknown error",
      dropCounts,
      // intentionally: no deals
    });
  }
};
