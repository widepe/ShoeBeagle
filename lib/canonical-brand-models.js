const canonicalBrandModels = require("./canonical-brands-models.json");

function normalizeSpace(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
}

function squashBrandKey(str) {
  return normalizeSpace(str)
    .toLowerCase()
    .replace(/[\u00AE\u2122\u2120]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function escapeRegExp(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toEntry(canonicalBrand, value) {
  if (Array.isArray(value)) {
    return {
      canonicalBrand,
      aliases: [canonicalBrand],
      models: value.filter((m) => typeof m === "string" && m.trim()),
    };
  }

  const aliases = Array.isArray(value?.aliases) ? value.aliases : [];
  const models = Array.isArray(value?.models) ? value.models : [];

  const aliasSet = new Set([canonicalBrand]);
  for (const alias of aliases) {
    if (typeof alias === "string" && alias.trim()) aliasSet.add(alias.trim());
  }

  return {
    canonicalBrand,
    aliases: Array.from(aliasSet),
    models: models.filter((m) => typeof m === "string" && m.trim()),
  };
}

function buildCanonicalBrandModelHelper(source = canonicalBrandModels) {
  const canonicalMap = new Map();
  const aliasToCanonical = new Map();
  const brandMatchers = [];
  const canonicalModelsLower = new Map();

  for (const [canonicalBrand, value] of Object.entries(source || {})) {
    const entry = toEntry(canonicalBrand, value);
    canonicalMap.set(canonicalBrand, entry);
    canonicalModelsLower.set(
      canonicalBrand,
      entry.models.map((m) => String(m).toLowerCase())
    );

    for (const alias of entry.aliases) {
      const key = squashBrandKey(alias);
      if (!key) continue;
      if (!aliasToCanonical.has(key)) aliasToCanonical.set(key, canonicalBrand);

      const normalizedAlias = normalizeSpace(alias);
      const tokenCount = normalizedAlias.split(" ").length;
      brandMatchers.push({
        alias,
        canonicalBrand,
        regex: new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(alias)}(?=[^A-Za-z0-9]|$)`, "i"),
        tokenCount,
        isShortSingleTokenAlias: tokenCount === 1 && normalizedAlias.length <= 2,
      });
    }
  }

  brandMatchers.sort((a, b) => {
    if (b.tokenCount !== a.tokenCount) return b.tokenCount - a.tokenCount;
    return b.alias.length - a.alias.length;
  });

  function resolveCanonicalBrand(rawBrand) {
    const cleaned = normalizeSpace(rawBrand);
    if (!cleaned) return "";

    const key = squashBrandKey(cleaned);
    return aliasToCanonical.get(key) || "";
  }

  function getCanonicalModels(rawBrand) {
    const canonicalBrand = resolveCanonicalBrand(rawBrand);
    if (!canonicalBrand) return [];
    return canonicalMap.get(canonicalBrand)?.models || [];
  }

  function detectCanonicalBrandFromText(rawText) {
    const text = String(rawText || "");
    if (!text.trim()) return "";

    for (const matcher of brandMatchers) {
      const match = matcher.regex.exec(text);
      if (!match) continue;
      if (matcher.isShortSingleTokenAlias && match.index > 0) {
        const afterMatch = text.slice(match.index + match[0].length).toLowerCase();
        const modelList = canonicalModelsLower.get(matcher.canonicalBrand) || [];
        const hasKnownModelAfterAlias = modelList.some((model) => afterMatch.includes(model));
        if (!hasKnownModelAfterAlias) continue;
      }
      return matcher.canonicalBrand;
    }

    return "";
  }

  function parseBrandModelFromText(listingText, rawBrandHint = "") {
    const rawTitle = String(listingText || "");
    if (!rawTitle.trim()) return { brand: "Unknown", model: "" };

    const hintCanonical = resolveCanonicalBrand(rawBrandHint) || detectCanonicalBrandFromText(rawBrandHint);
    const titleCanonical = detectCanonicalBrandFromText(rawTitle);
    const canonicalBrand = hintCanonical || titleCanonical;

    if (!canonicalBrand) return { brand: "Unknown", model: rawTitle };

    const matchersForBrand = brandMatchers.filter((m) => m.canonicalBrand === canonicalBrand);
    let model = rawTitle;

    for (const matcher of matchersForBrand) {
      if (matcher.regex.test(model)) {
        model = model.replace(matcher.regex, " ").replace(/\s+/g, " ").trim();
        if (model) break;
      }
    }

    const canonicalModels = getCanonicalModels(canonicalBrand);
    if (model) {
      const modelLower = model.toLowerCase();
      for (const candidate of canonicalModels) {
        if (modelLower.includes(String(candidate).toLowerCase())) {
          return { brand: canonicalBrand, model: candidate };
        }
      }
    }

    return { brand: canonicalBrand, model: model || rawTitle };
  }

  return {
    getCanonicalBrandKeys: () => Array.from(canonicalMap.keys()),
    getAliasToCanonicalMap: () => new Map(aliasToCanonical),
    resolveCanonicalBrand,
    getCanonicalModels,
    detectCanonicalBrandFromText,
    parseBrandModelFromText,
  };
}

const canonicalBrandModelHelper = buildCanonicalBrandModelHelper();

module.exports = {
  buildCanonicalBrandModelHelper,
  canonicalBrandModelHelper,
  squashBrandKey,
};
