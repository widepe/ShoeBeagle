export async function insertEvidenceRows(db, shoeId, evidenceList) {
  for (const ev of evidenceList) {
    await db.query(
      `
      insert into sb_shoe_evidence (
        shoe_id, field_name, raw_value, normalized_value,
        source_type, source_name, source_url,
        confidence_score, is_selected
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `,
      [
        shoeId,
        ev.field_name,
        ev.raw_value,
        ev.normalized_value,
        ev.source_type,
        ev.source_name,
        ev.source_url,
        ev.confidence_score,
        ev.is_selected,
      ]
    );
  }
}
