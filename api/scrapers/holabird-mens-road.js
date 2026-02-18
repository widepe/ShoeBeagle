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
  const runIso = new Date().toISOString();

  // Build the Mizuno-style top-level envelope FIRST (so even errors write consistent shape)
  const output = {
    store: "Holabird Sports",
    schemaVersion: 1,

    lastUpdated: runIso,
    via: "cheerio",

    sourceUrls: [MENS_ROAD],

    // We cannot know exact pages fetched without instrumenting _holabirdShared.js,
    // but we keep the field to match the Mizuno envelope.
    pagesFetched: null,

    // dealsFound = items encountered before final filtering
    // For this endpoint we only have "final deals" available without changing shared.
    // We'll set dealsFound = dealsExtracted for now (truthful + consistent).
    dealsFound: 0,
    dealsExtracted: 0,

    scrapeDurationMs: 0,

    ok: false,
    error: null,

    // IMPORTANT: keep deals at top level like Mizuno
    deals: [],
  };

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

    const durationMs = Date.now() - start;

    output.scrapeDurationMs = durationMs;
    output.ok = true;
    output.error = null;

    output.deals = deduped;

    // Without changing _holabirdShared.js we only know the extracted count.
    // To keep "dealsFound vs dealsExtracted" semantics, we set both equal here.
    output.dealsFound = deduped.length;
    output.dealsExtracted = deduped.length;

    const blob = await put("holabird-mens-road.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: output.store,
      schemaVersion: output.schemaVersion,
      lastUpdated: output.lastUpdated,
      via: output.via,
      dealsFound: output.dealsFound,
      dealsExtracted: output.dealsExtracted,
      scrapeDurationMs: output.scrapeDurationMs,
      ok: output.ok,
      error: output.error,
      blobUrl: blob.url,
    });
  } catch (err) {
    const durationMs = Date.now() - start;

    output.scrapeDurationMs = durationMs;
    output.ok = false;
    output.error = err?.message || String(err);
    output.deals = [];
    output.dealsFound = 0;
    output.dealsExtracted = 0;

    // Even on failure, try to write a blob with the same envelope
    try {
      const blob = await put("holabird-mens-road.json", JSON.stringify(output, null, 2), {
        access: "public",
        addRandomSuffix: false,
      });

      return res.status(500).json({
        success: false,
        store: output.store,
        schemaVersion: output.schemaVersion,
        lastUpdated: output.lastUpdated,
        via: output.via,
        dealsFound: output.dealsFound,
        dealsExtracted: output.dealsExtracted,
        scrapeDurationMs: output.scrapeDurationMs,
        ok: output.ok,
        error: output.error,
        blobUrl: blob.url,
      });
    } catch (writeErr) {
      return res.status(500).json({
        success: false,
        error: output.error,
        writeError: writeErr?.message || String(writeErr),
        store: output.store,
        schemaVersion: output.schemaVersion,
        lastUpdated: output.lastUpdated,
        via: output.via,
        scrapeDurationMs: output.scrapeDurationMs,
      });
    }
  }
};
