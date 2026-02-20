// /api/merge-deals.js
//
// Merges sources into canonical deals.json.
//
// IMPORTANT RULE (per your requirement):
// - merge-deals NEVER scrapes.
// - It ONLY fetches pre-scraped JSON from blob URLs provided via env vars.
//
// Canonical legacy 11 fields (kept):
//   listingName, brand, model, salePrice, originalPrice, discountPercent,
//   store, listingURL, imageURL, gender, shoeType
//
// Added OPTIONAL fields (new):
//   salePriceLow, salePriceHigh, originalPriceLow, originalPriceHigh, discountPercentUpTo
//
// HONESTY RULES:
// - A deal is included ONLY if it has BOTH sale pricing AND original pricing,
//   either as single prices or as ranges.
// - discountPercent is EXACT-ONLY:
//   * if salePrice AND originalPrice are both single numbers -> discountPercent = exact %
//   * if any range is involved -> discountPercent = null
// - discountPercentUpTo is RANGE-ONLY:
//   * if any range is involved -> discountPercentUpTo = "up to" %
//     computed as (originalHigh - saleLow) / originalHigh
//
// Also: legacy salePrice/originalPrice remain populated where possible.
// For range cases we set:
//   salePrice    = salePriceLow
//   originalPrice= originalPriceLow
// so your existing pipeline still has a single-number anchor,
// but UI should prefer the range fields when present.

const axios = require("axios");
const { put } = require("@vercel/blob");
const { assertDealSchema } = require("../lib/dealSchema");

/** ------------ Utilities ------------ **/

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function extractDealsFromPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload.deals)) return payload.deals;
  if (Array.isArray(payload.items)) return payload.items;

  if (payload.output && Array.isArray(payload.output.deals)) return payload.output.deals;
  if (payload.data && Array.isArray(payload.data.deals)) return payload.data.deals;

  return [];
}

function toNumber(x) {
  if (x == null) return null;
  const n = typeof x === "string" ? parseFloat(String(x).replace(/,/g, "")) : x;
  return Number.isFinite(n) ? n : null;
}

