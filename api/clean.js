// /api/clean-scraper-data.js
//
// Removes entire scraper entries where:
//   entry.error === "Request failed with status code 404"
//
// Writes back to the same blob key: scraper-data.json

const { put } = require("@vercel/blob");

const SRC_URL =
  "https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/scraper-data.json";

const DROP_ERROR_EXACT = "Request failed with status code 404";

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Use GET or POST" });
    }

    // Fetch current JSON
    const r = await fetch(SRC_URL, { cache: "no-store" });
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: `Failed to fetch source JSON: ${r.status} ${r.statusText}`,
        srcUrl: SRC_URL,
      });
    }

    const data = await r.json();
    if (!data || !Array.isArray(data.days)) {
      return res
        .status(400)
        .json({ ok: false, error: "Unexpected JSON shape (missing days[])" });
    }

    let removedTotal = 0;
    const removedByDay = [];

    const cleanedDays = data.days.map((day) => {
      const scrapers = Array.isArray(day.scrapers) ? day.scrapers : [];
      const before = scrapers.length;

      const kept = scrapers.filter((entry) => {
        const err = entry && typeof entry === "object" ? entry.error : null;
        return err !== DROP_ERROR_EXACT;
      });

      const removed = before - kept.length;
      removedTotal += removed;
      if (removed) removedByDay.push({ dayUTC: day.dayUTC, removed });

      return { ...day, scrapers: kept };
    });

    const cleaned = {
      ...data,
      lastUpdated: new Date().toISOString(),
      days: cleanedDays,
    };

    // Overwrite same blob name (no random suffix)
    const blob = await put("scraper-data.json", JSON.stringify(cleaned, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    res.setHeader("Cache-Control", "no-store, max-age=0");

    return res.status(200).json({
      ok: true,
      removedTotal,
      removedByDay,
      updatedBlobUrl: blob.url,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
};
