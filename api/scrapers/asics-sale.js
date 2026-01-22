// api/scrapers/asics-sale.js
// Scrapes all three ASICS sale pages using Firecrawl
// UPDATED: Handles pagination to get all ~100 products per page

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
  
  console.log(`Found ${$products.length} products with .productTile__root selector`);
  
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
 * Scrape ASICS page with pagination
 * ASICS shows ~24 items initially, but has ~100 total
 * We need to scroll or load more to get all products
 */
async function scrapeAsicsUrlWithPagination(app, baseUrl, description) {
  console.log(`[ASICS] Scraping ${description} with pagination...`);
  
  const allProducts = [];
  
  try {
    // Strategy: Load multiple pages if they use ?page= parameter
    // Or use scrolling if they use infinite scroll
    
    // First, try to get all products by setting a higher item count in URL
    // ASICS often uses ?sz=XX parameter
    const urls = [
      baseUrl, // Original URL (shows 24)
      baseUrl.includes('?') ? `${baseUrl}&sz=96` : `${baseUrl}?sz=96`, // Request 96 items
    ];
    
    for (const url of urls) {
      try {
        console.log(`[ASICS] Fetching: ${url}`);
        
        const scrapeResult = await app.scrapeUrl(url, {
          formats: ['html'],
          waitFor: 7000, // Wait longer for more products to load
          timeout: 40000
        });
        
        const products = extractAsicsProducts(scrapeResult.html, baseUrl);
        
        // Add new unique products
        for (const product of products) {
          if (!allProducts.find(p => p.url === product.url)) {
            allProducts.push(product);
          }
        }
        
        console.log(`[ASICS] ${description}: Cumulative ${allProducts.length} products`);
        
        // If we got close to the requested amount, we got them all
        if (products.length >= 90) {
          console.log(`[ASICS] Got ${products.length} products, that's probably all of them`);
          break;
        }
        
      } catch (error) {
        console.error(`[ASICS] Error fetching ${url}:`, error.message);
      }
    }
    
    console.log(`[ASICS] ${description}: Final count ${allProducts.length} products`);
    return allProducts;
    
  } catch (error) {
    console.error(`[ASICS] Error scraping ${description}:`, error.message);
    return allProducts;
  }
}

/**
 * Main scraper - scrapes all 3 ASICS pages
 */
async function scrapeAllAsicsSales() {
  const app = new FirecrawlApp({ 
    apiKey: process.env.FIRECRAWL_API_KEY 
  });
  
  console.log('[ASICS] Starting scrape of all sale pages...');
  
  const urls = [
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
  
  // Scrape all in parallel
  const results = await Promise.allSettled(
    urls.map(({ url, description }) => 
      scrapeAsicsUrlWithPagination(app, url, description)
    )
  );
  
  // Combine results
  const allProducts = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      allProducts.push(...result.value);
    } else {
      console.error(`[ASICS] Failed ${urls[index].description}:`, result.reason);
    }
  });
  
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
  
  return uniqueProducts;
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
    const deals = await scrapeAllAsicsSales();
    
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
