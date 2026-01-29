// api/scrapers/asics-sale.js
// Scrapes all three ASICS sale pages using Firecrawl
// FIXED: Gender detection works with query parameters using category codes
// FIXED: Image extraction now includes a robust fallback derived from the product URL

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');
const { put } = require('@vercel/blob');

/**
 * Pick the best (usually largest) URL from a srcset string.
 * Example: "url1 200w, url2 800w" -> returns url2
 */
function pickBestFromSrcset(srcset) {
  if (!srcset || typeof srcset !== 'string') return null;

  const candidates = srcset
    .split(',')
    .map(s => s.trim())
    .map(entry => entry.split(/\s+/)[0]) // URL part
    .filter(Boolean);

  if (!candidates.length) return null;
  return candidates[candidates.length - 1];
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
  return `https://www.asics.com/${url}`;
}

/**
 * Some ASICS tiles don't include a usable <img src/srcset> in the HTML we get back.
 * But their product URLs usually include a style+color code like:
 *   .../p/ANA_1012B755-402.html
 * And their image CDN commonly follows this pattern:
 *   https://images.asics.com/is/image/asics/1012B755_402_SR_RT_GLB?$zoom$
 *
 * This builds that as a fallback (best-effort).
 */
function buildAsicsImageFromProductUrl(productUrl) {
  if (!productUrl || typeof productUrl !== 'string') return null;

  // Example match: ANA_1012B755-402.html
  const m = productUrl.match(/ANA_([A-Za-z0-9]+)-([A-Za-z0-9]+)\.html/i);
  if (!m) return null;

  const style = m[1]; // 1012B755
  const color = m[2]; // 402

  // Common ASICS CDN naming
  // Some valid examples use $sfcc-product$; we prefer $zoom$ for a larger image.
  return `https://images.asics.com/is/image/asics/${style}_${color}_SR_RT_GLB?$zoom$`;
}

/**
 * Detect shoe type from title or model
 */
function detectShoeType(title, model) {
  const combined = ((title || "") + " " + (model || "")).toLowerCase();

  // Trail indicators
  if (/\b(trail|trabuco|fujitrabuco|fuji)\b/i.test(combined)) {
    return "trail";
  }

  // Track/spike indicators
  if (/\b(track|spike|japan|metaspeed|magic speed)\b/i.test(combined)) {
    return "track";
  }

  // Road is default for ASICS running shoes
  return "road";
}

/**
 * Extract products from ASICS HTML
 * Uses category codes (aa10106000, aa20106000) for gender detection
 * UPDATED: Now outputs new 10-field schema
 */
