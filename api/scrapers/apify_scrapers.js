const { put } = require("@vercel/blob");
const { ApifyClient } = require("apify-client");
const { cleanModelName } = require("./modelNameCleaner");

const apifyClient = new ApifyClient({ token: process.env.APIFY_TOKEN });

/** --- SHARED HELPERS (11 Schema Variables) --- **/
function nowIso() { return new Date().toISOString(); }
function computeDiscountPercent(orig, sale) {
  if (!orig || !sale || sale >= orig) return 0;
  return Math.round(((orig - sale) / orig) * 100);
}
function detectGender(url, name) {
  const combined = (url + " " + name).toLowerCase();
  if (/\/mens?[\/-]|\/men\/|men-/.test(combined) || /\bmen'?s?\b/i.test(combined)) return "mens";
  if (/\/womens?[\/-]|\/women\/|women-/.test(combined) || /\bwomen'?s?\b/i.test(combined)) return "womens";
  return "unisex";
}
function detectShoeType(name, model) {
  const combined = (name + " " + model).toLowerCase();
  if (/\b(trail|speedgoat|peregrine|ultra)\b/i.test(combined)) return "trail";
  if (/\b(track|spike|dragonfly)\b/i.test(combined)) return "track";
  return "road";
}

/** --- APIFY FETCHERS --- **/
async function fetchActorDatasetItems(actorId, storeName) {
  const run = await apifyClient.actor(actorId).call({});
  let allItems = [];
  let offset = 0;
  while (true) {
    const { items, total } = await apifyClient.dataset(run.defaultDatasetId).listItems({ offset, limit: 500 });
    allItems.push(...items);
    offset += items.length;
    if (offset >= total || items.length === 0) break;
  }
  return allItems.map(i => ({ ...i, store: storeName }));
}

function mapApifyToSchema(item, storeName) {
  const salePrice = parseFloat(item.salePrice || item.price || 0);
  const originalPrice = parseFloat(item.originalPrice || item.price || 0);
  const listingName = item.title || "Running Shoe";
  
  return {
    listingName,
    brand: item.brand || "Unknown",
    model: cleanModelName(item.model || ""),
    salePrice: salePrice || null,
    originalPrice: originalPrice || null,
    discountPercent: computeDiscountPercent(originalPrice, salePrice),
    store: storeName,
    listingURL: item.url || "#",
    imageURL: item.image || null,
    gender: item.gender || detectGender(item.url, listingName),
    shoeType: item.shoeType || detectShoeType(listingName, item.model)
  };
}

module.exports = async (req, res) => {
  const startTime = Date.now();
  const results = {};
  const allDeals = [];

  const sources = [
    { name: "Road Runner Sports", id: process.env.APIFY_ROADRUNNER_ACTOR_ID },
    { name: "REI Outlet", id: process.env.APIFY_REI_ACTOR_ID },
    { name: "Zappos", id: process.env.APIFY_ZAPPOS_ACTOR_ID }
  ];

  for (const src of sources) {
    try {
      const items = await fetchActorDatasetItems(src.id, src.name);
      const mapped = items.map(i => mapApifyToSchema(i, src.name));
      allDeals.push(...mapped);
      results[src.name] = { ok: true, count: mapped.length };
    } catch (e) {
      results[src.name] = { ok: false, error: e.message };
    }
  }

  const output = { lastUpdated: nowIso(), scraperResults: results, deals: allDeals };
  const blob = await put("apify_deals_blob.json", JSON.stringify(output, null, 2), {
    access: "public",
    addRandomSuffix: false,
  });

  res.status(200).json({ success: true, blobUrl: blob.url, count: allDeals.length });
};
