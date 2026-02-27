// /api/cron/check-alerts.js
//
// Checks active price alerts against cached deals (deals.json) and emails matches.
//
// DEAL SCHEMA (per your blob):
//   brand, model, salePrice, originalPrice, discountPercent, store,
//   listingURL, imageURL, gender, shoeType
//
// ALERT SCHEMA (expected):
//   id, email, brand, model, targetPrice, setAt (ms or ISO),
//   cancelledAt?, lastNotifiedAt?
//
// Notes:
// - Matching is brand/model fuzzy-ish (token prefix + squashed fallback)
// - Price match uses salePrice <= targetPrice
// - Email shows salePrice + strikethrough originalPrice (when original > sale)
// - Email footer includes: "This is an automated email..." line
// - Images are displayed in a 4:3 container (240x180) without warping (object-fit: contain)
//
// SECURITY / UX UPDATE:
// - "Manage Alerts" button now uses a signed token link (no ?email=).
// - Requires env var ALERTS_LINK_SECRET (same one you already created).
//
// REQUIRED ENV VARS:
// - SENDGRID_API_KEY
// - ALERTS_LINK_SECRET
// - CRON_SECRET (if you lock down cron)
// - SENDGRID_ALERTS_EMAIL (recommended; falls back to SENDGRID_FROM_EMAIL if present)
//
// OPTIONAL ENV VARS:
// - SITE_BASE_URL (defaults to https://shoebeagle.com)

const { list, put } = require("@vercel/blob");
const sgMail = require("@sendgrid/mail");
const crypto = require("crypto");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const SITE_BASE_URL = (process.env.SITE_BASE_URL || "https://shoebeagle.com").replace(/\/+$/, "");
const LINK_SECRET = process.env.ALERTS_LINK_SECRET || "";

// -----------------------------
// Token helpers (HMAC signed)
// token format: base64url(jsonPayload) + "." + base64url(hmac(payload))
// payload: { email, exp }
// -----------------------------
function b64urlEncode(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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

// -----------------------------
// Helpers
// -----------------------------
function normalizeStr(s) {
  return String(s || "").trim().toLowerCase();
}

function tokenize(s) {
  return normalizeStr(s)
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean);
}

function squash(s) {
  return normalizeStr(s).replace(/\s+/g, "");
}

