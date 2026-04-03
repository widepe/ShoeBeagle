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

  // mens + unisex both normalize to men's US sizing
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
  const cushioning =
  mapManufacturerCushioning(parsed.manufacturer_cushioning_label) ||
  normalizeCushioning(parsed.cushioning);
  const plated =
    parsed.plated === true ? true : parsed.plated === false ? false : null;
  const plateType = normalizePlateType(parsed.plate_type, plated);

  if (!model) {
    throw new Error(
      `Extraction did not return a canonical model for raw_model_text="${rawModelText}"`
    );
  }

  const bestUseRaw = Array.isArray(parsed.best_use)
    ? parsed.best_use
    : typeof parsed.best_use === "string"
    ? parsed.best_use
        .replace(/[{}"]/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const result = {
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
    weight_oz: convertWeightToTargetSize({
  weightValue: parsed.weight_value,
  weightUnit: parsed.weight_unit,
  foundSize: parsed.weight_found_size,
  foundSizeSystem: parsed.weight_found_size_system,
  gender,
}),
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

Use web search, and ONLY the following sources to find data. Do NOT use sources other than the official manufacturer of the shoe and those on this list.

Manufacturer source examples:
- ASICS
- Saucony
- Brooks
- Nike
- New Balance
- Adidas

Approved source order after manufacturer:
1. RunRepeat
2. Running Warehouse
3. RoadTrailRun
4. Doctors of Running
5. Running Shoes Guru
6. OutdoorGearLab
7. RTINGS
8. Road Runner Sports
9. Believe in the Run
10. Sole Review
11. Runner's World
12. The Running Clinic

IMPORTANT:
- Start with the manufacturer as the highest priority.
- Fill in as many schema variables as possible.
- Whatever variables are not found from the manufacturer, move down the approved list from top to bottom, filling in missing variables as you go.
- Sources must be used strictly in the order listed.
- Do not skip ahead.
- Do not guess.
- Prefer null over weak or uncertain data.

INPUT CANDIDATE:
${JSON.stringify(candidate, null, 2)}

OPTIONAL LOCAL SNIPPETS:
${JSON.stringify(snippets || [], null, 2)}

REQUIREMENTS

1. Resolve shoe identity first
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

2. Search order and source priority

STEP 1 — Manufacturer (required first, highest priority)
Use the official manufacturer page first for all variables if available.
Manufacturer overrides all other sources when there is conflict.

Manufacturer is especially authoritative for:
- brand
- model
- version
- manufacturer_model_id
- msrp_usd
- release_year
- upper
- foam (if explicitly stated)
- cushioning (if explicitly described)
- notes should preferably be based on manufacturer description, but rewritten in neutral language

STEP 2 — Approved sources in strict order
For any missing fields, continue down this exact list in order:
1. RunRepeat
2. Running Warehouse
3. RoadTrailRun
4. Doctors of Running
5. Running Shoes Guru
6. OutdoorGearLab
7. RTINGS
8. Road Runner Sports
9. Believe in the Run
10. Sole Review
11. Runner's World
12. The Running Clinic

Do not stop after one source.
Continue moving down the list until:
- all reasonably supported schema variables are filled, OR
- the list is exhausted

3. Conflict resolution
- Manufacturer overrides all fields if explicit

CUSHIONING OVERRIDE RULE
- If the manufacturer explicitly provides a cushioning label or cushion variable, you MUST use it.
- If the manufacturer explicitly provides a cushioning label, you must return that mapped value even if review sources describe the ride differently.
- Do NOT override manufacturer cushioning with review language.
- If men's and women's manufacturer pages use the same cushioning description, assign the same cushioning value unless the manufacturer explicitly states a difference.

Manufacturer cushioning mapping:
- "Balanced" => moderate
- "Soft" => mod/high
- "Plush" => high
- "Max" => high
- "Firm but cushioned" => low/mod
- "Firm" => low
- "Minimal" => minimal

- If the manufacturer does not explicitly provide cushioning language, then prefer agreement across strong approved sources.
- If disagreement exists, choose the most consistent value.
- Lower confidence_score when disagreement exists.

4. Strict rules
- Do NOT guess
- Do NOT fabricate values
- Do NOT use random sources outside the approved list
- Every non-null field must have exactly one selected evidence object
- If a value is null, omit evidence for that field from your reasoning and only include non-null fields in the evidence array

FIELD DEFINITIONS

display_name
- Format: brand + model + version with spaces
- Do NOT include gender
- Example: "Brooks Ghost 17"

brand
- Official manufacturer brand name
- Example: "Brooks", "Nike", "ASICS"

model
- Base model name only, without version if separable
- Example: "Ghost", "Pegasus", "1080"

version
- Version identifier of the shoe
- May be numeric, alphanumeric, or named
- Examples:
  - "17"
  - "v14"
  - "3"
  - "Next% 3"
  - "Pro 2"
  - "Edge+"
- If the model includes a version, separate it from the base model
- If no version exists, return null

gender
- One of: mens | womens | unisex | unknown

manufacturer_model_id
- Official manufacturer style or product ID
- Must come from manufacturer only
- If not clearly found, return null

aliases
- Array of alternate legitimate names for the same shoe if any
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
- Return number only

weight_oz
- Weight must ONLY be used if the source explicitly states:
  - the weight value
  - the shoe size for that weight
  - the size system (US, UK, or EU)

- If weight is given in grams, convert it to ounces
  - oz = g / 28.3495

- Convert found size to US size first:
  - mens or unisex:
    - US = UK + 1
    - US = EU - 33
  - womens:
    - US = UK + 2
    - US = EU - 31

- After converting to US size, normalize to target size using 2.6% compounding per half size:
  - mens or unisex target = US men's 9
  - womens target = US women's 7

- Formulas:
  - men_size_9 = found_weight * (1.026)^((9 - found_size) * 2)
  - women_size_7 = found_weight * (1.026)^((7 - found_size) * 2)

- If the source does not explicitly state the size, return null
- If the source does not explicitly state the size system, return null
- If the source does not explicitly state the unit, return null
- Do NOT assume standard sizes
- Do NOT infer size from context

heel_stack_mm
- Heel stack height in millimeters

forefoot_stack_mm
- Forefoot stack height in millimeters

offset_mm
- Heel-to-toe drop in millimeters
- If not explicitly stated, may be derived from stack values if both are known

surface
- One of: road | trail | track | xc | other | unknown

support
- One of: neutral | stability | motion_control | other | unknown

best_use
- Array of:
  - daily training
  - recovery
  - long runs
  - performance training
  - racing
  - trail running
  - hybrid
  - treadmill
  - other
- If "other", it must be 1-3 lowercase words only

plated
- true | false | null

plate_type
- One of: carbon | nylon | pebax | tpu | other | none | unknown

foam
- Primary midsole foam name
- Example: "DNA LOFT v3", "ZoomX"

cushioning
- One of: minimal | low | low/mod | moderate | mod/high | high | unknown

Cushioning mapping rules:
- "max", "plush", "very soft" => high
- "soft", "well-cushioned" => mod/high
- "balanced", "medium" => moderate
- "firm but cushioned" => low/mod
- "firm", "ground feel" => low
- "barefoot", "minimal" => minimal

upper
- Main upper material or construction

notes
- 40 words or less
- Must describe the shoe’s defining ride characteristics and key construction features
- Prioritize what makes the shoe distinct within its category
- Rewrite manufacturer description in neutral, non-marketing language
- Positive attributes only, no negative statements
- Do NOT copy text
- Do NOT include fluff
- Do NOT mention sources

confidence_score
- Number between 0 and 1
- Based on source agreement and reliability

REQUIRED VS OPTIONAL FIELDS

TIER 1 — REQUIRED
These must be correct or the output is not acceptable:
- brand
- model
- gender
- version if the shoe has a version

Rules:
- Never guess these fields
- Use manufacturer naming first
- If the shoe is clearly first-generation, version = null is acceptable

TIER 2 — HIGH PRIORITY
Make a strong effort to fill these by continuing through the full source list:
- surface
- weight_oz
- offset_mm
- release_year
- msrp_usd
- support

TIER 3 — DESIRABLE
Fill when reasonably supported:
- heel_stack_mm
- forefoot_stack_mm
- foam
- cushioning
- plated
- plate_type
- best_use
- upper
- manufacturer_model_id
- aliases

TIER 4 — OUTPUT QUALITY
These must always be present:
- notes
- confidence_score

EVIDENCE RULES

For every non-null selected field, include one evidence object in the evidence array with:
- field_name
- raw_value
- normalized_value
- source_type
- source_name
- source_url
- confidence_score
- is_selected
- notes

Also include:
- date_accessed in YYYY-MM-DD format

Only one evidence object per selected field.
Evidence must directly support the selected value.

Normalized allowed values:
- gender: mens | womens | unisex | unknown
- surface: road | trail | track | xc | other | unknown
- support: neutral | stability | motion_control | other | unknown
- plate_type: carbon | nylon | pebax | tpu | other | none | unknown
- cushioning: minimal | low | low/mod | moderate | mod/high | high | unknown
- best_use items:
  - daily training
  - recovery
  - long runs
  - performance training
  - racing
  - trail running
  - hybrid
  - treadmill
  - other

SYSTEM FIELDS (DO NOT GENERATE)
- slug
- normalized_key
- id
- created_at
- updated_at
- review_status

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
  "evidence": array
}
`.trim();

  const response = await openai.responses.create({
    model: "gpt-5.4",
    tools: [{ type: "web_search" }],
    include: ["web_search_call.action.sources"],
    input: prompt,
  });

  const webSources = response.output?.[0]?.web_search_call?.action?.sources || [];
  console.log("WEB SOURCES:", JSON.stringify(webSources, null, 2));

  const text =
    response.output_text ||
    response.output?.[0]?.content?.[0]?.text ||
    "";

  const parsed = parseJsonLoose(text);

  if (parsed.notes) {
    parsed.notes = parsed.notes
      .split(/\s+/)
      .slice(0, 40)
      .join(" ");
  }

  return postProcess(candidate, parsed);
}
