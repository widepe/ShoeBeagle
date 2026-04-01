export async function attachDealsToShoe(db, { shoeId, brand, model, gender }) {
  await db.query(
    `
    update sb_shoe_deals
    set shoe_id = $1
    where lower(brand) = lower($2)
      and lower(model) = lower($3)
      and lower(coalesce(gender, 'unknown')) = lower($4)
      and shoe_id is null
  `,
    [shoeId, brand, model, gender]
  );
}
