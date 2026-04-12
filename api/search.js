const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const rateLimitMap = new Map();

function cleanupRateLimitMap() {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(key);
    }
  }
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return (
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    "unknown"
  );
}

function rateLimit(req, res) {
  cleanupRateLimitMap();

  const ip = getClientIp(req);
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    res.status(429).json({ error: "Too many requests" });
    return false;
  }

  entry.count += 1;
  return true;
}

function sanitizeInput(str) {
  return String(str || "")
    .replace(/[<>]/g, "")
    .replace(/script/gi, "")
    .replace(/javascript/gi, "")
    .replace(/on\w+=/gi, "")
    .trim()
    .slice(0, 100);
}

function normalizeStr(value) {
  return String(value || "").trim().toLowerCase();
}

function squashStr(value) {
  return normalizeStr(value).replace(/[^a-z0-9]+/g, "");
}

function tokenize(value) {
  return normalizeStr(value)
    .split(/[^a-z0-9]+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeGender(value) {
  const g = normalizeStr(value);
  if (!g) return "";

  if (["men", "mens", "man's", "mans", "male"].includes(g)) return "mens";
  if (["women", "womens", "woman's", "womans", "female"].includes(g)) return "womens";
  if (["unisex"].includes(g)) return "unisex";
  if (["kid", "kids", "youth", "boys", "girls"].includes(g)) return "kids";

  return g;
}

function scoreField(fieldValue, query) {
  const field = String(fieldValue || "");
  if (!field) return 0;

  const fieldLower = field.toLowerCase();
  const queryLower = String(query || "").trim().toLowerCase();
  if (!queryLower) return 0;

  const fieldSquash = squashStr(field);
  const querySquash = squashStr(queryLower);
  const queryTokens = tokenize(queryLower);

  let score = 0;

  if (fieldLower === queryLower) score += 400;
  if (fieldSquash && querySquash && fieldSquash === querySquash) score += 350;

  if (fieldLower.startsWith(queryLower)) score += 220;
  if (fieldLower.includes(queryLower)) score += 140;

  if (querySquash.length >= 3 && fieldSquash.includes(querySquash)) score += 160;

  let tokenHits = 0;
  let tokenPrefixHits = 0;

  for (const token of queryTokens) {
    if (!token) continue;
    if (fieldLower.includes(token)) tokenHits += 1;

    const parts = fieldLower.split(/\s+/).filter(Boolean);
    if (parts.some((p) => p.startsWith(token))) tokenPrefixHits += 1;
  }

  score += tokenHits * 35;
  score += tokenPrefixHits * 50;

  score -= Math.min(field.length, 60) * 0.2;

  return score;
}

function scoreDeal(deal, rawQuery) {
  const query = String(rawQuery || "").trim();
  const queryNorm = normalizeStr(query);
  const querySquash = squashStr(query);
  const queryTokens = tokenize(query);

  const brand = String(deal.brand || "");
  const model = String(deal.model || "");
  const gender = normalizeGender(deal.gender || "");
  const listingName = String(deal.listingName || `${brand} ${model}`.trim());

  const brandNorm = normalizeStr(brand);
  const modelNorm = normalizeStr(model);
  const listingNorm = normalizeStr(listingName);

  let score = 0;

  score += scoreField(brand, query) * 1.6;
  score += scoreField(model, query) * 1.9;
  score += scoreField(listingName, query) * 1.15;
  score += scoreField(gender, query) * 1.35;

  if (brandNorm && modelNorm) {
    const brandModel = `${brandNorm} ${modelNorm}`.trim();
    const brandModelSquash = squashStr(brandModel);

    if (brandModel === queryNorm) score += 600;
    if (brandModel.startsWith(queryNorm)) score += 260;
    if (brandModel.includes(queryNorm)) score += 180;
    if (brandModelSquash && querySquash && brandModelSquash === querySquash) score += 520;
    if (brandModelSquash && querySquash && brandModelSquash.includes(querySquash)) score += 220;
  }

  if (gender && queryTokens.length) {
    const genderMatched = queryTokens.some((token) => normalizeGender(token) === gender);
    if (genderMatched) score += 180;
  }

  const matchedTokens = queryTokens.filter((token) => {
    const normGenderToken = normalizeGender(token);
    return (
      brandNorm.includes(token) ||
      modelNorm.includes(token) ||
      listingNorm.includes(token) ||
      (normGenderToken && gender === normGenderToken)
    );
  }).length;

  score += matchedTokens * 40;

  if (queryTokens.length > 1) {
    const allTokensMatched = queryTokens.every((token) => {
      const normGenderToken = normalizeGender(token);
      return (
        brandNorm.includes(token) ||
        modelNorm.includes(token) ||
        listingNorm.includes(token) ||
        (normGenderToken && gender === normGenderToken)
      );
    });

    if (allTokensMatched) score += 180;
  }

  return score;
}

function mapRowToDeal(row) {
  const brand = String(row.brand || "").trim();
  const model = String(row.model || "").trim();

  return {
    listingName:
      String(row.listing_name || "").trim() ||
      `${brand} ${model}`.trim(),
    brand,
    model,
    salePrice:
      row.sale_price === null || row.sale_price === undefined
        ? null
        : Number(row.sale_price),
    originalPrice:
      row.original_price === null || row.original_price === undefined
        ? null
        : Number(row.original_price),
    discountPercent:
      row.discount_percent === null || row.discount_percent === undefined
        ? null
        : Number(row.discount_percent),
    store: String(row.store || "").trim(),
    listingURL: String(row.listing_url || "").trim(),
    imageURL: String(row.image_url || "").trim(),
    gender: normalizeGender(row.gender || ""),
    shoeType: String(row.shoe_type || "").trim(),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!rateLimit(req, res)) return;

  const rawQuery = sanitizeInput(req.query?.query || "");

  if (!rawQuery) {
    return res.status(400).json({ error: "Missing query" });
  }

  const normalizedQuery = normalizeStr(rawQuery);
  const queryTokens = tokenize(normalizedQuery);

  if (!queryTokens.length) {
    return res.status(400).json({ error: "Invalid query" });
  }

  try {
    const whereParts = [];
    const params = [];
    let paramIndex = 1;

    for (const token of queryTokens) {
      const likeValue = `%${token}%`;
      const genderToken = normalizeGender(token);

      const tokenConditions = [
        `LOWER(COALESCE(brand, '')) LIKE LOWER($${paramIndex})`,
        `LOWER(COALESCE(model, '')) LIKE LOWER($${paramIndex})`,
        `LOWER(COALESCE(CONCAT(COALESCE(brand, ''), ' ', COALESCE(model, '')), '')) LIKE LOWER($${paramIndex})`,
      ];

      params.push(likeValue);
      paramIndex += 1;

      if (genderToken) {
        tokenConditions.push(`LOWER(COALESCE(gender, '')) = LOWER($${paramIndex})`);
        params.push(genderToken);
        paramIndex += 1;
      }

      whereParts.push(`(${tokenConditions.join(" OR ")})`);
    }

    const sql = `
      SELECT
        brand,
        model,
        gender,
        shoe_type,
        store,
        sale_price,
        original_price,
        discount_percent,
        listing_url,
        image_url,
        listing_name
      FROM sb_shoe_deals
      WHERE ${whereParts.join(" AND ")}
      LIMIT 500
    `;

    const { rows } = await pool.query(sql, params);

    const results = rows
      .map(mapRowToDeal)
      .map((deal) => ({
        ...deal,
        _score: scoreDeal(deal, rawQuery),
      }))
      .filter((deal) => deal._score > 0)
      .sort((a, b) => {
        if (b._score !== a._score) return b._score - a._score;

        const aDiscount = Number.isFinite(a.discountPercent) ? a.discountPercent : -1;
        const bDiscount = Number.isFinite(b.discountPercent) ? b.discountPercent : -1;
        if (bDiscount !== aDiscount) return bDiscount - aDiscount;

        const aPrice = Number.isFinite(a.salePrice) ? a.salePrice : Infinity;
        const bPrice = Number.isFinite(b.salePrice) ? b.salePrice : Infinity;
        if (aPrice !== bPrice) return aPrice - bPrice;

        return `${a.brand} ${a.model}`.localeCompare(`${b.brand} ${b.model}`);
      })
      .slice(0, 120)
      .map(({ _score, ...deal }) => deal);

    return res.status(200).json({
      query: rawQuery,
      results,
    });
  } catch (error) {
    console.error("api/search error:", error);
    return res.status(500).json({ error: "Search failed" });
  }
};
