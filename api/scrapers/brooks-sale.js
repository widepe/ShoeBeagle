// api/scrapers/brooks-sale-debug2.js
// More detailed debug to see what selectors are finding

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');

module.exports = async (req, res) => {
  try {
    const app = new FirecrawlApp({ 
      apiKey: process.env.FIRECRAWL_API_KEY 
    });
    
    console.log('Fetching Brooks...');
    
    const scrapeResult = await app.scrapeUrl(
      'https://www.brooksrunning.com/en_us/sale/?prefn1=productType&prefv1=Shoes',
      {
        formats: ['html'],
        waitFor: 5000,
        timeout: 30000
      }
    );
    
    const $ = cheerio.load(scrapeResult.html);
    
    // Test different selectors
    const tests = {
      'o-products-grid__item': $('.o-products-grid__item').length,
      'product-tile': $('.product-tile').length,
      'product': $('[class*="product"]').length,
      'grid-item': $('[class*="grid-item"]').length,
      'grid__item': $('[class*="grid__item"]').length,
      'Any links': $('a').length,
      'Any images': $('img').length
    };
    
    // Try to find actual product containers
    const sampleProducts = [];
    $('.o-products-grid__item').slice(0, 3).each((i, el) => {
      const $item = $(el);
      sampleProducts.push({
        html: $item.html().substring(0, 500),
        text: $item.text().substring(0, 200),
        classes: $item.attr('class'),
        hasLinks: $item.find('a').length,
        hasImages: $item.find('img').length
      });
    });
    
    // Also check if products are in a different structure
    const alternativeCheck = [];
    $('[class*="product"]').slice(0, 3).each((i, el) => {
      const $item = $(el);
      alternativeCheck.push({
        classes: $item.attr('class'),
        text: $item.text().substring(0, 100)
      });
    });
    
    return res.json({
      success: true,
      selectorTests: tests,
      sampleProducts: sampleProducts,
      alternativeProducts: alternativeCheck,
      htmlContainsGlycerin: scrapeResult.html.includes('Glycerin'),
      htmlContainsAdrenaline: scrapeResult.html.includes('Adrenaline'),
      tip: 'Check sampleProducts to see what HTML structure exists'
    });
    
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
