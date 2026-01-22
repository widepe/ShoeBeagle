// api/_healthShared.js       MAYBE NOT NEEDED
const { put } = require("@vercel/blob");

/**
 * Write a health record for a scraper run.
 * Use addRandomSuffix:false so the URL stays constant.
 */
async function writeScraperHealth({
  healthFileName,        // e.g. "health-holabird-mens-road.json"
  store,                 // e.g. "Holabird Sports"
  segment,               // e.g. "mens-road"
  ok,                    // boolean
  totalDeals,            // number
  durationMs,            // number
  error = null,          // string|null
  extra = {},            // any extra metrics you want
}) {
  const payload = {
    store,
    segment,
    ok: Boolean(ok),
    totalDeals: Number(totalDeals) || 0,
    lastRunTime: new Date().toISOString(),
    durationMs: Number(durationMs) || null,
    error: error ? String(error) : null,
    ...extra,
  };

  const blob = await put(healthFileName, JSON.stringify(payload, null, 2), {
    access: "public",
    addRandomSuffix: false,
  });

  return { payload, url: blob.url };
}

module.exports = { writeScraperHealth };

