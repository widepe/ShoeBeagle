const { list } = require("@vercel/blob");

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

// In-memory cache
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

// Rate limiting - 10 requests per minute per IP
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per minute

function getRateLimitKey(req) {
  // Get IP from various headers (supports proxies/load balancers)
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
    // First request from this IP
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }

  // Check if window has expired
  if (now > record.resetAt) {
    // Reset the window
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }

  // Within the window - check count
  if (record.count >= RATE_LIMIT_MAX) {
    // Rate limited!
    return true;
  }

  // Increment count
  record.count++;
  return false;
}

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetAt) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

module.exports = async (req, res) => {
  const requestId =
    (req.headers && (req.headers["x-vercel-id"] || req.headers["x-request-id"])) ||
    `local-${Date.now()}`;
  const startedAt = Date.now();

  try {
    // Check rate limit first
    const clientIp = getRateLimitKey(req);
    if (isRateLimited(clientIp)) {
      console.log("[/api/search] Rate limited:", { ip: clientIp, requestId });
      // Return 429 Too Many Requests but with a generic message
      // Real users won't see this; only bots will
      return res.status(429).json({
        error: "Too many requests",
        requestId,
      });
    }

    // OLD style: separate brand / model
    const rawBrand = req.query && req.query.brand ? req.query.brand : "";
    const rawModel = req.query && req.query.model ? req.query.model : "";

    // NEW style: single query string (brand, model, or both)
    const rawQuery = req.query && req.query.query ? req.query.query : "";

    const brand = normalize(rawBrand);
    const model = normalize(rawModel);
    const qNorm = normalize(rawQuery);

    console.log("[/api/search] Request:", {
      requestId,
      ip: clientIp,
      rawBrand,
      rawModel,
      rawQuery,
      brand,
      model,
      qNorm,
    });

    // Require at least one of: brand, model, or query
    if (!brand && !model && !qNorm) {
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

    // Cache key must include all 3 inputs so we don't cross-contaminate
    const cacheKey = `search:${brand}:${model}:${qNorm}`;
    const cached = getCached(cacheKey);
    if (cached) {
      console.log("[/api/search] Cache hit");
      return res.status(200).json({ results: cached, requestId, cached: true });
    }

    // Fetch from Vercel Blob Storage by name
    const { blobs } = await list({ prefix: "deals.json" });

    if (!blobs || blobs.length === 0) {
      console.error("[/api/search] Could not locate deals blob");
      return res.status(500).json({
        error: "Failed to load deals data",
        requestId,
      });
    }

    const blob = blobs[0];

    let dealsData;
    try {
      const response = await fetch(blob.url);
      if (!response.ok) {
        throw new Error(`Blob fetch failed: ${response.status}`);
      }
      dealsData = await response.json();
    } catch (blobError) {
      console.error("[/api/search] Error fetching from blob:", blobError.message);
      return res.status(500).json({
        error: "Failed to load deals data",
        requestId,
      });
    }

    // Support both { deals: [...] } and bare array [...]
    const deals = (dealsData && Array.isArray(dealsData.deals))
      ? dealsData.deals
      : (Array.isArray(dealsData) ? dealsData : []);

    console.log("[/api/search] Loaded deals:", {
      total: deals.length,
      lastUpdated: dealsData.lastUpdated || "unknown",
    });

    console.log("[/api/search] Parsed:", { brand, model, qNorm });

    const results = deals
      .filter((deal) => {
        const dealBrand = normalize(deal.brand);
        const dealModel = normalize(deal.model);
        const dealTitle = normalize(deal.title);

        // Mode 1: explicit brand + model (old behavior)
        if (brand || model) {
          if (brand && model) {
            const brandMatch = dealBrand.includes(brand);
            const modelMatch = dealModel.includes(model) || dealTitle.includes(model);
            return brandMatch && modelMatch;
          }

          if (brand && !model) {
            return dealBrand.includes(brand);
          }

          if (!brand && model) {
            return dealModel.includes(model) || dealTitle.includes(model);
          }
        }

        // Mode 2: free-text query only (new behavior)
        if (qNorm) {
          const haystack = `${dealBrand} ${dealModel} ${dealTitle}`;
          return haystack.includes(qNorm);
        }

        return false;
      })
      .map((deal) => ({
        title: deal.title,
        brand: deal.brand,
        model: deal.model,
        salePrice: Number(deal.salePrice),                           // CHANGED from 'price'
        price: deal.price ? Number(deal.price) : null,               // CHANGED from 'originalPrice'
        store: deal.store,
        url: deal.url,
        image: deal.image || "https://placehold.co/600x400?text=Running+Shoe",
        gender: deal.gender || "unknown",                            // NEW
        shoeType: deal.shoeType || "unknown",                        // NEW
      }))
      // Deals already sorted in blob; just take top N
      .slice(0, 24);

    setCache(cacheKey, results);

    console.log("[/api/search] Complete:", {
      requestId,
      ip: clientIp,
      ms: Date.now() - startedAt,
      count: results.length,
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
