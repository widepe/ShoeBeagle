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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function convertWeightToTargetSize({ weightValue, weightUnit, foundSize, foundSizeSystem, gender }) {
  const ounces = toOunces(weightValue, weightUnit);
  const usSize = toUsSize(foundSize, foundSizeSystem, gender);
  const g = normalizeGender(gender);
  if (ounces === null || usSize === null) return null;
  const targetSize = g === "womens" ? 7 : 9;
  const halfSizeSteps = (targetSize - usSize) * 2;
  return Number((ounces * Math.pow(1.026, halfSizeSteps)).toFixed(2));
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
  return words.join(" ").trim() || null;
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
    confidence_score: typeof ev.confidence_score === "number" ? ev.confidence_score : 0.7,
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

// ---------------------------------------------------------------------------
// Manufacturer domain discovery
// ---------------------------------------------------------------------------

// Derives candidate domains from the brand name without hardcoding.
// e.g. "Brooks" → ["brooksrunning.com", "brooks.com"]
// e.g. "New Balance" → ["newbalance.com", "new-balance.com"]
function candidateManufacturerDomains(brand) {
  const raw = String(brand || "").trim().toLowerCase();
  if (!raw) return [];

  // Remove spaces/hyphens to get a compact token (e.g. "newbalance")
  const compact = raw.replace(/[\s\-]+/g, "");
  // Hyphenated version (e.g. "new-balance")
  const hyphenated = raw.replace(/\s+/g, "-").replace(/-+/g, "-");

  const candidates = new Set();

  // Common patterns: brand + running, brand alone, hyphenated brand
  candidates.add(`${compact}running.com`);
  candidates.add(`${compact}.com`);
  if (hyphenated !== compact) {
    candidates.add(`${hyphenated}.com`);
  }

  return [...candidates];
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const JSON_SCHEMA = `{
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
}`;

function buildManufacturerPrompt({ candidate }) {
  const shoeName = [
    candidate.brand,
    candidate.verified_model || candidate.model,
    candidate.verified_version || "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  return `You are extracting running shoe specs from the official ${candidate.brand} manufacturer website.

Search the official ${candidate.brand} website for the product page of the ${shoeName} (${candidate.gender}).

Extract every available technical spec directly from the manufacturer page. Include:
- weight (record exact size and size system it was listed at)
- heel stack height (mm)
- forefoot stack height (mm)
- heel-to-toe drop / offset (mm)
- foam / midsole material name
- upper material description
- support type (neutral, stability, motion control)
- plate type if any
- MSRP / retail price in USD
- manufacturer model ID / product code (SKU or style number)
- release year (the year this version/edition was released)
- cushioning label as the manufacturer describes it (e.g. "balanced", "plush", "soft")
- best_use: what the shoe is designed for — pick all that apply from: daily training, recovery, long runs, performance training, racing, trail running, hybrid, treadmill, track, cross-country. Use the shoe's described purpose, category, and intended use on the manufacturer page.
- notes: 40-word max paraphrased synthesis of the shoe's positive attributes and special features from the manufacturer page

Candidate identity:
${JSON.stringify(
  {
    brand: candidate.brand,
    model: candidate.verified_model || candidate.model,
    version: candidate.verified_version || null,
    gender: candidate.gender,
  },
  null,
  2
)}

Rules:
- source_type for all evidence must be "brand"
- source_name must be the brand name (e.g. "${candidate.brand}")
- source_url must be the exact manufacturer page URL you found the data on
- Do not use retailer pages
- Return valid JSON only — no commentary, no markdown

${JSON_SCHEMA}`.trim();
}

function buildReviewPrompt({ candidate, snippets, missingFields }) {
  const shoeName = [
    candidate.brand,
    candidate.verified_model || candidate.model,
    candidate.verified_version || "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  const fieldList = missingFields.length > 0
    ? `Focus especially on these fields that are still missing: ${missingFields.join(", ")}`
    : "Fill as many fields as possible.";

  return `You are extracting running shoe specs from approved running shoe review sources.

Search for the ${shoeName} (${candidate.gender}) across these approved sources:
${APPROVED_SOURCES.map((s, i) => `${i + 1}. ${s.name}`).join("\\n")}

Do NOT use retailer pages (Amazon, Running Warehouse, REI, Zappos, etc.) for technical specs.
${fieldList}

For best_use, pick all that apply from these exact values only: daily training, recovery, long runs, performance training, racing, trail running, hybrid, treadmill, track, cross-country. Infer from how the review describes the shoe's purpose and intended use.
For cushioning, use one of: minimal, low, low/mod, moderate, mod/high, high. Base it on reviewer descriptions of the midsole feel and stack.
For release_year, look for the year this specific version was released or reviewed — not the original model launch year.

Local snippets already fetched (use these plus your own live search):
${JSON.stringify(snippets || [], null, 2)}

Candidate identity:
${JSON.stringify(
  {
    brand: candidate.brand,
    model: candidate.verified_model || candidate.model,
    version: candidate.verified_version || null,
    gender: candidate.gender,
  },
  null,
  2
)}

Rules:
- Each evidence row must have the correct source_name and source_url
- Prefer null over speculation
- Weight: record exact size and size system it was listed at (weight_found_size + weight_found_size_system)
- Return valid JSON only — no commentary, no markdown

${JSON_SCHEMA}`.trim();
}

// ---------------------------------------------------------------------------
// Merge two parsed results — manufacturer wins on any field it filled
// ---------------------------------------------------------------------------

const SPEC_FIELDS = [
  "display_name", "brand", "model", "version", "gender",
  "manufacturer_model_id", "aliases", "release_year", "msrp_usd",
  "weight_oz", "weight_value", "weight_unit", "weight_found_size",
  "weight_found_size_system", "heel_stack_mm", "forefoot_stack_mm",
  "offset_mm", "surface", "support", "best_use", "plated", "plate_type",
  "foam", "manufacturer_cushioning_label", "cushioning", "upper", "notes",
];

function isMissingParsed(field, value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return true;
    if (["surface", "support", "plate_type", "cushioning"].includes(field) && v === "unknown") return true;
    return false;
  }
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function getMissingParsedFields(parsed) {
  return SPEC_FIELDS.filter((f) => isMissingParsed(f, parsed[f]));
}

function mergeParsed(manufacturer, review) {
  // Manufacturer wins on every field it provided.
  // Review fills in anything manufacturer missed.
  const merged = { ...review };

  for (const field of SPEC_FIELDS) {
    if (!isMissingParsed(field, manufacturer[field])) {
      merged[field] = manufacturer[field];
    }
  }

  // Combine evidence from both
  const mfEvidence = Array.isArray(manufacturer.evidence) ? manufacturer.evidence : [];
  const rvEvidence = Array.isArray(review.evidence) ? review.evidence : [];
  merged.evidence = [...mfEvidence, ...rvEvidence];

  // Take higher confidence
  merged.confidence_score = Math.max(
    typeof manufacturer.confidence_score === "number" ? manufacturer.confidence_score : 0,
    typeof review.confidence_score === "number" ? review.confidence_score : 0
  );

  return merged;
}

// ---------------------------------------------------------------------------
// postProcess — unchanged from original
// ---------------------------------------------------------------------------

function postProcess(candidate, parsed) {
  const brand = String(parsed.brand || candidate.brand || "").trim();
  const fallbackModel = candidate.verified_model || candidate.model || "";
  const fallbackVersion = candidate.verified_version || null;
  const model = String(parsed.model || fallbackModel || "").trim();

  const version =
    parsed.version !== undefined && parsed.version !== null && String(parsed.version).trim() !== ""
      ? String(parsed.version).trim()
      : fallbackVersion;

  const gender = normalizeGender(parsed.gender || candidate.gender);
  const surface = normalizeSurface(parsed.surface || candidate.surface);
  const support = normalizeSupport(parsed.support);
  const cushioning =
    mapManufacturerCushioning(parsed.manufacturer_cushioning_label) ||
    normalizeCushioning(parsed.cushioning);

  const plated = parsed.plated === true ? true : parsed.plated === false ? false : null;
  const plateType = normalizePlateType(parsed.plate_type, plated);

  const bestUseRaw = Array.isArray(parsed.best_use)
    ? parsed.best_use
    : typeof parsed.best_use === "string"
      ? parsed.best_use.replace(/[{}"]/g, "").split(",").map((s) => s.trim()).filter(Boolean)
      : [];

  const convertedWeight = convertWeightToTargetSize({
    weightValue: parsed.weight_value,
    weightUnit: parsed.weight_unit,
    foundSize: parsed.weight_found_size,
    foundSizeSystem: parsed.weight_found_size_system,
    gender,
  });

  const evidenceList = dedupeEvidence(parsed.evidence);

const approvedLower = APPROVED_SOURCES.map((s) =>
  String(s.name || "").toLowerCase()
);

const hasApprovedEvidence = evidenceList.some((ev) => {
  const name = String(ev.source_name || "").toLowerCase();
  const type = String(ev.source_type || "").toLowerCase();
  return approvedLower.includes(name) || type === "brand";
});

  const baseConfidence = typeof parsed.confidence_score === "number" ? parsed.confidence_score : 0.75;
  const confidence_score = hasApprovedEvidence ? Math.max(baseConfidence, 0.85) : baseConfidence;

  return {
    display_name: version
      ? `${brand} ${model}${/^v/i.test(version) ? version : ` ${version}`}`
      : `${brand} ${model}`,
    brand,
    model,
    version,
    gender,
    manufacturer_model_id: parsed.manufacturer_model_id ? String(parsed.manufacturer_model_id).trim() : null,
    aliases: cleanAliases(parsed.aliases),
    release_year: Number.isInteger(parsed.release_year) ? parsed.release_year : null,
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

// ---------------------------------------------------------------------------
// Search API helpers — guaranteed domain enforcement
// ---------------------------------------------------------------------------

// One Perplexity Search client per call (reads PERPLEXITY_API_KEY from env)
// Dynamic import because @perplexity-ai/perplexity_ai is ESM-only
async function getSearchClient() {
  const { default: Perplexity } = await import("@perplexity-ai/perplexity_ai");
  return new Perplexity({ apiKey: process.env.PERPLEXITY_API_KEY });
}

// Run a Search API query against specific domains, return result pages
async function searchDomains({ query, domains, maxResults = 5, label }) {
  const searchClient = await getSearchClient();
  try {
    const result = await searchClient.search.create({
      query,
      search_domain_filter: domains,
      max_results: maxResults,
      max_tokens_per_page: 2048,
    });
    const pages = result.results || [];
    console.log(`SEARCH_${label}_OK`, {
      query,
      domains,
      pages_returned: pages.length,
      urls: pages.map((p) => p.url),
    });
    return pages;
  } catch (err) {
    console.log(`SEARCH_${label}_FAIL`, { query, domains, error: err?.message || String(err) });
    return [];
  }
}

// Format search result pages into a readable block for the extraction prompt
function formatSearchResults(pages) {
  if (!pages.length) return "No results found.";
  return pages
    .map((p, i) =>
      [
        `[${i + 1}] ${p.title}`,
        `URL: ${p.url}`,
        `Content: ${(p.snippet || "").trim()}`,
      ].join("\n")
    )
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Main export — Search API for source control, chat completions for extraction
// ---------------------------------------------------------------------------

export async function extractStructuredShoeData(aiClient, { candidate, snippets }) {
  const manufacturerDomains = candidateManufacturerDomains(candidate.brand);
  const allReviewDomains = APPROVED_SOURCES.flatMap((s) => s.domains || []); // all 12 — Search API supports 20

  const shoeName = [
    candidate.brand,
    candidate.verified_model || candidate.model,
    candidate.verified_version || "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  console.log("EXTRACTION_START", {
    brand: candidate.brand,
    model: candidate.verified_model || candidate.model,
    version: candidate.verified_version || null,
    gender: candidate.gender,
    manufacturer_domains: manufacturerDomains,
  });

  // ── Step 1: Search API — domain-enforced, guaranteed source control ─────────
  // Both searches fire in parallel. Search API hard-filters to specified domains.
  // The model never searches on its own — it only reads what we give it.
  const [mfPages, rvPages] = await Promise.all([
    searchDomains({
      query: `${shoeName} ${candidate.gender} official specs`,
      domains: manufacturerDomains,
      maxResults: 3,
      label: "MANUFACTURER",
    }),
    searchDomains({
      query: `${shoeName} ${candidate.gender} running shoe specs weight stack drop foam cushioning best use`,
      domains: allReviewDomains,
      maxResults: 10,
      label: "REVIEW",
    }),
  ]);

  // ── Step 2: Chat completions — extract JSON from pre-filtered search results ─
  const mfSnippets = formatSearchResults(mfPages);
  const rvSnippets = formatSearchResults(rvPages);

  const [mfResult, rvResult] = await Promise.allSettled([

    // Extraction call 1: manufacturer pages only
    aiClient.chat.completions.create({
      model: "sonar",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `You are extracting running shoe specs from manufacturer web pages. Extract only from the provided search results below. Do not search the web. Return valid JSON only — no commentary, no markdown fences.`,
        },
        {
          role: "user",
          content: `${buildManufacturerPrompt({ candidate })}\n\nManufacturer search results to extract from:\n${mfSnippets}`,
        },
      ],
    }),

    // Extraction call 2: review pages only
    aiClient.chat.completions.create({
      model: "sonar",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `You are extracting running shoe specs from running shoe review pages. Extract only from the provided search results below. Do not search the web. Return valid JSON only — no commentary, no markdown fences.`,
        },
        {
          role: "user",
          content: `${buildReviewPrompt({ candidate, snippets: [], missingFields: [] })}\n\nApproved source search results to extract from:\n${rvSnippets}`,
        },
      ],
    }),

  ]);

  // ── Parse results ─────────────────────────────────────────────────────────
  let manufacturerParsed = null;
  let manufacturerError = null;

  if (mfResult.status === "fulfilled") {
    try {
      const mfText = mfResult.value.choices?.[0]?.message?.content || "";
      manufacturerParsed = parseJsonLoose(mfText);
      console.log("MANUFACTURER_EXTRACTION_OK", {
        brand: candidate.brand,
        source_urls: mfPages.map((p) => p.url),
        missing_after: getMissingParsedFields(manufacturerParsed),
      });
    } catch (err) {
      manufacturerError = err?.message || String(err);
      console.log("MANUFACTURER_PARSE_FAIL", { brand: candidate.brand, error: manufacturerError });
    }
  } else {
    manufacturerError = mfResult.reason?.message || String(mfResult.reason);
    console.log("MANUFACTURER_EXTRACTION_FAIL", { brand: candidate.brand, error: manufacturerError });
  }

  let reviewParsed = null;

  if (rvResult.status === "fulfilled") {
    try {
      const rvText = rvResult.value.choices?.[0]?.message?.content || "";
      reviewParsed = parseJsonLoose(rvText);
      console.log("REVIEW_EXTRACTION_OK", {
        brand: candidate.brand,
        source_urls: rvPages.map((p) => p.url),
        missing_after: getMissingParsedFields(reviewParsed),
      });
    } catch (err) {
      console.log("REVIEW_PARSE_FAIL", { brand: candidate.brand, error: err?.message || String(err) });
    }
  } else {
    console.log("REVIEW_EXTRACTION_FAIL", { brand: candidate.brand, error: rvResult.reason?.message || String(rvResult.reason) });
  }

  // ── Merge: manufacturer wins, review fills gaps ───────────────────────────
  let merged;
  if (manufacturerParsed && reviewParsed) {
    const missingBeforeMerge = getMissingParsedFields(manufacturerParsed);
    merged = mergeParsed(manufacturerParsed, reviewParsed);
    console.log("MERGE_STRATEGY", {
      brand: candidate.brand,
      strategy: "manufacturer_wins_review_fills",
      manufacturer_missing: missingBeforeMerge,
      still_missing_after_merge: getMissingParsedFields(merged),
    });
  } else if (manufacturerParsed) {
    merged = manufacturerParsed;
    console.log("MERGE_STRATEGY", {
      brand: candidate.brand,
      strategy: "manufacturer_only",
      still_missing_after_merge: getMissingParsedFields(merged),
    });
  } else if (reviewParsed) {
    merged = reviewParsed;
    console.log("MERGE_STRATEGY", {
      brand: candidate.brand,
      strategy: "review_only_manufacturer_failed",
      manufacturer_error: manufacturerError,
      still_missing_after_merge: getMissingParsedFields(merged),
    });
  } else {
    throw new Error("All extraction calls failed — no data returned.");
  }

  console.log("EXTRACTED_FINAL", {
    brand: candidate.brand,
    model: candidate.model,
    gender: candidate.gender,
    missing_fields: getMissingParsedFields(merged),
  });

  return postProcess(candidate, merged);
}
