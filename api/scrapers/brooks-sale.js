// api/scrapers/brooks-sale-debug.js
// DEBUG VERSION - Returns the HTML so we can inspect it

const FirecrawlApp = require('@mendable/firecrawl-js').default;

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const app = new FirecrawlApp({ 
      apiKey: process.env.FIRECRAWL_API_KEY 
    });
    
    console.log('Fetching Brooks page with Firecrawl...');
    
    const scrapeResult = await app.scrapeUrl(
      'https://www.brooksrunning.com/en_us/sale/?prefn1=productType&prefv1=Shoes',
      {
        formats: ['html', 'markdown'],
        waitFor: 5000, // Wait longer
        timeout: 30000
      }
    );
    
    console.log('Got HTML from Firecrawl');
    
    // Return first 50,000 characters of HTML so we can inspect it
    const htmlPreview = scrapeResult.html.substring(0, 50000);
    
    // Also look for any product-related classes
    const productClasses = [];
    const classMatches = scrapeResult.html.matchAll(/class="([^"]*product[^"]*)"/gi);
    for (const match of classMatches) {
      if (!productClasses.includes(match[1])) {
        productClasses.push(match[1]);
      }
    }
    
    return res.status(200).json({
      success: true,
      htmlLength: scrapeResult.html.length,
      htmlPreview: htmlPreview,
      markdownPreview: scrapeResult.markdown?.substring(0, 5000),
      foundProductClasses: productClasses.slice(0, 20), // First 20 product-related classes
      searchForThese: [
        'Look for product tiles/cards in htmlPreview',
        'Check foundProductClasses for the right selector',
        'Product names, prices should be visible in markdown'
      ]
    });
    
  } catch (error) {
    console.error('Debug error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
};
