import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Bloomingdale's";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";
const BLOB_PATH = "bloomingdales-sale.json";

const SOURCE_URLS = [
  {
    url: "https://www.bloomingdales.com/shop/featured/womens-running-sneakers-on-sale?ss=true",
    genderHint: "womens"
  },
  {
    url: "https://www.bloomingdales.com/shop/featured/mens-running-sneakers-on-sale?ss=true",
    genderHint: "mens"
  }
];

const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145 Safari/537.36"
};

export default async function handler(req, res) {

  // CRON_SECRET
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success:false, error:"Unauthorized" });
  // }

  const start = Date.now();

  try {

    const allIds = new Set();
    const pageSummaries = [];

    for (const source of SOURCE_URLS) {

      const html = await fetchText(source.url);

      const ids = extractProductIds(html);

      ids.forEach(id => allIds.add(id));

      pageSummaries.push({
        url: source.url,
        genderHint: source.genderHint,
        idsFound: ids.length
      });
    }

    const candidateIds = [...allIds];

    const deals = [];
    const dropCounts = {};

    for (const id of candidateIds) {

      const result = await processProduct(id);

      if (!result.ok) {
        dropCounts[result.reason] =
          (dropCounts[result.reason] || 0) + 1;
        continue;
      }

      deals.push(result.deal);
    }

    const genderCounts = countGenders(deals);

    const blobData = {

      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: VIA,

      sourceUrls: SOURCE_URLS.map(x => x.url),
      pagesFetched: SOURCE_URLS.length,

      dealsFound: candidateIds.length,
      dealsExtracted: deals.length,

      dealsForMens: genderCounts.mens,
      dealsForWomens: genderCounts.womens,
      dealsForUnisex: genderCounts.unisex,
      dealsForUnknown: genderCounts.unknown,

      scrapeDurationMs: Date.now() - start,

      ok: true,
      error: null,

      deals
    };

    const blob = await put(
      BLOB_PATH,
      JSON.stringify(blobData, null, 2),
      { access: "public", addRandomSuffix:false }
    );

    return res.json({
      success: true,
      store: STORE,
      blobUrl: blob.url,

      pagesFetched: SOURCE_URLS.length,
      dealsFound: candidateIds.length,
      dealsExtracted: deals.length,

      dealsForMens: genderCounts.mens,
      dealsForWomens: genderCounts.womens,
      dealsForUnisex: genderCounts.unisex,
      dealsForUnknown: genderCounts.unknown,

      scrapeDurationMs: Date.now() - start,

      dropCounts,
      pageSummaries
    });

  } catch (err) {

    return res.status(500).json({
      success:false,
      store:STORE,
      error:err.message
    });
  }
}

async function processProduct(id) {

  const url =
    `https://www.bloomingdales.com/shop/product?ID=${id}`;

  const html = await fetchText(url);

  const json = extractProductJSON(html);

  if (!json) {
    return { ok:false, reason:"missingProductJSON" };
  }

  const product = json.product?.[0];

  if (!product) {
    return { ok:false, reason:"missingProduct" };
  }

  const best = bestColor(product);

  if (!best) {
    return { ok:false, reason:"notOnSale" };
  }

  const name = product.detail?.name || "";

  const brand = product.detail?.brand?.name || "";

  const listingURL =
    "https://www.bloomingdales.com" +
    (product.identifier?.productUrl || `/shop/product?ID=${id}`);

  const image =
    product.urlTemplate?.product +
    product.imagery?.images?.[0]?.filePath;

  const gender = inferGender(name);

  const discount =
    Math.round(
      ((best.originalPrice - best.salePrice) /
        best.originalPrice) * 100
    );

  const deal = {

    schemaVersion:1,

    listingName:name,

    brand,
    model:name.replace(brand,"").trim(),

    salePrice:best.salePrice,
    originalPrice:best.originalPrice,
    discountPercent:discount,

    salePriceLow:null,
    salePriceHigh:null,

    originalPriceLow:null,
    originalPriceHigh:null,

    discountPercentUpTo:null,

    store:STORE,

    listingURL,
    imageURL:image,

    gender,
    shoeType:"unknown"
  };

  return { ok:true, deal };
}

function extractProductIds(html) {

  const ids = new Set();

  const regex = /[?&]ID=(\d+)/g;

  let m;

  while ((m = regex.exec(html))) {
    ids.add(m[1]);
  }

  return [...ids];
}

function extractProductJSON(html) {

  const match =
    html.match(/\{"product":\[\{[\s\S]*?"meta":\{[\s\S]*?\}\}/);

  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function bestColor(product) {

  const map =
    product?.traits?.colors?.colorMap || {};

  let best = null;

  for (const c of Object.values(map)) {

    const p = c?.pricing?.price;

    if (!p?.priceType?.onSale) continue;

    const regular =
      p.tieredPrice?.[0]?.values?.find(
        v => v.type === "regular"
      )?.value;

    const sale =
      p.tieredPrice?.[0]?.values?.find(
        v => v.type === "discount"
      )?.value;

    if (!regular || !sale) continue;

    if (!best || sale < best.salePrice) {
      best = {
        salePrice:sale,
        originalPrice:regular
      };
    }
  }

  return best;
}

function inferGender(text) {

  const t = text.toLowerCase();

  if (t.includes("women")) return "womens";
  if (t.includes("men")) return "mens";
  if (t.includes("unisex")) return "unisex";

  return "unknown";
}

function countGenders(deals) {

  const g = {mens:0,womens:0,unisex:0,unknown:0};

  for (const d of deals) {
    if (!g[d.gender]) g.unknown++;
    else g[d.gender]++;
  }

  return g;
}

async function fetchText(url) {

  const r = await fetch(url,{headers:HEADERS});

  if (!r.ok)
    throw new Error(`HTTP ${r.status}`);

  return r.text();
}
