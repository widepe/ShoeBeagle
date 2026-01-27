// /api/alerts/cancel.js
const { put, list } = require("@vercel/blob");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { alertId, email } = req.body;

    if (!alertId || !email) {
      return res.status(400).json({ error: "Alert ID and email are required" });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Load alerts
    const { blobs } = await list({ prefix: "alerts.json" });
    
    if (!blobs || blobs.length === 0) {
      return res.status(404).json({ error: "No alerts found" });
    }

    const response = await fetch(blobs[0].url);
    const data = await response.json();
    let alerts = Array.isArray(data.alerts) ? data.alerts : [];

    // Find and cancel the alert
    const alertIndex = alerts.findIndex(a => a.id === alertId && a.email === cleanEmail);
    
    if (alertIndex === -1) {
      return res.status(404).json({ error: "Alert not found or unauthorized" });
    }

    alerts[alertIndex].cancelledAt = Date.now();

    // Save back to blob
    await put("alerts.json", JSON.stringify({ alerts, lastUpdated: new Date().toISOString() }), {
      access: "public",
      addRandomSuffix: false
    });

    console.log(`[ALERT CANCEL] Alert ${alertId} cancelled for ${cleanEmail}`);

    return res.status(200).json({
      success: true,
      message: "Alert cancelled successfully"
    });

  } catch (error) {
    console.error("[ALERT CANCEL] Error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
