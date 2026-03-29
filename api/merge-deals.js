// /api/merge-deals.js
//
// Merges sources into canonical deals.json.
//
// IMPORTANT RULES:
// - merge-deals NEVER scrapes.
// - It ONLY fetches pre-scraped JSON from blob URLs provided via env vars.
//
// Canonical schema variables supported here:
//   schemaVersion
//   listingName
//   brand
//   model
//   salePrice
//   originalPrice
//   discountPercent
//   salePriceLow
//   salePriceHigh
//   originalPriceLow
//   originalPriceHigh
//   discountPercentUpTo
//   store
//   listingURL
//   imageURL
//   gender
//   surface
//
// HONESTY RULES:
// - A deal is included if it has sale pricing.
// - Original / MSRP pricing is OPTIONAL.
// - discountPercent is ONLY computed when exact salePrice and exact originalPrice both exist
//   and originalPrice > salePrice.
// - discountPercentUpTo is ONLY computed when range/original data exists and supports it.
// - If original pricing is missing, discountPercent and discountPercentUpTo stay null.
//
// TO ADD A NEW STORE: add it to /lib/canonical-stores.json only. No changes needed here.

const axios = require("axios");
const { put } = require("@vercel/blob");
const { assertDealSchema } = require("../lib/dealSchema");
const { cleanModelName } = require("../lib/modelNameCleaner");

// ✅ Canonical Brand + Models dictionary (single source of truth)
const { canonicalBrandModelHelper } = require("../lib/canonical-brand-models");

// ✅ Canonical store list (single source of truth for stores)
const storeList = require("../lib/canonical-stores.json");

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

/** ------------ Brand canonicalization ------------ **/

function normalizeBrand(rawBrand) {
  const cleaned = String(rawBrand || "")
    .replace(/[\u00AE\u2122\u2120]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "Unknown";

  return canonicalBrandModelHelper.resolveCanonicalBrand(cleaned) || cleaned;
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
  if (age == null) return false;
  return age > days * 24 * 60 * 60 * 1000;
}

function formatAgeDays(ts, nowMs = Date.now()) {
  const age = ageMsFromTimestamp(ts, nowMs);
  if (age == null) return null;
  return Math.round((age / (24 * 60 * 60 * 1000)) * 10) / 10;
}

function isFreshWithinHours(ts, hours, nowMs = Date.now()) {
  const age = ageMsFromTimestamp(ts, nowMs);
  if (age == null) return false;
  return age <= hours * 60 * 60 * 1000;
}

/** ------------ Price shape helpers ------------ **/

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

// ✅ Data-driven storeBaseUrl — reads from /lib/canonical-stores.json at module load
const STORE_BASE_URL_MAP = (() => {
  const map = new Map();
  for (const s of storeList) {
    map.set(s.id.toLowerCase(), s.baseUrl);
    map.set(s.displayName.toLowerCase(), s.baseUrl);
    for (const alias of (s.aliases || [])) {
      map.set(alias.toLowerCase(), s.baseUrl);
    }
  }
  return map;
})();

function storeBaseUrl(store) {
  const s = String(store || "").toLowerCase().trim();
  return STORE_BASE_URL_MAP.get(s) || "https://example.com";
}

function normalizeGender(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "mens" || s === "men" || s === "men's") return "mens";
  if (s === "womens" || s === "women" || s === "women's") return "womens";
  if (s === "unisex") return "unisex";
  return "unknown";
}

function normalizeSurface(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "road") return "road";
  if (s === "trail") return "trail";
  if (s === "track") return "track";
  return "unknown";
}

