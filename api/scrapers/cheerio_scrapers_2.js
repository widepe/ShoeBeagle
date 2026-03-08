// /api/scrapers/cheerio_scrapers_2.js  (CommonJS)
//
// Runner to trigger a small set of scrapers.
// Mostly Cheerio-based scrapers, plus API-based scrapers:
//
// - Run United uses the Searchanise product search API
//   (searchserverapi*/getresults) instead of HTML scraping.
// - JD Sports uses the Algolia search API (*/1/indexes/*/queries)
//   instead of HTML scraping. (FAST)
// - Running Center uses the products-search API
//   instead of HTML scraping.
//
// Triggers (in order):
// - /api/scrapers/gazelle-sports
// - /api/scrapers/trackshack-clearance
// - /api/scrapers/als-sale
// - /api/scrapers/shoebacca-clearance
// - /api/scrapers/runnersplus
// - /api/scrapers/holabird-sports
// - /api/scrapers/rununited-searchanise
// - /api/scrapers/jdsports-algolia
// - /api/scrapers/running-center
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

  // safest default
  const RUN_CONCURRENTLY = false;

  // ==========================================================
  // EASY TOGGLES (turn off a store by setting false)
  // ==========================================================
  const ENABLED = {
    gazelle_sports: true,
    trackshack_clearance: true,
    als_sale: true,
    shoebacca_clearance: true,
    runnersplus: true,
    holabird_sports: true,
    rununited_searchanise: true,
    jdsports_algolia: true,
    running_center: true,
  };

  // IMPORTANT: URL paths typically do NOT include ".js"
  const TARGETS = [];
  if (ENABLED.gazelle_sports) TARGETS.push("/api/scrapers/gazelle-sports");
  if (ENABLED.trackshack_clearance) TARGETS.push("/api/scrapers/trackshack-clearance");
  if (ENABLED.als_sale) TARGETS.push("/api/scrapers/als-sale");
  if (ENABLED.shoebacca_clearance) TARGETS.push("/api/scrapers/shoebacca-clearance");
  if (ENABLED.runnersplus) TARGETS.push("/api/scrapers/runnersplus");
  if (ENABLED.holabird_sports) TARGETS.push("/api/scrapers/holabird-sports");

  // Run United — NOT Cheerio. Uses Searchanise API (searchserverapi*/getresults) to fetch products directly.
  if (ENABLED.rununited_searchanise) TARGETS.push("/api/scrapers/rununited-searchanise");

  // JD Sports — NOT Cheerio. Uses Algolia Search API (*/1/indexes/*/queries) to fetch products directly.
  if (ENABLED.jdsports_algolia) TARGETS.push("/api/scrapers/jdsports-algolia");

  // Running Center — NOT Cheerio. Uses products-search API to fetch products directly.
  if (ENABLED.running_center) TARGETS.push("/api/scrapers/running-center");

  try {
    const results = [];

    if (RUN_CONCURRENTLY) {
      const settled = await Promise.allSettled(TARGETS.map((p) => callInternal(req, p)));
      for (const s of settled) {
        if (s.status === "fulfilled") results.push(s.value);
        else {
          results.push({
            path: null,
            url: null,
            ok: false,
            status: 0,
            elapsedMs: 0,
            error: s.reason?.message || String(s.reason),
          });
        }
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
      enabled: ENABLED,
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
