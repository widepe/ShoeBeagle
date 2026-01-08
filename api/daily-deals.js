// api/daily-deals.js
const axios = require("axios");

// Parse price fields that might be numbers or strings like "$99.88"
function parseMoney(value) {
  if (value === null || value === undefined) return NaN;
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : NaN;
}

function hasGoodImage(deal) {
  if (!deal || typeof deal.image !== "string") return false;
  const img = deal.image.trim();
  if (!img) return false;
  if (!/^https?:\/\//i.test(img)) return false;
  if (img.toLowerCase().includes("no-image")) return false;
  return true;
}

// "Discounted" = either numeric markdown OR a non–"Full Price" discount label
function isDiscounted(deal) {
  if (!deal) return false;

  const price = parseMoney(deal.price);
  const original = parseMoney(deal.originalPrice);

  const numericDiscount =
    Number.isFinite(price) &&
    Number.isFinite(original) &&
    original > price;

  if (numericDiscount) return true;

  if (typeof deal.discount === "string") {
    const txt = deal.discount.trim();
    if (!txt) return false;
    if (/full price/i.test(txt)) return false;
    // Any non-empty discount label that isn't "Full Price" counts as a discount
    return true;
  }

  return false;
}

// Robustly extract the deals array from blob response
function extractDeals(dealsData) {
  // Shape A: { deals: [...] }
  if (dealsData && Array.isArray(dealsData.deals)) {
    return dealsData.deals;
  }

  // Shape B: [ { deals: [...] } ]
  if (Array.isArray(dealsData) && dealsData.length > 0 && Array.isArray(dealsData[0].deals)) {
    return dealsData[0].deals;
  }

  return [];
}

// Simple string hash for deterministic selection
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0; // unsigned 32-bit
  }
  return hash >>> 0;
}

// Deterministic "8 for today" picker
function pickDailyEight(pool) {
  if (!pool.length) return [];

  const todayKey = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const hash = hashString(todayKey);
  const count = Math.min(8, pool.length);

  const selected = [];
  for (let i = 0; i < count; i++) {
    const idx = (hash + i) % pool.length;
    selected.push(pool[idx]);
  }

  return selected;
}

module.exports = async (req, res) => {
  const requestId =
    (req.headers && (req.headers["x-vercel-id"] || req.headers["x-request-id"])) ||
    `local-${Date.now()}`;

  const startedAt = Date.now();

  try {
    const blobUrl =
      "https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/deals-xYNKTRtjMYCwJbor5T63ZCNKf6cFjE.json";

    let dealsData;
    try {
      const response = await axios.get(blobUrl);
      dealsData = response.data;
    } catch (blobError) {
      console.error("[/api/daily-deals] Error fetching from blob:", {
        requestId,
        message: blobError.message,
      });
      return res.status(500).json({
        error: "Failed to load deals data",
        requestId,
      });
    }

    const allDeals = extractDeals(dealsData);

    console.log("[/api/daily-deals] Loaded deals:", {
      requestId,
      total: allDeals.length,
      shape: Array.isArray(dealsData) ? "array-root" : "object-root",
    });

    // ✅ Your rule: only show *discounted* shoes with images.
    const discountedWithImages = allDeals.filter(
      (d) => hasGoodImage(d) && isDiscounted(d)
    );

    // Deterministic daily selection from this filtered pool
    const pool = discountedWithImages;
    const selectedRaw = pickDailyEight(pool);

    const selected = selectedRaw.map((deal) => {
      const price = parseMoney(deal.price);
      const original = parseMoney(deal.originalPrice);

      let discountLabel = deal.discount || null;
      // Compute % OFF if we have numeric markdown and no label
      if (!discountLabel && Number.isFinite(price) && Number.isFinite(original) && original > 0) {
        const pct = Math.round(100 * (1 - price / original));
        if (pct > 0) {
          discountLabel = `${pct}% OFF`;
        }
      }

      return {
        title: deal.title,
        price: Number.isFinite(price) ? price : null,
        originalPrice: Number.isFinite(original) ? original : null,
        discount: discountLabel,
        store: deal.store,
        url: deal.url,
        image: deal.image,
        brand: deal.brand,
        model: deal.model,
      };
    });

    const elapsedMs = Date.now() - startedAt;
    console.log("[/api/daily-deals] Response:", {
      requestId,
      elapsedMs,
      totalDeals: allDeals.length,
      discountedWithImages: discountedWithImages.length,
      picked: selected.length,
    });

    return res.status(200).json({
      requestId,
      elapsedMs,
      totalDeals: allDeals.length,
      totalDiscountedWithImages: discountedWithImages.length,
      deals: selected,
    });
  } catch (err) {
    console.error("[/api/daily-deals] Fatal error:", {
      requestId,
      message: err?.message || String(err),
      stack: err?.stack,
    });

    return res.status(500).json({
      error: "Unexpected error in daily deals endpoint",
      requestId,
    });
  }
};
