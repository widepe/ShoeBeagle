import { toNormalizedKey } from "./normalize.js";

function pickFieldEvidence(evidenceList, fieldName) {
  if (!Array.isArray(evidenceList)) return null;

  const matches = evidenceList.filter(
    (ev) =>
      ev &&
      String(ev.field_name || "").trim() === fieldName &&
      ev.source_url
  );

  if (matches.length === 0) return null;

  return matches[0];
}

function getFieldSourceUrl(evidenceList, fieldName) {
  return pickFieldEvidence(evidenceList, fieldName)?.source_url ?? null;
}

function getFieldRetrievedAt(evidenceList, fieldName, fallback = null) {
  const ev = pickFieldEvidence(evidenceList, fieldName);
  return ev?.retrieved_at ?? fallback;
}

export async function insertShoeRecord(db, shoe) {
  const normalizedKey = toNormalizedKey({
    brand: shoe.brand,
    model: shoe.model,
    version: shoe.version,
    gender: shoe.gender,
  });

  const bestUse = Array.isArray(shoe.best_use) ? shoe.best_use : [];
  const aliases = Array.isArray(shoe.aliases) ? shoe.aliases : [];
  const evidenceList = Array.isArray(shoe.evidence) ? shoe.evidence : [];
  const fallbackRetrievedAt = new Date().toISOString();

  const sql = `
    insert into sb_shoe_database (
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
      weight_oz_source_url,
      weight_oz_retrieved_at,

      heel_stack_mm,
      heel_stack_mm_source_url,
      heel_stack_mm_retrieved_at,

      forefoot_stack_mm,
      forefoot_stack_mm_source_url,
      forefoot_stack_mm_retrieved_at,

      offset_mm,
      offset_mm_source_url,
      offset_mm_retrieved_at,

      surface,
      surface_source_url,
      surface_retrieved_at,

      support,
      support_source_url,
      support_retrieved_at,

      best_use,
      best_use_source_url,
      best_use_retrieved_at,

      plated,
      plated_source_url,
      plated_retrieved_at,

      plate_type,
      plate_type_source_url,
      plate_type_retrieved_at,

      foam,
      foam_source_url,
      foam_retrieved_at,

      cushioning,
      cushioning_source_url,
      cushioning_retrieved_at,

      upper,
      upper_source_url,
      upper_retrieved_at,

      review_status,
      normalized_key
    )
    values (
      $1,  $2,  $3,  $4,  $5,  $6,  $7,  $8,  $9,
      $10, $11, $12,
      $13, $14, $15,
      $16, $17, $18,
      $19, $20, $21,
      $22, $23, $24,
      $25, $26, $27,
      $28, $29, $30,
      $31, $32, $33,
      $34, $35, $36,
      $37, $38, $39,
      $40, $41, $42,
      $43, $44, $45,
      $46, $47
    )
    on conflict (normalized_key)
    do update set
      display_name                  = excluded.display_name,
      manufacturer_model_id         = excluded.manufacturer_model_id,
      aliases                       = excluded.aliases,
      release_year                  = excluded.release_year,
      msrp_usd                      = excluded.msrp_usd,

      weight_oz                     = excluded.weight_oz,
      weight_oz_source_url          = excluded.weight_oz_source_url,
      weight_oz_retrieved_at        = excluded.weight_oz_retrieved_at,

      heel_stack_mm                 = excluded.heel_stack_mm,
      heel_stack_mm_source_url      = excluded.heel_stack_mm_source_url,
      heel_stack_mm_retrieved_at    = excluded.heel_stack_mm_retrieved_at,

      forefoot_stack_mm             = excluded.forefoot_stack_mm,
      forefoot_stack_mm_source_url  = excluded.forefoot_stack_mm_source_url,
      forefoot_stack_mm_retrieved_at= excluded.forefoot_stack_mm_retrieved_at,

      offset_mm                     = excluded.offset_mm,
      offset_mm_source_url          = excluded.offset_mm_source_url,
      offset_mm_retrieved_at        = excluded.offset_mm_retrieved_at,

      surface                       = excluded.surface,
      surface_source_url            = excluded.surface_source_url,
      surface_retrieved_at          = excluded.surface_retrieved_at,

      support                       = excluded.support,
      support_source_url            = excluded.support_source_url,
      support_retrieved_at          = excluded.support_retrieved_at,

      best_use                      = excluded.best_use,
      best_use_source_url           = excluded.best_use_source_url,
      best_use_retrieved_at         = excluded.best_use_retrieved_at,

      plated                        = excluded.plated,
      plated_source_url             = excluded.plated_source_url,
      plated_retrieved_at           = excluded.plated_retrieved_at,

      plate_type                    = excluded.plate_type,
      plate_type_source_url         = excluded.plate_type_source_url,
      plate_type_retrieved_at       = excluded.plate_type_retrieved_at,

      foam                          = excluded.foam,
      foam_source_url               = excluded.foam_source_url,
      foam_retrieved_at             = excluded.foam_retrieved_at,

      cushioning                    = excluded.cushioning,
      cushioning_source_url         = excluded.cushioning_source_url,
      cushioning_retrieved_at       = excluded.cushioning_retrieved_at,

      upper                         = excluded.upper,
      upper_source_url              = excluded.upper_source_url,
      upper_retrieved_at            = excluded.upper_retrieved_at,

      review_status                 = excluded.review_status,
      updated_at                    = now()
    returning id;
  `;

  const params = [
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
    getFieldSourceUrl(evidenceList, "weight_oz"),
    getFieldRetrievedAt(evidenceList, "weight_oz", fallbackRetrievedAt),

    shoe.heel_stack_mm,
    getFieldSourceUrl(evidenceList, "heel_stack_mm"),
    getFieldRetrievedAt(evidenceList, "heel_stack_mm", fallbackRetrievedAt),

    shoe.forefoot_stack_mm,
    getFieldSourceUrl(evidenceList, "forefoot_stack_mm"),
    getFieldRetrievedAt(evidenceList, "forefoot_stack_mm", fallbackRetrievedAt),

    shoe.offset_mm,
    getFieldSourceUrl(evidenceList, "offset_mm"),
    getFieldRetrievedAt(evidenceList, "offset_mm", fallbackRetrievedAt),

    shoe.surface,
    getFieldSourceUrl(evidenceList, "surface"),
    getFieldRetrievedAt(evidenceList, "surface", fallbackRetrievedAt),

    shoe.support,
    getFieldSourceUrl(evidenceList, "support"),
    getFieldRetrievedAt(evidenceList, "support", fallbackRetrievedAt),

    bestUse,
    getFieldSourceUrl(evidenceList, "best_use"),
    getFieldRetrievedAt(evidenceList, "best_use", fallbackRetrievedAt),

    shoe.plated,
    getFieldSourceUrl(evidenceList, "plated"),
    getFieldRetrievedAt(evidenceList, "plated", fallbackRetrievedAt),

    shoe.plate_type,
    getFieldSourceUrl(evidenceList, "plate_type"),
    getFieldRetrievedAt(evidenceList, "plate_type", fallbackRetrievedAt),

    shoe.foam,
    getFieldSourceUrl(evidenceList, "foam"),
    getFieldRetrievedAt(evidenceList, "foam", fallbackRetrievedAt),

    shoe.cushioning,
    getFieldSourceUrl(evidenceList, "cushioning"),
    getFieldRetrievedAt(evidenceList, "cushioning", fallbackRetrievedAt),

    shoe.upper,
    getFieldSourceUrl(evidenceList, "upper"),
    getFieldRetrievedAt(evidenceList, "upper", fallbackRetrievedAt),

    shoe.review_status || "unreviewed",
    normalizedKey,
  ];

  const { rows } = await db.query(sql, params);
  return rows[0].id;
}
