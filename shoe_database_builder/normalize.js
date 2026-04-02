function slugifyPart(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
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
  if (["neutral"].includes(s)) return "neutral";
  if (["stability"].includes(s)) return "stability";
  if (["motion_control", "motion control"].includes(s)) return "motion_control";
  if (["other"].includes(s)) return "other";
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

  const allowed = [
    "minimal",
    "low",
    "low/mod",
    "moderate",
    "mod/high",
    "high",
    "unknown",
  ];

  return allowed.includes(s) ? s : "unknown";
}

export function normalizeBestUse(list) {
  const allowed = new Set([
    "daily training",
    "recovery",
    "long runs",
    "performance training",
    "racing",
    "trail running",
    "hybrid",
    "other",
  ]);

  if (!Array.isArray(list)) return [];

  const cleaned = list
    .map((x) => String(x || "").trim().toLowerCase())
    .filter(Boolean)
    .filter((x) => allowed.has(x));

  return [...new Set(cleaned)];
}

export function toDisplayName({ brand, model, gender }) {
  return [brand, model, gender === "unknown" ? null : `(${gender})`]
    .filter(Boolean)
    .join(" ");
}

export function toSlug({ brand, model, gender }) {
  const parts = [brand, model, gender].map(slugifyPart).filter(Boolean);
  return parts.join("-");
}

export function toNormalizedKey({ brand, model, gender }) {
  return [
    slugifyPart(brand),
    slugifyPart(model),
    slugifyPart(normalizeGender(gender)),
  ].join("|");
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
