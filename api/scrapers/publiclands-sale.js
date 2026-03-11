// /api/scrapers/publiclands-sale.js

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    return res.status(200).json({
      success: true,
      message: "publiclands-sale route is alive"
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err?.message || "Unknown error"
    });
  }
}
