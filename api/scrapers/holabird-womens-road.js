// /api/scrapers/holabird-womens-road.js
const { put } = require("@vercel/blob");
const { scrapeHolabirdCollection, dedupeByUrl } = require("./_holabirdShared");

const WOMENS_ROAD =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Womens+Type_Running-Shoes+";

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
      collectionUrl: WOMENS_ROAD,
      maxPages: 80,
      stopAfterEmptyPages: 2,

      // ✅ womens-road guarantees
      fixedGender: "womens",
      fixedShoeType: "road",

      // ✅ exclude gift-card promos
      excludeGiftCard: true,

      // ✅ only true sale+regular markdown tiles
      requireStructuredSaleCompare: true,

      // ✅ avoid heuristic fallback accidentally including non-sale tiles
      allowHeuristicFallback: false,
    });

    const deduped = dedupeByUrl(deals);

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "Holabird Sports",
      segment: "womens-road",
      totalDeals: deduped.length,
      deals: deduped,
    };

    const blob = await put("holabird-womens-road.json", JSON.stringify(output, null, 2), {
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
