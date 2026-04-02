import OpenAI from "openai";

export default async function handler(req, res) {
  try {
    // 1. Check env first (prevents silent crashes)
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        stage: "env",
        error: "Missing OPENAI_API_KEY",
      });
    }

    // 2. Init client
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // 3. Simple test call
    const response = await client.responses.create({
      model: "gpt-5.4",
      input: "Say hello in 3 words.",
    });

    // 4. Safely extract text
    const text =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      "No text returned";

    return res.status(200).json({
      ok: true,
      text,
      id: response.id || null,
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      stage: "openai_call",
      message: error?.message || "Unknown error",
      name: error?.name || null,
      status: error?.status || null,
      code: error?.code || null,
      type: error?.type || null,
    });
  }
}
