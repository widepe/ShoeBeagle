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
  const runIso = new Date().toISOString();

  // Mizuno-style top-level envelope (consistent even on failure)
  const output = {
    store: "Holabird Sports",
    schemaVersion: 1,

    lastUpdated: runIso,
    via: "cheerio",

    sourceUrls: [WOMENS_ROAD],

    // Can't know exactly without instrumenting _holabirdShared.js
    pagesFetched: null,

    // Without shared instrumentation we only have final extracted deals.
    // Keep fields consistent + honest:
    dealsFound: 0,
    dealsExtracted: 0,

    scrapeDurationMs: 0,

    ok: false,
    error: null,

    deals: [],
  };

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

    const durationMs = Date.now() - start;

    output.scrapeDurationMs = durationMs;
    output.ok = true;
    output.error = null;
    output.deals = deduped;

    // No pre-filter count available without changing shared; set equal.
    output.dealsFound = deduped.length;
    output.dealsExtracted = deduped.length;

    const blob = await put("holabird-womens-road.json", JSON.stringify(output, null, 2), {
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

    // Still try to write the same envelope on failure
    try {
      const blob = await put("holabird-womens-road.json", JSON.stringify(output, null, 2), {
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
