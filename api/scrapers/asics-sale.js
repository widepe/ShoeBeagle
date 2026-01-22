// api/scrapers/asics-sale.js
// Scrapes all three ASICS sale pages using Firecrawl
// UPDATED: Better error handling to diagnose women's page failure

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');
const { put } = require('@vercel/blob');

/**
 * Extract products from ASICS HTML
 */
function extractAsicsProducts(html, sourceUrl) {
  const $ = cheerio.load(html);
  const products = [];
  
  // Determine gender from URL
  let gender = 'Unisex';
  if (sourceUrl.includes('mens-clearance')) {
    gender = 'Men';
  } else if (sourceUrl.includes('womens-clearance')) {
    gender = 'Women';
  } else if (sourceUrl.includes('leaving-asics')) {
    gender = 'Unisex';
  }
  
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
    
    // Get image
    const $img = $product.find('img').first();
    let image = $img.attr('src') || $img.attr('data-src');
    if (image && !image.startsWith('http')) {
      image = image.startsWith('//') ? `https:${image}` : `https://www.asics.com${image}`;
    }
    
    // Calculate discount
    const discount = originalPrice && price && originalPrice > price ?
      Math.round(((originalPrice - price) / originalPrice) * 100) : null;
    
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
        image,
        scrapedAt: new Date().toISOString()
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
      timeout: 45000 // 45 second timeout
    });
    
    const products = extractAsicsProducts(scrapeResult.html, baseUrl);
    
    console.log(`[ASICS] ${description}: Found ${products.length} products`);
    
    return { 
      success: true, 
      products, 
      count: products.length,
      url 
    };
    
  } catch (error) {
    console.error(`[ASICS] Error scraping ${description}:`, error.message);
    return { 
      success: false, 
      products: [], 
      count: 0,
      error: error.message,
      url: baseUrl 
    };
  }
}

/**
 * Main scraper - scrapes all 3 ASICS pages SEQUENTIALLY (not parallel)
 * Sequential is more reliable for avoiding rate limits
 */
async function scrapeAllAsicsSales() {
  const app = new FirecrawlApp({ 
    apiKey: process.env.FIRECRAWL_API_KEY 
  });
  
  console.log('[ASICS] Starting scrape of all sale pages (sequential)...');
  
  const pages = [
    {
      url: 'https://www.asics.com/us/en-us/mens-clearance/c/aa10106000/running/shoes/',
      description: "Men's Clearance"
    },
    {
      url: 'https://www.asics.com/us/en-us/womens-clearance/c/aa20106000/running/shoes/',
      description: "Women's Clearance"
    },
    {
      url: 'https://www.asics.com/us/en-us/styles-leaving-asics-com/c/aa60400001/running/shoes/?prefn1=c_productGender&prefv1=Women%7CMen',
      description: "Last Chance Styles"
    }
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
      url: result.url
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
      segments: [
        "Men's Clearance",
        "Women's Clearance", 
        "Last Chance Styles"
      ],
      totalDeals: deals.length,
      dealsByGender: {
        Men: deals.filter(d => d.gender === 'Men').length,
        Women: deals.filter(d => d.gender === 'Women').length,
        Unisex: deals.filter(d => d.gender === 'Unisex').length
      },
      pageResults, // Include per-page diagnostics
      deals: deals
    };
    
    const blob = await put('asics-sale.json', JSON.stringify(output, null, 2), {
      access: 'public',
      addRandomSuffix: false
    });
    
    const duration = Date.now() - start;
    
    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      dealsByGender: output.dealsByGender,
      pageResults, // Show which pages succeeded/failed
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated
    });
    
  } catch (error) {
    console.error('[ASICS] Fatal error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`
    });
  }
};
