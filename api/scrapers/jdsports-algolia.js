// /api/scrapers/jdsports-algolia.js
//
// ✅ JD Sports via Algolia (NO Firecrawl)
// ✅ FAST mode + auto-fallback to WIDE mode if name/url fields are missing
// ✅ Writes jdsports.json to Vercel Blob
// ✅ Returns lightweight response
//
// ENV required:
// - JDSPORTS_ALGOLIA_APP_ID
// - JDSPORTS_ALGOLIA_API_KEY
// - BLOB_READ_WRITE_TOKEN
//
// Optional:
// - JDSPORTS_ALGOLIA_INDEX (default: jd_products_prod)
// - JDSPORTS_DEALS_BLOB_URL
// - CRON_SECRET

import { put } from "@vercel/blob";

function nowIso() {
  return new Date().toISOString();
}
function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function parseMoney(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  const t = String(x).trim();
  if (!t) return null;
  const m = t.replace(/[^0-9.]/g, "");
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}
function roundInt(n) {
  return Number.isFinite(n) ? Math.round(n) : null;
}
function pickFirstTruthy(...vals) {
  for (const v of vals) {
    if (v !== null && v !== undefined && String(v).trim() !== "") return v;
  }
  return null;
}

function normalizeListingUrl(u) {
  const url = cleanText(u);
  if (!url) return "";
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return `https://www.jdsports.com${url}`;
  return url;
}

// IMPORTANT: Never edit listingName; only derive brand/model.
function deriveBrandModel(listingName) {
  let s = cleanText(listingName);

  s = s.replace(/^(Women's|Men's|Unisex)\s+/i, "");
  s = s.replace(/\s+(Trail|Road)\s+Running\s+Shoes\s*$/i, "");
  s = s.replace(/\s+Running\s+Shoes\s*$/i, "");
  s = cleanText(s);

  if (!s) return { brand: "unknown", model: "unknown" };

  const multiWordBrands = ["New Balance"];
  for (const b of multiWordBrands) {
    const bl = b.toLowerCase();
    const sl = s.toLowerCase();
    if (sl === bl) return { brand: b, model: "unknown" };
    if (sl.startsWith(bl + " ")) {
      return { brand: b, model: cleanText(s.slice(b.length)) || "unknown" };
    }
  }

  const parts = s.split(" ");
  const brand = parts[0] ? cleanText(parts[0]) : "unknown";
  const model = parts.length > 1 ? cleanText(parts.slice(1).join(" ")) : "unknown";
  return { brand, model };
}

function inferGenderFromHit(hit, listingName) {
  const candidates = [hit?.facet_gender, hit?.gender, hit?.department].filter(Boolean);
  const joined = cleanText(candidates.join(" ")).toLowerCase();
  if (joined.includes("women")) return "womens";
  if (joined.includes("men")) return "mens";
  if (joined.includes("unisex")) return "unisex";

  // fallback: prefix rule
  const n = (listingName || "").toLowerCase();
  if (n.startsWith("women's ")) return "womens";
  if (n.startsWith("men's ")) return "mens";
  if (n.startsWith("unisex ")) return "unisex";
  return null;
}

function inferShoeType(listingName, hit) {
  const n = (listingName || "").toLowerCase();
  const facets = [hit?.facet_surface, hit?.surface, hit?.facet_activity, hit?.activity]
    .flat()
    .filter(Boolean)
    .map((v) => String(v).toLowerCase());
  const blob = [n, ...facets].join(" ");
  if (blob.includes("trail")) return "trail";
  if (blob.includes("road")) return "road";
  return "unknown";
}

// --- Extraction (wide, defensive) ---
function extractListingName(hit) {
  // add lots of common variants; safe even if missing
  return cleanText(
    pickFirstTruthy(
      hit?.listingName,
      hit?.name,
      hit?.title,
      hit?.product_name,
      hit?.productName,
      hit?.product_title,
      hit?.productTitle,
      hit?.display_name,
      hit?.displayName,
      hit?.product_display_name,
      hit?.seo_title,
      hit?.h1,
      hit?.sku_name
    ) || ""
  );
}

