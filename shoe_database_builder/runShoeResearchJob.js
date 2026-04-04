// file: shoe_database_builder/runShoeResearchJob.js

let researchOneShoe;
let getDb;
let getAiClient;
let getPendingShoeCandidates;

try {
  ({ researchOneShoe } = await import("./researchOneShoe.js"));
  console.log("IMPORT_OK_researchOneShoe");
} catch (error) {
  console.log("IMPORT_FAIL_researchOneShoe", {
    error: error?.message || null,
    stack: error?.stack || null,
  });
  throw error;
}

try {
  ({ getDb } = await import("../db/getDb.js"));
  console.log("IMPORT_OK_getDb_path_1");
} catch (error) {
  console.log("IMPORT_FAIL_getDb_path_1", {
    path: "../db/getDb.js",
    error: error?.message || null,
  });
}

try {
  ({ getDb } = await import("./db/getDb.js"));
  console.log("IMPORT_OK_getDb_path_2");
} catch (error) {
  console.log("IMPORT_FAIL_getDb_path_2", {
    path: "./db/getDb.js",
    error: error?.message || null,
  });
}

try {
  ({ getAiClient } = await import("../ai/getAiClient.js"));
  console.log("IMPORT_OK_getAiClient_path_1");
} catch (error) {
  console.log("IMPORT_FAIL_getAiClient_path_1", {
    path: "../ai/getAiClient.js",
    error: error?.message || null,
  });
}

try {
  ({ getAiClient } = await import("./ai/getAiClient.js"));
  console.log("IMPORT_OK_getAiClient_path_2");
} catch (error) {
  console.log("IMPORT_FAIL_getAiClient_path_2", {
    path: "./ai/getAiClient.js",
    error: error?.message || null,
  });
}

try {
  ({ getPendingShoeCandidates } = await import("./getPendingShoeCandidates.js"));
  console.log("IMPORT_OK_getPendingShoeCandidates_path_1");
} catch (error) {
  console.log("IMPORT_FAIL_getPendingShoeCandidates_path_1", {
    path: "./getPendingShoeCandidates.js",
    error: error?.message || null,
  });
}

export async function runShoeResearchJob(limit = 2) {
  console.log("JOB_START", { limit });

  if (typeof getDb !== "function") {
    throw new Error("getDb import failed");
  }

  if (typeof getAiClient !== "function") {
    throw new Error("getAiClient import failed");
  }

  if (typeof getPendingShoeCandidates !== "function") {
    throw new Error("getPendingShoeCandidates import failed");
  }

  const db = await getDb();
  const aiClient = await getAiClient();

  const candidates = await getPendingShoeCandidates({ db, limit: 50 });

  console.log("JOB_CANDIDATES_COUNT", {
    count: candidates.length,
    items: candidates.map((c) => ({
      id: c.id,
      brand: c.brand,
      model: c.model,
      gender: c.gender,
    })),
  });

  const ghostOnly = candidates.filter((c) => {
    const brand = String(c.brand || "").toLowerCase();
    const model = String(c.model || "").toLowerCase();
    return brand === "brooks" && model.includes("ghost 17");
  });

  console.log("JOB_GHOST_ONLY_COUNT", {
    count: ghostOnly.length,
    items: ghostOnly.map((c) => ({
      id: c.id,
      brand: c.brand,
      model: c.model,
      gender: c.gender,
    })),
  });

  let processed = 0;
  const results = [];

  for (const candidate of ghostOnly) {
    console.log("JOB_RESEARCHING_CANDIDATE", {
      id: candidate.id,
      brand: candidate.brand,
      model: candidate.model,
      gender: candidate.gender,
    });

    try {
      const result = await researchOneShoe({ db, aiClient, candidate });
      results.push({
        ok: true,
        candidateId: candidate.id,
        shoeId: result.shoeId,
      });
      processed += 1;

      console.log("JOB_CANDIDATE_DONE", {
        id: candidate.id,
        shoeId: result.shoeId,
      });
    } catch (error) {
      console.log("JOB_CANDIDATE_ERROR", {
        id: candidate.id,
        brand: candidate.brand,
        model: candidate.model,
        gender: candidate.gender,
        error: error?.message || "Unknown error",
        stack: error?.stack || null,
      });

      results.push({
        ok: false,
        candidateId: candidate.id,
        error: error?.message || "Unknown error",
      });
    }
  }

  console.log("JOB_END", {
    processed,
    candidatesTotal: candidates.length,
    ghostOnlyTotal: ghostOnly.length,
  });

  return {
    ok: true,
    processed,
    totalCandidates: candidates.length,
    ghostOnlyTotal: ghostOnly.length,
    results,
  };
}
