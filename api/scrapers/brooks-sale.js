// api/brooks-sale.js
const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');
const { put } = require('@vercel/blob');

function extractBrooksProducts(html) {
  const $ = cheerio.load(html);
  const products = [];
  
  $('.product-tile, .product-grid-item').each((i, el) => {
    const $product = $(el);
    
    const title = (
      $product.find('.product-name').text().trim() ||
      $product.find('.product-tile__name').text().trim() ||
      $product.find('a').attr('title')?.trim()
    );
    
    const priceText = (
      $product.find('.price-sales').text().trim() ||
      $product.find('.sales').text().trim()
    );
    
    const originalPriceText = (
      $product.find('.price-list').text().trim() ||
      $product.find('.strike-through').text().trim()
    );
    
    const url = $product.find('a').first().attr('href');
    const image = (
      $product.find('img').first().attr('src') ||
      $product.find('img').first().attr('data-src')
    );
    
    if (title && priceText) {
      const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));
      const originalPrice = originalPriceText ? 
        parseFloat(originalPriceText.replace(/[^0-9.]/g, '')) : null;
      
      const discount = originalPrice && originalPrice > price ?
        Math.round(((originalPrice - price) / originalPrice) * 100) : null;
      
      const model = title.replace(/^Brooks\s+/i, '').trim();
      
      products.push({
        title,
        brand: 'Brooks',
        model,
        store: 'Brooks Running',
        price: price || null,
        originalPrice: originalPrice || null,
        discount: discount ? `${discount}%` : null,
        url: url ? (url.startsWith('http') ? url : `https://www.brooksrunning.com${url}`) : null,
        image: image ? (image.startsWith('http') ? image : `https://www.brooksrunning.com${image}`) : null,
        scrapedAt: new Date().toISOString()
      });
    }
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
      waitFor: 3000,
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
  
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['x-cron-secret'] !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
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
```

5. Click "Commit new file"

**That's it!** Vercel will automatically deploy and you can test it at:
```
https://your-project.vercel.app/api/brooks-sale