function extractListingURL(hit) {
  return normalizeListingUrl(
    pickFirstTruthy(
      hit?.url,
      hit?.pdpUrl,
      hit?.productUrl,
      hit?.pdp_url,
      hit?.product_url,
      hit?.link,
      hit?.path,
      hit?.seo_url,
      hit?.canonical_url
    ) || ""
  );
}

function extractImageURL(hit) {
  const raw = pickFirstTruthy(
    hit?.imageURL,
    hit?.imageUrl,
    hit?.image,
    hit?.image_url,
    hit?.thumbnail,
    hit?.thumbnail_url,
    hit?.main_image,
    hit?.mainImage
  );
  const url = cleanText(raw || "");
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return `https://www.jdsports.com${url}`;
  return url;
}

function extractPrices(hit) {
  // Your debug shows: final_price + price
  // Often: final_price = sale, price = original
  const saleCandidate = pickFirstTruthy(hit?.final_price, hit?.salePrice, hit?.sale_price, hit?.current_price);
  const originalCandidate = pickFirstTruthy(hit?.price, hit?.originalPrice, hit?.original_price, hit?.regular_price, hit?.msrp);

  // If "price" is an object, try common keys inside it
  let original = originalCandidate;
  if (original && typeof original === "object") {
    original = pickFirstTruthy(
      original?.original,
      original?.regular,
      original?.value,
      original?.amount,
      original?.current
    );
  }

  const salePrice = parseMoney(saleCandidate);
  const originalPrice = parseMoney(original);

  return { salePrice, originalPrice };
}

function makeDropTracker() {
  const counts = {
    totalHits: 0,
    dropped_missingListingName: 0,
    dropped_missingUrl: 0,
    dropped_gender: 0,
    dropped_saleMissingOrZero: 0,
    dropped_originalMissingOrZero: 0,
    dropped_notADeal: 0,
    kept: 0,
    __debug_firstHit: null,
    __debug_mode: null,
  };

  const bump = (key) => {
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
  };

  function toSummaryArray() {
    const rows = [
      { reason: "dropped_missingListingName", count: counts.dropped_missingListingName, note: "No title/name field found" },
      { reason: "dropped_missingUrl", count: counts.dropped_missingUrl, note: "No PDP link found" },
      { reason: "dropped_gender", count: counts.dropped_gender, note: "Could not infer mens/womens/unisex" },
      { reason: "dropped_saleMissingOrZero", count: counts.dropped_saleMissingOrZero, note: "Sale price missing/invalid/0" },
      { reason: "dropped_originalMissingOrZero", count: counts.dropped_originalMissingOrZero, note: "Original price missing/invalid/0" },
      { reason: "dropped_notADeal", count: counts.dropped_notADeal, note: "originalPrice must be > salePrice" },
      { reason: "kept", count: counts.kept, note: "Included in deals[]" },
    ];
    return rows.filter((r) => r.count > 0 || r.reason === "kept");
  }

  return { counts, bump, toSummaryArray };
}

async function algoliaQueries({ host, appId, apiKey, requests }) {
  const resp = await fetch(`https://${host}/1/indexes/*/queries`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-algolia-application-id": appId,
      "x-algolia-api-key": apiKey,
    },
    body: JSON.stringify({ requests }),
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = json?.message || json?.error || `Algolia HTTP ${resp.status}`;
    throw new Error(`Algolia failed: ${msg}`);
  }
  return json;
}

async function writeBlobJson(key, obj) {
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
  if (!token) throw new Error("Missing BLOB_READ_WRITE_TOKEN");

  const result = await put(key, JSON.stringify(obj, null, 2), {
    access: "public",
    token,
    contentType: "application/json",
    addRandomSuffix: false,
  });

  return result?.url || null;
}