function extractAsicsProducts(html, sourceUrl) {
  const $ = cheerio.load(html);
  const products = [];

  // Determine gender from URL - normalize URL first to handle query params
  const normalizedUrl = (sourceUrl || '').toLowerCase();
  let gender = 'unisex';

  // IMPORTANT: Check women's FIRST since aa20106000 contains aa10106000 as substring!
  if (normalizedUrl.includes('aa20106000') || normalizedUrl.includes('womens-clearance')) {
    gender = 'womens';
  } else if (normalizedUrl.includes('aa10106000') || normalizedUrl.includes('mens-clearance')) {
    gender = 'mens';
  } else if (normalizedUrl.includes('leaving-asics') || normalizedUrl.includes('aa60400001')) {
    gender = 'unisex';
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
    let cleanTitle = linkTitle
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

    let salePrice = null;
    let price = null;

    if (priceMatches && priceMatches.length >= 2) {
      price = parseFloat(priceMatches[0].replace('$', '')); // original price (first)
      salePrice = parseFloat(priceMatches[1].replace('$', '')); // sale price (second)
    } else if (priceMatches && priceMatches.length === 1) {
      salePrice = parseFloat(priceMatches[0].replace('$', ''));
    }

    // Ensure sale price is lower than original price
    if (salePrice && price && salePrice > price) {
      [salePrice, price] = [price, salePrice];
    }

    // Get URL
    let url = $link.attr('href');
    if (url && !url.startsWith('http')) {
      url = `https://www.asics.com${url}`;
    }

    // ----------------------------
    // IMAGE EXTRACTION (ROBUST)
    // ----------------------------
    // Try multiple places where ASICS might store the image:
    //   1) picture source[srcset]/[data-srcset]
    //   2) img[srcset]/[data-srcset]/[data-lazy-srcset]
    //   3) img[src]/[data-src]/[data-lazy-src]/[data-original]
    //   4) noscript img[src] (common lazy-load fallback)
    //   5) derived from product URL (high-success fallback)
    let image = null;

    // 1) picture source srcset
    const sourceSrcset =
      $product.find('picture source[srcset]').first().attr('srcset') ||
      $product.find('picture source[data-srcset]').first().attr('data-srcset') ||
      null;

    image = pickBestFromSrcset(sourceSrcset);

    // 2) img srcset variants
    if (!image) {
      const $img = $product.find('img').first();
      const imgSrcset =
        $img.attr('srcset') ||
        $img.attr('data-srcset') ||
        $img.attr('data-lazy-srcset') ||
        null;

      image = pickBestFromSrcset(imgSrcset);
    }

    // 3) img src variants
    if (!image) {
      const $img = $product.find('img').first();
      image =
        $img.attr('src') ||
        $img.attr('data-src') ||
        $img.attr('data-lazy-src') ||
        $img.attr('data-original') ||
        null;
    }

    // 4) noscript fallback
    if (!image) {
      const noscriptHtml = $product.find('noscript').first().html();
      if (noscriptHtml) {
        const $$ = cheerio.load(noscriptHtml);
        const nsImg =
          $$('img').first().attr('src') ||
          $$('img').first().attr('data-src') ||
          null;
        image = nsImg || null;
      }
    }

    image = absolutizeAsicsUrl(image);

    // Skip data URIs and obvious placeholders
    if (image && (image.startsWith('data:') || image.toLowerCase().includes('placeholder'))) {
      image = null;
    }

    // Upgrade thumbnail images to larger versions (if present)
    if (image && image.includes('$variantthumbnail$')) {
      image = image.replace('$variantthumbnail$', '$zoom$');
    }

    // 5) FINAL fallback: derive from product URL
    // This specifically fixes the cases like GEL-PULSE 16 where image was null.
    if (!image && url) {
      const derived = buildAsicsImageFromProductUrl(url);
      if (derived) image = derived;
    }
    // ----------------------------

    // Model name
    const model = cleanTitle.replace(/^ASICS\s+/i, '').trim();

    if (cleanTitle && (salePrice || price) && url) {
      products.push({
        title: cleanTitle,
        brand: 'ASICS',
        model,
        salePrice,                                  // CHANGED from 'price'
        price,                                      // CHANGED from 'originalPrice'
        store: 'ASICS',
        url,
        image: image || null,
        gender,                                     // CHANGED: now lowercase
        shoeType: detectShoeType(cleanTitle, model), // NEW
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

    // quick diagnostic: how many missing images
    const missingImages = products.filter(p => !p.image).length;
    console.log(`[ASICS] ${description}: Found ${products.length} products (${missingImages} missing images)`);

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

  const missingImagesTotal = uniqueProducts.filter(p => !p.image).length;
  console.log(`[ASICS] Total unique products: ${uniqueProducts.length} (${missingImagesTotal} missing images)`);
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

  //TEMPORARY TURNED OFF FOR DEBUGGING
  //const cronSecret = process.env.CRON_SECRET;
  //if (cronSecret && req.headers['x-cron-secret'] !== cronSecret) {
  //  return res.status(401).json({ error: 'Unauthorized' });
  //}

  const start = Date.now();

  try {
    const { products: deals, pageResults } = await scrapeAllAsicsSales();

    const output = {
      lastUpdated: new Date().toISOString(),
      store: 'ASICS',
      segments: ["Men's Clearance", "Women's Clearance", 'Last Chance Styles'],
      totalDeals: deals.length,
      dealsByGender: {
        mens: deals.filter(d => d.gender === 'mens').length,      // CHANGED to lowercase
        womens: deals.filter(d => d.gender === 'womens').length,  // CHANGED to lowercase
        unisex: deals.filter(d => d.gender === 'unisex').length,  // CHANGED to lowercase
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
