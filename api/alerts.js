// api/alerts.js
// Vercel serverless function for Shoe Beagle price alerts.
// Sends an email via SendGrid, and optionally an SMS via Twilio
// (if you choose to set that up).

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

// Optional Twilio SMS (only used if you set these in Vercel)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

// Helper to read JSON body in a Vercel Node handler
async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  console.log('[/api/alerts] hit with method:', req.method);

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  }

  if (!SENDGRID_API_KEY) {
    console.error('Missing SENDGRID_API_KEY env var');
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Missing SENDGRID_API_KEY' }));
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    console.error('Error parsing JSON body:', err);
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }

  const { product, targetPrice, email, phone } = body || {};
  const to = email || phone; // email preferred; phone used for SMS if set up

  console.log('Alert payload:', { product, targetPrice, email, phone });

  if (!to || !product || !targetPrice) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Missing required fields' }));
  }

  const numericPrice = Number(targetPrice);
  const priceDisplay = Number.isFinite(numericPrice)
    ? numericPrice.toFixed(2)
    : String(targetPrice);

  // Plain-text version (fallback + good for spam filters)
  const plainText = [
    `Thanks for setting a price alert at Shoe Beagle!`,
    ``,
    `Product: ${product}`,
    `Target Price: $${priceDisplay}`,
    ``,
    `We'll notify you if we detect a deal at or below your target price.`,
    ``,
    `If you didn't request this alert, you can ignore this email.`
  ].join('\n');

  // HTML version with centered logo linking back to the site
  const htmlContent = `
<div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background-color:#f5f5f5; padding:24px 16px; text-align:center;">
  <a href="https://shoebeagle.com" style="text-decoration:none; display:inline-block; margin-bottom:16px;">
    <img src="https://shoebeagle.com/images/logo.svg" alt="Shoe Beagle" style="max-width:260px; height:auto; display:block; margin:0 auto;">
  </a>
  <div style="max-width:520px; margin:0 auto; text-align:left; background:#ffffff; border-radius:12px; padding:20px 24px; border:1px solid #e5e7eb;">
    <p style="margin:0 0 12px; font-size:16px;">Thanks for setting a price alert at <strong>Shoe Beagle</strong>!</p>
    <p style="margin:0 0 8px; font-size:14px;"><strong>Product:</strong> ${product}</p>
    <p style="margin:0 0 8px; font-size:14px;"><strong>Target Price:</strong> $${priceDisplay}</p>
    <p style="margin:16px 0 0; font-size:14px;">We'll notify you if we detect a deal at or below your target price.</p>
  </div>
  <p style="margin-top:16px; font-size:12px; color:#6b7280;">If you didn't request this alert, you can ignore this email.</p>
</div>
`.trim();

  const sgPayload = {
    personalizations: [
      {
        to: [{ email: email || '' }].filter(x => x.email) // SendGrid still wants an email here
      }
    ],
    from: {
      email: 'alerts@shoebeagle.com', // your authenticated domain sender
      name: 'Shoe Beagle Alerts'
    },
    subject: `Price Alert Set: ${product}`,
    content: [
      {
        type: 'text/plain',
        value: plainText
      },
      {
        type: 'text/html',
        value: htmlContent
      }
    ]
  };

  try {
    // Only attempt SendGrid if we have an email
    if (email) {
      const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(sgPayload)
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.error('SendGrid API error:', resp.status, text);
        // We won't fail the whole request just for email, but we report the error
      } else {
        console.log('SendGrid email sent successfully to', email);
      }
    } else {
      console.log('No email address provided; skipping email send.');
    }

    // OPTIONAL: SMS via Twilio if phone is provided and env vars are set
    if (phone && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER) {
      try {
        const basicAuth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
        const smsBody = `Shoe Beagle alert set for ${product} at $${priceDisplay}. We'll notify you when we sniff out a deal at or below your target price.`;

        const smsResp = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${basicAuth}`,
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
            },
            body: new URLSearchParams({
              To: phone,
              From: TWILIO_FROM_NUMBER,
              Body: smsBody
            }).toString()
          }
        );

        if (!smsResp.ok) {
          const smsText = await smsResp.text().catch(() => '');
          console.error('Twilio SMS error:', smsResp.status, smsText);
        } else {
          console.log('Twilio SMS sent successfully to', phone);
        }
      } catch (smsErr) {
        console.error('Error sending SMS via Twilio:', smsErr);
      }
    } else if (phone) {
      console.log('Phone provided but Twilio env vars are missing; skipping SMS.');
    }

    // Always return success to the front-end if we got this far
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: true }));
  } catch (err) {
    console.error('Error in /api/alerts handler:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Unexpected error handling alert' }));
  }
}
