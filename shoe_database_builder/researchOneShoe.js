import { extractStructuredShoeData } from "./extractStructuredShoeData.js";
import { insertShoeRecord } from "./insertShoeRecord.js";
import { insertEvidenceRows } from "./insertEvidenceRows.js";
import { attachDealsToShoe } from "./attachDealsToShoe.js";
import { toDisplayName, splitModelAndVersion } from "./normalize.js";
import { fetchPageText } from "./fetchPageText.js";
import { verifyShoeIdentity } from "./verifyShoeIdentity.js";

export async function researchOneShoe({ db, aiClient, candidate }) {
  console.log("RESEARCH_ONE_SHOE_START", {
    brand: candidate?.brand,
    model: candidate?.model,
    gender: candidate?.gender,
  });

  const split = splitModelAndVersion(candidate.model, candidate.brand);
  let verification = null;

  const researchCandidate = {
    ...candidate,
    brand: candidate.brand,
    model: split.raw_model_text,
    raw_model_text: split.raw_model_text,
    verified_model: split.model,
    verified_version: split.version,
    gender: candidate.gender,
  };

  // ── Identity verification from retailer listing URL ──────────────────────
  if (candidate?.sample_listing_url) {
    try {
      const listingPage = await fetchPageText(candidate.sample_listing_url);
      verification = await verifyShoeIdentity(aiClient, {
        candidate: researchCandidate,
        pageResult: listingPage,
      });

      if (verification && verification.verified === false) {
        const mismatchError = new Error(
          verification.mismatch_reason || "Retailer listing did not match candidate identity."
        );
        mismatchError.stage = "identity_verification";
        mismatchError.brand = researchCandidate.brand;
        mismatchError.model = researchCandidate.model;
        mismatchError.gender = researchCandidate.gender;
        mismatchError.verification = verification;
        throw mismatchError;
      }

      if (verification?.verified) {
        const mergedModelText =
          verification.model && verification.version
            ? `${verification.model} ${verification.version}`
            : verification.model || researchCandidate.model;

        const normalized = splitModelAndVersion(
          mergedModelText,
          verification.brand || researchCandidate.brand
        );

        researchCandidate.brand = verification.brand || researchCandidate.brand;
        researchCandidate.model = normalized.raw_model_text || researchCandidate.model;
        researchCandidate.verified_model = normalized.model || researchCandidate.verified_model;
        researchCandidate.verified_version =
          normalized.version !== undefined && normalized.version !== null
            ? normalized.version
            : researchCandidate.verified_version;
        researchCandidate.gender = verification.gender || researchCandidate.gender;
      }
    } catch (error) {
      // If it's a mismatch error we threw above, re-throw it
      if (error.stage === "identity_verification") throw error;

      console.log("SHOE_IDENTITY_VERIFICATION_ERROR", {
        brand: candidate?.brand || null,
        model: candidate?.model || null,
        gender: candidate?.gender || null,
        error: error?.message || String(error),
      });
    }
  }

  // ── Spec extraction — two Perplexity calls, no axios waterfall ───────────
  // Pass empty snippets. Perplexity handles all source discovery internally:
  //   Call 1: manufacturer site via search_domain_filter
  //   Call 2: approved review sources via prompt instruction
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
  finalExtracted.brand = finalExtracted.brand || researchCandidate.brand;
  finalExtracted.model = finalExtracted.model || researchCandidate.verified_model || researchCandidate.model;
  finalExtracted.version =
    finalExtracted.version !== undefined && finalExtracted.version !== null
      ? finalExtracted.version
      : researchCandidate.verified_version || null;
  finalExtracted.gender = finalExtracted.gender || researchCandidate.gender || "unknown";

  finalExtracted.display_name =
    finalExtracted.display_name ||
    toDisplayName({
      brand: finalExtracted.brand,
      model: finalExtracted.version
        ? `${finalExtracted.model}${/^v/i.test(finalExtracted.version) ? finalExtracted.version : ` ${finalExtracted.version}`}`
        : finalExtracted.model,
      gender: finalExtracted.gender,
    }).replace(/\s+\((mens|womens|unisex|unknown)\)$/i, "");

  console.log("RESEARCH_ONE_SHOE_EXTRACTED", {
    brand: finalExtracted.brand,
    model: finalExtracted.model,
    version: finalExtracted.version,
    gender: finalExtracted.gender,
    weight_oz: finalExtracted.weight_oz,
    missing_fields: [
      "heel_stack_mm", "forefoot_stack_mm", "offset_mm", "foam", "cushioning", "support"
    ].filter((f) => finalExtracted[f] === null || finalExtracted[f] === "unknown"),
  });

  // ── Insert into Neon ─────────────────────────────────────────────────────
  const client = await db.connect();

  try {
    await client.query("begin");

    const shoeId = await insertShoeRecord(client, finalExtracted);
    await insertEvidenceRows(client, shoeId, finalExtracted.evidence);
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
      verified: verification,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
