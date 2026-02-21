// /api/scrapers/dicks-firecrawl.js  (CommonJS)
//
// Purpose:
// - Fetch Dick's Sporting Goods men's + women's sale running pages via Firecrawl
// - Scrape EXACTLY ONE page for mens + ONE page for womens (no pagination)
// - Extract canonical deals with optional range fields
//
// Rules you requested:
// - Deals are NOT dropped just because the title includes "running"
// - shoeType:
//    * if title contains "trail running shoes"        => "trail"
//    * else if title contains "running shoes"         => "road"
//    * else if title contains "track" or "spike(s)"   => "track"
//    * else                                           => "unknown"
// - gender (TITLE ONLY):
//    * women's / womens  => "womens"
//    * men's   / mens    => "mens"
//    * unisex            => "unisex"
//    * else              => "unknown"
//
// TEMP behavior kept:
// - Skip "See Price In Cart" items, but count them in metadata.
//
// Env vars required:
//   FIRECRAWL_API_KEY
//   BLOB_READ_WRITE_TOKEN
//
// Output blob:
//   dicks-sporting-goods.json

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "Dicks Sporting Goods";

const SOURCES = [
  {
    key: "mens",
    url: "https://www.dickssportinggoods.com/f/mens-sale-footwear?filterFacets=4285%253ARunning",
  },
  {
    key: "womens",
    url: "https://www.dickssportinggoods.com/f/womens-sale-footwear?filterFacets=4285%253ARunning",
  },
];

const BLOB_PATHNAME = "dicks-sporting-goods.json";
const MAX_ITEMS_TOTAL = 5000;
const SCHEMA_VERSION = 1;

// -----------------------------
// DEBUG HELPERS
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}

function msSince(t0) {
  return Date.now() - t0;
}

function shortText(s, n = 220) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// -----------------------------
// CORE HELPERS
// -----------------------------
function absUrl(href) {
  if (!href) return null;
  const h = String(href).trim();
  if (!h) return null;
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("//")) return "https:" + h;
  return new URL(h, "https://www.dickssportinggoods.com").toString();
}

// ✅ DSG card selector (matches your pasted outerHTML)
function selectProductCards($) {
  // Example: <div id="product-card" class="product-card-content ...">
  return $(
    'div#product-card.product-card-content, div.product-card-content[id="product-card"], div[id="product-card"], div.product-card'
  );
}

// Extract ALL $ values from any string (supports "$63.97 - $122.97")
function parseMoneyAll(text) {
  if (!text) return [];
  const s = String(text).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

  const out = [];
  const re = /\$?\s*([\d,]+(?:\.\d{1,2})?)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const num = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(num)) out.push(num);
  }
  return out;
}

function calcDiscountPercent(salePrice, originalPrice) {
  if (salePrice == null || originalPrice == null) return null;
  if (!(originalPrice > 0)) return null;
  const pct = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  return Number.isFinite(pct) ? pct : null;
}

// For ranges: "up to" based on (originalHigh - saleLow) / originalHigh
function calcDiscountPercentUpTo(saleLow, originalHigh) {
  if (saleLow == null || originalHigh == null) return null;
  if (!(originalHigh > 0)) return null;
  const pct = Math.round(((originalHigh - saleLow) / originalHigh) * 100);
  return Number.isFinite(pct) ? pct : null;
}

// ✅ Gender: TITLE ONLY (exactly per your rules)
function detectGenderFromTitleOnly(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (s.includes("women's") || s.includes("womens")) return "womens";
  if (s.includes("men's") || s.includes("mens")) return "mens";
  if (s.includes("unisex")) return "unisex";
  return "unknown";
}

// ✅ shoeType per your rules (order matters)
function detectShoeType(listingName) {
  const s = String(listingName || "").toLowerCase();

  if (s.includes("trail running shoes")) return "trail";
  if (s.includes("running shoes")) return "road";
  if (s.includes("track") || s.includes("spike")) return "track";

  return "unknown";
}

