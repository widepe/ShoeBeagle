// api/scrape-daily.js
// Daily scraper for running shoe deals
// Runs once per day via Vercel Cron

import axios from 'axios';
import cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';

/**
 * Main handler - triggered by Vercel Cron
 */
export default async function handler(req, res) {
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

    // ADD MORE SCRAPERS HERE as you build them
    // await sleep(2000);
    // const rrsDeals = await scrapeRoadRunnerSports();
    // allDeals.push(...rrsDeals);

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

    // Save to data/deals.json
    const dataDir = path.join(process.cwd(), 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'deals.json'),
      JSON.stringify(output, null, 2)
    );

    const duration = Date.now() - startTime;
    console.log(`[SCRAPER] Complete: ${allDeals.length} deals in ${duration}ms`);

    return res.status(200).json({
      success: true,
      totalDeals: allDeals.length,
      dealsByStore,
      scraperResults,
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
}

/**
 * Scrape Running Warehouse sale page
 * URL: https://www.runningwarehouse.com/catpage-MSSALE.html
 */
async function scrapeRunningWarehouse() {
  const deals = [];
  const url = 'https://www.runningwarehouse.com/catpage-MSSALE.html';

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

    // IMPORTANT: These selectors are placeholders
    // You MUST inspect Running Warehouse's actual HTML and update these
    // Use Chrome DevTools: Right-click on a product → Inspect
    
    // Example selector pattern (update based on actual HTML):
    $('.product-grid-item, .product-item, [data-product]').each((i, element) => {
      const $el = $(element);
      
      // Extract data (adjust selectors based on actual HTML)
      const title = $el.find('.product-name, .title, h3, h4').first().text().trim();
      const priceText = $el.find('.price, .sale-price, [class*="price"]').first().text().trim();
      const link = $el.find('a').first().attr('href');
      const image = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src');

      // Parse brand and model
      const { brand, model } = parseBrandModel(title);
      const price = parsePrice(priceText);

      // Only add if we have essential data
      if (title && price > 0 && link) {
        deals.push({
          title,
          brand,
          model,
          price,
          originalPrice: null, // Add if available on page
          store: 'Running Warehouse',
          url: link.startsWith('http') ? link : `https://www.runningwarehouse.com${link}`,
          image: image && image.startsWith('http') ? image : `https://www.runningwarehouse.com${image || ''}`,
          discount: null, // Calculate if original price available
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
 * URL: https://www.zappos.com/men-athletic-shoes/CK_XARC81wHAAQLiAgMBAhg.zso
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

    // IMPORTANT: Update these selectors based on Zappos' actual HTML
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

// TODO: Add more scrapers
// async function scrapeRoadRunnerSports() { ... }
// async function scrapeFleetFeet() { ... }
// async function scrapeREI() { ... }

/**
 * Parse brand and model from product title
 * @param {string} title - Product title
 * @returns {object} - { brand, model }
 */
function parseBrandModel(title) {
  // Common running shoe brands
  const brands = [
    'Nike', 'Adidas', 'New Balance', 'Brooks', 'Asics',
    'Hoka', 'Saucony', 'On', 'Altra', 'Mizuno',
    'Salomon', 'Reebok', 'Under Armour', 'Puma',
    'Karhu', 'Topo Athletic', 'Newton'
  ];

  let brand = 'Unknown';
  let model = title;

  // Find brand in title (case-insensitive)
  for (const b of brands) {
    const regex = new RegExp(`\\b${b}\\b`, 'gi');
    if (regex.test(title)) {
      brand = b;
      // Remove brand name from model
      model = title.replace(regex, '').trim();
      // Clean up extra spaces
      model = model.replace(/\s+/g, ' ');
      break;
    }
  }

  // Remove common suffixes
  model = model.replace(/\s*-\s*(Men's|Women's|Mens|Womens)\s*$/i, '');

  return { brand, model };
}

/**
 * Parse price from text
 * @param {string} priceText - Text containing price (e.g., "$99.95", "Sale: $79.99")
 * @returns {number} - Parsed price
 */
function parsePrice(priceText) {
  if (!priceText) return 0;
  
  // Remove everything except digits, commas, and periods
  const cleaned = priceText.replace(/[^\d,\.]/g, '');
  
  // Handle comma as thousands separator
  const normalized = cleaned.replace(',', '');
  
  const price = parseFloat(normalized);
  return isNaN(price) ? 0 : price;
}

/**
 * Convert product URL to affiliate link
 * @param {string} originalUrl - Original product URL
 * @param {string} store - Store name
 * @returns {string} - Affiliate URL or original if not enrolled
 */
function toAffiliateLink(originalUrl, store) {
  // Affiliate IDs from environment variables
  const affiliateIds = {
    'Running Warehouse': process.env.RUNNINGWAREHOUSE_AFFILIATE_ID,
    'Zappos': process.env.AMAZON_ASSOCIATE_ID,
    'Road Runner Sports': process.env.RRS_AFFILIATE_ID,
    // Add more as you get approved
  };

  const affiliateId = affiliateIds[store];
  
  // If no affiliate ID, return original URL
  if (!affiliateId) {
    return originalUrl;
  }

  // Convert based on affiliate network
  // Example for Amazon Associates (used by Zappos)
  if (store === 'Zappos' && affiliateId) {
    const url = new URL(originalUrl);
    url.searchParams.set('tag', affiliateId);
    return url.toString();
  }

  // Add conversion logic for other networks as needed
  // ShareASale, CJ Affiliate, etc.

  return originalUrl;
}

/**
 * Sleep helper for rate limiting
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
