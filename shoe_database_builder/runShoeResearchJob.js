import { Pool } from "pg";
import OpenAI from "openai";

import { getResearchCandidates } from "./selectCandidates.js";
import { researchOneShoe } from "./researchOneShoe.js";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function runShoeResearchJob(limit = 2, concurrency = 3) {
  const jobStart = Date.now();

  requiredEnv("DATABASE_URL");
  requiredEnv("PERPLEXITY_API_KEY");

  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const aiClient = new OpenAI({
    apiKey: process.env.PERPLEXITY_API_KEY,
    baseURL: "https://api.perplexity.ai",
  });

  // limit  = how many shoes to process
  // concurrency = how many run in parallel at once (max 5 to respect Perplexity limits)
  const targetCount   = Math.max(1, Number.isFinite(Number(limit))       ? Number(limit)       : 2);
  const batchSize     = Math.min(5, Math.max(1, Number.isFinite(Number(concurrency)) ? Number(concurrency) : 3));
  const fetchCount    = Math.max(targetCount * 3, 10);

  const summary = {
    ok: true,
    requested: targetCount,
    concurrency: batchSize,
    processed: 0,
    inserted: 0,
    failed: 0,
    results: [],
  };

  try {
    const candidates = await getResearchCandidates(db, fetchCount);

    if (!candidates.length) {
      return {
        ok: true,
        requested: targetCount,
        concurrency: batchSize,
        processed: 0,
        inserted: 0,
        failed: 0,
        results: [],
        elapsed_ms: Date.now() - jobStart,
        elapsed_sec: ((Date.now() - jobStart) / 1000).toFixed(1),
        message: "No missing shoe candidates found.",
      };
    }

    // Slice to only the shoes we actually want to process
    const toProcess = candidates.slice(0, targetCount);

    // Process in parallel batches of batchSize
    for (let i = 0; i < toProcess.length; i += batchSize) {
      const batch = toProcess.slice(i, i + batchSize);

      const batchResults = await Promise.allSettled(
        batch.map((candidate) => {
          const shoeStart = Date.now();
          return researchOneShoe({ db, aiClient, candidate }).then((result) => ({
            ok: true,
            candidate,
            result,
            shoeStart,
          }));
        })
      );

      for (const settled of batchResults) {
        summary.processed += 1;

        if (settled.status === "fulfilled") {
          const { candidate, result, shoeStart } = settled.value;
          const shoeElapsed = Date.now() - shoeStart;
          summary.inserted += 1;

          summary.results.push({
            ok: true,
            stage: "inserted",
            brand: result.extracted.brand,
            model: result.extracted.model,
            version: result.extracted.version,
            gender: result.extracted.gender,
            shoeId: result.shoeId,
            listingUrl: candidate.sample_listing_url || null,
            store: candidate.sample_store || null,
            verified: result.verified || null,
            elapsed_ms: shoeElapsed,
            elapsed_sec: (shoeElapsed / 1000).toFixed(1),
          });
        } else {
          const error = settled.reason;
          const shoeElapsed = Date.now() - jobStart; // approximate
          summary.ok = false;
          summary.failed += 1;

          const failure = {
            ok: false,
            stage: error?.stage || "research_one_shoe",
            brand: error?.brand || null,
            model: error?.model || null,
            gender: error?.gender || null,
            listingUrl: error?.listingUrl || null,
            store: error?.store || null,
            error: error?.message || "Unknown error",
            verification: error?.verification || null,
            elapsed_ms: shoeElapsed,
            elapsed_sec: (shoeElapsed / 1000).toFixed(1),
          };

          console.error("SHOE RESEARCH FAILURE:", JSON.stringify(failure, null, 2));
          summary.results.push(failure);
        }
      }
    }

    summary.elapsed_ms = Date.now() - jobStart;
    summary.elapsed_sec = ((Date.now() - jobStart) / 1000).toFixed(1);

    return summary;
  } finally {
    await db.end();
  }
}
