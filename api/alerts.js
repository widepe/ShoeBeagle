// /api/alerts.js
// Comprehensive alerts API handling all operations
//
// SECURITY CHANGE (no login, email-link-only access):
// - Listing + managing alerts now requires a signed token `t` (HMAC) that is only sent via email.
// - This prevents anyone from listing/managing alerts just by knowing an email address.
//
// REQUIRED ENV VARS:
// - SENDGRID_API_KEY
// - SENDGRID_ALERTS_EMAIL
// - ALERTS_LINK_SECRET   (long random string; used to sign email links)
//
// OPTIONAL ENV VARS:
// - SITE_BASE_URL (defaults to https://shoebeagle.com)

const { put, list } = require("@vercel/blob");
const sgMail = require("@sendgrid/mail");
const crypto = require("crypto");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const SITE_BASE_URL = (process.env.SITE_BASE_URL || "https://shoebeagle.com").replace(/\/+$/, "");
const LINK_SECRET = process.env.ALERTS_LINK_SECRET || "";

// =====================
// Basic sanitization (keep; still also escape output in HTML)
// =====================
function sanitizeInput(str) {
  return String(str || "")
    .replace(/[<>'"]/g, "")
    .replace(/script/gi, "")
    .trim()
    .slice(0, 100);
}

function formatDateShort(ms) {
  const d = new Date(ms);
  const day = d.getDate();
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mon = months[d.getMonth()];
  const yy = String(d.getFullYear()).slice(-2);
  return `${day}-${mon}-${yy}`;
}

// =====================
// Token helpers (HMAC signed)
// token format: base64url(jsonPayload) + "." + base64url(hmac(payload))
// payload: { email, exp }
// =====================
function b64urlEncode(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(str) {
  const pad = (4 - (str.length % 4)) % 4;
  const b64 = (str + "=".repeat(pad)).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

function signToken(payloadObj) {
  if (!LINK_SECRET) throw new Error("Missing ALERTS_LINK_SECRET");
  const payload = b64urlEncode(JSON.stringify(payloadObj));
  const sig = crypto
    .createHmac("sha256", LINK_SECRET)
    .update(payload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!LINK_SECRET) throw new Error("Missing ALERTS_LINK_SECRET");
  if (!token || typeof token !== "string" || !token.includes(".")) return null;

  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  const expected = crypto
    .createHmac("sha256", LINK_SECRET)
    .update(payload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  // timing-safe compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  let obj;
  try {
    obj = JSON.parse(b64urlDecode(payload));
  } catch {
    return null;
  }

  if (!obj || !obj.email || !obj.exp) return null;
  if (Date.now() > Number(obj.exp)) return null;

  return obj; // { email, exp }
}

// =====================
// (Light) HTML escaping for output insertion
// =====================
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
async function getAlertsBlobUrl() {
  const { blobs } = await list({ prefix: "alerts" }); // broader than "alerts.json"
  if (!blobs || blobs.length === 0) return null;

  // Prefer exact alerts.json
  const exact = blobs.find(b =>
    b.pathname === "alerts.json" || b.pathname.endsWith("/alerts.json")
  );
  if (exact) return exact.url;

  // Fallback: anything that contains alerts.json
  const any = blobs.find(b => String(b.pathname || "").includes("alerts.json"));
  return any ? any.url : null;
}
// =====================
// Confirmation email HTML
// =====================
function generateConfirmationEmail(newAlert, allUserAlerts, manageUrl) {
  const daysLeft = 30;

  const alertsHtml = allUserAlerts.map(alert => {
    const isCancelled = !!alert.cancelledAt;
    const days = Math.max(
      0,
      30 - Math.floor((Date.now() - Number(alert.setAt || 0)) / (1000 * 60 * 60 * 24))
    );

    return `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">${formatDateShort(alert.setAt)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">${escapeHtml(alert.brand)} ${escapeHtml(alert.model)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">$${Math.round(Number(alert.targetPrice || 0))}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">${isCancelled ? "Cancelled" : `${days} days`}</td>
      </tr>
    `;
  }).join("");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4ede3;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: white; border-radius: 10px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
      <div style="text-align: center; margin-bottom: 30px;">
        <img src="https://shoebeagle.com/images/email_logo.png" alt="Shoe Beagle" style="max-width: 300px; height: auto;">
      </div>

      <h1 style="color: #214478; margin: 0 0 20px; font-size: 24px;">✅ Alert Confirmed!</h1>

      <p style="font-size: 16px; line-height: 1.6; color: #333; margin-bottom: 20px;">
        Your price alert has been successfully created:
      </p>

      <div style="background: #f9f9f9; border-left: 4px solid #214478; padding: 15px; margin-bottom: 25px;">
        <p style="margin: 5px 0; font-size: 15px;"><strong>Shoe:</strong> ${escapeHtml(newAlert.brand)} ${escapeHtml(newAlert.model)}</p>
        <p style="margin: 5px 0; font-size: 15px;"><strong>Target Price:</strong> $${Math.round(Number(newAlert.targetPrice || 0))} or less</p>
        <p style="margin: 5px 0; font-size: 15px;"><strong>Duration:</strong> ${daysLeft} days (expires ${new Date(newAlert.setAt + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()})</p>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #333; margin-bottom: 25px;">
        We'll search daily for deals matching your criteria. When we find your shoes at or below $${Math.round(Number(newAlert.targetPrice || 0))},
        you'll be notified immediately!
      </p>

      ${allUserAlerts.length > 1 ? `
      <h2 style="color: #214478; font-size: 18px; margin-top: 30px; margin-bottom: 15px;">Your Alerts</h2>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;">
        <thead>
          <tr style="background: #f4ede3;">
            <th style="padding: 10px; text-align: left; border-bottom: 2px solid #214478;">Date Set</th>
            <th style="padding: 10px; text-align: left; border-bottom: 2px solid #214478;">Shoe</th>
            <th style="padding: 10px; text-align: right; border-bottom: 2px solid #214478;">Price</th>
            <th style="padding: 10px; text-align: center; border-bottom: 2px solid #214478;">Time Left</th>
          </tr>
        </thead>
        <tbody>
          ${alertsHtml}
        </tbody>
      </table>
      ` : ""}

      <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd;">
        <p style="font-size: 14px; color: #666; margin-bottom: 15px;">
          <strong>Save this email to manage or cancel alerts.</strong>
        </p>
        <a href="${manageUrl}"
           style="display: inline-block; padding: 12px 30px; background: #214478; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
          Manage Alerts
        </a>
      </div>

      <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666;">
        <p style="margin: 5px 0;">This alert will remain active for 30 days or until cancelled.</p>
        <p style="margin: 5px 0;">You can have up to 5 active alerts at a time.</p>
        <p style="margin: 15px 0 5px;"><strong>Privacy:</strong> Your email is never sold or shared by Shoe Beagle.</p>
        <p style="margin: 5px 0;">Questions? Visit <a href="https://shoebeagle.com" style="color: #214478;">shoebeagle.com</a></p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();
}

// ============================================================================
// MAIN HANDLER - Routes based on HTTP method and action parameter
// ============================================================================
module.exports = async (req, res) => {
  try {
    // GET request = LIST alerts (token-only)
    if (req.method === "GET") {
      return await handleList(req, res);
    }

    // POST request = CREATE or MANAGE (cancel/update/remove)
    if (req.method === "POST") {
      const { action } = req.body || {};

      // If no action specified, assume CREATE
      if (!action) {
        return await handleCreate(req, res);
      }

      // Otherwise, handle manage operations
      return await handleManage(req, res);
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (error) {
    console.error("[ALERTS API] Error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ============================================================================
// LIST ALERTS (token-only)
// GET /api/alerts?t=TOKEN
// ============================================================================
async function handleList(req, res) {
  const { t } = req.query || {};

  const tok = verifyToken(String(t || ""));
  if (!tok) {
    return res.status(401).json({ error: "Invalid or expired link" });
  }

  const cleanEmail = String(tok.email).trim().toLowerCase();

  // Load alerts from blob
const url = await getAlertsBlobUrl();
if (!url) {
  return res.status(200).json({ success: true, alerts: [], count: 0 });
}

const response = await fetch(url);

  const data = await response.json();
  const alerts = Array.isArray(data.alerts) ? data.alerts : [];

  // Filter by email and sort by date (newest first)
  const userAlerts = alerts
    .filter(a => a.email === cleanEmail)
    .sort((a, b) => Number(b.setAt || 0) - Number(a.setAt || 0));

  return res.status(200).json({
    success: true,
    alerts: userAlerts,
    count: userAlerts.length
  });
}

// ============================================================================
// CREATE ALERT
// ============================================================================
async function handleCreate(req, res) {
  const { email, brand, model, targetPrice, gender } = req.body || {};

  // Validation
  if (!email || !String(email).includes("@")) {
    return res.status(400).json({ error: "Valid email address is required" });
  }

  if (!brand || !model) {
    return res.status(400).json({ error: "Brand and model are required" });
  }

  const price = parseInt(targetPrice, 10);
  if (!price || price <= 0) {
    return res.status(400).json({ error: "Valid target price is required" });
  }

  const cleanEmail = sanitizeInput(email).toLowerCase();
  const cleanBrand = sanitizeInput(brand);
  const cleanModel = sanitizeInput(model);
  const cleanGender = sanitizeInput(gender);

  // Load existing alerts
  let alerts = [];
  try {
    const url = await getAlertsBlobUrl();
if (!url) return res.status(404).json({ error: "No alerts found" });

const response = await fetch(url);
const data = await response.json();
alerts = Array.isArray(data.alerts) ? data.alerts : [];

  } catch (err) {
    console.log("No existing alerts file, creating new one");
  }

  // Check limit: max 5 active alerts per email
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const userActiveAlerts = alerts.filter(a =>
    a.email === cleanEmail &&
    !a.cancelledAt &&
    (Number(a.setAt || 0) + TTL_MS) > Date.now()
  );

  if (userActiveAlerts.length >= 7) {
    return res.status(429).json({
      error: "Maximum 7 active alerts per email. Please cancel an existing alert first.",
      currentCount: userActiveAlerts.length
    });
  }

  // Create new alert
const newAlert = {
  id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
  email: cleanEmail,
  brand: cleanBrand,
  model: cleanModel,
  gender: cleanGender || "both",
  targetPrice: price,
  setAt: Date.now(),
  cancelledAt: null,
  lastNotifiedAt: null
};


  alerts.push(newAlert);

  // Save to blob
  await put(
    "alerts.json",
    JSON.stringify({ alerts, lastUpdated: new Date().toISOString() }),
    { access: "public", addRandomSuffix: false }
  );

  // Build signed manage link (valid for 30 days)
  let manageUrl = `${SITE_BASE_URL}/pages/cancel_alert.html`;
  try {
    const exp = Date.now() + TTL_MS;
    const token = signToken({ email: cleanEmail, exp });
    manageUrl = `${SITE_BASE_URL}/pages/cancel_alert.html?t=${encodeURIComponent(token)}`;
  } catch (e) {
    // If token signing fails (missing secret), keep a safe fallback (no email param).
    console.error("[ALERT CREATE] Failed to sign manage token:", e);
  }

  // Get all user's alerts for confirmation email (include all not-cancelled; page can show status)
  const allUserAlerts = alerts.filter(a => a.email === cleanEmail && !a.cancelledAt);

  // Send confirmation email
  try {
    const emailHtml = generateConfirmationEmail(newAlert, allUserAlerts, manageUrl);

    await sgMail.send({
      to: cleanEmail,
      from: process.env.SENDGRID_ALERTS_EMAIL,
      subject: `✅ Alert Confirmed: ${cleanBrand} ${cleanModel}`,
      html: emailHtml
    });

    console.log(`[ALERT CREATE] Alert created and confirmation sent to ${cleanEmail}`);
  } catch (emailError) {
    console.error("[ALERT CREATE] Email failed but alert was saved:", emailError);
    // Don't fail the request if email fails
  }

  return res.status(200).json({
    success: true,
    alert: newAlert,
    message: "Alert created! Check your email for confirmation."
  });
}

// ============================================================================
// MANAGE ALERTS (Cancel, Update, Remove) - token-only
// POST /api/alerts  body: { action, alertId, targetPrice?, t }
// ============================================================================
async function handleManage(req, res) {
  const { action, alertId, targetPrice, t } = req.body || {};

  // Validation
  if (!action || !alertId || !t) {
    return res.status(400).json({ error: "Action, alert ID, and token are required" });
  }

  const tok = verifyToken(String(t || ""));
  if (!tok) {
    return res.status(401).json({ error: "Invalid or expired link" });
  }

  const cleanEmail = String(tok.email).trim().toLowerCase();

  // Load existing alerts
  let alerts = [];
  try {
    const { blobs } = await list({ prefix: "alerts.json" });
    if (blobs && blobs.length > 0) {
      const response = await fetch(blobs[0].url);
      const data = await response.json();
      alerts = Array.isArray(data.alerts) ? data.alerts : [];
    }
  } catch (err) {
    return res.status(404).json({ error: "No alerts found" });
  }

  // Find the alert
  const alertIndex = alerts.findIndex(a =>
    a.id === alertId &&
    a.email === cleanEmail
  );

  if (alertIndex === -1) {
    return res.status(404).json({ error: "Alert not found" });
  }

  const alert = alerts[alertIndex];

  // Handle different actions
  switch (action) {
    case "cancel": {
      if (alert.cancelledAt) {
        return res.status(400).json({ error: "Alert is already cancelled" });
      }

      alerts[alertIndex] = {
        ...alert,
        cancelledAt: Date.now()
      };

      await put(
        "alerts.json",
        JSON.stringify({ alerts, lastUpdated: new Date().toISOString() }),
        { access: "public", addRandomSuffix: false }
      );

      console.log(`[ALERT CANCEL] Alert ${alertId} cancelled for ${cleanEmail}`);

      return res.status(200).json({
        success: true,
        message: "Alert cancelled successfully"
      });
    }

    case "update": {
      const price = parseInt(targetPrice, 10);
      if (!price || price <= 0) {
        return res.status(400).json({ error: "Valid target price is required" });
      }

      if (alert.cancelledAt) {
        return res.status(400).json({ error: "Cannot update a cancelled alert" });
      }

      const ageDays = Math.floor((Date.now() - Number(alert.setAt || 0)) / (1000 * 60 * 60 * 24));
      if (ageDays >= 30) {
        return res.status(400).json({ error: "Cannot update an expired alert" });
      }

      alerts[alertIndex] = {
        ...alert,
        targetPrice: price,
        setAt: Date.now(), // Reset the timer
        lastNotifiedAt: null
      };

      await put(
        "alerts.json",
        JSON.stringify({ alerts, lastUpdated: new Date().toISOString() }),
        { access: "public", addRandomSuffix: false }
      );

      console.log(`[ALERT UPDATE] Alert ${alertId} updated for ${cleanEmail}: $${price}`);

      return res.status(200).json({
        success: true,
        alert: alerts[alertIndex],
        message: "Alert updated and reset to 30 days"
      });
    }

    case "remove": {
      const isCancelled = !!alert.cancelledAt;
      const ageInDays = Math.floor((Date.now() - Number(alert.setAt || 0)) / (1000 * 60 * 60 * 24));
      const isExpired = ageInDays >= 30;

      if (!isCancelled && !isExpired) {
        return res.status(400).json({ error: "Can only remove inactive (cancelled or expired) alerts" });
      }

      alerts.splice(alertIndex, 1);

      await put(
        "alerts.json",
        JSON.stringify({ alerts, lastUpdated: new Date().toISOString() }),
        { access: "public", addRandomSuffix: false }
      );

      console.log(`[ALERT REMOVE] Alert ${alertId} removed for ${cleanEmail}`);

      return res.status(200).json({
        success: true,
        message: "Alert removed successfully"
      });
    }

    default:
      return res.status(400).json({ error: "Invalid action. Use 'cancel', 'update', or 'remove'" });
  }
}
