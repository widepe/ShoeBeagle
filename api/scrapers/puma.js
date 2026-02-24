// /api/puma.js  (CommonJS, Vercel Serverless Function)
//
// Scrapes PUMA running shoes sale lister using Cheerio and writes to Vercel Blob.
//
// ✅ Uses PUMA_DEALS_BLOB_URL env var (FULL blob URL) to determine blob pathname.
// ✅ Avoids the broken `offset=` pagination by paging with `fh_start_index=`
// ✅ Stops early if a page adds 0 new unique products (prevents “scrape beyond empty pages”)
// ✅ Gender + shoeType rules exactly as you specified (from the card subheader)
//
// Test:
//   /api/puma
//
// Optional overrides:
//   /api/puma?startUrl=https://us.puma.com/us/en/sale/all-sale?filter_product_division=%3E%7Bshoes%7D&filter_sport_type=%3E%7Brunning%7D
//
// Requires env vars:
//   - BLOB_READ_WRITE_TOKEN
//   - PUMA_DEALS_BLOB_URL   (example: https://...public.blob.vercel-storage.com/puma.json)

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

function nowIso() {
  return new Date().toISOString();
}

function toAbsUrl(href) {
  const s = String(href || "").trim();
  if (!s) return null;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return `https://us.puma.com${s}`;
  return `https://us.puma.com/${s}`;
}

