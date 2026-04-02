import OpenAI from "openai";

export default async function handler(req, res) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing OPENAI_API_KEY in Vercel environment variables",
      });
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const response = await client.responses.create({
      model: "gpt-5.4",
      input: "Say hello in 3 words.",
    });

    return res.status(200).json({
      ok: true,
      output_text: response.output_text ?? null,
      response_id: response.id ?? null,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Unknown error",
      name: error?.name || null,
      status: error?.status || null,
      code: error?.code || null,
      type: error?.type || null,
    });
  }
}
