import { runShoeResearchJob } from "../shoe_database_builder/runShoeResearchJob.js";

export default async function handler(req, res) {
  try {
    const limitRaw = req.query?.limit;
    const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 2;

    let runShoeResearchJob;
    try {
      const mod = await import("../shoe_database_builder/runShoeResearchJob.js");
      runShoeResearchJob = mod.runShoeResearchJob;
    } catch (error) {
      return res.status(500).json({
        ok: false,
        stage: "import_runShoeResearchJob",
        error: error?.message || "Failed importing runShoeResearchJob.js",
        stack: error?.stack || null,
      });
    }

    try {
      const result = await runShoeResearchJob(limit);
      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({
        ok: false,
        stage: "run_job",
        error: error?.message || "Job failed",
        stack: error?.stack || null,
      });
    }
  } catch (error) {
    return res.status(500).json({
      ok: false,
      stage: "api_handler",
      error: error?.message || "Unknown error",
      stack: error?.stack || null,
    });
  }
}
