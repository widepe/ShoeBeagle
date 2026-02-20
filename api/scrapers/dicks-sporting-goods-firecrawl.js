// /api/scrapers/dicks-firecrawl.js  (CommonJS)
//
// Purpose (FAST MODE as currently configured):
// - Scrape Dick's Sporting Goods MEN'S sale running pages via Firecrawl
// - Follow pagination via pageNumber param (MAX_PAGES_PER_SOURCE)
// - Extract canonical deals with optional range fields (salePriceLow/High, originalPriceLow/High, discountPercentUpTo)
// - STRICT running filter:
//    * "trail running shoes" => shoeType "trail"
//    * "running shoes"       => shoeType "road"
//    * otherwise EXCLUDE
// - TEMP: Skip "See Price In Cart" items for speed, but DO COUNT THEM in metadata.
// - IMPORTANT FIXES IN THIS VERSION:
//    1) dealsFound now counts ALL running shoe cards found (including those skipped for price-in-cart, missing prices, etc.)
//    2) metadata includes seePriceInCartSkipped total
//    3) price ranges are NOT skipped; they are recorded using the range variables.
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

// ✅ MEN'S only for now (women's disabled)
const SOURCES = [
  {
    key: "mens",
    url: "https://www.dickssportinggoods.com/f/mens-sale-footwear?filterFacets=4285%253ARunning",
  },
  // {
  //   key: "womens",
  //   url: "https://www.dickssportinggoods.com/f/womens-sale-footwear?filterFacets=4285%253ARunning",
  // },
];

const BLOB_PATHNAME = "dicks-sporting-goods.json";
const MAX_ITEMS_TOTAL = 5000;

// ✅ currently 3 pages (0,1,2)
const MAX_PAGES_PER_SOURCE = 3;

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