function uniqByKey(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyFn(it);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function firstUrlFromSrcset(srcset) {
  if (!srcset) return null;
  const first = String(srcset).split(",")[0]?.trim();
  if (!first) return null;
  return first.split(/\s+/)[0] || null;
}
function normalizeHtmlUrl(u) {
  if (!u) return null;
  return String(u)
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .trim();
}
function getImageUrlFromCard($card) {
  const candidates = [];

  $card.find("img").each((_, imgEl) => {
    const $img = cheerio(imgEl); // ✅ wrap element directly

    const attrsToCheck = ["src", "data-src", "data-original", "srcset", "data-srcset"];
    for (const a of attrsToCheck) {
      const raw = $img.attr(a);
      if (!raw) continue;

      let val = raw;
      if (a.includes("srcset")) val = firstUrlFromSrcset(raw);

      val = normalizeHtmlUrl(val);
      if (!val) continue;

      candidates.push(val);
    }
  });

  const cleaned = candidates
    .map((u) => String(u).trim())
    .filter(Boolean)
    .filter((u) => !u.startsWith("data:image/"))
    .map((u) => absUrl(u))
    .filter(Boolean);

  if (!cleaned.length) return null;

  // Prefer any real Scene7 image (dkscdn OR GolfGalaxy OR others), not the placeholder
  const scene7Real = cleaned.find((u) => {
    const lower = u.toLowerCase();
    return lower.includes("dks.scene7.com/is/image/") && !lower.includes("productimageunavailable");
  });
  if (scene7Real) return scene7Real;

  // Otherwise any non-placeholder
  const nonPlaceholder = cleaned.find((u) => !u.toLowerCase().includes("productimageunavailable"));
  if (nonPlaceholder) return nonPlaceholder;

  return null;
}

function extractPriceSignalsFromCardText($card) {
  const t = $card.text().replace(/\s+/g, " ").trim().toLowerCase();
  const seePriceInCart = t.includes("see price in cart");
  return { seePriceInCart };
}

function guessBrandModel(listingName) {
  const raw = String(listingName || "").replace(/\s+/g, " ").trim();
  if (!raw) return { brand: "unknown", model: "unknown" };

  const brandPrefixes = [
    "New Balance",
    "Under Armour",
    "ASICS",
    "Saucony",
    "Brooks",
    "HOKA",
    "On",
    "Nike",
    "adidas",
    "PUMA",
    "Mizuno",
    "Altra",
    "Reebok",
    "Salomon",
    "Merrell",
    "La Sportiva",
    "Topo Athletic",
    "Arc'teryx",
    "The North Face",
    "Columbia",
    "Vans",
  ];

  const match = brandPrefixes
    .slice()
    .sort((a, b) => b.length - a.length)
    .find(
      (b) =>
        raw.toLowerCase().startsWith(b.toLowerCase() + " ") ||
        raw.toLowerCase() === b.toLowerCase()
    );

  let brand;
  let rest;

  if (match) {
    brand = match;
    rest = raw.slice(match.length).trim();
  } else {
    brand = raw.split(/\s+/)[0] || "unknown";
    rest = raw.slice(brand.length).trim();
  }

  const model =
    rest
      .replace(/\bwomen'?s\b/gi, "")
      .replace(/\bmen'?s\b/gi, "")
      .replace(/\bunisex\b/gi, "")
      .replace(/\btrail running shoes\b/gi, "")
      .replace(/\brunning shoes\b/gi, "")
      .replace(/\bshoes?\b/gi, "")
      .replace(/\s+/g, " ")
      .trim() || "unknown";

  return { brand, model };
}

// Parse sale/original price values directly from the container text
function extractSaleAndOriginalValuesFromCard($card) {
  const saleText = $card.find(".price-sale, [class*='price-sale']").first().text() || "";
  const origText = $card
    .find(".hmf-text-decoration-linethrough, [class*='linethrough'], [class*='strike']")
    .first()
    .text() || "";

  const saleVals = parseMoneyAll(saleText);
  const origVals = parseMoneyAll(origText);

  const saleValues = Array.from(new Set(saleVals.map((x) => Number(x.toFixed(2))))).sort(
    (a, b) => a - b
  );
  const originalValues = Array.from(
    new Set(origVals.map((x) => Number(x.toFixed(2))))
  ).sort((a, b) => a - b);

  return { saleValues, originalValues, saleText, origText };
}

// -----------------------------
// FIRECRAWL FETCH
// -----------------------------
async function fetchHtmlViaFirecrawl(url, runId, label = "DSG") {
  const t0 = Date.now();
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY env var is not set");

  console.log(`[${runId}] ${label} firecrawl start: ${url}`);

  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["html"],
      onlyMainContent: false,
      waitFor: 3500,
      timeout: 60000,
      maxAge: 0, // force fresh
    }),
  });

  let json;
  try {
    json = await res.json();
  } catch (e) {
    const text = await res.text().catch(() => "");
    console.error(`[${runId}] ${label} firecrawl JSON parse error. Body:`, (text || "").slice(0, 300));
    throw e;
  }

  console.log(`[${runId}] ${label} firecrawl done: status=${res.status} ok=${res.ok} time=${msSince(t0)}ms`);

  if (!res.ok || !json?.success) {
    console.log(`[${runId}] ${label} firecrawl error:`, JSON.stringify(json).slice(0, 300));
    throw new Error(`Firecrawl failed: ${res.status} — ${json?.error || "unknown error"}`);
  }

  const html = json?.data?.html || json?.html || "";
  console.log(`[${runId}] ${label} firecrawl htmlLen=${html.length}`);
  if (!html) throw new Error("Firecrawl returned empty HTML");

  return html;
}

