// /api/scrapers/dicks-firecrawl.js  (CommonJS)
//
// Purpose:
// - Fetch Dick's Sporting Goods men's + women's sale running pages via Firecrawl
// - Follow pagination (pageNumber param) per source (MAX_PAGES_PER_SOURCE = 4)
// - Extract canonical deals with optional range fields
// - STRICT running filter:
//    * "trail running shoes" => shoeType "trail"
//    * "running shoes"       => shoeType "road"
//    * otherwise EXCLUDE
// - TEMP: Skip "See Price In Cart" items to avoid timeouts
//   * BUT count them in metadata (seePriceInCartSkipped)
// - FIX: dealsFound counts ALL strict-running cards (including skipped)
// - FIX: price ranges are captured from the price container text
// - FIX: page number loop corrected — DSG uses 1-based pageNumber param;
//        omitting param = page 1, so loop now runs 1..MAX_PAGES_PER_SOURCE
//        and withPageNumber drops the param for page 1, sets it for pages 2+
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
// No fixed page limit — scraper stops automatically when:
//   1. A page returns 0 product cards (end of catalogue)
//   2. A page returns 0 new deals not already seen (pure duplicate page)
//   3. The same page fingerprint repeats (DSG looping on last page)
//   4. MAX_PAGES_SAFETY_CEILING is hit (absolute backstop against infinite loops)
const MAX_PAGES_SAFETY_CEILING = 8;
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

