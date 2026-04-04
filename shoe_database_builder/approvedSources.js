export const APPROVED_SOURCES = [
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

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function compact(parts) {
  return parts.map((x) => String(x || "").trim()).filter(Boolean);
}

function normalizeSourceKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function buildIdentity(candidate) {
  const brand = String(candidate?.brand || "").trim();
  const model = String(candidate?.verified_model || candidate?.model || "").trim();
  const version = String(candidate?.verified_version || "").trim();
  const gender = String(candidate?.gender || "").trim().toLowerCase();

  const modelWithVersion = compact([model, version]).join(" ").trim();
  const fullName = compact([brand, model, version]).join(" ").trim();

  return {
    brand,
    model,
    version,
    gender,
    modelWithVersion,
    fullName,
    fullSlug: slugify(fullName),
    modelSlug: slugify(modelWithVersion),
  };
}

function buildManufacturerTarget(identity) {
  return {
    source_name: identity.brand || "Manufacturer",
    source_type: "brand",
    source_url: null,
    priority: 1,
    discovery_queries: [
      compact([identity.brand, identity.model, identity.version, "running shoe"]).join(" "),
      compact([identity.brand, identity.model, identity.version, "official"]).join(" "),
      compact([identity.brand, identity.model, identity.version, "manufacturer"]).join(" "),
    ].filter(Boolean),
    candidate_hints: {
      brand: identity.brand,
      model: identity.model,
      version: identity.version,
      gender: identity.gender,
      full_name: identity.fullName,
      full_slug: identity.fullSlug,
      model_slug: identity.modelSlug,
    },
  };
}

function buildSourceTarget(sourceName, priority, identity) {
  return {
    source_name: sourceName,
    source_type: "review",
    source_url: null,
    priority,
    discovery_queries: [
      compact([sourceName, identity.brand, identity.model, identity.version]).join(" "),
      compact([sourceName, identity.fullName]).join(" "),
      compact([sourceName, identity.brand, identity.model]).join(" "),
    ].filter(Boolean),
    candidate_hints: {
      brand: identity.brand,
      model: identity.model,
      version: identity.version,
      gender: identity.gender,
      full_name: identity.fullName,
      full_slug: identity.fullSlug,
      model_slug: identity.modelSlug,
      source_key: normalizeSourceKey(sourceName),
    },
  };
}

export function getSourceRank(name) {
  const i = APPROVED_SOURCES.findIndex(
    (x) => x.toLowerCase() === String(name || "").toLowerCase()
  );
  return i === -1 ? 999 : i;
}

export function getApprovedSourceCandidates(candidate) {
  const identity = buildIdentity(candidate);

  return [
    buildManufacturerTarget(identity),
    ...APPROVED_SOURCES.map((name, index) =>
      buildSourceTarget(name, index + 2, identity)
    ),
  ].sort((a, b) => a.priority - b.priority);
}
