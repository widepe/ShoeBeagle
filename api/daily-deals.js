// api/daily-deals.js
const axios = require("axios");

// ============================================================================
// DATE-BASED SEEDED RANDOM FUNCTIONS
// ============================================================================
// These functions ensure that "random" selections stay the same all day long.
// 
// How it works:
// 1. Use today's date (e.g., "2026-01-09") as a seed
// 2. Convert date to a number (sum of character codes)
// 3. Generate "random" numbers based on this seed
// 4. Same seed = same "random" numbers = same deals all day
// 5. New day = new seed = new "random" numbers = new deals
//
// Why this matters:
// - Users see the same deals all day (no confusion when refreshing page)
// - Deals change automatically at midnight (no manual updates needed)
// - No database needed to remember which deals were selected
// - All users see the same deals (consistent experience)
// ============================================================================

// Simple seeded random number generator
// Same seed always produces same sequence of "random" numbers
function seededRandom(seed) {
  const x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

// Randomly sample from array using date-based seed
// Returns same results all day, different results each day
function getRandomSample(array, count) {
  if (!array || array.length === 0) return [];
  
  // Use today's date as seed (YYYY-MM-DD format, changes at midnight UTC)
  const today = new Date().toISOString().split('T')[0]; // e.g., "2026-01-09"
  
  // Convert date string to number seed
  let seed = 0;
  for (let i = 0; i < today.length; i++) {
    seed += today.charCodeAt(i);
  }
  
  const copy = [...array];
  const picked = [];

  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const rng = seededRandom(seed + i);
    const idx = Math.floor(rng * copy.length);
    picked.push(copy[idx]);
    copy.splice(idx, 1);
  }

  return picked;
}

// Parse price fields that might be numbers or strings like "$99.88"
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
    deal.image &&
    typeof deal.image === "string" &&
    deal.image.trim() &&
    !deal.image.includes("no-image") &&
    !deal.image.includes("placeholder")
  );
}

function isDiscounted(deal) {
  const price = parseMoney(deal.price);
  const original = parseMoney(deal.originalPrice);
  if (deal.discount && typeof deal.discount === "string") return true;
  if (Number.isFinite(price) && Number.isFinite(original) && original > price) {
    return true;
  }
  return false;
}