// -----------------------------
// PARSE / EXTRACT (single page)
// -----------------------------
async function extractDealsFromHtml(html, runId, sourceKey) {
  const t0 = Date.now();
  const $ = cheerio.load(html);

  const deals = [];

  let cardsFound = 0;
  let titleMissingSkipped = 0;
  let urlMissingSkipped = 0;
  let imageMissingSkipped = 0;
  let priceMissingSkipped = 0;
  let seePriceInCartSkipped = 0;

  const $cards = selectProductCards($);
  cardsFound = $cards.length;

  console.log(`[${runId}] DSG parse ${sourceKey}: cardsFound=${cardsFound}`);

  for (let i = 0; i < $cards.length; i++) {
    const el = $cards.get(i);
    const $card = $(el);

    const $title = $card.find("a.product-title-link").first();
    const listingName = $title.text().replace(/\s+/g, " ").trim();
    if (!listingName) {
      titleMissingSkipped++;
      continue;
    }

    const href = $title.attr("href") || null;
    const listingURL = absUrl(href);
    if (!listingURL) {
      urlMissingSkipped++;
      continue;
    }

    const imageURL = getImageUrlFromCard($card);
    if (!imageURL) {
      imageMissingSkipped++;
      continue;
    }

    const { seePriceInCart } = extractPriceSignalsFromCardText($card);
    if (seePriceInCart) {
      seePriceInCartSkipped++;
      continue;
    }

    let { saleValues, originalValues, saleText, origText } = extractSaleAndOriginalValuesFromCard($card);

    // aria-label fallback
    if (!saleValues.length || !originalValues.length) {
      const aria = $title.attr("aria-label") || "";
      const nums = parseMoneyAll(aria).map((x) => Number(x.toFixed(2)));
      const uniq = Array.from(new Set(nums)).sort((a, b) => a - b);

      if (uniq.length >= 4) {
        if (!saleValues.length) saleValues = [uniq[0], uniq[1]];
        if (!originalValues.length) originalValues = [uniq[uniq.length - 2], uniq[uniq.length - 1]];
      } else if (uniq.length >= 2) {
        if (!saleValues.length) saleValues = [uniq[0]];
        if (!originalValues.length) originalValues = [uniq[uniq.length - 1]];
      }
    }

    if (!saleValues.length || !originalValues.length) {
      priceMissingSkipped++;
      continue;
    }

    const saleLow = saleValues[0];
    const saleHigh = saleValues[saleValues.length - 1];
    const origLow = originalValues[0];
    const origHigh = originalValues[originalValues.length - 1];

    if (!(saleLow > 0) || !(origLow > 0)) {
      priceMissingSkipped++;
      continue;
    }

    const isSaleRange = saleValues.length > 1 && saleLow !== saleHigh;
    const isOrigRange = originalValues.length > 1 && origLow !== origHigh;
    const isAnyRange = isSaleRange || isOrigRange;

    let salePrice = null;
    let originalPrice = null;
    let discountPercent = null;

    let salePriceLow = null;
    let salePriceHigh = null;
    let originalPriceLow = null;
    let originalPriceHigh = null;
    let discountPercentUpTo = null;

    if (!isAnyRange) {
      salePrice = saleLow;
      originalPrice = origLow;
      discountPercent = calcDiscountPercent(salePrice, originalPrice);
    } else {
      salePriceLow = saleLow;
      salePriceHigh = saleHigh;
      originalPriceLow = origLow;
      originalPriceHigh = origHigh;
      discountPercentUpTo = calcDiscountPercentUpTo(salePriceLow, originalPriceHigh);

      console.log(
        `[${runId}] DSG RANGE ${sourceKey}: ${shortText(listingName, 80)} | saleText="${shortText(
          saleText,
          80
        )}" origText="${shortText(origText, 80)}" => sale=${salePriceLow}-${salePriceHigh} orig=${originalPriceLow}-${originalPriceHigh}`
      );
    }

    const gender = detectGenderFromTitleOnly(listingName);
    const shoeType = detectShoeType(listingName);

    const { brand, model } = guessBrandModel(listingName);

    deals.push({
      schemaVersion: SCHEMA_VERSION,

      listingName,
      brand,
      model,

      salePrice,
      originalPrice,
      discountPercent,

      salePriceLow,
      salePriceHigh,
      originalPriceLow,
      originalPriceHigh,
      discountPercentUpTo,

      store: STORE,
      listingURL,
      imageURL,
      gender,
      shoeType,
    });
  }

  const deduped = uniqByKey(deals, (d) => d.listingURL || d.listingName).slice(0, MAX_ITEMS_TOTAL);

  console.log(
    `[${runId}] DSG parse ${sourceKey}: cardsFound=${cardsFound} extracted=${deals.length} deduped=${deduped.length} seePriceInCartSkipped=${seePriceInCartSkipped} priceMissingSkipped=${priceMissingSkipped} imageMissingSkipped=${imageMissingSkipped} titleMissingSkipped=${titleMissingSkipped} urlMissingSkipped=${urlMissingSkipped} time=${msSince(
      t0
    )}ms`
  );

  return {
    deals: deduped,
    cardsFound,
    extracted: deals.length,
    seePriceInCartSkipped,
    priceMissingSkipped,
    imageMissingSkipped,
    titleMissingSkipped,
    urlMissingSkipped,
  };
}

