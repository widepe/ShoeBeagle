// api/daily-deals.js
const axios = require("axios");

// Simple random sampler without modifying original array
function getRandomSample(array, count) {
  const copy = [...array];
  const picked = [];

  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    picked.push(copy[idx]);
    copy.splice(idx, 1);
  }

  return picked;
}

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
    return true;
  }

  return false;
}

module.exports = async (req, res) => {
  const requestId =
    (req.headers && (req.headers["x-vercel-id"] || req.headers["x-request-id"])) ||
    `local-${Date.now()}`;

  const startedAt = Date.now();

  try {
    // FIXED: Now points to the consistent deals.json URL (no random suffix)
    const blobUrl =
      "https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/deals.json";

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

    // Extract deals array from the response
    const allDeals = (dealsData && Array.isArray(dealsData.deals))
      ? dealsData.deals
      : (dealsData && dealsData.deals) || [];

    console.log("[/api/daily-deals] Loaded deals:", {
      requestId,
      total: allDeals.length,
      hasDealsField: !!dealsData?.deals,
    });

    // 1) Preferred: discounted + image
    const discountedWithImages = allDeals.filter(
      (d) => hasGoodImage(d) && isDiscounted(d)
    );

    // 2) Fallback: image only
    const withImagesOnly =
      discountedWithImages.length === 0
        ? allDeals.filter(hasGoodImage)
        : [];

    // 3) Final pool: prefer discountedWithImages, else withImagesOnly, else allDeals
    let pool = discountedWithImages;
    let poolReason = "discountedWithImages";

    if (pool.length === 0) {
      pool = withImagesOnly;
      poolReason = "withImagesOnly";
    }
    if (pool.length === 0) {
      pool = allDeals;
      poolReason = "allDeals";
    }

    const selectedRaw = getRandomSample(pool, 8);

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
      withImagesOnly: withImagesOnly.length,
      poolReason,
      picked: selected.length,
    });

    return res.status(200).json({
      requestId,
      elapsedMs,
      totalDeals: allDeals.length,
      discountedWithImages: discountedWithImages.length,
      withImagesOnly: withImagesOnly.length,
      poolReason,
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
