// /api/scrapers/fleet-feet-debug.js

const cheerio = require("cheerio");

export const config = { maxDuration: 60 };

async function fetchTextWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    return {
      status: resp.status,
      html: await resp.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

export default async function handler(req, res) {
  try {
    const url = "https://www.fleetfeet.com/browse/shoes/mens?clearance=on";

    const { status, html } = await fetchTextWithTimeout(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      },
      30000
    );

    const $ = cheerio.load(html);

    const productTileCount = $(".product-tile").length;
    const productLinkCount = $("a.product-tile-link").length;
    const priceCount = $(".product-tile-price").length;
    const discountedCount = $(".product-tile-price .discounted").length;
    const originalCount = $(".product-tile-price .original").length;

    const title = normalizeWhitespace($("title").text());
    const bodySnippet = normalizeWhitespace($("body").text()).slice(0, 1500);
    const firstTileHtml = $(".product-tile").first().toString().slice(0, 3000);

    return res.status(200).json({
      success: true,
      status,
      url,
      title,
      counts: {
        productTileCount,
        productLinkCount,
        priceCount,
        discountedCount,
        originalCount,
      },
      firstTileHtml: firstTileHtml || null,
      bodySnippet,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err?.message || "Unknown error",
    });
  }
}
