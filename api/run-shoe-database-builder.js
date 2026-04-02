import { runShoeResearchJob } from "../shoe_database_builder/runShoeResearchJob.js";

export default async function handler(req, res) {
  try {
    const limitRaw = req.query?.limit;
    const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 2;

    const result = await runShoeResearchJob(limit);

    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || "Unknown error",
    });
  }
}
