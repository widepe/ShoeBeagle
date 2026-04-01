export async function extractStructuredShoeData(openai, snippets) {
  const inputText = snippets.join("\n");

  const response = await openai.responses.create({
    model: "gpt-5.3",
    input: [
      {
        role: "user",
        content: `Extract structured running shoe data from this:\n${inputText}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "shoe",
        schema: {
          type: "object",
          properties: {
            display_name: { type: "string" },
            brand: { type: "string" },
            model: { type: "string" },
            version: { type: ["string", "null"] },
            gender: { type: "string" },
            surface: { type: "string" },
            support: { type: "string" },
            cushioning: { type: "string" },
            best_use: {
              type: "array",
              items: { type: "string" },
            },
            confidence_score: { type: "number" },
            evidence: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  field_name: { type: "string" },
                  raw_value: { type: ["string", "null"] },
                  normalized_value: {},
                  source_name: { type: "string" },
                  source_type: { type: "string" },
                  source_url: { type: ["string", "null"] },
                  confidence_score: { type: ["number", "null"] },
                  is_selected: { type: "boolean" },
                },
                required: ["field_name", "source_name", "source_type", "is_selected"],
              },
            },
          },
          required: [
            "display_name",
            "brand",
            "model",
            "gender",
            "surface",
            "support",
            "cushioning",
            "best_use",
            "confidence_score",
            "evidence",
          ],
        },
      },
    },
  });

  return JSON.parse(response.output[0].content[0].text);
}
