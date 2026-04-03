import { fetchApprovedSourcePages } from "./fetchApprovedSourcePages.js";
import { extractStructuredShoeData } from "./extractStructuredShoeData.js";
import { insertShoeRecord } from "./insertShoeRecord.js";
import { insertEvidenceRows } from "./insertEvidenceRows.js";
import { attachDealsToShoe } from "./attachDealsToShoe.js";
import { toDisplayName, splitModelAndVersion } from "./normalize.js";

function buildSnippets(extraPages = []) {
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

  const approvedPages = await fetchApprovedSourcePages(researchCandidate);
  const snippets = buildSnippets(approvedPages);

  let extracted = await extractStructuredShoeData(aiClient, {
    candidate: researchCandidate,
    snippets,
  });

  extracted.brand = extracted.brand || researchCandidate.brand;
  extracted.model = extracted.model || researchCandidate.verified_model || researchCandidate.model;
  extracted.version =
    extracted.version !== undefined && extracted.version !== null
      ? extracted.version
      : researchCandidate.verified_version || null;
  extracted.gender = extracted.gender || researchCandidate.gender;

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
      approvedPages,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
