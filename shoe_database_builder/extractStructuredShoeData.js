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
  const rawModelText = String(
    candidate.raw_model_text || candidate.model || ""
  ).trim();
  const model = String(parsed.model || "").trim();
  const version = parsed.version ? String(parsed.version).trim() : null;
  const gender = normalizeGender(parsed.gender || candidate.gender);
  const surface = normalizeSurface(parsed.surface || candidate.surface);
  const support = normalizeSupport(parsed.support);
  const cushioning = normalizeCushioning(parsed.cushioning);
  const plated =
    parsed.plated === true ? true : parsed.plated === false ? false : null;
  const plateType = normalizePlateType(parsed.plate_type, plated);

  if (!model) {
    throw new Error(
      `Extraction did not return a canonical model for raw_model_text="${rawModelText}"`
    );
  }

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
You are an expert running shoe researcher building a high-quality database.

You may use web search, but you must prioritize ONLY these trusted sources:
- RunRepeat
- The Running Clinic
- Running Warehouse
- Doctors of Running
- RoadTrailRun
- Believe in the Run
- OutdoorGearLab
- Road Runner Sports
- Running Shoes Guru
- RTINGS

Do not rely on other sources unless one of the approved sources is unavailable for a specific field.
Do not guess.
If data is not supported, return null.

INPUT CANDIDATE:
${JSON.stringify(candidate, null, 2)}

OPTIONAL LOCAL SNIPPETS:
${JSON.stringify(snippets || [], null, 2)}

REQUIREMENTS:

1. Resolve shoe identity
- brand
- model (base model only)
- version (if identifiable)
- gender

Examples:
- "Ghost 17" => model: "Ghost", version: "17"
- "Pegasus 41" => model: "Pegasus", version: "41"
- "1080v14" => model: "1080", version: "v14"
- "1080 v14" => model: "1080", version: "v14"
- "Kinvara" => model: "Kinvara", version: null

2. Research and fill these fields when supported:
- release_year
- msrp_usd
- weight_oz
- heel_stack_mm
- forefoot_stack_mm
- offset_mm
- foam
- cushioning
- support
- plated
- plate_type
- best_use
- upper
- surface

3. Source quality rules
- Prefer agreement across approved sources
- For retailer facts like MSRP, Running Warehouse and Road Runner Sports can be strong
- For stack, weight, foam, and ride details, prioritize review/lab-style sources
- If sources disagree, choose the most consistent value and lower confidence_score

4. Notes rules
- notes must be an original 1-3 sentence database summary
- do NOT write marketing copy
- do NOT plagiarize
- do NOT write vague notes like "retailer listing describes..."
- summarize ride, intended use, and defining traits in plain language

5. Evidence rules
For each confidently selected field, include an evidence object:
{
  "field_name": string,
  "raw_value": string|null,
  "normalized_value": string|number|boolean|array|null,
  "source_type": "review" | "lab" | "retailer" | "other",
  "source_name": string,
  "source_url": string|null,
  "confidence_score": number,
  "is_selected": true,
  "notes": string|null
}

6. Confidence guidance
- 0.9+ = multiple strong approved sources agree
- 0.7-0.89 = one strong approved source or near agreement
- 0.5-0.69 = weaker support
- below 0.5 should usually mean null instead

7. Normalized allowed values
- gender: mens | womens | unisex | unknown
- surface: road | trail | track | xc | other | unknown
- support: neutral | stability | motion_control | other | unknown
- plate_type: carbon | nylon | pebax | tpu | other | none | unknown
- cushioning: minimal | low | low/mod | moderate | mod/high | high | unknown
- best_use items: daily training | recovery | long runs | performance training | racing | trail running | hybrid | other

Return valid JSON only.
Do not include markdown fences.
Use null when unknown.
Use empty arrays when unknown for array fields.

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
    tools: [{ type: "web_search" }],
    include: ["web_search_call.action.sources"],
    input: prompt,
  });

  const text =
    response.output_text ||
    response.output?.[0]?.content?.[0]?.text ||
    "";

  const parsed = parseJsonLoose(text);
  return postProcess(candidate, parsed);
}
