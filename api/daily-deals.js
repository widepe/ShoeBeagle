// api/daily-deals.js
const axios = require("axios");

// simple random sampler without modifying original array
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

module.exports = async (req, res) => {
  const requestId =
    (req.headers && (req.headers["x-vercel-id"] || req.headers["x-request-id"])) ||
    `local-${Date.now()}`;

  const startedAt = Date.now();

  try {
    // Same blob URL used in /api/search
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

    const deals = Array.isArray(dealsData.deals) ? dealsData.deals : [];

    // ✅ Filter to only discounted deals WITH images
    const discountedWithImages = deals.filter((d) => {
      if (!d) return false;

      // Require an image
      if (typeof d.image !== "string") return false;
      const img = d.image.trim();
      if (!img) return false;
      if (!/^https?:\/\//i.test(img)) return false;
      if (img.toLowerCase().includes("no-image")) return false; // optional safety

      // Require real markdown
      const price = Number(d.price);
      const original = Number(d.originalPrice);

      if (!Number.isFinite(price) || !Number.isFinite(original)) return false;
      if (!(original > price)) return false; // must actually be marked down

      // Optional: exclude explicit full-price tag if present
      if (typeof d.discount === "string" && d.discount.toLowerCase().includes("full price")) {
        return false;
      }

      return true;
    });

    // Randomly pick up to 8
    const selectedRaw = getRandomSample(discountedWithImages, 8);

    // Normalize fields we send to the client (keep same shape as /api/search)
    const selected = selectedRaw.map((deal) => {
      const price = Number(deal.price);
      const original = Number(deal.originalPrice);
      let discountLabel = deal.discount || null;

      // If discount label missing, compute something like "40% OFF"
      if (!discountLabel && Number.isFinite(price) && Number.isFinite(original) && original > 0) {
        const pct = Math.round(100 * (1 - price / original));
        if (pct > 0) {
          discountLabel = `${pct}% OFF`;
        }
      }

      return {
        title: deal.title,
        price,
        originalPrice: original,
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
      totalDeals: deals.length,
      discountedWithImages: discountedWithImages.length,
      picked: selected.length,
    });

    return res.status(200).json({
      requestId,
      elapsedMs,
      totalDeals: deals.length,
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