function sanitizeDeal(raw) {
  if (!raw) return null;

  const store = raw.store || raw.retailer || raw.site || "Unknown";
  const base = storeBaseUrl(store);

const listingNameRaw = raw.listingName ?? raw.listing ?? raw.title ?? raw.name ?? "";
const brandRaw = raw.brand ?? raw.vendor ?? "";
const modelRaw = raw.model ?? "";

const listingName = cleanTitleText(listingNameRaw);
const brand = normalizeBrand(cleanLooseText(brandRaw));

const brandEntry = canonicalBrandModelHelper.data?.[brand] || null;
const brandAliases = Array.isArray(brandEntry?.aliases) ? brandEntry.aliases : [];

const cleanedModel = cleanModelName(modelRaw || listingNameRaw, {
  brand,
  brandAliases,
});

const model = cleanedModel.modelBase || "";

  let listingURL = String(raw.listingURL ?? raw.listingUrl ?? raw.url ?? raw.href ?? "").trim();
  if (listingURL) listingURL = absolutizeUrl(listingURL, base);

  let imageURL = null;
  const imgCandidate = raw.imageURL ?? raw.imageUrl ?? raw.image ?? raw.img ?? raw.thumbnail ?? null;
  if (typeof imgCandidate === "string" && imgCandidate.trim()) {
    imageURL = absolutizeUrl(imgCandidate.trim(), base);
  }

  const gender = normalizeGender(raw.gender);
  const surface = normalizeSurface(raw.surface ?? raw.shoeType);

  const priceShape = normalizePriceShapes(raw);

  const legacySale = priceShape.salePrice != null ? priceShape.salePrice : priceShape.salePriceLow;
  const legacyOrig = priceShape.originalPrice != null ? priceShape.originalPrice : priceShape.originalPriceLow;

  const safeListingName = listingName || normalizeWhitespace(`${brand} ${model}`) || "Running Shoe";
  const safeName = looksLikeCssOrJunk(safeListingName) ? "" : safeListingName;

  const canonical = {
    schemaVersion: 1,

    listingName: safeName,
    brand: brand || "Unknown",
    model: model || "",
    salePrice: Number.isFinite(legacySale) ? legacySale : null,
    originalPrice: Number.isFinite(legacyOrig) ? legacyOrig : null,

    discountPercent: null,
    discountPercentUpTo: null,

    salePriceLow: priceShape.salePriceLow,
    salePriceHigh: priceShape.salePriceHigh,
    originalPriceLow: priceShape.originalPriceLow,
    originalPriceHigh: priceShape.originalPriceHigh,

    store: typeof store === "string" ? store.trim() : "Unknown",
    listingURL: listingURL || "",
    imageURL: imageURL || null,
    gender,
    surface,
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

/** ------------ Exclusion tracking ------------ **/

function createExclusionTracker() {
  return {
    totalExcludedDeals: 0,
    reasons: Object.create(null),
  };
}

function trackExclusion(tracker, reason, store, deal) {
  if (!tracker || !reason) return;

  tracker.totalExcludedDeals += 1;

  if (!tracker.reasons[reason]) {
    tracker.reasons[reason] = {
      count: 0,
      stores: new Set(),
      examples: [],
    };
  }

  const bucket = tracker.reasons[reason];
  bucket.count += 1;

  const storeName = String(store || deal?.store || "Unknown").trim() || "Unknown";
  bucket.stores.add(storeName);

  if (bucket.examples.length < 5) {
    bucket.examples.push({
      store: storeName,
      listingName: String(deal?.listingName || "").trim() || null,
      brand: String(deal?.brand || "").trim() || null,
      model: String(deal?.model || "").trim() || null,
      listingURL: String(deal?.listingURL || "").trim() || null,
    });
  }
}

function finalizeExclusionTracker(tracker) {
  const byReason = Object.entries(tracker?.reasons || {})
    .map(([reason, data]) => ({
      reason,
      count: data.count,
      stores: Array.from(data.stores).sort((a, b) => a.localeCompare(b)),
      examples: data.examples,
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const storesIndex = Object.create(null);
  for (const item of byReason) {
    for (const store of item.stores) {
      if (!storesIndex[store]) storesIndex[store] = 0;
      storesIndex[store] += item.count;
    }
  }

  const excludedStores = Object.keys(storesIndex)
    .sort((a, b) => a.localeCompare(b))
    .map((store) => ({
      store,
      exclusions: storesIndex[store],
    }));

  return {
    totalExcludedDeals: tracker?.totalExcludedDeals || 0,
    excludedReasonCount: byReason.length,
    byReason,
    excludedStores,
  };
}

const TITLE_MODEL_EXCLUDE_PATTERNS = [
  "accessories",
  "accessory",
  "apparel",
  "arm warmer",
  "backpack",
  "bag",
  "bags",
  "beanie",
  "bottle",
  "bra",
  "bras",
  "brief",
  "cap",
  "compression",
  "crosskix",
  "crew neck",
  "earwarmer",
  "ear warmer",
  "equipment",
  "eyewear",
  "fabric",
  "flask",
  "gaiter",
  "gear",
  "gloves",
  "hat",
  "half-crew",
  "headband",
  "headwarmer",
  "head warmer",
  "hoodie",
  "hydration",
  "insole",
  "insoles",
  "jacket",
  "jackets",
  "junior",
  "juniors",
  "kid",
  "kids",
  "lace",
  "laces",
  "leg warmer",
  "leggings",
  "low-cut",
  "mid-calf",
  "mid-crew",
  "mini crew",
  "mini-crew",
  "mitt",
  "out of stock",
  "pack",
  "pants",
  "pickleball",
  "pullover",
  "quarter-crew",
  "recovery",
  "shirt",
  "shorts",
  "singlet",
  "sleeve",
  "sleeves",
  "sock",
  "socks",
  "sunglasses",
  "tank top",
  "tank-top",
  "tanktop",
  "throw",
  "throws",
  "thigh-high",
  "tights",
  "underwear",
  "vest",
  "watch",
  "windbreaker",
  "wristband",
  "yaktrax",
  "youth",
  "youths",
];

function getKeywordExclusionReason(listingName, model) {
  const haystack = `${String(listingName || "")} ${String(model || "")}`.toLowerCase();

  for (const pattern of TITLE_MODEL_EXCLUDE_PATTERNS) {
    const regex = new RegExp(`\\b${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (regex.test(haystack)) {
      return `"${pattern}" in title/model`;
    }
  }

  return null;
}

function getDealExclusionReasons(deal) {
  const reasons = [];
  if (!deal) {
    reasons.push("deal could not be normalized");
    return reasons;
  }

  const listingURL = String(deal.listingURL || "").trim();
  const listingName = String(deal.listingName || "").trim();
  const brand = String(deal.brand || "").trim();
  const model = String(deal.model || "").trim();

  const brandLc = brand.toLowerCase();

  if (!brand || brandLc === "unknown" || brandLc === "null") {
    reasons.push("brand is null/unknown");
  }

  if (!listingURL) {
    reasons.push("missing listingURL");
  }

  if (!listingName) {
    reasons.push("missing listingName");
  }

  if (!hasSalePriceShape(deal)) {
    reasons.push("missing sale price");
  }

  const saleLow = toNumber(deal.salePriceLow) ?? toNumber(deal.salePrice);
  const saleHigh = toNumber(deal.salePriceHigh);

  if (!Number.isFinite(saleLow)) {
    reasons.push("sale price could not be parsed");
  } else {
    if (saleLow < 10) reasons.push("sale price below minimum");
    if (saleLow > 1000) reasons.push("sale price above maximum");
  }

  if (saleHigh != null && Number.isFinite(saleHigh) && Number.isFinite(saleLow) && saleHigh < saleLow) {
    reasons.push("sale price range invalid");
  }

  const origSingle = toNumber(deal.originalPrice);
  const origLow = toNumber(deal.originalPriceLow);
  const origHigh = toNumber(deal.originalPriceHigh);

  if (Number.isFinite(origSingle) && origSingle <= 0) reasons.push("original price invalid");
  if (Number.isFinite(origLow) && origLow <= 0) reasons.push("original price range invalid");
  if (Number.isFinite(origHigh) && origHigh <= 0) reasons.push("original price range invalid");
  if (Number.isFinite(origLow) && Number.isFinite(origHigh) && origHigh < origLow) {
    reasons.push("original price range invalid");
  }

  const bestKnownOrig = origHigh ?? origSingle ?? origLow ?? null;
  if (Number.isFinite(bestKnownOrig) && Number.isFinite(saleLow) && saleLow >= bestKnownOrig) {
    reasons.push("sale price is not less than original price");
  }

  const keywordReason = getKeywordExclusionReason(listingName, model);
  if (keywordReason) reasons.push(keywordReason);

  return Array.from(new Set(reasons));
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
    ...d, // Preserve any existing fields from the original scraper deal object so future schema fields aren't lost during normalization

    schemaVersion: 1,

    listingName: typeof c.listingName === "string" ? c.listingName.trim() : "",
    brand: typeof c.brand === "string" ? c.brand.trim() : "Unknown",
    model: typeof c.model === "string" ? c.model.trim() : "",

    salePrice: toNumber(c.salePrice),
    originalPrice: toNumber(c.originalPrice),
    discountPercent: Number.isFinite(toNumber(c.discountPercent))
      ? Math.round(toNumber(c.discountPercent))
      : null,

    salePriceLow: saleRangeOk ? saleLo : null,
    salePriceHigh: saleRangeOk ? saleHi : null,
    originalPriceLow: origRangeOk ? origLo : null,
    originalPriceHigh: origRangeOk ? origHi : null,
    discountPercentUpTo: Number.isFinite(toNumber(c.discountPercentUpTo))
      ? Math.round(toNumber(c.discountPercentUpTo))
      : null,

    store: typeof c.store === "string" ? c.store.trim() : "Unknown",
    listingURL: typeof c.listingURL === "string" ? c.listingURL.trim() : "",
    imageURL: typeof c.imageURL === "string" ? c.imageURL.trim() : c.imageURL ?? null,
    gender: normalizeGender(c.gender),
    surface: normalizeSurface(c.surface),
  };
}

function dedupeDealsWithTracking(deals, exclusionTracker) {
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
    if (seen.has(key)) {
      trackExclusion(exclusionTracker, "duplicate store+listingURL after merge", storeKey, d);
      continue;
    }

    seen.add(key);
    unique.push(d);
  }

  return unique;
}

/** ------------ Blob-only fetch helpers (cache buster) ------------ **/

async function fetchJson(url) {
  try {
    const cacheBustedUrl = `${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}`;

    const resp = await axios.get(cacheBustedUrl, {
      timeout: 30000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json,text/plain,*/*",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });

    return resp.data;
  } catch (e) {
    throw new Error(`fetchJson failed for ${url}: ${e?.message || String(e)}`);
  }
}

function extractTopLevelMeta(payload) {
  const timestamp =
    payload?.lastUpdated ||
    payload?.timestamp ||
    payload?.generatedAt ||
    payload?.scrapedAt ||
    payload?.runFinishedAt ||
    null;

  const durationMs = parseDurationMs(
    payload?.scrapeDurationMs ??
      payload?.elapsedMs ??
      payload?.durationMs ??
      payload?.duration ??
      payload?.scrapeDuration ??
      null
  );

  const via = payload?.via || payload?.source || null;

  return { timestamp, durationMs, via };
}

async function loadDealsFromBlobOnly({ name, blobUrl }) {
  const metadata = {
    name,
    source: null,
    deals: [],
    blobUrl: null,
    timestamp: null,
    duration: null,
    payloadMeta: null,
    error: null,
  };

  const u = String(blobUrl || "").trim();
  if (!u) {
    metadata.source = "error";
    metadata.error = `Missing required env var / blobUrl for ${name}`;
    return metadata;
  }

  try {
    const payload = await fetchJson(u);
    const deals = extractDealsFromPayload(payload);

    const { timestamp, durationMs, via } = extractTopLevelMeta(payload);

    metadata.source = via || payload?.via || "blob";
    metadata.deals = deals;
    metadata.blobUrl = u;
    metadata.timestamp = timestamp || null;
    metadata.duration = durationMs != null ? durationMs : null;
    metadata.payloadMeta = payload;

    return metadata;
  } catch (e) {
    metadata.source = "error";
    metadata.error = e?.message || String(e);
    metadata.blobUrl = u;
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
    surface: deal.surface || deal.shoeType || "unknown",  };
}

function computeStats(deals, storeMetadata, mergeExclusions) {
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
    mergeExclusions: mergeExclusions || {
      totalExcludedDeals: 0,
      excludedReasonCount: 0,
      byReason: [],
      excludedStores: [],
    },
  };
}

/** ------------ Daily Deals ------------ **/

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
  if (!hasSalePriceShape(deal)) return false;

  const saleLow = toNumber(deal.salePriceLow) ?? toNumber(deal.salePrice);
  if (!Number.isFinite(saleLow) || saleLow <= 0) return false;

  const origHigh = toNumber(deal.originalPriceHigh) ?? toNumber(deal.originalPrice);
  if (!Number.isFinite(origHigh)) {
    return true;
  }

  return origHigh > saleLow;
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
    gender: normalizeGender(deal.gender),
    surface: normalizeSurface(deal.surface ?? deal.shoeType),
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

function buildTodayScraperRecord({ sourceId, sourceDisplayName, meta, perSource }) {
  const payload = meta?.payloadMeta || null;

  const timestamp =
    meta?.timestamp ||
    payload?.lastUpdated ||
    payload?.timestamp ||
    payload?.scrapedAt ||
    null;

  const durationMs = parseDurationMs(
    meta?.duration != null
      ? meta.duration
      : (payload?.scrapeDurationMs ?? payload?.elapsedMs ?? payload?.duration ?? null)
  );

  const via = meta?.source || perSource?.via || null;
  const blobUrl = meta?.blobUrl || null;
  const ok = !!perSource?.ok;
  const count = ok
    ? (Number.isFinite(perSource?.count) ? perSource.count : safeArray(meta?.deals).length)
    : 0;

  return {
    storeId: sourceId,
    scraper: sourceDisplayName,
    ok,
    count,
    durationMs,
    timestamp,
    via,
    blobUrl,
    error: ok ? null : (meta?.error || perSource?.error || "Unknown error"),
  };
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

/** ------------ Store-id mapping helpers ------------ **/

function stripParensSuffix(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  return s.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function storeKey(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function buildStoreNameKeyToIdMap(sources) {
  const map = new Map();
  for (const s of safeArray(sources)) {
    const id = s.id || s.name;
    const name = String(s.name || "").trim();
    const base = stripParensSuffix(name);

    const keys = new Set([name, base, id].filter(Boolean).map(storeKey));
    for (const k of keys) map.set(k, id);

    if (storeKey(base) === storeKey("Holabird Sports")) map.set(storeKey("Holabird"), id);
    if (storeKey(base) === storeKey("Brooks Running")) map.set(storeKey("Brooks"), id);
  }
  return map;
}

function buildSourceGroupsById(sources) {
  const groups = new Map();
  for (const s of safeArray(sources)) {
    const id = s.id || s.name;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        names: new Set(),
        blobUrls: new Set(),
        displayName: stripParensSuffix(s.name || id) || id,
      });
    }
    const g = groups.get(id);
    if (s.name) g.names.add(String(s.name));
    if (s.blobUrl) g.blobUrls.add(String(s.blobUrl));
    const candidate = stripParensSuffix(s.name || "") || "";
    if (candidate && candidate.length < (g.displayName || "").length) g.displayName = candidate;
  }
  return groups;
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

  // Freshness policy:
  // - If source timestamp is OLDER THAN 7 DAYS: exclude that store's deals from merge
  const MAX_STORE_DATA_AGE_DAYS = 7;

  // "freshData" threshold
  const FRESHNESS_THRESHOLD_HOURS = 26;

  try {
    console.log("[MERGE] Starting merge:", new Date().toISOString());
    console.log("[MERGE] Blob-only mode: endpoints disabled.");

    // ✅ Sources built dynamically from /lib/canonical-stores.json.
    // To add a new store: add it to canonical-stores.json only. No changes needed here.
    const sources = storeList
      .filter((s) => s.enabled !== false)
      .map((s) => ({
        id: s.id,
        name: s.displayName,
        blobUrl: String(process.env[s.envVar] || "").trim(),
      }));

    const SCRAPER_DATA_BLOB_URL = String(process.env.SCRAPER_DATA_BLOB_URL || "").trim();

    // maps used to make "0 shoes" explicit in deals.json
    const rawCountsById = {};
    const keptCountsById = {};

    // stable mapping from various store strings -> source id
    const STORE_NAME_KEY_TO_ID = buildStoreNameKeyToIdMap(sources);

    // groups (handles holabird triple-blob cleanly in storeCoverage)
    const SOURCE_GROUPS = buildSourceGroupsById(sources);

    // NEW: detailed exclusion tracker
    const exclusionTracker = createExclusionTracker();

    // Load all blobs in parallel (this does NOT scrape; it only fetches JSON)
    const settled = await Promise.allSettled(sources.map((s) => loadDealsFromBlobOnly(s)));

    const perSource = {};
    const storeMetadata = {};
    const allDealsRaw = [];
    const perSourceMeta = {};

    for (let i = 0; i < settled.length; i++) {
      const src = sources[i];
      const key = src.id || src.name;
      const name = src.name;

      if (settled[i].status === "fulfilled") {
        const { source, deals, blobUrl, timestamp, duration, payloadMeta, error } = settled[i].value;

        rawCountsById[key] = (rawCountsById[key] || 0) + safeArray(deals).length;

        if (source === "error") {
          perSource[key] = { ok: false, error: error || "Unknown error" };
          storeMetadata[key] = { ...(storeMetadata[key] || {}), error: error || "Unknown error" };
          perSourceMeta[key] = { name, error: error || "Unknown error", source: "error", deals: [], blobUrl };
          continue;
        }

        const prev = storeMetadata[key] || {};
        const prevCount = Number.isFinite(prev.count) ? prev.count : 0;

        const tsMsPrev = parseTimestampMs(prev.timestamp);
        const tsMsNew = parseTimestampMs(timestamp);
        const newestTs =
          tsMsPrev != null && tsMsNew != null
            ? tsMsNew >= tsMsPrev
              ? timestamp
              : prev.timestamp
            : timestamp || prev.timestamp || null;

        const isTooOld = isOlderThanDays(newestTs, MAX_STORE_DATA_AGE_DAYS, nowMs);
        const ageDays = formatAgeDays(newestTs, nowMs);

        storeMetadata[key] = {
          blobUrl: blobUrl || prev.blobUrl || null,
          timestamp: newestTs,
          duration: duration != null ? duration : prev.duration ?? null,
          count: prevCount + safeArray(deals).length,
          ageDays: ageDays != null ? ageDays : prev.ageDays ?? null,
          staleExcluded: !!isTooOld,
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

          for (const rawDeal of safeArray(deals)) {
            const storeForDeal =
              rawDeal?.store || rawDeal?.retailer || rawDeal?.site || src.name || src.id || "Unknown";
            trackExclusion(
              exclusionTracker,
              `source data older than ${MAX_STORE_DATA_AGE_DAYS} days`,
              storeForDeal,
              rawDeal
            );
          }

          console.log(
            `[MERGE] EXCLUDING SOURCE (too old): ${name} | id=${key} | ageDays=${ageDays ?? "unknown"} | ts=${
              timestamp ?? "none"
            }`
          );
          continue;
        }

        perSource[key] = { ok: true, via: source, count: safeArray(deals).length };
        allDealsRaw.push(...safeArray(deals));
      } else {
        const msg = settled[i].reason?.message || String(settled[i].reason);
        perSource[key] = { ok: false, error: msg };
        storeMetadata[key] = { ...(storeMetadata[key] || {}), error: msg };

        rawCountsById[key] = rawCountsById[key] || 0;

        perSourceMeta[key] = { name, error: msg, source: "error", deals: [], blobUrl: src.blobUrl || null };
      }
    }

    console.log("[MERGE] Source counts:", perSource);
    console.log("[MERGE] Total raw deals (after staleness exclusion):", allDealsRaw.length);

    // Normalize -> filter with detailed reasons -> dedupe with detailed reasons
    const normalized = [];
    for (const rawDeal of allDealsRaw) {
      const n = normalizeDeal(rawDeal);
      if (!n) {
        const store = rawDeal?.store || rawDeal?.retailer || rawDeal?.site || "Unknown";
        trackExclusion(exclusionTracker, "deal could not be normalized", store, rawDeal);
        continue;
      }
      normalized.push(n);
    }

    const filtered = [];
    for (const deal of normalized) {
      const reasons = getDealExclusionReasons(deal);
      if (reasons.length) {
        for (const reason of reasons) {
          trackExclusion(exclusionTracker, reason, deal.store, deal);
        }
        continue;
      }
      filtered.push(deal);
    }

    const unique = dedupeDealsWithTracking(filtered, exclusionTracker);

    for (const d of unique) {
      const storeName = String(d?.store || "").trim();
      const id = STORE_NAME_KEY_TO_ID.get(storeKey(storeName)) || null;
      const key = id || storeName || "unknown";
      keptCountsById[key] = (keptCountsById[key] || 0) + 1;
    }

    const mergeExclusions = finalizeExclusionTracker(exclusionTracker);

    // Schema validation warnings (do not fail build; only log)
    let schemaWarnings = 0;
    for (const d of unique) {
      const errs = assertDealSchema(d);
      if (errs.length) {
        schemaWarnings++;
        console.log("[SCHEMA WARNING]", errs.join("; "), { store: d.store, listingURL: d.listingURL });
      }
    }
    console.log(`[SCHEMA] warnings: ${schemaWarnings}`);

    // Sort: random shuffle then by discount descending (keeps variety)
    const discountForSort = (d) => {
      const exact = toNumber(d.discountPercent);
      const upTo = toNumber(d.discountPercentUpTo);
      return Number.isFinite(exact) ? exact : Number.isFinite(upTo) ? upTo : 0;
    };

    unique.sort(() => Math.random() - 0.5);
    unique.sort((a, b) => discountForSort(b) - discountForSort(a));

    // Count deals per store
    const dealsByStoreCounts = {};
    for (const d of unique) {
      const s = d.store || "Unknown";
      dealsByStoreCounts[s] = (dealsByStoreCounts[s] || 0) + 1;
    }

    // Sort stores alphabetically
    const dealsByStore = Object.keys(dealsByStoreCounts)
      .sort((a, b) => a.localeCompare(b))
      .reduce((acc, store) => {
        acc[store] = dealsByStoreCounts[store];
        return acc;
      }, {});

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

    const storeCoverage = Array.from(SOURCE_GROUPS.values())
      .map((g) => {
        const id = g.id;
        const meta = storeMetadata[id] || {};
        const status = perSource[id] || {};
        const rawCount = rawCountsById[id] || 0;
        const keptCount = keptCountsById[id] || 0;

        return {
          id,
          name: g.displayName || id,
          names: Array.from(g.names.values()),
          blobUrls: Array.from(g.blobUrls.values()),

          ok: !!status.ok,
          error: status.ok ? null : status.error || meta.error || null,

          staleExcluded: !!meta.staleExcluded,
          staleThresholdDays: meta.staleThresholdDays ?? MAX_STORE_DATA_AGE_DAYS,

          rawCount,
          keptCount,

          sourceLastUpdated: meta.timestamp || null,
          ageDays: meta.ageDays ?? null,
        };
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const output = {
      lastUpdated: new Date().toISOString(),
      totalDeals: unique.length,
      totalDealsRaw: allDealsRaw.length,
      totalDealsExcluded: mergeExclusions.totalExcludedDeals,

      dealsByStore,
      scraperResults: perSource,

      sourceFreshness,
      storeCoverage,
      mergeExclusions,

      deals: unique,
    };

    const unalteredPayload = {
      lastUpdated: output.lastUpdated,
      totalDealsRaw: allDealsRaw.length,
      totalDealsExcluded: mergeExclusions.totalExcludedDeals,
      scraperResults: perSource,
      storeMetadata,
      mergeExclusions,
      deals: allDealsRaw,
    };

    // Derived payloads
    const stats = computeStats(unique, storeMetadata, mergeExclusions);
    stats.lastUpdated = output.lastUpdated;

    const dailySeedUTC = getDateSeedStringUTC();
    const twelveDailyDeals = computeTwelveDailyDeals(unique, dailySeedUTC);

    const dailyDealsPayload = {
      lastUpdated: output.lastUpdated,
      daySeedUTC: dailySeedUTC,
      total: twelveDailyDeals.length,
      deals: twelveDailyDeals,
    };

    // scraper-data: rolling 30-day history
    const todayDayUTC = toIsoDayUTC(output.lastUpdated);

    const todayRecords = [];
    for (const src of sources) {
      const key = src.id || src.name;
      const meta = perSourceMeta[key] || null;
      const perSourceEntry = perSource[key] || { ok: false, count: 0, error: "Missing perSource entry" };

      todayRecords.push(
        buildTodayScraperRecord({
          sourceId: src.id || key,
          sourceDisplayName: src.name || key,
          meta,
          perSource: perSourceEntry,
        })
      );
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

    // Write blobs (public, stable filenames)
    const [dealsBlob, unalteredBlob, statsBlob, dailyDealsBlob, scraperDataBlob] = await Promise.all([
      put("deals.json", JSON.stringify(output, null, 2), { access: "public", addRandomSuffix: false }),
      put("unaltered-deals.json", JSON.stringify(unalteredPayload, null, 2), {
        access: "public",
        addRandomSuffix: false,
      }),
      put("stats.json", JSON.stringify(stats, null, 2), { access: "public", addRandomSuffix: false }),
      put("twelve_daily_deals.json", JSON.stringify(dailyDealsPayload, null, 2), {
        access: "public",
        addRandomSuffix: false,
      }),
      put("scraper-data.json", JSON.stringify(scraperData, null, 2), { access: "public", addRandomSuffix: false }),
    ]);

    const durationMs = Date.now() - start;

    return res.status(200).json({
      success: true,
      totalDeals: unique.length,
      totalRawDeals: allDealsRaw.length,
      totalExcludedDeals: mergeExclusions.totalExcludedDeals,
      dealsByStore,
      scraperResults: perSource,
      storeMetadata,
      sourceFreshness,
      storeCoverage,
      mergeExclusions,

      dealsBlobUrl: dealsBlob.url,
      unalteredBlobUrl: unalteredBlob.url,
      statsBlobUrl: statsBlob.url,
      dailyDealsBlobUrl: dailyDealsBlob.url,
      scraperDataBlobUrl: scraperDataBlob.url,

      duration: `${durationMs}ms`,
      timestamp: output.lastUpdated,

      note: SCRAPER_DATA_BLOB_URL
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
