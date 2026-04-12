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

function normalizeStr(value) {
  return String(value || "").trim().toLowerCase();
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

  try {
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
      WHERE COALESCE(brand, '') <> ''
         OR COALESCE(model, '') <> ''
      ORDER BY brand ASC, model ASC, sale_price ASC NULLS LAST
      LIMIT 5000
    `;

    const { rows } = await pool.query(sql);
    const deals = rows.map(mapRowToDeal);

    return res.status(200).json({
      deals,
    });
  } catch (error) {
    console.error("api/search-index error:", error);
    return res.status(500).json({ error: "Search index failed" });
  }
};
