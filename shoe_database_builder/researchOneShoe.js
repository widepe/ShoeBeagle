import { getApprovedSourceCandidates } from "./approvedSources.js";
import { fetchApprovedSourcePage } from "./fetchApprovedSourcePages.js";
import { extractStructuredShoeData } from "./extractStructuredShoeData.js";
import { insertShoeRecord } from "./insertShoeRecord.js";
import { insertEvidenceRows } from "./insertEvidenceRows.js";
import { attachDealsToShoe } from "./attachDealsToShoe.js";
import { toDisplayName, splitModelAndVersion } from "./normalize.js";

const WATERFALL_FIELDS = [
  "display_name",
  "brand",
  "model",
  "version",
  "gender",
  "manufacturer_model_id",
  "aliases",
  "release_year",
  "msrp_usd",
  "weight_oz",
  "heel_stack_mm",
  "forefoot_stack_mm",
  "offset_mm",
  "surface",
  "support",
  "best_use",
  "plated",
  "plate_type",
  "foam",
  "cushioning",
  "upper",
  "notes",
];

function buildSnippets(pages = []) {
  const snippets = [];

  for (const page of pages) {
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

function isMissingValue(field, value) {
  if (value === undefined || value === null) return true;

  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return true;
    if (["surface", "support", "plate_type", "cushioning"].includes(field) && v === "unknown") {
      return true;
    }
    return false;
  }

  if (Array.isArray(value)) return value.length === 0;

  return false;
}

function getMissingFields(record) {
  return WATERFALL_FIELDS.filter((field) => isMissingValue(field, record[field]));
}

function mergeEvidence(existing = [], incoming = []) {
  const out = [...existing];
  const seen = new Set(
    out.map((ev) =>
      [
        ev.field_name,
        String(ev.source_name || "").toLowerCase(),
        String(ev.source_url || "").toLowerCase(),
        JSON.stringify(ev.normalized_value),
        String(ev.raw_value || ""),
      ].join("|")
    )
  );

  for (const ev of Array.isArray(incoming) ? incoming : []) {
    const key = [
      ev.field_name,
      String(ev.source_name || "").toLowerCase(),
      String(ev.source_url || "").toLowerCase(),
      JSON.stringify(ev.normalized_value),
      String(ev.raw_value || ""),
    ].join("|");

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }

  return out;
}

function mergeMissingFields(base, incoming) {
  const merged = { ...base };

  for (const field of WATERFALL_FIELDS) {
    if (isMissingValue(field, merged[field]) && !isMissingValue(field, incoming[field])) {
      merged[field] = incoming[field];
    }
  }

  merged.evidence = mergeEvidence(base.evidence, incoming.evidence);
  merged.confidence_score = Math.max(
    typeof base.confidence_score === "number" ? base.confidence_score : 0,
    typeof incoming.confidence_score === "number" ? incoming.confidence_score : 0
  );

  return merged;
}

function seedExtracted(candidate) {
  return {
    display_name: null,
    brand: candidate.brand || null,
    model: candidate.verified_model || candidate.model || null,
    version: candidate.verified_version || null,
    gender: candidate.gender || "unknown",
    manufacturer_model_id: null,
    aliases: [],
    release_year: null,
    msrp_usd: null,
    weight_oz: null,
    heel_stack_mm: null,
    forefoot_stack_mm: null,
    offset_mm: null,
    surface: "unknown",
    support: "unknown",
    best_use: [],
    plated: null,
    plate_type: "unknown",
    foam: null,
    cushioning: "unknown",
    upper: null,
    notes: null,
    confidence_score: 0,
    review_status: "unreviewed",
    evidence: [],
  };
}

function finalizeExtracted(extracted, candidate) {
  const out = { ...extracted };

  out.brand = out.brand || candidate.brand;
  out.model = out.model || candidate.verified_model || candidate.model;
  out.version =
    out.version !== undefined && out.version !== null
      ? out.version
      : candidate.verified_version || null;
  out.gender = out.gender || candidate.gender || "unknown";

  out.display_name =
    out.display_name ||
    toDisplayName({
      brand: out.brand,
      model: out.version
        ? `${out.model}${/^v/i.test(out.version) ? out.version : ` ${out.version}`}`
        : out.model,
      gender: out.gender,
    }).replace(/\s+\((mens|womens|unisex|unknown)\)$/i, "");

  return out;
}

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

  const sourcePlan = getApprovedSourceCandidates(researchCandidate);
  let accumulated = seedExtracted(researchCandidate);
  const fetchedPages = [];

  for (const source of sourcePlan) {
    const missingBefore = getMissingFields(accumulated);
    if (missingBefore.length === 0) break;

    const page = await fetchApprovedSourcePage(source);
    if (!page) continue;

    console.log("PAGE_FOR_EXTRACTION", {
      brand: researchCandidate.brand,
      model: researchCandidate.model,
      gender: researchCandidate.gender,
      source_name: source.source_name,
      source_type: source.source_type,
      url: page.url,
      title: page.title,
      text_length: page.text ? page.text.length : 0,
      text_preview: page.text ? page.text.slice(0, 500) : null,
    });

    fetchedPages.push(page);

    const snippets = buildSnippets([page]);

    console.log("SNIPPETS_FOR_EXTRACTION", {
      brand: researchCandidate.brand,
      model: researchCandidate.model,
      gender: researchCandidate.gender,
      source_name: source.source_name,
      snippet_count: snippets.length,
      snippets: snippets.map((s) => ({
        source_name: s.source_name,
        source_type: s.source_type,
        source_url: s.source_url,
        text_length: s.text ? s.text.length : 0,
        text_preview: s.text ? s.text.slice(0, 300) : null,
      })),
    });

    const extracted = await extractStructuredShoeData(aiClient, {
      candidate: researchCandidate,
      snippets,
    });

    accumulated = mergeMissingFields(accumulated, extracted);

    console.log("WATERFALL_STEP", {
      brand: researchCandidate.brand,
      model: researchCandidate.model,
      gender: researchCandidate.gender,
      source_name: source.source_name,
      source_type: source.source_type,
      missing_before: missingBefore,
      missing_after: getMissingFields(accumulated),
    });
  }

  const finalExtracted = finalizeExtracted(accumulated, researchCandidate);

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
      approvedPages: fetchedPages,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
