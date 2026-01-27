// /api/alerts/list.js
const { list } = require("@vercel/blob");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ error: "Email parameter is required" });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Load alerts from blob
    const { blobs } = await list({ prefix: "alerts.json" });
    
    if (!blobs || blobs.length === 0) {
      return res.status(200).json({ success: true, alerts: [] });
    }

    const response = await fetch(blobs[0].url);
    const data = await response.json();
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];

    // Filter by email and sort by date (newest first)
    const userAlerts = alerts
      .filter(a => a.email === cleanEmail)
      .sort((a, b) => b.setAt - a.setAt);

    return res.status(200).json({
      success: true,
      alerts: userAlerts,
      count: userAlerts.length
    });

  } catch (error) {
    console.error("[ALERT LIST] Error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
