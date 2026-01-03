module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body =
      typeof req.body === "object"
        ? req.body
        : JSON.parse(req.body || "{}");

    console.log("[/api/click] click", {
      title: body.title,
      store: body.store,
      url: body.url,
      at: new Date().toISOString()
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[/api/click] error", e?.message || String(e));
    return res.status(200).json({ ok: false });
  }
};
