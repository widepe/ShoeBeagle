// api/scrapers/rununited-sale-debug.js
// Debug scraper to inspect  Run United's  HTML structure

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');

module.exports = async (req, res) => {
  try {
    const app = new FirecrawlApp({ 
      apiKey: process.env.FIRECRAWL_API_KEY 
    });
    
    const url = 'https://rununited.com/sale/?rb_custom_field_c35c669bb6d94ec8e66ac9e9873f0a4d=Shoes&rb_custom_field_69a256025f66e4ce5d15c9dd7225d357=Running&tab=products';
    
    console.log('[DEBUG] Fetching Run United page...');
    
    const scrapeResult = await app.scrapeUrl(url, {
      formats: ['html'],
      waitFor: 5000,
      timeout: 30000
    });
    
    const $ = cheerio.load(scrapeResult.html);
    
    // Find potential product containers
    const selectors = [
      '.product-item',
      '.product-card',
      '.product',
      '[class*="product"]',
      'article',
      '.item',
      '[data-product-id]',
      '.grid-item',
      '.card'
    ];
    
    const selectorResults = {};
    for (const selector of selectors) {
      const count = $(selector).length;
      if (count > 0) {
        selectorResults[selector] = {
          count,
          sampleHTML: $(selector).first().html()?.substring(0, 500)
        };
      }
    }
    
    // Get first potential product for inspection
    let $firstProduct = null;
    let usedSelector = null;
    
    for (const selector of selectors) {
      const $el = $(selector).first();
      if ($el.length > 0) {
        $firstProduct = $el;
        usedSelector = selector;
        break;
      }
    }
    
    const debug = {
      url,
      pageTitle: $('title').text(),
      totalElements: {
        divs: $('div').length,
        articles: $('article').length,
        links: $('a').length,
        images: $('img').length
      },
      selectorResults,
      firstProductAnalysis: $firstProduct ? {
        selector: usedSelector,
        text: $firstProduct.text().substring(0, 300),
        html: $firstProduct.html()?.substring(0, 800),
        links: $firstProduct.find('a').map((_, el) => $(el).attr('href')).get(),
        images: $firstProduct.find('img').map((_, el) => ({
          src: $(el).attr('src'),
          alt: $(el).attr('alt')
        })).get(),
        prices: $firstProduct.text().match(/\$\d+(?:\.\d{2})?/g)
      } : null,
      bodyPreview: $('body').html()?.substring(0, 2000)
    };
    
    return res.status(200).json({
      success: true,
      debug
    });
    
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
};
