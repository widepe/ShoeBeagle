// api/scrapers/shoebacca-clearance.js
// Scrapes Shoebacca clearance athletic running shoes using Shopify JSON API
// Matches exact 10-field schema used by ASICS/Brooks scrapers
// Integrates with merge-deals.js validation pipeline

const { put } = require('@vercel/blob');

/**
 * Detect shoe type from product tags and title
 * Matches logic from ASICS scraper
 */
function detectShoeType(product) {
  const tags = (product.tags || []).map(tag => tag.toLowerCase());
  const title = (product.title || '').toLowerCase();
  const combined = [...tags, title].join(' ');

  // Trail indicators
  if (/\b(trail|mountain|off-road|hiking)\b/.test(combined)) {
    return 'trail';
  }

  // Track/spike indicators
  if (/\b(track|spike|racing|carbon)\b/.test(combined)) {
    return 'track';
  }

  // Road is default for running shoes
  return 'road';
}

/**
 * Detect gender from product tags
 * Returns: 'mens', 'womens', or 'unisex' (lowercase to match ASICS)
 */
function detectGender(product) {
  const tags = (product.tags || []).map(tag => tag.toLowerCase());
  const title = (product.title || '').toLowerCase();
  const vendor = (product.vendor || '').toLowerCase();
  
  // Combine all text for pattern matching
  const allText = [...tags, title, vendor].join(' ');
  
  // Check for men's indicators
  const hasMens = 
    /\bmen'?s\b/i.test(allText) ||
    /\bmale\b/i.test(allText) ||
    tags.includes('men') ||
    tags.includes('mens');
  
  // Check for women's indicators (more patterns)
  const hasWomens = 
    /\bwomen'?s\b/i.test(allText) ||
    /\bwomans\b/i.test(allText) ||
    /\bfemale\b/i.test(allText) ||
    /\bladies\b/i.test(allText) ||
    /\bgirls\b/i.test(allText) ||
    tags.includes('women') ||
    tags.includes('womens') ||
    tags.includes('woman') ||
    tags.includes('ladies');

  // If both explicitly mentioned, it's unisex
  if (hasMens && hasWomens) {
    return 'unisex';
  }

  // If only one is mentioned, use that
  if (hasMens) return 'mens';
  if (hasWomens) return 'womens';

  // Default to unisex if unclear
  return 'unisex';
}

/**
 * Extract brand from vendor or title
 * Uses same brand list as other scrapers
 */
function extractBrand(product) {
  const vendor = product.vendor || '';
  if (vendor && vendor !== 'Unknown') {
    return vendor;
  }

  // Try to extract brand from title
  const title = product.title || '';
  const commonBrands = [
    'Nike', 'Adidas', 'ASICS', 'Brooks', 'New Balance', 
    'Hoka', 'HOKA', 'Saucony', 'Mizuno', 'On', 'Altra',
    'Salomon', 'Reebok', 'Under Armour', 'Puma', 'Skechers',
    'Topo Athletic', 'Karhu', 'Diadora', 'Newton'
  ];

  for (const brand of commonBrands) {
    if (title.toLowerCase().includes(brand.toLowerCase())) {
      return brand;
    }
  }

  return 'Unknown';
}

/**
 * Extract model name from title (remove brand prefix and gender suffixes)
 */
