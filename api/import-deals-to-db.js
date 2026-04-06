// /api/import-deals-to-db.js

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const PUBLIC_DEALS_URL =
  "https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/deals.json";

const BATCH_SIZE = 500;

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/['']/g, "")
    .replace(/[^a-z0-9+.\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeGender(value) {
  const s = normalizeText(value);
  if (s === "mens" || s === "men" || s === "mens shoe" || s === "mens shoes") return "mens";
  if (s === "womens" || s === "women" || s === "womens shoe" || s === "womens shoes") return "womens";
  if (s === "unisex") return "unisex";
  return "unknown";
}

function buildSlugParts(deal) {
  const brand = normalizeText(deal.brand).replace(/\s+/g, "-");
  const model = normalizeText(deal.model).replace(/\s+/g, "-");
  const version = normalizeText(deal.version).replace(/\s+/g, "-");
  const gender = normalizeGender(deal.gender);

  return { brand, model, version, gender };
}

function buildCandidateSlugs(deal) {
  const { brand, model, version, gender } = buildSlugParts(deal);
  const slugs = new Set();

  if (brand && model && version && gender !== "unknown") {
    slugs.add(`${brand}-${model}-${version}-${gender}`);
  }
  if (brand && model && version) {
    slugs.add(`${brand}-${model}-${version}`);
  }
  if (brand && model && gender !== "unknown") {
    slugs.add(`${brand}-${model}-${gender}`);
  }
  if (brand && model) {
    slugs.add(`${brand}-${model}`);
  }

  return Array.from(slugs);
}

async function fetchDealsJson(url) {
  const resp = await fetch(url, {
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch deals JSON: ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}

function extractDeals(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.deals)) return payload.deals;
  return [];
}

// ---------------------------------------------------------------------------
// Bulk shoe-ID resolution: one query for slugs, one for brand/model/gender
// ---------------------------------------------------------------------------

async function buildShoeIdLookup(client, deals) {
  // Collect all candidate slugs across all deals
  const allSlugs = new Set();
  for (const deal of deals) {
    for (const slug of buildCandidateSlugs(deal)) {
      allSlugs.add(slug);
    }
  }

  // slug → shoe id
  const slugToId = new Map();
  if (allSlugs.size > 0) {
    const slugArr = Array.from(allSlugs);
    const { rows } = await client.query(
      `SELECT id, slug FROM sb_shoe_database WHERE slug = ANY($1::text[])`,
      [slugArr]
    );
    for (const r of rows) {
      slugToId.set(r.slug, r.id);
    }
  }

  // Collect unique (brand, model, gender) combos for fallback field-match
  const fieldKeys = new Set();
  const fieldTuples = [];
  for (const deal of deals) {
    const brand = String(deal.brand || "").trim().toLowerCase();
    const model = String(deal.model || "").trim().toLowerCase();
    const gender = normalizeGender(deal.gender);
    if (!brand || !model) continue;
    const key = `${brand}|${model}|${gender}`;
    if (!fieldKeys.has(key)) {
      fieldKeys.add(key);
      fieldTuples.push({ brand, model, gender });
    }
  }

  // "brand|model|gender" → shoe id  (field-based fallback)
  const fieldToId = new Map();
  if (fieldTuples.length > 0) {
    // Build a VALUES list for a single bulk query
    const params = [];
    const valuesClauses = [];
    for (let i = 0; i < fieldTuples.length; i++) {
      const off = i * 3;
      valuesClauses.push(`($${off + 1}, $${off + 2}, $${off + 3})`);
      params.push(fieldTuples[i].brand, fieldTuples[i].model, fieldTuples[i].gender);
    }

    const { rows } = await client.query(
      `
      SELECT DISTINCT ON (v.brand, v.model, v.gender)
             s.id, v.brand, v.model, v.gender
      FROM (VALUES ${valuesClauses.join(",")}) AS v(brand, model, gender)
      JOIN sb_shoe_database s
        ON lower(s.brand) = v.brand
       AND lower(s.model) = v.model
       AND (s.gender = v.gender OR s.gender = 'unisex' OR v.gender = 'unknown')
      `,
      params
    );

    for (const r of rows) {
      fieldToId.set(`${r.brand}|${r.model}|${r.gender}`, r.id);
    }
  }

  return { slugToId, fieldToId };
}

function resolveShoeId(deal, slugToId, fieldToId) {
  // Try slug match (most-specific first — buildCandidateSlugs returns them in that order)
  const candidateSlugs = buildCandidateSlugs(deal);
  for (const slug of candidateSlugs) {
    const id = slugToId.get(slug);
    if (id != null) return id;
  }

  // Fallback: field-based match
  const brand = String(deal.brand || "").trim().toLowerCase();
  const model = String(deal.model || "").trim().toLowerCase();
  const gender = normalizeGender(deal.gender);
  if (brand && model) {
    const id = fieldToId.get(`${brand}|${model}|${gender}`);
    if (id != null) return id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Bulk INSERT in batches
// ---------------------------------------------------------------------------

const COLUMNS = [
  "listing_name",
  "brand",
  "model",
  "sale_price",
  "original_price",
  "discount_percent",
  "sale_price_low",
  "sale_price_high",
  "original_price_low",
  "original_price_high",
  "discount_percent_up_to",
  "store",
  "listing_url",
  "image_url",
  "gender",
  "scraped_at",
  "shoe_id",
];

function rowValues(row) {
  return [
    row.listing_name,
    row.brand,
    row.model,
    row.sale_price,
    row.original_price,
    row.discount_percent,
    row.sale_price_low,
    row.sale_price_high,
    row.original_price_low,
    row.original_price_high,
    row.discount_percent_up_to,
    row.store,
    row.listing_url,
    row.image_url,
    row.gender,
    row.scraped_at,
    row.shoe_id,
  ];
}

async function bulkInsert(client, rows) {
  const colCount = COLUMNS.length; // 17
  let totalInserted = 0;

  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const params = [];
    const valuesClauses = [];

    for (let i = 0; i < batch.length; i++) {
      const off = i * colCount;
      const placeholders = COLUMNS.map((_, c) => `$${off + c + 1}`).join(",");
      valuesClauses.push(`(${placeholders})`);
      params.push(...rowValues(batch[i]));
    }

    await client.query(
      `INSERT INTO sb_shoe_deals (${COLUMNS.join(",")})
       VALUES ${valuesClauses.join(",")}`,
      params
    );

    totalInserted += batch.length;
  }

  return totalInserted;
}

// ---------------------------------------------------------------------------
// Core logic — callable directly (no req/res needed)
// ---------------------------------------------------------------------------

async function run({ dryRun = false, dealsUrl = PUBLIC_DEALS_URL } = {}) {
  const startMs = Date.now();
  let client;

  try {
    const payload = await fetchDealsJson(dealsUrl);
    const deals = extractDeals(payload);

    if (!Array.isArray(deals) || deals.length === 0) {
      throw new Error("Deals JSON is empty or invalid.");
    }

    client = await pool.connect();
    await client.query("BEGIN");

    // --- Bulk shoe-ID resolution (2 queries instead of N×2) ---
    const { slugToId, fieldToId } = await buildShoeIdLookup(client, deals);

    // --- Normalize every deal row in memory ---
    const preparedRows = [];
    const skippedDeals = [];

    for (const raw of deals) {
      const shoeId = resolveShoeId(raw, slugToId, fieldToId);

      const row = {
        listing_name: String(raw.listing_name || raw.listingName || "").trim(),
        brand: String(raw.brand || "").trim(),
        model: String(raw.model || "").trim(),
        sale_price: toNumber(raw.sale_price ?? raw.salePrice),
        original_price: toNumber(raw.original_price ?? raw.originalPrice),
        discount_percent: toNumber(raw.discount_percent ?? raw.discountPercent),
        sale_price_low: toNumber(raw.sale_price_low ?? raw.salePriceLow),
        sale_price_high: toNumber(raw.sale_price_high ?? raw.salePriceHigh),
        original_price_low: toNumber(raw.original_price_low ?? raw.originalPriceLow),
        original_price_high: toNumber(raw.original_price_high ?? raw.originalPriceHigh),
        discount_percent_up_to: toNumber(raw.discount_percent_up_to ?? raw.discountPercentUpTo),
        store: String(raw.store || "").trim(),
        listing_url: String(raw.listing_url || raw.listingURL || "").trim(),
        image_url: String(raw.image_url || raw.imageURL || "").trim() || null,
        gender: normalizeGender(raw.gender),
        scraped_at: raw.scraped_at || raw.scrapedAt || payload.lastUpdated || new Date().toISOString(),
        shoe_id: shoeId,
      };

      if (!shoeId) {
        skippedDeals.push({ brand: row.brand, model: row.model, version: String(raw.version || "").trim() });
      }

      preparedRows.push(row);
    }

    const matched = preparedRows.filter((r) => r.shoe_id != null).length;
    const unmatched = preparedRows.length - matched;

    if (dryRun) {
      await client.query("ROLLBACK");

      const preview = preparedRows.slice(0, 25).map((r) => ({
        listing_name: r.listing_name,
        brand: r.brand,
        model: r.model,
        store: r.store,
        gender: r.gender,
        shoe_id: r.shoe_id,
      }));

      return {
        success: true,
        dryRun: true,
        dealsUrl,
        totalDealsInJson: deals.length,
        inserted: 0,
        updated: 0,
        matched,
        unmatched,
        skipped: unmatched,
        elapsed_ms: Date.now() - startMs,
        errors: [],
        skippedDeals: skippedDeals.slice(0, 50),
        preview,
      };
    }

    // --- Wipe + bulk insert inside the transaction ---
    await client.query('DELETE FROM "sb_shoe_deals"');
    const insertedCount = await bulkInsert(client, preparedRows);

    await client.query("COMMIT");

    return {
      success: true,
      dryRun: false,
      dealsUrl,
      totalDealsInJson: deals.length,
      inserted: insertedCount,
      updated: 0,
      matched,
      unmatched,
      skipped: unmatched,
      elapsed_ms: Date.now() - startMs,
      errors: [],
      skippedDeals: skippedDeals.slice(0, 50),
      preview: preparedRows.slice(0, 25).map((r) => ({
        listing_name: r.listing_name,
        brand: r.brand,
        model: r.model,
        store: r.store,
        gender: r.gender,
        shoe_id: r.shoe_id,
      })),
    };
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }

    return {
      success: false,
      error: err.message,
      elapsed_ms: Date.now() - startMs,
    };
  } finally {
    if (client) client.release();
  }
}

// ---------------------------------------------------------------------------
// API route handler (delegates to run())
// ---------------------------------------------------------------------------

const handler = async (req, res) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const dryRun = String(req.query.dryRun || "").toLowerCase() === "true";
  const dealsUrl = String(req.query.url || PUBLIC_DEALS_URL).trim();

  const result = await run({ dryRun, dealsUrl });
  const status = result.success ? 200 : 500;
  return res.status(status).json(result);
};

handler.run = run;
module.exports = handler;
