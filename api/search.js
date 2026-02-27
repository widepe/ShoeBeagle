// /api/search.js
// Improved search:
// - Token-based, order-independent matching (Google-ish)
// - Handles gt2000 / gt-2000 / gt 2000 / 2000
// - Handles prefix tolerance: asic -> asics
// - Scores + sorts results (best matches first)
// - Keeps your: rate limiting, requestId, caching, blob loading
// - ✅ RETURNS CANONICAL 11-FIELD SCHEMA (matches merge-deals + UI)
//
// ✅ FRESHNESS FIX:
// 1) Cache deals.json in-memory for 5 minutes (reduces Blob reads).
// 2) Version search-result cache by dealsData.lastUpdated.
//    When merge-deals overwrites deals.json, lastUpdated changes,
//    and cached search results automatically flip to the new dataset.
//
// ✅ BRAND INPUT CANONICALIZATION (NEW):
// - Load canonical brand display keys from /lib/canonical-brands-models.json
// - If user types "asics" or "Asics" or "ASICS", we normalize the input to "ASICS"
// - This makes suggestions + filters case-insensitive but returns consistent display casing.

const { list } = require("@vercel/blob");


/* ----------------------------- Normalization ----------------------------- */

// Lowercase, strip accents, punctuation -> spaces, collapse whitespace
function normalizeSpaces(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9\s]+/g, " ")   // punctuation -> space
    .replace(/\s+/g, " ")
    .trim();
}

// Remove spaces too (for gt2000 style matching)
function squash(s) {
  return normalizeSpaces(s).replace(/\s+/g, "");
}

function tokenize(s) {
  const ns = normalizeSpaces(s);
  return ns ? ns.split(" ").filter(Boolean) : [];
}

// Filter out pure-noise tokens. Keep numbers, keep >=2 char words.
function isMeaningfulToken(t) {
  if (!t) return false;
  if (/^\d+$/.test(t)) return true;
  return t.length >= 2;
}

// If user types one glued chunk (gt2000) also try to infer tokens.
function queryTokensFromRaw(rawQuery) {
  const ns = normalizeSpaces(rawQuery);
  const tokens = tokenize(ns).filter(isMeaningfulToken);

  const squashedQuery = squash(rawQuery);
  if (tokens.length === 1 && squashedQuery.length >= 4 && /^[a-z0-9]+$/.test(squashedQuery)) {
    const nums = squashedQuery.match(/\d+/g) || [];
    const letters = squashedQuery.match(/[a-z]+/g) || [];
    const extras = [
      ...letters.filter((x) => x.length >= 2 && x.length <= 6),
      ...nums.filter((x) => x.length >= 2),
    ];
    return Array.from(new Set([...tokens, ...extras])).filter(isMeaningfulToken);
  }

  return tokens;
}


/* ------------------------------ Scoring --------------------------------- */

// Build a searchable index for each deal once per request.
function buildIndex(deal) {
  const brand = deal.brand || "";
  const model = deal.model || "";
  const title = deal.listingName || deal.title || deal.name || "";

  const combined = `${brand} ${model} ${title}`;
  const tokens = tokenize(combined);
  const tokenSet = new Set(tokens);
  const squashedCombined = squash(combined);

  return { tokenSet, tokens, squashedCombined, brand, model, title };
}