function toLightweightResponse(output) {
  return {
    store: output.store,
    schemaVersion: output.schemaVersion,
    lastUpdated: output.lastUpdated,
    via: output.via,
    sourceUrls: output.sourceUrls,
    pagesFetched: output.pagesFetched,
    dealsFound: output.dealsFound,
    dealsExtracted: output.dealsExtracted,
    scrapeDurationMs: output.scrapeDurationMs,
    ok: output.ok,
    error: output.error,
    dropCounts: output.dropCounts || null,
    dropReasons: output.dropReasons || null,
    blobUrl: output.blobUrl || null,
    configuredBlobUrl: output.configuredBlobUrl || null,
  };
}

export default async function handler(req, res) {
  // CRON_SECRET
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const t0 = Date.now();

  const configuredBlobUrl = String(process.env.JDSPORTS_DEALS_BLOB_URL || "").trim() || null;

  const appId = String(process.env.JDSPORTS_ALGOLIA_APP_ID || "").trim();
  const apiKey = String(process.env.JDSPORTS_ALGOLIA_API_KEY || "").trim();
  const indexName = String(process.env.JDSPORTS_ALGOLIA_INDEX || "jd_products_prod").trim();

  if (!appId) return res.status(500).json({ ok: false, error: "Missing JDSPORTS_ALGOLIA_APP_ID" });
  if (!apiKey) return res.status(500).json({ ok: false, error: "Missing JDSPORTS_ALGOLIA_API_KEY" });

  const host = `${appId.toLowerCase()}-dsn.algolia.net`;
  const startUrl = `algolia:${indexName} facet_activity=Running facet_category=Shoes ruleContexts=jd-all-sale`;

  const drop = makeDropTracker();

  try {
    const deals = [];
    const seenUrl = new Set();

    const MAX_PAGES = 8;
    const HITS_PER_PAGE = 100;

    // FAST: very small payload. (But we auto-fallback if it hides title/url fields.)
    const FAST_ATTRS = [
      "objectID",
      "final_price",
      "price",
      "facet_gender",
      "facet_activity",
      "facet_category",

      // try some likely title/url/image fields (may be wrong on JD; that’s okay)
      "name",
      "title",
      "product_name",
      "productName",
      "url",
      "path",
      "pdpUrl",
      "productUrl",
      "image",
      "imageUrl",
      "thumbnail",
      "originalPrice",
      "regular_price",
      "msrp",
    ];

    let mode = "fast"; // "fast" or "wide"

    for (let page = 0; page < MAX_PAGES; page++) {
      const request = {
        indexName,
        analytics: false,
        clickAnalytics: false,
        analyticsTags: ["jd-all-sale", "browse", "web"],
        facetFilters: [["facet_activity:Running"], ["facet_category:Shoes"]],
        filters: "",
        hitsPerPage: HITS_PER_PAGE,
        page,
        query: "",
        ruleContexts: ["jd-all-sale", "web"],
        userToken: "anonymous",
      };

      if (mode === "fast") {
        request.facets = [];
        request.attributesToRetrieve = FAST_ATTRS;
        request.attributesToHighlight = [];
        request.attributesToSnippet = [];
      }

      const json = await algoliaQueries({ host, appId, apiKey, requests: [request] });
      const r0 = json?.results?.[0];
      const hits = Array.isArray(r0?.hits) ? r0.hits : [];

      if (page === 0 && hits.length) {
        drop.counts.__debug_firstHit = {
          objectID: hits[0]?.objectID ?? null,
          keys: Object.keys(hits[0] || {}).slice(0, 80),
        };
        drop.counts.__debug_mode = mode;
      }

      drop.counts.totalHits += hits.length;

      if (!hits.length) break;

      // If FAST mode returns hits but ALL missingListingName, switch to WIDE and re-fetch page 0 once.
      if (mode === "fast" && page === 0) {
        let missingNameCount = 0;
        for (const hit of hits) {
          const nm = extractListingName(hit);
          if (!nm) missingNameCount++;
        }
        if (missingNameCount === hits.length) {
          mode = "wide";

          // re-fetch page 0 in WIDE mode (no attributesToRetrieve)
          const jsonWide = await algoliaQueries({ host, appId, apiKey, requests: [{ ...request, facets: [], attributesToRetrieve: undefined }] });
          const r0w = jsonWide?.results?.[0];
          const hitsW = Array.isArray(r0w?.hits) ? r0w.hits : [];

          // reset the current loop’s hits to wide hits
          hits.length = 0;
          hits.push(...hitsW);

          if (hitsW.length) {
            drop.counts.__debug_firstHit = {
              objectID: hitsW[0]?.objectID ?? null,
              keys: Object.keys(hitsW[0] || {}).slice(0, 80),
            };
            drop.counts.__debug_mode = "wide";
          }
        }
      }

      for (const hit of hits) {
        const listingName = extractListingName(hit);
        if (!listingName) {
          drop.bump("dropped_missingListingName");
          continue;
        }

        const listingURL = extractListingURL(hit);
        if (!listingURL) {
          drop.bump("dropped_missingUrl");
          continue;
        }

        if (seenUrl.has(listingURL)) continue;
        seenUrl.add(listingURL);

        const gender = inferGenderFromHit(hit, listingName);
        if (!gender) {
          drop.bump("dropped_gender");
          continue;
        }

        const { salePrice, originalPrice } = extractPrices(hit);

        if (!(Number.isFinite(salePrice) && salePrice > 0)) {
          drop.bump("dropped_saleMissingOrZero");
          continue;
        }
        if (!(Number.isFinite(originalPrice) && originalPrice > 0)) {
          drop.bump("dropped_originalMissingOrZero");
          continue;
        }
        if (!(originalPrice > salePrice)) {
          drop.bump("dropped_notADeal");
          continue;
        }

        const shoeType = inferShoeType(listingName, hit);
        const imageURL = extractImageURL(hit) || "";

        const discountPercent = roundInt(((originalPrice - salePrice) / originalPrice) * 100);
        const { brand, model } = deriveBrandModel(listingName);

        deals.push({
          schemaVersion: 1,
          listingName,
          brand,
          model,
          salePrice,
          originalPrice,
          discountPercent,
          salePriceLow: null,
          salePriceHigh: null,
          originalPriceLow: null,
          originalPriceHigh: null,
          discountPercentUpTo: null,
          store: "JD Sports",
          listingURL,
          imageURL,
          gender,
          shoeType,
        });

        drop.bump("kept");
      }

      const nbPages = Number(r0?.nbPages);
      if (Number.isFinite(nbPages) && page + 1 >= nbPages) break;
    }

    const scrapeDurationMs = Date.now() - t0;

    const output = {
      store: "JD Sports",
      schemaVersion: 1,
      lastUpdated: nowIso(),
      via: "algolia",
      sourceUrls: [startUrl],
      pagesFetched: null,
      dealsFound: seenUrl.size,
      dealsExtracted: deals.length,
      scrapeDurationMs,
      ok: true,
      error: null,
      deals,
      dropCounts: drop.counts,
      dropReasons: drop.toSummaryArray(),
      blobUrl: null,
      configuredBlobUrl,
    };

    output.blobUrl = await writeBlobJson("jdsports.json", output);
    return res.status(200).json(toLightweightResponse(output));
  } catch (err) {
    const scrapeDurationMs = Date.now() - t0;

    const output = {
      store: "JD Sports",
      schemaVersion: 1,
      lastUpdated: nowIso(),
      via: "algolia",
      sourceUrls: [startUrl],
      pagesFetched: null,
      dealsFound: 0,
      dealsExtracted: 0,
      scrapeDurationMs,
      ok: false,
      error: String(err?.message || err),
      deals: [],
      dropCounts: drop?.counts || null,
      dropReasons: drop?.toSummaryArray?.() || null,
      blobUrl: null,
      configuredBlobUrl,
    };

    try {
      output.blobUrl = await writeBlobJson("jdsports.json", output);
    } catch {}

    return res.status(500).json(toLightweightResponse(output));
  }
}
