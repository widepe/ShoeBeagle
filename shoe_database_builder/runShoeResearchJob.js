import { Pool } from "pg";
import OpenAI from "openai";

import { getResearchCandidates } from "./selectCandidates.js";
import { researchOneShoe } from "./researchOneShoe.js";

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function runShoeResearchJob(limit = 2) {
  console.log("Starting shoe research job...");

  const candidates = await getResearchCandidates(db, limit);

  const results = [];

  for (const candidate of candidates) {
    try {
      console.log("Processing:", candidate.brand, candidate.model, candidate.gender);

      const result = await researchOneShoe({ db, openai, candidate });

      results.push({
        ok: true,
        ...candidate,
        shoeId: result.shoeId,
      });
    } catch (err) {
      console.error("Error:", err.message);

      results.push({
        ok: false,
        ...candidate,
        error: err.message,
      });
    }
  }

  console.log("Done:", results);
  return results;
}

// run directly
if (process.argv[1].includes("runShoeResearchJob.js")) {
  runShoeResearchJob().then(() => process.exit());
}
