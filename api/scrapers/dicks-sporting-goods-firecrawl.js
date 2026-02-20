// /api/scrapers/dicks-firecrawl.js  (CommonJS)
//
// Hit this route manually to test:
//   /api/scrapers/dicks-firecrawl
// (If you want to keep your normal auth pattern later, you can pass ?key=YOUR_CRON_SECRET
//  and uncomment the CRON secret block below.)
//
// Purpose:
// - Fetch Dick's Sporting Goods men's + women's sale running pages via Firecrawl
// - Follow pagination (Next page) per source
// - Extract canonical deals with optional range fields (imageURL included)
// - STRICT running filter:
//    * "trail running shoes" => shoeType "trail"
//    * "running shoes"       => shoeType "road"
//    * otherwise EXCLUDE (non-running shoes appear even with filters)
// - Handle "See Price In Cart":
//    * If card says price-in-cart, attempt to fetch product page via Firecrawl and extract price there
//    * If sale price still can't be found => EXCLUDE the deal
// - Prices can have multiple sale + original values; support range fields.
//
// Env vars required:
//   FIRECRAWL_API_KEY
//   BLOB_READ_WRITE_TOKEN
// Optional (for later):
//   CRON_SECRET   (commented out for testing)
//
// Output blob:
//   dicks-sporting-goods.json   (you said "/dicks-sporting-goods.json" — in Vercel Blob, use pathname without leading slash)

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
const MAX_PAGES_PER_SOURCE = 12; // safety cap
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

// Your rule:
// - "trail running shoes" => trail
// - "running shoes" => road
// - otherwise exclude
function detectShoeTypeStrict(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (s.includes("trail running shoes")) return "trail";
  if (s.includes("running shoes")) return "road";
  return null; // means EXCLUDE
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
  // From your outerHTML: <img itemprop="image" ... src="https://dks.scene7.com/...">
  const $img = $card.find('img[itemprop="image"]').first();
  if (!$img.length) return null;

  const src =
    $img.attr("src") || $img.attr("data-src") || $img.attr("data-original") || null;
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

  // Handle a few common multi-word brand prefixes
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
    .find((b) => raw.toLowerCase().startsWith(b.toLowerCase() + " ") || raw.toLowerCase() === b.toLowerCase());

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
  let json;

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
// PRODUCT PAGE PRICE (for "See Price In Cart")
// -----------------------------
function tryParseJsonLdOffersPrices($) {
  const out = { saleValues: [], originalValues: [] };

  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    if (!txt) return;

    let obj;
    try {
      obj = JSON.parse(txt);
    } catch {
      return;
    }

    const nodes = Array.isArray(obj) ? obj : [obj];

    for (const node of nodes) {
      // offers can be object or array; price can be string/number; can include lowPrice/highPrice
      const offers = node?.offers;
      const offerArr = Array.isArray(offers) ? offers : offers ? [offers] : [];

      for (const o of offerArr) {
        const price = o?.price ?? o?.lowPrice ?? null;
        const highPrice = o?.highPrice ?? null;
        const listPrice = o?.priceSpecification?.price ?? null; // sometimes
        const n1 = parseMoney(price);
        const n2 = parseMoney(highPrice);
        const n3 = parseMoney(listPrice);

        if (n1 != null) out.saleValues.push(n1);
        if (n2 != null) out.saleValues.push(n2);

        // Some JSON-LD uses priceSpecification with type "ListPrice"
        // We can't reliably distinguish sale vs list without more structure, so we also collect all money-like values.
        if (n3 != null) out.originalValues.push(n3);
      }
    }
  });

  // De-dupe + sort
  out.saleValues = Array.from(new Set(out.saleValues.map((x) => Number(x.toFixed(2))))).sort((a, b) => a - b);
  out.originalValues = Array.from(new Set(out.originalValues.map((x) => Number(x.toFixed(2))))).sort((a, b) => a - b);

  return out;
}

function tryRegexPricesFromHtml(html) {
  // Last-resort: try a few common keys found in embedded JSON blobs.
  // We keep this conservative: only accept plausible prices ($10-$1000).
  const vals = [];

  const patterns = [
    /"finalPrice"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/gi,
    /"salePrice"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/gi,
    /"currentPrice"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/gi,
    /"listPrice"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/gi,
    /"originalPrice"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/gi,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 10 && n <= 1000) vals.push(Number(n.toFixed(2)));
      if (vals.length > 50) break;
    }
    if (vals.length > 50) break;
  }

  const uniq = Array.from(new Set(vals)).sort((a, b) => a - b);
  return uniq;
}

async function resolvePriceInCartByProductPage(listingURL, runId) {
  // returns { saleValues: number[], originalValues: number[] }
  try {
    const html = await fetchHtmlViaFirecrawl(listingURL, runId, "DSG-PDP");
    const $ = cheerio.load(html);

    // Try JSON-LD first (cleanest)
    const fromLd = tryParseJsonLdOffersPrices($);

    // Also try visible DOM cues
    // We collect all money-like values from typical price areas; keep separate buckets by best guess.
    const domSale = collectMoneyValues(
      $,
      $('[class*="price"], [data-test*="price"], [data-testid*="price"], [itemprop="price"]').find("*")
    );
    const regexVals = tryRegexPricesFromHtml(html);

    const all = Array.from(new Set([...(fromLd.saleValues || []), ...(domSale || []), ...(regexVals || [])]))
      .map((x) => Number(x.toFixed(2)))
      .sort((a, b) => a - b);

    // Heuristic:
    // - If we find 2+ distinct values, treat lowest as sale candidates and highest as original candidates
    // - If only 1 value, treat it as sale candidate; original unknown (caller may exclude)
    const saleValues = all.length ? [all[0]] : [];
    const originalValues = all.length >= 2 ? [all[all.length - 1]] : [];

    return { saleValues, originalValues };
  } catch (e) {
    console.log(`[${runId}] DSG-PDP price-in-cart fetch failed for ${listingURL}: ${String(e?.message || e)}`);
    return { saleValues: [], originalValues: [] };
  }
}


