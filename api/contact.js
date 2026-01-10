// api/contact.js
// Contact form submission endpoint

module.exports = async (req, res) => {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, email, message } = req.body;

    // Validate inputs
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (!email.includes('@')) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    if (message.length < 10) {
      return res.status(400).json({ error: 'Message must be at least 10 characters' });
    }

    // Your email (hidden from users!)
    const YOUR_EMAIL = 'widepe@gmail.com';

    // For now, we'll use a simple webhook approach
    // You can upgrade to nodemailer later if needed
    
    // Log the message (you can set up email later)
    console.log('Contact form submission:', {
      from: email,
      name: name,
      message: message,
      timestamp: new Date().toISOString()
    });

    // TODO: Set up actual email sending with:
    // - Sendgrid (free tier: 100 emails/day)
    // - Resend (free tier: 100 emails/day)
    // - Nodemailer with Gmail SMTP
    
    // For now, return success
    // The message is logged and you can check Vercel logs
    return res.status(200).json({ 
      success: true,
      message: 'Message received! We\'ll get back to you soon.'
    });

  } catch (error) {
    console.error('Contact form error:', error);
    return res.status(500).json({ 
      error: 'Failed to send message. Please try again.' 
    });
  }
};
