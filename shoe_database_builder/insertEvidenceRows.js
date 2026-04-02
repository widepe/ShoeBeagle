function toJsonbValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  return JSON.stringify(value);
}

export async function insertEvidenceRows(db, shoeId, evidenceList) {
  if (!Array.isArray(evidenceList) || evidenceList.length === 0) return;

  for (const ev of evidenceList) {
    const normalizedJson = toJsonbValue(ev.normalized_value);

    console.log("EVIDENCE INSERT DEBUG", {
      shoeId,
      field_name: ev.field_name || null,
      raw_value: ev.raw_value ?? null,
      normalized_value_original: ev.normalized_value,
      normalized_value_json: normalizedJson,
      source_type: ev.source_type || "parsed_page",
      source_name: ev.source_name || "Unknown Source",
      source_url: ev.source_url ?? null,
      confidence_score:
        typeof ev.confidence_score === "number" ? ev.confidence_score : null,
      is_selected: ev.is_selected === true,
      notes: ev.notes ?? null,
    });

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
        normalizedJson,
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
