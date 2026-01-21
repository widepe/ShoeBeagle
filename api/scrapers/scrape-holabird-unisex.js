const { put } = require("@vercel/blob");
const { scrapeHolabirdCollection } = require("./_holabirdShared");

// If Holabird uses a different tag, change it here.
const UNISEX_RUNNING =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Unisex+Type_Running-Shoes+";

const UNISEX_TRAIL =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Unisex+Type_Trail-Running-Shoes+";

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const start = Date.now();

  try {
    const all = [];

    const running = await scrapeHolabirdCollection({
      collectionUrl: UNISEX_RUNNING,
      maxPages: 8,
      storeName: "Holabird Sports",
    });
    all.push(...running);

    const trail = await scrapeHolabirdCollection({
      collectionUrl: UNISEX_TRAIL,
      maxPages: 8,
      storeName: "Holabird Sports",
    });
    all.push(...trail);

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
      segment: "unisex",
      totalDeals: deduped.length,
      deals: deduped,
    };

    const blob = await put("holabird-unisex.json", JSON.stringify(output, null, 2), {
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