function scoreDeal({ brandTokens, modelTokens, queryTokens }, idx) {
  let score = 0;

  const hasExact = (t) => idx.tokenSet.has(t);
  const hasPrefix = (t) => idx.tokens.some((dt) => dt.startsWith(t));
  const hasSquashed = (qSquashed) => idx.squashedCombined.includes(qSquashed);

  // --- Brand ---
  if (brandTokens.length) {
    let brandHits = 0;

    for (const t of brandTokens) {
      if (hasExact(t)) { score += 20; brandHits++; continue; }
      if (hasPrefix(t)) { score += 12; brandHits++; continue; }
    }

    // If user specified brand, require at least one brand hit
    if (brandHits === 0) return 0;

    score += Math.floor((brandHits / brandTokens.length) * 10);
  }

  // --- Model ---
  if (modelTokens.length) {
    let modelHits = 0;

    const modelSquashed = squash(modelTokens.join(" "));
    if (modelSquashed && modelSquashed.length >= 4 && hasSquashed(modelSquashed)) {
      score += 25;
      modelHits++;
    }

    for (const t of modelTokens) {
      if (hasExact(t)) { score += /^\d+$/.test(t) ? 18 : 14; modelHits++; continue; }
      if (hasPrefix(t)) { score += 9; modelHits++; continue; }
      if (
        /^\d+$/.test(t) &&
        t.length >= 2 &&
        idx.tokens.some((dt) => /^\d+$/.test(dt) && dt.startsWith(t))
      ) {
        score += 7;
        modelHits++;
        continue;
      }
    }

    // If user specified model, require at least one model hit
    if (modelHits === 0) return 0;

    score += Math.floor((modelHits / modelTokens.length) * 10);
  }

  // --- Query ---
  if (queryTokens.length) {
    let hits = 0;

    const qSquashed = squash(queryTokens.join(" "));
    if (qSquashed && qSquashed.length >= 4 && hasSquashed(qSquashed)) {
      score += 18;
      hits += 1;
    }

    for (const t of queryTokens) {
      if (hasExact(t)) { score += /^\d+$/.test(t) ? 12 : 9; hits++; continue; }
      if (hasPrefix(t)) { score += 6; hits++; continue; }
    }

    // If this is a "query only" search (no brand/model), require some minimum hits
    if (!brandTokens.length && !modelTokens.length) {
      const required = queryTokens.length === 1 ? 1 : Math.ceil(queryTokens.length * 0.6);
      if (hits < required) return 0;
    }

    score += Math.floor((hits / queryTokens.length) * 12);
  }

  // Small bonus if model exists
  if (idx.model && idx.model.trim()) score += 2;

  return score;
}

/* ------------------------------ Caching --------------------------------- */

// Per-query search results cache
const cache = new Map();

// Because we version cache keys by dealsData.lastUpdated,
// you can safely keep this long. It won't block "fresh daily data".
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// deals.json cache (reduces Blob reads)
const DEALS_TTL = 5 * 60 * 1000; // 5 minutes
let dealsCache = { timestamp: 0, data: null, blobUrl: null };

async function loadDealsDataFresh() {
  const { blobs } = await list({ prefix: "deals.json" });
  if (!blobs || blobs.length === 0) {
    throw new Error("Could not locate deals.json blob");
  }

  const blob = blobs[0];
  const url = blob.url;

  // When we DO refresh, we cache-bust here (once per 5 minutes max)
  const freshUrl = `${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}`;
  const resp = await fetch(freshUrl, { cache: "no-store" });
  if (!resp.ok) throw new Error(`Blob fetch failed: ${resp.status}`);

  const data = await resp.json();
  return { data, blobUrl: url };
}

async function getDealsData() {
  const now = Date.now();
  if (dealsCache.data && (now - dealsCache.timestamp) < DEALS_TTL) {
    return dealsCache;
  }

  const loaded = await loadDealsDataFresh();
  dealsCache = {
    timestamp: now,
    data: loaded.data,
    blobUrl: loaded.blobUrl,
  };
  return dealsCache;
}

/* ---------------------------- Rate Limiting ----------------------------- */

// 10 requests per minute per IP
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 10;

function getRateLimitKey(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function isRateLimited(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }

  if (now > record.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }

  if (record.count >= RATE_LIMIT_MAX) return true;

  record.count++;
  return false;
}

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

/* ------------------------------- Helpers -------------------------------- */