function parseMoney(s) {
  const t = String(s || "").replace(/[, ]+/g, "").trim();
  if (!t) return null;
  const m = t.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function cleanText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

// Your rules:
// - Gender from subheader: Men's / Women's, else unknown
// - shoeType from subheader: contains "road running" => road,
//   contains "trail running" => trail, else unknown
function deriveGenderAndType(subHeaderRaw) {
  const sub = cleanText(subHeaderRaw);
  const lower = sub.toLowerCase();

  let gender = "unknown";
  if (/\bmen'?s\b/.test(lower) || /\bmen\b/.test(lower)) gender = "mens";
  else if (/\bwomen'?s\b/.test(lower) || /\bwomen\b/.test(lower)) gender = "womens";

  let shoeType = "unknown";
  if (lower.includes("road running")) shoeType = "road";
  else if (lower.includes("trail running")) shoeType = "trail";

  return { gender, shoeType, subHeader: sub };
}

// Extract a likely total item count from the HTML if present.
// We try a few patterns; if none found, we’ll still paginate until “no new uniques”.
function extractTotalItemsFromHtml(html) {
  // Common in the JSON blobs you pasted: "totalItems":270
  const m1 = html.match(/"totalItems"\s*:\s*(\d{1,6})/);
  if (m1) return Number(m1[1]);

  // Sometimes: "nrOfItemsInSelection":270
  const m2 = html.match(/"nrOfItemsInSelection"\s*:\s*(\d{1,6})/);
  if (m2) return Number(m2[1]);

  return null;
}

// Ensure URL has fh_view_size and fh_start_index for server-side paging.
function withFhPaging(urlStr, startIndex, viewSize) {
  const u = new URL(urlStr);
  if (!u.searchParams.get("fh_view_size")) u.searchParams.set("fh_view_size", String(viewSize));
  u.searchParams.set("fh_start_index", String(startIndex));
  return u.toString();
}

function blobPathFromFullUrl(fullUrl) {
  const raw = String(fullUrl || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    // pathname like "/puma.json" or "/folder/puma.json"
    return u.pathname.replace(/^\/+/, "") || null;
  } catch {
    return null;
  }
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Fetch failed ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }

  return await res.text();
}

function parseTilesFromHtml(html) {
  const $ = cheerio.load(html);
  const tiles = $("li[data-test-id='product-list-item']");
  const parsed = [];

  tiles.each((_, el) => {
    const $li = $(el);

    const href =
      $li.find("a[data-test-id='product-list-item-link']").attr("href") ||
      $li.find("a[href*='/us/en/pd/']").attr("href") ||
      "";

    const listingURL = toAbsUrl(href);
    const model = cleanText($li.find("h2").first().text());

    // Card subheader (your gender/shoeType rules depend on this)
    const subHeaderRaw = $li.find("h3").first().text();
    const { gender, shoeType, subHeader } = deriveGenderAndType(subHeaderRaw);

    // Prices
    const saleRaw = $li.find("[data-test-id='sale-price']").first().text();
    const origRaw = $li.find("[data-test-id='price']").first().text();
    const salePrice = parseMoney(saleRaw);
    const originalPrice = parseMoney(origRaw);

    // Image
    const img =
      $li.find("img").first().attr("src") ||
      $li.find("img").first().attr("data-src") ||
      null;

    const imageURL = cleanText(img);

    parsed.push({
      listingURL,
      model,
      subHeader,
      gender,
      shoeType,
      salePrice,
      originalPrice,
      imageURL: imageURL || null,
    });
  });

  return parsed;
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();

  // ✅ Define these FIRST to avoid “Cannot access 'blobPath' before initialization”
  const blobToken = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
  const blobUrlEnv = String(process.env.PUMA_DEALS_BLOB_URL || "").trim();
  const blobPath = blobPathFromFullUrl(blobUrlEnv);

  const VIEW_SIZE = 24;
  const MAX_PAGES_HARD_CAP = 50; // safety

  const startUrl =
    String(req.query?.startUrl || "").trim() ||
    "https://us.puma.com/us/en/sale/all-sale?filter_product_division=%3E%7Bshoes%7D&filter_sport_type=%3E%7Brunning%7D";

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
      dropped_duplicate: 0,
      dropped_missingUrl: 0,
      dropped_missingImage: 0,
      dropped_missingModel: 0,
      dropped_saleMissingOrZero: 0,
      dropped_originalMissingOrZero: 0,
      dropped_notADeal: 0,
      keptUnique: 0,
      __debug_firstTile: null,
      stopReason: null,
    },
    deals: [],
  };

  try {
    if (!blobToken) throw new Error("Missing BLOB_READ_WRITE_TOKEN env var");
    if (!blobUrlEnv) throw new Error("Missing PUMA_DEALS_BLOB_URL env var");
    if (!blobPath) throw new Error("PUMA_DEALS_BLOB_URL is not a valid URL (could not parse pathname)");

    // Fetch first page to learn total item count if possible
    const html0 = await fetchHtml(withFhPaging(startUrl, 0, VIEW_SIZE));
    const totalItems = extractTotalItemsFromHtml(html0);

    // Plan pages
    const plannedPages =
      typeof totalItems === "number" && Number.isFinite(totalItems) && totalItems > 0
        ? Math.min(MAX_PAGES_HARD_CAP, Math.ceil(totalItems / VIEW_SIZE))
        : MAX_PAGES_HARD_CAP; // unknown total: rely on stop condition

    const seen = new Set(); // dedupe by listingURL
    const deals = [];

    for (let page = 0; page < plannedPages; page++) {
      const startIndex = page * VIEW_SIZE;
      const pageUrl = withFhPaging(startUrl, startIndex, VIEW_SIZE);
      out.sourceUrls.push(pageUrl);

      const html = page === 0 ? html0 : await fetchHtml(pageUrl);
      out.pagesFetched++;

      const tiles = parseTilesFromHtml(html);
      out.dropCounts.totalTiles += tiles.length;

      if (!out.dropCounts.__debug_firstTile && tiles[0]) {
        out.dropCounts.__debug_firstTile = {
          tileExists: true,
          firstModel: tiles[0].model || null,
          firstSubHeader: tiles[0].subHeader || null,
          firstHref: tiles[0].listingURL || null,
          firstImg: tiles[0].imageURL || null,
          firstSale: tiles[0].salePrice,
          firstOrig: tiles[0].originalPrice,
        };
      }

      const before = seen.size;

      for (const t of tiles) {
        // Required fields per your canonical deal logic
        if (!t.listingURL) {
          out.dropCounts.dropped_missingUrl++;
          continue;
        }
        if (seen.has(t.listingURL)) {
          out.dropCounts.dropped_duplicate++;
          continue;
        }
        if (!t.imageURL) {
          out.dropCounts.dropped_missingImage++;
          continue;
        }
        if (!t.model) {
          out.dropCounts.dropped_missingModel++;
          continue;
        }
        if (!t.salePrice || t.salePrice <= 0) {
          out.dropCounts.dropped_saleMissingOrZero++;
          continue;
        }
        if (!t.originalPrice || t.originalPrice <= 0) {
          out.dropCounts.dropped_originalMissingOrZero++;
          continue;
        }
        if (t.salePrice >= t.originalPrice) {
          out.dropCounts.dropped_notADeal++;
          continue;
        }

        seen.add(t.listingURL);

        const discountPercent = Math.round(((t.originalPrice - t.salePrice) / t.originalPrice) * 100);

        deals.push({
          schemaVersion: 1,

          listingName: `PUMA ${t.model} ${t.subHeader}`.trim(),
          brand: "PUMA",
          model: t.model,

          salePrice: t.salePrice,
          originalPrice: t.originalPrice,
          discountPercent,

          // no ranges on this lister
          salePriceLow: null,
          salePriceHigh: null,
          originalPriceLow: null,
          originalPriceHigh: null,
          discountPercentUpTo: null,

          store: "PUMA",
          listingURL: t.listingURL,
          imageURL: t.imageURL,

          gender: t.gender,
          shoeType: t.shoeType,
        });
      }

      const added = seen.size - before;
      if (added === 0) {
        out.dropCounts.stopReason = "no_new_unique_urls";
        break;
      }
    }

    out.deals = deals;
    out.dealsFound = out.dropCounts.totalTiles;
    out.dealsExtracted = deals.length;
    out.dropCounts.keptUnique = deals.length;

    // Write blob
    const blob = await put(blobPath, JSON.stringify(out, null, 2), {
      access: "public",
      contentType: "application/json",
      token: blobToken,
    });

    out.ok = true;
    out.error = null;
    out.blobUrl = blob.url;
    out.scrapeDurationMs = Date.now() - t0;

    return res.status(200).json(out);
  } catch (e) {
    out.ok = false;
    out.error = e?.message || String(e);
    out.scrapeDurationMs = Date.now() - t0;

    // Still return the partial debug we have
    return res.status(500).json(out);
  }
};
