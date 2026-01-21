const axios = require("axios");
const cheerio = require("cheerio");

/** Remove HTML/CSS/widget junk from scraped strings */
function sanitizeText(input) {
  if (input == null) return "";
  let s = String(input).trim();
  if (!s) return "";

  // Nuke obvious CSS blocks / injected style text
  if (
    /{[^}]*}/.test(s) &&
    /(margin|display|font-size|padding|color|background|line-height)\s*:/i.test(s)
  ) {
    return "";
  }

  // Strip tags if any (sometimes you end up with markup-like strings)
  if (s.includes("<")) {
    s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
    s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
    s = s.replace(/<[^>]+>/g, " ");
  }

  // Decode a few common entities
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  s = s.replace(/\s+/g, " ").trim();

  // Kill known review/widget junk
  if (
    !s ||
    s.length < 4 ||
    /^#review-stars-/i.test(s) ||
    /oke-sr-count/i.test(s)
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

  return base + "/" + u.replace(/^\/+/, "");
}

function pickLargestFromSrcset(srcset) {
  if (!srcset) return null;
  const parts = String(srcset)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  let best = null;
  let bestScore = -1;

  for (const part of parts) {
    const [url, desc] = part.split(/\s+/);
    if (!url) continue;

    let score = 0;
    const mW = desc?.match(/(\d+)w/i);
    const mX = desc?.match(/(\d+(?:\.\d+)?)x/i);

    if (mW) score = parseInt(mW[1], 10);
    else if (mX) score = Math.round(parseFloat(mX[1]) * 1000);

    if (score >= bestScore) {
      bestScore = score;
      best = url;
    }
  }

  return best;
}

function findBestImageUrl($, $link, $container) {
  const candidates = [];

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

  if ($link && $link.find) pushFromImg($link.find("img").first());
  if ($container && $container.find) pushFromImg($container.find("img").first());

  if ($container && $container.find) {
    $container.find("img").each((_, el) => pushFromImg($(el)));
  }

  const abs = candidates
    .map((c) => (c ? String(c).trim() : ""))
    .filter(Boolean)
    .map((c) => absolutizeUrl(c));

  return abs[0] || null;
}

function extractDollarAmounts(text) {
  if (!text) return [];
  const matches = String(text).match(/\$\s*[\d,]+(?:\.\d{1,2})?/g);
  if (!matches) return [];
  return matches
    .map((m) => parseFloat(m.replace(/[$,\s]/g, "")))
    .filter((n) => Number.isFinite(n));
}

/**
 * Price extraction from card text: expects sale+original.
 * This matches your “shoe deal” use-case.
 */
function extractPricesFromText(fullText) {
  let prices = extractDollarAmounts(fullText);

  prices = prices.filter((p) => Number.isFinite(p) && p >= 10 && p < 1000);
  prices = [...new Set(prices.map((p) => p.toFixed(2)))].map((s) => parseFloat(s));

  if (prices.length < 2) return { salePrice: null, originalPrice: null, valid: false };
  if (prices.length > 4) return { salePrice: null, originalPrice: null, valid: false };

  // High -> low
  prices.sort((a, b) => b - a);

  // Use top as original, lowest as sale (common for Shopify cards)
  const original = prices[0];
  const sale = prices[prices.length - 1];

  if (!(sale < original)) return { salePrice: null, originalPrice: null, valid: false };

  const pct = ((original - sale) / original) * 100;
  if (pct < 5 || pct > 90) return { salePrice: null, originalPrice: null, valid: false };

  return { salePrice: sale, originalPrice: original, valid: true };
}

function randomDelay(min = 250, max = 700) {
  const wait = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * Theme-resilient collection scraper:
 * - Finds product links by /products/
 * - Extracts title from img alt OR container title-like nodes
 * - Extracts prices from container text (not fragile class selectors)
 * - Extracts best image via src/srcset/data-src/data-srcset
 */
async function scrapeHolabirdCollection({ collectionUrl, maxPages = 50, stopAfterEmptyPages = 1 }) {
  const deals = [];
  const seen = new Set();
  let emptyPagesInARow = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url = collectionUrl.includes("?")
      ? `${collectionUrl}&page=${page}`
      : `${collectionUrl}?page=${page}`;

    const resp = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(resp.data);

    let foundThisPage = 0;

    $('a[href*="/products/"]').each((_, el) => {
      const $link = $(el);
      const href = $link.attr("href");
      if (!href || !href.includes("/products/")) return;

      const productUrl = absolutizeUrl(href);
      if (!productUrl || seen.has(productUrl)) return;

      // “Container” heuristics: grab a nearby parent; theme changes won’t break this badly.
      const $container = $link.closest("li, article, div").first();

      const containerText = sanitizeText($container.text());
      if (!containerText || !containerText.includes("$")) return;

      // Title strategy (don’t use $container.text() for title)
      let title =
        sanitizeText($link.find("img").first().attr("alt")) ||
        sanitizeText($container.find("h2,h3,[class*='title'],[class*='name']").first().text()) ||
        sanitizeText($link.text());

      if (!title) return;
      if (/review-stars|oke-sr-count/i.test(title)) return;

      const { salePrice, originalPrice, valid } = extractPricesFromText(containerText);
      if (!valid || salePrice == null || originalPrice == null) return;

      const image = findBestImageUrl($, $link, $container);

      seen.add(productUrl);
      foundThisPage++;

      deals.push({
        title,
        store: "Holabird Sports",
        price: salePrice,
        originalPrice,
        url: productUrl,
        image: image || null,
        scrapedAt: new Date().toISOString(),
      });
    });

    if (foundThisPage === 0) {
      emptyPagesInARow++;
      if (emptyPagesInARow >= stopAfterEmptyPages) break;
    } else {
      emptyPagesInARow = 0;
    }

    await randomDelay();
  }

  return deals;
}

function dedupeByUrl(deals) {
  const out = [];
  const seen = new Set();
  for (const d of deals || []) {
    const u = d?.url;
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(d);
  }
  return out;
}

module.exports = {
  scrapeHolabirdCollection,
  dedupeByUrl,
};
