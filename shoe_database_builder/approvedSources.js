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

function compact(parts) {
  return parts.map((x) => String(x || "").trim()).filter(Boolean);
}

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

function buildIdentity(candidate) {
  const brand = String(candidate?.brand || "").trim();
  const model = String(candidate?.verified_model || candidate?.model || "").trim();
  const version = String(candidate?.verified_version || "").trim();
  const gender = String(candidate?.gender || "").trim().toLowerCase();

  const fullName = compact([brand, model, version]).join(" ").trim();
  const modelWithVersion = compact([model, version]).join(" ").trim();

  return {
    brand,
    model,
    version,
    gender,
    fullName,
    modelWithVersion,
    fullSlug: slugify(fullName),
    modelSlug: slugify(modelWithVersion),
  };
}

export function getSourceRank(name) {
  const i = APPROVED_SOURCES.findIndex(
    (x) => x.toLowerCase() === String(name || "").toLowerCase()
  );
  return i === -1 ? 999 : i;
}

function buildManufacturerSource(identity) {
  return {
    source_name: identity.brand || "Manufacturer",
    source_type: "brand",
    priority: 1,
    source_url: null,
    discovery_queries: [
      compact([identity.brand, identity.model, identity.version, "official running shoe"]).join(" "),
      compact([identity.brand, identity.model, identity.version, "official"]).join(" "),
      compact([identity.brand, identity.model, identity.version, "manufacturer"]).join(" "),
    ].filter(Boolean),
    direct_url_candidates: [
      identity.fullSlug ? `https://www.${slugify(identity.brand).replace(/-/g, "")}.com/${identity.fullSlug}` : null,
      identity.modelSlug ? `https://www.${slugify(identity.brand).replace(/-/g, "")}.com/${identity.modelSlug}` : null,
    ].filter(Boolean),
  };
}

function buildApprovedSource(sourceName, priority, identity) {
  return {
    source_name: sourceName,
    source_type: "review",
    priority,
    source_url: null,
    discovery_queries: [
      compact([sourceName, identity.brand, identity.model, identity.version]).join(" "),
      compact([sourceName, identity.fullName]).join(" "),
      compact([sourceName, identity.brand, identity.model]).join(" "),
    ].filter(Boolean),
    direct_url_candidates:
      sourceName === "RunRepeat"
        ? [
            identity.fullSlug ? `https://runrepeat.com/${identity.fullSlug}` : null,
            identity.modelSlug ? `https://runrepeat.com/${identity.modelSlug}` : null,
          ].filter(Boolean)
        : [],
  };
}

export function getApprovedSourceCandidates(candidate) {
  const identity = buildIdentity(candidate);

  return [
    buildManufacturerSource(identity),
    ...APPROVED_SOURCES.map((name, index) =>
      buildApprovedSource(name, index + 2, identity)
    ),
  ].sort((a, b) => a.priority - b.priority);
}
