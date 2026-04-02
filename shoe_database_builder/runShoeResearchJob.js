import "dotenv/config";
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
  requiredEnv("OPENAI_API_KEY");

  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const summary = {
    ok: true,
    processed: 0,
    inserted: 0,
    failed: 0,
    results: [],
  };

  try {
    const candidates = await getResearchCandidates(db, limit);

    if (!candidates.length) {
      return {
        ok: true,
        processed: 0,
        inserted: 0,
        failed: 0,
        results: [],
        message: "No missing shoe candidates found.",
      };
    }

    for (const candidate of candidates) {
      try {
        const result = await researchOneShoe({ db, openai, candidate });

        summary.processed += 1;
        summary.inserted += 1;
        summary.results.push({
          ok: true,
          brand: candidate.brand,
          model: candidate.model,
          gender: candidate.gender,
          shoeId: result.shoeId,
          listingUrl: candidate.sample_listing_url || null,
        });
      } catch (error) {
        summary.ok = false;
        summary.processed += 1;
        summary.failed += 1;
        summary.results.push({
          ok: false,
          brand: candidate.brand,
          model: candidate.model,
          gender: candidate.gender,
          error: error?.message || "Unknown error",
        });
      }
    }

    return summary;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && process.argv[1].includes("runShoeResearchJob.js")) {
  runShoeResearchJob(2)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
