import { toNormalizedKey, toSlug } from "./normalize.js";

export async function insertShoeRecord(db, shoe) {
  const slug = toSlug({
    brand: shoe.brand,
    model: shoe.model,
    version: shoe.version,
    gender: shoe.gender,
  });

  const normalizedKey = toNormalizedKey({
    brand: shoe.brand,
    model: shoe.model,
    version: shoe.version,
    gender: shoe.gender,
  });

  // Postgres requires arrays to be passed as actual JS arrays.
  // best_use and aliases are stored as text[] columns.
  const bestUse = Array.isArray(shoe.best_use) ? shoe.best_use : [];
  const aliases = Array.isArray(shoe.aliases) ? shoe.aliases : [];

  const sql = `
    insert into sb_shoe_database (
      slug,
      display_name,
      brand,
      model,
      version,
      gender,
      manufacturer_model_id,
      aliases,
      release_year,
      msrp_usd,
      weight_oz,
      heel_stack_mm,
      forefoot_stack_mm,
      offset_mm,
      surface,
      support,
      best_use,
      plated,
      plate_type,
      foam,
      cushioning,
      upper,
      notes,
      confidence_score,
      review_status,
      normalized_key
    )
    values (
      $1,  $2,  $3,  $4,  $5,  $6,  $7,  $8,  $9,  $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26
    )
    on conflict (normalized_key)
    do update set
      display_name        = excluded.display_name,
      manufacturer_model_id = excluded.manufacturer_model_id,
      aliases             = excluded.aliases,
      release_year        = excluded.release_year,
      msrp_usd            = excluded.msrp_usd,
      weight_oz           = excluded.weight_oz,
      heel_stack_mm       = excluded.heel_stack_mm,
      forefoot_stack_mm   = excluded.forefoot_stack_mm,
      offset_mm           = excluded.offset_mm,
      surface             = excluded.surface,
      support             = excluded.support,
      best_use            = excluded.best_use,
      plated              = excluded.plated,
      plate_type          = excluded.plate_type,
      foam                = excluded.foam,
      cushioning          = excluded.cushioning,
      upper               = excluded.upper,
      notes               = excluded.notes,
      confidence_score    = excluded.confidence_score,
      updated_at          = now()
    returning id;
  `;

  const params = [
    slug,
    shoe.display_name,
    shoe.brand,
    shoe.model,
    shoe.version,
    shoe.gender,
    shoe.manufacturer_model_id,
    aliases,
    shoe.release_year,
    shoe.msrp_usd,
    shoe.weight_oz,
    shoe.heel_stack_mm,
    shoe.forefoot_stack_mm,
    shoe.offset_mm,
    shoe.surface,
    shoe.support,
    bestUse,
    shoe.plated,
    shoe.plate_type,
    shoe.foam,
    shoe.cushioning,
    shoe.upper,
    shoe.notes,
    shoe.confidence_score,
    shoe.review_status || "unreviewed",
    normalizedKey,
  ];

  const { rows } = await db.query(sql, params);
  return rows[0].id;
}
