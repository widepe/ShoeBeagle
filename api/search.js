const fs = require("fs");
const path = require("path");

function normalize(s) {
  return String(s || "").trim().toLowerCase();
}

module.exports = (req, res) => {
  const requestId =
    (req.headers && (req.headers["x-vercel-id"] || req.headers["x-request-id"])) ||
    `local-${Date.now()}`;
  const startedAt = Date.now();

  try {
    const rawQuery = req.query && req.query.query ? req.query.query : "";
    const query = String(rawQuery).trim();

    console.log("[/api/search] start", { requestId, query });

    if (!query) {
      res.status(400).json({
        error: "Missing query parameter",
        example: "/api/search?query=Nike%20Pegasus",
        requestId
      });
      console.log("[/api/search] done (400)", { requestId, ms: Date.now() - startedAt });
      return;
    }

    // Read curated deals file
    const dealsPath = path.join(process.cwd(), "data", "deals.json");
    const raw = fs.readFileSync(dealsPath, "utf8");
    const deals = JSON.parse(raw);

    const q = normalize(query);

    // Match if brand is in query AND model is in query (case-insensitive)
    const results = deals
      .filter((d) => q.includes(normalize(d.brand)) && q.includes(normalize(d.model)))
      .map((d) => ({
        title: d.title,
        price: Number(d.price),
        store: d.store,
        url: d.url,
        image:
          d.image && String(d.image).trim()
            ? d.image
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
