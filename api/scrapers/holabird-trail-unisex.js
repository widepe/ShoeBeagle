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
  const runIso = new Date().toISOString();

  const sourceUrls = [
    WOMENS_TRAIL,
    MENS_TRAIL,
    UNISEX_TRAIL,
    UNISEX_ROAD,
  ];

  // Mizuno-style envelope (consistent even on failure)
  const output = {
    store: "Holabird Sports",
    schemaVersion: 1,

    lastUpdated: runIso,
    via: "cheerio",

    sourceUrls,

    // Not available without instrumenting shared scraper
    pagesFetched: null,

    dealsFound: 0,
    dealsExtracted: 0,

    scrapeDurationMs: 0,

    ok: false,
    error: null,

    deals: [],
  };

  try {
    const all = [];

    const common = {
      maxPages: 80,
      stopAfterEmptyPages: 2,
      excludeGiftCard: true,
      requireStructuredSaleCompare: true,
      allowHeuristicFallback: false,
    };

    // Womens Trail
    all.push(
      ...(await scrapeHolabirdCollection({
        collectionUrl: WOMENS_TRAIL,
        ...common,
        fixedGender: "womens",
        fixedShoeType: "trail",
      }))
    );

    // Mens Trail
    all.push(
      ...(await scrapeHolabirdCollection({
        collectionUrl: MENS_TRAIL,
        ...common,
        fixedGender: "mens",
        fixedShoeType: "trail",
      }))
    );

    // Unisex Trail
    all.push(
      ...(await scrapeHolabirdCollection({
        collectionUrl: UNISEX_TRAIL,
        ...common,
        fixedGender: "unisex",
        fixedShoeType: "trail",
      }))
    );

    // Unisex Road
    all.push(
      ...(await scrapeHolabirdCollection({
        collectionUrl: UNISEX_ROAD,
        ...common,
        fixedGender: "unisex",
        fixedShoeType: "road",
      }))
    );

    const deduped = dedupeByUrl(all);
    const durationMs = Date.now() - start;

    output.scrapeDurationMs = durationMs;
    output.ok = true;
    output.error = null;
    output.deals = deduped;

    // Without modifying shared scraper, these must match extracted
    output.dealsFound = deduped.length;
    output.dealsExtracted = deduped.length;

    const blob = await put(
      "holabird-trail-unisex.json",
      JSON.stringify(output, null, 2),
      {
        access: "public",
        addRandomSuffix: false,
      }
    );

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

    try {
      const blob = await put(
        "holabird-trail-unisex.json",
        JSON.stringify(output, null, 2),
        {
          access: "public",
          addRandomSuffix: false,
        }
      );

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