function extractModel(title, brand) {
  if (!title) return '';

  let model = title;

  // Remove brand name from start
  if (brand && brand !== 'Unknown') {
    const brandRegex = new RegExp(`^${brand}\\s+`, 'i');
    model = model.replace(brandRegex, '');
  }

  // Remove common suffixes
  model = model
    .replace(/\s+men's$/i, '')
    .replace(/\s+women's$/i, '')
    .replace(/\s+unisex$/i, '')
    .replace(/\s+running\s+shoe(s)?$/i, '')
    .trim();

  return model;
}

/**
 * Get best image URL from Shopify product
 * Returns absolute URL or null
 */
function getBestImageUrl(product) {
  // Try main image first
  if (product.image?.src) {
    return product.image.src;
  }

  // Try images array
  if (product.images && product.images.length > 0) {
    const firstImg = product.images[0];
    return typeof firstImg === 'string' ? firstImg : firstImg.src || null;
  }

  // Try featured_image
  if (product.featured_image) {
    return product.featured_image;
  }

  return null;
}

/**
 * Scrape a single page from Shopify products.json
 */
async function scrapeShoebaccaPage(baseUrl, page = 1) {
  // Shopify's max limit is 250 products per page
  const url = `${baseUrl}/products.json?page=${page}&limit=250`;

  console.log(`[Shoebacca] Fetching page ${page}...`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      console.error(`[Shoebacca] HTTP ${response.status} for page ${page}`);
      return { products: [], hasMore: false };
    }

    const data = await response.json();
    const products = data.products || [];

    console.log(`[Shoebacca] Page ${page}: Found ${products.length} raw products`);

    // Shopify returns empty array when no more pages
    const hasMore = products.length > 0;

    return { products, hasMore };
  } catch (error) {
    console.error(`[Shoebacca] Error fetching page ${page}:`, error.message);
    return { products: [], hasMore: false };
  }
}

/**
 * Scrape all pages with pagination
 */
async function scrapeAllPages(collectionUrl) {
  const allProducts = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= 10) { // Safety limit of 10 pages
    const { products, hasMore: more } = await scrapeShoebaccaPage(collectionUrl, page);
    
    if (products.length > 0) {
      allProducts.push(...products);
      page++;
      
      // Add delay between requests to be polite
      if (more) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    hasMore = more;
  }

  console.log(`[Shoebacca] Scraped ${page - 1} pages, ${allProducts.length} total products`);
  return allProducts;
}

/**
 * Filter products for running shoes only (Men's/Women's/Unisex)
 * Convert to 10-field schema matching ASICS/Brooks
 * 
 * CRITICAL: Uses salePrice and price (NOT price and originalPrice)
 * This matches the schema expected by merge-deals.js
 */
function filterAndTransformProducts(products) {
  const filtered = [];

  for (const product of products) {
    const tags = (product.tags || []).map(tag => tag.toLowerCase());
    const productType = (product.product_type || '').toLowerCase();
    const title = (product.title || '').toLowerCase();

    // Must be running shoes
    const isRunning = 
      tags.includes('running') || 
      productType.includes('running') ||
      title.includes('running');

    // Skip if not running shoes
    if (!isRunning) continue;

    // Detect gender (keep unisex - merge-deals will handle filtering if needed)
    const gender = detectGender(product);

    // Extract prices
    const variant = product.variants?.[0];
    if (!variant) continue;

    // CRITICAL: salePrice is the current price, price is the original/compare price
    // This matches the schema from ASICS scraper
    const salePrice = variant.price ? parseFloat(variant.price) : null;
    const price = variant.compare_at_price ? parseFloat(variant.compare_at_price) : null;

    // Must have a sale price
    if (!salePrice) continue;

    // Skip if there's no discount (merge-deals will also validate this)
    if (price && salePrice >= price) continue;

    // Get product URL
    const url = `https://www.shoebacca.com/products/${product.handle}`;

    // Extract brand and model
    const brand = extractBrand(product);
    const model = extractModel(product.title, brand);

    // Get image
    const image = getBestImageUrl(product);

    // Detect shoe type
    const shoeType = detectShoeType(product);

    // Check availability
    const available = product.available !== false;

    // Transform to match ASICS schema (10 fields)
    // IMPORTANT: Field order and names must match exactly
    filtered.push({
      title: product.title || '',           // Will be sanitized by merge-deals
      brand,
      model,
      salePrice,                            // Current/sale price
      price,                                // Original/compare price (can be null)
      store: 'Shoebacca',
      url,
      image,                                // Can be null
      gender,                               // 'mens', 'womens', or 'unisex'
      shoeType,                             // 'road', 'trail', or 'track'
    });
  }

  return filtered;
}

/**
 * Main scraper function
 */
async function scrapeShoebaccaClearance() {
  console.log('[Shoebacca] Starting clearance scrape...');

  const collectionUrl = 'https://www.shoebacca.com/collections/clearance-athletic';

  try {
    // Scrape all pages
    const rawProducts = await scrapeAllPages(collectionUrl);
    console.log(`[Shoebacca] Total raw products scraped: ${rawProducts.length}`);

    // Filter and transform to match schema
    const products = filterAndTransformProducts(rawProducts);
    console.log(`[Shoebacca] Filtered to ${products.length} running shoes`);

    // Stats for logging
    const byGender = {
      mens: products.filter(p => p.gender === 'mens').length,
      womens: products.filter(p => p.gender === 'womens').length,
      unisex: products.filter(p => p.gender === 'unisex').length,
    };

    const byShoeType = {
      road: products.filter(p => p.shoeType === 'road').length,
      trail: products.filter(p => p.shoeType === 'trail').length,
      track: products.filter(p => p.shoeType === 'track').length,
    };

    const missingImages = products.filter(p => !p.image).length;
    const missingPrices = products.filter(p => !p.price).length; // Missing original price

    console.log(`[Shoebacca] By Gender:`, byGender);
    console.log(`[Shoebacca] By Shoe Type:`, byShoeType);
    console.log(`[Shoebacca] Missing images: ${missingImages}`);
    console.log(`[Shoebacca] Missing original prices: ${missingPrices}`);

    return { products, byGender, byShoeType };
  } catch (error) {
    console.error('[Shoebacca] Fatal error:', error);
    throw error;
  }
}

/**
 * Vercel handler
 * Matches the response format from ASICS/Brooks scrapers
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Support both x-cron-secret (standard) and authorization header
  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = req.headers['x-cron-secret'] || 
                         req.headers.authorization?.replace('Bearer ', '');
  
  if (cronSecret && providedSecret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const start = Date.now();

  try {
    const { products: deals, byGender, byShoeType } = await scrapeShoebaccaClearance();

    // Match the output format from ASICS scraper
    const output = {
      lastUpdated: new Date().toISOString(),
      store: 'Shoebacca',
      segments: ['Clearance Athletic - Running Shoes'],
      totalDeals: deals.length,
      dealsByGender: byGender,
      dealsByShoeType: byShoeType,
      deals,
    };

    // Save to Vercel Blob (same pattern as ASICS)
    const blob = await put('shoebacca-clearance.json', JSON.stringify(output, null, 2), {
      access: 'public',
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;

    console.log(`[Shoebacca] ✓ Complete! ${deals.length} deals in ${duration}ms`);
    console.log(`[Shoebacca] Blob URL: ${blob.url}`);

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
    console.error('[Shoebacca] Fatal error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`,
    });
  }
};
