export const APPROVED_SOURCES = [
  { name: "RunRepeat", domains: ["runrepeat.com"] },
  { name: "Running Warehouse", domains: ["runningwarehouse.com"] },
  { name: "RoadTrailRun", domains: ["roadtrailrun.com"] },
  { name: "Doctors of Running", domains: ["doctorsofrunning.com"] },
  { name: "Running Shoes Guru", domains: ["runningshoesguru.com"] },
  { name: "OutdoorGearLab", domains: ["outdoorgearlab.com"] },
  { name: "RTINGS", domains: ["rtings.com"] },
  { name: "Road Runner Sports", domains: ["roadrunnersports.com"] },
  { name: "Believe in the Run", domains: ["believeintherun.com"] },
  { name: "Sole Review", domains: ["solereview.com"] },
  { name: "Runner's World", domains: ["runnersworld.com"] },
  { name: "The Running Clinic", domains: ["therunningclinic.com"] },
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
    (source) => source.name.toLowerCase() === String(name || "").toLowerCase()
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

function buildApprovedSource(source, priority, identity) {
  return {
    source_name: source.name,
    source_type: "review",
    priority,
    source_url: null,
    discovery_queries: [
      compact([source.name, identity.brand, identity.model, identity.version]).join(" "),
      compact([source.name, identity.fullName]).join(" "),
      compact([source.name, identity.brand, identity.model]).join(" "),
    ].filter(Boolean),
    direct_url_candidates:
      source.name === "RunRepeat"
        ? [
            identity.fullSlug ? `https://runrepeat.com/${identity.fullSlug}` : null,
            identity.modelSlug ? `https://runrepeat.com/${identity.modelSlug}` : null,
          ].filter(Boolean)
        : [],
    identity,
    allowed_domains: source.domains || [],
  };
}

export function getApprovedSourceCandidates(candidate) {
  const identity = buildIdentity(candidate);

  return [
    buildManufacturerSource(identity),
    ...APPROVED_SOURCES.map((source, index) =>
      buildApprovedSource(source, index + 2, identity)
    ),
  ].sort((a, b) => a.priority - b.priority);
}
