// /api/blob-smoke-test.js
const { put } = require("@vercel/blob");

module.exports = async function handler(req, res) {
  try {
    const payload = {
      meta: {
        purpose: "blob smoke test",
        wroteAt: new Date().toISOString(),
      },
      ok: true,
    };

    const blobRes = await put("kohls.json", JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    res.status(200).json({ ok: true, blobUrl: blobRes.url });
  } catch (err) {
    console.error("blob smoke test failed:", err);
    res.status(500).json({
      ok: false,
      error: String(err && err.message ? err.message : err),
      hasToken: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    });
  }
};
