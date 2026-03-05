// /api/going-going-gone.js  (CommonJS)
//
// GoingGoingGone (DSG catalog API) -> Shoe Beagle deals JSON -> Vercel Blob
//
// RULES YOU GAVE ME (implemented):
// - store for the payload is "GoingGoingGone"
// - blob path is STABLE: "going-going-gone.json" (overwrites each run)
// - include ONLY items whose listingName contains "running shoes" (case-insensitive)
// - shoeType is ALWAYS "unknown" for this store
// - keep your top-level structure fields exactly (plus deals + optional runId/pageNotes/dropCounts debug)
//
// NOTE:
// - This endpoint sometimes returns HTTP 403 (HTML "Site Maintenance") from datacenter IPs.
//   If you still see 403 from Vercel, move this scraper to Apify w/ proxies.
//
// ---------------------------
// AUTH (COMMENTED OUT FOR TESTING)
// ---------------------------
// // CRON_SECRET
// const auth = req.headers.authorization;
// if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
//   return res.status(401).json({ success: false, error: "Unauthorized" });
// }

const { put } = require("@vercel/blob");

const API_BASE =
  "https://prod-catalog-product-api.dickssportinggoods.com/v2/search?searchVO=";

const STORE = "GoingGoingGone";
const SCHEMA_VERSION = 1;

const SOURCE_URLS = [
  // this is the page your site is browsing
  "https://www.goinggoinggone.com/f/shop-all-womens-sale?pageSize=24&filterFacets=5382%253AAthletic%2520%2526%2520Sneakers",
];

// category/filters in your sample request:
const CFG = {
  pageSize: 24,
  selectedSort: 5,
  selectedCategory: "12301_10515458",
  // IMPORTANT: the API filter you captured is still "Athletic & Sneakers".
  // We filter down to "running shoes" ourselves.
  filter5382: "Athletic & Sneakers",

  // safety
  maxPages: Number(process.env.GOINGGOINGGONE_MAX_PAGES || 25),
  timeoutMs: Number(process.env.GOINGGOINGGONE_TIMEOUT_MS || 25_000),
};

function stripInvisible(s) {
  if (typeof s !== "string") return "";
  // remove common invisible/control chars + zero-width + soft hyphen, normalize whitespace
  return s
    .replace(/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeRunningShoes(listingName) {
  const s = stripInvisible(listingName).toLowerCase();
  return s.includes("running shoes");
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function pickCurrentFacet(floatFacets, identifier, nowMs) {
  const matches = Array.isArray(floatFacets)
    ? floatFacets.filter((f) => f && f.identifier === identifier)
    : [];

  if (!matches.length) return null;

  // Prefer the one valid "now"
  const active = matches.find((f) => {
    const st = Number(f.startDateTime);
    const en = Number(f.endDateTime);
    return Number.isFinite(st) && Number.isFinite(en) && nowMs >= st && nowMs <= en;
  });
  if (active && Number.isFinite(Number(active.value))) return Number(active.value);

  // Otherwise pick the lowest numeric value (safe for offerprice) or first numeric
  const nums = matches
    .map((f) => Number(f.value))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return null;

  // For listprice we could pick max; but typically only one listprice exists.
  // We'll pick the first for listprice-like identifiers, min for offerprice-like.
  if (identifier.toLowerCase().includes("offer")) {
    return Math.min(...nums);
  }
  return nums[0];
}

function computeExactDiscountPercent(original, sale) {
  if (!Number.isFinite(original) || !Number.isFinite(sale) || original <= 0) return null;
  const pct = ((original - sale) / original) * 100;
  if (!Number.isFinite(pct)) return null;
  // round to 2 decimals
  return Math.round(pct * 100) / 100;
}

function computeUpToDiscountPercent(originalHigh, saleLow) {
  if (!Number.isFinite(originalHigh) || !Number.isFinite(saleLow) || originalHigh <= 0) return null;
  const pct = ((originalHigh - saleLow) / originalHigh) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.round(pct * 100) / 100;
}

function buildSearchVO(pageNumber) {
  // NOTE: zipcode / storeId / selectedStore intentionally REMOVED (your request)
  return {
    pageNumber,
    pageSize: CFG.pageSize,
    selectedSort: CFG.selectedSort,
    selectedCategory: CFG.selectedCategory,
    selectedFilters: {
      "5382": [CFG.filter5382],
    },
    isFamilyPage: true,
    mlBypass: false,
    snbAudience: "",
    includeFulfillmentFacets: false,
  };
}

function buildApiUrl(pageNumber) {
  const vo = buildSearchVO(pageNumber);
  return API_BASE + encodeURIComponent(JSON.stringify(vo));
}

function guessGenderFromAttributes(attributesStr) {
  // attributesStr looks like JSON string of an array of {"5495":"Women's"} etc.
  const arr = safeJsonParse(attributesStr, []);
  if (!Array.isArray(arr)) return "unknown";

  // Try common fields in your sample
  const values = [];
  for (const obj of arr) {
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") values.push(v);
      }
    }
  }
  const joined = values.join(" | ").toLowerCase();
  if (joined.includes("women")) return "women";
  if (joined.includes("men")) return "men";
  if (joined.includes("unisex")) return "unisex";
  return "unknown";
}

function deriveModel(brand, listingName) {
  // very simple: remove brand prefix if present
  const b = stripInvisible(brand);
  let name = stripInvisible(listingName);

  if (b && name.toLowerCase().startsWith(b.toLowerCase() + " ")) {
    name = name.slice(b.length).trim();
  }

  // Remove leading "Women's"/"Men's"/"Unisex" if present
  name = name.replace(/^(women's|mens|men's|unisex)\s+/i, "").trim();

  // Keep the rest (including "Running Shoes") because you might want it in model search,
  // but we can also optionally strip trailing "Running Shoes" for cleaner model.
  const cleaned = name.replace(/\s+running shoes$/i, "").trim();

  return stripInvisible(cleaned || name);
}

function buildListingUrl(assetSeoUrl) {
  const path = typeof assetSeoUrl === "string" ? assetSeoUrl : "";
  if (!path.startsWith("/")) return null;
  return `https://www.goinggoinggone.com${path}`;
}

function buildImageUrl(fullImageOrThumb) {
  // Best-effort: DSG commonly serves images from scene7 under /is/image/dks/<id>
  // If this doesn't render, we can adjust later once you confirm the exact working pattern.
  const id = stripInvisible(fullImageOrThumb);
  if (!id) return null;
  return `https://dks.scene7.com/is/image/dks/${encodeURIComponent(id)}?wid=600&fmt=png-alpha`;
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function fetchPage(pageNumber) {
  const url = buildApiUrl(pageNumber);

  // Keep these headers "browser-ish" (your 403 came from over-simplifying + datacenter IPs)
  const headers = {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    channel: "g3",
    "content-type": "application/json",
    "disable-pinning": "false",
    origin: "https://www.goinggoinggone.com",
    referer: SOURCE_URLS[0],
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    "x-dsg-platform": "v2",

    // sometimes helps (harmless if ignored)
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };

  const res = await fetchWithTimeout(
    url,
    { method: "GET", headers, cache: "no-store" },
    CFG.timeoutMs
  );

  const ct = res.headers.get("content-type") || "";

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`DSG API HTTP ${res.status} (${ct}): ${txt.slice(0, 600)}`);
  }

  // If protection returns HTML with 200, detect it
  if (!ct.toLowerCase().includes("application/json")) {
    const txt = await res.text().catch(() => "");
    throw new Error(`DSG API non-JSON (${ct}): ${txt.slice(0, 600)}`);
  }

  return res.json();
}

