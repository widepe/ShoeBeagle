import {
  cleanAliases,
  normalizeBestUse,
  normalizeCushioning,
  normalizeGender,
  normalizePlateType,
  normalizeSupport,
  normalizeSurface,
  safeNumber,
} from "./normalize.js";
import { APPROVED_SOURCES } from "./approvedSources.js";

function parseJsonLoose(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Empty model response");

  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error("Could not parse model JSON");
  }
}

function toOunces(weightValue, weightUnit) {
  const value = safeNumber(weightValue);
  const unit = String(weightUnit || "").trim().toLowerCase();

  if (value === null) return null;
  if (!unit) return null;

  if (["oz", "ounce", "ounces"].includes(unit)) return value;
  if (["g", "gram", "grams"].includes(unit)) return value / 28.3495;

  return null;
}

function toUsSize(foundSize, sizeSystem, gender) {
  const size = safeNumber(foundSize);
  const system = String(sizeSystem || "").trim().toLowerCase();
  const g = normalizeGender(gender);

  if (size === null || !system) return null;
  if (system === "us") return size;

  if (g === "womens") {
    if (system === "uk") return size + 2;
    if (system === "eu") return size - 31;
    return null;
  }

  if (system === "uk") return size + 1;
  if (system === "eu") return size - 33;

  return null;
}

function convertWeightToTargetSize({
  weightValue,
  weightUnit,
  foundSize,
  foundSizeSystem,
  gender,
}) {
  const ounces = toOunces(weightValue, weightUnit);
  const usSize = toUsSize(foundSize, foundSizeSystem, gender);
  const g = normalizeGender(gender);

  if (ounces === null || usSize === null) return null;

  const targetSize = g === "womens" ? 7 : 9;
  const halfSizeSteps = (targetSize - usSize) * 2;
  const corrected = ounces * Math.pow(1.026, halfSizeSteps);

  return Number(corrected.toFixed(2));
}

function mapManufacturerCushioning(label) {
  const s = String(label || "").trim().toLowerCase();
  if (!s) return null;

  if (s === "balanced") return "moderate";
  if (s === "soft") return "mod/high";
  if (s === "plush" || s === "max") return "high";
  if (s === "firm but cushioned") return "low/mod";
  if (s === "firm") return "low";
  if (s === "minimal") return "minimal";

  return null;
}

function truncateNotes(value) {
  if (!value) return null;

  const words = String(value).trim().split(/\s+/).filter(Boolean).slice(0, 40);
  const text = words.join(" ").trim();

  return text || null;
}

function normalizeEvidence(ev) {
  if (!ev) return null;

  const field_name = ev.field_name || ev.field;
  if (!field_name) return null;

  return {
    field_name: String(field_name).trim(),
    raw_value: ev.raw_value ?? ev.value ?? null,
    normalized_value: ev.normalized_value ?? null,
    source_type: ev.source_type ?? "other",
    source_name: ev.source_name ?? ev.source ?? "Unknown Source",
    source_url: ev.source_url ?? ev.url ?? null,
    confidence_score:
      typeof ev.confidence_score === "number" ? ev.confidence_score : 0.7,
    is_selected: ev.is_selected === true || ev.is_selected === undefined,
    notes: ev.notes ?? null,
  };
}

function dedupeEvidence(evidence) {
  const seen = new Set();
  const out = [];

  for (const ev of Array.isArray(evidence) ? evidence : []) {
    const n = normalizeEvidence(ev);
    if (!n) continue;

    const key = [
      n.field_name,
      String(n.source_name || "").toLowerCase(),
      String(n.source_url || "").toLowerCase(),
      JSON.stringify(n.normalized_value),
      String(n.raw_value || ""),
    ].join("|");

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }

  return out;
}

