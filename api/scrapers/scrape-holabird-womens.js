const { put } = require("@vercel/blob");
const { scrapeHolabirdCollection } = require("./_holabirdShared");

// Womens URLs you provided:
const WOMENS_RUNNING =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Womens+Type_Running-Shoes+";

const WOMENS_TRAIL =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Womens+Type_Trail-Running-Shoes+";

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const start = Date.now();

  try {
    const all = [];

    // Running
    const running = await scrapeHolabirdCollection({
      collectionUrl: WOMENS_RUNNING,
      maxPages: 8,
      storeName: "Holabird Sports",
    });
    all.push(...running);

    // Trail
    const trail = await scrapeHolabirdCollection({
      collectionUrl: WOMENS_TRAIL,
      maxPages: 8,
      storeName: "Holabird Sports",
    });
    all.push(...trail);

    // Dedup by URL
    const seen = new Set();
    const deduped = [];
    for (const d of all) {
      const k = d?.url;
      if (!k || seen.has(k)) continue;
      seen.add(k);
      deduped.push(d);
    }

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "Holabird Sports",
      segment: "womens",
      totalDeals: deduped.length,
      deals: deduped,
    };

    const blob = await put("holabird-womens.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    const ms = Date.now() - start;

    return res.status(200).json({
      success: true,
      totalDeals: deduped.length,
      blobUrl: blob.url,
      duration: `${ms}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};