function buildDealFromVO(vo, productDetails, nowMs) {
  const listingName = stripInvisible(vo?.name || "");
  if (!listingName) return null;

  // must explicitly contain "running shoes"
  if (!looksLikeRunningShoes(listingName)) return null;

  const brand = stripInvisible(vo?.mfName || "");
  const model = deriveModel(brand, listingName);

  const parentId = String(vo?.parentCatentryId || vo?.parentCatentryId === 0 ? vo.parentCatentryId : "");
  const parentDetails = parentId ? productDetails?.[parentId] : null;

  // RANGE PRICES (preferred if present)
  let saleLow = null,
    saleHigh = null,
    origLow = null,
    origHigh = null;

  if (parentDetails?.prices) {
    const p = parentDetails.prices;

    const minOffer = Number(p.minofferprice);
    const maxOffer = Number(p.maxofferprice);
    const minList = Number(p.minlistprice);
    const maxList = Number(p.maxlistprice);

    if (Number.isFinite(minOffer) && Number.isFinite(maxOffer)) {
      saleLow = minOffer;
      saleHigh = maxOffer;
    }
    if (Number.isFinite(minList) && Number.isFinite(maxList)) {
      origLow = minList;
      origHigh = maxList;
    }
  }

  // SINGLE PRICES (fallback to floatFacets)
  const floatFacets = vo?.floatFacets || [];
  const listPrice = pickCurrentFacet(floatFacets, "dickssportinggoodslistprice", nowMs);
  const offerPrice = pickCurrentFacet(floatFacets, "dickssportinggoodsofferprice", nowMs);

  // Decide whether we’re range or single
  const hasRange =
    Number.isFinite(saleLow) &&
    Number.isFinite(saleHigh) &&
    saleLow !== saleHigh &&
    Number.isFinite(origLow) &&
    Number.isFinite(origHigh) &&
    origLow !== origHigh;

  const hasSingle =
    Number.isFinite(offerPrice) && Number.isFinite(listPrice) && listPrice > 0;

  // HONESTY RULE: must have BOTH sale and original (range OR single)
  if (!hasRange && !hasSingle) return null;

  let salePrice = null;
  let originalPrice = null;

  let salePriceLow = null,
    salePriceHigh = null,
    originalPriceLow = null,
    originalPriceHigh = null;

  let discountPercent = null;
  let discountPercentUpTo = null;

  if (hasRange) {
    // Use range fields; keep legacy salePrice/originalPrice as the LOW end (consistent with "up to")
    salePriceLow = saleLow;
    salePriceHigh = saleHigh;
    originalPriceLow = origLow;
    originalPriceHigh = origHigh;

    salePrice = saleLow;
    originalPrice = origHigh; // show the "best" original for context (high end)

    discountPercent = null; // exact-only rule
    discountPercentUpTo = computeUpToDiscountPercent(origHigh, saleLow);
  } else {
    salePrice = offerPrice;
    originalPrice = listPrice;

    discountPercent = computeExactDiscountPercent(originalPrice, salePrice);
    discountPercentUpTo = null;

    // keep range fields null
  }

  const listingURL = buildListingUrl(vo?.assetSeoUrl || vo?.dsgSeoUrl);
  const imageURL = buildImageUrl(vo?.fullImage || vo?.thumbnail);

  const gender = guessGenderFromAttributes(vo?.attributes);

  return {
    schemaVersion: SCHEMA_VERSION,

    listingName,

    brand: stripInvisible(brand),
    model: stripInvisible(model),

    salePrice: Number.isFinite(salePrice) ? salePrice : null,
    originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
    discountPercent: Number.isFinite(discountPercent) ? discountPercent : null,

    salePriceLow: Number.isFinite(salePriceLow) ? salePriceLow : null,
    salePriceHigh: Number.isFinite(salePriceHigh) ? salePriceHigh : null,
    originalPriceLow: Number.isFinite(originalPriceLow) ? originalPriceLow : null,
    originalPriceHigh: Number.isFinite(originalPriceHigh) ? originalPriceHigh : null,
    discountPercentUpTo: Number.isFinite(discountPercentUpTo) ? discountPercentUpTo : null,

    store: STORE,

    listingURL: listingURL || null,
    imageURL: imageURL || null,

    gender,
    shoeType: "unknown",
  };
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  const runId = `goinggoinggone-${Math.random().toString(36).slice(2, 10)}`;

  // (AUTH BLOCK IS COMMENTED OUT ABOVE FOR TESTING)

  const out = {
    store: STORE,
    schemaVersion: SCHEMA_VERSION,

    lastUpdated: new Date().toISOString(),
    via: "vercel",

    sourceUrls: SOURCE_URLS,

    pagesFetched: 0,

    dealsFound: 0,
    dealsExtracted: 0,

    scrapeDurationMs: 0,

    ok: true,
    error: null,

    deals: [],

    // optional debug (safe to keep; your merge-deals will ignore extra keys)
    runId,
    pageNotes: [],
    dropCounts: {
      totalProducts: 0,
      dropped_notRunningShoes: 0,
      dropped_missingPrices: 0,
      dropped_missingUrl: 0,
      dropped_other: 0,
      kept: 0,
    },
  };

  try {
    const nowMs = Date.now();
    const seenKey = new Set();

    // We'll loop pages until we have covered totalCount or hit maxPages
    let pageNumber = 0;
    let totalCount = null;

    while (pageNumber < CFG.maxPages) {
      const json = await fetchPage(pageNumber);

      const vos = Array.isArray(json?.productVOs) ? json.productVOs : [];
      const productDetails = json?.productDetails || {};

      // totals
      if (typeof json?.totalCount === "number") totalCount = json.totalCount;

      out.pagesFetched += 1;
      out.dealsFound += vos.length;

      out.pageNotes.push({
        pageNumber,
        cards: vos.length,
      });

      out.dropCounts.totalProducts += vos.length;

      for (const vo of vos) {
        const listingName = stripInvisible(vo?.name || "");
        if (!looksLikeRunningShoes(listingName)) {
          out.dropCounts.dropped_notRunningShoes += 1;
          continue;
        }

        const deal = buildDealFromVO(vo, productDetails, nowMs);
        if (!deal) {
          out.dropCounts.dropped_missingPrices += 1;
          continue;
        }

        if (!deal.listingURL) {
          out.dropCounts.dropped_missingUrl += 1;
          continue;
        }

        // Dedup by URL (your preference)
        if (seenKey.has(deal.listingURL)) continue;
        seenKey.add(deal.listingURL);

        out.deals.push(deal);
        out.dealsExtracted += 1;
        out.dropCounts.kept += 1;
      }

      // stop condition: last page
      const pageSize = CFG.pageSize;
      if (totalCount != null) {
        const fetchedSoFar = (pageNumber + 1) * pageSize;
        if (fetchedSoFar >= totalCount) break;
      }

      // If API returns fewer than pageSize, also stop
      if (vos.length < pageSize) break;

      pageNumber += 1;
    }

    // Upload to Vercel Blob (stable pathname)
    const blob = await put("going-going-gone.json", JSON.stringify(out, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false, // IMPORTANT: stable overwrite
    });

    out.blobUrl = blob?.url || null;

    out.scrapeDurationMs = Date.now() - startedAt;
    out.ok = true;
    out.error = null;

    return res.status(200).json(out);
  } catch (err) {
    out.scrapeDurationMs = Date.now() - startedAt;
    out.ok = false;
    out.error = String(err && err.message ? err.message : err);

    // keep deals array present (empty ok)
    return res.status(200).json(out);
  }
};
