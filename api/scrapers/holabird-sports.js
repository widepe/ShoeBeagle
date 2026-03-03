// /api/scrapers/holabird-mens-road.js
const { put } = require("@vercel/blob");
const { scrapeHolabirdCollection, dedupeByUrl, buildTopLevel } = require("./_holabirdShared");

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
    const r = await scrapeHolabirdCollection({
      collectionUrl: MENS_ROAD,
      shoeType: "road",

      // Gender comes from card title.
      // Fallback only if title doesn’t contain men's token (rare).
      fallbackGender: "mens",

      maxPages: 80,
      stopAfterEmptyPages: 2,
      excludeGiftCard: true,
      requireStructuredSaleCompare: true,
    });

    const deduped = dedupeByUrl(r.deals);
    const durationMs = Date.now() - start;

    const output = buildTopLevel({
      via: "cheerio",
      sourceUrls: r.sourceUrls,
      pagesFetched: r.pagesFetched,
      dealsFound: r.dealsFound,
      dealsExtracted: deduped.length,
      scrapeDurationMs: durationMs,
      ok: true,
      error: null,
      deals: deduped,
    });

    const blob = await put("holabird-mens-road.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      blobUrl: blob.url,
      pagesFetched: output.pagesFetched,
      dealsFound: output.dealsFound,
      dealsExtracted: output.dealsExtracted,
      duration: `${durationMs}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    const output = buildTopLevel({
      via: "cheerio",
      sourceUrls: [MENS_ROAD],
      pagesFetched: 0,
      dealsFound: 0,
      dealsExtracted: 0,
      scrapeDurationMs: durationMs,
      ok: false,
      error: err?.message || String(err),
      deals: [],
    });

    await put("holabird-mens-road.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(500).json({ success: false, error: output.error });
  }
};
