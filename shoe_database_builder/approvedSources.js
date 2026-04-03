// approvedSources.js

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getApprovedSourceCandidates(candidate) {
  const brand = String(candidate.brand || "").trim();
  const model = String(candidate.verified_model || candidate.model || "").trim();
  const version = String(candidate.verified_version || "").trim();
  const gender = String(candidate.gender || "unknown").trim().toLowerCase();

  const fullName = [brand, model, version].filter(Boolean).join(" ").trim();
  const fullSlug = slugify(fullName);

  const sources = [];

  // Manufacturer first
  if (brand.toLowerCase() === "brooks" && model.toLowerCase() === "ghost" && version === "15") {
    if (gender === "mens") {
      sources.push({
        source_name: "Brooks",
        source_type: "brand",
        source_url:
          "https://www.brooksrunning.com/en_us/mens/shoes/road-running-shoes/ghost-15/1103931D025.080.html",
        priority: 1,
        field_priority: ["model", "version", "manufacturer_model_id", "msrp_usd", "upper", "foam", "cushioning"],
      });
    }

    if (gender === "womens") {
      sources.push({
        source_name: "Brooks",
        source_type: "brand",
        source_url:
          "https://www.brooksrunning.com/en_us/womens/shoes/road-running-shoes/ghost-15/1203801B020.075.html",
        priority: 1,
        field_priority: ["model", "version", "manufacturer_model_id", "msrp_usd", "upper", "foam", "cushioning"],
      });
    }
  }

  // Approved review sources
  sources.push(
    {
      source_name: "RunRepeat",
      source_type: "review",
      source_url: `https://runrepeat.com/${fullSlug}`,
      priority: 2,
    },
    {
      source_name: "Doctors of Running",
      source_type: "review",
      source_url: `https://www.doctorsofrunning.com/search?q=${encodeURIComponent(fullName)}`,
      priority: 3,
    },
    {
      source_name: "Running Warehouse",
      source_type: "review",
      source_url: `https://www.runningwarehouse.com/searchresults.html?searchtext=${encodeURIComponent(fullName)}`,
      priority: 4,
    },
    {
      source_name: "RoadTrailRun",
      source_type: "review",
      source_url: `https://www.google.com/search?q=site%3Aroadtrailrun.com+${encodeURIComponent(fullName)}`,
      priority: 5,
    },
    {
      source_name: "Believe in the Run",
      source_type: "review",
      source_url: `https://www.google.com/search?q=site%3Abelieveintherun.com+${encodeURIComponent(fullName)}`,
      priority: 6,
    },
    {
      source_name: "Running Shoes Guru",
      source_type: "review",
      source_url: `https://www.google.com/search?q=site%3Arunningshoesguru.com+${encodeURIComponent(fullName)}`,
      priority: 7,
    },
    {
      source_name: "OutdoorGearLab",
      source_type: "review",
      source_url: `https://www.google.com/search?q=site%3Aoutdoorgearlab.com+${encodeURIComponent(fullName)}`,
      priority: 8,
    },
    {
      source_name: "Road Runner Sports",
      source_type: "review",
      source_url: `https://www.google.com/search?q=site%3Aroadrunnersports.com+${encodeURIComponent(fullName)}`,
      priority: 9,
    },
    {
      source_name: "RTINGS",
      source_type: "review",
      source_url: `https://www.google.com/search?q=site%3Artings.com+${encodeURIComponent(fullName)}`,
      priority: 10,
    },
    {
      source_name: "The Running Clinic",
      source_type: "review",
      source_url: `https://www.google.com/search?q=site%3Arunningclinic.com+${encodeURIComponent(fullName)}`,
      priority: 11,
    }
  );

  return sources;
}
