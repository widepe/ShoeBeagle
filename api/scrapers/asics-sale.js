// api/scrapers/asics-sale.js
// Scrapes all three ASICS sale pages using Firecrawl
// FIXED: Gender detection works with query parameters using category codes
// FIXED: Image extraction now checks picture/source srcset + img srcset + common lazy attrs + background-image

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');
const { put } = require('@vercel/blob');

/**
 * Pick the best (usually largest) URL from a srcset string.
 * Example: "url1 200w, url2 800w" -> returns url2
 */
function pickBestFromSrcset(srcset) {
  if (!srcset || typeof srcset !== 'string') return null;

  // Keep entries, choose the largest width if widths exist, else last URL
  const entries = srcset
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!entries.length) return null;

  let bestUrl = null;
  let bestW = -1;

  for (const entry of entries) {
    const parts = entry.split(/\s+/).filter(Boolean);
    const url = parts[0];
    const wPart = parts.find(p => /^\d+w$/.test(p));
    const w = wPart ? parseInt(wPart.replace('w', ''), 10) : null;

    if (w !== null && !Number.isNaN(w)) {
      if (w > bestW) {
        bestW = w;
        bestUrl = url;
      }
    } else {
      // If no widths, fall back to last entry later
      bestUrl = url;
    }
  }

  // If we never saw widths, bestUrl will be from last parsed entry
  return bestUrl || null;
}

/**
 * Convert ASICS-ish URLs to absolute https URLs.
 */
function absolutizeAsicsUrl(url) {
  if (!url || typeof url !== 'string') return null;

  // handle HTML entities if present
  url = url.replace(/&amp;/g, '&').trim();

  if (!url) return null;
  if (url.startsWith('data:')) return null;

  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `https://www.asics.com${url}`;
  return `https://www.asics.com/${url.replace(/^\.?\//, '')}`;
}

/**
 * Extract an image URL from a product tile.
 * Tries picture/source srcset first, then img srcset, then img src/data-src,
 * then background-image inline styles.
 */
