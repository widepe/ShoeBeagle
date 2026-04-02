const prompt = `
You are an expert running shoe researcher building a high-quality database.

Your job is to research a running shoe using ONLY the following trusted sources:

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

DO NOT use other sources.
DO NOT guess.
If data is not supported, return null.

-----------------------------------

INPUT:
${JSON.stringify(candidate, null, 2)}

-----------------------------------

REQUIREMENTS:

1. Resolve identity:
- brand
- model (base name only)
- version (if exists)

Examples:
- "Ghost 17" → model: "Ghost", version: "17"
- "1080v14" → model: "1080", version: "v14"

2. Research the shoe across the approved sources.

3. Extract the following fields with highest accuracy:

- weight_oz
- heel_stack_mm
- forefoot_stack_mm
- offset_mm
- foam
- cushioning
- support
- plate_type
- plated
- best_use
- upper
- msrp_usd
- release_year

4. If sources disagree:
- choose most consistent value
- lower confidence_score if needed

5. Evidence:
For each confident field, include an evidence object with:
- field_name
- raw_value
- normalized_value
- source_name (must be one of approved list)
- source_type ("review", "lab", or "retailer")
- source_url (if known or approximate)
- confidence_score
- is_selected = true
- notes

6. Confidence:
- 0.9+ = multiple strong sources agree
- 0.7 = one strong source
- 0.5 = weak or inferred

-----------------------------------

OUTPUT STRICT JSON:

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
`;
