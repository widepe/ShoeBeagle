// api/deals-stats.js
//
// Returns aggregate stats about all scraped Running Warehouse deals:
//
// {
//   totalDeals: number,
//   dealsWithImages: number,
//   off10OrMore: number,
//   off25OrMore: number,
//   off50OrMore: number
// }

const { get } = require("@vercel/blob");

function computeDiscountPercent(deal) {
  const price = Number(deal.price);      // original price
  const sale = Number(deal.salePrice);   // sale price

  if (!Number.isFinite(price) || !Number.isFinite(sale)) return 0;
  if (price <= 0 || sale >= price) return 0;

  const pct = ((price - sale) / price) * 100;
  return Math.round(pct);
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Read the same blob that scrape-daily.js writes to:
    //   "scraped/runningwarehouse/deals.json"
    const { blob } = await get("scraped/runningwarehouse/deals.json");

    if (!blob || !blob.url) {
      return res.status(500).json({ error: "Could not locate deals blob" });
    }

    const resp = await fetch(blob.url);
    if (!resp.ok) {
      return res.status(500).json({
        error: "Failed to fetch deals JSON from blob",
        status: resp.status
      });
    }

    const json = await resp.json();
    const deals = Array.isArray(json) ? json : (json.deals || []);

    const totalDeals = deals.length;

    const dealsWithImages = deals.filter(
      (d) => typeof d.image === "string" && d.image.trim().length > 0
    ).length;

    const withValidDiscount = deals.filter((d) => computeDiscountPercent(d) > 0);

    const off10OrMore = withValidDiscount.filter(
      (d) => computeDiscountPercent(d) >= 10
    ).length;

    const off25OrMore = withValidDiscount.filter(
      (d) => computeDiscountPercent(d) >= 25
    ).length;

    const off50OrMore = withValidDiscount.filter(
      (d) => computeDiscountPercent(d) >= 50
    ).length;

    return res.status(200).json({
      totalDeals,
      dealsWithImages,
      off10OrMore,
      off25OrMore,
      off50OrMore
    });
  } catch (err) {
    console.error("[api/deals-stats] Error:", err);
    return res.status(500).json({
      error: "Internal server error",
      details: err?.message || String(err)
    });
  }
};
