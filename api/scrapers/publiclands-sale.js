// /api/scrapers/publiclands-sale.js

import { FirecrawlApp } from "@mendable/firecrawl-js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    return res.status(200).json({
      success: true,
      firecrawlType: typeof FirecrawlApp
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err?.message || "Unknown error"
    });
  }
}
