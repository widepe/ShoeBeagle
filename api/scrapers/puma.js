// /api/scrape-puma.js
// Scrape PUMA running shoe sale via the JSON search endpoint (GraphQL -> Fredhopper-like results)
// Writes blob to puma.json

const { put } = require("@vercel/blob");

// -----------------------------
// helpers
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}

function requireEnv(name) {
  const v = String(process.env[name] || "").trim();
  return v || null;
}

function parseOptionalJsonEnv(name) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) {
    return { __error: `Invalid JSON in ${name}: ${e?.message || "parse error"}` };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toNumPrice(x) {
  if (x == null) return null;
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const s = String(x).trim();
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function pct(off, orig) {
  if (!Number.isFinite(off) || !Number.isFinite(orig) || orig <= 0) return null;
  return Math.round(((orig - off) / orig) * 100);
}

function slugifyPumaName(name) {
  // PUMA slugs look like:
  // "Skyrocket Lite 2 Women's Shoes" -> "skyrocket-lite-2-womens-shoes"
  // keep it simple & robust
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "") // remove apostrophes
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function deriveGender(subHeaderOrName) {
  const s = String(subHeaderOrName || "").toLowerCase();
  if (/\bmen\b|\bmens\b|\bmen's\b/.test(s)) return "mens";
  if (/\bwomen\b|\bwomens\b|\bwomen's\b/.test(s)) return "womens";
  return "unknown";
}

function deriveShoeType(subHeaderOrName) {
  const s = String(subHeaderOrName || "").toLowerCase();
  if (s.includes("road running")) return "road";
  if (s.includes("trail running")) return "trail";
  return "unknown";
}

function buildListingUrlFromHit(masterName, masterId, colorValue) {
  // Matches the pattern you showed:
  // /us/en/pd/cell-thrill-dash-mens-sneakers/311728?swatch=05
  const slug = slugifyPumaName(masterName);
  if (!slug || !masterId) return null;
  const sw = String(colorValue || "").trim();
  const q = sw ? `?swatch=${encodeURIComponent(sw)}` : "";
  return `https://us.puma.com/us/en/pd/${slug}/${encodeURIComponent(masterId)}${q}`;
}

// -----------------------------
// GraphQL fetch
// -----------------------------
async function postGraphql(endpoint, body, extraHeaders) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    ...(extraHeaders || {}),
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave json null
  }

  if (!res.ok) {
    const msg = json?.errors?.[0]?.message || text.slice(0, 500) || `HTTP ${res.status}`;
    throw new Error(`PUMA GraphQL failed (${res.status}): ${msg}`);
  }
  if (!json) throw new Error("PUMA GraphQL returned non-JSON response");
  return json;
}

// -----------------------------
// handler
// -----------------------------
module.exports = async function handler(req, res) {
  const t0 = Date.now();

  // ✅ required
  const endpoint = requireEnv("PUMA_GRAPHQL_ENDPOINT");
  const blobToken = requireEnv("BLOB_READ_WRITE_TOKEN");

  if (!endpoint) {
    res.status(500).json({ ok: false, error: "Missing env var PUMA_GRAPHQL_ENDPOINT" });
    return;
  }
  if (!blobToken) {
    res.status(500).json({ ok: false, error: "Missing env var BLOB_READ_WRITE_TOKEN" });
    return;
  }

  const blobPath = String(process.env.PUMA_BLOB_PATH || "puma.json").trim() || "puma.json";
  const extraHeaders = parseOptionalJsonEnv("PUMA_GRAPHQL_EXTRA_HEADERS_JSON");
  if (extraHeaders?.__error) {
    res.status(500).json({ ok: false, error: extraHeaders.__error });
    return;
  }

  // Pagination knobs
  const viewSize = 24;
  const maxPages = Number(req.query?.maxPages || 50); // safety cap
  const throttleMs = Number(req.query?.throttleMs || 120); // be polite

  // This is the important part: use fh_start_index pagination, not offset=
  // Start index defaults to 0.
  let startIndex = 0;

  // OUTPUT
  const out = {
    store: "PUMA",
    schemaVersion: 1,
    lastUpdated: nowIso(),
    via: "cheerio", // keep your label if you want, but this is JSON API
    sourceUrls: [],
    pagesFetched: 0,
    dealsFound: 0,
    dealsExtracted: 0,
    scrapeDurationMs: 0,
    ok: true,
    error: null,
    dropCounts: {
      totalItemsSeen: 0,
      dropped_notADeal: 0,
      dropped_missingUrl: 0,
      dropped_missingImage: 0,
      dropped_missingModel: 0,
      dropped_saleMissingOrZero: 0,
      dropped_originalMissingOrZero: 0,
      kept: 0,
    },
    deals: [],
  };

  const seen = new Set();
  let totalItems = null;

  try {
    for (let page = 0; page < maxPages; page++) {
      // Build the same query the site uses (you already captured the *response*).
      // You must mirror the site's request body here.
      //
      // IMPORTANT:
      // - The exact "query" string may differ on your end.
      // - If your network request used "operationName" + "variables", copy that.
      //
      // Below is a flexible shape that works when the endpoint accepts a persisted query,
      // OR when it accepts a "query" document. If your request had different keys,
      // paste the request body and we’ll match it exactly.

      const body = {
        // If your request includes operationName, set it here:
        operationName: "searchProducts",
        // If your request includes a GraphQL "query", put it here.
        // If your request was "persisted query" style, you will instead have extensions.persistedQuery.
        // query: "....",
        variables: {
          // the key thing is fh_start_index and fh_view_size
          // Many implementations accept these inside a "urlParams" string. Yours clearly does.
          urlParams: `fh_view_size=${viewSize}&country=us&eb_segment=5&environment=live&fh_view=lister&row_size=4&platform=web&fh_start_index=${startIndex}&fh_location=%2f%2fcatalog01%2fen_US%2fcategories%3c%7bcatalog01_us%7d%2fcategories%3c%7bcatalog01_us_us0sale%7d%2fcategories%3c%7bcatalog01_us_us0sale_us0sale0all0sale%7d%2fproduct_division%3e%7bshoes%7d%2fsport_type%3e%7brunning%7d`,
        },
      };

      const json = await postGraphql(endpoint, body, extraHeaders);

      const sp = json?.data?.searchProducts;
      const itemsSection = sp?.itemsSection;
      const results = itemsSection?.results;
      const items = itemsSection?.items || [];

      // Capture totalItems once (this makes stopping correct & fast)
      if (typeof results?.totalItems === "number" && totalItems == null) {
        totalItems = results.totalItems;
      }

      // Track the “source urls” in a human way
      out.sourceUrls.push(`fh_start_index=${startIndex}&fh_view_size=${viewSize}`);

      out.pagesFetched += 1;
      out.dropCounts.totalItemsSeen += items.length;
      out.dealsFound += items.length;

      let newUniqueThisPage = 0;

      for (const it of items) {
        const hit = it?.productSearchHit;
        const master = hit?.masterProduct;
        const variant = hit?.variantProduct;

        const masterId = master?.id || hit?.masterId || hit?.id;
        const colorValue = hit?.color || variant?.colorValue;
        const masterName = master?.name || variant?.name || "";

        const model = String(master?.header || variant?.header || "").trim() || String(masterName).trim();

        const imageURL =
          variant?.preview ||
          variant?.images?.[0]?.href ||
          master?.image?.href ||
          master?.image?.verticalImageHref ||
          null;

        const salePrice = toNumPrice(variant?.productPrice?.salePrice);
        const originalPrice = toNumPrice(variant?.productPrice?.price);

        // listingURL: we construct from name + id + swatch (works like your HTML example)
        const listingURL = buildListingUrlFromHit(masterName, masterId, colorValue);

        // Derive gender/shoeType from the same label you see on the card
        // In this API, subHeader is the closest analog.
        const subHeader = String(master?.subHeader || variant?.subHeader || "").trim();
        const gender = deriveGender(subHeader || masterName);
        const shoeType = deriveShoeType(subHeader || masterName);

        // Drops (in case the API returns weird items)
        if (!listingURL) {
          out.dropCounts.dropped_missingUrl += 1;
          continue;
        }
        if (!imageURL) {
          out.dropCounts.dropped_missingImage += 1;
          continue;
        }
        if (!model) {
          out.dropCounts.dropped_missingModel += 1;
          continue;
        }
        if (!(salePrice > 0)) {
          out.dropCounts.dropped_saleMissingOrZero += 1;
          continue;
        }
        if (!(originalPrice > 0)) {
          out.dropCounts.dropped_originalMissingOrZero += 1;
          continue;
        }
        if (!(salePrice < originalPrice)) {
          out.dropCounts.dropped_notADeal += 1;
          continue;
        }

        // de-dupe
        if (seen.has(listingURL)) continue;
        seen.add(listingURL);
        newUniqueThisPage += 1;

        const discountPercent = pct(salePrice, originalPrice);

        out.deals.push({
          schemaVersion: 1,
          listingName: masterName || model,
          brand: "Puma",
          model,
          salePrice,
          originalPrice,
          discountPercent,

          salePriceLow: null,
          salePriceHigh: null,
          originalPriceLow: null,
          originalPriceHigh: null,
          discountPercentUpTo: null,

          store: "PUMA",
          listingURL,
          imageURL,
          gender,
          shoeType,
        });

        out.dropCounts.kept += 1;
      }

      // ✅ stop conditions
      if (items.length === 0) {
        out.stopReason = "no_items";
        break;
      }

      // If the endpoint ever repeats the same page, stop immediately
      if (newUniqueThisPage === 0) {
        out.stopReason = "no_new_unique_deals";
        break;
      }

      startIndex += viewSize;

      // If we know totalItems, stop exactly at end
      if (typeof totalItems === "number" && startIndex >= totalItems) {
        out.stopReason = "reached_totalItems";
        break;
      }

      if (throttleMs > 0) await sleep(throttleMs);
    }

    out.dealsExtracted = out.deals.length;
    out.scrapeDurationMs = Date.now() - t0;

    // write blob
    const blob = await put(blobPath, JSON.stringify(out, null, 2), {
      access: "public",
      contentType: "application/json",
      token: blobToken,
    });

    out.blobUrl = blob.url;

    res.setHeader("content-type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify(out, null, 2));
  } catch (err) {
    const outErr = {
      ok: false,
      error: err?.message || String(err),
      lastUpdated: nowIso(),
      scrapeDurationMs: Date.now() - t0,
    };
    res.status(500).json(outErr);
  }
};
