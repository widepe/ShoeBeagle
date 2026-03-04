// /api/scrapers/holabird-mens-road.js
const { put } = require("@vercel/blob");
const { scrapeHolabirdCollection, dedupeByUrl, buildTopLevel } = require("./_holabirdShared");

const MENS_ROAD =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Mens+Type_Running-Shoes+";

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // ✅ COMMENTED OUT FOR TESTING (per request)
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const start = Date.now();

  try {
    const r = await scrapeHolabirdCollection({
      collectionUrl: MENS_ROAD,
      shoeType: "road",

      // Gender comes from card/title. Fallback only if missing token.
      fallbackGender: "mens",

      // You previously had high maxPages because HTML pagination is expensive.
      // With Searchanise API, each page is 250 items, so maxPages=80 is still OK,
      // but you'll likely hit the totalItems boundary long before.
      maxPages: 80,
      stopAfterEmptyPages: 2,

      excludeGiftCard: true,

      // ⚠️ IMPORTANT:
      // If your shared scraper currently expects "structured sale/compare" *from HTML*,
      // that can accidentally drop everything for Searchanise if list_price isn't mapped.
      // If your shared code already maps price/list_price -> sale/original, leave this true.
      // If you're still seeing dealsExtracted=0, flip to false.
      requireStructuredSaleCompare: true,
    });

    // If your shared scraper returns "all items" and not only deals,
    // you can enforce deal logic here too.
    // (If shared already enforces this, this won't change anything.)
    const filteredDeals = (r.deals || []).filter((d) => {
      if (!d) return false;
      if (!Number.isFinite(d.salePrice) || d.salePrice <= 0) return false;
      if (!Number.isFinite(d.originalPrice) || d.originalPrice <= 0) return false;
      if (d.salePrice >= d.originalPrice) return false;
      if (!d.listingURL) return false;
      if (!d.listingName) return false;
      return true;
    });

    const deduped = dedupeByUrl(filteredDeals);
    const durationMs = Date.now() - start;

    // ✅ TOP-LEVEL STRUCTURE:
    // buildTopLevel should produce:
    // store, schemaVersion, lastUpdated, via, sourceUrls, pagesFetched,
    // dealsFound, dealsExtracted, scrapeDurationMs, ok, error, (plus deals/pageNotes if included)
    const output = buildTopLevel({
      via: "searchanise", // was "cheerio"
      sourceUrls: r.sourceUrls,
      pagesFetched: r.pagesFetched,
      dealsFound: r.dealsFound,
      dealsExtracted: deduped.length,
      scrapeDurationMs: durationMs,
      ok: true,
      error: null,
      deals: deduped,

      // If your buildTopLevel supports it, include pageNotes too.
      // If it doesn't, it will just ignore this property.
      pageNotes: r.pageNotes,
    });

    const blob = await put("holabird-mens-road.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      ok: true,
      store: output.store,
      dealsExtracted: output.dealsExtracted,
      pagesFetched: output.pagesFetched,
      dealsFound: output.dealsFound,
      scrapeDurationMs: output.scrapeDurationMs,
      blobUrl: blob.url,
      lastUpdated: output.lastUpdated,
    });
  } catch (err) {
    const durationMs = Date.now() - start;

    const output = buildTopLevel({
      via: "searchanise",
      sourceUrls: [MENS_ROAD, "https://searchserverapi.com/getresults"],
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

    return res.status(500).json({ ok: false, error: output.error });
  }
};
