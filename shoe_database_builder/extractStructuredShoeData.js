import {
  cleanAliases,
  normalizeBestUse,
  normalizeCushioning,
  normalizeGender,
  normalizePlateType,
  normalizeSupport,
  normalizeSurface,
  safeNumber,
  toDisplayName,
} from "./normalize.js";

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

function postProcess(candidate, parsed) {
const brand = String(parsed.brand || candidate.brand || "").trim();
const rawModelText = String(candidate.raw_model_text || candidate.model || "").trim();
const model = String(parsed.model || "").trim();
const version = parsed.version ? String(parsed.version).trim() : null;
const gender = normalizeGender(parsed.gender || candidate.gender);
const surface = normalizeSurface(parsed.surface || candidate.surface);

if (!model) {
  throw new Error(`Extraction did not return a canonical model for raw_model_text="${rawModelText}"`);
}
  const support = normalizeSupport(parsed.support);
  const cushioning = normalizeCushioning(parsed.cushioning);
  const plated =
    parsed.plated === true ? true : parsed.plated === false ? false : null;
  const plateType = normalizePlateType(parsed.plate_type, plated);

  const result = {
    display_name:
  String(parsed.display_name || "").trim() ||
  (version
    ? `${brand} ${model}${/^v/i.test(version) ? version : ` ${version}`}`
    : `${brand} ${model}`),
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
    weight_oz: safeNumber(parsed.weight_oz),
    heel_stack_mm: safeNumber(parsed.heel_stack_mm),
    forefoot_stack_mm: safeNumber(parsed.forefoot_stack_mm),
    offset_mm: safeNumber(parsed.offset_mm),
    surface,
    support,
    best_use: normalizeBestUse(parsed.best_use),
    plated,
    plate_type: plateType,
    foam: parsed.foam ? String(parsed.foam).trim() : null,
    cushioning,
    upper: parsed.upper ? String(parsed.upper).trim() : null,
    notes: parsed.notes ? String(parsed.notes).trim() : null,
    confidence_score:
      typeof parsed.confidence_score === "number"
        ? parsed.confidence_score
        : 0.5,
    review_status: "unreviewed",
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
  };

  return result;
}

export async function extractStructuredShoeData(openai, { candidate, snippets }) {
  const prompt = `
You are extracting structured running shoe data for a database.

Return valid JSON only.
Do not include markdown fences.
Do not omit required keys.
Use null when unknown.
Use empty arrays when unknown for array fields.

Allowed normalized values:
- gender: mens | womens | unisex | unknown
- surface: road | trail | track | xc | other | unknown
- support: neutral | stability | motion_control | other | unknown
- plate_type: carbon | nylon | pebax | tpu | other | none | unknown
- cushioning: minimal | low | low/mod | moderate | mod/high | high | unknown
- best_use items: daily training | recovery | long runs | performance training | racing | trail running | hybrid | other

Prefer explicit facts from the snippets over guessing.
If a field is not clearly supported, use null or unknown.

IMPORTANT MODEL RULE:
The candidate's raw_model_text may already include a version.
You must determine whether a version exists and split it correctly.

Treat candidate.raw_model_text as marketed shoe name text, not as a guaranteed canonical model.

Examples:
- "Ghost 17" => model: "Ghost", version: "17"
- "Pegasus 41" => model: "Pegasus", version: "41"
- "1080v14" => model: "1080", version: "v14"
- "1080 v14" => model: "1080", version: "v14"
- "Kinvara" => model: "Kinvara", version: null

Rules:
- Preserve branded version styling where appropriate, especially forms like "v14"
- Do not leave the version attached to model if the version is identifiable
- Do not invent a version if it is not supported
- display_name should be the marketed combined form, such as:
  - "Brooks Ghost 17"
  - "New Balance 1080v14"

Include evidence rows for every field you selected confidently.
Each evidence row should include:
field_name, raw_value, normalized_value, source_type, source_name, source_url, confidence_score, is_selected, notes

Candidate seed:
${JSON.stringify(candidate, null, 2)}

Snippets:
${JSON.stringify(snippets, null, 2)}

model must be the base model only, without the version when the version is identifiable.


Required JSON shape:
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
  "heel_stack_mm": number|null,
  "forefoot_stack_mm": number|null,
  "offset_mm": number|null,
  "surface": string,
  "support": string,
  "best_use": string[],
  "plated": boolean|null,
  "plate_type": string,
  "foam": string|null,
  "cushioning": string,
  "upper": string|null,
  "notes": string|null,
  "confidence_score": number,
  "evidence": array
}
`.trim();

  const response = await openai.responses.create({
    model: "gpt-5.4",
    input: prompt,
  });

  const text =
    response.output_text ||
    response.output?.[0]?.content?.[0]?.text ||
    "";

  const parsed = parseJsonLoose(text);
  return postProcess(candidate, parsed);
}
