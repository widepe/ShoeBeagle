// /api/scrapers/holabird-sports.js
//
// Holabird Sports shoe deals scraper
//
// ✅ Scrapes 6 segments (road + trail; mens/womens/unisex) SEQUENTIALLY (no concurrency)
// ✅ Each segment is isolated — one failure does NOT kill the whole run
// ✅ Does NOT force gender (gender derived from title only; unknown allowed)
// ✅ Forces shoeType from segment URL
// ✅ Top-level structure matches Zappos-style schema
// ✅ pageNotes included
// ✅ CRON secret commented out for testing

const { put } = require("@vercel/blob");
const axios = require("axios");
const cheerio = require("cheerio");

const HOLABIRD_BASE = "https://www.holabirdsports.com";
const STORE_NAME = "Holabird Sports";
const SCHEMA_VERSION = 1;

/*
Segments define shoeType by URL.
Gender is NOT forced — parser determines it from title; unknown allowed.
Segments run sequentially (no concurrency) to avoid rate limiting / bot detection.
*/
const SEGMENTS = [
  // ROAD
  {
    url: "https://www.holabirdsports.com/collections/shoe-deals/Gender_Mens+Type_Running-Shoes+",
    shoeType: "road",
  },
  {
    url: "https://www.holabirdsports.com/collections/shoe-deals/Type_Running-Shoes+Gender_Womens+",
    shoeType: "road",
  },
  {
    url: "https://www.holabirdsports.com/collections/shoe-deals/Type_Running-Shoes+Gender_Unisex+",
    shoeType: "road",
  },

  // TRAIL
  {
    url: "https://www.holabirdsports.com/collections/shoe-deals/Gender_Mens+Type_Trail-Running-Shoes+",
    shoeType: "trail",
  },
  {
    url: "https://www.holabirdsports.com/collections/shoe-deals/Type_Trail-Running-Shoes+Gender_Womens+",
    shoeType: "trail",
  },
  {
    url: "https://www.holabirdsports.com/collections/shoe-deals/Type_Trail-Running-Shoes+Gender_Unisex+",
    shoeType: "trail",
  },
];

// Slightly longer delays now that we're sequential — be polite to Holabird.
const DELAY_MIN_MS = 300;
const DELAY_MAX_MS = 700;

// Safety caps
const MAX_PAGES_PER_SEGMENT = 80;
const STOP_AFTER_EMPTY_PAGES = 2;

// Keep strict sale/compare requirement (drops full-price items)
const REQUIRE_STRUCTURED_SALE_COMPARE = true;

// Exclude obvious non-shoe junk if it appears in these collections
const EXCLUDE_GIFT_CARD = true;

/** -------------------- small utilities -------------------- **/

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(input) {
  if (input == null) return "";
  return String(input).replace(/\s+/g, " ").trim();
}

function absolutizeUrl(url, base = HOLABIRD_BASE) {
  if (!url) return null;
  const u = String(url).trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return base.replace(/\/+$/, "") + u;
  return base.replace(/\/+$/, "") + "/" + u.replace(/^\/+/, "");
}

