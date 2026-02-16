// api/scrapers/apify_scrapers.js
// Trigger-only runner for Apify Actors

const { ApifyClient } = require("apify-client");

const apifyClient = new ApifyClient({
  token: process.env.APIFY_TOKEN,
});

function nowIso() {
  return new Date().toISOString();
}

function requireEnv(name) {
  const v = String(process.env[name] || "").trim();
  return v || null;
}

// ===========================
// EASY TOGGLES
// ===========================
const ENABLED = {
  brooks: true,
  rei: true,
  roadrunner: true,
  zappos: true,
  footlocker: true,
  rnj: true,
};

// ===========================
// ACTOR DEFINITIONS
// ===========================
const TARGETS = [
  { key: "brooks", name: "Brooks Running", actorEnv: "APIFY_BROOKS_ACTOR_ID", inputEnv: "APIFY_BROOKS_INPUT_JSON" },
  { key: "rei", name: "REI Outlet", actorEnv: "APIFY_REI_ACTOR_ID", inputEnv: "APIFY_REI_INPUT_JSON" },
  { key: "roadrunner", name: "Road Runner Sports", actorEnv: "APIFY_ROADRUNNER_ACTOR_ID", inputEnv: "APIFY_ROADRUNNER_INPUT_JSON" },
  { key: "zappos", name: "Zappos", actorEnv: "APIFY_ZAPPOS_ACTOR_ID", inputEnv: "APIFY_ZAPPOS_INPUT_JSON" },
  { key: "footlocker", name: "Foot Locker", actorEnv: "APIFY_FOOTLOCKER_ACTOR_ID", inputEnv: "APIFY_FOOTLOCKER_INPUT_JSON" },
  { key: "rnj", name: "RnJ Sports", actorEnv: "APIFY_RNJSPORTS_ACTOR_ID", inputEnv: "APIFY_RNJSPORTS_INPUT_JSON" },
];

async function callActor(actorId, actorName, input) {
  const run = await apifyClient.actor(actorId).call(input || {});
  return {
    actorName,
    actorId,
    runId: run.id,
    status: run.status,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    defaultDatasetId: run.defaultDatasetId || null,
  };
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
  const parts = s.split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  return new Set(parts);
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const startedAtIso = nowIso();
  const overallStart = Date.now();

  try {
    if (!requireEnv("APIFY_TOKEN")) {
      return res.status(500).json({ success: false, error: "Missing APIFY_TOKEN env var" });
    }

    const onlySet = parseCsvParam(req.query?.only);
    const skipSet = parseCsvParam(req.query?.skip);

    const results = {};

    for (const t of TARGETS) {
      const key = t.key;

      if (onlySet && !onlySet.has(key)) {
        results[t.name] = { ok: false, skipped: true, reason: "Not in ?only list", key };
        continue;
      }

      if (skipSet && skipSet.has(key)) {
        results[t.name] = { ok: false, skipped: true, reason: "In ?skip list", key };
        continue;
      }

      if (!onlySet && !ENABLED[key]) {
        results[t.name] = { ok: false, skipped: true, reason: "Disabled in ENABLED map", key };
        continue;
      }

      const actorId = requireEnv(t.actorEnv);

      if (!actorId) {
        results[t.name] = {
          ok: false,
          error: `${t.actorEnv} is not set`,
          actorEnv: t.actorEnv,
          key,
        };
        continue;
      }

      const maybeInput = parseOptionalJsonEnv(t.inputEnv);
      if (maybeInput && maybeInput.__error) {
        results[t.name] = {
          ok: false,
          error: maybeInput.__error,
          actorId,
          actorEnv: t.actorEnv,
          inputEnv: t.inputEnv,
          key,
        };
        continue;
      }

      try {
        const runInfo = await callActor(actorId, t.name, maybeInput || {});
        results[t.name] = { ok: true, key, ...runInfo };
      } catch (err) {
        results[t.name] = {
          ok: false,
          key,
          actorId,
          actorEnv: t.actorEnv,
          error: err?.message || "Unknown error",
          statusCode: err?.statusCode || null,
          type: err?.type || null,
        };
      }
    }

    const durationMs = Date.now() - overallStart;

    return res.status(200).json({
      success: true,
      mode: "trigger-only",
      startedAt: startedAtIso,
      durationMs,
      results,
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
      stack: process.env.NODE_ENV === "development" ? error?.stack : undefined,
    });
  }
};
