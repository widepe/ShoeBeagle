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
  asics: true,
  brooks: true,
  rei: true,
  roadrunner: true,
  zappos: true,
  footlocker: true,
  rnj: true,

  // ✅ added
  mizuno: true,
};

// ===========================
// ACTOR DEFINITIONS
// ===========================
const TARGETS = [
  { key: "asics", name: "ASICS", actorEnv: "APIFY_ASICS_ACTOR_ID", inputEnv: "APIFY_ASICS_INPUT_JSON" },
  { key: "brooks", name: "Brooks Running", actorEnv: "APIFY_BROOKS_ACTOR_ID", inputEnv: "APIFY_BROOKS_INPUT_JSON" },
  { key: "footlocker", name: "Foot Locker", actorEnv: "APIFY_FOOTLOCKER_ACTOR_ID", inputEnv: "APIFY_FOOTLOCKER_INPUT_JSON" },
  { key: "mizuno", name: "Mizuno", actorEnv: "APIFY_MIZUNO_ACTOR_ID", inputEnv: "APIFY_MIZUNO_INPUT_JSON" },
  { key: "rei", name: "REI Outlet", actorEnv: "APIFY_REI_ACTOR_ID", inputEnv: "APIFY_REI_INPUT_JSON" },
  { key: "roadrunner", name: "Road Runner Sports", actorEnv: "APIFY_ROADRUNNER_ACTOR_ID", inputEnv: "APIFY_ROADRUNNER_INPUT_JSON" },
  { key: "rnj", name: "RnJ Sports", actorEnv: "APIFY_RNJSPORTS_ACTOR_ID", inputEnv: "APIFY_RNJSPORTS_INPUT_JSON" },
  { key: "zappos", name: "Zappos", actorEnv: "APIFY_ZAPPOS_ACTOR_ID", inputEnv: "APIFY_ZAPPOS_INPUT_JSON" },
];

async function callActor(actorId, actorName, input) {
  const run = await apifyClient.actor(actorId).start(input || {});
  return {
    actorName,
    actorId,
    runId: run.id,
    status: run.status, // typically "READY" / "RUNNING"
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null, // usually null right after start
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

    const tasks = TARGETS.map(async (t) => {
  const key = t.key;

  if (onlySet && !onlySet.has(key)) {
    return [t.name, { ok: false, skipped: true, reason: "Not in ?only list", key }];
  }

  if (skipSet && skipSet.has(key)) {
    return [t.name, { ok: false, skipped: true, reason: "In ?skip list", key }];
  }

  if (!onlySet && !ENABLED[key]) {
    return [t.name, { ok: false, skipped: true, reason: "Disabled in ENABLED map", key }];
  }

  const actorId = requireEnv(t.actorEnv);

  if (!actorId) {
    return [t.name, {
      ok: false,
      error: `${t.actorEnv} is not set`,
      actorEnv: t.actorEnv,
      key,
    }];
  }

  const maybeInput = parseOptionalJsonEnv(t.inputEnv);
  if (maybeInput && maybeInput.__error) {
    return [t.name, {
      ok: false,
      error: maybeInput.__error,
      actorId,
      actorEnv: t.actorEnv,
      inputEnv: t.inputEnv,
      key,
    }];
  }

  try {
    const runInfo = await callActor(actorId, t.name, maybeInput || {});
    return [t.name, { ok: true, key, ...runInfo }];
  } catch (err) {
    return [t.name, {
      ok: false,
      key,
      actorId,
      actorEnv: t.actorEnv,
      error: err?.message || "Unknown error",
      statusCode: err?.statusCode || null,
      type: err?.type || null,
    }];
  }
});

const settled = await Promise.allSettled(tasks);


for (const s of settled) {
  if (s.status === "fulfilled") {
    const [name, payload] = s.value;
    results[name] = payload;
  } else {
    results[`unknown-${Math.random().toString(16).slice(2)}`] = {
      ok: false,
      error: s.reason?.message || String(s.reason),
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
