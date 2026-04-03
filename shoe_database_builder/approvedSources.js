function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function compact(parts) {
  return parts.map((x) => String(x || "").trim()).filter(Boolean);
}

function normalizeBrandDomainPart(brand) {
  return String(brand || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

function buildNames(candidate) {
  const brand = String(candidate?.brand || "").trim();
  const model = String(candidate?.verified_model || candidate?.model || "").trim();
  const version = String(candidate?.verified_version || "").trim();
  const gender = String(candidate?.gender || "").trim().toLowerCase();

  const fullName = compact([brand, model, version]).join(" ").trim();
  const fullSlug = slugify(fullName);
  const modelSlug = slugify(compact([model, version]).join(" "));
  const brandDomain = normalizeBrandDomainPart(brand);

  const genderSlug =
    gender === "mens" ? "mens" :
    gender === "womens" ? "womens" :
    gender === "unisex" ? "unisex" :
    "";

  return {
    brand,
    model,
    version,
    gender,
    fullName,
    fullSlug,
    modelSlug,
    brandDomain,
    genderSlug,
  };
}

function manufacturerCandidates(info) {
  const { brand, fullName, modelSlug, brandDomain, genderSlug } = info;

  if (!brandDomain || !fullName) return [];

  const list = [
    {
      source_name: brand,
      source_type: "brand",
      source_url: `https://www.${brandDomain}.com/search?q=${encodeURIComponent(fullName)}`,
      priority: 1,
    },
    {
      source_name: brand,
      source_type: "brand",
      source_url: `https://www.${brandDomain}.com/search?query=${encodeURIComponent(fullName)}`,
      priority: 2,
    },
    {
      source_name: brand,
      source_type: "brand",
      source_url: `https://www.${brandDomain}.com/search?keyword=${encodeURIComponent(fullName)}`,
      priority: 3,
    },
    {
      source_name: brand,
      source_type: "brand",
      source_url: `https://www.${brandDomain}.com/?s=${encodeURIComponent(fullName)}`,
      priority: 4,
    },
  ];

  if (modelSlug) {
    list.push({
      source_name: brand,
      source_type: "brand",
      source_url: `https://www.${brandDomain}.com/${modelSlug}/`,
      priority: 5,
    });
  }

  if (genderSlug && modelSlug) {
    list.push(
      {
        source_name: brand,
        source_type: "brand",
        source_url: `https://www.${brandDomain}.com/${genderSlug}/${modelSlug}/`,
        priority: 6,
      },
      {
        source_name: brand,
        source_type: "brand",
        source_url: `https://www.${brandDomain}.com/${genderSlug}/shoes/${modelSlug}/`,
        priority: 7,
      }
    );
  }

  return list;
}

function approvedReviewCandidates(info, startPriority = 20) {
  const { fullSlug, fullName } = info;

  if (!fullName) return [];

  return [
    {
      source_name: "RunRepeat",
      source_type: "review",
      source_url: `https://runrepeat.com/${fullSlug}`,
      priority: startPriority,
    },
    {
      source_name: "Doctors of Running",
      source_type: "review",
      source_url: `https://www.doctorsofrunning.com/search?q=${encodeURIComponent(fullName)}`,
      priority: startPriority + 1,
    },
    {
      source_name: "RoadTrailRun",
      source_type: "review",
      source_url: `https://www.roadtrailrun.com/search?q=${encodeURIComponent(fullName)}`,
      priority: startPriority + 2,
    },
    {
      source_name: "Believe in the Run",
      source_type: "review",
      source_url: `https://believeintherun.com/?s=${encodeURIComponent(fullName)}`,
      priority: startPriority + 3,
    },
    {
      source_name: "Running Shoes Guru",
      source_type: "review",
      source_url: `https://www.runningshoesguru.com/?s=${encodeURIComponent(fullName)}`,
      priority: startPriority + 4,
    },
    {
      source_name: "OutdoorGearLab",
      source_type: "review",
      source_url: `https://www.outdoorgearlab.com/search?ftr=${encodeURIComponent(fullName)}`,
      priority: startPriority + 5,
    },
    {
      source_name: "RTINGS",
      source_type: "review",
      source_url: `https://www.rtings.com/search?q=${encodeURIComponent(fullName)}`,
      priority: startPriority + 6,
    },
    {
      source_name: "The Running Clinic",
      source_type: "review",
      source_url: `https://www.therunningclinic.com/?s=${encodeURIComponent(fullName)}`,
      priority: startPriority + 7,
    },
  ];
}

function dedupeSources(sources) {
  const seen = new Set();
  const out = [];

  for (const item of sources) {
    if (!item?.source_url) continue;

    const key = `${item.source_name}|${item.source_url}`.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(item);
  }

  return out;
}

export function getApprovedSourceCandidates(candidate) {
  const info = buildNames(candidate);

  const sources = [
    ...manufacturerCandidates(info),
    ...approvedReviewCandidates(info, 20),
  ];

  return dedupeSources(sources).sort((a, b) => a.priority - b.priority);
}
