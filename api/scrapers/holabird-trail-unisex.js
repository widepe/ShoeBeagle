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
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

const auth = req.headers.authorization;
if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  return res.status(401).json({ success: false, error: "Unauthorized" });
}


  const start = Date.now();

  try {
    const all = [];

    // 4 collections; keep delays inside helper small so this stays fast.
    all.push(
      ...(await scrapeHolabirdCollection({ collectionUrl: WOMENS_TRAIL, maxPages: 80, stopAfterEmptyPages: 2 }))
    );
    all.push(
      ...(await scrapeHolabirdCollection({ collectionUrl: MENS_TRAIL, maxPages: 80, stopAfterEmptyPages: 2 }))
    );
    all.push(
      ...(await scrapeHolabirdCollection({ collectionUrl: UNISEX_TRAIL, maxPages: 80, stopAfterEmptyPages: 2 }))
    );
    all.push(
      ...(await scrapeHolabirdCollection({ collectionUrl: UNISEX_ROAD, maxPages: 80, stopAfterEmptyPages: 2 }))
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
    return res.status(500).json({ success: false, error: err.message });
  }
};
