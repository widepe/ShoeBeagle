export async function insertShoeRecord(db, data) {
  const sql = `
    insert into sb_shoe_database (
      slug, display_name, brand, model, version, gender,
      surface, support, cushioning, best_use, confidence_score
    )
    values (
      lower($1 || '-' || $2 || '-' || $3),
      $4, $1, $2, $5, $3,
      $6, $7, $8, $9, $10
    )
    returning id;
  `;

  const { rows } = await db.query(sql, [
    data.brand,
    data.model,
    data.gender,
    data.display_name,
    data.version,
    data.surface,
    data.support,
    data.cushioning,
    data.best_use,
    data.confidence_score,
  ]);

  return rows[0].id;
}
