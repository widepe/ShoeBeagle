// api/scrapers/rununited-sale.js
// Scrapes Run United sale page for running shoes
// Uses Firecrawl for JavaScript-rendered content

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');
const { put } = require('@vercel/blob');

/**
 * Extract products from Run United sale page  HTML 
 */
function extractRunUnitedProducts(html, sourceUrl) {
  const $ = cheerio.load(html);
  const products = [];
  
  console.log('[RUN UNITED] Starting product extraction...');
  
  // TODO: Need to identify the correct product selectors
  // Common patterns to try:
  const potentialSelectors = [
    '.product-item',
    '.product-card', 
    '.product',
    '[class*="product"]',
    'article',
    '.item',
    '[data-product-id]'
  ];
  
  // Try each selector to find products
  let $products = null;
  for (const selector of potentialSelectors) {
    $products = $(selector);
    if ($products.length > 0) {
      console.log(`[RUN UNITED] Found ${$products.length} products with selector: ${selector}`);
      break;
    }
  }
  
  if (!$products || $products.length === 0) {
    console.log('[RUN UNITED] No products found with standard selectors');
    return products;
  }
  
  $products.each((i, el) => {
    const $product = $(el);
    
    // Extract title (try multiple selectors)
    let title = 
      $product.find('h2, h3, h4, .product-title, .title, [class*="title"]').first().text().trim() ||
      $product.find('a').first().attr('title') ||
      $product.find('img').first().attr('alt') ||
      '';
    
    if (!title || title.length < 3) return;
    
    // Extract URL
    let url = $product.find('a').first().attr('href');
    if (url && !url.startsWith('http')) {
      url = url.startsWith('/') ? `https://rununited.com${url}` : `https://rununited.com/${url}`;
    }
    
    // Extract prices
    const priceText = $product.text();
    const priceMatches = priceText.match(/\$(\d+(?:\.\d{2})?)/g);
    
    let price = null;
    let originalPrice = null;
    
    if (priceMatches && priceMatches.length >= 2) {
      // Multiple prices found - assume first is original, last is sale
      originalPrice = parseFloat(priceMatches[0].replace('$', ''));
      price = parseFloat(priceMatches[priceMatches.length - 1].replace('$', ''));
    } else if (priceMatches && priceMatches.length === 1) {
      price = parseFloat(priceMatches[0].replace('$', ''));
    }
    
    // Swap if sale price is higher (incorrect order)
    if (price && originalPrice && price > originalPrice) {
      [price, originalPrice] = [originalPrice, price];
    }
    
    // Extract image
    const $img = $product.find('img').first();
    let image = (
      $img.attr('src') ||
      $img.attr('data-src') ||
      $img.attr('data-lazy-src') ||
      null
    );
    
    if (image && !image.startsWith('http')) {
      if (image.startsWith('//')) {
        image = `https:${image}`;
      } else if (image.startsWith('/')) {
        image = `https://rununited.com${image}`;
      }
    }
    
    // Skip placeholder images
    if (image && (image.startsWith('data:') || image.includes('placeholder'))) {
      image = null;
    }
    
    // Calculate discount
    const discount = originalPrice && price && originalPrice > price ?
      Math.round(((originalPrice - price) / originalPrice) * 100) : null;
    
    // Extract brand from title (common pattern: "Brand Model Name")
    const brandMatch = title.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+/);
    const brand = brandMatch ? brandMatch[1] : 'Unknown';
    const model = brandMatch ? title.replace(brandMatch[0], '').trim() : title;
    
    if (title && url && (price || originalPrice)) {
      products.push({
        title,
        brand,
        model,
        store: 'Run United',
        price,
        originalPrice,
        discount: discount ? `${discount}%` : null,
        url,
        image,
        scrapedAt: new Date().toISOString()
      });
    }
  });
  
  console.log(`[RUN UNITED] Extracted ${products.length} valid products`);
  return products;
}

/**
 * Scrape Run United sale page with pagination
 */
async function scrapeRunUnitedSale() {
  const app = new FirecrawlApp({ 
    apiKey: process.env.FIRECRAWL_API_KEY 
  });
  
  const baseUrl = 'https://rununited.com/sale/?rb_custom_field_c35c669bb6d94ec8e66ac9e9873f0a4d=Shoes&rb_custom_field_69a256025f66e4ce5d15c9dd7225d357=Running&tab=products';
  
  console.log('[RUN UNITED] Starting scrape...');
  
  try {
    // Start with first page to see how many products exist
    const scrapeResult = await app.scrapeUrl(baseUrl, {
      formats: ['html'],
      waitFor: 5000, // Wait 5 seconds for JavaScript to load
      timeout: 30000
    });
    
    const products = extractRunUnitedProducts(scrapeResult.html, baseUrl);
    
    console.log(`[RUN UNITED] Total products found: ${products.length}`);
    
    return {
      success: true,
      products,
      count: products.length,
      url: baseUrl
    };
    
  } catch (error) {
    console.error('[RUN UNITED] Scrape error:', error.message);
    return {
      success: false,
      products: [],
      count: 0,
      error: error.message
    };
  }
}

/**
 * Main handler
 */
module.exports = async (req, res) => {
  // START TIMER: Track scrape duration
  const start = Date.now();
  
  try {
    console.log('[RUN UNITED] Scraper triggered');
    
    const result = await scrapeRunUnitedSale();
    
    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error,
        totalDeals: 0
      });
    }
    
    // Build output for blob storage
    const output = {
      lastUpdated: new Date().toISOString(),
      store: 'Run United',
      segment: 'sale-shoes',
      totalDeals: result.count,
      deals: result.products
    };
    
    // Save to Vercel blob
    const blob = await put('rununited-sale.json', JSON.stringify(output, null, 2), {
      access: 'public',
      addRandomSuffix: false
    });
    
    const duration = Date.now() - start;
    
    console.log(`[RUN UNITED] Complete! ${result.count} products in ${duration}ms`);
    
    return res.status(200).json({
      success: true,
      totalDeals: result.count,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated
    });
    
  } catch (error) {
    console.error('[RUN UNITED] Fatal error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      totalDeals: 0
    });
  }
};
