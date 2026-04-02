import { toNormalizedKey } from "./normalize.js";

export async function attachDealsToShoe(db, { shoeId, brand, model, gender }) {
  const normalizedKey = toNormalizedKey({ brand, model, gender });

  const sql = `
    update sb_shoe_deals d
    set shoe_id = $1
    where d.shoe_id is null
      and (
        (
          lower(trim(coalesce(d.brand, ''))) || '|' ||
          lower(trim(coalesce(d.model, ''))) || '|' ||
          lower(trim(coalesce(nullif(d.gender, ''), 'unknown')))
        ) = $2
        or (
          lower(trim(d.brand)) = lower(trim($3))
          and lower(trim(d.model)) = lower(trim($4))
          and lower(trim(coalesce(nullif(d.gender, ''), 'unknown'))) = lower(trim($5))
        )
      )
  `;

  await db.query(sql, [shoeId, normalizedKey, brand, model, gender]);
}
