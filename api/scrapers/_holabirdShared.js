const axios = require("axios");
const cheerio = require("cheerio");

/**
 * Basic HTML/CSS garbage protection.
 * - strips tags
 * - kills obvious CSS blocks
 * - decodes a few common entities
 */
function sanitizeText(input) {
  if (input == null) return "";
  let s = String(input).trim();
  if (!s) return "";

  // If this looks like CSS or injected style text, discard
  // e.g. "#review-stars-123 { margin-top: 0; }"
  if (
    /#\w+[-_]\w+/.test(s) &&
    /{[^}]*}/.test(s) &&
    /(margin|display|font-size|padding|color|background)\s*:/i.test(s)
  ) {
    return "";
  }

  // Strip HTML tags if any
  if (s.includes("<")) {
    s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
    s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
    s = s.replace(/<[^>]+>/g, " ");
  }

  // Decode a few common entities (enough for product titles)
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  // Normalize whitespace
  s = s.replace(/\s+/g, " ").trim();

  // Kill known junk patterns
  if (
    !s ||
    s.length < 4 ||
    /^#review-stars-/i.test(s) ||
    /^\/\//.test(s) ||
    /^\{.*\}$/.test(s)
  ) {
    return "";
  }

  return s;
}

function absolutizeUrl(url, base = "https://www.holabirdsports.com") {
  if (!url) return null;
  let u = String(url).trim();
  if (!u) return null;

  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return base + u;

  // relative (rare)
  return base + "/" + u.replace(/^\/+/, "");
}

function pickLargestFromSrcset(srcset) {
  if (!srcset) return null;
  const parts = String(srcset)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  // Each part: "url 600w" OR "url 2x"
  // We'll prefer the last (often largest) after sorting by numeric descriptor.
  let best = null;
  let bestScore = -1;

  for (const part of parts) {
    const [url, desc] = part.split(/\s+/);
    if (!url) continue;

    let score = 0;
    if (desc) {
      const mW = desc.match(/(\d+)w/i);
      const mX = desc.match(/(\d+(?:\.\d+)?)x/i);
      if (mW) score = parseInt(mW[1], 10);
      else if (mX) score = Math.round(parseFloat(mX[1]) * 1000);
    }

    if (score >= bestScore) {
      bestScore = score;
      best = url;
    }
  }

  return best;
}

function findBestImageUrl($, $link, $container) {
  // Try in order: link img, container img, any img inside
  const $img =
    ($link && $link.find && $link.find("img").first()) ||
    cheerio.load("").root(); // fallback dummy

  let candidates = [];

  function pushFromImg($imgEl) {
    if (!$imgEl || !$imgEl.length) return;

    const src =
      $imgEl.attr("data-src") ||
      $imgEl.attr("data-original") ||
      $imgEl.attr("src");

    const srcset =
      $imgEl.attr("data-srcset") ||
      $imgEl.attr("srcset");

    const picked = pickLargestFromSrcset(srcset);

    if (picked) candidates.push(picked);
    if (src) candidates.push(src);
  }

  // 1) <a> img
  if ($link && $link.find) pushFromImg($link.find("img").first());

  // 2) container img
  if ($container && $container.find) pushFromImg($container.find("img").first());

  // 3) any nested img as last resort
  if ($container && $container.find) {
    $container.find("img").each((_, el) => pushFromImg($(el)));
  }

  // clean + absolutize
  candidates = candidates
    .map((c) => (c ? String(c).trim() : ""))
    .filter(Boolean)
    .map((c) => absolutizeUrl(c));

  return candidates[0] || null;
}

/**
 * Extract $ amounts from text
 */
function extractDollarAmounts(text) {
  if (!text) return [];
  const matches = String(text).match(/\$\s*[\d,]+(?:\.\d{1,2})?/g);
  if (!matches) return [];

  return matches
    .map((m) => parseFloat(m.replace(/[$,\s]/g, "")))
    .filter((n) => Number.isFinite(n));
}

