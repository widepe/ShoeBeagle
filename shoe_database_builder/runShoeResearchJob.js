import { researchOneShoe } from "./researchOneShoe.js";
import { getDb } from "../db/getDb.js";
import { getAiClient } from "../ai/getAiClient.js";
import { getPendingShoeCandidates } from "./getPendingShoeCandidates.js";

export async function runShoeResearchJob(limit = 2) {
  console.log("JOB_START", { limit });

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
