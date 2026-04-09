import { extractStructuredShoeData } from "./extractStructuredShoeData.js";
import { insertShoeRecord } from "./insertShoeRecord.js";
import { attachDealsToShoe } from "./attachDealsToShoe.js";
import { toDisplayName, splitModelAndVersion } from "./normalize.js";

export async function researchOneShoe({ db, aiClient, candidate }) {
  console.log("RESEARCH_ONE_SHOE_START", {
    brand: candidate?.brand,
    model: candidate?.model,
    gender: candidate?.gender,
  });

  const split = splitModelAndVersion(candidate.model, candidate.brand);

  const researchCandidate = {
    ...candidate,
    brand: candidate.brand,
    model: split.raw_model_text,
    raw_model_text: split.raw_model_text,
    verified_model: split.model,
    verified_version: split.version,
    gender: candidate.gender,
  };

  // ── Spec extraction ──────────────────────────────────────────────────────
  console.log("RESEARCH_ONE_SHOE_EXTRACTION_START", {
    brand: researchCandidate.brand,
    model: researchCandidate.verified_model || researchCandidate.model,
    version: researchCandidate.verified_version || null,
    gender: researchCandidate.gender,
  });

  const finalExtracted = await extractStructuredShoeData(aiClient, {
    candidate: researchCandidate,
    snippets: [],
  });

  // ── Finalize identity fields ─────────────────────────────────────────────
  finalExtracted.brand =
    finalExtracted.brand || researchCandidate.brand;

  finalExtracted.model =
    finalExtracted.model ||
    researchCandidate.verified_model ||
    researchCandidate.model;

  finalExtracted.version =
    finalExtracted.version !== undefined &&
    finalExtracted.version !== null
      ? finalExtracted.version
      : researchCandidate.verified_version || null;

  finalExtracted.gender =
    finalExtracted.gender || researchCandidate.gender || "unknown";

  finalExtracted.display_name =
    finalExtracted.display_name ||
    toDisplayName({
      brand: finalExtracted.brand,
      model: finalExtracted.version
        ? `${finalExtracted.model}${
            /^v/i.test(finalExtracted.version)
              ? finalExtracted.version
              : ` ${finalExtracted.version}`
          }`
        : finalExtracted.model,
      gender: finalExtracted.gender,
    }).replace(/\s+\((mens|womens|unisex|unknown)\)$/i, "");

  console.log("RESEARCH_ONE_SHOE_EXTRACTED", {
    brand: finalExtracted.brand,
    model: finalExtracted.model,
    version: finalExtracted.version,
    gender: finalExtracted.gender,
    weight_oz: finalExtracted.weight_oz,
  });

  // ── Insert into Neon ─────────────────────────────────────────────────────
  const client = await db.connect();

  try {
    await client.query("begin");

    const shoeId = await insertShoeRecord(client, finalExtracted);

    await attachDealsToShoe(client, {
      shoeId,
      brand: finalExtracted.brand,
      model: finalExtracted.model,
      gender: finalExtracted.gender,
    });

    await client.query("commit");

    return {
      shoeId,
      extracted: finalExtracted,
      verified: null,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
