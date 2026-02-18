// /api/scrapers/holabird-trail-unisex.js
const { put } = require("@vercel/blob");
const { scrapeHolabirdCollection, dedupeByUrl, buildTopLevel } = require("./_holabirdShared");

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
    const common = {
      maxPages: 80,
      stopAfterEmptyPages: 2,
      excludeGiftCard: true,
      requireStructuredSaleCompare: true,
    };

    const allDeals = [];
    const allSourceUrls = [];
    let pagesFetchedTotal = 0;
    let dealsFoundTotal = 0;

    // womens trail
    {
      const r = await scrapeHolabirdCollection({
        collectionUrl: WOMENS_TRAIL,
        shoeType: "trail",
        fallbackGender: "womens",
        ...common,
      });
      allDeals.push(...r.deals);
      allSourceUrls.push(...r.sourceUrls);
      pagesFetchedTotal += r.pagesFetched;
      dealsFoundTotal += r.dealsFound;
    }

    // mens trail
    {
      const r = await scrapeHolabirdCollection({
        collectionUrl: MENS_TRAIL,
        shoeType: "trail",
        fallbackGender: "mens",
        ...common,
      });
      allDeals.push(...r.deals);
      allSourceUrls.push(...r.sourceUrls);
      pagesFetchedTotal += r.pagesFetched;
      dealsFoundTotal += r.dealsFound;
    }

    // unisex trail
    {
      const r = await scrapeHolabirdCollection({
        collectionUrl: UNISEX_TRAIL,
        shoeType: "trail",
        fallbackGender: "unisex",
        ...common,
      });
      allDeals.push(...r.deals);
      allSourceUrls.push(...r.sourceUrls);
      pagesFetchedTotal += r.pagesFetched;
      dealsFoundTotal += r.dealsFound;
    }

    // unisex road
    {
      const r = await scrapeHolabirdCollection({
        collectionUrl: UNISEX_ROAD,
        shoeType: "road",
        fallbackGender: "unisex",
        ...common,
      });
      allDeals.push(...r.deals);
      allSourceUrls.push(...r.sourceUrls);
      pagesFetchedTotal += r.pagesFetched;
      dealsFoundTotal += r.dealsFound;
    }

    const deduped = dedupeByUrl(allDeals);
    const durationMs = Date.now() - start;

    // de-dupe sourceUrls
    const sourceUrls = [...new Set(allSourceUrls.filter(Boolean))];

    const output = buildTopLevel({
      via: "cheerio",
      sourceUrls,
      pagesFetched: pagesFetchedTotal,
      dealsFound: dealsFoundTotal,
      dealsExtracted: deduped.length,
      scrapeDurationMs: durationMs,
      ok: true,
      error: null,
      deals: deduped,
    });

    const blob = await put("holabird-trail-unisex.json", JSON.stringify(output, null, 2), {
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
      sourceUrls: [WOMENS_TRAIL, MENS_TRAIL, UNISEX_TRAIL, UNISEX_ROAD],
      pagesFetched: 0,
      dealsFound: 0,
      dealsExtracted: 0,
      scrapeDurationMs: durationMs,
      ok: false,
      error: err?.message || String(err),
      deals: [],
    });

    await put("holabird-trail-unisex.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(500).json({ success: false, error: output.error });
  }
};
