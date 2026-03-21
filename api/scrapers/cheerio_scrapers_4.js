// /api/scrapers/cheerio_scrapers_4.js  (CommonJS)
//
// Runner to trigger a small set of scraper endpoints.
//
// Notes:
// - This runner only TRIGGERS the internal endpoint; the endpoint does its own scrape + blob write.
// - Sequential by default.
// - Passes cron auth through if provided.

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
  // - x-cron-secret header
  // - Authorization: Bearer <secret>
  const cronSecret =
    String(req.headers["x-cron-secret"] || "").trim() ||
    (String(req.headers.authorization || "")
      .trim()
      .startsWith("Bearer ")
      ? String(req.headers.authorization).trim().slice("Bearer ".length).trim()
      : "");

  const headers = {};
  if (cronSecret) headers.Authorization = `Bearer ${cronSecret}`;

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
    body: json ?? text.slice(0, 2000),
  };
}

module.exports = async function handler(req, res) {
  const runId = `cheerio4-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
  const startedAt = nowIso();

  const RUN_CONCURRENTLY = false;

  // ==========================================================
  // EASY TOGGLES
  // ==========================================================
  const ENABLED = {
    runpacers_sale: true,
    therunningwellstore_sale: true,
    running_company: true,
    tc_running_co: true,
    front_runners_la: true,
    confluence_running: true,
  };

  const TARGETS = [];

  // RunPacers sale running shoes pages.
  if (ENABLED.runpacers_sale) TARGETS.push("/api/scrapers/runpacers-sale");

  // The Running Well Store sale footwear collection via Shopify products.json.
  if (ENABLED.therunningwellstore_sale) TARGETS.push("/api/scrapers/therunningwellstore");

  // Running Company sale running shoes scraper.
  if (ENABLED.running_company) TARGETS.push("/api/scrapers/running-company");

  // TC Running Co sale running shoes scraper.
  if (ENABLED.tc_running_co) TARGETS.push("/api/scrapers/tc-running-co");

  // Front Runners LA running + trail collections via Shopify products.json.
  if (ENABLED.front_runners_la) TARGETS.push("/api/scrapers/front-runners-la");

  // Confluence Running via Shopify products.json.
  if (ENABLED.confluence_running) TARGETS.push("/api/scrapers/confluence-running");
  
  try {
    const results = [];

    if (RUN_CONCURRENTLY) {
      const settled = await Promise.allSettled(TARGETS.map((p) => callInternal(req, p)));
      for (const s of settled) {
        if (s.status === "fulfilled") {
          results.push(s.value);
        } else {
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