function parseDurationMs(dur) {
  if (dur == null) return null;
  if (typeof dur === "number" && Number.isFinite(dur)) return dur;

  const s = String(dur).trim();
  if (!s) return null;

  let m = s.match(/^(\d+(?:\.\d+)?)\s*ms$/i);
  if (m) return Math.round(parseFloat(m[1]));

  m = s.match(/^(\d+(?:\.\d+)?)\s*s$/i);
  if (m) return Math.round(parseFloat(m[1]) * 1000);

  m = s.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (m) {
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const ss = parseFloat(m[3]);
    if (Number.isFinite(hh) && Number.isFinite(mm) && Number.isFinite(ss)) {
      return Math.round(hh * 3600000 + mm * 60000 + ss * 1000);
    }
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** ------------ Freshness helpers ------------ **/

function parseTimestampMs(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function ageMsFromTimestamp(ts, nowMs = Date.now()) {
  const ms = parseTimestampMs(ts);
  if (ms == null) return null;
  return nowMs - ms;
}

function isOlderThanDays(ts, days, nowMs = Date.now()) {
  const age = ageMsFromTimestamp(ts, nowMs);
  if (age == null) return false; // unknown age => do NOT exclude by default
  return age > days * 24 * 60 * 60 * 1000;
}

function formatAgeDays(ts, nowMs = Date.now()) {
  const age = ageMsFromTimestamp(ts, nowMs);
  if (age == null) return null;
  return Math.round((age / (24 * 60 * 60 * 1000)) * 10) / 10; // 1 decimal
}

// NEW: freshness boolean (<= N hours old)
function isFreshWithinHours(ts, hours, nowMs = Date.now()) {
  const age = ageMsFromTimestamp(ts, nowMs);
  if (age == null) return false; // no timestamp => treat as NOT fresh
  return age <= hours * 60 * 60 * 1000;
}

/** ------------ Price range helpers ------------ **/

function normalizePriceShapes(raw) {
  const salePrice = toNumber(raw?.salePrice ?? raw?.currentPrice ?? raw?.sale_price ?? raw?.price ?? null);
  const originalPrice = toNumber(
    raw?.originalPrice ??
      raw?.original_price ??
      raw?.compareAtPrice ??
      raw?.compare_at_price ??
      raw?.msrp ??
      raw?.listPrice ??
      raw?.wasPrice ??
      null
  );

  let saleLow = toNumber(raw?.salePriceLow ?? raw?.sale_low ?? raw?.saleMin ?? raw?.saleMinPrice ?? null);
  let saleHigh = toNumber(raw?.salePriceHigh ?? raw?.sale_high ?? raw?.saleMax ?? raw?.saleMaxPrice ?? null);

  let origLow = toNumber(raw?.originalPriceLow ?? raw?.original_low ?? raw?.origMin ?? raw?.origMinPrice ?? null);
  let origHigh = toNumber(raw?.originalPriceHigh ?? raw?.original_high ?? raw?.origMax ?? raw?.origMaxPrice ?? null);

  if ((saleLow == null) !== (saleHigh == null)) {
    saleLow = null;
    saleHigh = null;
  }
  if ((origLow == null) !== (origHigh == null)) {
    origLow = null;
    origHigh = null;
  }

  if (saleLow != null && saleHigh != null && saleLow > saleHigh) {
    const tmp = saleLow;
    saleLow = saleHigh;
    saleHigh = tmp;
  }
  if (origLow != null && origHigh != null && origLow > origHigh) {
    const tmp = origLow;
    origLow = origHigh;
    origHigh = tmp;
  }

  if (saleLow != null && saleHigh != null && (saleLow <= 0 || saleHigh <= 0)) {
    saleLow = null;
    saleHigh = null;
  }
  if (origLow != null && origHigh != null && (origLow <= 0 || origHigh <= 0)) {
    origLow = null;
    origHigh = null;
  }

  return {
    salePrice: Number.isFinite(salePrice) ? salePrice : null,
    originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
    salePriceLow: saleLow,
    salePriceHigh: saleHigh,
    originalPriceLow: origLow,
    originalPriceHigh: origHigh,
  };
}

function hasSalePriceShape(d) {
  const sp = toNumber(d?.salePrice);
  const lo = toNumber(d?.salePriceLow);
  const hi = toNumber(d?.salePriceHigh);
  return Number.isFinite(sp) || (Number.isFinite(lo) && Number.isFinite(hi));
}

function hasOriginalPriceShape(d) {
  const op = toNumber(d?.originalPrice);
  const lo = toNumber(d?.originalPriceLow);
  const hi = toNumber(d?.originalPriceHigh);
  return Number.isFinite(op) || (Number.isFinite(lo) && Number.isFinite(hi));
}

function computeDiscountPercentExact(deal) {
  const sale = toNumber(deal?.salePrice);
  const orig = toNumber(deal?.originalPrice);

  if (!Number.isFinite(sale) || !Number.isFinite(orig)) return null;
  if (orig <= 0) return null;
  if (sale >= orig) return null;

  const pct = ((orig - sale) / orig) * 100;
  if (!Number.isFinite(pct)) return null;

  const rounded = Math.round(pct);
  if (rounded < 0) return null;
  if (rounded > 95) return 95;
  return rounded;
}

function computeDiscountPercentUpTo(deal) {
  const saleLow = toNumber(deal?.salePriceLow) ?? toNumber(deal?.salePrice);
  const origHigh = toNumber(deal?.originalPriceHigh) ?? toNumber(deal?.originalPrice);

  if (!Number.isFinite(saleLow) || !Number.isFinite(origHigh) || origHigh <= 0) return null;
  if (saleLow >= origHigh) return null;

  const pct = ((origHigh - saleLow) / origHigh) * 100;
  if (!Number.isFinite(pct)) return null;

  const rounded = Math.round(pct);
  if (rounded < 0) return null;
  if (rounded > 95) return 95;
  return rounded;
}

function computeDollarSavings(deal) {
  const exactOrig = toNumber(deal?.originalPrice);
  const exactSale = toNumber(deal?.salePrice);

  if (Number.isFinite(exactOrig) && Number.isFinite(exactSale) && exactOrig > exactSale) {
    return exactOrig - exactSale;
  }

  const origHigh = toNumber(deal?.originalPriceHigh) ?? exactOrig;
  const saleLow = toNumber(deal?.salePriceLow) ?? exactSale;

  if (!Number.isFinite(origHigh) || !Number.isFinite(saleLow) || origHigh <= saleLow) return 0;
  return origHigh - saleLow;
}

/** ------------ Theme-change-resistant sanitization ------------ **/

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function stripHtmlToText(maybeHtml) {
  const s = String(maybeHtml || "");
  if (!s) return "";
  if (!/[<>]/.test(s)) return normalizeWhitespace(s);
  return normalizeWhitespace(s.replace(/<[^>]*>/g, " "));
}

function looksLikeCssOrJunk(s) {
  const t = normalizeWhitespace(s);
  if (!t) return true;
  if (t.length < 3) return true;
  if (/^#[-_a-z0-9]+/i.test(t)) return true;
  if (t.includes("{") && t.includes("}") && t.includes(":")) return true;
  if (t.startsWith("@media") || t.startsWith(":root")) return true;
  return false;
}

function cleanTitleText(raw) {
  let t = stripHtmlToText(raw);
  t = t.replace(/^(extra\s*\d+\s*%\s*off)\s+/i, "");
  t = t.replace(/^(sale|clearance|closeout)\s+/i, "");
  t = normalizeWhitespace(t);
  if (looksLikeCssOrJunk(t)) return "";
  return t;
}

function cleanLooseText(raw) {
  return normalizeWhitespace(stripHtmlToText(raw));
}

function absolutizeUrl(u, base) {
  let url = String(u || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return base.replace(/\/+$/, "") + url;
  return base.replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
}

function storeBaseUrl(store) {
  const s = String(store || "").toLowerCase();

  if (s === "als") return "https://www.als.com";
  if (s.includes("asics")) return "https://www.asics.com";
  if (s.includes("brooks")) return "https://www.brooksrunning.com";
  if (s.includes("finish line") || s.includes("finishline")) return "https://www.finishline.com";
  if (s.includes("fleet feet")) return "https://www.fleetfeet.com";
  if (s.includes("foot locker") || s.includes("footlocker")) return "https://www.footlocker.com";
  if (s.includes("holabird")) return "https://www.holabirdsports.com";
  if (s.includes("hoka")) return "https://www.hoka.com";
  if (s.includes("kohls") || s.includes("kohl's")) return "https://www.kohls.com";
  if (s.includes("luke")) return "https://lukeslocker.com";
  if (s.includes("marathon sports")) return "https://www.marathonsports.com";
  if (s === "rei") return "https://www.rei.com";
  if (s.includes("mizuno")) return "https://usa.mizuno.com";
  if (s.includes("rei outlet")) return "https://www.rei.com/rei-garage";
  if (s.includes("rei")) return "https://www.rei.com";
  if (s.includes("road runner")) return "https://www.roadrunnersports.com";
  if (s.includes("rnj")) return "https://www.rnjsports.com";
  if (s.includes("running warehouse")) return "https://www.runningwarehouse.com";
  if (s.includes("shoebacca")) return "https://www.shoebacca.com";
  if (s.includes("track shack") || s.includes("trackshack")) return "https://shop.trackshack.com";
  if (s.includes("zappos")) return "https://www.zappos.com";
  return "https://example.com";
}

function sanitizeDeal(raw) {
  if (!raw) return null;

  const store = raw.store || raw.retailer || raw.site || "Unknown";
  const base = storeBaseUrl(store);

  const listingNameRaw = raw.listingName ?? raw.listing ?? raw.title ?? raw.name ?? "";
  const brandRaw = raw.brand ?? raw.vendor ?? "";
  const modelRaw = raw.model ?? "";

  const listingName = cleanTitleText(listingNameRaw);
  const brand = cleanLooseText(brandRaw) || "Unknown";
  const model = cleanLooseText(modelRaw) || "";

  let listingURL = String(raw.listingURL ?? raw.listingUrl ?? raw.url ?? raw.href ?? "").trim();
  if (listingURL) listingURL = absolutizeUrl(listingURL, base);

  let imageURL = null;
  const imgCandidate = raw.imageURL ?? raw.imageUrl ?? raw.image ?? raw.img ?? raw.thumbnail ?? null;
  if (typeof imgCandidate === "string" && imgCandidate.trim()) {
    imageURL = absolutizeUrl(imgCandidate.trim(), base);
  }

  const gender = typeof raw.gender === "string" ? raw.gender.trim() : "unknown";
  const shoeType = typeof raw.shoeType === "string" ? raw.shoeType.trim() : "unknown";

  const priceShape = normalizePriceShapes(raw);

  const legacySale = priceShape.salePrice != null ? priceShape.salePrice : priceShape.salePriceLow;
  const legacyOrig = priceShape.originalPrice != null ? priceShape.originalPrice : priceShape.originalPriceLow;

  const safeListingName = listingName || normalizeWhitespace(`${brand} ${model}`) || "Running Shoe";
  const safeName = looksLikeCssOrJunk(safeListingName) ? "" : safeListingName;

  const canonical = {
    listingName: safeName,
    brand: brand || "Unknown",
    model: model || "",
    salePrice: Number.isFinite(legacySale) ? legacySale : null,
    originalPrice: Number.isFinite(legacyOrig) ? legacyOrig : null,

    discountPercent: null,
    discountPercentUpTo: null,

    store: typeof store === "string" ? store.trim() : "Unknown",
    listingURL: listingURL || "",
    imageURL: imageURL || null,
    gender,
    shoeType,

    salePriceLow: priceShape.salePriceLow,
    salePriceHigh: priceShape.salePriceHigh,
    originalPriceLow: priceShape.originalPriceLow,
    originalPriceHigh: priceShape.originalPriceHigh,
  };

  const anySaleRange =
    Number.isFinite(toNumber(canonical.salePriceLow)) && Number.isFinite(toNumber(canonical.salePriceHigh));
  const anyOrigRange =
    Number.isFinite(toNumber(canonical.originalPriceLow)) && Number.isFinite(toNumber(canonical.originalPriceHigh));
  const anyRangeInvolved = anySaleRange || anyOrigRange;

  if (!anyRangeInvolved) {
    canonical.discountPercent = computeDiscountPercentExact(canonical);
    canonical.discountPercentUpTo = null;
  } else {
    canonical.discountPercent = null;
    canonical.discountPercentUpTo = computeDiscountPercentUpTo(canonical);
  }

  return canonical;
}

function isValidRunningShoe(deal) {
  if (!deal) return false;

  const listingURL = String(deal.listingURL || "").trim();
  const listingName = String(deal.listingName || "").trim();
  if (!listingURL || !listingName) return false;

  if (!hasSalePriceShape(deal)) return false;
  if (!hasOriginalPriceShape(deal)) return false;

  const saleLow = toNumber(deal.salePriceLow) ?? toNumber(deal.salePrice);
  const origHigh = toNumber(deal.originalPriceHigh) ?? toNumber(deal.originalPrice);

  if (!Number.isFinite(saleLow) || !Number.isFinite(origHigh)) return false;
  if (saleLow >= origHigh) return false;

  if (saleLow < 10 || saleLow > 1000) return false;

  const exact = toNumber(deal.discountPercent);
  const upTo = toNumber(deal.discountPercentUpTo);
  const effective = Number.isFinite(exact) ? exact : Number.isFinite(upTo) ? upTo : null;

  if (!Number.isFinite(effective)) return false;
  if (effective < 5 || effective > 95) return false;

  const title = listingName.toLowerCase();

  const excludePatterns = [
    "sock",
    "socks",
    "apparel",
    "shirt",
    "shorts",
    "tights",
    "pants",
    "hat",
    "cap",
    "beanie",
    "insole",
    "insoles",
    "laces",
    "lace",
    "accessories",
    "accessory",
    "hydration",
    "bottle",
    "flask",
    "watch",
    "watches",
    "gear",
    "equipment",
    "bag",
    "bags",
    "pack",
    "backpack",
    "vest",
    "vests",
    "jacket",
    "jackets",
    "bra",
    "bras",
    "underwear",
    "brief",
    "glove",
    "gloves",
    "mitt",
    "compression sleeve",
    "arm warmer",
    "leg warmer",
    "headband",
    "wristband",
    "sunglasses",
    "eyewear",
    "sleeve",
    "sleeves",
    "throw",
    "throws",
    "yaktrax",
    "out of stock",
    "kids",
    "kid",
    "leggings",
    "youth",
    "junior",
    "juniors",
    "windbreaker",
  ];

  for (const pattern of excludePatterns) {
    const regex = new RegExp(`\\b${pattern}\\b`, "i");
    if (regex.test(title)) return false;
  }

  return true;
}

function normalizeDeal(d) {
  const c = sanitizeDeal(d);
  if (!c) return null;

  const saleLo = toNumber(c.salePriceLow);
  const saleHi = toNumber(c.salePriceHigh);
  const origLo = toNumber(c.originalPriceLow);
  const origHi = toNumber(c.originalPriceHigh);

  const saleRangeOk = (saleLo == null && saleHi == null) || (Number.isFinite(saleLo) && Number.isFinite(saleHi));
  const origRangeOk = (origLo == null && origHi == null) || (Number.isFinite(origLo) && Number.isFinite(origHi));

  return {
    listingName: typeof c.listingName === "string" ? c.listingName.trim() : "",
    brand: typeof c.brand === "string" ? c.brand.trim() : "Unknown",
    model: typeof c.model === "string" ? c.model.trim() : "",

    salePrice: toNumber(c.salePrice),
    originalPrice: toNumber(c.originalPrice),

    discountPercent: Number.isFinite(toNumber(c.discountPercent)) ? Math.round(toNumber(c.discountPercent)) : null,

    store: typeof c.store === "string" ? c.store.trim() : "Unknown",
    listingURL: typeof c.listingURL === "string" ? c.listingURL.trim() : "",
    imageURL: typeof c.imageURL === "string" ? c.imageURL.trim() : c.imageURL ?? null,
    gender: typeof c.gender === "string" ? c.gender.trim() : "unknown",
    shoeType: typeof c.shoeType === "string" ? c.shoeType.trim() : "unknown",

    salePriceLow: saleRangeOk ? saleLo : null,
    salePriceHigh: saleRangeOk ? saleHi : null,
    originalPriceLow: origRangeOk ? origLo : null,
    originalPriceHigh: origRangeOk ? origHi : null,

    discountPercentUpTo: Number.isFinite(toNumber(c.discountPercentUpTo))
      ? Math.round(toNumber(c.discountPercentUpTo))
      : null,
  };
}

function dedupeDeals(deals) {
  const unique = [];
  const seen = new Set();

  for (const d of deals) {
    if (!d) continue;

    const urlKey = (d.listingURL || "").trim();
    const storeKey = (d.store || "Unknown").trim();

    if (!urlKey) {
      unique.push(d);
      continue;
    }

    const key = `${storeKey}|${urlKey}`;
    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(d);
  }

  return unique;
}

/** ------------ -only fetch helpers CACHE BUSTER fetch fresh data ------------ **/

async function fetchJson(url) {
  try {
    // ✅ CACHE-BUST: force a fresh fetch from  CDN (prevents stale week-old JSON)
    const cacheBustedUrl = `${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}`;

    const resp = await axios.get(cacheBustedUrl, {
      timeout: 30000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json,text/plain,*/*",

        // ✅ Best-effort (some CDNs still ignore; cb param above is the real fix)
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });

    return resp.data;
  } catch (e) {
    throw new Error(`fetchJson failed for ${url}: ${e?.message || String(e)}`);
  }
}

async function loadDealsFromOnly({ name, Url }) {
  const metadata = {
    name,
    source: null,
    deals: [],
    Url: null,
    timestamp: null,
    duration: null,
    payloadMeta: null,
    error: null,
  };

  const u = String(Url || "").trim();
  if (!u) {
    metadata.source = "error";
    metadata.error = `Missing required env var / Url for ${name}`;
    return metadata;
  }

  try {
    const payload = await fetchJson(u);
    const deals = extractDealsFromPayload(payload);

    metadata.source = "";
    metadata.deals = deals;
    metadata.Url = u;

    // Support multiple timestamp field names
    metadata.timestamp = payload.lastUpdated || payload.timestamp || payload.scrapedAt || null;

    metadata.duration = payload.scrapeDurationMs ?? payload.duration ?? null;
    metadata.payloadMeta = payload;

    return metadata;
  } catch (e) {
    metadata.source = "error";
    metadata.error = e?.message || String(e);
    return metadata;
  }
}

/** ------------ Stats / Daily Deals / scraper-data ------------ **/

function bucketLabel(salePrice) {
  if (!Number.isFinite(salePrice)) return null;
  if (salePrice < 50) return "$0-50";
  if (salePrice < 75) return "$50-75";
  if (salePrice < 100) return "$75-100";
  if (salePrice < 125) return "$100-125";
  if (salePrice < 150) return "$125-150";
  return "$150+";
}

function dealSummary(deal) {
  if (!deal) return null;

  const exact = toNumber(deal.discountPercent);
  const upTo = toNumber(deal.discountPercentUpTo);
  const effectiveDiscount = Number.isFinite(exact) ? exact : Number.isFinite(upTo) ? upTo : null;

  return {
    listingName: deal.listingName || "",
    brand: deal.brand || "Unknown",
    model: deal.model || "",
    store: deal.store || "Unknown",
    listingURL: deal.listingURL || "",
    imageURL: deal.imageURL || null,

    salePrice: toNumber(deal.salePrice),
    originalPrice: toNumber(deal.originalPrice),

    salePriceLow: toNumber(deal.salePriceLow),
    salePriceHigh: toNumber(deal.salePriceHigh),
    originalPriceLow: toNumber(deal.originalPriceLow),
    originalPriceHigh: toNumber(deal.originalPriceHigh),

    discountPercent: Number.isFinite(exact) ? Math.round(exact) : null,
    discountPercentUpTo: Number.isFinite(upTo) ? Math.round(upTo) : null,
    discountEffective: Number.isFinite(effectiveDiscount) ? Math.round(effectiveDiscount) : null,

    dollarSavings: computeDollarSavings(deal),
    gender: deal.gender || "unknown",
    shoeType: deal.shoeType || "unknown",
  };
}

function computeStats(deals, storeMetadata) {
  const nowIsoStr = new Date().toISOString();

  const stores = Object.create(null);
  const brands = Object.create(null);
  const uniqueStoreSet = new Set();
  const uniqueBrandSet = new Set();

  let discountCount = 0;
  let discountSum = 0;

  let topPercent = null;
  let topDollar = null;
  let lowestPrice = null;
  let bestValue = null;

  const priceBuckets = {
    "$0-50": 0,
    "$50-75": 0,
    "$75-100": 0,
    "$100-125": 0,
    "$125-150": 0,
    "$150+": 0,
  };

  for (const d of safeArray(deals)) {
    const store = (d.store || "Unknown").trim() || "Unknown";
    const brandRaw = (d.brand || "").trim();
    const brand = brandRaw ? brandRaw : "Unknown";

    const saleLow = toNumber(d.salePriceLow) ?? toNumber(d.salePrice);
    uniqueStoreSet.add(store);
    uniqueBrandSet.add(brand);

    if (!stores[store]) {
      stores[store] = {
        store,
        count: 0,
        discountSum: 0,
        discountCount: 0,
        savingsSum: 0,
        unknownBrandCount: 0,
        missingImageCount: 0,
        missingUrlCount: 0,
        missingModelCount: 0,
        missingPriceCount: 0,
      };
    }

    const s = stores[store];
    s.count += 1;

    const brandIsUnknown = brand === "Unknown" || !brandRaw;
    if (brandIsUnknown) s.unknownBrandCount += 1;

    const img = typeof d.imageURL === "string" ? d.imageURL : "";
    if (!img || img.includes("placehold.co")) s.missingImageCount += 1;

    const url = typeof d.listingURL === "string" ? d.listingURL : "";
    if (!url || url === "#") s.missingUrlCount += 1;

    const model = typeof d.model === "string" ? d.model.trim() : "";
    if (!model) s.missingModelCount += 1;

    if (!Number.isFinite(saleLow) || saleLow <= 0) s.missingPriceCount += 1;

    const exact = toNumber(d.discountPercent);
    const upTo = toNumber(d.discountPercentUpTo);
    const percentOff = Number.isFinite(exact) ? exact : Number.isFinite(upTo) ? upTo : 0;

    const dollarSavings = computeDollarSavings(d);

    if (percentOff > 0) {
      s.discountSum += percentOff;
      s.discountCount += 1;
      s.savingsSum += dollarSavings;

      discountSum += percentOff;
      discountCount += 1;

      if (!topPercent || percentOff > topPercent.percentOff) topPercent = { deal: d, percentOff };
      if (!topDollar || dollarSavings > topDollar.dollarSavings) topDollar = { deal: d, dollarSavings };

      if (Number.isFinite(saleLow)) {
        if (!lowestPrice || saleLow < lowestPrice.salePrice) lowestPrice = { deal: d, salePrice: saleLow };
      }

      const valueScore = percentOff + dollarSavings * 0.5;
      if (!bestValue || valueScore > bestValue.valueScore) bestValue = { deal: d, valueScore };
    }

    if (Number.isFinite(saleLow) && saleLow > 0) {
      const label = bucketLabel(saleLow);
      if (label) priceBuckets[label] += 1;
    }

    if (!brands[brand]) {
      brands[brand] = {
        brand,
        count: 0,
        discountSum: 0,
        discountCount: 0,
        minPrice: Number.POSITIVE_INFINITY,
        maxPrice: 0,
      };
    }

    const b = brands[brand];
    b.count += 1;

    if (percentOff > 0) {
      b.discountSum += percentOff;
      b.discountCount += 1;
    }

    if (Number.isFinite(saleLow) && saleLow > 0) {
      b.minPrice = Math.min(b.minPrice, saleLow);
      b.maxPrice = Math.max(b.maxPrice, saleLow);
    }
  }

  for (const b of Object.values(brands)) {
    if (!Number.isFinite(b.minPrice)) b.minPrice = 0;
  }

  const storesTable = Object.values(stores)
    .map((s) => {
      const avgDiscount = s.discountCount ? s.discountSum / s.discountCount : 0;
      const avgSavings = s.discountCount ? s.savingsSum / s.discountCount : 0;
      const unknownPct = s.count ? (s.unknownBrandCount / s.count) * 100 : 0;

      let status = "healthy";
      const issues = [];

      if (s.count === 0) {
        status = "critical";
        issues.push("ZERO RESULTS");
      }

      if (unknownPct > 50) {
        status = "critical";
        issues.push(`${unknownPct.toFixed(0)}% Unknown Brands`);
      } else if (unknownPct > 20) {
        if (status !== "critical") status = "warning";
        issues.push(`${unknownPct.toFixed(0)}% Unknown Brands`);
      }

      const missingImagesPct = s.count ? (s.missingImageCount / s.count) * 100 : 0;
      if (missingImagesPct > 30) {
        if (status !== "critical") status = "warning";
        issues.push(`${missingImagesPct.toFixed(0)}% Missing Images`);
      }

      const missingUrlsPct = s.count ? (s.missingUrlCount / s.count) * 100 : 0;
      if (missingUrlsPct > 10) {
        if (status !== "critical") status = "warning";
        issues.push(`${missingUrlsPct.toFixed(0)}% Missing URLs`);
      }

      const missingModelsPct = s.count ? (s.missingModelCount / s.count) * 100 : 0;
      if (missingModelsPct > 30) {
        if (status !== "critical") status = "warning";
        issues.push(`${missingModelsPct.toFixed(0)}% Missing Models`);
      }

      if (s.count > 0 && s.count < 5) {
        if (status !== "critical") status = "warning";
        issues.push(`Low Deal Count (${s.count})`);
      }

      return {
        store: s.store,
        count: s.count,
        avgDiscount,
        avgSavings,
        unknownBrandCount: s.unknownBrandCount,
        unknownBrandPct: unknownPct,
        missingImageCount: s.missingImageCount,
        missingUrlCount: s.missingUrlCount,
        missingModelCount: s.missingModelCount,
        missingPriceCount: s.missingPriceCount,
        health: { status, issues },
      };
    })
    .sort((a, b) => b.count - a.count);

  const brandsTop = Object.values(brands)
    .filter((b) => b.brand && b.brand !== "Unknown")
    .map((b) => ({
      brand: b.brand,
      count: b.count,
      avgDiscount: b.discountCount ? b.discountSum / b.discountCount : 0,
      minPrice: b.minPrice,
      maxPrice: b.maxPrice,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  const unknownByStore = storesTable.reduce((acc, s) => {
    acc[s.store] = { unknownCount: s.unknownBrandCount, total: s.count, pct: s.unknownBrandPct };
    return acc;
  }, {});

  let healthyCount = 0,
    warningCount = 0,
    criticalCount = 0;
  for (const s of storesTable) {
    if (s.health.status === "healthy") healthyCount++;
    else if (s.health.status === "warning") warningCount++;
    else criticalCount++;
  }

  const avgDiscount = discountCount ? discountSum / discountCount : 0;

  return {
    version: 1,
    generatedAt: nowIsoStr,
    totalDeals: safeArray(deals).length,
    totalStores: uniqueStoreSet.size,
    totalBrands: uniqueBrandSet.size,
    avgDiscount,

    topDeals: {
      topPercent: topPercent ? dealSummary(topPercent.deal) : null,
      topDollar: topDollar ? dealSummary(topDollar.deal) : null,
      lowestPrice: lowestPrice ? dealSummary(lowestPrice.deal) : null,
      bestValue: bestValue ? dealSummary(bestValue.deal) : null,
    },

    storesTable,
    brandsTop,
    unknownByStore,
    priceBuckets,

    health: {
      summary: { healthy: healthyCount, warning: warningCount, critical: criticalCount },
      stores: storesTable.map((s) => ({
        store: s.store,
        status: s.health.status,
        issues: s.health.issues,
        count: s.count,
        unknownBrandPct: s.unknownBrandPct,
      })),
    },

    scraperMetadata: storeMetadata || {},
  };
}

/** ------------ Daily Deals (unchanged) ------------ **/

function seededRandom(seed) {
  const x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}
function getDateSeedStringUTC() {
  return new Date().toISOString().split("T")[0];
}
function seedFromString(str) {
  let seed = 0;
  for (let i = 0; i < str.length; i++) seed += str.charCodeAt(i);
  return seed;
}
function getRandomSample(array, count, seedBaseStr) {
  if (!array || array.length === 0) return [];
  const dateStr = seedBaseStr || getDateSeedStringUTC();
  const seedBase = seedFromString(dateStr);

  const copy = [...array];
  const picked = [];
  const n = Math.min(count, copy.length);

  for (let i = 0; i < n; i++) {
    const rng = seededRandom(seedBase + i);
    const idx = Math.floor(rng * copy.length);
    picked.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return picked;
}
function parseMoney(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.]/g, "");
    const num = parseFloat(cleaned);
    return Number.isFinite(num) ? num : 0;
  }
  return 0;
}
function hasGoodImage(deal) {
  return (
    deal &&
    deal.imageURL &&
    typeof deal.imageURL === "string" &&
    deal.imageURL.trim() &&
    !deal.imageURL.includes("no-image") &&
    !deal.imageURL.includes("placeholder") &&
    !deal.imageURL.includes("placehold.co")
  );
}
function isDiscountedDeal(deal) {
  if (!hasSalePriceShape(deal) || !hasOriginalPriceShape(deal)) return false;
  const saleLow = toNumber(deal.salePriceLow) ?? toNumber(deal.salePrice);
  const origHigh = toNumber(deal.originalPriceHigh) ?? toNumber(deal.originalPrice);
  return Number.isFinite(saleLow) && Number.isFinite(origHigh) && origHigh > saleLow;
}
function shuffleWithDateSeed(items, seedStr) {
  const dateStr = seedStr || getDateSeedStringUTC();
  let shuffleSeed = 999;
  for (let i = 0; i < dateStr.length; i++) {
    shuffleSeed += dateStr.charCodeAt(i) * 7;
  }

  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const rng = seededRandom(shuffleSeed + i);
    const j = Math.floor(rng * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function toDailyDealShape(deal) {
  const saleLow = toNumber(deal.salePriceLow) ?? parseMoney(deal.salePrice);
  const saleHigh = toNumber(deal.salePriceHigh);
  const origLow = toNumber(deal.originalPriceLow) ?? parseMoney(deal.originalPrice);
  const origHigh = toNumber(deal.originalPriceHigh);

  const exact = toNumber(deal.discountPercent);
  const upTo = toNumber(deal.discountPercentUpTo);
  const effective = Number.isFinite(exact) ? exact : Number.isFinite(upTo) ? upTo : null;

  return {
    listingName: deal.listingName || "Running Shoe Deal",
    brand: deal.brand || "",
    model: deal.model || "",
    salePrice: Number.isFinite(saleLow) ? saleLow : 0,
    originalPrice: Number.isFinite(origLow) ? origLow : null,

    discountPercent: Number.isFinite(exact) ? Math.round(exact) : null,
    discountPercentUpTo: Number.isFinite(upTo) ? Math.round(upTo) : null,
    discountEffective: Number.isFinite(effective) ? Math.round(effective) : null,

    salePriceLow: Number.isFinite(saleLow) ? saleLow : null,
    salePriceHigh: Number.isFinite(saleHigh) ? saleHigh : null,
    originalPriceLow: Number.isFinite(origLow) ? origLow : null,
    originalPriceHigh: Number.isFinite(origHigh) ? origHigh : null,

    store: deal.store || "Store",
    listingURL: deal.listingURL || "#",
    imageURL: deal.imageURL || "",
    gender: deal.gender || "unknown",
    shoeType: deal.shoeType || "unknown",
  };
}
function computeTwelveDailyDeals(allDeals, seedStr) {
  const dateStr = seedStr || getDateSeedStringUTC();

  const qualityDeals = (allDeals || []).filter((d) => hasGoodImage(d) && isDiscountedDeal(d));
  const workingPool = qualityDeals.length >= 12 ? qualityDeals : (allDeals || []).filter(hasGoodImage);
  if (!workingPool.length) return [];

  if (workingPool.length < 12) {
    const picked = getRandomSample(workingPool, workingPool.length, dateStr);
    return shuffleWithDateSeed(picked, dateStr).map(toDailyDealShape);
  }

  const discountForSort = (d) => {
    const exact = toNumber(d.discountPercent);
    const upTo = toNumber(d.discountPercentUpTo);
    return Number.isFinite(exact) ? exact : Number.isFinite(upTo) ? upTo : 0;
  };

  const top20ByPercent = [...workingPool].sort((a, b) => discountForSort(b) - discountForSort(a)).slice(0, 20);

  const byPercent = getRandomSample(top20ByPercent, Math.min(4, top20ByPercent.length), dateStr);
  const pickedUrls = new Set(byPercent.map((d) => d.listingURL).filter(Boolean));

  const top20ByDollar = [...workingPool]
    .filter((d) => !pickedUrls.has(d.listingURL))
    .sort((a, b) => computeDollarSavings(b) - computeDollarSavings(a))
    .slice(0, 20);

  const byDollar = getRandomSample(top20ByDollar, Math.min(4, top20ByDollar.length), dateStr);
  byDollar.forEach((d) => pickedUrls.add(d.listingURL));

  const remaining = workingPool.filter((d) => !pickedUrls.has(d.listingURL));
  const randomPicks = getRandomSample(remaining, Math.min(4, remaining.length), dateStr);

  const selectedRaw = [...byPercent, ...byDollar, ...randomPicks];
  const shuffled = shuffleWithDateSeed(selectedRaw, dateStr);

  return shuffled.map(toDailyDealShape);
}

/** ------------ scraper-data.json (rolling 30 days) ------------ **/

function toIsoDayUTC(isoOrDate) {
  const d = isoOrDate ? new Date(isoOrDate) : new Date();
  if (Number.isNaN(d.getTime())) return getDateSeedStringUTC();
  return d.toISOString().split("T")[0];
}

// UPDATED: supports payload.scraperResult (singular) for per-store cheerio s
function buildTodayScraperRecords({ sourceName, meta, perSourceOk }) {
  const payload = meta?.payloadMeta || null;
  const timestamp = meta?.timestamp || payload?.lastUpdated || payload?.timestamp || payload?.scrapedAt || null;
  const durationMs = parseDurationMs(meta?.duration || payload?.scrapeDurationMs || payload?.duration || null);
  const via = meta?.source || null;
  const Url = meta?.Url || null;

  if (!perSourceOk) {
    return [
      {
        scraper: sourceName,
        ok: false,
        count: 0,
        durationMs,
        timestamp,
        via,
        Url,
        error: meta?.error || "Unknown error",
      },
    ];
  }

  // Old “combined cheerio” style (scraperResults object)
  if (payload && payload.scraperResults && typeof payload.scraperResults === "object") {
    const records = [];
    for (const [name, r] of Object.entries(payload.scraperResults)) {
      const ok = typeof r?.success === "boolean" ? r.success : typeof r?.ok === "boolean" ? r.ok : true;
      const count = Number.isFinite(r?.count) ? r.count : 0;
      const dMs = parseDurationMs(r?.durationMs || r?.duration || null) ?? durationMs ?? null;

      records.push({
        scraper: name,
        ok,
        count,
        durationMs: dMs,
        timestamp: payload.lastUpdated || payload.timestamp || payload.scrapedAt || timestamp || null,
        via,
        Url,
      });
    }
    if (records.length) return records;
  }

  // NEW per-store cheerio style (scraperResult singular)
  if (payload && payload.scraperResult && typeof payload.scraperResult === "object") {
    const r = payload.scraperResult;
    const ok = typeof r?.success === "boolean" ? r.success : typeof r?.ok === "boolean" ? r.ok : true;
    const count = Number.isFinite(r?.count) ? r.count : safeArray(meta?.deals).length;
    const dMs = parseDurationMs(r?.durationMs || r?.duration || null) ?? durationMs ?? null;

    return [
      {
        scraper: r?.scraper || sourceName,
        ok,
        count,
        durationMs: dMs,
        timestamp: payload.lastUpdated || payload.timestamp || payload.scrapedAt || timestamp || null,
        via,
        Url,
        error: r?.error || null,
      },
    ];
  }

  // Fallback
  return [
    {
      scraper: sourceName,
      ok: true,
      count: safeArray(meta?.deals).length,
      durationMs,
      timestamp,
      via,
      Url,
    },
  ];
}

function mergeRollingScraperHistory(existing, todayDayUTC, todayRecords, maxDays = 30) {
  const history = safeArray(existing?.days).filter(Boolean);
  const filtered = history.filter((d) => d?.dayUTC !== todayDayUTC);

  filtered.push({
    dayUTC: todayDayUTC,
    generatedAt: new Date().toISOString(),
    scrapers: safeArray(todayRecords),
  });

  filtered.sort((a, b) => String(a.dayUTC).localeCompare(String(b.dayUTC)));
  const trimmed = filtered.slice(Math.max(0, filtered.length - maxDays));

  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    days: trimmed,
  };
}

/** ------------ Handler ------------ **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const start = Date.now();
  const nowMs = Date.now();

  // ============================================================================
  //  URLs (-only mode)
  // ============================================================================

  const ALS_SALE__URL = String(process.env.ALS_SALE__URL || "").trim();
  const ASICS_SALE__URL = String(process.env.ASICS_SALE__URL || "").trim();
  const BACKCOUNTRY_DEALS_BLOB_URL = String(process.env.BACKCOUNTRY_DEALS_BLOB_URL || "").trim();
  const BROOKS_DEALS_BLOB_URL = String(process.env.BROOKS_DEALS_BLOB_URL || "").trim();
  const FINISHLINE_DEALS_BLOB_URL = String(process.env.FINISHLINE_DEALS_BLOB_URL || "").trim();
  const FLEET_FEET_CHEERIO_BLOB_URL = String(process.env.FLEET_FEET_CHEERIO_BLOB_URL || "").trim();
  const FOOTLOCKER_DEALS_BLOB_URL = String(process.env.FOOTLOCKER_DEALS_BLOB_URL || "").trim();
  const HOKA_DEALS_BLOB_URL = String(process.env.HOKA_DEALS_BLOB_URL || "").trim();
  const HOLABIRD_MENS_ROAD_BLOB_URL = String(process.env.HOLABIRD_MENS_ROAD_BLOB_URL || "").trim();
  const HOLABIRD_TRAIL_UNISEX_BLOB_URL = String(process.env.HOLABIRD_TRAIL_UNISEX_BLOB_URL || "").trim();
  const HOLABIRD_WOMENS_ROAD_BLOB_URL = String(process.env.HOLABIRD_WOMENS_ROAD_BLOB_URL || "").trim();
  const KOHLS_DEALS_BLOB_URL = String(process.env.KOHLS_DEALS_BLOB_URL || "").trim();
  const LUKES_LOCKER_CHEERIO_BLOB_URL = String(process.env.LUKES_LOCKER_CHEERIO_BLOB_URL || "").trim();
  const MARATHON_SPORTS_CHEERIO_BLOB_URL = String(process.env.MARATHON_SPORTS_CHEERIO_BLOB_URL || "").trim();
  const MIZUNO_DEALS_BLOB_URL = String(process.env.MIZUNO_DEALS_BLOB_URL || "").trim();
  const REI_DEALS_BLOB_URL = String(process.env.REI_DEALS_BLOB_URL || "").trim();
  const RNJSPORTS_DEALS_BLOB_URL = String(process.env.RNJSPORTS_DEALS_BLOB_URL || "").trim();
  const ROADRUNNER_DEALS_BLOB_URL = String(process.env.ROADRUNNER_DEALS_BLOB_URL || "").trim();
  const RUNNING_WAREHOUSE_CHEERIO_BLOB_URL = String(process.env.RUNNING_WAREHOUSE_CHEERIO_BLOB_URL || "").trim();
  const SHOEBACCA_CLEARANCE_BLOB_URL = String(process.env.SHOEBACCA_CLEARANCE_BLOB_URL || "").trim();
  const TRACKSHACK_CLEARANCE_BLOB_URL = String(process.env.TRACKSHACK_CLEARANCE_BLOB_URL || "").trim();
  const ZAPPOS_DEALS_BLOB_URL = String(process.env.ZAPPOS_DEALS_BLOB_URL || "").trim();

  const SCRAPER_DATA_BLOB_URL = String(process.env.SCRAPER_DATA_BLOB_URL || "").trim();

  // --------------------------------------------------------------------------
  // Freshness policy (your requirement):
  //
  // - If a scraper's last successful data is not from the last 24 hours:
  //     we STILL merge it (that's fine).
  // - BUT if the source timestamp is OLDER THAN 7 DAYS:
  //     we DO NOT add ANY deals from that source to the merged deals.
  //     That store should show 0 deals.
  // --------------------------------------------------------------------------
  const MAX_STORE_DATA_AGE_DAYS = 7;

  // NEW: your "freshData" threshold
  const FRESHNESS_THRESHOLD_HOURS = 26;

  try {
    console.log("[MERGE] Starting merge:", new Date().toISOString());
    console.log("[MERGE] Blob-only mode: endpoints disabled.");

    console.log("[MERGE] BACKCOUNTRY_DEALS_BLOB_URL set?", !!BACKCOUNTRY_DEALS_BLOB_URL);
    console.log("[MERGE] BROOKS_DEALS_BLOB_URL set?", !!BROOKS_DEALS_BLOB_URL);
    console.log("[MERGE] FINISHLINE_DEALS_BLOB_URL set?", !!FINISHLINE_DEALS_BLOB_URL);
    console.log("[MERGE] FLEET_FEET_CHEERIO_BLOB_URL set?", !!FLEET_FEET_CHEERIO_BLOB_URL);
    console.log("[MERGE] FOOTLOCKER_DEALS_BLOB_URL set?", !!FOOTLOCKER_DEALS_BLOB_URL);
    console.log("[MERGE] HOKA_DEALS_BLOB_URL set?", !!HOKA_DEALS_BLOB_URL);
    console.log("[MERGE] KOHLS_DEALS_BLOB_URL set?", !!KOHLS_DEALS_BLOB_URL);
    console.log("[MERGE] LUKES_LOCKER_CHEERIO_BLOB_URL set?", !!LUKES_LOCKER_CHEERIO_BLOB_URL);
    console.log("[MERGE] MARATHON_SPORTS_CHEERIO_BLOB_URL set?", !!MARATHON_SPORTS_CHEERIO_BLOB_URL);
    console.log("[MERGE] REI_DEALS_BLOB_URL set?", !!REI_DEALS_BLOB_URL);
    console.log("[MERGE] RNJSPORTS_DEALS_BLOB_URL set?", !!RNJSPORTS_DEALS_BLOB_URL);
    console.log("[MERGE] ROADRUNNER_DEALS_BLOB_URL set?", !!ROADRUNNER_DEALS_BLOB_URL);
    console.log("[MERGE] RUNNING_WAREHOUSE_CHEERIO_BLOB_URL set?", !!RUNNING_WAREHOUSE_CHEERIO_BLOB_URL);
    console.log("[MERGE] ZAPPOS_DEALS_BLOB_URL set?", !!ZAPPOS_DEALS_BLOB_URL);


    const sources = [
    
      
      { id: "als", name: "ALS", blobUrl: ALS_SALE_BLOB_URL }, 
      { id: "asics", name: "ASICS", blobUrl: ASICS_SALE_BLOB_URL },
      { id: "backcountry", name: "Backcountry", blobUrl: BACKCOUNTRY_DEALS_BLOB_URL },
      { id: "brooks-running", name: "Brooks Running", blobUrl: BROOKS_DEALS_BLOB_URL },
      { id: "finishline", name: "Finish Line", blobUrl: FINISHLINE_DEALS_BLOB_URL },
      { id: "fleet-feet", name: "Fleet Feet", blobUrl: FLEET_FEET_CHEERIO_BLOB_URL },
      { id: "foot-locker", name: "Foot Locker", blobUrl: FOOTLOCKER_DEALS_BLOB_URL },
      { id: "hoka", name: "HOKA", blobUrl: HOKA_DEALS_BLOB_URL },
            // Holabird is split across 3 blobs but shares 1 id
      { id: "holabird-sports", name: "Holabird Sports (Mens Road)", blobUrl: HOLABIRD_MENS_ROAD_BLOB_URL },
      { id: "holabird-sports", name: "Holabird Sports (Womens Road)", blobUrl: HOLABIRD_WOMENS_ROAD_BLOB_URL },
      { id: "holabird-sports", name: "Holabird Sports (Trail + Unisex)", blobUrl: HOLABIRD_TRAIL_UNISEX_BLOB_URL },
      { id: "kohls", name: "Kohls", blobUrl: KOHLS_DEALS_BLOB_URL },
      { id: "lukes-locker", name: "Luke's Locker", blobUrl: LUKES_LOCKER_CHEERIO_BLOB_URL },
      { id: "marathon-sports", name: "Marathon Sports", blobUrl: MARATHON_SPORTS_CHEERIO_BLOB_URL },
      { id: "mizuno", name: "Mizuno", blobUrl: MIZUNO_DEALS_BLOB_URL },
      { id: "rei-outlet", name: "REI Outlet", blobUrl: REI_DEALS_BLOB_URL },
      { id: "rnj-sports", name: "RNJ Sports", blobUrl: RNJSPORTS_DEALS_BLOB_URL },
      { id: "road-runner-sports", name: "Road Runner Sports", blobUrl: ROADRUNNER_DEALS_BLOB_URL },
      { id: "running-warehouse", name: "Running Warehouse", blobUrl: RUNNING_WAREHOUSE_CHEERIO_BLOB_URL },
      { id: "shoebacca", name: "Shoebacca", blobUrl: SHOEBACCA_CLEARANCE_BLOB_URL },
      { id: "track-shack", name: "Track Shack", blobUrl: TRACKSHACK_CLEARANCE_BLOB_URL },
      { id: "zappos", name: "Zappos", blobUrl: ZAPPOS_DEALS_BLOB_URL },
    ];

    const settled = await Promise.allSettled(sources.map((s) => loadDealsFromBlobOnly(s)));

    const perSource = {};
    const storeMetadata = {};
    const allDealsRaw = [];
    const perSourceMeta = {};

    // NEW: map id->display store name for the report
    const storeDisplayNameById = {};
    for (const s of sources) {
      if (!storeDisplayNameById[s.id]) storeDisplayNameById[s.id] = s.name;
    }

    for (let i = 0; i < settled.length; i++) {
      const src = sources[i];
      const key = src.id || src.name; // ✅ id is the real key
      const name = src.name; // display name only

      if (settled[i].status === "fulfilled") {
        const { source, deals, blobUrl, timestamp, duration, payloadMeta, error } = settled[i].value;

        if (source === "error") {
          perSource[key] = { ok: false, error: error || "Unknown error" };
          // accumulate storeMetadata even on error (keep the last error)
          storeMetadata[key] = { ...(storeMetadata[key] || {}), error: error || "Unknown error" };
          perSourceMeta[key] = { name, error: error || "Unknown error", source: "error", deals: [] };
          continue;
        }

        const isTooOld = isOlderThanDays(timestamp, MAX_STORE_DATA_AGE_DAYS, nowMs);
        const ageDays = formatAgeDays(timestamp, nowMs);

        // NOTE: Holabird shares an id across 3 blobs; accumulate counts and take the newest timestamp.
        const prev = storeMetadata[key] || {};
        const prevCount = Number.isFinite(prev.count) ? prev.count : 0;

        const tsMsPrev = parseTimestampMs(prev.timestamp);
        const tsMsNew = parseTimestampMs(timestamp);
        const newestTs =
          tsMsPrev != null && tsMsNew != null
            ? (tsMsNew >= tsMsPrev ? timestamp : prev.timestamp)
            : (timestamp || prev.timestamp || null);

        storeMetadata[key] = {
          blobUrl: blobUrl || prev.blobUrl || null, // keep latest non-empty
          timestamp: newestTs,
          duration: duration || prev.duration || null,
          count: prevCount + safeArray(deals).length,
          ageDays: ageDays != null ? ageDays : prev.ageDays ?? null,
          staleExcluded: !!isTooOld, // if any blob is too old, this might be true; fine for your use
          staleThresholdDays: MAX_STORE_DATA_AGE_DAYS,
        };

        perSourceMeta[key] = { name, source, deals, blobUrl, timestamp, duration, payloadMeta };

        if (isTooOld) {
          perSource[key] = {
            ok: true,
            via: source,
            count: 0,
            staleExcluded: true,
            ageDays: ageDays != null ? ageDays : null,
            note: `Excluded: source data older than ${MAX_STORE_DATA_AGE_DAYS} days`,
          };
          console.log(
            `[MERGE] EXCLUDING SOURCE (too old): ${name} | id=${key} | ageDays=${ageDays ?? "unknown"} | ts=${timestamp ?? "none"}`
          );
          continue;
        }

        // note: perSource[key].count is “this blob’s” count; storeMetadata[key].count is accumulated
        perSource[key] = { ok: true, via: source, count: safeArray(deals).length };
        allDealsRaw.push(...safeArray(deals));
      } else {
        const msg = settled[i].reason?.message || String(settled[i].reason);
        perSource[key] = { ok: false, error: msg };
        storeMetadata[key] = { ...(storeMetadata[key] || {}), error: msg };
        perSourceMeta[key] = { name, error: msg, source: "error", deals: [] };
      }
    }

    console.log("[MERGE] Source counts:", perSource);
    console.log("[MERGE] Total raw deals (after staleness exclusion):", allDealsRaw.length);

    const unalteredPayload = {
      lastUpdated: new Date().toISOString(),
      totalDealsRaw: allDealsRaw.length,
      scraperResults: perSource,
      storeMetadata,
      deals: allDealsRaw,
    };

    const normalized = allDealsRaw.map(normalizeDeal).filter(Boolean);
    const filtered = normalized.filter(isValidRunningShoe);
    const unique = dedupeDeals(filtered);

    let schemaWarnings = 0;
    for (const d of unique) {
      const errs = assertDealSchema(d);
      if (errs.length) {
        schemaWarnings++;
        console.log("[SCHEMA WARNING]", errs.join("; "), {
          store: d.store,
          listingURL: d.listingURL,
        });
      }
    }
    console.log(`[SCHEMA] warnings: ${schemaWarnings}`);

    const discountForSort = (d) => {
      const exact = toNumber(d.discountPercent);
      const upTo = toNumber(d.discountPercentUpTo);
      return Number.isFinite(exact) ? exact : Number.isFinite(upTo) ? upTo : 0;
    };

    unique.sort(() => Math.random() - 0.5);
    unique.sort((a, b) => discountForSort(b) - discountForSort(a));

    const dealsByStore = {};
    for (const d of unique) {
      const s = d.store || "Unknown";
      dealsByStore[s] = (dealsByStore[s] || 0) + 1;
    }

    // NEW: freshness report (store, storeLastUpdated, freshData)
    // - storeLastUpdated is pulled from each store blob's payload timestamp
    // - freshData is true iff age <= 26 hours (your rule)
    const sourceFreshness = Object.keys(storeMetadata)
      .sort((a, b) => String(a).localeCompare(String(b)))
      .map((storeId) => {
        const m = storeMetadata[storeId] || {};
        const storeLastUpdated = m.timestamp || null;
        return {
          store: storeId,
          storeLastUpdated,
          freshData: isFreshWithinHours(storeLastUpdated, FRESHNESS_THRESHOLD_HOURS, nowMs),
        };
      });

    const output = {
      lastUpdated: new Date().toISOString(),
      totalDeals: unique.length,
      dealsByStore,
      scraperResults: perSource,

      // ✅ WRITTEN INTO deals.json (as requested)
      sourceFreshness, // [{ store, storeLastUpdated, freshData }]

      deals: unique,
    };

    const stats = computeStats(unique, storeMetadata);
    stats.lastUpdated = output.lastUpdated;

    const dailySeedUTC = getDateSeedStringUTC();
    const twelveDailyDeals = computeTwelveDailyDeals(unique, dailySeedUTC);

    const dailyDealsPayload = {
      lastUpdated: output.lastUpdated,
      daySeedUTC: dailySeedUTC,
      total: twelveDailyDeals.length,
      deals: twelveDailyDeals,
    };

    const todayDayUTC = toIsoDayUTC(output.lastUpdated);

    const todayRecords = [];
    for (const src of sources) {
      const key = src.id || src.name;
      const ok = !!perSource[key]?.ok;
      const meta = perSourceMeta[key] || null;

      todayRecords.push(...buildTodayScraperRecords({ sourceName: key, meta, perSourceOk: ok }));
    }

    let existingScraperData = null;
    if (SCRAPER_DATA_BLOB_URL) {
      try {
        existingScraperData = await fetchJson(SCRAPER_DATA_BLOB_URL);
      } catch (e) {
        console.log("[MERGE] Could not read SCRAPER_DATA_BLOB_URL (starting fresh):", e.message);
        existingScraperData = null;
      }
    }

    const scraperData = mergeRollingScraperHistory(existingScraperData, todayDayUTC, todayRecords, 30);

    const [dealsBlob, unalteredBlob, statsBlob, dailyDealsBlob, scraperDataBlob] = await Promise.all([
      put("deals.json", JSON.stringify(output, null, 2), { access: "public", addRandomSuffix: false }),
      put("unaltered-deals.json", JSON.stringify(unalteredPayload, null, 2), { access: "public", addRandomSuffix: false }),
      put("stats.json", JSON.stringify(stats, null, 2), { access: "public", addRandomSuffix: false }),
      put("twelve_daily_deals.json", JSON.stringify(dailyDealsPayload, null, 2), { access: "public", addRandomSuffix: false }),
      put("scraper-data.json", JSON.stringify(scraperData, null, 2), { access: "public", addRandomSuffix: false }),
    ]);

    const durationMs = Date.now() - start;

    return res.status(200).json({
      success: true,
      totalDeals: unique.length,
      totalRawDeals: allDealsRaw.length,
      dealsByStore,
      scraperResults: perSource,
      storeMetadata,

      // NEW: return it in API response too (handy for quick checks)
      sourceFreshness,

      dealsBlobUrl: dealsBlob.url,
      unalteredBlobUrl: unalteredBlob.url,
      statsBlobUrl: statsBlob.url,
      dailyDealsBlobUrl: dailyDealsBlob.url,
      scraperDataBlobUrl: scraperDataBlob.url,

      duration: `${durationMs}ms`,
      timestamp: output.lastUpdated,

      note:
        SCRAPER_DATA_BLOB_URL
          ? "scraper-data history appended (SCRAPER_DATA_BLOB_URL was set)"
          : "scraper-data written, but to persist rolling 30-day history you should set SCRAPER_DATA_BLOB_URL to scraperDataBlobUrl",
    });
  } catch (err) {
    console.error("[MERGE] Fatal error:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};
