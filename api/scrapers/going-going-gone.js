// /api/scrapers/goinggoinggone.js
//
// GoingGoingGone (DSG) JSON API scraper -> writes /going-going-gone.json to Vercel Blob
//
// Rules (per your requirements):
// - Only include products where listingName contains the exact phrase "running shoes" (case-insensitive)
// - store is "GoingGoingGone"
// - shoeType is always "unknown"
// - Must keep your top-level structure and schema fields
// - Range prices supported via productDetails[parentCatentryId].prices
//
// ENV needed:
// - BLOB_READ_WRITE_TOKEN (Vercel Blob)
// - (optional) GOINGGOINGGONE_ZIPCODE, GOINGGOINGGONE_STOREID, GOINGGOINGGONE_SELECTEDSTORE, GOINGGOINGGONE_CATEGORY
// - (optional) GOINGGOINGGONE_FILTER_5382 (default "Athletic & Sneakers" but we still filter by "running shoes")
//
// NOTE: We keep listingName EXACTLY as provided (never modify it).

const { put } = require("@vercel/blob");

const STORE = "GoingGoingGone";
const SCHEMA_VERSION = 1;

const CFG = {
  selectedCategory: process.env.GOINGGOINGGONE_CATEGORY || "12301_10515458",
  filter5382: process.env.GOINGGOINGGONE_FILTER_5382 || "Athletic & Sneakers",
  pageSize: 24,
  selectedSort: 5,
};

function isRunningShoesName(listingName) {
  if (!listingName) return false;
  return listingName.toLowerCase().includes("running shoes");
}

function guessGenderFromName(listingName) {
  const s = (listingName || "").toLowerCase();
  if (s.includes("women's") || s.includes("womens")) return "women";
  if (s.includes("men's") || s.includes("mens")) return "men";
  return "unisex";
}