/**
 * Universal price extractor (same logic as your main scraper)
 */
function extractPricesFromText(fullText) {
  let prices = extractDollarAmounts(fullText);

  // Filter to reasonable range
  prices = prices.filter((p) => Number.isFinite(p) && p >= 10 && p < 1000);

  // Deduplicate
  prices = [...new Set(prices.map((p) => p.toFixed(2)))].map((s) => parseFloat(s));

  if (prices.length < 2) return { salePrice: null, originalPrice: null, valid: false };
  if (prices.length > 3) return { salePrice: null, originalPrice: null, valid: false };

  // Sort high -> low
  prices.sort((a, b) => b - a);

  if (prices.length === 2) {
    const original = prices[0];
    const sale = prices[1];
    if (!(sale < original)) return { salePrice: null, originalPrice: null, valid: false };

    const pct = ((original - sale) / original) * 100;
    if (pct < 5 || pct > 90) return { salePrice: null, originalPrice: null, valid: false };

    return { salePrice: sale, originalPrice: original, valid: true };
  }

  // 3 prices: original is largest; pick next largest as sale
  const original = prices[0];
  const sale = Math.max(prices[1], prices[2]);

  const pct = ((original - sale) / original) * 100;
  if (sale < original && pct >= 5 && pct <= 90) {
    return { salePrice: sale, originalPrice: original, valid: true };
  }

  return { salePrice: null, originalPrice: null, valid: false };
}

function randomDelay(min = 400, max = 900) {
  const wait = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * Scrape a Holabird collection URL with pagination.
 * Theme-resilience strategy:
 * - avoid relying on specific class names
 * - extract title from img alt OR common title elements
 * - sanitize everything to kill HTML/CSS junk
 * - pull prices from container text
 * - images found via src/srcset/data-src
 */
async function scrapeHolabirdCollection({
  collectionUrl,
  maxPages = 8,
  storeName = "Holabird Sports",
  userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
}) {
  const deals = [];
  const seen = new Set();

  for (let page = 1; page <= maxPages; page++) {
    const url = collectionUrl.includes("?")
      ? `${collectionUrl}&page=${page}`
      : `${collectionUrl}?page=${page}`;

    const resp = await axios.get(url, {
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(resp.data);

    let foundThisPage = 0;

    // Find product links
    $('a[href*="/products/"]').each((_, el) => {
      const $link = $(el);
      const href = $link.attr("href");
      if (!href || !href.includes("/products/")) return;

      const productUrl = absolutizeUrl(href);
      if (!productUrl || seen.has(productUrl)) return;

      // Find a nearby container with pricing context
      const $container = $link.closest("li, article, div").first();
      const containerTextRaw = sanitizeText($container.text());
      if (!containerTextRaw || !containerTextRaw.includes("$")) return;

      // Title strategy:
      // 1) img alt
      // 2) common title nodes in container
      // 3) link text
      let title =
        sanitizeText($link.find("img").first().attr("alt")) ||
        sanitizeText($container.find("h2,h3,[class*='title'],[class*='name']").first().text()) ||
        sanitizeText($link.text());

      // If still junk, bail
      if (!title) return;

      // Kill known non-product junk anchors
      if (/review-stars|oke-sr-count/i.test(title)) return;

      const { salePrice, originalPrice, valid } = extractPricesFromText(containerTextRaw);
      if (!valid || !salePrice || !originalPrice) return;

      // Image strategy (may not be inside <a>)
      const image = findBestImageUrl($, $link, $container);

      seen.add(productUrl);
      foundThisPage++;

      deals.push({
        title,
        store: storeName,
        price: salePrice,
        originalPrice,
        url: productUrl,
        image: image || null,
        scrapedAt: new Date().toISOString(),
      });
    });

    // If no products found, stop early
    if (foundThisPage === 0) break;

    await randomDelay();
  }

  return deals;
}

module.exports = {
  sanitizeText,
  absolutizeUrl,
  scrapeHolabirdCollection,
  randomDelay,
};
