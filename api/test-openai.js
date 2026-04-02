import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function test() {
  try {
    const res = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Say hello" }],
    });
    console.log("SUCCESS:", res.choices[0].message.content);
  } catch (err) {
    console.error("ERROR:", err.message);
  }
}

test();
