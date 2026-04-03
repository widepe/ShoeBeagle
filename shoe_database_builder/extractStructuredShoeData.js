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

export async function extractStructuredShoeData(aiClient, { candidate, snippets }) {
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

[keep your full REQUIREMENTS + FIELD DEFINITIONS + EVIDENCE RULES block exactly as you have it]

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

Return valid JSON only.
Do not include markdown fences.
Do not include explanations.
`.trim();

  const response = await aiClient.chat.completions.create({
    model: "sonar",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a precise data-extraction system. You must obey source order and return strictly valid JSON only.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const text = response.choices?.[0]?.message?.content || "";
  const parsed = parseJsonLoose(text);

  if (parsed.notes) {
    parsed.notes = parsed.notes
      .split(/\s+/)
      .slice(0, 40)
      .join(" ");
  }

  return postProcess(candidate, parsed);
}
