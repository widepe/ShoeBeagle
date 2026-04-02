function toJsonbValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  return JSON.stringify(value);
}

function normalizeEvidenceSourceType(value) {
  const v = String(value || "").trim().toLowerCase();

  if (v === "brand") return "brand";
  if (v === "retailer") return "retailer";
  if (v === "lab") return "lab";
  if (v === "review") return "review";
  if (v === "ai") return "ai";
  if (v === "other") return "other";

  if (v === "sb_shoe_deals") return "retailer";
  if (v === "retailer_listing_page") return "retailer";
  if (v === "parsed_page") return "ai";

  return "other";
}

export async function insertEvidenceRows(db, shoeId, evidenceList) {
  if (!Array.isArray(evidenceList) || evidenceList.length === 0) return;

  for (const ev of evidenceList) {
    const normalizedJson = toJsonbValue(ev.normalized_value);
    const sourceType = normalizeEvidenceSourceType(ev.source_type);

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
        sourceType,
        ev.source_name || "Unknown Source",
        ev.source_url ?? null,
        typeof ev.confidence_score === "number" ? ev.confidence_score : null,
        ev.is_selected === true,
        ev.notes ?? null,
      ]
    );
  }
}
