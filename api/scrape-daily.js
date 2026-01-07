// api/scrape-daily.js
// Daily scraper for running shoe deals
// Runs once per day via Vercel Cron

const axios = require('axios');
const cheerio = require('cheerio');
const { put } = require('@vercel/blob');

/**
 * Main handler - triggered by Vercel Cron
 */
module.exports = async (req, res) => {
  // Security: Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Optional: Verify cron secret
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['x-cron-secret'] !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  console.log('[SCRAPER] Starting daily scrape:', new Date().toISOString());

  try {
    const allDeals = [];
    const scraperResults = {};

    // Scrape Running Warehouse
    try {
      const rwDeals = await scrapeRunningWarehouse();
      allDeals.push(...rwDeals);
      scraperResults['Running Warehouse'] = { success: true, count: rwDeals.length };
      console.log(`[SCRAPER] Running Warehouse: ${rwDeals.length} deals`);
    } catch (error) {
      scraperResults['Running Warehouse'] = { success: false, error: error.message };
      console.error('[SCRAPER] Running Warehouse failed:', error.message);
    }

    // Scrape Zappos
    try {
      await sleep(2000); // Be respectful - 2 second delay between sites
      const zapposDeals = await scrapeZappos();
      allDeals.push(...zapposDeals);
      scraperResults['Zappos'] = { success: true, count: zapposDeals.length };
      console.log(`[SCRAPER] Zappos: ${zapposDeals.length} deals`);
    } catch (error) {
      scraperResults['Zappos'] = { success: false, error: error.message };
      console.error('[SCRAPER] Zappos failed:', error.message);
    }

    // Calculate statistics
    const dealsByStore = {};
    allDeals.forEach(deal => {
      dealsByStore[deal.store] = (dealsByStore[deal.store] || 0) + 1;
    });

    // Prepare output
    const output = {
      lastUpdated: new Date().toISOString(),
      totalDeals: allDeals.length,
      dealsByStore,
      scraperResults,
      deals: allDeals
    };

    // Save to Vercel Blob Storage
    const blob = await put('deals.json', JSON.stringify(output, null, 2), {
      access: 'public'
    });

    console.log('[SCRAPER] Saved to blob:', blob.url);

    const duration = Date.now() - startTime;
    console.log(`[SCRAPER] Complete: ${allDeals.length} deals in ${duration}ms`);

    return res.status(200).json({
      success: true,
      totalDeals: allDeals.length,
      dealsByStore,
      scraperResults,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated
    });

  } catch (error) {
    console.error('[SCRAPER] Fatal error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

/**
 * Scrape Running Warehouse sale page
 */
async function scrapeRunningWarehouse() {
  const deals = [];
  const url = 'https://www.runningwarehouse.com/catpage-SALEMS.html';

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ShoeBeagleBot/1.0; +https://shoebeagle.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);

    $('.cattable-wrap-cell').each((i, element) => {
      const $el = $(element);
      
      const title = $el.find('[data-gtm_impression_name]').first().attr('data-gtm_impression_name') || $el.find('.cattable-wrap-cell-inner').first().text().trim();
      const priceText = $el.find('.price, .sale-price, [class*="price"]').first().text().trim();
      const link = $el.find('a').first().attr('href');
      const image = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src');

      const { brand, model } = parseBrandModel(title);
      const price = parsePrice(priceText);

      if (title && price > 0 && link) {
        deals.push({
          title,
          brand,
          model,
          price,
          originalPrice: null,
          store: 'Running Warehouse',
          url: link.startsWith('http') ? link : `https://www.runningwarehouse.com${link}`,
          image: image && image.startsWith('http') ? image : `https://www.runningwarehouse.com${image || ''}`,
          discount: null,
          scrapedAt: new Date().toISOString()
        });
      }
    });

  } catch (error) {
    console.error('[SCRAPER] Running Warehouse error:', error.message);
    throw error;
  }

  return deals;
}

/**
 * Scrape Zappos clearance/sale page
 */
async function scrapeZappos() {
  const deals = [];
  const url = 'https://www.zappos.com/men-athletic-shoes/CK_XARC81wHAAQLiAgMBAhg.zso';

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ShoeBeagleBot/1.0; +https://shoebeagle.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);

    $('[data-product-id], .product, article').each((i, element) => {
      const $el = $(element);
      
      const title = $el.find('[itemprop="name"], .product-name, h2, h3').first().text().trim();
      const priceText = $el.find('[itemprop="price"], .price').first().text().trim();
      const link = $el.find('a').first().attr('href');
      const image = $el.find('img').first().attr('src');

      const { brand, model } = parseBrandModel(title);
      const price = parsePrice(priceText);

      if (title && price > 0 && link) {
        deals.push({
          title,
          brand,
          model,
          price,
          originalPrice: null,
          store: 'Zappos',
          url: link.startsWith('http') ? link : `https://www.zappos.com${link}`,
          image: image || 'https://placehold.co/600x400?text=Running+Shoe',
          discount: null,
          scrapedAt: new Date().toISOString()
        });
      }
    });

  } catch (error) {
    console.error('[SCRAPER] Zappos error:', error.message);
    throw error;
  }

  return deals;
}

function parseBrandModel(title) {
  const brands = [
    'Nike', 'Adidas', 'New Balance', 'Brooks', 'Asics',
    'Hoka', 'Saucony', 'On', 'Altra', 'Mizuno',
    'Salomon', 'Reebok', 'Under Armour', 'Puma',
    'Karhu', 'Topo Athletic', 'Newton'
  ];

  let brand = 'Unknown';
  let model = title;

  for (const b of brands) {
    const regex = new RegExp(`\\b${b}\\b`, 'gi');
    if (regex.test(title)) {
      brand = b;
      model = title.replace(regex, '').trim();
      model = model.replace(/\s+/g, ' ');
      break;
    }
  }

  model = model.replace(/\s*-\s*(Men's|Women's|Mens|Womens)\s*$/i, '');

  return { brand, model };
}

function parsePrice(priceText) {
  if (!priceText) return 0;
  
  const cleaned = priceText.replace(/[^\d,\.]/g, '');
  const normalized = cleaned.replace(',', '');
  
  const price = parseFloat(normalized);
  return isNaN(price) ? 0 : price;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
