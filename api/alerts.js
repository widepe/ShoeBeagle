// api/alerts.js
// Vercel Serverless Function that receives POST JSON
// from your front-end and sends a basic email via SendGrid.

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        const parsed = data ? JSON.parse(data) : {};
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  }

  if (!SENDGRID_API_KEY) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Missing SENDGRID_API_KEY' }));
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    console.error('Error parsing JSON body:', err);
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }

  const { product, targetPrice, email, phone } = body || {};
  const to = email || phone;

  if (!to || !product || !targetPrice) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Missing required fields' }));
  }

  const numericPrice = Number(targetPrice);
  const priceDisplay = Number.isFinite(numericPrice)
    ? numericPrice.toFixed(2)
    : String(targetPrice);

  const sgPayload = {
    personalizations: [
      {
        to: [{ email: to }]
      }
    ],
    from: {
      email: 'alerts@shoebeagle.com', // any address on your verified domain
      name: 'Shoe Beagle Alerts'
    },
    subject: `Price Alert Set: ${product}`,
    content: [
      {
        type: 'text/plain',
        value: [
          `Thanks for setting a price alert at Shoe Beagle!`,
          ``,
          `Product: ${product}`,
          `Target Price: $${priceDisplay}`,
          ``,
          `We'll notify you if we detect a deal at or below your target price (once you hook up the deal-checker logic).`,
          ``,
          `If you didn't request this alert, you can ignore this email.`
        ].join('\n')
      }
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