// -----------------------------
// SCRAPE ONE PAGE PER SOURCE
// -----------------------------
async function scrapeOnePagePerSource(runId, src) {
  const visited = [src.url];
  console.log(`[${runId}] DSG ${src.key} single-page start: ${src.url}`);

  const html = await fetchHtmlViaFirecrawl(src.url, runId, `DSG-${src.key}`);

  const parsed = await extractDealsFromHtml(html, runId, src.key);

  return {
    deals: parsed.deals || [],
    pagesFetched: 1,
    sourceUrlsVisited: visited,

    cardsFound: parsed.cardsFound || 0,
    extracted: parsed.extracted || 0,

    seePriceInCartSkipped: parsed.seePriceInCartSkipped || 0,
    priceMissingSkipped: parsed.priceMissingSkipped || 0,
    imageMissingSkipped: parsed.imageMissingSkipped || 0,
    titleMissingSkipped: parsed.titleMissingSkipped || 0,
    urlMissingSkipped: parsed.urlMissingSkipped || 0,
  };
}

// -----------------------------
// SCRAPE ALL SOURCES
// -----------------------------
async function scrapeAll(runId) {
  const startedAt = Date.now();
  const allDeals = [];
  const sourceUrls = [];

  let pagesFetchedTotal = 0;
  let cardsFoundTotal = 0;

  let seePriceInCartSkippedTotal = 0;
  let priceMissingSkippedTotal = 0;
  let imageMissingSkippedTotal = 0;
  let titleMissingSkippedTotal = 0;
  let urlMissingSkippedTotal = 0;

  for (const src of SOURCES) {
    console.log(`[${runId}] DSG source start: ${src.key}`);

    const out = await scrapeOnePagePerSource(runId, src);

    allDeals.push(...(out.deals || []));
    pagesFetchedTotal += out.pagesFetched || 0;
    cardsFoundTotal += out.cardsFound || 0;
    sourceUrls.push(...(out.sourceUrlsVisited || []));

    seePriceInCartSkippedTotal += out.seePriceInCartSkipped || 0;
    priceMissingSkippedTotal += out.priceMissingSkipped || 0;
    imageMissingSkippedTotal += out.imageMissingSkipped || 0;
    titleMissingSkippedTotal += out.titleMissingSkipped || 0;
    urlMissingSkippedTotal += out.urlMissingSkipped || 0;

    console.log(
      `[${runId}] DSG source done: ${src.key} extractedDeals=${(out.deals || []).length} pagesFetched=${out.pagesFetched} cardsFound=${out.cardsFound} seePriceInCartSkipped=${out.seePriceInCartSkipped}`
    );
  }

  const deals = uniqByKey(allDeals, (d) => d.listingURL || d.listingName).slice(0, MAX_ITEMS_TOTAL);
  const scrapeDurationMs = msSince(startedAt);

  return {
    store: STORE,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated: nowIso(),
    via: "firecrawl",

    sourceUrls,
    pagesFetched: pagesFetchedTotal,

    // "found" = how many product cards we saw on the two pages
    dealsFound: cardsFoundTotal,
    // "extracted" = how many we kept (priced & not "see price in cart", etc.)
    dealsExtracted: deals.length,

    seePriceInCartSkipped: seePriceInCartSkippedTotal,

    missingTitleSkipped: titleMissingSkippedTotal,
    missingUrlSkipped: urlMissingSkippedTotal,
    missingPriceSkipped: priceMissingSkippedTotal,
    missingImageSkipped: imageMissingSkippedTotal,

    scrapeDurationMs,

    ok: true,
    error: null,

    deals,
  };
}

