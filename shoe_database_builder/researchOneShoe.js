import { extractStructuredShoeData } from "./extractStructuredShoeData.js";
import { insertShoeRecord } from "./insertShoeRecord.js";
import { insertEvidenceRows } from "./insertEvidenceRows.js";
import { attachDealsToShoe } from "./attachDealsToShoe.js";

export async function researchOneShoe({ db, openai, candidate }) {
  // TEMP: using minimal input (next step is real fetchers)
  const snippets = [
    `Brand: ${candidate.brand}`,
    `Model: ${candidate.model}`,
    `Gender: ${candidate.gender}`,
  ];

  const extracted = await extractStructuredShoeData(openai, snippets);

  const shoeId = await insertShoeRecord(db, extracted);

  await insertEvidenceRows(db, shoeId, extracted.evidence);

  await attachDealsToShoe(db, {
    shoeId,
    brand: candidate.brand,
    model: candidate.model,
    gender: candidate.gender,
  });

  return { shoeId };
}
