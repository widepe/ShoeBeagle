// api/alerts.js
// Vercel serverless function for Shoe Beagle price alerts.
// Sends an email via SendGrid with logo and clean copy.

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

// Helper to read JSON body
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

  const { product, targetPrice, email } = body || {};

  if (!email || !product || !targetPrice) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Missing required fields' }));
  }

  const numericPrice = Number(targetPrice);
  const priceDisplay = Number.isFinite(numericPrice)
    ? numericPrice.toFixed(2)
    : String(targetPrice);

  const plainText = [
    `Thanks for setting a price alert at Shoe Beagle!`,
    ``,
    `Product: ${product}`,
    `Target Price: $${priceDisplay}`,
    ``,
    `We'll notify you if we detect a deal at or below your target price.`,
    `To manage or cancel your alert(s) anytime, visit: https://shoebeagle.com/pages/myalerts.html`,
    ``,
    `If you didn't request this alert, you can ignore this email.`
  ].join('\n');

  const htmlContent = `
<div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background-color:#f5f5f5; padding:24px 16px; text-align:center;">
  <a href="https://shoebeagle.com" style="text-decoration:none; display:inline-block; margin-bottom:16px;">
    <img src="https://shoebeagle.com/images/e_logo.png" alt="Shoe Beagle" style="max-width:260px; height:auto; display:block; margin:0 auto;">
  </a>
  <div style="max-width:520px; margin:0 auto; text-align:left; background:#ffffff; border-radius:12px; padding:20px 24px; border:1px solid #e5e7eb;">
    <p style="margin:0 0 12px; font-size:16px;">Thanks for setting a price alert at <strong>Shoe Beagle</strong>!</p>
    <p style="margin:0 0 8px; font-size:14px;"><strong>Product:</strong> ${product}</p>
    <p style="margin:0 0 8px; font-size:14px;"><strong>Target Price:</strong> $${priceDisplay}</p>
    <p style="margin:16px 0 0; font-size:14px;">We'll notify you immediately if we detect a deal at or below your target price. This alert will remain active for 30 days.</p>
    <p style="margin:12px 0 0; font-size:13px; color:#374151;">
      Save this email to manage or cancel your alert(s) by clicking
      <a href="https://shoebeagle.com/pages/myalerts.html"
         style="color:#214478ff; font-weight:600; text-decoration:none;">
        HERE
      </a>.
    </p>
  </div>
  <p style="margin-top:16px; font-size:12px; color:#6b7280;">If you didn't request this alert, you can ignore this email.</p>
</div>
`.trim();

  const sgPayload = {
    personalizations: [
      {
        to: [{ email }]
      }
    ],
    from: {
      email: 'alerts@shoebeagle.com',
      name: 'Shoe Beagle Alerts'
    },
    subject: `Price Alert Set: ${product}`,
    content: [
      { type: 'text/plain', value: plainText },
      { type: 'text/html', value: htmlContent }
    ]
  };

  try {
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
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Failed to send email via SendGrid' }));
    }

    console.log('SendGrid email sent successfully to', email);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: true }));
  } catch (err) {
    console.error('Error calling SendGrid:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Unexpected error sending email' }));
  }
}
