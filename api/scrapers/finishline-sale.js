// api/scrapers/finishline-sale.js
// Scrapes Finish Line sale running shoes using Firecrawl
// Single page scrape: https://www.finishline.com/plp/all-sale/gender=men+gender=women+category=shoes+activity=running
// Matches 10-field schema used by ASICS/Brooks/Shoebacca scrapers

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');
const { put } = require('@vercel/blob');

/**
 * Detect shoe type from title/tags
 */
function detectShoeType(title) {
  const titleLower = (title || '').toLowerCase();

  // Trail indicators
  if (/\b(trail|mountain|off-road|hiking)\b/i.test(titleLower)) {
    return 'trail';
  }

  // Track/spike indicators
  if (/\b(track|spike|racing|carbon|tempo)\b/i.test(titleLower)) {
    return 'track';
  }

  // Road is default
  return 'road';
}

/**
 * Detect gender from title or URL params
 */
function detectGender(title, productUrl) {
  const titleLower = (title || '').toLowerCase();
  const urlLower = (productUrl || '').toLowerCase();
  const combined = titleLower + ' ' + urlLower;

  // Check for men's indicators
  const hasMens = /\bmen'?s\b/i.test(combined) || /\bmale\b/i.test(combined);
  
  // Check for women's indicators
  const hasWomens = /\bwomen'?s\b/i.test(combined) || 
                    /\bfemale\b/i.test(combined) || 
                    /\bladies\b/i.test(combined);

  // If both mentioned, it's unisex
  if (hasMens && hasWomens) return 'unisex';
  
  if (hasMens) return 'mens';
  if (hasWomens) return 'womens';
  
  return 'unisex';
}

/**
 * Extract brand from title
 */
function extractBrand(title) {
  if (!title) return 'Unknown';

  const commonBrands = [
    'Nike', 'Adidas', 'ASICS', 'Brooks', 'New Balance', 
    'Hoka', 'HOKA', 'Saucony', 'Mizuno', 'On', 'Altra',
    'Salomon', 'Reebok', 'Under Armour', 'Puma', 'Skechers',
    'Topo Athletic', 'Karhu', 'Diadora', 'Newton', 'Jordan',
    'Converse', 'Vans', 'Fila', 'Champion'
  ];

  for (const brand of commonBrands) {
    if (title.toLowerCase().includes(brand.toLowerCase())) {
      return brand;
    }
  }

  // Try to extract first word as brand
  const firstWord = title.trim().split(/\s+/)[0];
  if (firstWord && firstWord.length > 2) {
    return firstWord;
  }

  return 'Unknown';
}

/**
 * Extract model name from title (remove brand)
 */
