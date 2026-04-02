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
   best_use: normalizeBestUse(
  (() => {
    if (Array.isArray(parsed.best_use)) return parsed.best_use;

    if (typeof parsed.best_use === "string") {
      return parsed.best_use
        .replace(/[{}"]/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    return [];
  })()
),
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

3. Source priority and data extraction rules

You must follow this exact order of sources:

STEP 1 — Manufacturer (highest priority, required first)
- First, search for the official manufacturer page for this exact shoe
- Use manufacturer as the primary source for:
  - model
  - version
  - manufacturer_model_id
  - msrp_usd
  - release_year
  - upper
  - foam (if explicitly stated)
  - cushioning (if explicitly described)

- Manufacturer ALWAYS overrides other sources when there is conflict for these fields
- Notes should be primarily based on manufacturer description, but rewritten (not copied)

STEP 2 — Trusted review sources (fill remaining fields)
Then use ONLY these sources to complete missing or weak fields:
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

Use these sources especially for:
- weight_oz
- heel_stack_mm
- forefoot_stack_mm
- offset_mm
- foam (if not clear from manufacturer)
- cushioning (performance characterization)
- support
- plated
- plate_type
- best_use
- ride characteristics

STEP 3 — Coverage requirement
- You must attempt to fill as many schema fields as possible
- Do not stop after finding one source
- Continue searching down the approved list until:
  - all major fields are filled, OR
  - no reliable data can be found

STEP 4 — Conflict resolution
- Manufacturer overrides for identity + MSRP fields
- For performance fields:
  - prefer agreement across multiple trusted sources
  - if disagreement exists, choose the most consistent value
  - lower confidence_score accordingly

STEP 5 — Strict rules
- Do NOT guess
- Do NOT fabricate values
- Do NOT use random sources outside the approved list unless absolutely necessary
4. Notes rules
- notes must be 40 words or less
- notes should primarily reflect the manufacturer’s description, rewritten in original language
- enhance with insights from trusted review sources when helpful
- focus on ride, cushioning, purpose, and defining traits
- do NOT copy text
- do NOT include marketing fluff
- do NOT mention sources

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



FIELD DEFINITIONS

You must follow these definitions exactly when constructing output:

display_name
- Clean public-facing name of the shoe
- Format: "Brand Model Version"
- Do NOT include gender
- Example: "Brooks Ghost 17"

brand
- Official manufacturer brand name
- Example: "Brooks", "Nike", "ASICS"

model
- Base model name only, without version if separable
- Example: "Ghost", "Pegasus", "1080"

version
- Version identifier only
- Examples: "17", "v14"
- If no version exists, return null

gender
- One of: mens | womens | unisex | unknown
- Based on the specific product being researched

manufacturer_model_id
- Official manufacturer style or product ID
- Must come from manufacturer source only
- If not clearly found, return null

aliases
- Array of alternate legitimate names for the same shoe
- Include variations like:
  - "Nike ZoomX Vaporfly Next% 3"
  - "Vaporfly 3"
- Do NOT include colorways or retailer naming noise

release_year
- Year this specific version was released
- Must be supported by a reliable source
- Otherwise return null

msrp_usd
- Standard retail price in USD (not sale price)
- Prefer manufacturer or major retailer
- Return number only (no currency symbols)

weight_oz
- Weight in ounces for the specific gender/version when possible
- Prefer trusted review or lab sources

heel_stack_mm
- Heel stack height in millimeters

forefoot_stack_mm
- Forefoot stack height in millimeters

offset_mm
- Heel-to-toe drop in millimeters
- If not explicitly stated, may be derived from stack values if both are known

surface
- One of: road | trail | track | xc | other | unknown
- Based on intended running surface

support
- One of: neutral | stability | motion_control | other | unknown

best_use
- Array of primary use cases
- Allowed values:
  - daily training
  - recovery
  - long runs
  - performance training
  - racing
  - trail running
  - hybrid
  - other

plated
- true if the shoe contains any plate, otherwise false or null if unknown

plate_type
- One of: carbon | nylon | pebax | tpu | other | none | unknown

foam
- Primary midsole foam name
- Example: "DNA LOFT v3", "ZoomX", "Fresh Foam X"

cushioning
- One of:
  minimal | low | low/mod | moderate | mod/high | high | unknown

upper
- Main upper material or construction
- Example: "engineered mesh", "double jacquard mesh"

notes
- Maximum 40 words
- Short, original runner-focused summary
- Highlight ride, cushioning, stability, and intended use
- Do NOT include marketing language
- Do NOT mention sources
- Do NOT copy text

confidence_score
- Number between 0 and 1
- Based on source agreement and reliability

SYSTEM FIELDS (DO NOT GENERATE)

slug
- Generated by system
- Format: brand-model-version-gender (lowercase, hyphen-separated)

normalized_key
- Generated by system
- Format: "brand model version gender" (lowercase, space-separated)

id, created_at, updated_at, review_status
- System-managed fields
- Do NOT include or modify

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

  const webSources =
  response.output?.[0]?.web_search_call?.action?.sources || [];

console.log("WEB SOURCES:", JSON.stringify(webSources, null, 2));
  const text =
    response.output_text ||
    response.output?.[0]?.content?.[0]?.text ||
    "";

  const parsed = parseJsonLoose(text);
  if (parsed.notes) {
  parsed.notes = parsed.notes
    .split(" ")
    .slice(0, 40)
    .join(" ");
}
  return postProcess(candidate, parsed);
}