function extractDollar(text) {
  const m = String(text || "").match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

/** -------------------- image helpers -------------------- **/

function pickLargestFromSrcset(srcset) {
  if (!srcset) return null;

  const parts = String(srcset)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  let best = null;
  let bestScore = -1;

  for (const part of parts) {
    const [url, desc] = part.split(/\s+/);
    if (!url) continue;

    let score = 0;
    const mW = desc?.match(/(\d+)w/i);
    const mX = desc?.match(/(\d+(?:\.\d+)?)x/i);

    if (mW) score = parseInt(mW[1], 10);
    else if (mX) score = Math.round(parseFloat(mX[1]) * 1000);

    if (score >= bestScore) {
      bestScore = score;
      best = url;
    }
  }

  return best;
}

function bestImgUrlFrom($img) {
  if (!$img || !$img.length) return null;

  const src = $img.attr("data-src") || $img.attr("data-original") || $img.attr("src");
  const srcset = $img.attr("data-srcset") || $img.attr("srcset");
  const picked = pickLargestFromSrcset(srcset);

  return absolutizeUrl(String(picked || src || "").trim(), HOLABIRD_BASE);
}

function findBestImageURL($tile) {
  const $primary = $tile.find("img.product-item__primary-image").first();
  const $any = $tile.find("img").first();
  return bestImgUrlFrom($primary) || bestImgUrlFrom($any) || null;
}

/** -------------------- title / gender / brand / model -------------------- **/

function extractHolabirdTitleText($tile) {
  const t =
    $tile.find("a.product-item__title").first().text() ||
    $tile.find("img.product-item__primary-image").first().attr("alt") ||
    $tile.find("a.product-item__title").first().attr("title") ||
    "";
  return normalizeText(t);
}

function detectGenderFromTitle(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (/\bmen'?s\b/.test(s) || /\bmens\b/.test(s)) return "mens";
  if (/\bwomen'?s\b/.test(s) || /\bwomens\b/.test(s)) return "womens";
  if (/\bunisex\b/.test(s)) return "unisex";
  return "unknown";
}

// Brand list: longest-first match to avoid "On" beating "On Running".
const BRANDS = [
  "Mount to Coast",
  "New Balance",
  "Under Armour",
  "The North Face",
  "La Sportiva",
  "Pearl Izumi",
  "Topo Athletic",
  "Vibram FiveFingers",
  "On Running",
  "361 Degrees",
  "ASICS",
  "Brooks",
  "Saucony",
  "Mizuno",
  "adidas",
  "Nike",
  "HOKA",
  "Puma",
  "Salomon",
  "Diadora",
  "Skechers",
  "Reebok",
  "Altra",
  "Karhu",
  "norda",
  "Nnormal",
  "inov8",
  "Inov-8",
  "VEJA",
  "APL",
  "On",
];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBrand(title) {
  const t = String(title || "");
  if (!t) return "Unknown";

  const brandsSorted = [...BRANDS].sort((a, b) => b.length - a.length);

  for (const b of brandsSorted) {
    if (b === "On") {
      if (/\bOn\b/.test(t)) return "On";
      continue;
    }
    const re = new RegExp(`\\b${escapeRegex(b)}\\b`, "i");
    if (re.test(t)) return b;
  }

  const parts = normalizeText(t).split(" ");
  return parts[0] || "Unknown";
}

function cleanModelFromTitle(title, brand) {
  let t = normalizeText(title);

  if (brand && brand !== "Unknown") {
    const re =
      brand === "On" ? /\bOn\b/ : new RegExp(`\\b${escapeRegex(brand)}\\b`, "i");
    t = normalizeText(t.replace(re, " "));
  }

  // Cut off at explicit gender token
  t = t.replace(/\b(Men'?s|Mens|Women'?s|Womens|Unisex)\b.*$/i, "").trim();

  // Remove trailing generic words if present
  t = t
    .replace(
      /\b(Running Shoe|Trail Running Shoe|Running Shoes|Trail Running Shoes|Shoe|Shoes)\b\s*$/i,
      ""
    )
    .trim();

  return normalizeText(t);
}

/** -------------------- price extraction -------------------- **/

function extractPricesStructured($tile) {
  const saleText = normalizeText(
    $tile.find(".product-item__price-list .price--highlight").first().text()
  );
  const origText = normalizeText(
    $tile.find(".product-item__price-list .price--compare").first().text()
  );

  const sale = extractDollar(saleText);
  const orig = extractDollar(origText);

  if (!Number.isFinite(sale) || !Number.isFinite(orig)) return { valid: false };
  if (!(sale < orig)) return { valid: false };

  return { salePrice: round2(sale), originalPrice: round2(orig), valid: true };
}

/** -------------------- delay -------------------- **/

function randomDelay(min = DELAY_MIN_MS, max = DELAY_MAX_MS) {
  const wait = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, wait));
}

/** -------------------- core segment scraper -------------------- **/

async function scrapeHolabirdCollection({
  collectionUrl,
  shoeType = "unknown",
  maxPages = MAX_PAGES_PER_SEGMENT,
  stopAfterEmptyPages = STOP_AFTER_EMPTY_PAGES,
  excludeGiftCard = EXCLUDE_GIFT_CARD,
  requireStructuredSaleCompare = REQUIRE_STRUCTURED_SALE_COMPARE,
} = {}) {
  const deals = [];
  const seen = new Set();
  const pageNotes = [];

  let pagesFetched = 0;
  let dealsFound = 0;
  let emptyPages = 0;

  // Keep first 2 visited page URLs as human-meaningful sourceUrls
  const visitedForSourceUrls = [];

  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = collectionUrl.includes("?")
      ? `${collectionUrl}&page=${page}`
      : `${collectionUrl}?page=${page}`;

    const startedAt = Date.now();
    let resp;

    try {
      resp = await axios.get(pageUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
          Accept: "text/html",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 20000,
        // Do NOT use validateStatus: () => true — let axios throw on non-2xx
        // so the catch block handles it consistently.
      });
    } catch (axiosErr) {
      const status = axiosErr?.response?.status ?? null;
      const durationMs = Date.now() - startedAt;
      pageNotes.push({
        page: `html page=${page}`,
        success: false,
        count: 0,
        error: axiosErr.message,
        url: pageUrl,
        duration: `${durationMs}ms`,
        status,
      });
      // Re-throw so the segment-level try/catch records the failure.
      throw axiosErr;
    }

    const durationMs = Date.now() - startedAt;
    pagesFetched++;

    if (visitedForSourceUrls.length < 2) visitedForSourceUrls.push(pageUrl);

    const $ = cheerio.load(resp.data);
    let foundThisPage = 0;

    $(".product-item").each((_, el) => {
      const $tile = $(el);

      if (excludeGiftCard && $tile.find(".gift-card-message").length) return;

      const href = $tile.find('a[href^="/products/"]').first().attr("href");
      if (!href || href.includes("#")) return;

      const listingURL = absolutizeUrl(href);
      if (!listingURL || seen.has(listingURL)) return;

      const listingName = extractHolabirdTitleText($tile);
      if (!listingName) return;

      // Count every tile found, even ones we'll filter out
      foundThisPage++;
      dealsFound++;

      if (requireStructuredSaleCompare) {
        const hasSale = $tile.find(".price--highlight").length > 0;
        const hasCompare = $tile.find(".price--compare").length > 0;
        if (!hasSale || !hasCompare) return;
      }

      const prices = extractPricesStructured($tile);
      if (!prices.valid) return;

      const { salePrice, originalPrice } = prices;

      // Strict deal guards
      if (!Number.isFinite(salePrice) || salePrice <= 0) return;
      if (!Number.isFinite(originalPrice) || originalPrice <= 0) return;
      if (!(salePrice < originalPrice)) return;

      const brand = extractBrand(listingName);
      const model = cleanModelFromTitle(listingName, brand);
      const gender = detectGenderFromTitle(listingName); // NOT forced from segment

      deals.push({
        listingName,
        brand,
        model,
        salePrice,
        originalPrice,
        discountPercent: computeDiscountPercent(originalPrice, salePrice),
        store: STORE_NAME,
        listingURL,
        imageURL: findBestImageURL($tile),
        gender,
        shoeType, // always from segment, overwritten again after return for safety
      });

      seen.add(listingURL);
    });

    pageNotes.push({
      page: `html page=${page}`,
      success: true,
      count: foundThisPage,
      error: null,
      url: pageUrl,
      duration: `${durationMs}ms`,
      status: resp.status,
    });

    if (foundThisPage === 0) {
      emptyPages++;
      if (emptyPages >= stopAfterEmptyPages) break;
    } else {
      emptyPages = 0;
    }

    await randomDelay();
  }

  return {
    pagesFetched,
    dealsFound,
    dealsExtracted: deals.length,
    sourceUrls: visitedForSourceUrls.length ? visitedForSourceUrls : [collectionUrl],
    deals,
    pageNotes,
  };
}