// -----------------------------
// PARSE / EXTRACT
// -----------------------------
async function extractDealsFromHtml(html, runId, sourceKey) {
  const t0 = Date.now();
  const $ = cheerio.load(html);
  const deals = [];

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
    if (!shoeType) {
      // strict running-only filter
      continue;
    }

    const href = $title.attr("href") || null;
    const listingURL = absUrl(href);
    if (!listingURL) continue;

    // Image URL
    const imageURL = getImageUrlFromCard($card);
    if (!imageURL) continue;

    // Price in card (when available)
    const saleEls = $card.find(".price-sale, .hmf-body-bold-l.price-sale, [class*='price-sale']");
    const origEls = $card.find(".hmf-text-decoration-linethrough, [class*='linethrough'], [class*='strike']");

    let saleValues = collectMoneyValues($, saleEls);
    let originalValues = collectMoneyValues($, origEls);

    // Some cards embed pricing in aria-label:
    // aria-label="..., New Lower Price: $135.97 , Previous Price: $169.99, ..."
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
        // assume lowest is sale, highest is original
        saleValues = saleValues.length ? saleValues : [uniq[0]];
        originalValues = originalValues.length ? originalValues : [uniq[uniq.length - 1]];
      }
    }

    // Price-in-cart handling
    const { seePriceInCart } = extractPriceSignalsFromCardText($card);

    if (seePriceInCart) {
      // We must find sale price elsewhere, or exclude.
      const resolved = await resolvePriceInCartByProductPage(listingURL, runId);

      // Merge any found values (dedupe)
      saleValues = Array.from(new Set([...(saleValues || []), ...(resolved.saleValues || [])]))
        .map((x) => Number(x.toFixed(2)))
        .sort((a, b) => a - b);

      originalValues = Array.from(new Set([...(originalValues || []), ...(resolved.originalValues || [])]))
        .map((x) => Number(x.toFixed(2)))
        .sort((a, b) => a - b);

      if (!saleValues.length) {
        // per your requirement: exclude if sale can't be found for "price in cart"
        continue;
      }
      // If original is still missing, we exclude because your pipeline requires both.
      if (!originalValues.length) continue;
    }

    // Require BOTH (as in your Kohls rules)
    if (!saleValues.length || !originalValues.length) continue;

    const saleLow = saleValues[0];
    const saleHigh = saleValues[saleValues.length - 1];
    const origLow = originalValues[0];
    const origHigh = originalValues[originalValues.length - 1];

    if (!(saleLow > 0) || !(origLow > 0)) continue;

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

    const gender = detectGenderFromTitle(listingName) !== "unknown"
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
    `[${runId}] DSG parse ${sourceKey}: extracted=${deals.length} deduped=${deduped.length} time=${msSince(t0)}ms`
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
  } else {
    console.log(`[${runId}] DSG sample ${sourceKey}: none`);
  }

  return deduped;
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

    const deals = await extractDealsFromHtml(html, runId, src.key);
    sourceDeals.push(...deals);

    console.log(
      `[${runId}] DSG ${src.key} page ${pageNumber + 1} done: deals=${deals.length}`
    );
  }

  return {
    deals: uniqByKey(sourceDeals, (d) => d.listingURL || d.listingName),
    pagesFetched,
    sourceUrlsVisited: visited,
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

  for (const src of SOURCES) {
    console.log(`[${runId}] DSG source start: ${src.key}`);
    const out = await scrapeSourceWithPagination(runId, src);
    allDeals.push(...out.deals);
    pagesFetchedTotal += out.pagesFetched;
    sourceUrls.push(...out.sourceUrlsVisited);
    console.log(
      `[${runId}] DSG source done: ${src.key} deals=${out.deals.length} pagesFetched=${out.pagesFetched}`
    );
  }

  const deals = uniqByKey(allDeals, (d) => d.listingURL || d.listingName).slice(0, MAX_ITEMS_TOTAL);
  const scrapeDurationMs = msSince(startedAt);

  console.log(
    `[${runId}] DSG scrapeAll: totalBeforeDedupe=${allDeals.length} totalAfterDedupe=${deals.length} durationMs=${scrapeDurationMs}`
  );

  return {
    store: STORE,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated: nowIso(),
    via: "firecrawl",

    sourceUrls,
    pagesFetched: pagesFetchedTotal,

    dealsFound: allDeals.length,
    dealsExtracted: deals.length,

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

  // ✅ OPTIONAL CRON SECRET (COMMENTED OUT FOR TESTING AS REQUESTED)
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
      `[${runId}] DSG blob write start: ${BLOB_PATHNAME} dealsExtracted=${data.dealsExtracted}`
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
      dealsExtracted: data.dealsExtracted,
      dealsFound: data.dealsFound,
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
