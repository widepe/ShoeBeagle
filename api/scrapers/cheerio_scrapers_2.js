// /api/scrapers/cheerio_scrapers_2.js  (CommonJS)
//
// Runner to trigger a small set of scrapers.
// Mostly Cheerio-based scrapers, plus API-based scrapers:
//
// - Run United uses the Searchanise product search API
//   (searchserverapi*/getresults) instead of HTML scraping.
// - JD Sports uses the Algolia search API (*/1/indexes/*/queries)
//   instead of HTML scraping. (FAST)
//
// Triggers (in order):
// - /api/scrapers/gazelle-sports
// - /api/scrapers/trackshack-clearance
// - /api/scrapers/als-sale
// - /api/scrapers/shoebacca-clearance
// - /api/scrapers/rununited-searchanise
// - /api/scrapers/jdsports-algolia
//
// Notes:
// - This runner only TRIGGERS internal endpoints; each endpoint does its own scrape + blob write.
// - Default is sequential to reduce load and avoid accidental parallel overlap.
// - You can toggle RUN_CONCURRENTLY if you want, but sequential is safest.

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function callInternal(req, path) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host) throw new Error("Missing host header (cannot build internal URL).");

  const base = `${proto}://${host}`;
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;

  const t0 = Date.now();

  // Support passing cron auth through either:
  // - x-cron-secret header (preferred for this runner)
  // - Authorization: Bearer <secret>
  const cronSecret =
    String(req.headers["x-cron-secret"] || "").trim() ||
    (String(req.headers.authorization || "")
      .trim()
      .startsWith("Bearer ")
      ? String(req.headers.authorization).trim().slice("Bearer ".length).trim()
      : "");

  const headers = {};
if (cronSecret) headers["Authorization"] = `Bearer ${cronSecret}`;

  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  const elapsedMs = Date.now() - t0;

  const json = safeJsonParse(text);

  return {
    path,
    url,
    ok: res.ok,
    status: res.status,
    elapsedMs,
    body: json ?? text.slice(0, 2000), // cap text to keep logs reasonable
  };
}

module.exports = async function handler(req, res) {
  const runId = `cheerio2-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
  const startedAt = nowIso();

  // ✅ safest default
  const RUN_CONCURRENTLY = false;

  // IMPORTANT: URL paths typically do NOT include ".js"
  const TARGETS = [
    "/api/scrapers/gazelle-sports",
    "/api/scrapers/trackshack-clearance",
    "/api/scrapers/als-sale",
    "/api/scrapers/shoebacca-clearance",
    // Run United — NOT Cheerio. Uses Searchanise API (searchserverapi*/getresults) to fetch products directly.
    "/api/scrapers/rununited-searchanise",
    // JD Sports — NOT Cheerio. Uses Algolia Search API (*/1/indexes/*/queries) to fetch products directly.
    "/api/scrapers/jdsports-algolia",
  ];

  try {
    const results = [];

    if (RUN_CONCURRENTLY) {
      const settled = await Promise.allSettled(TARGETS.map((p) => callInternal(req, p)));
      for (const s of settled) {
        if (s.status === "fulfilled") results.push(s.value);
        else results.push({ ok: false, status: 0, elapsedMs: 0, error: s.reason?.message || String(s.reason) });
      }
    } else {
      for (const p of TARGETS) {
        results.push(await callInternal(req, p));
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    const totalMs = results.reduce((sum, r) => sum + (r.elapsedMs || 0), 0);

    res.status(200).json({
      ok: okCount === results.length,
      runId,
      startedAt,
      finishedAt: nowIso(),
      mode: RUN_CONCURRENTLY ? "concurrent" : "sequential",
      targets: TARGETS,
      okCount,
      total: results.length,
      totalElapsedMs: totalMs,
      results,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      runId,
      startedAt,
      finishedAt: nowIso(),
      error: e?.message || String(e),
    });
  }
};
