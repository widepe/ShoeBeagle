// /api/search.js
// Improved search:
// - Token-based, order-independent matching (Google-ish)
// - Handles gt2000 / gt-2000 / gt 2000 / 2000
// - Handles prefix tolerance: asic -> asics
// - Scores + sorts results (best matches first)
// - Keeps your: rate limiting, requestId, caching, blob loading
// - ✅ RETURNS CANONICAL 11-FIELD SCHEMA (matches merge-deals + UI)

const { list } = require("@vercel/blob");

/* ----------------------------- Normalization ----------------------------- */

function normalizeSpaces(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9\s]+/g, " ")   // punctuation -> space
    .replace(/\s+/g, " ")
    .trim();
}

function squash(s) {
  return normalizeSpaces(s).replace(/\s+/g, ""); // remove spaces too
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

// For "query=" mode: if user types one glued chunk (gt2000) we also try to infer tokens.
function queryTokensFromRaw(rawQuery) {
  const ns = normalizeSpaces(rawQuery);
  const tokens = tokenize(ns).filter(isMeaningfulToken);

  // If user typed something like "gt2000" (no spaces), add a split hint:
  // - add number runs (2000)
  // - add leading letters (gt)
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

// Build a searchable index for each deal once per request (cheap and clear).
function buildIndex(deal) {
  const brand = deal.brand || "";
  const model = deal.model || "";
  // ✅ Canonical title field is listingName (fallback to title/name if any legacy source leaks through)
  const title = deal.listingName || deal.title || deal.name || "";

  const combined = `${brand} ${model} ${title}`;
  const tokens = tokenize(combined);
  const tokenSet = new Set(tokens);
  const squashedCombined = squash(combined);

  return { tokenSet, tokens, squashedCombined, brand, model, title };
}

// Score how well this deal matches the desired brand/model/query tokens.
// Higher score = better rank.
function scoreDeal({ brandTokens, modelTokens, queryTokens }, idx) {
  let score = 0;

  const hasExact = (t) => idx.tokenSet.has(t);
  const hasPrefix = (t) => idx.tokens.some((dt) => dt.startsWith(t));
  const hasSquashed = (qSquashed) => idx.squashedCombined.includes(qSquashed);

  // --- Brand field (if provided) should be relatively strong ---
  if (brandTokens.length) {
    let brandHits = 0;

    for (const t of brandTokens) {
      if (hasExact(t)) { score += 20; brandHits++; continue; }
      if (hasPrefix(t)) { score += 12; brandHits++; continue; } // asic -> asics
    }

    // Require at least one brand hit if brand was provided
    if (brandHits === 0) return 0;

    score += Math.floor((brandHits / brandTokens.length) * 10);
  }

  // --- Model field (if provided) strong, allow numbers + squashed matching ---
  if (modelTokens.length) {
    let modelHits = 0;

    const modelSquashed = squash(modelTokens.join(" "));
    if (modelSquashed && modelSquashed.length >= 4 && hasSquashed(modelSquashed)) {
      score += 25; // gt2000 matches GT-2000 regardless of separators
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

    // Require at least one model hit if model was provided
    if (modelHits === 0) return 0;

    score += Math.floor((modelHits / modelTokens.length) * 10);
  }

  // --- Free-text query tokens (if provided) moderate weight, order-independent ---
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

    // For query-only searches, require a minimum hit rate
    if (!brandTokens.length && !modelTokens.length) {
      const required = queryTokens.length === 1 ? 1 : Math.ceil(queryTokens.length * 0.6);
      if (hits < required) return 0;
    }

    score += Math.floor((hits / queryTokens.length) * 12);
  }

  // Tie-breaker: slight preference if model appears (more specific)
  if (idx.model && idx.model.trim()) score += 2;

  return score;
}

/* ------------------------------ Caching --------------------------------- */

// In-memory cache (results only)
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

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

    // OLD style: separate brand / model
    const rawBrand = req.query && req.query.brand ? req.query.brand : "";
    const rawModel = req.query && req.query.model ? req.query.model : "";

    // NEW style: single query string
    const rawQuery = req.query && req.query.query ? req.query.query : "";

    const brandTokens = tokenize(rawBrand).filter(isMeaningfulToken);
    const modelTokens = tokenize(rawModel).filter(isMeaningfulToken);
    const queryTokens = queryTokensFromRaw(rawQuery).filter(isMeaningfulToken);

    console.log("[/api/search] Request:", {
      requestId,
      ip: clientIp,
      rawBrand,
      rawModel,
      rawQuery,
      brandTokens,
      modelTokens,
      queryTokens,
    });

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

    const cacheKey = `search:v3:${brandTokens.join(".")}:${modelTokens.join(".")}:${queryTokens.join(".")}`;
    const cached = getCached(cacheKey);
    if (cached) {
      console.log("[/api/search] Cache hit");
      return res.status(200).json({ results: cached, requestId, cached: true });
    }

    // Load deals.json blob
    const { blobs } = await list({ prefix: "deals.json" });
    if (!blobs || blobs.length === 0) {
      console.error("[/api/search] Could not locate deals blob");
      return res.status(500).json({ error: "Failed to load deals data", requestId });
    }

    const blob = blobs[0];

    let dealsData;
    try {
      // ✅ CACHE BUST: Vercel Blob public URLs can be CDN-cached even after overwrite.
// Adding a unique query param forces a fresh fetch of the newest blob contents.
const freshUrl = `${blob.url}${blob.url.includes("?") ? "&" : "?"}cb=${Date.now()}`;
const response = await fetch(freshUrl, { cache: "no-store" });

      if (!response.ok) throw new Error(`Blob fetch failed: ${response.status}`);
      dealsData = await response.json();
    } catch (blobError) {
      console.error("[/api/search] Error fetching from blob:", blobError.message);
      return res.status(500).json({ error: "Failed to load deals data", requestId });
    }

    const deals = (dealsData && Array.isArray(dealsData.deals))
      ? dealsData.deals
      : (Array.isArray(dealsData) ? dealsData : []);

    console.log("[/api/search] Loaded deals:", {
      total: deals.length,
      lastUpdated: dealsData.lastUpdated || "unknown",
    });

    // Score + rank
    const desired = { brandTokens, modelTokens, queryTokens };

    const scored = [];
    for (const deal of deals) {
      const idx = buildIndex(deal);
      const s = scoreDeal(desired, idx);
      if (s > 0) scored.push({ deal, score: s });
    }

    scored.sort((a, b) => b.score - a.score);

    // ✅ Return CANONICAL SCHEMA FIELDS that your UI expects
    const results = scored
      .slice(0, 480)
      .map(({ deal /*, score*/ }) => ({
        listingName: deal.listingName || deal.title || deal.name || "Running Shoe Deal",
        brand: deal.brand || "Unknown",
        model: deal.model || "",
        salePrice: safeNum(deal.salePrice),
        originalPrice: safeNum(deal.originalPrice),
        discountPercent: Number.isFinite(safeNum(deal.discountPercent)) ? Math.round(safeNum(deal.discountPercent)) : 0,
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
      query: { brandTokens, modelTokens, queryTokens },
      dataAge: dealsData.lastUpdated
        ? `Updated ${new Date(dealsData.lastUpdated).toLocaleString()}`
        : "unknown",
    });

    return res.status(200).json({
      results,
      requestId,
      lastUpdated: dealsData.lastUpdated,
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
