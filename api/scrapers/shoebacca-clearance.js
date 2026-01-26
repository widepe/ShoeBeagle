// api/scrapers/shoebacca-clearance.js
// Scrapes Shoebacca clearance athletic running shoes using Shopify JSON API
// UPDATED: now records scraped URLs (pageResults), timestamp, and duration like ASICS

const { put } = require('@vercel/blob');

/**
 * Detect shoe type from product tags and title
 * Matches logic from ASICS scraper
 */
function detectShoeType(product) {
  const tags = (product.tags || []).map(tag => tag.toLowerCase());
  const title = (product.title || '').toLowerCase();
  const combined = [...tags, title].join(' ');

  if (/\b(trail|mountain|off-road|hiking)\b/.test(combined)) return 'trail';
  if (/\b(track|spike|racing|carbon)\b/.test(combined)) return 'track';
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
  const allText = [...tags, title, vendor].join(' ');

  const hasMens =
    /\bmen'?s\b/i.test(allText) ||
    /\bmale\b/i.test(allText) ||
    tags.includes('men') ||
    tags.includes('mens');

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

  if (hasMens && hasWomens) return 'unisex';
  if (hasMens) return 'mens';
  if (hasWomens) return 'womens';
  return 'unisex';
}

/**
 * Extract brand from vendor or title
 */
function extractBrand(product) {
  const vendor = product.vendor || '';
  if (vendor && vendor !== 'Unknown') return vendor;

  const title = product.title || '';
  const commonBrands = [
    'Nike', 'Adidas', 'ASICS', 'Brooks', 'New Balance',
    'Hoka', 'HOKA', 'Saucony', 'Mizuno', 'On', 'Altra',
    'Salomon', 'Reebok', 'Under Armour', 'Puma', 'Skechers',
    'Topo Athletic', 'Karhu', 'Diadora', 'Newton'
  ];

  for (const brand of commonBrands) {
    if (title.toLowerCase().includes(brand.toLowerCase())) return brand;
  }

  return 'Unknown';
}

/**
 * Extract model name from title (remove brand prefix and gender suffixes)
 */
