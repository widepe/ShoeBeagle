// ONLY SHOWING THE THREE FIXED FUNCTIONS - Replace these in your scrape-daily.js file

async function fetchRoadRunnerDeals() {
  if (!process.env.APIFY_ROADRUNNER_ACTOR_ID) {
    throw new Error("APIFY_ROADRUNNER_ACTOR_ID is not set");
  }
  const items = await fetchActorDatasetItems(process.env.APIFY_ROADRUNNER_ACTOR_ID, "Road Runner Sports");
  
  // Transform to new schema - FIXED: read from correct field names
  return items.map((item) => ({
    title: item.title || "Running Shoe",
    brand: item.brand || "Unknown",
    model: item.model || "",
    salePrice: item.salePrice ?? null,  // FIXED: was item.price
    price: item.price ?? null,           // FIXED: was item.originalPrice
    store: item.store || "Road Runner Sports",
    url: item.url || "#",
    image: item.image ?? null,
    gender: item.gender || detectGender(item.url, item.title),
    shoeType: item.shoeType || detectShoeType(item.title, item.model),
  }));
}

async function fetchZapposDeals() {
  if (!process.env.APIFY_ZAPPOS_ACTOR_ID) {
    throw new Error("APIFY_ZAPPOS_ACTOR_ID is not set");
  }
  const items = await fetchActorDatasetItems(process.env.APIFY_ZAPPOS_ACTOR_ID, "Zappos");
  
  // Transform to new schema - FIXED: read from correct field names
  return items.map((item) => ({
    title: item.title || "Running Shoe",
    brand: item.brand || "Unknown",
    model: item.model || "",
    salePrice: item.salePrice ?? null,  // FIXED: was item.price
    price: item.price ?? null,           // FIXED: was item.originalPrice
    store: item.store || "Zappos",
    url: item.url || "#",
    image: item.image ?? null,
    gender: item.gender || detectGender(item.url, item.title),
    shoeType: item.shoeType || detectShoeType(item.title, item.model),
  }));
}

async function fetchReiDeals() {
  console.log("[REI] fetchReiDeals called");

  if (!process.env.APIFY_REI_ACTOR_ID) {
    throw new Error("APIFY_REI_ACTOR_ID is not set");
  }

  const items = await fetchActorDatasetItems(process.env.APIFY_REI_ACTOR_ID, "REI Outlet");

  // Transform to new schema - FIXED: read from correct field names
  return items.map((item) => {
    const brand = item.brand || "Unknown";
    const model = item.model || "";
    const title = item.title || `${brand} ${model}`.trim() || "REI Outlet Shoe";

    return {
      title,
      brand,
      model,
      salePrice: item.salePrice ?? null,  // FIXED: was item.price
      price: item.price ?? null,           // FIXED: was item.originalPrice
      store: item.store || "REI Outlet",
      url: item.url || "#",
      image: item.image ?? null,
      gender: item.gender || detectGender(item.url, title),
      shoeType: item.shoeType || detectShoeType(title, model),
    };
  });
}
