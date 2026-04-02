import { toNormalizedKey, toSlug } from "./normalize.js";

export async function insertShoeRecord(db, shoe) {
  const slug = toSlug({
    brand: shoe.brand,
    model: shoe.model,
    gender: shoe.gender,
  });

  const normalizedKey = toNormalizedKey({
    brand: shoe.brand,
    model: shoe.model,
    gender: shoe.gender,
  });

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
    shoe.aliases,
    shoe.release_year,
    shoe.msrp_usd,
    shoe.weight_oz,
    shoe.heel_stack_mm,
    shoe.forefoot_stack_mm,
    shoe.offset_mm,
    shoe.surface,
    shoe.support,
    shoe.best_use,
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
