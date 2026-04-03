export async function attachDealsToShoe(db, { shoeId, brand, model, gender }) {
  const lookupKey = [
    String(brand || "").trim().toLowerCase(),
    String(model || "").trim().toLowerCase(),
    String(gender || "unknown").trim().toLowerCase(),
  ].join("|");

  const sql = `
    UPDATE sb_shoe_deals d
    SET shoe_id = $1
    WHERE d.shoe_id IS NULL
      AND (
        lower(trim(coalesce(d.brand, ''))) || '|' ||
        lower(trim(coalesce(d.model, ''))) || '|' ||
        lower(trim(coalesce(nullif(d.gender, ''), 'unknown')))
      ) = $2;
  `;

  await db.query(sql, [shoeId, lookupKey]);
}
