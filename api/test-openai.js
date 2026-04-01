import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function test() {
  try {
    const res = await client.responses.create({
      model: "gpt-5.3",
      input: "Say hello",
    });

    console.log("SUCCESS:", res.output[0].content[0].text);
  } catch (err) {
    console.error("ERROR:", err.message);
  }
}

test();
