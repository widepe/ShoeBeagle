import fs from "fs/promises";
import path from "path";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const filePath = path.join(process.cwd(), "lib", "canonical-stores.json");
    const raw = await fs.readFile(filePath, "utf8");
    const stores = JSON.parse(raw);

    if (!Array.isArray(stores)) {
      return res.status(500).json({ ok: false, error: "canonical-stores.json must be an array" });
    }

    return res.status(200).json(stores);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to load stores" });
  }
}