/** -------------------- dedupe -------------------- **/

function dedupeByUrl(deals) {
  const out = [];
  const seen = new Set();
  for (const d of deals || []) {
    if (!d?.listingURL || seen.has(d.listingURL)) continue;
    seen.add(d.listingURL);
    out.push(d);
  }
  return out;
}

/** -------------------- top-level shape -------------------- **/

function buildTopLevel({
  via,
  sourceUrls,
  pagesFetched,
  dealsFound,
  dealsExtracted,
  scrapeDurationMs,
  ok,
  error,
  deals,
  pageNotes,
}) {
  return {
    store: STORE_NAME,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated: nowIso(),
    via: via || "cheerio",

    sourceUrls: Array.isArray(sourceUrls) && sourceUrls.length ? sourceUrls : [],
    pagesFetched: Number.isFinite(pagesFetched) ? pagesFetched : 0,

    dealsFound: Number.isFinite(dealsFound) ? dealsFound : 0,
    dealsExtracted: Number.isFinite(dealsExtracted)
      ? dealsExtracted
      : Array.isArray(deals)
      ? deals.length
      : 0,

    scrapeDurationMs: Number.isFinite(scrapeDurationMs) ? scrapeDurationMs : 0,

    ok: !!ok,
    error: error || null,

    pageNotes: Array.isArray(pageNotes) ? pageNotes : [],

    deals: Array.isArray(deals) ? deals : [],
  };
}

