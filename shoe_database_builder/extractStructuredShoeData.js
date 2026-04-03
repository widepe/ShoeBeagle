export async function extractStructuredShoeData(aiClient, { candidate, snippets }) {
  const prompt = `
You are an expert running shoe researcher building a high-quality database.

Use web search, and ONLY the following sources to find data. Do NOT use sources other than the official manufacturer of the shoe and those on this list.

Manufacturer source examples:
- ASICS
- Saucony
- Brooks
- Nike
- New Balance
- Adidas

Approved source order after manufacturer:
1. RunRepeat
2. Running Warehouse
3. RoadTrailRun
4. Doctors of Running
5. Running Shoes Guru
6. OutdoorGearLab
7. RTINGS
8. Road Runner Sports
9. Believe in the Run
10. Sole Review
11. Runner's World
12. The Running Clinic

IMPORTANT:
- Start with the manufacturer as the highest priority.
- Fill in as many schema variables as possible.
- Whatever variables are not found from the manufacturer, move down the approved list from top to bottom, filling in missing variables as you go.
- Sources must be used strictly in the order listed.
- Do not skip ahead.
- Do not guess.
- Prefer null over weak or uncertain data.

INPUT CANDIDATE:
${JSON.stringify(candidate, null, 2)}

OPTIONAL LOCAL SNIPPETS:
${JSON.stringify(snippets || [], null, 2)}

[keep your full REQUIREMENTS + FIELD DEFINITIONS + EVIDENCE RULES block exactly as you have it]

Required JSON shape:
{
  "display_name": string,
  "brand": string,
  "model": string,
  "version": string|null,
  "gender": string,
  "manufacturer_model_id": string|null,
  "aliases": string[],
  "release_year": number|null,
  "msrp_usd": number|null,
  "weight_oz": number|null,
  "weight_value": number|null,
  "weight_unit": string|null,
  "weight_found_size": number|null,
  "weight_found_size_system": string|null,  
  "heel_stack_mm": number|null,
  "forefoot_stack_mm": number|null,
  "offset_mm": number|null,
  "surface": string,
  "support": string,
  "best_use": string[],
  "plated": boolean|null,
  "plate_type": string,
  "foam": string|null,
  "manufacturer_cushioning_label": string|null,
  "cushioning": string,
  "upper": string|null,
  "notes": string|null,
  "confidence_score": number,
  "evidence": array
}

Return valid JSON only.
Do not include markdown fences.
Do not include explanations.
`.trim();

  const response = await aiClient.chat.completions.create({
    model: "sonar-pro",        // Perplexity model
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a precise data-extraction system. You must obey source order and return strictly valid JSON only.",
      },
      { role: "user", content: prompt },
    ],
  });

  const text = response.choices?.[0]?.message?.content || "";

  const parsed = parseJsonLoose(text);

  if (parsed.notes) {
    parsed.notes = parsed.notes
      .split(/\s+/)
      .slice(0, 40)
      .join(" ");
  }

  return postProcess(candidate, parsed);
}