function postProcess(candidate, parsed) {
  const brand = String(parsed.brand || candidate.brand || "").trim();

  const fallbackModel =
    candidate.verified_model ||
    candidate.model ||
    "";

  const fallbackVersion = candidate.verified_version || null;

  const model = String(parsed.model || fallbackModel || "").trim();

  const version =
    parsed.version !== undefined &&
    parsed.version !== null &&
    String(parsed.version).trim() !== ""
      ? String(parsed.version).trim()
      : fallbackVersion;

  const gender = normalizeGender(parsed.gender || candidate.gender);
  const surface = normalizeSurface(parsed.surface || candidate.surface);
  const support = normalizeSupport(parsed.support);

  const cushioning =
    mapManufacturerCushioning(parsed.manufacturer_cushioning_label) ||
    normalizeCushioning(parsed.cushioning);

  const plated =
    parsed.plated === true ? true : parsed.plated === false ? false : null;

  const plateType = normalizePlateType(parsed.plate_type, plated);

  const bestUseRaw = Array.isArray(parsed.best_use)
    ? parsed.best_use
    : typeof parsed.best_use === "string"
      ? parsed.best_use
          .replace(/[{}"]/g, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  const convertedWeight = convertWeightToTargetSize({
    weightValue: parsed.weight_value,
    weightUnit: parsed.weight_unit,
    foundSize: parsed.weight_found_size,
    foundSizeSystem: parsed.weight_found_size_system,
    gender,
  });

  const evidenceList = dedupeEvidence(parsed.evidence);

  const approvedLower = APPROVED_SOURCES.map((s) => s.toLowerCase());
  const hasApprovedEvidence = evidenceList.some(
    (ev) =>
      approvedLower.includes(String(ev.source_name || "").toLowerCase()) ||
      String(ev.source_type || "").toLowerCase() === "brand"
  );

  const baseConfidence =
    typeof parsed.confidence_score === "number"
      ? parsed.confidence_score
      : 0.75;

  const confidence_score = hasApprovedEvidence
    ? Math.max(baseConfidence, 0.85)
    : baseConfidence;

  return {
    display_name: version
      ? `${brand} ${model}${/^v/i.test(version) ? version : ` ${version}`}`
      : `${brand} ${model}`,
    brand,
    model,
    version,
    gender,
    manufacturer_model_id: parsed.manufacturer_model_id
      ? String(parsed.manufacturer_model_id).trim()
      : null,
    aliases: cleanAliases(parsed.aliases),
    release_year: Number.isInteger(parsed.release_year)
      ? parsed.release_year
      : null,
    msrp_usd: safeNumber(parsed.msrp_usd),
    weight_oz: convertedWeight ?? safeNumber(parsed.weight_oz),
    heel_stack_mm: safeNumber(parsed.heel_stack_mm),
    forefoot_stack_mm: safeNumber(parsed.forefoot_stack_mm),
    offset_mm: safeNumber(parsed.offset_mm),
    surface,
    support,
    best_use: normalizeBestUse(bestUseRaw),
    plated,
    plate_type: plateType,
    foam: parsed.foam ? String(parsed.foam).trim() : null,
    cushioning,
    upper: parsed.upper ? String(parsed.upper).trim() : null,
    notes: truncateNotes(parsed.notes),
    confidence_score,
    review_status: "unreviewed",
    evidence: evidenceList,
  };
}

function buildResearchPrompt({ candidate, snippets }) {
  return `
You are an expert running shoe researcher building a structured database record.

Your job is to use the provided source snippets and return a single JSON object.

Research rules:
- Manufacturer pages are highest priority and should be used first when available.
- After manufacturer pages, use only these approved non-manufacturer sources:
  ${APPROVED_SOURCES.map((s, i) => `${i + 1}. ${s}`).join("\\n  ")}
- Do not use retailer pages as sources for technical specs.
- Do not guess; prefer null over speculation.
- Fill as many fields as possible from the provided snippets.
- Include evidence rows for every non-trivial populated field.
- Evidence must name the source and include the URL when available.
- For notes, prefer manufacturer snippets when available.
- notes should be a short paraphrased synthesis of positive attributes and special features of the shoe.
- notes must be 40 words or fewer.
- Do not copy marketing sentences verbatim.
- If there is not enough support for a useful note, return null for notes.

Identity rules:
- Canonicalize model and version cleanly.
- Keep gender normalized to one of: mens, womens, unisex, unknown.

Candidate:
${JSON.stringify(candidate, null, 2)}

Local snippets:
${JSON.stringify(snippets || [], null, 2)}

Return valid JSON only with this exact shape and field names (no extra fields, no different names):

{
  "display_name": string,
  "brand": string,
  "model": string,
  "version": string|null,
  "gender": string,
  "manufacturer_model_id": string|null,
  "aliases": string[],
  "release_year": number|null,
  "msrp_usd": number|null,
  "weight_oz": number|null,
  "weight_value": number|null,
  "weight_unit": string|null,
  "weight_found_size": number|null,
  "weight_found_size_system": string|null,
  "heel_stack_mm": number|null,
  "forefoot_stack_mm": number|null,
  "offset_mm": number|null,
  "surface": string,
  "support": string,
  "best_use": string[],
  "plated": boolean|null,
  "plate_type": string,
  "foam": string|null,
  "manufacturer_cushioning_label": string|null,
  "cushioning": string,
  "upper": string|null,
  "notes": string|null,
  "confidence_score": number,
  "evidence": [
    {
      "field_name": string,
      "raw_value": string|null,
      "normalized_value": any,
      "source_type": "brand"|"review"|"lab"|"retailer"|"ai"|"other",
      "source_name": string,
      "source_url": string|null,
      "confidence_score": number,
      "is_selected": boolean,
      "notes": string|null
    }
  ]
}
`.trim();
}

export async function extractStructuredShoeData(aiClient, { candidate, snippets }) {
  const prompt = buildResearchPrompt({ candidate, snippets });

  const response = await aiClient.chat.completions.create({
    model: "sonar",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a precise data extraction system. Use manufacturer snippets first, then approved non-retailer sources. Do not use retailer sources for technical specs. Fill all clearly supported fields and return valid JSON only.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const text = response.choices?.[0]?.message?.content || "";
  const parsed = parseJsonLoose(text);

  console.log(
    "EXTRACTED_RAW",
    JSON.stringify(
      {
        candidate: {
          brand: candidate.brand,
          model: candidate.model,
          gender: candidate.gender,
        },
        parsed,
      },
      null,
      2
    )
  );

  return postProcess(candidate, parsed);
}
