// /api/scrapers/adidas-firecrawl.js  (CommonJS)
//
// Adidas sale scraper using Firecrawl + safe pagination.
//
// ✅ What it does
// - Scrapes:
//     https://www.adidas.com/us/women-running-shoes-sale
//     https://www.adidas.com/us/men-running-shoes-sale
// - Paginates with ?start=48, ?start=96, ... ONLY when a page is "full" (>= 48 cards)
// - Outputs your top-level schema + deals[]
// - Writes EXACT adidas.json to Vercel Blob (no suffix)
//
// Env vars required (Vercel):
// - FIRECRAWL_API_KEY
// - BLOB_READ_WRITE_TOKEN
// Optional:
// - CRON_SECRET (if you gate this endpoint)
// - SCRAPE_MAX_PAGES (default 10)
// - SCRAPE_PAGE_SIZE (default 48)

const cheerio = require('cheerio');
const { put } = require('@vercel/blob');

const STORE = 'Adidas';
const SCHEMA_VERSION = 1;
const VIA = 'firecrawl';

const BASE_URLS = [
  'https://www.adidas.com/us/women-running-shoes-sale',
  'https://www.adidas.com/us/men-running-shoes-sale',
];

function nowIso() {
  return new Date().toISOString();
}

function toAbsUrl(href) {
  const s = String(href || '').trim();
  if (!s) return null;
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  if (s.startsWith('/')) return `https://www.adidas.com${s}`;
  return `https://www.adidas.com/${s}`;
}

function parseMoney(text) {
  const s = String(text || '').replace(/,/g, '');
  const m = s.match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function roundPct(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  return Math.round(n);
}

function computeDiscountPercent(sale, orig) {
  if (typeof sale !== 'number' || typeof orig !== 'number') return null;
  if (!(sale > 0) || !(orig > 0) || sale >= orig) return null;
  return roundPct(((orig - sale) / orig) * 100);
}

function inferGenderFromSubtitle(subtitle) {
  const s = String(subtitle || '').toLowerCase();
  if (s.includes('unisex')) return 'unisex';
  if (s.includes('women') || s.includes("women’s") || s.includes("women's")) return 'womens';
  if (s.includes('men')) return 'mens';
  return 'unknown';
}

function buildPagedUrl(baseUrl, start) {
  if (!start) return baseUrl;
  const u = new URL(baseUrl);
  u.searchParams.set('start', String(start));
  return u.toString();
}

async function firecrawlScrapeHtml(url, apiKey) {
  // Firecrawl scrape endpoint (HTML)
  // NOTE: If your project uses a different Firecrawl route, swap it here.
  const resp = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ['html'],
      // A little politeness helps stability; Firecrawl handles its own fetch logic.
      // You can add "waitFor" or "onlyMainContent" if you use those elsewhere.
    }),
  });

  const json = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg = json?.error || json?.message || `Firecrawl scrape failed (${resp.status})`;
    throw new Error(`${msg}`);
  }

  const html =
    json?.data?.html ||
    json?.html || // some variants
    null;

  if (!html || typeof html !== 'string') {
    throw new Error('Firecrawl returned no HTML.');
  }

  return html;
}

function extractDealsFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);

  const cards = $('article[data-testid="plp-product-card"]');
  const cardCount = cards.length;

  const extracted = [];
  cards.each((_, el) => {
    const $card = $(el);

    const title =
      $card.find('p[data-testid="product-card-title"]').first().text().trim() || '';

    const subtitle =
      $card.find('p[data-testid="product-card-subtitle"]').first().text().trim() || '';

    const imageURL =
      ($card.find('img[data-testid="product-card-primary-image"]').first().attr('src') || '').trim() ||
      null;

    const href =
      ($card.find('a[data-testid="product-card-image-link"]').first().attr('href') ||
        $card.find('a[data-testid="product-card-description-link"]').first().attr('href') ||
        '').trim() || null;

    // Price text: try a couple patterns
    const saleText =
      $card.find('[data-testid="main-price"] ._sale-color_1dnvn_101').first().text().trim() ||
      $card.find('[data-testid="main-price"]').first().text().trim() ||
      '';

    const originalText =
      $card.find('[data-testid="original-price"]').first().text().trim() || '';

    const listingName = title;
    if (!listingName) return;

    const listingURL = toAbsUrl(href);
    const salePrice = parseMoney(saleText);
    const originalPrice = parseMoney(originalText);

    // HONESTY RULE: must have both prices
    if (!(salePrice > 0) || !(originalPrice > 0)) return;

    const discountPercent = computeDiscountPercent(salePrice, originalPrice);

    extracted.push({
      listingName,
      brand: 'Adidas',
      model: listingName,

      salePrice,
      originalPrice,
      discountPercent,

      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,

      store: STORE,

      listingURL,
      imageURL,

      gender: inferGenderFromSubtitle(subtitle),
      shoeType: 'unknown',

      // optional debug
      // __pageUrl: pageUrl,
    });
  });

  return { cardCount, deals: extracted };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();

  try {
    // Optional gating (if you use CRON_SECRET for scrapers)
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const got = String(req.headers['x-cron-secret'] || req.query?.secret || '');
      if (got !== cronSecret) {
        return res.status(401).json({ ok: false, error: 'Unauthorized (missing/invalid secret).' });
      }
    }

    const apiKey = String(process.env.FIRECRAWL_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: 'Missing FIRECRAWL_API_KEY' });
    }

    const blobToken = String(process.env.BLOB_READ_WRITE_TOKEN || '').trim();
    if (!blobToken) {
      return res.status(500).json({ ok: false, error: 'Missing BLOB_READ_WRITE_TOKEN' });
    }

    const PAGE_SIZE = Number(process.env.SCRAPE_PAGE_SIZE || '48') || 48;
    const MAX_PAGES = Number(process.env.SCRAPE_MAX_PAGES || '10') || 10;

    const seen = new Set();
    const allDeals = [];

    let pagesFetched = 0;
    let dealsFound = 0;
    let dealsExtracted = 0;

    const sourceUrls = [];

    const dropCounts = {
      totalCards: 0,
      dropped_missingTitle: 0,
      dropped_missingBothPrices: 0,
      dropped_duplicate: 0,
      kept: 0,
    };

    for (const baseUrl of BASE_URLS) {
      // start offsets: 0, 48, 96, ... until last page (<PAGE_SIZE) or MAX_PAGES
      for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
        const start = pageIndex * PAGE_SIZE;
        const url = buildPagedUrl(baseUrl, start);

        // If you’re nervous about bot protection, a little delay between pages helps.
        if (pageIndex > 0) await sleep(650 + Math.floor(Math.random() * 650));

        const html = await firecrawlScrapeHtml(url, apiKey);
        pagesFetched += 1;
        sourceUrls.push(url);

        const { cardCount, deals } = extractDealsFromHtml(html, url);

        dropCounts.totalCards += cardCount;
        dealsFound += cardCount;

        for (const d of deals) {
          if (!d.listingName) {
            dropCounts.dropped_missingTitle += 1;
            continue;
          }
          if (!(d.salePrice > 0) || !(d.originalPrice > 0)) {
            dropCounts.dropped_missingBothPrices += 1;
            continue;
          }

          const key = d.listingURL || `${d.listingName}::${d.salePrice}::${d.originalPrice}`;
          if (seen.has(key)) {
            dropCounts.dropped_duplicate += 1;
            continue;
          }
          seen.add(key);

          allDeals.push(d);
          dropCounts.kept += 1;
        }

        // ✅ paginate safely: only try next page when THIS page is "full"
        // If fewer than PAGE_SIZE cards, assume we're at the end.
        if (cardCount < PAGE_SIZE) break;
      }
    }

    dealsExtracted = allDeals.length;

    const out = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      deals: allDeals,

      // Optional diagnostics (remove later if you want)
      dropCounts,
    };

    // Write EXACT adidas.json (no suffix)
    const blob = await put('adidas.json', JSON.stringify(out, null, 2), {
      access: 'public',
      contentType: 'application/json',
      token: blobToken,
      addRandomSuffix: false,
    });

    out.blobUrl = blob.url;

    return res.status(200).json(out);
  } catch (err) {
    const outFail = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,
      sourceUrls: [],
      pagesFetched: 0,
      dealsFound: 0,
      dealsExtracted: 0,
      scrapeDurationMs: Date.now() - startedAt,
      ok: false,
      error: String(err?.message || err),
      deals: [],
    };

    return res.status(500).json(outFail);
  }
};
