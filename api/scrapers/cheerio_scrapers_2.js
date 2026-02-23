// /api/scrapers/cheerio_scrapers_2.js  (CommonJS)
// Runner to trigger a small set of Cheerio scrapers.
// Triggers (in order):
// - /api/scrapers/gazelle-sports
// - /api/scrapers/trackshack-clearance
// - /api/scrapers/als-sale
// - /api/scrapers/shoebacca-clearance
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
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  const elapsedMs = Date.now() - t0;

  // Try to parse JSON but don't require it.
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
