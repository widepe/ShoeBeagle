// api/contact.js
// Contact form submission endpoint using SendGrid

const sgMail = require("@sendgrid/mail");

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL;          // where YOU receive messages
const FROM_EMAIL =
  process.env.SENDGRID_FROM_EMAIL || CONTACT_EMAIL || "contact@shoebeagle.com";

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

module.exports = async (req, res) => {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Check config
  if (!SENDGRID_API_KEY || !CONTACT_EMAIL) {
    console.error("Missing SENDGRID_API_KEY or CONTACT_EMAIL env vars.");
    return res
      .status(500)
      .json({ error: "Email service not configured on the server." });
  }

  try {
    const { name, email, message } = req.body || {};

    // Basic validation
    if (!name || !email || !message) {
      return res.status(400).json({ error: "All fields are required." });
    }

    if (!email.includes("@")) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    if (message.trim().length < 10) {
      return res
        .status(400)
        .json({ error: "Message must be at least 10 characters long." });
    }

    // Build the email
    const mail = {
      to: CONTACT_EMAIL,          // goes to you
      from: FROM_EMAIL,           // must be your authenticated domain
      replyTo: email,             // so hitting “reply” goes to the visitor
      subject: `New contact from ${name} via Shoe Beagle`,
      text: `
Name: ${name}
Email: ${email}

Message:
${message}
      `.trim(),
      html: `
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Message:</strong></p>
        <p style="white-space:pre-wrap;">${message}</p>
      `,
    };

    // Send via SendGrid
    await sgMail.send(mail);

    return res.status(200).json({
      success: true,
      message: "Message sent successfully.",
    });
  } catch (error) {
    console.error("Contact form error:", error);

    // Try to surface SendGrid's own error message if present
    const sgMsg =
      error?.response?.body?.errors?.[0]?.message ||
      error?.message ||
      "Failed to send message. Please try again later.";

    return res.status(500).json({ error: sgMsg });
  }
};