// -----------------------------
// HANDLER
// -----------------------------
module.exports = async function handler(req, res) {
  const runId = `dsg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const t0 = Date.now();

  console.log(`[${runId}] DSG handler start ${nowIso()}`);
  console.log(`[${runId}] method=${req.method} path=${req.url || ""}`);

  try {
    const data = await scrapeAll(runId);

    console.log(
      `[${runId}] DSG blob write start: ${BLOB_PATHNAME} dealsExtracted=${data.dealsExtracted} dealsFound=${data.dealsFound} seePriceInCartSkipped=${data.seePriceInCartSkipped}`
    );

    const blobRes = await put(BLOB_PATHNAME, JSON.stringify(data, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    console.log(`[${runId}] DSG blob write done: url=${blobRes.url} time=${msSince(t0)}ms`);

    res.status(200).json({
      ok: true,
      runId,
      dealsFound: data.dealsFound,
      dealsExtracted: data.dealsExtracted,
      seePriceInCartSkipped: data.seePriceInCartSkipped,
      missingTitleSkipped: data.missingTitleSkipped,
      missingUrlSkipped: data.missingUrlSkipped,
      missingPriceSkipped: data.missingPriceSkipped,
      missingImageSkipped: data.missingImageSkipped,
      pagesFetched: data.pagesFetched,
      blobUrl: blobRes.url,
      elapsedMs: msSince(t0),
    });
  } catch (err) {
    console.error(`[${runId}] DSG scrape failed:`, err);
    res.status(500).json({
      ok: false,
      runId,
      error: String(err && err.message ? err.message : err),
      elapsedMs: msSince(t0),
    });
  } finally {
    console.log(`[${runId}] DSG handler end time=${msSince(t0)}ms`);
  }
};
