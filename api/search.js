const fs = require("fs");
const path = require("path");

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

module.exports = (req, res) => {
  const requestId =
    (req.headers && (req.headers["x-vercel-id"] || req.headers["x-request-id"])) ||
    `local-${Date.now()}`;
  const startedAt = Date.now();

  try {
    const rawQuery = req.query && req.query.query ? req.query.query : "";
    const query = normalize(rawQuery);

    console.log("[/api/search] start", { requestId, query });

    if (!query) {
      res.status(400).json({
        error: "Missing query parameter",
        example: "/api/search?query=Nike%20Pegasus",
        requestId
      });
      return;
    }

    // Load curated deals
    const dealsPath = path.join(process.cwd(), "data", "deals.json");
    const deals = JSON.parse(fs.readFileSync(dealsPath, "utf8"));

    const results = deals
      .filter((deal) => {
        const brand = normalize(deal.brand);
        const model = normalize(deal.model);

        // Require brand match
        if (!query.includes(brand)) return false;

        // Model match: allow partial match either direction
        return (
          query.includes(model) ||
          model.includes(query.replace(brand, "").trim())
        );
      })
      .map((deal) => ({
        title: deal.title,
        price: Number(deal.price),
        store: deal.store,
        url: deal.url,
        image:
          deal.image && String(deal.image).trim()
            ? deal.image
            : "https://placehold.co/600x400?text=Running+Shoe"
      }))
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
      .slice(0, 12);

    res.status(200).json({ results, requestId });

    console.log("[/api/search] done (200)", {
      requestId,
      ms: Date.now() - startedAt,
      count: results.length
    });
  } catch (err) {
    console.error("[/api/search] error", {
      requestId,
      message: err?.message || String(err)
    });
    res.status(500).json({ error: "Internal server error", requestId });
  }
};
