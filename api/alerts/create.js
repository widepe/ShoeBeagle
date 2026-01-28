// /api/alerts/create.js
const { put, list } = require("@vercel/blob");
const sgMail = require("@sendgrid/mail");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

function sanitizeInput(str) {
  return String(str || "")
    .replace(/[<>'"]/g, '')
    .replace(/script/gi, '')
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

function generateConfirmationEmail(newAlert, allUserAlerts) {
  const daysLeft = 30;
  const alertsHtml = allUserAlerts.map(alert => `
    <tr>
      <td style="padding: 8px; border-bottom: 1px solid #ddd;">${formatDateShort(alert.setAt)}</td>
      <td style="padding: 8px; border-bottom: 1px solid #ddd;">${alert.brand} ${alert.model}</td>
      <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">$${Math.round(alert.targetPrice)}</td>
      <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">${alert.cancelledAt ? 'Cancelled' : `${Math.max(0, 30 - Math.floor((Date.now() - alert.setAt) / (1000 * 60 * 60 * 24)))} days`}</td>
    </tr>
  `).join('');

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
        <p style="margin: 5px 0; font-size: 15px;"><strong>Shoe:</strong> ${newAlert.brand} ${newAlert.model}</p>
        <p style="margin: 5px 0; font-size: 15px;"><strong>Target Price:</strong> $${Math.round(newAlert.targetPrice)} or less</p>
        <p style="margin: 5px 0; font-size: 15px;"><strong>Duration:</strong> ${daysLeft} days (expires ${new Date(newAlert.setAt + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()})</p>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #333; margin-bottom: 25px;">
        We'll search daily for deals matching your criteria. When we find your shoes at or below $${Math.round(newAlert.targetPrice)}, 
        you'll be notified immediately!
      </p>

      ${allUserAlerts.length > 1 ? `
      <h2 style="color: #214478; font-size: 18px; margin-top: 30px; margin-bottom: 15px;">Your Active Alerts</h2>
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
      ` : ''}

      <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd;">
        <p style="font-size: 14px; color: #666; margin-bottom: 15px;">
          <strong>Save this email to manage or cancel alerts.</strong>
        </p>
        <a href="https://shoebeagle.com/pages/myalerts.html?email=${encodeURIComponent(newAlert.email)}" 
           style="display: inline-block; padding: 12px 30px; background: #214478; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
          Manage Alerts
        </a>
      </div>

      <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666;">
        <p style="margin: 5px 0;">Your alert will remain active for 30 days or until cancelled.</p>
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

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email, brand, model, targetPrice } = req.body;

    // Validation
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: "Valid email address is required" });
    }

    if (!brand || !model) {
      return res.status(400).json({ error: "Brand and model are required" });
    }

    const price = parseInt(targetPrice);
    if (!price || price <= 0) {
      return res.status(400).json({ error: "Valid target price is required" });
    }

    const cleanEmail = sanitizeInput(email).toLowerCase();
    const cleanBrand = sanitizeInput(brand);
    const cleanModel = sanitizeInput(model);

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
      console.log("No existing alerts file, creating new one");
    }

    // Check limit: max 5 active alerts per email
    const userActiveAlerts = alerts.filter(a => 
      a.email === cleanEmail && 
      !a.cancelledAt && 
      (a.setAt + 30 * 24 * 60 * 60 * 1000) > Date.now()
    );

    if (userActiveAlerts.length >= 5) {
      return res.status(429).json({ 
        error: "Maximum 5 active alerts per email. Please cancel an existing alert first.",
        currentCount: userActiveAlerts.length
      });
    }

    // Create new alert
    const newAlert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      email: cleanEmail,
      brand: cleanBrand,
      model: cleanModel,
      targetPrice: price,
      setAt: Date.now(),
      cancelledAt: null,
      lastNotifiedAt: null
    };

    alerts.push(newAlert);

    // Save to blob
    await put("alerts.json", JSON.stringify({ alerts, lastUpdated: new Date().toISOString() }), {
      access: "public",
      addRandomSuffix: false
    });

    // Get all user's alerts for confirmation email
    const allUserAlerts = alerts.filter(a => a.email === cleanEmail && !a.cancelledAt);

    // Send confirmation email
    try {
      const emailHtml = generateConfirmationEmail(newAlert, allUserAlerts);
      
      await sgMail.send({
        to: cleanEmail,
        from: process.env.SENDGRID_FROM_EMAIL,
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

  } catch (error) {
    console.error("[ALERT CREATE] Error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
