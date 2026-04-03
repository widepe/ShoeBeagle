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

const APPROVED_SOURCES = [
  "RunRepeat",
  "Running Warehouse",
  "RoadTrailRun",
  "Doctors of Running",
  "Running Shoes Guru",
  "OutdoorGearLab",
  "RTINGS",
  "Road Runner Sports",
  "Believe in the Run",
  "Sole Review",
  "Runner's World",
  "The Running Clinic",
];

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
  return String(value).trim().split(/\s+/).slice(0, 40).join(" ");
}

function normalizeEvidence(ev) {
  if (!ev || !ev.field_name) return null;

  return {
    field_name: String(ev.field_name).trim(),
    raw_value: ev.raw_value ?? null,
    normalized_value: ev.normalized_value ?? null,
    source_type: ev.source_type ?? "other",
    source_name: ev.source_name ?? "Unknown Source",
    source_url: ev.source_url ?? null,
    confidence_score:
      typeof ev.confidence_score === "number" ? ev.confidence_score : 0.7,
    is_selected: ev.is_selected === true,
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
  const rawModelText = String(
    candidate.raw_model_text || candidate.model || ""
  ).trim();

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

  // note: no throw here anymore

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
    confidence_score:
      typeof parsed.confidence_score === "number"
        ? parsed.confidence_score
        : 0.75,
    review_status: "unreviewed",
    evidence: dedupeEvidence(parsed.evidence),
  };
}
function buildResearchPrompt({ candidate, snippets }) {
  return `
You are an expert running shoe researcher building a structured database record.

Your job is to research this shoe on the web and return a single JSON object.

Research rules:
- If an official manufacturer page is available in the snippets, use it first for identity, style code, MSRP, upper, foam, and any explicitly stated specs.
- If no manufacturer page is available or accessible, you MUST still continue using ONLY these approved sources to fill as many fields as possible:
  ${APPROVED_SOURCES.map((s, i) => `${i + 1}. ${s}`).join("\\n  ")}
- Do not use unapproved sources.
- Do not guess; prefer null over speculation.
- However, DO fill fields that are clearly supported by one or more approved sources, even when the manufacturer page is missing.
- Manufacturer overrides identity + MSRP when present. Approved review/lab sources override retailer for performance specs (stack, weight, cushioning, use, ride).
- Include evidence rows for every non-trivial populated field.
- Evidence must name the source and include the URL when available.

Identity rules:
- The candidate identity is already verified.
- Canonicalize model and version cleanly.
- Keep gender normalized to one of: mens, womens, unisex, unknown.

Candidate:
${JSON.stringify(candidate, null, 2)}

Local snippets:
${JSON.stringify(snippets || [], null, 2)}

Return valid JSON only with this exact shape:
...
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
          "You are a precise data extraction system. Research the web, prefer official manufacturer data first, use only approved sources after that, and return valid JSON only.",
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
