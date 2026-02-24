// TEMP DEBUG — REMOVE AFTER YOU GET THE STACK
process.on("warning", (w) => {
  if (w?.name === "DeprecationWarning" || String(w?.code || "").startsWith("DEP")) {
    console.warn("WARNING STACK:\n" + (w?.stack || w?.message || w));
  }
});
// /api/scrapers/apify_scrapers.js
// Trigger-only runner for Apify Actors (does NOT wait for completion, does NOT write blobs)

function nowIso() {
  return new Date().toISOString();
}

function requireEnv(name) {
  const v = String(process.env[name] || "").trim();
  return v || null;
}

function parseOptionalJsonEnv(envName) {
  const raw = String(process.env[envName] || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { __error: `Invalid JSON in ${envName}: ${e?.message || "parse error"}` };
  }
}

function parseCsvParam(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  const parts = s
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return new Set(parts);
}

// Simple concurrency limiter (no deps)
async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let i = 0;

  const runners = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
    }
  });

  await Promise.all(runners);
  return results;
}

// ===========================
// EASY TOGGLES
// ===========================
const ENABLED = {
  asics: true,
  brooks: true,
  footlocker: true,  
  mizuno: true,
  puma: true,
  rei: true,
  rnj: true,
  roadrunner: true,
  zappos: true,
};

// ===========================
// ACTOR DEFINITIONS
// ===========================
const TARGETS = [
  { key: "asics", name: "ASICS", actorEnv: "APIFY_ASICS_ACTOR_ID", inputEnv: "APIFY_ASICS_INPUT_JSON" },
  { key: "brooks", name: "Brooks Running", actorEnv: "APIFY_BROOKS_ACTOR_ID", inputEnv: "APIFY_BROOKS_INPUT_JSON" },
  { key: "footlocker", name: "Foot Locker", actorEnv: "APIFY_FOOTLOCKER_ACTOR_ID", inputEnv: "APIFY_FOOTLOCKER_INPUT_JSON" },
  { key: "mizuno", name: "Mizuno", actorEnv: "APIFY_MIZUNO_ACTOR_ID", inputEnv: "APIFY_MIZUNO_INPUT_JSON" },
  { key: "puma", name: "PUMA", actorEnv: "APIFY_PUMA_ACTOR_ID", inputEnv: "APIFY_PUMA_INPUT_JSON" },
  { key: "rei", name: "REI Outlet", actorEnv: "APIFY_REI_ACTOR_ID", inputEnv: "APIFY_REI_INPUT_JSON" },
  { key: "roadrunner", name: "Road Runner Sports", actorEnv: "APIFY_ROADRUNNER_ACTOR_ID", inputEnv: "APIFY_ROADRUNNER_INPUT_JSON" },
  { key: "rnj", name: "RnJ Sports", actorEnv: "APIFY_RNJSPORTS_ACTOR_ID", inputEnv: "APIFY_RNJSPORTS_INPUT_JSON" },
  { key: "zappos", name: "Zappos", actorEnv: "APIFY_ZAPPOS_ACTOR_ID", inputEnv: "APIFY_ZAPPOS_INPUT_JSON" },
];

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // ✅ Accept either header style:
  // - Authorization: Bearer <CRON_SECRET>
  // - x-cron-secret: <CRON_SECRET>
  const CRON_SECRET = requireEnv("CRON_SECRET");
  if (CRON_SECRET) {
    const auth = String(req.headers.authorization || "").trim();
    const xCron = String(req.headers["x-cron-secret"] || "").trim();
    const okAuth = auth === `Bearer ${CRON_SECRET}` || xCron === CRON_SECRET;

    if (!okAuth) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
  }


  
  const startedAtIso = nowIso();
  const overallStart = Date.now();

  const APIFY_TOKEN = requireEnv("APIFY_TOKEN");
  if (!APIFY_TOKEN) {
    return res.status(500).json({ success: false, error: "Missing APIFY_TOKEN env var" });
  }

  // Avoid req.query (Vercel runtime uses deprecated url.parse() under the hood)
  const urlObj = new URL(req.url, "http://localhost");

  const onlySet = parseCsvParam(urlObj.searchParams.get("only"));
  const skipSet = parseCsvParam(urlObj.searchParams.get("skip"));

  const concurrencyParam = parseInt(String(urlObj.searchParams.get("concurrency") || ""), 10);
  const TRIGGER_CONCURRENCY =
    Number.isFinite(concurrencyParam) && concurrencyParam > 0 ? concurrencyParam : TARGETS.length;

  const concurrencyParam = parseInt(String(req.query?.concurrency || ""), 10);
  const TRIGGER_CONCURRENCY = Number.isFinite(concurrencyParam) && concurrencyParam > 0 ? concurrencyParam : TARGETS.length;

  async function triggerOne(t) {
    const key = t.key;

    if (onlySet && !onlySet.has(key)) {
      return [key, { ok: false, skipped: true, reason: "Not in ?only list", key }];
    }
    if (skipSet && skipSet.has(key)) {
      return [key, { ok: false, skipped: true, reason: "In ?skip list", key }];
    }
    if (!onlySet && !ENABLED[key]) {
      return [key, { ok: false, skipped: true, reason: "Disabled in ENABLED map", key }];
    }

    const actorId = requireEnv(t.actorEnv);
    if (!actorId) {
      return [key, { ok: false, error: `${t.actorEnv} is not set`, actorEnv: t.actorEnv, key }];
    }

    const maybeInput = parseOptionalJsonEnv(t.inputEnv);
    if (maybeInput && maybeInput.__error) {
      return [
        key,
        { ok: false, error: maybeInput.__error, actorId, actorEnv: t.actorEnv, inputEnv: t.inputEnv, key },
      ];
    }

    try {
      const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${APIFY_TOKEN}`,
        },
        body: JSON.stringify(maybeInput || {}),
      });

      const json = await response.json();

      if (!response.ok) {
        throw new Error(json?.error?.message || `HTTP ${response.status}`);
      }

      const r = json.data;
      return [
        key,
        {
          ok: true,
          key,
          name: t.name,
          actorId,
          runId: r.id,
          status: r.status,
          startedAt: r.startedAt || null,
          finishedAt: r.finishedAt || null,
          defaultDatasetId: r.defaultDatasetId || null,
        },
      ];
    } catch (err) {
      return [
        key,
        {
          ok: false,
          key,
          name: t.name,
          actorId,
          actorEnv: t.actorEnv,
          error: err?.message || "Unknown error",
          statusCode: err?.statusCode || null,
          type: err?.type || null,
        },
      ];
    }
  }

  const tuples = await runWithConcurrency(TARGETS, TRIGGER_CONCURRENCY, triggerOne);

  const results = {};
  for (const tup of tuples) {
    if (Array.isArray(tup) && tup.length === 2) {
      const [key, payload] = tup;
      results[key] = payload;
    }
  }

  const durationMs = Date.now() - overallStart;

  const keys = Object.keys(results);
  const okCount = keys.filter((k) => results[k]?.ok).length;
  const skippedCount = keys.filter((k) => results[k]?.skipped).length;
  const errorCount = keys.filter((k) => !results[k]?.ok && !results[k]?.skipped).length;

  return res.status(200).json({
    success: true,
    mode: "trigger-only",
    startedAt: startedAtIso,
    durationMs,
    triggerConcurrency: TRIGGER_CONCURRENCY,
    summary: { total: keys.length, ok: okCount, skipped: skippedCount, errors: errorCount },
    results,
    note:
      "This route only TRIGGERS Apify runs. It does not wait for completion and does not write blobs. Each actor writes its own blob when it finishes.",
  });
};
