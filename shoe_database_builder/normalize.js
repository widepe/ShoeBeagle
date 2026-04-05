function slugifyPart(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

export function splitModelAndVersion(rawModel, brand = null) {
  const input = String(rawModel || "").trim();
  if (!input) {
    return {
      raw_model_text: "",
      model: null,
      version: null,
    };
  }

  let text = input
    .replace(/\s+/g, " ")
    .replace(/[–—]/g, "-")
    .trim();

  if (brand) {
    const brandEscaped = String(brand)
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`^${brandEscaped}\\s+`, "i"), "").trim();
  }

  text = text
    .replace(/\b(mens|men's|mens'|women's|womens|women|unisex)\b/gi, "")
    .replace(/\b(running shoe|running shoes|shoe|shoes)\b/gi, "")
    .replace(/\b(wide|extra wide|narrow|regular)\b/gi, "")
    .replace(/\((.*?)\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return {
      raw_model_text: input,
      model: null,
      version: null,
    };
  }

  let match;

  match = text.match(/^(.+?)\s+(v\d+)$/i);
  if (match) {
    return {
      raw_model_text: input,
      model: match[1].trim(),
      version: match[2].trim(),
    };
  }

  match = text.match(/^(.+?)(v\d+)$/i);
  if (match) {
    return {
      raw_model_text: input,
      model: match[1].trim(),
      version: match[2].trim(),
    };
  }

  match = text.match(/^(.+?)\s+(\d+)$/);
  if (match) {
    return {
      raw_model_text: input,
      model: match[1].trim(),
      version: match[2].trim(),
    };
  }

  match = text.match(/^(.+?)-(\d+)$/);
  if (match) {
    return {
      raw_model_text: input,
      model: match[1].trim(),
      version: match[2].trim(),
    };
  }

  return {
    raw_model_text: input,
    model: text,
    version: null,
  };
}

export function normalizeGender(gender) {
  const g = String(gender || "").trim().toLowerCase();

  if (!g) return "unknown";
  if (["mens", "men", "male", "m"].includes(g)) return "mens";
  if (["womens", "women", "female", "w"].includes(g)) return "womens";
  if (["unisex"].includes(g)) return "unisex";
  return "unknown";
}

export function normalizeSurface(surface) {
  const s = String(surface || "").trim().toLowerCase();

  if (!s) return "unknown";
  if (["road"].includes(s)) return "road";
  if (["trail"].includes(s)) return "trail";
  if (["track"].includes(s)) return "track";
  if (["xc", "cross country", "cross-country", "x-country"].includes(s)) return "xc";
  if (["other"].includes(s)) return "other";
  return "unknown";
}

export function normalizeSupport(support) {
  const s = String(support || "").trim().toLowerCase();

  if (!s) return "unknown";

  const canonical = new Set(["neutral", "stability", "motion_control", "none", "other"]);
  if (canonical.has(s)) return s;

  // Alias map: common AI/manufacturer/review terms → canonical
  const aliases = {
    // neutral
    "neutral cushioning":         "neutral",
    "neutral support":            "neutral",
    "no support":                 "neutral",
    "underpronation":             "neutral",
    "supination":                 "neutral",
    "cushioned":                  "neutral",
    "cushion":                    "neutral",
    // stability
    "stability support":          "stability",
    "mild stability":             "stability",
    "mild support":               "stability",
    "moderate support":           "stability",
    "moderate stability":         "stability",
    "light stability":            "stability",
    "light support":              "stability",
    "structured":                 "stability",
    "guiding":                    "stability",
    "guided":                     "stability",
    "overpronation":              "stability",
    "overpronation control":      "stability",
    "pronation control":          "stability",
    "anti-pronation":             "stability",
    "antipronation":              "stability",
    "support":                    "stability",
    "supportive":                 "stability",
    // motion control
    "motion control":             "motion_control",
    "maximum support":            "motion_control",
    "maximum stability":          "motion_control",
    "max support":                "motion_control",
    "max stability":              "motion_control",
    "severe overpronation":       "motion_control",
    "rigid support":              "motion_control",
    "high support":               "motion_control",
    "high stability":             "motion_control",
    // none
    "barefoot":                   "none",
    "minimalist":                 "none",
    "zero support":               "none",
    "no arch support":            "none",
  };

  if (aliases[s]) return aliases[s];

  // Fuzzy keyword fallback
  if (/motion.{0,5}control|maximum.{0,10}support|maximum.{0,10}stability|severe.{0,10}pronat/.test(s)) return "motion_control";
  if (/stabilit|overpron|pronation|structured|guiding|supportive/.test(s)) return "stability";
  if (/neutral|supination|underpron|no.{0,5}support/.test(s)) return "neutral";
  if (/barefoot|minimalist|zero.{0,5}drop/.test(s)) return "none";

  return "unknown";
}

export function normalizePlateType(plateType, plated) {
  const p = String(plateType || "").trim().toLowerCase();

  if (!p) {
    if (plated === false) return "none";
    return "unknown";
  }

  if (["carbon"].includes(p)) return "carbon";
  if (["nylon"].includes(p)) return "nylon";
  if (["pebax"].includes(p)) return "pebax";
  if (["tpu"].includes(p)) return "tpu";
  if (["none"].includes(p)) return "none";
  if (["other"].includes(p)) return "other";
  return "unknown";
}

export function normalizeCushioning(value) {
  const s = String(value || "").trim().toLowerCase();

  if (!s) return "unknown";

  const canonical = new Set(["minimal", "low", "low/mod", "moderate", "mod/high", "high"]);
  if (canonical.has(s)) return s;

  // Alias map: common AI/manufacturer returned values → canonical
  const aliases = {
    // minimal
    "very low":               "minimal",
    "barefoot":               "minimal",
    "zero drop":              "minimal",
    // low
    "firm":                   "low",
    "lean":                   "low",
    "light":                  "low",
    "lightweight":            "low",
    "low cushion":            "low",
    "low cushioning":         "low",
    // low/mod
    "low to moderate":        "low/mod",
    "low-moderate":           "low/mod",
    "firm but cushioned":     "low/mod",
    "moderate-low":           "low/mod",
    // moderate
    "medium":                 "moderate",
    "medium cushion":         "moderate",
    "medium cushioning":      "moderate",
    "moderate cushion":       "moderate",
    "moderate cushioning":    "moderate",
    "balanced":               "moderate",
    "neutral cushioning":     "moderate",
    "everyday cushioning":    "moderate",
    "standard":               "moderate",
    // mod/high
    "moderate to high":       "mod/high",
    "moderate-high":          "mod/high",
    "soft":                   "mod/high",
    "well cushioned":         "mod/high",
    "well-cushioned":         "mod/high",
    "high-moderate":          "mod/high",
    // high
    "max":                    "high",
    "max cushion":            "high",
    "max cushioning":         "high",
    "maximum":                "high",
    "maximum cushion":        "high",
    "maximum cushioning":     "high",
    "maximal":                "high",
    "maximalist":             "high",
    "plush":                  "high",
    "ultra cushioned":        "high",
    "ultra-cushioned":        "high",
    "super cushioned":        "high",
    "heavily cushioned":      "high",
    "high cushion":           "high",
    "high cushioning":        "high",
    "over cushioned":         "high",
    "over-cushioned":         "high",
    "marshmallowy":           "high",
    "bouncy":                 "high",
    // minimal
    "ultra light":            "minimal",
    "ultra-light":            "minimal",
    "minimalist":             "minimal",
    "traditional cushion":    "minimal",
    "traditional":            "minimal",
    "racing flat":            "minimal",
    // low
    // NOTE: "responsive", "snappy", "springy", "energetic" removed — these are ride-feel
    // descriptors, not cushioning levels. A moderate shoe can be responsive.
    "lean cushion":           "low",
    "lean cushioning":        "low",
    // moderate
    "cushioned":              "moderate",
    "comfortable":            "moderate",
    "protective":             "moderate",
    "everyday":               "moderate",
    // mod/high
    "lush":                   "mod/high",
    "luxurious":              "mod/high",
    "pillowy":                "mod/high",
    "cloud-like":             "mod/high",
    "cloud like":             "mod/high",
  };

  // Exact alias match
  if (aliases[s]) return aliases[s];

  // Fuzzy fallback — partial keyword match for phrases not in the alias map
  if (/max|plush|marshmallow|ultra\s*cushion|over\s*cushion|maximalist|maximal/.test(s)) return "high";
  if (/lush|pillowy|cloud|luxur|very\s*soft|super\s*soft/.test(s)) return "mod/high";
  if (/medium|moderate|balanced|cushioned|comfortable|protective|everyday|standard/.test(s)) return "moderate";
  if (/low[- ]mod|low to mod|firm.*cushion|cushion.*firm/.test(s)) return "low/mod";
  if (/firm|lean/.test(s)) return "low";
  if (/minimal|barefoot|minimalist|traditional|racing flat|zero[- ]drop/.test(s)) return "minimal";

  return "unknown";
}

export function normalizeBestUse(list) {
  // Canonical allowed values
  const canonical = new Set([
    "daily training",
    "recovery",
    "long runs",
    "performance training",
    "racing",
    "trail running",
    "hybrid",
    "treadmill",
    "track",
    "cross-country",
    "other",
  ]);

  // Alias map: common AI-returned values → canonical value
  const aliases = {
    // daily training
    "daily_trainer":          "daily training",
    "daily trainer":          "daily training",
    "daily":                  "daily training",
    "everyday":               "daily training",
    "everyday training":      "daily training",
    "training":               "daily training",
    // recovery
    "easy runs":              "recovery",
    "easy":                   "recovery",
    "easy run":               "recovery",
    // long runs
    "long_run":               "long runs",
    "long run":               "long runs",
    "long":                   "long runs",
    // performance training
    "tempo":                  "performance training",
    "speedwork":              "performance training",
    "tempo & speedwork":      "performance training",
    "tempo and speedwork":    "performance training",
    "speed":                  "performance training",
    "workout":                "performance training",
    "workouts":               "performance training",
    "fast":                   "performance training",
    "speed work":             "performance training",
    // racing
    "race":                   "racing",
    "race day":               "racing",
    // trail running
    "trail":                  "trail running",
    "trails":                 "trail running",
    // treadmill
    "treadmill running":      "treadmill",
    // daily training — versatile/all-around road shoes map here, not hybrid
    "versatile":              "daily training",
    "all-around":             "daily training",
    "all around":             "daily training",
    // hybrid — road/trail or road/off-road crossover shoes only
    "road to trail":          "hybrid",
    "road and trail":         "hybrid",
    "road/trail":             "hybrid",
    // track
    "track running":          "track",
    "track spikes":           "track",
    "spikes":                 "track",
    // cross-country
    "cross country":          "cross-country",
    "xc":                     "cross-country",
    "xc running":             "cross-country",
    "cross-country running":  "cross-country",
    "cross country running":  "cross-country",
    // other
    "unknown":                "other",
  };

  if (!Array.isArray(list)) return [];

  const cleaned = list
    .map((x) => {
      const raw = String(x || "").trim().toLowerCase();
      if (!raw) return null;

      // Exact canonical match
      if (canonical.has(raw)) return raw;

      // Exact alias match
      if (aliases[raw]) return aliases[raw];

      // Fuzzy keyword fallback — partial match for unrecognized phrases
      if (/cross.{0,5}country|\bxc\b/.test(raw)) return "cross-country";
      if (/treadmill/.test(raw)) return "treadmill";
      if (/\btrack\b/.test(raw)) return "track";
      if (/trail/.test(raw) && /road/.test(raw)) return "hybrid";
      if (/trail/.test(raw)) return "trail running";
      if (/race|racing/.test(raw)) return "racing";
      if (/tempo|speed|performance|workout|interval/.test(raw)) return "performance training";
      if (/long/.test(raw)) return "long runs";
      if (/recover|easy|rest/.test(raw)) return "recovery";
      if (/daily|everyday|versatile|all.around|all purpose|general/.test(raw)) return "daily training";

      return null;
    })
    .filter(Boolean);

  return [...new Set(cleaned)];
}

export function toDisplayName({ brand, model, gender }) {
  return [brand, model, gender === "unknown" ? null : `(${gender})`]
    .filter(Boolean)
    .join(" ");
}

export function toSlug({ brand, model, version, gender }) {
  const parts = [brand, model, version, gender].map(slugifyPart).filter(Boolean);
  return parts.join("-");
}

export function toNormalizedKey({ brand, model, version, gender }) {
  return [
    slugifyPart(brand),
    slugifyPart(model),
    slugifyPart(version),
    slugifyPart(normalizeGender(gender)),
  ].join(" ");
}

export function cleanAliases(aliases) {
  if (!Array.isArray(aliases)) return [];
  return [...new Set(
    aliases
      .map((x) => String(x || "").trim())
      .filter(Boolean)
  )];
}

export function safeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