module.exports = async (req, res) => {
  const requestId = `${req.headers["x-vercel-id"] || "local"}-${Date.now()}`;

  try {
    console.log("[/api/daily-deals] Request started", { requestId });

    const blobUrl = "https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/deals.json";

    let dealsData;
    try {
      const resp = await axios.get(blobUrl, { timeout: 8000 });
      dealsData = resp.data;
    } catch (fetchErr) {
      console.error("[/api/daily-deals] Failed to fetch blob:", {
        requestId,
        error: fetchErr.message,
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
    });

    if (allDeals.length === 0) {
      return res.status(200).json({
        deals: [],
        total: 0,
        message: "No deals available",
        requestId,
      });
    }

    // ========================================================================
    // DAILY DEALS SELECTION STRATEGY
    // ========================================================================
    // Goal: Show 12 high-quality deals that change once per day (at midnight)
    //
    // Selection Method (4 + 4 + 4):
    // 1. Sort by HIGHEST PERCENTAGE OFF → take top 20 → RANDOMLY PICK 4 from those 20
    // 2. Sort by BIGGEST DOLLAR SAVINGS → take top 20 → RANDOMLY PICK 4 from those 20 (no duplicates)
    // 3. From all remaining deals → RANDOMLY PICK 4 (for variety/discovery)
    //
    // Why this approach:
    // - Guarantees quality: 8 deals come from top 20 pools (best discounts)
    // - Provides variety: Random selection within pools means different deals daily
    // - Ensures discovery: 4 completely random deals expose lesser-known deals
    // - No duplicates: Each step excludes previous selections
    // - Changes daily: Date-based random seed picks different deals each day
    // - Fair exposure: All top 20 deals get rotated through over time
    //
    // Example with 56 deals:
    // - Day 1: Picks deals #3, #7, #12, #18 from top 20% pool
    // - Day 2: Picks deals #1, #5, #14, #19 from top 20% pool (different!)
    //
    // Display order: All 12 shuffled randomly (same shuffle all day)
    // ========================================================================

    const qualityDeals = allDeals.filter(
      (d) => hasGoodImage(d) && isDiscounted(d) && d.originalPrice && d.price
    );

    // If we don't have enough quality deals, use all deals with images
    const workingPool = qualityDeals.length >= 12 
      ? qualityDeals 
      : allDeals.filter(hasGoodImage);

    console.log("[/api/daily-deals] Working pool size:", workingPool.length);

    // Safety check: if we have fewer than 12 deals total, just return what we have
    if (workingPool.length < 12) {
      const shuffled = getRandomSample(workingPool, workingPool.length);
      const selected = shuffled.map((deal) => {
        const price = parseMoney(deal.price);
        const original = parseMoney(deal.originalPrice);
        let discountLabel = deal.discount || null;
        if (!discountLabel && Number.isFinite(price) && Number.isFinite(original) && original > 0) {
          const pct = Math.round(100 * (1 - price / original));
          if (pct > 0) {
            discountLabel = `${pct}% OFF`;
          }
        }
        return {
          title: deal.title || "Running Shoe Deal",
          brand: deal.brand || "",
          model: deal.model || "",
          store: deal.store || "Store",
          price: Number.isFinite(price) ? price : 0,
          originalPrice: Number.isFinite(original) ? original : null,
          discount: discountLabel,
          image: deal.image || "",
          url: deal.url || "#",
        };
      });

      return res.status(200).json({
        deals: selected,
        total: selected.length,
        requestId,
      });
    }

    // 1) TOP 20 BY PERCENTAGE OFF → Pick random 4
const top20ByPercent = [...workingPool]
  .sort((a, b) => {
    const pctA = a.originalPrice && a.price 
      ? ((a.originalPrice - a.price) / a.originalPrice) * 100 
      : 0;
    const pctB = b.originalPrice && b.price 
      ? ((b.originalPrice - b.price) / b.originalPrice) * 100 
      : 0;
    return pctB - pctA;
  })
  .slice(0, Math.min(20, workingPool.length));

const byPercent = getRandomSample(top20ByPercent, Math.min(4, top20ByPercent.length));

// 2) TOP 20 BY DOLLAR SAVINGS → Pick random 4 (excluding already picked)
const alreadyPicked = new Set(byPercent);

const top20ByDollar = [...workingPool]
  .filter(d => !alreadyPicked.has(d))
  .sort((a, b) => {
    const savingsA = (a.originalPrice || 0) - (a.price || 0);
    const savingsB = (b.originalPrice || 0) - (b.price || 0);
    return savingsB - savingsA;
  })
  .slice(0, 20);

const byDollar = getRandomSample(top20ByDollar, Math.min(4, top20ByDollar.length));

// Update the set - FIXED THIS LINE
byDollar.forEach(d => alreadyPicked.add(d)); // ✅ Correct way to add multiple items

// 3) 4 RANDOM from remaining (excluding already picked)
const remaining = workingPool.filter(d => !alreadyPicked.has(d));
const randomPicks = getRandomSample(remaining, Math.min(4, remaining.length));

    // Combine all deals (might be less than 12 if pool is small)
    const selectedRaw = [...byPercent, ...byDollar, ...randomPicks];
    
    // Shuffle using the same date-based seed so order stays same all day
    const today = new Date().toISOString().split('T')[0];
    let shuffleSeed = 999; // Different seed than selection
    for (let i = 0; i < today.length; i++) {
      shuffleSeed += today.charCodeAt(i) * 7;
    }
    
    // Fisher-Yates shuffle with seed
    const shuffled = [...selectedRaw];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const rng = seededRandom(shuffleSeed + i);
      const j = Math.floor(rng * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    const selected = shuffled.map((deal) => {
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
        title: deal.title || "Running Shoe Deal",
        brand: deal.brand || "",
        model: deal.model || "",
        store: deal.store || "Store",
        price: Number.isFinite(price) ? price : 0,
        originalPrice: Number.isFinite(original) ? original : null,
        discount: discountLabel,
        image: deal.image || "",
        url: deal.url || "#",
      };
    });

    console.log("[/api/daily-deals] Returning deals:", {
      requestId,
      count: selected.length,
    });

    return res.status(200).json({
      deals: selected,
      total: selected.length,
      requestId,
    });

  } catch (error) {
    console.error("[/api/daily-deals] Unexpected error:", {
      requestId,
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      error: "Unexpected error in daily deals endpoint",
      requestId,
    });
  }
};