function extractModel(title, brand) {
  if (!title) return '';

  let model = title;

  // Remove brand name from start
  if (brand && brand !== 'Unknown') {
    const brandRegex = new RegExp(`^${brand}\\s+`, 'i');
    model = model.replace(brandRegex, '');
  }

  // Remove gender suffixes
  model = model
    .replace(/\s+men's$/i, '')
    .replace(/\s+women's$/i, '')
    .replace(/\s+unisex$/i, '')
    .replace(/\s+running\s+shoe(s)?$/i, '')
    .trim();

  return model;
}

/**
 * Parse price string to number
 */
function parsePrice(priceStr) {
  if (!priceStr) return null;
  
  const cleaned = String(priceStr)
    .replace(/[^0-9.]/g, '')
    .trim();
  
  const num = parseFloat(cleaned);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * Extract products from Finish Line HTML
 */
function extractFinishLineProducts(html) {
  const $ = cheerio.load(html);
  const products = [];

  console.log('[Finish Line] Parsing HTML...');

  // Try multiple possible selectors for product cards
  const possibleSelectors = [
    '.product-card',
    '.product-tile',
    '.ProductCard',
    '[data-testid="product-card"]',
    '.product-grid-item',
    'article[class*="product"]',
    'div[class*="ProductCard"]',
    'div[class*="product-card"]',
  ];

  let $products = $();
  for (const selector of possibleSelectors) {
    $products = $(selector);
    if ($products.length > 0) {
      console.log(`[Finish Line] Found ${$products.length} products using selector: ${selector}`);
      break;
    }
  }

  if ($products.length === 0) {
    console.log('[Finish Line] No products found with standard selectors, trying fallback...');
    // Fallback: look for any elements with product-like attributes
    $products = $('[data-product-id], [data-sku], a[href*="/product/"]').closest('div, article, li');
    console.log(`[Finish Line] Fallback found ${$products.length} potential products`);
  }

  $products.each((i, el) => {
    const $product = $(el);

    // Get title
    const title = 
      $product.find('h2, h3, .product-title, .product-name, [class*="title"], [class*="name"]').first().text().trim() ||
      $product.find('a[href*="/product/"]').first().attr('aria-label') ||
      $product.find('img').first().attr('alt') ||
      '';

    if (!title || title.length < 3) return;

    // Get URL
    let url = $product.find('a[href*="/product/"]').first().attr('href') || '';
    if (url && !url.startsWith('http')) {
      url = `https://www.finishline.com${url}`;
    }
    if (!url) return;

    // Get prices
    const priceText = $product.text();
    const priceMatches = priceText.match(/\$(\d+(?:\.\d{2})?)/g);

    let salePrice = null;
    let price = null;

    if (priceMatches && priceMatches.length >= 2) {
      // First price is usually original, second is sale
      price = parsePrice(priceMatches[0]);
      salePrice = parsePrice(priceMatches[1]);
    } else if (priceMatches && priceMatches.length === 1) {
      // Only one price - treat as sale price
      salePrice = parsePrice(priceMatches[0]);
    }

    // Ensure sale price is lower than original
    if (salePrice && price && salePrice > price) {
      [salePrice, price] = [price, salePrice];
    }

    if (!salePrice) return;

    // Get image
    let image = 
      $product.find('img').first().attr('src') ||
      $product.find('img').first().attr('data-src') ||
      $product.find('img').first().attr('data-lazy-src') ||
      null;

    // Make image URL absolute
    if (image && !image.startsWith('http')) {
      if (image.startsWith('//')) {
        image = `https:${image}`;
      } else if (image.startsWith('/')) {
        image = `https://www.finishline.com${image}`;
      }
    }

    // Skip placeholder images
    if (image && (image.includes('placeholder') || image.startsWith('data:'))) {
      image = null;
    }

    // Extract brand and model
    const brand = extractBrand(title);
    const model = extractModel(title, brand);

    // Detect gender and shoe type
    const gender = detectGender(title, url);
    const shoeType = detectShoeType(title);

    products.push({
      title: title.trim(),
      brand,
      model,
      salePrice,
      price,
      store: 'Finish Line',
      url,
      image,
      gender,
      shoeType,
    });
  });

  return products;
}

/**
 * Scrape Finish Line sale page
 */
async function scrapeFinishLineSale() {
  const app = new FirecrawlApp({
    apiKey: process.env.FIRECRAWL_API_KEY,
  });

  console.log('[Finish Line] Starting scrape...');

  const url = 'https://www.finishline.com/plp/all-sale/gender=men+gender=women+category=shoes+activity=running';

  try {
    console.log(`[Finish Line] Fetching: ${url}`);

    const scrapeResult = await app.scrapeUrl(url, {
      formats: ['html'],
      waitFor: 8000, // Wait 8 seconds for products to load
      timeout: 45000, // 45 second timeout
    });

    const products = extractFinishLineProducts(scrapeResult.html);

    const missingImages = products.filter(p => !p.image).length;
    const missingPrices = products.filter(p => !p.price).length;

    console.log(`[Finish Line] Found ${products.length} products`);
    console.log(`[Finish Line] Missing images: ${missingImages}`);
    console.log(`[Finish Line] Missing original prices: ${missingPrices}`);

    return {
      success: true,
      products,
      count: products.length,
    };
  } catch (error) {
    console.error('[Finish Line] Error scraping:', error.message);
    return {
      success: false,
      products: [],
      count: 0,
      error: error.message,
    };
  }
}

/**
 * Vercel handler
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = req.headers['x-cron-secret'] || 
                         req.headers.authorization?.replace('Bearer ', '');
  
  if (cronSecret && providedSecret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const start = Date.now();

  try {
    const { products: deals, success, error } = await scrapeFinishLineSale();

    if (!success) {
      return res.status(500).json({
        success: false,
        error: error || 'Scraping failed',
        duration: `${Date.now() - start}ms`,
      });
    }

    // Calculate stats
    const byGender = {
      mens: deals.filter(d => d.gender === 'mens').length,
      womens: deals.filter(d => d.gender === 'womens').length,
      unisex: deals.filter(d => d.gender === 'unisex').length,
    };

    const byShoeType = {
      road: deals.filter(d => d.shoeType === 'road').length,
      trail: deals.filter(d => d.shoeType === 'trail').length,
      track: deals.filter(d => d.shoeType === 'track').length,
    };

    const output = {
      lastUpdated: new Date().toISOString(),
      store: 'Finish Line',
      segments: ['Sale - Running Shoes'],
      totalDeals: deals.length,
      dealsByGender: byGender,
      dealsByShoeType: byShoeType,
      deals,
    };

    // Save to Vercel Blob
    const blob = await put('finishline-sale.json', JSON.stringify(output, null, 2), {
      access: 'public',
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;

    console.log(`[Finish Line] ✓ Complete! ${deals.length} deals in ${duration}ms`);
    console.log(`[Finish Line] Blob URL: ${blob.url}`);

    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      dealsByGender: byGender,
      dealsByShoeType: byShoeType,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (error) {
    console.error('[Finish Line] Fatal error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`,
    });
  }
};
