// /api/scrapers/jdsports-algolia.js
//
// ✅ Scrapes JD Sports running shoes sale via Algolia (NO Firecrawl)
// ✅ Fast mode: attributesToRetrieve + no facets + no highlights/snippets
// ✅ Applies your rules (honesty; dedupe by listingURL)
// ✅ Writes FULL top-level JSON + deals[] to Vercel Blob key: jdsports.json
// ✅ Returns LIGHTWEIGHT response (no deals array) + blobUrl
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

function extractListingName(hit) {
  return cleanText(
    pickFirstTruthy(
      hit?.listingName,
      hit?.name,
      hit?.title,
      hit?.product_name,
      hit?.productName
    ) || ""
  );
}

function extractListingURL(hit) {
  return normalizeListingUrl(
    pickFirstTruthy(hit?.url, hit?.pdpUrl, hit?.productUrl, hit?.link, hit?.path) || ""
  );
}

function extractImageURL(hit) {
  const raw = pickFirstTruthy(
    hit?.imageURL,
    hit?.imageUrl,
    hit?.image,
    hit?.image_url,
    hit?.thumbnail,
    hit?.thumbnail_url
  );

  const url = cleanText(raw || "");
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return `https://www.jdsports.com${url}`;
  return url;
}

function extractPrices(hit) {
  const saleCandidate = pickFirstTruthy(
    hit?.salePrice,
    hit?.sale_price,
    hit?.final_price,
    hit?.current_price,
    hit?.price?.sale,
    hit?.price?.current,
    hit?.price
  );

  const originalCandidate = pickFirstTruthy(
    hit?.originalPrice,
    hit?.original_price,
    hit?.regular_price,
    hit?.msrp,
    hit?.compare_at_price,
    hit?.was_price,
    hit?.price?.original,
    hit?.price?.regular
  );

  const salePrice = parseMoney(saleCandidate);
  const originalPrice = parseMoney(originalCandidate);
  return { salePrice, originalPrice };
}

function inferGenderFromHit(hit, listingName) {
  const candidates = [
    hit?.facet_gender,
    hit?.gender,
    hit?.product_gender,
    hit?.department,
  ].filter(Boolean);

  const joined = cleanText(candidates.join(" ")).toLowerCase();
  if (joined.includes("women")) return "womens";
  if (joined.includes("men")) return "mens";
  if (joined.includes("unisex")) return "unisex";

  // Fallback: listingName prefix rule
  const n = (listingName || "").toLowerCase();
  if (n.startsWith("women's ")) return "womens";
  if (n.startsWith("men's ")) return "mens";
  if (n.startsWith("unisex ")) return "unisex";

  return null; // drop
}

function inferShoeType(listingName, hit) {
  const n = (listingName || "").toLowerCase();
  const facets = [
    hit?.facet_surface,
    hit?.surface,
    hit?.facet_activity,
    hit?.activity,
  ]
    .flat()
    .filter(Boolean)
    .map((v) => String(v).toLowerCase());

  const blob = [n, ...facets].join(" ");

  if (blob.includes("trail")) return "trail";
  if (blob.includes("road")) return "road";
  return "unknown";
}

// IMPORTANT: Never edit listingName; only derive brand/model.
function deriveBrandModel(listingName) {
  let s = cleanText(listingName);

  // Remove gender prefix
  s = s.replace(/^(Women's|Men's|Unisex)\s+/i, "");

  // Remove trailing "Running Shoes"
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
/*  // CRON_SECRET
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }  */

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

    // Keep conservative for Vercel. Adjust if needed.
    const MAX_PAGES = 8;
    const HITS_PER_PAGE = 100;

    // FAST: only fetch fields we might use (huge payload reduction)
    const ATTRS = [
      // names
      "listingName",
      "name",
      "title",
      "product_name",
      "productName",

      // urls
      "url",
      "pdpUrl",
      "productUrl",
      "link",
      "path",

      // images
      "imageURL",
      "imageUrl",
      "image",
      "image_url",
      "thumbnail",
      "thumbnail_url",

      // prices
      "salePrice",
      "sale_price",
      "final_price",
      "current_price",
      "price",
      "originalPrice",
      "original_price",
      "regular_price",
      "msrp",
      "compare_at_price",
      "was_price",

      // gender / facets (for infer)
      "facet_gender",
      "gender",
      "product_gender",
      "department",
      "facet_activity",
      "facet_category",
      "facet_surface",
      "surface",
      "activity",
    ];

    for (let page = 0; page < MAX_PAGES; page++) {
      const requests = [
        {
          indexName,
          analytics: false,
          clickAnalytics: false,
          analyticsTags: ["jd-all-sale", "browse", "web"],
          facetFilters: [["facet_activity:Running"], ["facet_category:Shoes"]],

          // FAST: no facets, no highlight/snippet payload
          facets: [],
          attributesToRetrieve: ATTRS,
          attributesToHighlight: [],
          attributesToSnippet: [],

          filters: "",
          hitsPerPage: HITS_PER_PAGE,
          page,
          query: "",
          ruleContexts: ["jd-all-sale", "web"],
          userToken: "anonymous",
        },
      ];

      const json = await algoliaQueries({ host, appId, apiKey, requests });
      const r0 = json?.results?.[0];
      const hits = Array.isArray(r0?.hits) ? r0.hits : [];

      if (page === 0 && hits.length) {
        drop.counts.__debug_firstHit = {
          objectID: hits[0]?.objectID ?? null,
          keys: Object.keys(hits[0] || {}).slice(0, 60),
        };
      }

      drop.counts.totalHits += hits.length;

      if (!hits.length) break;

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

        // Dedup by PDP URL
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
