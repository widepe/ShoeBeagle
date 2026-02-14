// api/apify_scrapers.js
// Trigger-only runner for Apify Actors
// - Starts actor runs (one per store) and returns run IDs / status.
// - NO dataset reads
// - NO mapping
// - NO put() / blob writes
//
// Assumption (your current architecture):
// ✅ Each Apify actor is responsible for scraping + writing its OWN Vercel Blob.
// Vercel only triggers the runs (this file) + later merge-deals reads blobs.

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

async function callActor(actorId, actorName, input) {
  // .call() waits for the run to finish. That's okay if your actors usually finish
  // within Vercel's function timeout. If they might take longer, switch to .start()
  // (see NOTE below).
  const run = await apifyClient.actor(actorId).call(input || {});
  return {
    actorName,
    actorId,
    runId: run.id,
    status: run.status,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    defaultDatasetId: run.defaultDatasetId || null, // informational only
  };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // Optional cron auth (recommended)
const auth = req.headers.authorization;
if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  return res.status(401).json({ success: false, error: "Unauthorized" });
}


  const startedAtIso = nowIso();
  const overallStart = Date.now();

  // Only actor IDs matter now.
  // (You can keep/remove the *_DEALS_BLOB_URL env vars elsewhere; this file does not use them.)
  const TARGETS = [
    { name: "Brooks Running", actorEnv: "APIFY_BROOKS_ACTOR_ID", inputEnv: "APIFY_BROOKS_INPUT_JSON" },
    { name: "REI Outlet", actorEnv: "APIFY_REI_ACTOR_ID", inputEnv: "APIFY_REI_INPUT_JSON" },
    { name: "Road Runner Sports", actorEnv: "APIFY_ROADRUNNER_ACTOR_ID", inputEnv: "APIFY_ROADRUNNER_INPUT_JSON" },
    { name: "Zappos", actorEnv: "APIFY_ZAPPOS_ACTOR_ID", inputEnv: "APIFY_ZAPPOS_INPUT_JSON" },
    { name: "Foot Locker", actorEnv: "APIFY_FOOTLOCKER_ACTOR_ID", inputEnv: "APIFY_FOOTLOCKER_INPUT_JSON" },
    { name: "RnJ Sports", actorEnv: "APIFY_RNJSPORTS_ACTOR_ID", inputEnv: "APIFY_RNJSPORTS_INPUT_JSON" },
  ];

  // Small helper: allow optional per-actor input via env as JSON (optional)
  function parseOptionalJsonEnv(envName) {
    const raw = String(process.env[envName] || "").trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return { __error: `Invalid JSON in ${envName}: ${e?.message || "parse error"}` };
    }
  }

  try {
    if (!requireEnv("APIFY_TOKEN")) {
      return res.status(500).json({ success: false, error: "Missing APIFY_TOKEN env var" });
    }

    const results = {};

    // Sequential trigger (safer, fewer concurrent runs). You can parallelize later if desired.
    for (const t of TARGETS) {
      const actorId = requireEnv(t.actorEnv);

      if (!actorId) {
        results[t.name] = {
          ok: false,
          error: `${t.actorEnv} is not set`,
          actorEnv: t.actorEnv,
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
        };
        continue;
      }

      try {
        const runInfo = await callActor(actorId, t.name, maybeInput || {});
        results[t.name] = {
          ok: true,
          ...runInfo,
        };
      } catch (err) {
        results[t.name] = {
          ok: false,
          actorId,
          actorEnv: t.actorEnv,
          error: err?.message || "Unknown error",
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
      note:
        "This endpoint only triggers Apify actor runs. Actors are expected to write their own Vercel blobs.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
      stack: process.env.NODE_ENV === "development" ? error?.stack : undefined,
    });
  }
};

/**
 * NOTE (important):
 * - This uses apifyClient.actor(actorId).call(), which WAITS until the actor run finishes.
 *   If your actors sometimes take longer than your Vercel function timeout, switch to:
 *
 *     const run = await apifyClient.actor(actorId).start(input || {});
 *
 *   and then return run.id/status immediately.
 *
 * If you want, tell me your typical actor run times and your Vercel function limit,
 * and I’ll swap it to .start() safely.
 */
