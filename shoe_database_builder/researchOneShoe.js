import { fetchPageText } from "./fetchPageText.js";
import { extractStructuredShoeData } from "./extractStructuredShoeData.js";
import { insertShoeRecord } from "./insertShoeRecord.js";
import { insertEvidenceRows } from "./insertEvidenceRows.js";
import { attachDealsToShoe } from "./attachDealsToShoe.js";
import { normalizeGender, normalizeSurface, toDisplayName } from "./normalize.js";

function buildSeedEvidence(candidate) {
  const sourceName = candidate.sample_store || "Shoe Beagle Deal Row";
  const sourceUrl = candidate.sample_listing_url || null;

  return [
    {
      field_name: "brand",
      raw_value: candidate.brand,
      normalized_value: candidate.brand,
      source_type: "retailer",
      source_name: sourceName,
      source_url: sourceUrl,
      confidence_score: 0.95,
      is_selected: true,
      notes: "Seeded from sb_shoe_deals candidate row",
    },
    {
      field_name: "model",
      raw_value: candidate.model,
      normalized_value: candidate.model,
      source_type: "retailer",
      source_name: sourceName,
      source_url: sourceUrl,
      confidence_score: 0.95,
      is_selected: true,
      notes: "Seeded from sb_shoe_deals candidate row",
    },
    {
      field_name: "gender",
      raw_value: candidate.gender,
      normalized_value: normalizeGender(candidate.gender),
      source_type: "retailer",
      source_name: sourceName,
      source_url: sourceUrl,
      confidence_score: 0.9,
      is_selected: true,
      notes: "Seeded from sb_shoe_deals candidate row",
    },
    {
      field_name: "surface",
      raw_value: candidate.surface,
      normalized_value: normalizeSurface(candidate.surface),
      source_type: "retailer",
      source_name: sourceName,
      source_url: sourceUrl,
      confidence_score: 0.75,
      is_selected: true,
      notes: "Seeded from sb_shoe_deals candidate row",
    },
  ];
}

function buildSnippets(candidate, pageResult) {
  const snippets = [];

  snippets.push({
    source_name: candidate.sample_store || "Shoe Beagle Deal Row",
    source_type: "retailer",
    source_url: candidate.sample_listing_url || null,
    text: [
      `Brand: ${candidate.brand}`,
      `Model: ${candidate.model}`,
      `Gender: ${candidate.gender}`,
      `Surface: ${candidate.surface}`,
      `Listing name: ${candidate.sample_listing_name || ""}`,
      `Store: ${candidate.sample_store || ""}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  if (pageResult?.ok) {
    snippets.push({
      source_name: candidate.sample_store || "Retailer Listing Page",
      source_type: "retailer",
      source_url: candidate.sample_listing_url || null,
      text: pageResult.text,
    });
  }

  return snippets;
}

function mergeSeedEvidence(extracted, seedEvidence) {
  const existing = Array.isArray(extracted.evidence) ? extracted.evidence : [];
  return [...seedEvidence, ...existing];
}

export async function researchOneShoe({ db, openai, candidate }) {
  const pageResult = await fetchPageText(candidate.sample_listing_url);

  const snippets = buildSnippets(candidate, pageResult);

  let extracted = await extractStructuredShoeData(openai, {
    candidate,
    snippets,
  });

  extracted.display_name =
    extracted.display_name ||
    toDisplayName({
      brand: extracted.brand || candidate.brand,
      model: extracted.model || candidate.model,
      gender: extracted.gender || candidate.gender,
    });

  extracted.evidence = mergeSeedEvidence(extracted, buildSeedEvidence(candidate));

  const client = await db.connect();

  try {
    await client.query("begin");

    const shoeId = await insertShoeRecord(client, extracted);

    await insertEvidenceRows(client, shoeId, extracted.evidence);

    await attachDealsToShoe(client, {
      shoeId,
      brand: extracted.brand || candidate.brand,
      model: extracted.model || candidate.model,
      gender: extracted.gender || candidate.gender,
    });

    await client.query("commit");

    return {
      shoeId,
      extracted,
      pageResult,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