// Classify shoe type from title. Returns a shoeType string for ALL shoes —
// never returns null (nothing is excluded based on type).
//   "trail running shoes" / "trail running"  => "trail"
//   "road running shoes" / "road running"    => "road"
//   "track" / "spike"                        => "track"
//   anything else with "running"             => "road"  (default for running)
//   otherwise                                => "unknown"
function detectShoeType(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (s.includes("trail running")) return "trail";
  if (s.includes("road running")) return "road";
  if (s.includes("track") || s.includes("spike")) return "track";
  if (s.includes("running")) return "road";
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

// Derive the product image URL directly from the SKU embedded in the listing URL.
// DSG listing URLs follow: /p/some-slug-SKUCODE/SKUCODE?categoryId=...&color=...
// The SKU is the LAST segment of the pathname (before the query string).
// Using URL().pathname avoids the regex-on-full-string bug where color params
// like "color=Crimson/Coral" would cause the wrong segment to be extracted.
// Image CDN pattern: https://dks.scene7.com/is/image/dkscdn/SKUCODE_is/
function getImageUrlFromListingUrl(listingUrl) {
  if (!listingUrl) return null;
  try {
    const u = new URL(listingUrl);
    // pathname: /p/nike-mens-pegasus-41-running-shoes-24nikmpgss41vltccrnn/24nikmpgss41vltccrnn
    const segments = u.pathname.split("/").filter(Boolean);
    const sku = segments[segments.length - 1];
    if (!sku || sku.length < 6) return null;
    return `https://dks.scene7.com/is/image/dkscdn/${sku}_is/?wid=252&hei=252&qlt=85,0&fmt=jpg&op_sharpen=1`;
  } catch {
    return null;
  }
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

// Parse sale/original price values directly from the container text.
// Works with DSG's DOM:
//   <div class="price-sale"> $63.97 <span> - $122.97 </span></div>
//   <div class="hmf-text-decoration-linethrough"> $139.99 <span> - $144.99 </span> *</div>
function extractSaleAndOriginalValuesFromCard($card) {
  const saleText = $card.find(".price-sale, [class*='price-sale']").first().text() || "";
  const origText = $card
    .find(".hmf-text-decoration-linethrough, [class*='linethrough'], [class*='strike']")
    .first()
    .text() || "";

  const saleVals = parseMoneyAll(saleText);
  const origVals = parseMoneyAll(origText);

  // normalize
  const saleValues = Array.from(new Set(saleVals.map((x) => Number(x.toFixed(2))))).sort((a, b) => a - b);
  const originalValues = Array.from(new Set(origVals.map((x) => Number(x.toFixed(2))))).sort((a, b) => a - b);

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

  let res;
  let json;

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
      waitFor: 5000,    // increased from 3500 to give slow pages more time to render
      timeout: 75000,   // increased from 60000
    }),
  });

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
// -----------------------------
async function extractDealsFromHtml(html, runId, sourceKey) {
  const t0 = Date.now();
  const $ = cheerio.load(html);

  const deals = [];

  let runningCardsFound = 0;
  let seePriceInCartSkipped = 0;
  let missingPriceSkipped = 0;
  let missingImageSkipped = 0;

  const $cards = $("div.product-card");
  console.log(`[${runId}] DSG parse ${sourceKey}: cardsFound=${$cards.length}`);

  for (let i = 0; i < $cards.length; i++) {
    const el = $cards.get(i);
    const $card = $(el);

    const $title = $card.find("a.product-title-link").first();
    const listingName = $title.text().replace(/\s+/g, " ").trim();
    if (!listingName) continue;

    const shoeType = detectShoeType(listingName);

    runningCardsFound++;

    const href = $title.attr("href") || null;
    const listingURL = absUrl(href);
    if (!listingURL) continue;

    // Derive image URL from the SKU in the listing URL — reliable, no lazy-load issues
    const imageURL = getImageUrlFromListingUrl(listingURL);
    if (!imageURL) {
      missingImageSkipped++;
      continue;
    }

    const { seePriceInCart } = extractPriceSignalsFromCardText($card);
    if (seePriceInCart) {
      seePriceInCartSkipped++;
      continue;
    }

    // Robust extraction from the actual price containers
    let { saleValues, originalValues, saleText, origText } = extractSaleAndOriginalValuesFromCard($card);

    // aria-label fallback (e.g. "New Lower Price: $63.97 to $122.97 , Previous Price: $139.99 to $144.99")
    if (!saleValues.length || !originalValues.length) {
      const aria = $title.attr("aria-label") || "";
      const nums = parseMoneyAll(aria).map((x) => Number(x.toFixed(2)));
      const uniq = Array.from(new Set(nums)).sort((a, b) => a - b);

      // heuristic: first two likely sale range, last two likely original range
      // if we only got 2 total, use low as sale and high as original
      if (uniq.length >= 4) {
        if (!saleValues.length) saleValues = [uniq[0], uniq[1]];
        if (!originalValues.length) originalValues = [uniq[uniq.length - 2], uniq[uniq.length - 1]];
      } else if (uniq.length >= 2) {
        if (!saleValues.length) saleValues = [uniq[0]];
        if (!originalValues.length) originalValues = [uniq[uniq.length - 1]];
      }
    }

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

  return {
    deals: deduped,
    runningCardsFound,
    seePriceInCartSkipped,
    missingPriceSkipped,
    missingImageSkipped,
  };
}

// -----------------------------
// PAGINATION (pageNumber param)
// -----------------------------
// DSG uses 1-based page numbers. Omitting the param = page 1.
// Setting pageNumber=1 also = page 1 (duplicate). So:
//   page 1  => no pageNumber param
//   page 2  => pageNumber=2
//   page 3  => pageNumber=3
function withPageNumber(baseUrl, pageNumber) {
  const u = new URL(baseUrl);
  if (pageNumber <= 1) {
    u.searchParams.delete("pageNumber");
  } else {
    u.searchParams.set("pageNumber", String(pageNumber));
  }
  return u.toString();
}

// -----------------------------
// SCRAPE SOURCE
// -----------------------------
async function scrapeSourceWithPagination(runId, src) {
  const sourceDeals = [];
  const visited = [];
  let pagesFetched = 0;

  let runningCardsFound = 0;
  let seePriceInCartSkipped = 0;
  let missingPriceSkipped = 0;
  let missingImageSkipped = 0;

  // Seen URL sets for duplicate/loop detection
  const seenListingUrls = new Set();   // all URLs scraped so far across pages
  let lastPageFingerprint = null;      // fingerprint of the previous page's URL set

  for (let pageNumber = 1; pageNumber <= MAX_PAGES_SAFETY_CEILING; pageNumber++) {
    const pageUrl = withPageNumber(src.url, pageNumber);
    visited.push(pageUrl);
    pagesFetched++;

    console.log(`[${runId}] DSG ${src.key} page ${pageNumber} start: ${pageUrl}`);

    // Small delay between pages (except the first) to prevent Firecrawl
    // from returning a cached copy of the previous page
    if (pageNumber > 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    let html;
    try {
      html = await fetchHtmlViaFirecrawl(pageUrl, runId, `DSG-${src.key}`);
    } catch (err) {
      console.error(`[${runId}] DSG ${src.key} page ${pageNumber} fetch error:`, err.message);
      // Don't crash the whole run — stop this source and move on
      break;
    }

    const $ = cheerio.load(html);
    const cardCount = $("div.product-card").length;
    console.log(`[${runId}] DSG ${src.key} page ${pageNumber} cardsFound=${cardCount}`);

    // Stop condition 1: no cards at all — end of catalogue
    if (!cardCount) {
      console.log(`[${runId}] DSG ${src.key} stop: no cards on page ${pageNumber}`);
      break;
    }

    // Build a fingerprint from ALL product-title-link hrefs on this page
    // (not just priced deals) so we can detect when DSG loops on the last page.
    // Must happen BEFORE extractDealsFromHtml so it uses the raw card set.
    const pageUrls = [];
    $("a.product-title-link").each((_, el) => {
      const href = $(el).attr("href");
      if (href) pageUrls.push(href.split("?")[0]); // strip query string for stable fingerprint
    });
    pageUrls.sort();
    const pageFingerprint = pageUrls.join("|");

    // Stop condition 3: same page returned twice in a row — DSG is looping on last page
    if (pageFingerprint && pageFingerprint === lastPageFingerprint) {
      console.log(`[${runId}] DSG ${src.key} stop: duplicate page fingerprint on page ${pageNumber} — DSG looping`);
      break;
    }
    lastPageFingerprint = pageFingerprint;

    const parsed = await extractDealsFromHtml(html, runId, src.key);
    const pageDeals = parsed.deals || [];

    // Stop condition 2: count how many deals on this page are genuinely new.
    // Note: we only check priced deals here (seePriceInCart items are excluded).
    // A page with cards but 0 priced deals is still valid (all MAP-protected) —
    // only stop if we HAD priced deals last time and now have zero new ones.
    const newDeals = pageDeals.filter((d) => {
      const key = d.listingURL || d.listingName;
      return key && !seenListingUrls.has(key);
    });

    if (pageDeals.length > 0 && newDeals.length === 0) {
      console.log(`[${runId}] DSG ${src.key} stop: page ${pageNumber} had ${pageDeals.length} deals but 0 new — pure duplicate`);
      break;
    }

    // Track ALL card URLs as seen (using raw hrefs) so the duplicate-deal check
    // works correctly on subsequent pages regardless of pricing status
    $("a.product-title-link").each((_, el) => {
      const href = $(el).attr("href");
      if (href) seenListingUrls.add(href.split("?")[0]);
    });

    sourceDeals.push(...pageDeals);

    runningCardsFound += parsed.runningCardsFound || 0;
    seePriceInCartSkipped += parsed.seePriceInCartSkipped || 0;
    missingPriceSkipped += parsed.missingPriceSkipped || 0;
    missingImageSkipped += parsed.missingImageSkipped || 0;

    console.log(`[${runId}] DSG ${src.key} page ${pageNumber} newDeals=${newDeals.length} totalSoFar=${sourceDeals.length}`);
  }

  return {
    deals: uniqByKey(sourceDeals, (d) => d.listingURL || d.listingName),
    pagesFetched,
    sourceUrlsVisited: visited,

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

  return {
    store: STORE,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated: nowIso(),
    via: "firecrawl",

    sourceUrls,
    pagesFetched: pagesFetchedTotal,

    dealsFound: runningCardsFoundTotal, // all strict-running cards (including skipped)
    dealsExtracted: deals.length,       // priced deals only (single price or range)

    seePriceInCartSkipped: seePriceInCartSkippedTotal,

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
