// /api/clean-scraper-data.js
// RUN ONCE, then delete this file.

const { put } = require("@vercel/blob");

const INPUT_URL =
  "https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/scraper-data.json";

const BLOCKED_FILENAMES = new Set([
  "apify-deals_blob.json",
  "cheerio-deals_blob.json",
  "deals-other.json",
]);

function getFilename(url) {
  try {
    const u = new URL(url);
    return u.pathname.split("/").pop();
  } catch {
    return "";
  }
}

module.exports = async function handler(req, res) {
  try {
    // 1. Fetch existing scraper-data.json
    const response = await fetch(INPUT_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch original file`);
    }

    const data = await response.json();

    let removed = 0;

    // 2. Remove unwanted scraper entries
    data.days = data.days.map(day => {
      const filtered = (day.scrapers || []).filter(scraper => {
        const filename = getFilename(scraper.blobUrl || "");
        const shouldRemove = BLOCKED_FILENAMES.has(filename);
        if (shouldRemove) removed++;
        return !shouldRemove;
      });

      return { ...day, scrapers: filtered };
    });

    data.lastUpdated = new Date().toISOString();

    // 3. Overwrite original blob
    const result = await put("scraper-data.json", JSON.stringify(data, null, 2), {
      access: "public",
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false,
    });

    res.status(200).json({
      ok: true,
      removed,
      updatedUrl: result.url,
      message: "Cleanup complete. You can now delete this API file.",
    });

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
};