function parseMoney(text) {
  if (!text) return null;
  const m = String(text)
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .match(/\$?\s*([\d,]+(\.\d{1,2})?)/);
  if (!m) return null;
  const num = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(num) ? num : null;
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

function detectGenderFromSource(sourceKey) {
  if (sourceKey === "mens") return "mens";
  if (sourceKey === "womens") return "womens";
  return "unknown";
}

function detectGenderFromTitle(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (s.includes("women's") || s.includes("womens")) return "womens";
  if (s.includes("men's") || s.includes("mens")) return "mens";
  if (s.includes("unisex")) return "unisex";
  return "unknown";
}

// STRICT running-only rule
function detectShoeTypeStrict(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (s.includes("trail running shoes")) return "trail";
  if (s.includes("running shoes")) return "road";
  return null; // EXCLUDE
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

function getImageUrlFromCard($card) {
  const $img = $card.find('img[itemprop="image"]').first();
  if (!$img.length) return null;

  const src = $img.attr("src") || $img.attr("data-src") || $img.attr("data-original") || null;
  const srcset = $img.attr("srcset") || $img.attr("data-srcset") || null;
  const fromSrcset = firstUrlFromSrcset(srcset);

  return absUrl(src || fromSrcset);
}

function collectMoneyValues($, $elements) {
  const nums = [];
  $elements.each((_, el) => {
    const t = $(el).text();
    const n = parseMoney(t);
    if (n != null && Number.isFinite(n)) nums.push(n);
  });

  // de-dupe exact duplicates (common with nested spans)
  const uniq = Array.from(new Set(nums.map((x) => Number(x.toFixed(2))))).map(Number);
  uniq.sort((a, b) => a - b);
  return uniq;
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
        raw.toLowerCase().startsWith(b.toLowerCase() + " ") || raw.toLowerCase() === b.toLowerCase()
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

// -----------------------------
// FIRECRAWL FETCH
// -----------------------------
async function fetchHtmlViaFirecrawl(url, runId, label = "DSG") {
  const t0 = Date.now();
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY env var is not set");

  console.log(`[${runId}] ${label} firecrawl start: ${url}`);

  let res;
  try {
    res = await fetch("https://api.firecrawl.dev/v1/scrape", {
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
      }),
    });
  } catch (e) {
    console.error(`[${runId}] ${label} firecrawl network error:`, e);
    throw e;
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    const text = await res.text().catch(() => "");
    console.error(`[${runId}] ${label} firecrawl JSON parse error. Body:`, (text || "").slice(0, 300));
    throw e;
  }

  console.log(
    `[${runId}] ${label} firecrawl done: status=${res.status} ok=${res.ok} time=${msSince(t0)}ms`
  );

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
// PARSE / EXTRACT
// IMPORTANT: returns counters so metadata can reflect ALL cards, not just extracted deals.
// -----------------------------
async function extractDealsFromHtml(html, runId, sourceKey) {
  const t0 = Date.now();
  const $ = cheerio.load(html);

  const deals = [];

  let runningCardsFound = 0;       // ✅ counts all "running shoe" cards (strict filter)
  let seePriceInCartSkipped = 0;   // ✅ counts those skipped due to hidden pricing
  let missingPriceSkipped = 0;     // optional (helps explain gaps)
  let missingImageSkipped = 0;     // optional (helps explain gaps)

  const $cards = $("div.product-card");
  console.log(`[${runId}] DSG parse ${sourceKey}: cardsFound=${$cards.length}`);

  for (let i = 0; i < $cards.length; i++) {
    const el = $cards.get(i);
    const $card = $(el);

    // Title + URL
    const $title = $card.find("a.product-title-link").first();
    const listingName = $title.text().replace(/\s+/g, " ").trim();
    if (!listingName) continue;

    const shoeType = detectShoeTypeStrict(listingName);
    if (!shoeType) continue; // strict running-only filter

    // ✅ This is a "deal card" we consider in dealsFound
    runningCardsFound++;

    const href = $title.attr("href") || null;
    const listingURL = absUrl(href);
    if (!listingURL) continue;

    // Image URL (still required for extracted deals; but card still counts in dealsFound)
    const imageURL = getImageUrlFromCard($card);
    if (!imageURL) {
      missingImageSkipped++;
      continue;
    }

    // Price-in-cart handling (TEMP: skip for speed, but count in metadata)
    const { seePriceInCart } = extractPriceSignalsFromCardText($card);
    if (seePriceInCart) {
      seePriceInCartSkipped++;
      continue;
    }

    // Price in card (when available)
    const saleEls = $card.find(".price-sale, .hmf-body-bold-l.price-sale, [class*='price-sale']");
    const origEls = $card.find(
      ".hmf-text-decoration-linethrough, [class*='linethrough'], [class*='strike']"
    );

    let saleValues = collectMoneyValues($, saleEls);
    let originalValues = collectMoneyValues($, origEls);

    // Some cards embed pricing in aria-label:
    if (!saleValues.length || !originalValues.length) {
      const aria = $title.attr("aria-label") || "";
      const nums = [];
      const re = /\$[\s]*([\d,]+(?:\.\d{1,2})?)/g;
      let m;
      while ((m = re.exec(String(aria))) !== null) {
        const n = Number(String(m[1]).replace(/,/g, ""));
        if (Number.isFinite(n)) nums.push(Number(n.toFixed(2)));
      }
      const uniq = Array.from(new Set(nums)).sort((a, b) => a - b);
      if (uniq.length >= 2) {
        saleValues = saleValues.length ? saleValues : [uniq[0]];
        originalValues = originalValues.length ? originalValues : [uniq[uniq.length - 1]];
      }
    }

    // Require BOTH (your rule) — but count these gaps separately so dealsFound makes sense
    if (!saleValues.length || !originalValues.length) {
      missingPriceSkipped++;
      continue;
    }

    const saleLow = saleValues[0];
    const saleHigh = saleValues[saleValues.length - 1];
    const origLow = originalValues[0];
    const origHigh = originalValues[originalValues.length - 1];

    if (!(saleLow > 0) || !(origLow > 0)) {
      missingPriceSkipped++;
      continue;
    }

    // ✅ RANGES ARE SUPPORTED (NOT SKIPPED)
    const isSaleRange = saleValues.length > 1 && saleLow !== saleHigh;
    const isOrigRange = originalValues.length > 1 && origLow !== origHigh;
    const isAnyRange = isSaleRange || isOrigRange;

    // Legacy + range fields
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
    }

    const gender =
      detectGenderFromTitle(listingName) !== "unknown"
        ? detectGenderFromTitle(listingName)
        : detectGenderFromSource(sourceKey);

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
    `[${runId}] DSG parse ${sourceKey}: runningCardsFound=${runningCardsFound} extracted=${deals.length} deduped=${deduped.length} seePriceInCartSkipped=${seePriceInCartSkipped} missingPriceSkipped=${missingPriceSkipped} missingImageSkipped=${missingImageSkipped} time=${msSince(
      t0
    )}ms`
  );

  if (deduped.length) {
    const s = deduped[0];
    console.log(`[${runId}] DSG sample ${sourceKey}:`, {
      listingName: shortText(s.listingName, 80),
      listingURL: s.listingURL ? s.listingURL.slice(0, 80) : null,
      imageURL: s.imageURL ? s.imageURL.slice(0, 80) : null,
      salePrice: s.salePrice,
      originalPrice: s.originalPrice,
      salePriceLow: s.salePriceLow,
      salePriceHigh: s.salePriceHigh,
      originalPriceLow: s.originalPriceLow,
      originalPriceHigh: s.originalPriceHigh,
      discountPercent: s.discountPercent,
      discountPercentUpTo: s.discountPercentUpTo,
      gender: s.gender,
      shoeType: s.shoeType,
    });
  }

  return {
    deals: deduped,

    // ✅ counters for metadata
    runningCardsFound,
    seePriceInCartSkipped,
    missingPriceSkipped,
    missingImageSkipped,
  };
}

// -----------------------------
// PAGINATION (pageNumber param)
// -----------------------------
function withPageNumber(baseUrl, pageNumber) {
  const u = new URL(baseUrl);
  if (pageNumber == null || pageNumber === 0) {
    u.searchParams.delete("pageNumber"); // first page
  } else {
    u.searchParams.set("pageNumber", String(pageNumber));
  }
  return u.toString();
}

// -----------------------------
// SCRAPE SOURCE (WITH PARAM PAGINATION)
// -----------------------------
async function scrapeSourceWithPagination(runId, src) {
  const sourceDeals = [];
  const visited = [];
  let pagesFetched = 0;

  // ✅ rollup counters per source
  let runningCardsFound = 0;
  let seePriceInCartSkipped = 0;
  let missingPriceSkipped = 0;
  let missingImageSkipped = 0;

  for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_SOURCE; pageNumber++) {
    const pageUrl = withPageNumber(src.url, pageNumber);
    visited.push(pageUrl);
    pagesFetched++;

    console.log(`[${runId}] DSG ${src.key} page ${pageNumber + 1} start: ${pageUrl}`);

    const html = await fetchHtmlViaFirecrawl(pageUrl, runId, `DSG-${src.key}`);

    const $ = cheerio.load(html);
    const cardCount = $("div.product-card").length;
    console.log(`[${runId}] DSG ${src.key} page ${pageNumber + 1} cardsFound=${cardCount}`);

    if (!cardCount) {
      console.log(`[${runId}] DSG ${src.key} stop: no cards`);
      break;
    }

    const parsed = await extractDealsFromHtml(html, runId, src.key);

    sourceDeals.push(...(parsed.deals || []));

    // ✅ accumulate counts
    runningCardsFound += parsed.runningCardsFound || 0;
    seePriceInCartSkipped += parsed.seePriceInCartSkipped || 0;
    missingPriceSkipped += parsed.missingPriceSkipped || 0;
    missingImageSkipped += parsed.missingImageSkipped || 0;

    console.log(
      `[${runId}] DSG ${src.key} page ${pageNumber + 1} done: extractedDeals=${(parsed.deals || []).length} runningCardsFound=${parsed.runningCardsFound} seePriceInCartSkipped=${parsed.seePriceInCartSkipped}`
    );
  }

  return {
    deals: uniqByKey(sourceDeals, (d) => d.listingURL || d.listingName),
    pagesFetched,
    sourceUrlsVisited: visited,

    // ✅ per-source totals (rolled up into global metadata)
    runningCardsFound,
    seePriceInCartSkipped,
    missingPriceSkipped,
    missingImageSkipped,
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

  // ✅ global rollups
  let runningCardsFoundTotal = 0;
  let seePriceInCartSkippedTotal = 0;
  let missingPriceSkippedTotal = 0;
  let missingImageSkippedTotal = 0;

  for (const src of SOURCES) {
    console.log(`[${runId}] DSG source start: ${src.key}`);

    const out = await scrapeSourceWithPagination(runId, src);

    allDeals.push(...(out.deals || []));
    pagesFetchedTotal += out.pagesFetched || 0;
    sourceUrls.push(...(out.sourceUrlsVisited || []));

    runningCardsFoundTotal += out.runningCardsFound || 0;
    seePriceInCartSkippedTotal += out.seePriceInCartSkipped || 0;
    missingPriceSkippedTotal += out.missingPriceSkipped || 0;
    missingImageSkippedTotal += out.missingImageSkipped || 0;

    console.log(
      `[${runId}] DSG source done: ${src.key} extractedDeals=${(out.deals || []).length} pagesFetched=${out.pagesFetched} runningCardsFound=${out.runningCardsFound} seePriceInCartSkipped=${out.seePriceInCartSkipped}`
    );
  }

  const deals = uniqByKey(allDeals, (d) => d.listingURL || d.listingName).slice(0, MAX_ITEMS_TOTAL);
  const scrapeDurationMs = msSince(startedAt);

  console.log(
    `[${runId}] DSG scrapeAll: runningCardsFoundTotal=${runningCardsFoundTotal} extractedDealsTotal=${deals.length} seePriceInCartSkippedTotal=${seePriceInCartSkippedTotal} durationMs=${scrapeDurationMs}`
  );

  return {
    store: STORE,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated: nowIso(),
    via: "firecrawl",

    sourceUrls,
    pagesFetched: pagesFetchedTotal,

    // ✅ FIXED METRICS:
    // dealsFound = all running shoe cards found (even if skipped)
    dealsFound: runningCardsFoundTotal,

    // dealsExtracted = deals that passed rules and were returned in deals[]
    dealsExtracted: deals.length,

    // ✅ NEW: explicit skipped count for hidden pricing
    seePriceInCartSkipped: seePriceInCartSkippedTotal,

    // optional: helps you explain gaps fast
    missingPriceSkipped: missingPriceSkippedTotal,
    missingImageSkipped: missingImageSkippedTotal,

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

  // ✅ OPTIONAL CRON SECRET (still commented)
  // const CRON_SECRET = String(process.env.CRON_SECRET || "").trim();
  // if (!CRON_SECRET) {
  //   return res.status(500).json({ ok: false, error: "CRON_SECRET not configured" });
  // }
  // const provided = String(req.headers["x-cron-secret"] || req.query?.key || "").trim();
  // if (provided !== CRON_SECRET) {
  //   return res.status(401).json({ ok: false, error: "Unauthorized" });
  // }

  console.log(`[${runId}] DSG handler start ${nowIso()}`);
  console.log(`[${runId}] method=${req.method} path=${req.url || ""}`);
  console.log(
    `[${runId}] env: hasBlobToken=${Boolean(process.env.BLOB_READ_WRITE_TOKEN)} hasFirecrawlKey=${Boolean(
      process.env.FIRECRAWL_API_KEY
    )} node=${process.version}`
  );

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
