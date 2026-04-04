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

export async function runShoeResearchJob(limit = 2) {
  requiredEnv("DATABASE_URL");
  requiredEnv("PERPLEXITY_API_KEY"); // Perplexity API key

  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const aiClient = new OpenAI({
    apiKey: process.env.PERPLEXITY_API_KEY,
    // For Sonar (chat completions–style), Perplexity’s docs use this base URL:
    // https://api.perplexity.ai
    baseURL: "https://api.perplexity.ai",
  });

  const targetSuccesses = Number.isFinite(Number(limit)) ? Number(limit) : 2;
  const fetchCount = Math.max(targetSuccesses * 5, 10);

  const summary = {
    ok: true,
    requested: targetSuccesses,
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
        requested: targetSuccesses,
        processed: 0,
        inserted: 0,
        failed: 0,
        results: [],
        message: "No missing shoe candidates found.",
      };
    }

    for (const candidate of candidates) {
      if (summary.inserted >= targetSuccesses) break;

      try {
        const result = await researchOneShoe({ db, aiClient, candidate });

        summary.processed += 1;
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
        });
      } catch (error) {
        summary.ok = false;
        summary.processed += 1;
        summary.failed += 1;

        const failure = {
          ok: false,
          stage: error?.stage || "research_one_shoe",
          brand: error?.brand || candidate.brand,
          model: error?.model || candidate.model,
          gender: error?.gender || candidate.gender,
          listingUrl: error?.listingUrl || candidate.sample_listing_url || null,
          store: error?.store || candidate.sample_store || null,
          error: error?.message || "Unknown error",
          verification: error?.verification || null,
        };

        console.error(
          "SHOE RESEARCH FAILURE:",
          JSON.stringify(failure, null, 2),
        );
        summary.results.push(failure);
      }
    }

    if (summary.inserted < targetSuccesses) {
      summary.message = `Requested ${targetSuccesses} successful inserts, but only inserted ${summary.inserted}.`;
    }

    return summary;
  } finally {
    await db.end();
  }
}