function extractModel(title, brand) {
  if (!title) return '';

  let model = title;

  if (brand && brand !== 'Unknown') {
    const brandRegex = new RegExp(`^${brand}\\s+`, 'i');
    model = model.replace(brandRegex, '');
  }

  return model
    .replace(/\s+men's$/i, '')
    .replace(/\s+women's$/i, '')
    .replace(/\s+unisex$/i, '')
    .replace(/\s+running\s+shoe(s)?$/i, '')
    .trim();
}

/**
 * Get best image URL from Shopify product
 */
function getBestImageUrl(product) {
  if (product.image?.src) return product.image.src;

  if (product.images && product.images.length > 0) {
    const firstImg = product.images[0];
    return typeof firstImg === 'string' ? firstImg : firstImg.src || null;
  }

  if (product.featured_image) return product.featured_image;

  return null;
}

/**
 * Scrape a single page from Shopify products.json
 * UPDATED: returns fetchUrl + request duration, and can report errors in pageResults
 */
async function scrapeShoebaccaPage(baseUrl, page = 1) {
  const fetchUrl = `${baseUrl}/products.json?page=${page}&limit=250`;

  console.log(`[Shoebacca] Fetching page ${page}: ${fetchUrl}`);

  const startedAt = Date.now();

  try {
    const response = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const fetchDurationMs = Date.now() - startedAt;

    if (!response.ok) {
      console.error(`[Shoebacca] HTTP ${response.status} for page ${page}`);
      return {
        products: [],
        hasMore: false,
        success: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        url: fetchUrl,
        durationMs: fetchDurationMs,
      };
    }

    const data = await response.json();
    const products = data.products || [];
    const hasMore = products.length > 0;

    console.log(`[Shoebacca] Page ${page}: Found ${products.length} raw products (${fetchDurationMs}ms)`);

    return {
      products,
      hasMore,
      success: true,
      status: response.status,
      error: null,
      url: fetchUrl,
      durationMs: fetchDurationMs,
    };
  } catch (error) {
    const fetchDurationMs = Date.now() - startedAt;
    console.error(`[Shoebacca] Error fetching page ${page}:`, error.message);
    return {
      products: [],
      hasMore: false,
      success: false,
      status: null,
      error: error.message,
      url: fetchUrl,
      durationMs: fetchDurationMs,
    };
  }
}

/**
 * Scrape all pages with pagination
 * UPDATED: collects pageResults (urls, counts, per-page duration, errors)
 */
async function scrapeAllPages(collectionUrl) {
  const allProducts = [];
  const pageResults = [];

  let page = 1;
  let hasMore = true;

  while (hasMore && page <= 10) { // Safety limit
    const result = await scrapeShoebaccaPage(collectionUrl, page);

    pageResults.push({
      page: `products.json page=${page}`,
      success: result.success,
      count: result.products.length,
      error: result.error || null,
      url: result.url,
      duration: `${result.durationMs}ms`,
      status: result.status,
    });

    if (result.products.length > 0) {
      allProducts.push(...result.products);
      page++;
    }

    hasMore = result.hasMore;

    // polite delay if there may be another page
    if (hasMore) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.log(`[Shoebacca] Scraped ${page - 1} pages, ${allProducts.length} total products`);
  return { allProducts, pageResults };
}

/**
 * Filter products for running shoes only and transform to 10-field schema
 */
function filterAndTransformProducts(products) {
  const filtered = [];

  for (const product of products) {
    const tags = (product.tags || []).map(tag => tag.toLowerCase());
    const productType = (product.product_type || '').toLowerCase();
    const titleLower = (product.title || '').toLowerCase();

    const isRunning =
      tags.includes('running') ||
      productType.includes('running') ||
      titleLower.includes('running');

    if (!isRunning) continue;

    const gender = detectGender(product);

    const variant = product.variants?.[0];
    if (!variant) continue;

    const salePrice = variant.price ? parseFloat(variant.price) : null;
    const price = variant.compare_at_price ? parseFloat(variant.compare_at_price) : null;

    if (!salePrice) continue;
    if (price && salePrice >= price) continue;

    const url = `https://www.shoebacca.com/products/${product.handle}`;

    const brand = extractBrand(product);
    const model = extractModel(product.title, brand);
    const image = getBestImageUrl(product);
    const shoeType = detectShoeType(product);

    filtered.push({
      title: product.title || '',
      brand,
      model,
      salePrice,
      price,
      store: 'Shoebacca',
      url,
      image: image || null,
      gender,
      shoeType,
    });
  }

  return filtered;
}

/**
 * Main scraper function
 * UPDATED: returns pageResults and source collectionUrl
 */
async function scrapeShoebaccaClearance() {
  console.log('[Shoebacca] Starting clearance scrape...');

  const collectionUrl = 'https://www.shoebacca.com/collections/clearance-athletic';

  try {
    const { allProducts: rawProducts, pageResults } = await scrapeAllPages(collectionUrl);
    console.log(`[Shoebacca] Total raw products scraped: ${rawProducts.length}`);

    const products = filterAndTransformProducts(rawProducts);
    console.log(`[Shoebacca] Filtered to ${products.length} running shoes`);

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
    const missingOriginalPrices = products.filter(p => !p.price).length;

    console.log(`[Shoebacca] By Gender:`, byGender);
    console.log(`[Shoebacca] By Shoe Type:`, byShoeType);
    console.log(`[Shoebacca] Missing images: ${missingImages}`);
    console.log(`[Shoebacca] Missing original prices: ${missingOriginalPrices}`);

    return {
      products,
      byGender,
      byShoeType,
      pageResults,
      sourceCollectionUrl: collectionUrl,
    };
  } catch (error) {
    console.error('[Shoebacca] Fatal error:', error);
    throw error;
  }
}

/**
 * Vercel handler
 * UPDATED: returns pageResults + sourceCollectionUrl like ASICS does
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  const providedSecret =
    req.headers['x-cron-secret'] ||
    req.headers.authorization?.replace('Bearer ', '');

  if (cronSecret && providedSecret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const start = Date.now();

  try {
    const {
      products: deals,
      byGender,
      byShoeType,
      pageResults,
      sourceCollectionUrl,
    } = await scrapeShoebaccaClearance();

    const output = {
      lastUpdated: new Date().toISOString(),
      store: 'Shoebacca',
      segments: ['Clearance Athletic - Running Shoes'],
      sourceCollectionUrl,     // NEW: top-level source
      totalDeals: deals.length,
      dealsByGender: byGender,
      dealsByShoeType: byShoeType,
      pageResults,             // NEW: per-page urls, counts, per-page duration/errors
      deals,
    };

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
      pageResults,            // NEW
      sourceCollectionUrl,    // NEW
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
