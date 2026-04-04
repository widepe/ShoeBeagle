export default async function handler(req, res) {
  console.log("HANDLER_START", {
    method: req?.method || null,
    url: req?.url || null,
    query: req?.query || null,
  });

  try {
    const limitRaw = req.query?.limit;
    const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 2;

    console.log("HANDLER_AFTER_LIMIT", {
      limitRaw,
      limit,
    });

    let runShoeResearchJob;
    try {
      console.log("HANDLER_BEFORE_IMPORT");

      const mod = await import("../shoe_database_builder/runShoeResearchJob.js");
      runShoeResearchJob = mod.runShoeResearchJob;

      console.log("HANDLER_AFTER_IMPORT", {
        hasRunShoeResearchJob: typeof runShoeResearchJob === "function",
      });
    } catch (error) {
      console.log("HANDLER_IMPORT_ERROR", {
        error: error?.message || "Failed importing runShoeResearchJob.js",
        stack: error?.stack || null,
      });

      return res.status(500).json({
        ok: false,
        stage: "import_runShoeResearchJob",
        error: error?.message || "Failed importing runShoeResearchJob.js",
        stack: error?.stack || null,
      });
    }

    try {
      console.log("HANDLER_BEFORE_RUN_JOB", {
        limit,
      });

      const result = await runShoeResearchJob(limit);

      console.log("HANDLER_AFTER_RUN_JOB", {
        ok: result?.ok ?? null,
        processed: result?.processed ?? null,
        inserted: result?.inserted ?? null,
        skipped: result?.skipped ?? null,
        errors: result?.errors ?? null,
      });

      return res.status(200).json(result);
    } catch (error) {
      console.log("HANDLER_RUN_JOB_ERROR", {
        error: error?.message || "Job failed",
        stack: error?.stack || null,
      });

      return res.status(500).json({
        ok: false,
        stage: "run_job",
        error: error?.message || "Job failed",
        stack: error?.stack || null,
      });
    }
  } catch (error) {
    console.log("HANDLER_FATAL_ERROR", {
      error: error?.message || "Unknown error",
      stack: error?.stack || null,
    });

    return res.status(500).json({
      ok: false,
      stage: "api_handler",
      error: error?.message || "Unknown error",
      stack: error?.stack || null,
    });
  }
}
