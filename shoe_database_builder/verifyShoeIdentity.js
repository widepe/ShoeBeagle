function parseJsonLoose(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Empty model response");

  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error("Could not parse verification JSON");
  }
}

export async function verifyShoeIdentity(openai, { candidate, pageResult }) {
  const prompt = `
You are verifying the identity of a running shoe from its retailer sales page before any broader research begins.

Use ONLY:
- the seed candidate data
- the retailer listing page text
- the retailer listing URL

Your job:
1. Verify or correct:
- brand
- model
- version
- gender

2. Split model and version correctly.
Examples:
- "Ghost 17" => model: "Ghost", version: "17"
- "1080v14" => model: "1080", version: "v14"
- "Kinvara" => model: "Kinvara", version: null

3. The retailer listing page is the source of truth for identity if clear.

4. verified=true ONLY if the listing page clearly supports the shoe identity.
5. verified=false if:
- the page is unclear
- the page appears to be a different shoe
- gender conflicts materially
- version conflicts materially
- brand/model cannot be confirmed

6. Compare against the seed candidate:
- candidate.brand
- candidate.model (this often already includes version)
- candidate.gender

7. If verified=false, explain exactly why in mismatch_reason.

Return valid JSON only.

Seed candidate:
${JSON.stringify(candidate, null, 2)}

Retailer listing page text:
${JSON.stringify({
  ok: pageResult?.ok || false,
  url: candidate.sample_listing_url || null,
  text: pageResult?.text || null,
}, null, 2)}

Required JSON shape:
{
  "verified": boolean,
  "brand": string|null,
  "model": string|null,
  "version": string|null,
  "gender": string|null,
  "display_name": string|null,
  "verification_notes": string|null,
  "mismatch_reason": string|null
}
`.trim();

  const response = await openai.responses.create({
    model: "gpt-5.4",
    input: prompt,
  });

  const text =
    response.output_text ||
    response.output?.[0]?.content?.[0]?.text ||
    "";

  const parsed = parseJsonLoose(text);

  return {
    verified: parsed.verified === true,
    brand: parsed.brand ? String(parsed.brand).trim() : null,
    model: parsed.model ? String(parsed.model).trim() : null,
    version: parsed.version ? String(parsed.version).trim() : null,
    gender: parsed.gender ? String(parsed.gender).trim() : null,
    display_name: parsed.display_name ? String(parsed.display_name).trim() : null,
    verification_notes: parsed.verification_notes
      ? String(parsed.verification_notes).trim()
      : null,
    mismatch_reason: parsed.mismatch_reason
      ? String(parsed.mismatch_reason).trim()
      : null,
  };
}