function extractAsicsImageFromTile($tile) {
  let image = null;

  // 1) <picture><source srcset=...> or data-srcset
  const $source = $tile.find('picture source').first();
  if ($source && $source.length) {
    const srcset =
      $source.attr('srcset') ||
      $source.attr('data-srcset') ||
      $source.attr('data-lazy-srcset') ||
      null;

    image = pickBestFromSrcset(srcset) || null;
  }

  // 2) img srcset / data-srcset variants
  if (!image) {
    const $img = $tile.find('img').first();
    if ($img && $img.length) {
      const imgSrcset =
        $img.attr('srcset') ||
        $img.attr('data-srcset') ||
        $img.attr('data-lazy-srcset') ||
        $img.attr('data-src-set') || // sometimes odd naming
        null;

      image = pickBestFromSrcset(imgSrcset) || null;
    }
  }

  // 3) img src / lazy attrs
  if (!image) {
    const $img = $tile.find('img').first();
    if ($img && $img.length) {
      image =
        $img.attr('src') ||
        $img.attr('data-src') ||
        $img.attr('data-lazy-src') ||
        $img.attr('data-original') ||
        $img.attr('data-image') ||
        null;
    }
  }

  // 4) background-image inline style fallback
  if (!image) {
    const $bg = $tile.find('[style*="background-image"]').first();
    const style = ($bg && $bg.length ? $bg.attr('style') : '') || '';
    const m = style.match(/background-image\s*:\s*url\(["']?(.*?)["']?\)/i);
    if (m && m[1]) image = m[1];
  }

  image = absolutizeAsicsUrl(image);

  // Skip placeholders / data URIs
  if (image && (image.startsWith('data:') || image.toLowerCase().includes('placeholder'))) {
    image = null;
  }

  // Upgrade thumbnail images to larger versions (if ASICS uses this pattern)
  if (image && image.includes('$variantthumbnail$')) {
    image = image.replace('$variantthumbnail$', '$zoom$');
  }

  return image || null;
}

/**
 * Extract products from ASICS HTML
 * FIXED: Uses category codes (aa10106000, aa20106000) for gender detection
 */
function extractAsicsProducts(html, sourceUrl) {
  const $ = cheerio.load(html);
  const products = [];

  // Determine gender from URL - normalize URL first to handle query params
  const normalizedUrl = (sourceUrl || '').toLowerCase();
  let gender = 'Unisex';

  // IMPORTANT: Check women's FIRST since aa20106000 contains aa10106000 as substring!
  if (normalizedUrl.includes('aa20106000') || normalizedUrl.includes('womens-clearance')) {
    gender = 'Women';
  } else if (normalizedUrl.includes('aa10106000') || normalizedUrl.includes('mens-clearance')) {
    gender = 'Men';
  } else if (normalizedUrl.includes('leaving-asics') || normalizedUrl.includes('aa60400001')) {
    gender = 'Unisex';
  }

  console.log(`[ASICS] Processing URL: ${sourceUrl} -> Gender: ${gender}`);

  // CORRECT SELECTOR: productTile__root
  const $products = $('.productTile__root');

  console.log(`[ASICS] Found ${$products.length} products for ${gender}`);

  $products.each((i, el) => {
    const $product = $(el);

    // Get product link for title and URL
    const $link = $product.find('a[href*="/p/"]').first();
    const linkTitle = $link.attr('aria-label') || $link.text().trim();

    // Clean up title
    let cleanTitle = (linkTitle || '')
      .replace(/Next slide/gi, '')
      .replace(/Previous slide/gi, '')
      .replace(/Sale/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Extract model name (before "Men's" or "Women's")
    const modelMatch = cleanTitle.match(/^([A-Z][A-Z\-\s\d]+?)(?=Men's|Women's|Unisex|\$)/i);
    if (modelMatch) {
      cleanTitle = modelMatch[1].trim();
    }

    if (!cleanTitle || cleanTitle.length < 3) return;

    // Extract prices
    const productText = $product.text();
    const priceMatches = productText.match(/\$(\d+\.\d{2})/g);

    let price = null;
    let originalPrice = null;

    if (priceMatches && priceMatches.length >= 2) {
      originalPrice = parseFloat(priceMatches[0].replace('$', ''));
      price = parseFloat(priceMatches[1].replace('$', ''));
    } else if (priceMatches && priceMatches.length === 1) {
      price = parseFloat(priceMatches[0].replace('$', ''));
    }

    // Ensure sale price is lower
    if (price && originalPrice && price > originalPrice) {
      [price, originalPrice] = [originalPrice, price];
    }

    // Get URL
    let url = $link.attr('href');
    if (url && !url.startsWith('http')) {
      url = `https://www.asics.com${url}`;
    }

    // FIXED: Image extraction
    const image = extractAsicsImageFromTile($product);

    // Calculate discount
    const discount =
      originalPrice && price && originalPrice > price
        ? Math.round(((originalPrice - price) / originalPrice) * 100)
        : null;

    // Model name
    const model = cleanTitle.replace(/^ASICS\s+/i, '').trim();

    if (cleanTitle && (price || originalPrice) && url) {
      products.push({
        title: cleanTitle,
        brand: 'ASICS',
        model,
        store: 'ASICS',
        gender,
        price,
        originalPrice,
        discount: discount ? `${discount}%` : null,
        url,
        image: image || null,
        scrapedAt: new Date().toISOString(),
      });
    }
  });

  return products;
}

/**
 * Scrape ASICS page with pagination - single attempt with larger size
 */
async function scrapeAsicsUrlWithPagination(app, baseUrl, description) {
  console.log(`[ASICS] Scraping ${description}...`);

  try {
    // Request 100 items directly (ASICS max seems to be around 96-100)
    const url = baseUrl.includes('?') ? `${baseUrl}&sz=100` : `${baseUrl}?sz=100`;

    console.log(`[ASICS] Fetching: ${url}`);

    const scrapeResult = await app.scrapeUrl(url, {
      formats: ['html'],
      waitFor: 8000, // Wait 8 seconds for all products to load
      timeout: 45000, // 45 second timeout
    });

    const products = extractAsicsProducts(scrapeResult.html, baseUrl);

    console.log(`[ASICS] ${description}: Found ${products.length} products`);

    return {
      success: true,
      products,
      count: products.length,
      url,
    };
  } catch (error) {
    console.error(`[ASICS] Error scraping ${description}:`, error.message);
    return {
      success: false,
      products: [],
      count: 0,
      error: error.message,
      url: baseUrl,
    };
  }
}

/**
 * Main scraper - scrapes all 3 ASICS pages SEQUENTIALLY (not parallel)
 * Sequential is more reliable for avoiding rate limits
 */
async function scrapeAllAsicsSales() {
  const app = new FirecrawlApp({
    apiKey: process.env.FIRECRAWL_API_KEY,
  });

  console.log('[ASICS] Starting scrape of all sale pages (sequential)...');

  const pages = [
    {
      url: 'https://www.asics.com/us/en-us/mens-clearance/c/aa10106000/running/shoes/',
      description: "Men's Clearance",
    },
    {
      url: 'https://www.asics.com/us/en-us/womens-clearance/c/aa20106000/running/shoes/',
      description: "Women's Clearance",
    },
    {
      url: 'https://www.asics.com/us/en-us/styles-leaving-asics-com/c/aa60400001/running/shoes/?prefn1=c_productGender&prefv1=Women%7CMen',
      description: 'Last Chance Styles',
    },
  ];

  const results = [];
  const allProducts = [];

  // Scrape sequentially with delay between requests
  for (let i = 0; i < pages.length; i++) {
    const { url, description } = pages[i];

    console.log(`[ASICS] Starting page ${i + 1}/${pages.length}: ${description}`);

    const result = await scrapeAsicsUrlWithPagination(app, url, description);
    results.push({
      page: description,
      success: result.success,
      count: result.count,
      error: result.error || null,
      url: result.url,
    });

    if (result.success) {
      allProducts.push(...result.products);
    }

    // Add 2 second delay between pages to avoid rate limiting
    if (i < pages.length - 1) {
      console.log('[ASICS] Waiting 2 seconds before next page...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Deduplicate by URL
  const uniqueProducts = [];
  const seenUrls = new Set();

  for (const product of allProducts) {
    if (!product.url) {
      uniqueProducts.push(product);
      continue;
    }

    if (!seenUrls.has(product.url)) {
      seenUrls.add(product.url);
      uniqueProducts.push(product);
    }
  }

  console.log(`[ASICS] Total unique products: ${uniqueProducts.length}`);
  console.log(`[ASICS] Results per page:`, results);

  return { products: uniqueProducts, pageResults: results };
}

/**
 * Vercel handler
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['x-cron-secret'] !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const start = Date.now();

  try {
    const { products: deals, pageResults } = await scrapeAllAsicsSales();

    const output = {
      lastUpdated: new Date().toISOString(),
      store: 'ASICS',
      segments: ["Men's Clearance", "Women's Clearance", 'Last Chance Styles'],
      totalDeals: deals.length,
      dealsByGender: {
        Men: deals.filter(d => d.gender === 'Men').length,
        Women: deals.filter(d => d.gender === 'Women').length,
        Unisex: deals.filter(d => d.gender === 'Unisex').length,
      },
      pageResults,
      deals,
    };

    const blob = await put('asics-sale.json', JSON.stringify(output, null, 2), {
      access: 'public',
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;

    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      dealsByGender: output.dealsByGender,
      pageResults,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (error) {
    console.error('[ASICS] Fatal error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`,
    });
  }
};
