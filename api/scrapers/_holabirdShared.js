const axios = require("axios");
const cheerio = require("cheerio");

/** Remove HTML/CSS/widget junk from scraped strings */
function sanitizeText(input) {
  if (input == null) return "";
  let s = String(input).trim();
  if (!s) return "";

  // Strip injected CSS blocks instead of nuking the whole string
  if (
    /{[^}]*}/.test(s) &&
    /(margin|display|font-size|padding|color|background|line-height)\s*:/i.test(s)
  ) {
    s = s.replace(/#[A-Za-z0-9_-]+\s*\{[^}]*\}/g, " ");
    s = s.replace(/\.[A-Za-z0-9_-]+\s*\{[^}]*\}/g, " ");
    s = s.replace(/#review-stars-[^}]*\}/gi, " ");
    s = s.replace(/oke-sr-count[^}]*\}/gi, " ");
    s = s.replace(/\s+/g, " ").trim();
  }

  // Strip tags if any
  if (s.includes("<")) {
    s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
    s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
    s = s.replace(/<[^>]+>/g, " ");
  }

  // Decode common entities
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

  function pushFromImg($img) {
    if (!$img || !$img.length) return;

    const src =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      $img.attr("src");

    const srcset =
      $img.attr("data-srcset") ||
      $img.attr("srcset");

    const picked = pickLargestFromSrcset(srcset);

    if (picked) candidates.push(picked);
    if (src) candidates.push(src);
  }

  if ($link?.find) pushFromImg($link.find("img").first());
  if ($container?.find) pushFromImg($container.find("img").first());

  if ($container?.find) {
    $container.find("img").each((_, el) => pushFromImg($(el)));
  }

  return (
    candidates
      .map((c) => (c ? absolutizeUrl(c.trim()) : null))
      .filter(Boolean)[0] || null
  );
}

function extractDollarAmounts(text) {
  if (!text) return [];
  const matches = String(text).match(/\$\s*[\d,]+(?:\.\d{1,2})?/g);
  if (!matches) return [];

  return matches
    .map((m) => parseFloat(m.replace(/[$,\s]/g, "")))
    .filter(Number.isFinite);
}

function extractPricesFromText(fullText) {
  let prices = extractDollarAmounts(fullText)
    .filter((p) => p >= 10 && p < 1000);

  prices = [...new Set(prices.map((p) => p.toFixed(2)))].map(Number);

  if (prices.length < 2 || prices.length > 4) {
    return { valid: false };
  }

  prices.sort((a, b) => b - a);

  const original = prices[0];
  const sale = prices[prices.length - 1];

  if (sale >= original) return { valid: false };

  const pct = ((original - sale) / original) * 100;
  if (pct < 5 || pct > 90) return { valid: false };

  return { salePrice: sale, originalPrice: original, valid: true };
}

function randomDelay(min = 250, max = 700) {
  const wait = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, wait));
}

async function scrapeHolabirdCollection({ collectionUrl, maxPages = 50, stopAfterEmptyPages = 1 }) {
  const deals = [];
  const seen = new Set();
  let emptyPages = 0;

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
    let found = 0;

    $('a[href*="/products/"]').each((_, el) => {
      const $link = $(el);
      const href = $link.attr("href");
      if (!href || href.includes("#")) return;

      const productUrl = absolutizeUrl(href);
      if (!productUrl || seen.has(productUrl)) return;

      const $container = $link.closest("li, article, div").first();
      const containerText = sanitizeText($container.text());
      if (!containerText.includes("$")) return;

      let title =
        sanitizeText(
          $container
            .find(
              "h1,h2,h3," +
              "a[href*='/products/']," +
              "a[class*='title'],a[class*='name'],a[class*='heading']," +
              "[class*='product-title'],[class*='product_name'],[class*='product-name']," +
              "[class*='card__heading'],[class*='full-unstyled-link']," +
              "[class*='grid-product__title'],[class*='product-item__title']"
            )
            .first()
            .text()
        ) ||
        sanitizeText($link.attr("title")) ||
        sanitizeText($link.text()) ||
        sanitizeText($link.find("img").first().attr("alt"));

      if (!title) return;

      const prices = extractPricesFromText(containerText);
      if (!prices.valid) return;

      deals.push({
        title,
        store: "Holabird Sports",
        price: prices.salePrice,
        originalPrice: prices.originalPrice,
        url: productUrl,
        image: findBestImageUrl($, $link, $container),
        scrapedAt: new Date().toISOString(),
      });

      seen.add(productUrl);
      found++;
    });

    if (found === 0) {
      emptyPages++;
      if (emptyPages >= stopAfterEmptyPages) break;
    } else {
      emptyPages = 0;
    }

    await randomDelay();
  }

  return deals;
}

function dedupeByUrl(deals) {
  const out = [];
  const seen = new Set();

  for (const d of deals || []) {
    if (!d?.url || seen.has(d.url)) continue;
    seen.add(d.url);
    out.push(d);
  }

  return out;
}

module.exports = {
  scrapeHolabirdCollection,
  dedupeByUrl,
};
