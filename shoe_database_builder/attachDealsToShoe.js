import { toNormalizedKey } from "./normalize.js";

export async function attachDealsToShoe(db, { shoeId, brand, model, version, gender }) {
  const normalizedKey = toNormalizedKey({ brand, model, version, gender });

  const sql = `
    UPDATE sb_shoe_deals d
    SET shoe_id = $1
    WHERE d.shoe_id IS NULL
      AND (
        (
          lower(trim(coalesce(d.brand, ''))) || '|' ||
          lower(trim(coalesce(d.model, ''))) || '|' ||
          lower(trim(coalesce(nullif(d.gender, ''), 'unknown'))) = $2
        )
      );
  `;

  await db.query(sql, [shoeId, normalizedKey]);
}