function toNumber(val) {
  if (val === null || val === undefined) return NaN;
  const n = Number(String(val).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function toMs(val) {
  if (typeof val === "number") return val;
  const ms = Date.parse(val);
  return Number.isFinite(ms) ? ms : NaN;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function money(n) {
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

function safeUrl(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return "";
  return s;
}

// -----------------------------
// Matching (brand/model + price)
// -----------------------------
function dealMatchesAlert(deal, alert) {
  const dealBrandTokens = tokenize(deal.brand || "");
  const dealModelTokens = tokenize(deal.model || "");
  const dealSquashed = squash(`${deal.brand || ""} ${deal.model || ""}`);

  const alertBrandTokens = tokenize(alert.brand || "");
  const alertModelTokens = tokenize(alert.model || "");
  const alertSquashed = squash(`${alert.brand || ""} ${alert.model || ""}`);

  // Brand matching
  let brandMatches = true;
  if (alertBrandTokens.length > 0) {
    brandMatches = alertBrandTokens.some((token) =>
      dealBrandTokens.some((dt) => dt.startsWith(token) || token.startsWith(dt))
    );
  }

  // Model matching
  let modelMatches = true;
  if (alertModelTokens.length > 0) {
    modelMatches = alertModelTokens.some((token) =>
      dealModelTokens.some((dt) => dt.startsWith(token) || token.startsWith(dt))
    );

    // Squashed fallback for "gt2000" vs "GT-2000"
    if (!modelMatches && alertSquashed.length >= 4 && dealSquashed.length >= 4) {
      modelMatches = dealSquashed.includes(alertSquashed) || alertSquashed.includes(dealSquashed);
    }
  }

  // Price matching (salePrice vs targetPrice)
  const dealPrice = toNumber(deal.salePrice);
  const targetPrice = toNumber(alert.targetPrice);
  const priceMatches =
    Number.isFinite(dealPrice) && Number.isFinite(targetPrice) && dealPrice <= targetPrice;

  return brandMatches && modelMatches && priceMatches;
}

// -----------------------------
// Email generation
// -----------------------------
function formatActiveText(daysLeft) {
  return daysLeft > 0
    ? `for the next ${daysLeft} day${daysLeft === 1 ? "" : "s"}`
    : "until the end of today";
}

function buildManageAlertsUrl(email) {
  // Token valid for 30 days from send time
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const base = `${SITE_BASE_URL}/pages/cancel_alert.html`;

  try {
    const cleanEmail = normalizeStr(email);
    const exp = Date.now() + TTL_MS;
    const token = signToken({ email: cleanEmail, exp });
    return `${base}?t=${encodeURIComponent(token)}`;
  } catch (e) {
    console.error("[CRON] Failed to sign manage token:", e);
    // Safe fallback: no email leak; page will show "invalid/missing link"
    return base;
  }
}

function generateMatchEmail(alert, matches, daysLeft) {
  const sorted = [...matches].sort((a, b) => toNumber(a.salePrice) - toNumber(b.salePrice));
  const topDeals = sorted.slice(0, 12);

  const dealsHtml = topDeals
    .map((deal) => {
      const sale = toNumber(deal.salePrice);
      const original = toNumber(deal.originalPrice);
      const showOriginal =
        Number.isFinite(original) && Number.isFinite(sale) && original > sale;

      const brand = escapeHtml(deal.brand || "");
      const model = escapeHtml(deal.model || "");
      const store = escapeHtml(deal.store || "");

      const img = safeUrl(deal.imageURL);
      const url = safeUrl(deal.listingURL);

      return `
        <div style="border:1px solid #ddd; border-radius:12px; padding:16px; margin-bottom:16px; background:#f9f9f9;">

          <div style="
            width:240px;
            height:180px; /* 4:3 */
            background:#ffffff;
            display:flex;
            align-items:center;
            justify-content:center;
            margin:0 0 12px 0;
            border-radius:8px;
            overflow:hidden;
          ">
            ${
              img
                ? `<img src="${img}" alt="${brand} ${model}" style="max-width:100%; max-height:100%; object-fit:contain; display:block; border:0;" />`
                : ""
            }
          </div>

          <h3 style="margin:0 0 8px; color:#214478; font-size:16px;">
            ${brand} ${model}
          </h3>

          <p style="margin:4px 0; font-size:14px;">
            <strong>Store:</strong> ${store}
          </p>

          <p style="margin:6px 0; font-size:14px;">
            <strong>Price:</strong>
            <span style="color:#dc3545; font-size:18px; font-weight:bold;">
              $${money(sale)}
            </span>
            ${
              showOriginal
                ? `<span style="text-decoration:line-through; color:#999; margin-left:8px;">
                     $${money(original)}
                   </span>`
                : ""
            }
          </p>

          ${
            url
              ? `<a href="${url}"
                   style="display:inline-block; margin-top:10px; padding:10px 18px;
                          background:#214478; color:#fff; text-decoration:none;
                          border-radius:8px; font-size:14px;">
                  View Deal
                </a>`
              : ""
          }
        </div>
      `;
    })
    .join("");

  const activeText = formatActiveText(daysLeft);

  const alertBrand = escapeHtml(alert.brand || "");
  const alertModel = escapeHtml(alert.model || "");
  const manageUrl = buildManageAlertsUrl(alert.email);

  return `
<!DOCTYPE html>
<html>
<body style="margin:0; padding:0; font-family:Arial,sans-serif; background:#f4ede3;">
  <div style="max-width:600px; margin:0 auto; padding:20px;">
    <div style="background:#fff; border-radius:12px; padding:28px;">

      <div style="text-align:center; margin-bottom:22px;">
        <a href="${SITE_BASE_URL}">
          <img src="${SITE_BASE_URL}/images/email_logo.png"
               alt="Shoe Beagle"
               style="max-width:300px; height:auto; border:0;" />
        </a>
      </div>

      <h1 style="color:#214478; font-size:24px; margin:0 0 12px;">
        Great News! Marty Found Your Shoes!
      </h1>

      <p style="font-size:16px; line-height:1.6; margin:0 0 18px;">
        We have <strong>${matches.length}</strong> deal${matches.length === 1 ? "" : "s"} for
        <strong>${alertBrand} ${alertModel}</strong> at or below your target price.
      </p>

      <h2 style="color:#214478; font-size:18px; margin:18px 0 12px;">
        Top Deals
      </h2>

      ${dealsHtml}

      <div style="margin-top:22px; padding:16px; background:#f4ede3; border-radius:10px;">
        <p style="margin:0; font-size:14px;">
          <strong>Your alert will remain active ${activeText}</strong>.
          If we find more matches, we’ll send another update.
        </p>
      </div>

      <!-- Buttons (match confirmation email vibe) -->
      <div style="margin-top:24px; padding-top:18px; border-top:1px solid #ddd; text-align:center;">
        <p style="font-size:14px; color:#666; margin:0 0 14px;">
          <strong>Manage or cancel alerts using your secure link:</strong>
        </p>

        <a href="${manageUrl}"
           style="display:inline-block; padding:12px 30px; background:#214478; color:#fff;
                  text-decoration:none; border-radius:8px; font-size:14px; font-weight:bold;">
          Manage Alerts
        </a>

        <div style="height:12px;"></div>

        <a href="${SITE_BASE_URL}"
           style="display:inline-block; padding:12px 30px; background:#28a745; color:#fff;
                  text-decoration:none; border-radius:8px; font-size:14px; font-weight:bold;">
          Search for More Deals
        </a>
      </div>

      <div style="margin-top:22px; font-size:12px; color:#666; border-top:1px solid #ddd; padding-top:16px;">
        <p style="margin:0 0 6px;">
          This is an automated email from Shoe Beagle. Replies to this address aren’t monitored.
        </p>
        <p style="margin:0;">
          Shoe Beagle does not sell products directly and is not responsible for retailer pricing or availability.
        </p>
      </div>

    </div>
  </div>
</body>
</html>
`.trim();
}

// -----------------------------
// Handler
// -----------------------------
module.exports = async (req, res) => {
  // Verify cron secret
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log("[CRON] Unauthorized request");
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("[CRON] Starting alert check...", new Date().toISOString());
  const startTime = Date.now();

  try {
    // Load deals.json
    console.log("[CRON] Loading deals...");
    const { blobs: dealBlobs } = await list({ prefix: "deals.json" });
    if (!dealBlobs || dealBlobs.length === 0) throw new Error("Could not locate deals.json");

    const dealBlob = dealBlobs.find((b) => b.pathname === "deals.json") || dealBlobs[0];

    const dealsResponse = await fetch(dealBlob.url);
    if (!dealsResponse.ok) {
      throw new Error(`Failed to fetch deals.json (${dealsResponse.status})`);
    }

    const dealsData = await dealsResponse.json();
    const deals = Array.isArray(dealsData.deals) ? dealsData.deals : [];
    console.log(`[CRON] Loaded ${deals.length} deals`);

    // Load alerts.json
    console.log("[CRON] Loading alerts...");
    const { blobs: alertBlobs } = await list({ prefix: "alerts.json" });

    if (!alertBlobs || alertBlobs.length === 0) {
      console.log("[CRON] No alerts file found");
      return res.status(200).json({
        success: true,
        message: "No alerts to check",
        alertsChecked: 0,
        emailsSent: 0,
      });
    }

    const alertBlob = alertBlobs.find((b) => b.pathname === "alerts.json") || alertBlobs[0];

    const alertsResponse = await fetch(alertBlob.url);
    if (!alertsResponse.ok) {
      throw new Error(`Failed to fetch alerts.json (${alertsResponse.status})`);
    }

    const alertsData = await alertsResponse.json();
    let alerts = Array.isArray(alertsData.alerts) ? alertsData.alerts : [];

    // Filter active alerts only (not cancelled, not expired)
    const now = Date.now();
    const activeAlerts = alerts.filter((a) => {
      if (a.cancelledAt) return false;
      const setAtMs = toMs(a.setAt);
      if (!Number.isFinite(setAtMs)) return false;
      return setAtMs + 30 * 24 * 60 * 60 * 1000 > now;
    });

    console.log(`[CRON] Found ${activeAlerts.length} active alerts`);

    if (activeAlerts.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No active alerts",
        alertsChecked: 0,
        emailsSent: 0,
      });
    }

    let emailsSent = 0;
    let alertsUpdated = false;

    for (const alert of activeAlerts) {
      const brand = alert.brand || "";
      const model = alert.model || "";
      console.log(`[CRON] Checking alert ${alert.id} for ${brand} ${model}`.trim());

      const matches = deals.filter((deal) => dealMatchesAlert(deal, alert));
      if (matches.length === 0) continue;

      console.log(`[CRON] Found ${matches.length} matches for alert ${alert.id}`);

      // Only email once per 24h per alert
      const lastNotifiedMs = toMs(alert.lastNotifiedAt);
      const lastNotified = Number.isFinite(lastNotifiedMs) ? lastNotifiedMs : 0;
      const hoursSince = (now - lastNotified) / (1000 * 60 * 60);

      if (alert.lastNotifiedAt && hoursSince < 24) {
        console.log(
          `[CRON] Skipping alert ${alert.id} (last notified ${hoursSince.toFixed(1)}h ago)`
        );
        continue;
      }

      try {
        const setAtMs = toMs(alert.setAt);
        const ageDays = Number.isFinite(setAtMs)
          ? Math.floor((now - setAtMs) / (1000 * 60 * 60 * 24))
          : 0;

        const daysLeft = Math.max(0, 30 - ageDays);
        const emailHtml = generateMatchEmail(alert, matches, daysLeft);

        const fromEmail =
          process.env.SENDGRID_ALERTS_EMAIL ||
          process.env.SENDGRID_FROM_EMAIL;

        if (!fromEmail) {
          throw new Error("Missing SENDGRID_ALERTS_EMAIL (or SENDGRID_FROM_EMAIL)");
        }

        await sgMail.send({
          to: alert.email,
          from: fromEmail,
          subject: `🎉 ${matches.length} Deal${matches.length === 1 ? "" : "s"} Found: ${brand} ${model}`.trim(),
          html: emailHtml,
        });

        // Update lastNotifiedAt in the full alerts array
        const idx = alerts.findIndex((a) => a.id === alert.id);
        if (idx >= 0) {
          alerts[idx].lastNotifiedAt = now;
          alertsUpdated = true;
        }

        emailsSent++;
        console.log(`[CRON] Email sent to ${alert.email}`);
      } catch (emailError) {
        console.error(`[CRON] Failed to send email for alert ${alert.id}:`, emailError);
      }
    }

    // Save updated alerts if any were notified
    if (alertsUpdated) {
      await put(
        "alerts.json",
        JSON.stringify({ alerts, lastUpdated: new Date().toISOString() }),
        { access: "public", addRandomSuffix: false }
      );
      console.log("[CRON] Updated alerts.json with notification timestamps");
    }

    const duration = Date.now() - startTime;
    console.log(`[CRON] Check complete in ${duration}ms`);
    console.log(`[CRON] Alerts checked: ${activeAlerts.length}, Emails sent: ${emailsSent}`);

    return res.status(200).json({
      success: true,
      message: "Alert check completed",
      alertsChecked: activeAlerts.length,
      emailsSent,
      duration,
    });
  } catch (error) {
    console.error("[CRON] Error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};
