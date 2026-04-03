import { fetchApprovedSourcePages } from "./fetchApprovedSourcePages.js";
import { fetchPageText } from "./fetchPageText.js";
import { extractStructuredShoeData } from "./extractStructuredShoeData.js";
import { insertShoeRecord } from "./insertShoeRecord.js";
import { insertEvidenceRows } from "./insertEvidenceRows.js";
import { attachDealsToShoe } from "./attachDealsToShoe.js";
import { verifyShoeIdentity } from "./verifyShoeIdentity.js";
import { toDisplayName, splitModelAndVersion } from "./normalize.js";

function buildSnippets(candidate, _pageResult, extraPages = []) {
  const snippets = [];

  for (const page of extraPages) {
    if (!page?.ok || !page.text || !page.url) continue;

    snippets.push({
      source_name: page.source_name || "Approved Source",
      source_type: page.source_type || "review",
      source_url: page.url,
      text: page.text,
    });
  }

  return snippets;
}

export async function researchOneShoe({ db, aiClient, candidate }) {
  const pageResult = await fetchPageText(candidate.sample_listing_url);

  const verified = await verifyShoeIdentity(aiClient, {
    candidate,
    pageResult,
  });

  if (!verified.verified) {
    const error = new Error(
      verified.mismatch_reason ||
        `Listing page identity could not be verified for ${candidate.brand} ${candidate.model} (${candidate.gender})`
    );

    error.stage = "verify_identity";
    error.brand = candidate.brand;
    error.model = candidate.model;
    error.gender = candidate.gender;
    error.store = candidate.sample_store || null;
    error.listingUrl = candidate.sample_listing_url || null;
    error.verification = verified;
    throw error;
  }

  const baseBrand = verified.brand || candidate.brand;
  const baseName = verified.display_name || candidate.model;
  const split = splitModelAndVersion(baseName, baseBrand);

  const verifiedCandidate = {
    ...candidate,
    brand: baseBrand,
    model: split.raw_model_text,
    raw_model_text: split.raw_model_text,
    verified_model: verified.model || split.model,
    verified_version: verified.version || split.version,
    gender: verified.gender || candidate.gender,
  };

  const approvedPages = await fetchApprovedSourcePages(verifiedCandidate);
  const snippets = buildSnippets(verifiedCandidate, null, approvedPages);

  let extracted = await extractStructuredShoeData(aiClient, {
    candidate: verifiedCandidate,
    snippets,
  });

  extracted.brand = extracted.brand || verified.brand || candidate.brand;
  extracted.model = extracted.model || verified.model || candidate.model;
  extracted.version =
    extracted.version !== undefined && extracted.version !== null
      ? extracted.version
      : verified.version || null;
  extracted.gender = extracted.gender || verified.gender || candidate.gender;

  extracted.display_name =
    extracted.display_name ||
    toDisplayName({
      brand: extracted.brand,
      model: extracted.version
        ? `${extracted.model}${/^v/i.test(extracted.version) ? extracted.version : ` ${extracted.version}`}`
        : extracted.model,
      gender: extracted.gender,
    }).replace(/\s+\((mens|womens|unisex|unknown)\)$/i, "");

  const client = await db.connect();

  try {
    await client.query("begin");

    const shoeId = await insertShoeRecord(client, extracted);

    await insertEvidenceRows(client, shoeId, extracted.evidence);

    await attachDealsToShoe(client, {
      shoeId,
      brand: extracted.brand,
      model: extracted.model,
      version: extracted.version,
      gender: extracted.gender,
    });

    await client.query("commit");

    return {
      shoeId,
      extracted,
      pageResult,
      verified,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
