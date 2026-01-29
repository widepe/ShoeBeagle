// api/scrapers/brooks-sale.js
// FINAL FIX - Uses data attributes which actually contain the product info

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');
const { put } = require('@vercel/blob');

/**
 * Detect gender from product title or URL
 */
function detectGender(title, url) {
  const titleLower = (title || '').toLowerCase();
  const urlLower = (url || '').toLowerCase();
  const combined = titleLower + ' ' + urlLower;

  // Brooks patterns
  if (/\b(men'?s?|male)\b/i.test(combined)) return 'mens';
  if (/\b(women'?s?|female|ladies)\b/i.test(combined)) return 'womens';
  if (/\bunisex\b/i.test(combined)) return 'unisex';

  return 'unknown';
}

/**
 * Detect shoe type from title or model
 */
function detectShoeType(title, model) {
  const combined = ((title || '') + ' ' + (model || '')).toLowerCase();

  // Trail indicators
  if (/\b(trail|cascadia|caldera|catamount)\b/i.test(combined)) {
    return 'trail';
  }

  // Track/spike indicators
  if (/\b(track|spike|hyperion|elite)\b/i.test(combined)) {
    return 'track';
  }

  // Road is default for Brooks (most Brooks shoes are road running)
  // Common models: Ghost, Glycerin, Adrenaline, Launch, Levitate, etc.
  return 'road';
}

function extractBrooksProducts(html) {
  const $ = cheerio.load(html);
  const products = [];
  
  // Brooks uses: o-products-grid__item for product containers
  $('.o-products-grid__item').each((i, el) => {
    const $product = $(el);
    const $content = $product.find('.o-products-grid__item-content');
    
    // Get title from data attribute!
    const title = $content.attr('data-cnstrc-item-name');
    const productId = $content.attr('data-pid');
    
    if (!title) return; // Skip if no title
    
    // Get prices - try multiple methods
    let salePrice = null;
    let price = null;
    
    // Method 1: Try standard price classes
    const $priceContainer = $product.find('.m-product-tile__price-container, .price-container, [class*="price"]');
    
    // Look for sale/current price in multiple places
    const salePriceText = (
      $priceContainer.find('.price-sales').text().trim() ||
      $priceContainer.find('.sales').text().trim() ||
      $priceContainer.find('[class*="sale"]').text().trim() ||
      $product.find('.price-sales, .sales, [class*="sale-price"]').text().trim()
    );
    
    // Look for original/list price
    const origPriceText = (
      $priceContainer.find('.price-list').text().trim() ||
      $priceContainer.find('[class*="list"]').text().trim() ||
      $priceContainer.find('[class*="original"]').text().trim() ||
      $product.find('.price-list, [class*="original-price"]').text().trim()
    );
    
    // Method 2: Parse from all price-related text if Method 1 failed
    if (!salePriceText && !origPriceText) {
      const allPriceText = $product.find('[class*="price"]').text();
      const allPrices = allPriceText.match(/\$(\d+(?:\.\d{2})?)/g);
      
      if (allPrices && allPrices.length >= 2) {
        // Multiple prices found - assume first is original, second is sale
        price = parseFloat(allPrices[0].replace('$', ''));
        salePrice = parseFloat(allPrices[1].replace('$', ''));
      } else if (allPrices && allPrices.length === 1) {
        // Only one price - treat as current price
        salePrice = parseFloat(allPrices[0].replace('$', ''));
      }
    } else {
      // Parse prices from the text we found
      if (salePriceText) {
        const priceMatch = salePriceText.match(/\$?\s*(\d+(?:\.\d{2})?)/);
        if (priceMatch) salePrice = parseFloat(priceMatch[1]);
      }
      
      if (origPriceText) {
        const origMatch = origPriceText.match(/\$?\s*(\d+(?:\.\d{2})?)/);
        if (origMatch) price = parseFloat(origMatch[1]);
      }
    }
    
    // Ensure prices make sense (sale should be lower than original)
    if (salePrice && price && salePrice > price) {
      [salePrice, price] = [price, salePrice];
    }
    
    // Get URL - try multiple selectors
    let url = (
      $product.find('a.m-product-tile__link').first().attr('href') ||
      $product.find('a[href*="/products/"]').first().attr('href') ||
      $product.find('a[href*="/p/"]').first().attr('href') ||
      $product.find('a').first().attr('href')
    );
    
    // Get image
    const image = (
      $product.find('img.m-product-tile__image').first().attr('src') ||
      $product.find('img').first().attr('src') ||
      $product.find('img').first().attr('data-src')
    );
    
    // Extract model from title (the title from data attribute is just the model name)
    const model = title.replace(/^Brooks\s+/i, '').trim();
    
    // Create full title: Brand + Model (to match other scrapers like "ASICS GEL-NIMBUS 27")
    const fullTitle = `Brooks ${model}`;
    
    // Absolutize URL and image
    const absoluteUrl = url ? (url.startsWith('http') ? url : `https://www.brooksrunning.com${url}`) : null;
    const absoluteImage = image ? (image.startsWith('http') ? image : `https://www.brooksrunning.com${image}`) : null;
    
    products.push({
      title: fullTitle,                           // "Brooks Glycerin 22"
      brand: 'Brooks',
      model: model,                               // "Glycerin 22"
      salePrice,                                  // CHANGED from 'price'
      price,                                      // CHANGED from 'originalPrice'
      store: 'Brooks Running',
      url: absoluteUrl,
      image: absoluteImage,
      gender: detectGender(fullTitle, absoluteUrl), // NEW
      shoeType: detectShoeType(fullTitle, model),   // NEW
    });
  });
  
  return products;
}

async function scrapeBrooksSale() {
  const app = new FirecrawlApp({ 
    apiKey: process.env.FIRECRAWL_API_KEY 
  });
  
  console.log('Starting Brooks scrape with Firecrawl...');
  
  const scrapeResult = await app.scrapeUrl(
    'https://www.brooksrunning.com/en_us/sale/?prefn1=productType&prefv1=Shoes',
    {
      formats: ['html'],
      waitFor: 5000,
      timeout: 30000
    }
  );
  
  console.log('Firecrawl scrape complete, parsing HTML...');
  const products = extractBrooksProducts(scrapeResult.html);
  console.log(`Found ${products.length} products`);
  
  return products;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  //TEMPORARY TURN OFF FOR DEBUGGING
  //const cronSecret = process.env.CRON_SECRET;
  //if (cronSecret && req.headers['x-cron-secret'] !== cronSecret) {
  //  return res.status(401).json({ error: 'Unauthorized' });
  //}
  
  const start = Date.now();
  
  try {
    const deals = await scrapeBrooksSale();
    
    const output = {
      lastUpdated: new Date().toISOString(),
      store: 'Brooks Running',
      segment: 'sale-shoes',
      totalDeals: deals.length,
      deals: deals
    };
    
    const blob = await put('brooks-sale.json', JSON.stringify(output, null, 2), {
      access: 'public',
      addRandomSuffix: false
    });
    
    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      blobUrl: blob.url,
      duration: `${Date.now() - start}ms`,
      timestamp: output.lastUpdated
    });
    
  } catch (error) {
    console.error('Error in Brooks scraper:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`
    });
  }
};
