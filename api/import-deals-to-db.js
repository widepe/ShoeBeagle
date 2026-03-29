// /api/import-deals-to-db.js

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const PUBLIC_DEALS_URL =
  "https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/deals.json";

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/['’]/g, "")
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

function normalizeSurface(value) {
  const s = normalizeText(value);
  if (s === "road") return "road";
  if (s === "trail") return "trail";
  if (s === "track") return "track";
  if (s === "xc" || s === "cross country" || s === "cross-country") return "xc";
  return "unknown";
}

function stripLeadingBrand(listingName, brand) {
  const name = String(listingName || "").trim();
  const b = String(brand || "").trim();
  if (!name || !b) return name;

  const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return name.replace(new RegExp(`^${escaped}\\s+`, "i"), "").trim();
}

function buildSlugParts(deal) {
  const brand = normalizeText(deal.brand).replace(/\s+/g, "-");
  const model = normalizeText(deal.model).replace(/\s+/g, "-");
  const version = normalizeText(deal.version).replace(/\s+/g, "-");
  const gender = normalizeGender(deal.gender);

  return {
    brand,
    model,
    version,
    gender,
  };
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
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
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

async function findMatchingShoeId(client, deal) {
  const brand = String(deal.brand || "").trim();
  const model = String(deal.model || "").trim();
  const gender = normalizeGender(deal.gender);
  const candidateSlugs = buildCandidateSlugs(deal);

  if (candidateSlugs.length) {
    const bySlug = await client.query(
      `
      SELECT id
      FROM sb_shoe_database
      WHERE slug = ANY($1::text[])
      LIMIT 1
      `,
      [candidateSlugs]
    );
    if (bySlug.rows.length) return bySlug.rows[0].id;
  }

  if (brand && model) {
    const byFields = await client.query(
      `
      SELECT id
      FROM sb_shoe_database
      WHERE lower(brand) = lower($1)
        AND lower(model) = lower($2)
        AND (gender = $3 OR gender = 'unisex' OR $3 = 'unknown')
      LIMIT 1
      `,
      [brand, model, gender]
    );
    if (byFields.rows.length) return byFields.rows[0].id;
  }

  return null;
}

async function findExistingDealId(client, deal) {
  const store = String(deal.store || "").trim();
  const listingUrl = String(deal.listing_url || deal.listingURL || "").trim();
  const listingName = String(deal.listing_name || deal.listingName || "").trim();
  const brand = String(deal.brand || "").trim();
  const model = String(deal.model || "").trim();

  if (store && listingUrl) {
    const byUrl = await client.query(
      `
      SELECT id
      FROM sb_shoe_deals
      WHERE store = $1 AND listing_url = $2
      LIMIT 1
      `,
      [store, listingUrl]
    );
    if (byUrl.rows.length) return byUrl.rows[0].id;
  }

  const byName = await client.query(
    `
    SELECT id
    FROM sb_shoe_deals
    WHERE store = $1
      AND listing_name = $2
      AND brand = $3
      AND model = $4
    LIMIT 1
    `,
    [store, listingName, brand, model]
  );

  if (byName.rows.length) return byName.rows[0].id;

  return null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const dryRun = String(req.query.dryRun || "").toLowerCase() === "true";
  const dealsUrl = String(req.query.url || PUBLIC_DEALS_URL).trim();

  let client;

  try {
    const payload = await fetchDealsJson(dealsUrl);
    const deals = extractDeals(payload);

    client = await pool.connect();
    await client.query("BEGIN");

    let inserted = 0;
    let updated = 0;
    let matched = 0;
    let unmatched = 0;
    const preview = [];

    for (const raw of deals) {
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
        surface: normalizeSurface(raw.surface ?? raw.shoeType),
        scraped_at: raw.scraped_at || raw.scrapedAt || payload.lastUpdated || new Date().toISOString(),
        shoe_id: await findMatchingShoeId(client, raw),
      };

      if (row.shoe_id) matched += 1;
      else unmatched += 1;

      preview.push({
        listing_name: row.listing_name,
        brand: row.brand,
        model: row.model,
        store: row.store,
        surface: row.surface,
        gender: row.gender,
        shoe_id: row.shoe_id,
      });

      if (dryRun) continue;

      const existingId = await findExistingDealId(client, row);

      if (existingId) {
        await client.query(
          `
          UPDATE sb_shoe_deals
          SET
            listing_name = $1,
            brand = $2,
            model = $3,
            sale_price = $4,
            original_price = $5,
            discount_percent = $6,
            sale_price_low = $7,
            sale_price_high = $8,
            original_price_low = $9,
            original_price_high = $10,
            discount_percent_up_to = $11,
            store = $12,
            listing_url = $13,
            image_url = $14,
            gender = $15,
            surface = $16,
            scraped_at = $17,
            shoe_id = $18
          WHERE id = $19
          `,
          [
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
            row.surface,
            row.scraped_at,
            row.shoe_id,
            existingId,
          ]
        );
        updated += 1;
      } else {
        await client.query(
          `
          INSERT INTO sb_shoe_deals (
            listing_name,
            brand,
            model,
            sale_price,
            original_price,
            discount_percent,
            sale_price_low,
            sale_price_high,
            original_price_low,
            original_price_high,
            discount_percent_up_to,
            store,
            listing_url,
            image_url,
            gender,
            surface,
            scraped_at,
            shoe_id
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
          )
          `,
          [
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
            row.surface,
            row.scraped_at,
            row.shoe_id,
          ]
        );
        inserted += 1;
      }
    }

    if (dryRun) {
      await client.query("ROLLBACK");
      return res.status(200).json({
        success: true,
        dryRun: true,
        dealsUrl,
        totalDealsInJson: deals.length,
        inserted,
        updated,
        matched,
        unmatched,
        preview: preview.slice(0, 25),
      });
    }

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      dealsUrl,
      totalDealsInJson: deals.length,
      inserted,
      updated,
      matched,
      unmatched,
      preview: preview.slice(0, 25),
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  } finally {
    if (client) client.release();
  }
};
