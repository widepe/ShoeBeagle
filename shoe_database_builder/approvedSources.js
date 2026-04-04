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

export const APPROVED_SOURCE_DOMAINS = {
  "RunRepeat": ["runrepeat.com"],
  "Running Warehouse": ["runningwarehouse.com"],
  "RoadTrailRun": ["roadtrailrun.com"],
  "Doctors of Running": ["doctorsofrunning.com"],
  "Running Shoes Guru": ["runningshoesguru.com"],
  "OutdoorGearLab": ["outdoorgearlab.com"],
  "RTINGS": ["rtings.com"],
  "Road Runner Sports": ["roadrunnersports.com"],
  "Believe in the Run": ["believeintherun.com"],
  "Sole Review": ["solereview.com"],
  "Runner's World": ["runnersworld.com"],
  "The Running Clinic": ["therunningclinic.com"],
};

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
  const brandToken = slugify(identity.brand).replace(/-/g, "");
  const brandSlug = slugify(identity.brand);

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
      identity.fullSlug ? `https://www.${brandToken}.com/${identity.fullSlug}` : null,
      identity.modelSlug ? `https://www.${brandToken}.com/${identity.modelSlug}` : null,
      identity.fullSlug ? `https://www.${brandSlug}.com/${identity.fullSlug}` : null,
      identity.modelSlug ? `https://www.${brandSlug}.com/${identity.modelSlug}` : null,
    ].filter(Boolean),
    identity,
    allowed_domains: brandToken ? [brandToken] : [],
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
    identity,
    allowed_domains: APPROVED_SOURCE_DOMAINS[sourceName] || [],
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
