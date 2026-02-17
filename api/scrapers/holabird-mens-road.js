// /api/scrapers/holabird-mens-road.js
const { put } = require("@vercel/blob");
const { scrapeHolabirdCollection, dedupeByUrl } = require("./_holabirdShared");

// Mens road deals collection
const MENS_ROAD =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Mens+Type_Running-Shoes+";

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const start = Date.now();

  try {
    const deals = await scrapeHolabirdCollection({
      collectionUrl: MENS_ROAD,
      maxPages: 80, // “all pages” attempt (stops early when empty)
      stopAfterEmptyPages: 2,

      // ✅ Mens-road specific guarantees
      fixedGender: "mens",
      fixedShoeType: "road",

      // ✅ You said you do NOT want gift-card promos
      excludeGiftCard: true,

      // ✅ Only accept true markdown tiles that show both Sale + Regular
      requireStructuredSaleCompare: true,

      // ✅ Heuristic fallback can accidentally include non-sale tiles; keep it off for this endpoint
      allowHeuristicFallback: false,
    });

    const deduped = dedupeByUrl(deals);

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "Holabird Sports",
      segment: "mens-road",
      totalDeals: deduped.length,
      deals: deduped,
    };

    const blob = await put("holabird-mens-road.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      totalDeals: deduped.length,
      blobUrl: blob.url,
      duration: `${Date.now() - start}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err?.message || String(err),
    });
  }
};