/** -------------------- Vercel handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // CRON SECRET DISABLED FOR TESTING
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  */

  const start = Date.now();

  let allDeals = [];
  let pagesFetched = 0;
  let dealsFound = 0;
  const sourceUrls = [];
  const pageNotes = [];
  const segmentErrors = [];

  // ── Run segments SEQUENTIALLY ──────────────────────────────────────────────
  // No concurrency: avoids hammering Holabird and eliminates any shared-state
  // race conditions. Each segment is wrapped in its own try/catch so a single
  // failure (bot block, 429, timeout) does NOT abort the remaining segments.
  for (const segment of SEGMENTS) {
    sourceUrls.push(segment.url); // always record the segment URL

    try {
      const r = await scrapeHolabirdCollection({
        collectionUrl: segment.url,
        shoeType: segment.shoeType,
      });

      pagesFetched += r.pagesFetched || 0;
      dealsFound += r.dealsFound || 0;

      if (r.pageNotes?.length) pageNotes.push(...r.pageNotes);

      // Belt-and-suspenders: enforce shoeType from segment regardless of what
      // the parser may have stored on each deal.
      const normalizedDeals = (r.deals || []).map((d) => ({
        ...d,
        shoeType: segment.shoeType,
      }));

      allDeals.push(...normalizedDeals);

      console.log(
        `[holabird] segment OK  shoeType=${segment.shoeType} ` +
          `pages=${r.pagesFetched} deals=${normalizedDeals.length} ` +
          `url=${segment.url}`
      );
    } catch (err) {
      const msg = err?.message || String(err);
      segmentErrors.push({ url: segment.url, shoeType: segment.shoeType, error: msg });
      console.error(`[holabird] segment FAIL url=${segment.url} error=${msg}`);
      // Continue to the next segment — do NOT rethrow.
    }
  }

  const deduped = dedupeByUrl(allDeals);
  const durationMs = Date.now() - start;

  // Overall run is "ok" as long as at least one segment succeeded.
  const overallOk = deduped.length > 0 || segmentErrors.length < SEGMENTS.length;
  const overallError =
    segmentErrors.length > 0
      ? `${segmentErrors.length} segment(s) failed: ${segmentErrors
          .map((e) => `${e.url} — ${e.error}`)
          .join(" | ")}`
      : null;

  const output = buildTopLevel({
    via: "cheerio",
    sourceUrls,
    pagesFetched,
    dealsFound,
    dealsExtracted: deduped.length,
    scrapeDurationMs: durationMs,
    ok: overallOk,
    error: overallError,
    deals: deduped,
    pageNotes,
  });

  try {
    const blob = await put("holabird-shoe-deals.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      ok: overallOk,
      store: output.store,
      dealsExtracted: output.dealsExtracted,
      pagesFetched: output.pagesFetched,
      dealsFound: output.dealsFound,
      scrapeDurationMs: output.scrapeDurationMs,
      segmentErrors: segmentErrors.length ? segmentErrors : undefined,
      blobUrl: blob.url,
      lastUpdated: output.lastUpdated,
    });
  } catch (blobErr) {
    // Blob write failure — still return what we scraped so the caller knows.
    console.error("[holabird] blob write failed:", blobErr.message);
    return res.status(500).json({
      ok: false,
      error: `Blob write failed: ${blobErr.message}`,
      dealsExtracted: deduped.length,
      segmentErrors: segmentErrors.length ? segmentErrors : undefined,
    });
  }
};
