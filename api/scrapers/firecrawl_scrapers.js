// /api/scrapers/firecrawl_scrapers.js  (CommonJS)
// Trigger runner for your Firecrawl-based scrapers.
//
// ✅ What it does
// - Hits each internal scraper route (which does the Firecrawl scrape + blob write)
// - Runs enabled scrapers concurrently (or sequential if you switch the toggle)
// - Lets you turn each scraper on/off near the top with true/false
// - Easy to extend: add another entry to TARGETS
//
// Test manually:
//   /api/scrapers/firecrawl_scrapers
//
// Cron:
//   add to vercel.json like:
//   { "path": "/api/scrapers/firecrawl_scrapers", "schedule": "10 9 * * *" }

const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000; // 6 min per scraper request
const RUN_CONCURRENTLY = true; // set false to run one-after-another (safer)

// ===========================
// EASY TOGGLES (on/off here)
// ===========================
const ENABLED = {
  backcountry: true,
  bigpeach: true,
  finishline: true,
  hoka: true,
  jdsports: true,
  kohls: true,
  nike: true,
};

// ===========================
// SCRAPER TARGETS (add new ones here)
// ===========================
const TARGETS = [
    
    {
    key: "backcountry",
    name: "Backcountry Firecrawl",
    path: "/api/scrapers/backcountry-firecrawl",
  },
  {
    key: "finishline",
    name: "Finish Line Firecrawl",
    path: "/api/scrapers/finishline-firecrawl",
  },  
  {
    key: "hoka",
    name: "HOKA Firecrawl",
    // internal route path (no domain needed)
    path: "/api/scrapers/hoka-firecrawl",
  },
  {
    key: "jdsports",
    name: "JD Sports Firecrawl",
    path: "/api/scrapers/jdsports-firecrawl",
  },  
  {
    key: "kohls",
    name: "Kohl's Firecrawl",
    path: "/api/scrapers/kohls-firecrawl",
  },
  {
  key: "nike",
  name: "Nike Firecrawl",
  path: "/api/scrapers/nike",
},
  
];

// -----------------------------
// HELPERS
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}

function msSince(t0) {
  return Date.now() - t0;
}

function getBaseUrl(req) {
  // Vercel provides x-forwarded-proto + host
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text(); // always read body (helps debugging)
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not json, that's okay
    }
    return { res, text, json };
  } finally {
    clearTimeout(id);
  }
}

async function runOneTarget(baseUrl, runId, t, cronSecret) {
  const url = `${baseUrl}${t.path}`;
  const t0 = Date.now();

  console.log(`[${runId}] FIRECRAWL trigger start: ${t.key} -> ${url}`);

  try {
    // Use GET because your scrapers are GET-testable routes.
    const { res, json, text } = await fetchWithTimeout(
      `${url}?trigger=1`,
      {
        method: "GET",
        headers: {
          "User-Agent": "ShoeBeagle-FirecrawlRunner/1.0",
          // ✅ pass through cron secret so /api/scrapers/backcountry (and others that enforce it) can run
          ...(cronSecret ? { "x-cron-secret": cronSecret } : {}),
        },
      },
      DEFAULT_TIMEOUT_MS
    );

    const elapsedMs = msSince(t0);

    // Many of your scrapers return { ok: true/false, ... }
    const ok = (json && (json.ok === true || json.success === true)) || res.ok;

    console.log(
      `[${runId}] FIRECRAWL trigger done: ${t.key} status=${res.status} ok=${ok} time=${elapsedMs}ms`
    );

    return {
      key: t.key,
      name: t.name,
      url,
      status: res.status,
      ok: Boolean(ok),
      elapsedMs,
      // keep a small snippet for debugging
      bodySnippet: (text || "").slice(0, 500),
      json: json || null,
    };
  } catch (err) {
    const elapsedMs = msSince(t0);
    console.error(`[${runId}] FIRECRAWL trigger ERROR: ${t.key}`, err);

    return {
      key: t.key,
      name: t.name,
      url,
      status: 0,
      ok: false,
      elapsedMs,
      error: String(err && err.message ? err.message : err),
    };
  }
}

// -----------------------------
// HANDLER
// -----------------------------
module.exports = async function handler(req, res) {
  const runId = `firecrawl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const startedAt = Date.now();
  const baseUrl = getBaseUrl(req);

  console.log(`[${runId}] FIRECRAWL runner start ${nowIso()}`);
  console.log(`[${runId}] method=${req.method} url=${req.url || ""}`);
  console.log(`[${runId}] baseUrl=${baseUrl}`);

  // ✅ grab CRON_SECRET from env and pass to child scrapers that require it
  const CRON_SECRET = String(process.env.CRON_SECRET || "").trim() || null;

  // select enabled targets
  const enabledTargets = TARGETS.filter((t) => ENABLED[t.key]);
  const disabledTargets = TARGETS.filter((t) => !ENABLED[t.key]).map((t) => t.key);

  if (!enabledTargets.length) {
    return res.status(200).json({
      ok: true,
      runId,
      message: "No firecrawl scrapers enabled (all toggles false).",
      disabledTargets,
      elapsedMs: msSince(startedAt),
    });
  }

  let results = [];

  if (RUN_CONCURRENTLY) {
    results = await Promise.all(
      enabledTargets.map((t) => runOneTarget(baseUrl, runId, t, CRON_SECRET))
    );
  } else {
    for (const t of enabledTargets) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await runOneTarget(baseUrl, runId, t, CRON_SECRET));
    }
  }

  const okAll = results.every((r) => r.ok);
  const elapsedMs = msSince(startedAt);

  // Build a compact summary
  const summary = results.map((r) => ({
    key: r.key,
    ok: r.ok,
    status: r.status,
    elapsedMs: r.elapsedMs,
    // helpful if your scraper returns blobUrl
    blobUrl: r.json?.blobUrl || r.json?.url || null,
    dealsExtracted: r.json?.dealsExtracted ?? null,
    error: r.error || r.json?.error || null,
  }));

  console.log(`[${runId}] FIRECRAWL runner end okAll=${okAll} time=${elapsedMs}ms`);

  res.status(okAll ? 200 : 207).json({
    ok: okAll,
    runId,
    baseUrl,
    runConcurrently: RUN_CONCURRENTLY,
    disabledTargets,
    results: summary,
    elapsedMs,
  });
};
