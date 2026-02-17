// /api/scrapers/holabird-trail-unisex.js
const { put } = require("@vercel/blob");
const { scrapeHolabirdCollection, dedupeByUrl } = require("./_holabirdShared");

const WOMENS_TRAIL =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Womens+Type_Trail-Running-Shoes+";
const MENS_TRAIL =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Mens+Type_Trail-Running-Shoes+";
const UNISEX_TRAIL =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Unisex+Type_Trail-Running-Shoes+";
const UNISEX_ROAD =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Unisex+Type_Running-Shoes+";

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
    const all = [];

    // Common scrape options for Holabird:
    // - exclude gift card promos
    // - only accept true sale+regular tiles
    // - disable heuristic fallback to avoid accidental inclusions
    const common = {
      maxPages: 80,
      stopAfterEmptyPages: 2,
      excludeGiftCard: true,
      requireStructuredSaleCompare: true,
      allowHeuristicFallback: false,
    };

    // Womens trail: all shoeType trail
    all.push(
      ...(await scrapeHolabirdCollection({
        collectionUrl: WOMENS_TRAIL,
        ...common,
        fixedGender: "womens",
        fixedShoeType: "trail",
      }))
    );

    // Mens trail: all shoeType trail
    all.push(
      ...(await scrapeHolabirdCollection({
        collectionUrl: MENS_TRAIL,
        ...common,
        fixedGender: "mens",
        fixedShoeType: "trail",
      }))
    );

    // Unisex trail: shoeType trail (in URL)
    all.push(
      ...(await scrapeHolabirdCollection({
        collectionUrl: UNISEX_TRAIL,
        ...common,
        fixedGender: "unisex",
        fixedShoeType: "trail",
      }))
    );

    // Unisex road: shoeType road (in URL)
    all.push(
      ...(await scrapeHolabirdCollection({
        collectionUrl: UNISEX_ROAD,
        ...common,
        fixedGender: "unisex",
        fixedShoeType: "road",
      }))
    );

    const deduped = dedupeByUrl(all);

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "Holabird Sports",
      segment: "trail-and-unisex",
      totalDeals: deduped.length,
      deals: deduped,
    };

    const blob = await put("holabird-trail-unisex.json", JSON.stringify(output, null, 2), {
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
