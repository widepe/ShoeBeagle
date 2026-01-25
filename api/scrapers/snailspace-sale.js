// api/scrapers/snailspace-sale.js
// Scrapes A Snail's Pace Running Shop sale page using Firecrawl
// URL: https://shop.asnailspace.net/category/964/sale
// Matches 10-field schema used by other scrapers

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');
const { put } = require('@vercel/blob');

/**
 * Detect shoe type from title
 */
function detectShoeType(title) {
  const titleLower = (title || '').toLowerCase();

  // Trail indicators
  if (/\b(trail|speedgoat|peregrine|hierro|wildcat|terraventure|speedcross|trabuco)\b/i.test(titleLower)) {
    return 'trail';
  }

  // Track/spike indicators
  if (/\b(track|spike|dragonfly|metaspeed|endorphin pro)\b/i.test(titleLower)) {
    return 'track';
  }

  // Road is default
  return 'road';
}

/**
 * Detect gender from title and category
 */
function detectGender(title, category) {
  const titleLower = (title || '').toLowerCase();
  const categoryLower = (category || '').toLowerCase();
  const combined = titleLower + ' ' + categoryLower;

  // Check for explicit gender markers
  if (/\b(men'?s?|male|boys?)\b/i.test(combined)) return 'mens';
  if (/\b(women'?s?|female|ladies|girls?)\b/i.test(combined)) return 'womens';
  if (/\b(unisex|kids?|youth)\b/i.test(combined)) return 'unisex';

  return 'unisex';
}

/**
 * Extract brand from title
 */
function extractBrand(title) {
  if (!title) return 'Unknown';

  const commonBrands = [
    'Nike', 'Adidas', 'ASICS', 'Asics', 'Brooks', 'New Balance', 
    'Hoka', 'HOKA', 'Saucony', 'Mizuno', 'On', 'Altra',
    'Salomon', 'Reebok', 'Under Armour', 'Puma', 'Skechers',
    'Topo Athletic', 'Karhu', 'Diadora', 'Newton', 'Rabbit',
    'Feetures', 'BALEGA', 'Vuori', 'OISELLE', 'FLEKS'
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

  // Remove common suffixes
  model = model
    .replace(/\s+-\s+(men'?s?|women'?s?)$/i, '')
    .replace(/\s+men'?s?$/i, '')
    .replace(/\s+women'?s?$/i, '')
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
 * Extract products from A Snail's Pace HTML
 */
function extractSnailsPaceProducts(html) {
  const $ = cheerio.load(html);
  const products = [];

  console.log('[Snails Pace] Parsing HTML...');

  // Products appear in a grid with specific structure
  // Look for product containers with SALE indicator
  const $saleItems = $('*:contains("SALE")').closest('div, article, li');
  
  console.log(`[Snails Pace] Found ${$saleItems.length} items with SALE indicator`);

  const seenNames = new Set();

  $saleItems.each((i, el) => {
    const $item = $(el);
    
    // Get the full text of this item
    const itemText = $item.text();
    
    // Skip if doesn't look like a product (too short or no price)
    if (!itemText.includes('$') || itemText.length < 10) return;

    // Extract title - usually appears after SALE and before price
    // Pattern: SALE\n<title>\n<brand>\n$<price>
    const lines = itemText.split('\n').map(l => l.trim()).filter(Boolean);
    
    let title = '';
    let brand = '';
    
    // Find the product name (after SALE, before brand/price)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Skip "SALE" line
      if (line === 'SALE') continue;
      
      // Skip if it's a price
      if (line.startsWith('$')) break;
      
      // This should be the title
      if (!title && line.length > 3 && !line.includes('$')) {
        title = line;
      } else if (title && !brand && line.length > 2 && !line.includes('$')) {
        // Next non-price line after title is often the brand
        brand = line;
        break;
      }
    }

    if (!title || title.length < 3) return;

    // Skip duplicates
    if (seenNames.has(title)) return;
    seenNames.add(title);

    // Extract prices from text
    const priceMatches = itemText.match(/\$\s*[\d,.]+/g);
    
    let salePrice = null;
    let price = null;

    if (priceMatches && priceMatches.length >= 2) {
      // Two prices: original and sale
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

    // Try to find product link
    const $link = $item.find('a[href*="/product/"]').first();
    let url = $link.attr('href') || '';
    if (url && !url.startsWith('http')) {
      url = `https://shop.asnailspace.net${url}`;
    }

    // If no URL found, skip
    if (!url) return;

    // Get image
    let image = 
      $item.find('img').first().attr('src') ||
      $item.find('img').first().attr('data-src') ||
      null;

    // Make image URL absolute
    if (image && !image.startsWith('http')) {
      if (image.startsWith('//')) {
        image = `https:${image}`;
      } else if (image.startsWith('/')) {
        image = `https://shop.asnailspace.net${image}`;
      }
    }

    // Extract brand from title or use detected brand
    const extractedBrand = brand || extractBrand(title);
    const model = extractModel(title, extractedBrand);

    // Detect gender and shoe type
    const gender = detectGender(title, itemText);
    const shoeType = detectShoeType(title);

    // Only include footwear (skip apparel)
    const isFootwear = /\b(shoe|sneaker|running|trainer|spike|boot|sandal|slide)\b/i.test(title);
    if (!isFootwear) {
      console.log(`[Snails Pace] Skipping non-footwear: ${title}`);
      return;
    }

    console.log(`[Snails Pace] ✓ Added: ${title} - $${salePrice}`);

    products.push({
      title: title.trim(),
      brand: extractedBrand,
      model,
      salePrice,
      price,
      store: "A Snail's Pace",
      url,
      image,
      gender,
      shoeType,
    });
  });

  console.log(`[Snails Pace] Extracted ${products.length} products`);
  return products;
}

/**
 * Scrape A Snail's Pace sale page
 */
async function scrapeSnailsPaceSale() {
  const app = new FirecrawlApp({
    apiKey: process.env.FIRECRAWL_API_KEY,
  });

  console.log("[Snails Pace] Starting scrape...");

  const url = 'https://shop.asnailspace.net/category/964/sale';

  try {
    console.log(`[Snails Pace] Fetching: ${url}`);

    const scrapeResult = await app.scrapeUrl(url, {
      formats: ['html'],
      waitFor: 8000, // Wait 8 seconds for content to load
      timeout: 45000,
    });

    const products = extractSnailsPaceProducts(scrapeResult.html);

    const missingImages = products.filter(p => !p.image).length;
    const missingPrices = products.filter(p => !p.price).length;

    console.log(`[Snails Pace] Found ${products.length} products`);
    console.log(`[Snails Pace] Missing images: ${missingImages}`);
    console.log(`[Snails Pace] Missing original prices: ${missingPrices}`);

    return {
      success: true,
      products,
      count: products.length,
    };
  } catch (error) {
    console.error('[Snails Pace] Error scraping:', error.message);
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
    const { products: deals, success, error } = await scrapeSnailsPaceSale();

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
      store: "A Snail's Pace",
      segments: ['Sale'],
      totalDeals: deals.length,
      dealsByGender: byGender,
      dealsByShoeType: byShoeType,
      deals,
    };

    // Save to Vercel Blob
    const blob = await put('snailspace-sale.json', JSON.stringify(output, null, 2), {
      access: 'public',
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;

    console.log(`[Snails Pace] ✓ Complete! ${deals.length} deals in ${duration}ms`);
    console.log(`[Snails Pace] Blob URL: ${blob.url}`);

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
    console.error('[Snails Pace] Fatal error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`,
    });
  }
};
