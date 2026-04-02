function toJsonbValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  return JSON.stringify(value);
}

export async function insertEvidenceRows(db, shoeId, evidenceList) {
  if (!Array.isArray(evidenceList) || evidenceList.length === 0) return;

  for (const ev of evidenceList) {
    await db.query(
      `
      insert into sb_shoe_evidence (
        shoe_id,
        field_name,
        raw_value,
        normalized_value,
        source_type,
        source_name,
        source_url,
        confidence_score,
        is_selected,
        notes
      )
      values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)
      `,
      [
        shoeId,
        ev.field_name || null,
        ev.raw_value ?? null,
        toJsonbValue(ev.normalized_value),
        ev.source_type || "parsed_page",
        ev.source_name || "Unknown Source",
        ev.source_url ?? null,
        typeof ev.confidence_score === "number" ? ev.confidence_score : null,
        ev.is_selected === true,
        ev.notes ?? null,
      ]
    );
  }
}