function safeNumber(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Remove brand + gender words + "Running Shoes" suffix to make a model guess.
// This is best-effort. listingName remains untouched.
function deriveModel({ listingName, brand }) {
  let m = (listingName || "").trim();

  // remove brand if it appears at start
  const b = (brand || "").trim();
  if (b && m.toLowerCase().startsWith(b.toLowerCase())) {
    m = m.slice(b.length).trim();
  }

  // remove leading gender token
  m = m.replace(/^(women's|womens|men's|mens|unisex)\s+/i, "").trim();

  // remove trailing "running shoes"
  m = m.replace(/\s*running shoes\s*$/i, "").trim();

  // collapse extra spaces
  m = m.replace(/\s+/g, " ").trim();

  return m || (listingName || "").trim();
}

// Scene7 image URL from the HTML page proved pattern:
// https://dks.scene7.com/is/image/dkscdn/<THUMBNAIL>_<COLOR>_is/?fmt=jpg&wid=252...
function buildImageUrl({ thumbnail, swatchPartnumber }) {
  if (!thumbnail) return null;

  // swatchPartnumber looks like: "24ASIWGLNMBS27BLCFTW_Black/Breeze"
  let color = "";
  if (swatchPartnumber && swatchPartnumber.includes("_")) {
    color = swatchPartnumber.split("_").slice(1).join("_");
  }

  // Convert "Black/Breeze" -> "Black_Breeze"
  color = (color || "").replaceAll("/", "_").replaceAll(" ", "_").trim();

  // If no color, just use thumbnail (still often works, but less certain)
  const suffix = color ? `${thumbnail}_${encodeURIComponent(color)}_is` : `${thumbnail}_is`;

  return `https://dks.scene7.com/is/image/dkscdn/${suffix}/?fmt=jpg&wid=600&qlt=85%2C0&op_sharpen=1`;
}

function buildListingUrl(assetSeoUrl) {
  if (!assetSeoUrl) return null;
  if (assetSeoUrl.startsWith("http")) return assetSeoUrl;
  return `https://www.goinggoinggone.com${assetSeoUrl}`;
}

// Pull price range from productDetails[parentCatentryId].prices when available
function getPriceInfoFromDetails(parentCatentryId, productDetails) {
  const key = String(parentCatentryId || "");
  const pd = productDetails && productDetails[key];
  const prices = pd && pd.prices;
  if (!prices) return null;

  const minList = safeNumber(prices.minlistprice);
  const maxList = safeNumber(prices.maxlistprice);
  const minOffer = safeNumber(prices.minofferprice);
  const maxOffer = safeNumber(prices.maxofferprice);

  if (minList == null || minOffer == null) return null;

  const isRange =
    (maxList != null && maxList !== minList) ||
    (maxOffer != null && maxOffer !== minOffer);

  return { minList, maxList: maxList ?? minList, minOffer, maxOffer: maxOffer ?? minOffer, isRange };
}

function computeDiscountExact(salePrice, originalPrice) {
  if (salePrice == null || originalPrice == null) return null;
  if (originalPrice <= 0) return null;
  const pct = ((originalPrice - salePrice) / originalPrice) * 100;
  const rounded = Math.round(pct * 100) / 100;
  if (!Number.isFinite(rounded)) return null;
  if (rounded < 0) return null;
  return rounded;
}

function computeDiscountUpTo(saleLow, originalHigh) {
  if (saleLow == null || originalHigh == null) return null;
  if (originalHigh <= 0) return null;
  const pct = ((originalHigh - saleLow) / originalHigh) * 100;
  const rounded = Math.round(pct * 100) / 100;
  if (!Number.isFinite(rounded)) return null;
  if (rounded < 0) return null;
  return rounded;
}

function buildSearchVO(pageNumber) {
  return {
    pageNumber,
    pageSize: CFG.pageSize,
    selectedSort: CFG.selectedSort,
    selectedCategory: CFG.selectedCategory,
    selectedFilters: {
      "5382": [CFG.filter5382],
    },
    // keep these if you want, but they’re not required
    isFamilyPage: true,
    mlBypass: false,
  };
}

function buildSourceUrl(pageNumber) {
  // Mirrors the API endpoint you used (searchVO query param contains encoded JSON)
  const searchVO = buildSearchVO(pageNumber);
  const encoded = encodeURIComponent(JSON.stringify(searchVO));
  return `https://prod-catalog-product-api.dickssportinggoods.com/v2/search?searchVO=${encoded}`;
}

async function fetchPage(pageNumber) {
  const url = buildSourceUrl(pageNumber);

  const res = await fetch(url, {
    method: "GET",
headers: {
  accept: "application/json",
  channel: "g3",
  "x-dsg-platform": "v2",
  origin: "https://www.goinggoinggone.com",
},
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`DSG API HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }

  const json = await res.json();
  return { url, json };
}

module.exports = async function handler(req, res) {
  // CRON_SECRET (commented out for testing)
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const t0 = Date.now();

  let pagesFetched = 0;
  let dealsFound = 0;
  let dealsExtracted = 0;

  const sourceUrls = [];

  try {
    const deals = [];

    // page loop
    let pageNumber = 0;
    let totalCount = null;

    while (true) {
      const { url, json } = await fetchPage(pageNumber);
      pagesFetched += 1;
      sourceUrls.push(url);

      const productVOs = Array.isArray(json.productVOs) ? json.productVOs : [];
      const productDetails = json.productDetails || {};

      // Count everything "found" as raw cards returned
      dealsFound += productVOs.length;

      if (totalCount == null && typeof json.totalCount === "number") {
        totalCount = json.totalCount;
      }

      for (const p of productVOs) {
        const listingName = (p && p.name) ? String(p.name) : "";
        if (!isRunningShoesName(listingName)) continue;

        const brand = (p && p.mfName) ? String(p.mfName).trim() : "";
        const model = deriveModel({ listingName, brand });
        const gender = guessGenderFromName(listingName);

        const listingURL = buildListingUrl(p.assetSeoUrl || p.dsgSeoUrl);
        const imageURL = buildImageUrl({
          thumbnail: p.thumbnail || p.fullImage,
          swatchPartnumber: p.swatchPartnumber,
        });

        // Prices (prefer productDetails range)
        const priceInfo = getPriceInfoFromDetails(p.parentCatentryId, productDetails);
        if (!priceInfo) continue;

        const saleLow = priceInfo.minOffer;
        const saleHigh = priceInfo.maxOffer;
        const origLow = priceInfo.minList;
        const origHigh = priceInfo.maxList;

        // HONESTY
        const isRange = priceInfo.isRange;

        const salePrice = safeNumber(saleLow);
        const originalPrice = safeNumber(origLow);

        const discountPercent = isRange ? null : computeDiscountExact(salePrice, originalPrice);
        const discountPercentUpTo = isRange ? computeDiscountUpTo(saleLow, origHigh) : null;

        // Must have BOTH sale + original (single or range)
        if (saleLow == null || origLow == null) continue;

        const deal = {
          schemaVersion: SCHEMA_VERSION,

          listingName, // never edited

          brand,
          model,

          salePrice,
          originalPrice,
          discountPercent,

          salePriceLow: isRange ? safeNumber(saleLow) : null,
          salePriceHigh: isRange ? safeNumber(saleHigh) : null,
          originalPriceLow: isRange ? safeNumber(origLow) : null,
          originalPriceHigh: isRange ? safeNumber(origHigh) : null,
          discountPercentUpTo,

          store: STORE,

          listingURL,
          imageURL,

          gender,
          shoeType: "unknown",
        };

        // Basic required fields sanity
        if (!deal.listingURL || !deal.imageURL) continue;

        deals.push(deal);
      }

      // Stop condition: if we've reached or exceeded totalCount, or got fewer than pageSize
      const pageSize = CFG.pageSize;
      const alreadyCovered = (pageNumber + 1) * pageSize;

      if (productVOs.length < pageSize) break;
      if (totalCount != null && alreadyCovered >= totalCount) break;

      pageNumber += 1;

      // Safety cap to avoid accidental infinite loops
      if (pageNumber > 200) break;
    }

    // Dedup by listingURL (simple + safest for this feed)
    const seen = new Set();
    const deduped = [];
    for (const d of deals) {
      if (seen.has(d.listingURL)) continue;
      seen.add(d.listingURL);
      deduped.push(d);
    }

    dealsExtracted = deduped.length;

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: "vercel",

      sourceUrls,

      pagesFetched,

      dealsFound,
      dealsExtracted,

      scrapeDurationMs: Date.now() - t0,

      ok: true,
      error: null,

      deals: deduped,
    };

    // Write to Blob (stable path)
    const blob = await put("going-going-gone.json", JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      ok: true,
      store: STORE,
      pagesFetched,
      dealsFound,
      dealsExtracted,
      scrapeDurationMs: payload.scrapeDurationMs,
      blobUrl: blob && blob.url ? blob.url : null,
    });
  } catch (err) {
    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: new Date().toISOString(),
      via: "vercel",

      sourceUrls,
      pagesFetched,
      dealsFound,
      dealsExtracted,

      scrapeDurationMs: Date.now() - t0,

      ok: false,
      error: String(err && err.message ? err.message : err),
      deals: [],
    };

    // Best-effort blob write even on failure (optional)
    try {
      await put("going-going-gone.json", JSON.stringify(payload, null, 2), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
      });
    } catch (_) {}

    return res.status(500).json(payload);
  }
};