function safeNum(x) {
  if (x == null) return null;
  const n = typeof x === "string" ? parseFloat(String(x).replace(/,/g, "")) : Number(x);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------- Handler -------------------------------- */

module.exports = async (req, res) => {
  const requestId =
    (req.headers && (req.headers["x-vercel-id"] || req.headers["x-request-id"])) ||
    `local-${Date.now()}`;
  const startedAt = Date.now();

  try {
    const clientIp = getRateLimitKey(req);
    if (isRateLimited(clientIp)) {
      console.log("[/api/search] Rate limited:", { ip: clientIp, requestId });
      return res.status(429).json({ error: "Too many requests", requestId });
    }

    // Raw query params
    const rawBrandInput = req.query && req.query.brand ? req.query.brand : "";
    const rawModel = req.query && req.query.model ? req.query.model : "";
    const rawQuery = req.query && req.query.query ? req.query.query : "";

    // ✅ NEW: Canonicalize brand *input* so casing doesn't matter,
    // and "asics" always becomes "ASICS" (assuming your JSON uses "ASICS" as the key).
    const rawBrand = rawBrandInput;

    const brandTokens = tokenize(rawBrand).filter(isMeaningfulToken);
    const modelTokens = tokenize(rawModel).filter(isMeaningfulToken);
    const queryTokens = queryTokensFromRaw(rawQuery).filter(isMeaningfulToken);

    if (!brandTokens.length && !modelTokens.length && !queryTokens.length) {
      return res.status(400).json({
        error: "Missing parameters - provide brand, model, query, or a combination",
        examples: [
          "/api/search?brand=Nike&model=Pegasus",
          "/api/search?query=Nike%20Pegasus",
          "/api/search?query=Pegasus",
        ],
        requestId,
      });
    }

    // Get deals.json (cached for 5 minutes)
    let dealsData;
    try {
      const loaded = await getDealsData();
      dealsData = loaded.data;
    } catch (e) {
      console.error("[/api/search] Failed loading deals.json:", e?.message || String(e));
      return res.status(500).json({ error: "Failed to load deals data", requestId });
    }

    const dealsVersion = dealsData?.lastUpdated ? String(dealsData.lastUpdated) : "unknown";

    // Include canonicalized brand in the cache key so asics/ASICS share cache
    const cacheKey = `search:v6:${dealsVersion}:${brandTokens.join(".")}:${modelTokens.join(".")}:${queryTokens.join(".")}`;

    const cached = getCached(cacheKey);
    if (cached) {
      return res.status(200).json({
        results: cached,
        requestId,
        lastUpdated: dealsVersion,
        cached: true,
      });
    }

    const deals = Array.isArray(dealsData?.deals)
      ? dealsData.deals
      : (Array.isArray(dealsData) ? dealsData : []);

    // Score + rank
    const desired = { brandTokens, modelTokens, queryTokens };
    const scored = [];

    for (const deal of deals) {
      const idx = buildIndex(deal);
      const s = scoreDeal(desired, idx);
      if (s > 0) scored.push({ deal, score: s });
    }

    scored.sort((a, b) => b.score - a.score);

    // Cap results (keep your existing cap)
   const results = scored.map(({ deal }) => ({
      listingName: deal.listingName || deal.title || deal.name || "Running Shoe Deal",
      brand: deal.brand || "Unknown",
      model: deal.model || "",
      salePrice: safeNum(deal.salePrice),
      originalPrice: safeNum(deal.originalPrice),
      discountPercent: Number.isFinite(safeNum(deal.discountPercent))
        ? Math.round(safeNum(deal.discountPercent))
        : 0,
      store: deal.store || "Unknown",
      listingURL: deal.listingURL || deal.url || "",
      imageURL:
        deal.imageURL ||
        deal.imageUrl ||
        deal.image ||
        deal.img ||
        deal.thumbnail ||
        "https://placehold.co/600x400?text=Running+Shoe",
      gender: deal.gender || "unknown",
      shoeType: deal.shoeType || "unknown",
    }));

    setCache(cacheKey, results);

    console.log("[/api/search] Complete:", {
      requestId,
      ip: clientIp,
      ms: Date.now() - startedAt,
      count: results.length,
      dealsVersion,
      query: { brand: rawBrandInput, brandTokens, modelTokens, queryTokens },
    });

    return res.status(200).json({
      results,
      requestId,
      lastUpdated: dealsVersion,
      cached: false,
    });
  } catch (err) {
    console.error("[/api/search] Fatal error:", {
      requestId,
      message: err?.message || String(err),
      stack: err?.stack,
    });

    return res.status(500).json({
      error: "Internal server error",
      details: err?.message,
      requestId,
    });
  }
};
