// /api/scrapers/publiclands-sale.js

import Firecrawl from "@mendable/firecrawl-js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    const firecrawl = new Firecrawl({
      apiKey: process.env.FIRECRAWL_API_KEY || "",
    });

    return res.status(200).json({
      success: true,
      importType: typeof Firecrawl,
      instanceType: typeof firecrawl,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err?.message || "Unknown error",
    });
  }
}
