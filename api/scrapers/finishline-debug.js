// api/scrapers/finishline-debug.js
// Debug endpoint to see what HTML Firecrawl returns

const FirecrawlApp = require('@mendable/firecrawl-js').default;

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

  try {
    const app = new FirecrawlApp({
      apiKey: process.env.FIRECRAWL_API_KEY,
    });

    const url = 'https://www.finishline.com/plp/all-sale/gender=men+gender=women+category=shoes+activity=running';

    console.log('[Debug] Fetching:', url);

    const scrapeResult = await app.scrapeUrl(url, {
      formats: ['html', 'markdown'],
      waitFor: 10000, // Wait 10 seconds
      timeout: 60000,
    });

    // Return first 10000 characters of HTML to inspect
    const htmlPreview = scrapeResult.html ? scrapeResult.html.substring(0, 10000) : 'No HTML';
    const markdownPreview = scrapeResult.markdown ? scrapeResult.markdown.substring(0, 5000) : 'No markdown';

    return res.status(200).json({
      success: true,
      htmlLength: scrapeResult.html ? scrapeResult.html.length : 0,
      htmlPreview,
      markdownPreview,
      hasProducts: scrapeResult.html ? scrapeResult.html.includes('product') : false,
      hasPrices: scrapeResult.html ? scrapeResult.html.includes('$') : false,
    });
  } catch (error) {
    console.error('[Debug] Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};
