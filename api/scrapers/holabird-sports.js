// /api/scrapers/holabird-mens-road.js
const { put } = require("@vercel/blob");
const { scrapeHolabirdCollection, dedupeByUrl, buildTopLevel } = require("./_holabirdShared");

/*
Segments define shoeType by URL.
Gender is NOT forced — shared parser determines it.
*/

const SEGMENTS = [
  // ROAD
  {
    url: "https://www.holabirdsports.com/collections/shoe-deals/Gender_Mens+Type_Running-Shoes+",
    shoeType: "road"
  },
  {
    url: "https://www.holabirdsports.com/collections/shoe-deals/Type_Running-Shoes+Gender_Womens+",
    shoeType: "road"
  },
  {
    url: "https://www.holabirdsports.com/collections/shoe-deals/Type_Running-Shoes+Gender_Unisex+",
    shoeType: "road"
  },

  // TRAIL
  {
    url: "https://www.holabirdsports.com/collections/shoe-deals/Gender_Mens+Type_Trail-Running-Shoes+",
    shoeType: "trail"
  },
  {
    url: "https://www.holabirdsports.com/collections/shoe-deals/Type_Trail-Running-Shoes+Gender_Womens+",
    shoeType: "trail"
  },
  {
    url: "https://www.holabirdsports.com/collections/shoe-deals/Type_Trail-Running-Shoes+Gender_Unisex+",
    shoeType: "trail"
  }
];

module.exports = async (req, res) => {

  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // CRON SECRET DISABLED FOR TESTING
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const start = Date.now();

  try {

    let allDeals = [];
    let pagesFetched = 0;
    let dealsFound = 0;
    let sourceUrls = [];
    let pageNotes = [];

    for (const segment of SEGMENTS) {

      const r = await scrapeHolabirdCollection({
        collectionUrl: segment.url,
        shoeType: segment.shoeType,

        fallbackGender: "mens",

        maxPages: 80,
        stopAfterEmptyPages: 2,
        excludeGiftCard: true,
        requireStructuredSaleCompare: true
      });

      pagesFetched += r.pagesFetched;
      dealsFound += r.dealsFound;

      sourceUrls.push(segment.url);

      if (Array.isArray(r.pageNotes)) {
        pageNotes.push(...r.pageNotes);
      }

      const filtered = (r.deals || []).filter((d) => {
        if (!d) return false;
        if (!Number.isFinite(d.salePrice) || d.salePrice <= 0) return false;
        if (!Number.isFinite(d.originalPrice) || d.originalPrice <= 0) return false;
        if (d.salePrice >= d.originalPrice) return false;
        if (!d.listingURL) return false;
        if (!d.listingName) return false;
        return true;
      });

      // Force shoeType from segment URL
      const normalized = filtered.map((d) => ({
        ...d,
        shoeType: segment.shoeType
      }));

      allDeals.push(...normalized);
    }

    const deduped = dedupeByUrl(allDeals);

    const durationMs = Date.now() - start;

    const output = buildTopLevel({
      via: "searchanise",
      sourceUrls,
      pagesFetched,
      dealsFound,
      dealsExtracted: deduped.length,
      scrapeDurationMs: durationMs,
      ok: true,
      error: null,
      deals: deduped,
      pageNotes
    });

    const blob = await put("holabird-shoe-deals.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false
    });

    return res.status(200).json({
      ok: true,
      store: output.store,
      dealsExtracted: output.dealsExtracted,
      pagesFetched: output.pagesFetched,
      dealsFound: output.dealsFound,
      scrapeDurationMs: output.scrapeDurationMs,
      blobUrl: blob.url,
      lastUpdated: output.lastUpdated
    });

  } catch (err) {

    const durationMs = Date.now() - start;

    const output = buildTopLevel({
      via: "searchanise",
      sourceUrls: SEGMENTS.map(s => s.url),
      pagesFetched: 0,
      dealsFound: 0,
      dealsExtracted: 0,
      scrapeDurationMs: durationMs,
      ok: false,
      error: err?.message || String(err),
      deals: []
    });

    await put("holabird-shoe-deals.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false
    });

    return res.status(500).json({ ok: false, error: output.error });
  }
};
