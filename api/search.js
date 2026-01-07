const axios = require("axios");

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

module.exports = async (req, res) => {
  const requestId =
    (req.headers && (req.headers["x-vercel-id"] || req.headers["x-request-id"])) ||
    `local-${Date.now()}`;
  const startedAt = Date.now();

  try {
    const rawQuery = req.query && req.query.query ? req.query.query : "";
    const query = normalize(rawQuery);
    
    console.log("[/api/search] Request:", { requestId, rawQuery, query });

    if (!query) {
      return res.status(400).json({
        error: "Missing query parameter",
        example: "/api/search?query=Nike%20Pegasus",
        requestId
      });
    }

    // Check cache
    const cacheKey = `search:${query}`;
    const cached = getCached(cacheKey);
    if (cached) {
      console.log("[/api/search] Cache hit");
      return res.status(200).json({ results: cached, requestId, cached: true });
    }

    // Load deals from Vercel Blob Storage
    const blobUrl = 'https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/deals-Hdb7taRgUyYd0OJpkU9zxgTZTgBdZK.json';
    let dealsData;
    
    try {
      const response = await axios.get(blobUrl);
      dealsData = response.data;
    } catch (blobError) {
      console.error("[/api/search] Error fetching from blob:", blobError.message);
      return res.status(500).json({ 
        error: "Failed to load deals data",
        requestId
      });
    }

    const deals = dealsData.deals || [];

    console.log("[/api/search] Loaded deals:", {
      total: deals.length,
      lastUpdated: dealsData.lastUpdated || 'unknown'
    });

    // Parse query
    const parts = rawQuery.trim().split(/\s+/);
    const brand = parts[0] || "";
    const model = parts.slice(1).join(" ") || "";

    console.log("[/api/search] Parsed:", { brand, model });

    // Filter deals
    const results = deals
      .filter((deal) => {
        const dealBrand = normalize(deal.brand);
        const dealModel = normalize(deal.model);
        const normalizedBrand = normalize(brand);
        const normalizedModel = normalize(model);
        
        // Require brand match
        if (!dealBrand.includes(normalizedBrand)) return false;
        
        // Model match: allow partial match either direction
        if (!normalizedModel) return true; // Brand-only search
        
        return (
          dealModel.includes(normalizedModel) ||
          normalizedModel.includes(dealModel)
        );
      })
      .map((deal) => ({
        title: deal.title,
        price: Number(deal.price),
        originalPrice: deal.originalPrice ? Number(deal.originalPrice) : null,
        discount: deal.discount || null,
        store: deal.store,
        url: deal.url,
        image: deal.image || "https://placehold.co/600x400?text=Running+Shoe"
      }))
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
      .slice(0, 12);

    // Cache results
    setCache(cacheKey, results);

    console.log("[/api/search] Complete:", {
      requestId,
      ms: Date.now() - startedAt,
      count: results.length,
      dataAge: dealsData.lastUpdated ? `Updated ${new Date(dealsData.lastUpdated).toLocaleString()}` : 'unknown'
    });

    return res.status(200).json({ 
      results, 
      requestId,
      lastUpdated: dealsData.lastUpdated,
      cached: false
    });

  } catch (err) {
    console.error("[/api/search] Fatal error:", {
      requestId,
      message: err?.message || String(err),
      stack: err?.stack
    });
    
    return res.status(500).json({ 
      error: "Internal server error",
      details: err?.message,
      requestId
    });
  }
};
