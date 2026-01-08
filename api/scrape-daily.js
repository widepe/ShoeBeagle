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
      
      // Extract title - try multiple methods
      let title = $el.find('[data-gtm_impression_name]').first().attr('data-gtm_impression_name');
      
      if (!title) {
        // Try getting from the alt text of the image
        title = $el.find('img').first().attr('alt');
      }
      
      if (!title || title.includes('<img')) {
        // Last resort: skip this product
        return;
      }
      
      // Clean up the title
      title = title.replace(/\s+/g, ' ').trim();
      
      const priceText = $el.find('[data-gtm_impression_price]').first().attr('data-gtm_impression_price') || 
                        $el.find('.price, .sale-price, [class*="price"]').first().text().trim();
      
      let link = $el.find('a').first().attr('href');
      let image = null;

      // Always try srcset first (Running Warehouse uses it)
      const srcset = $el.find('img').first().attr('srcset');
      if (srcset) {
        // srcset format: "url1 width1, url2 width2, ..."
        // Just take the first URL before the first space
        const firstPart = srcset.split(',')[0]; // Get first option
        image = firstPart.trim().split(' ')[0]; // Get URL before width
      } else {
        // Fallback to regular src
        image = $el.find('img').first().attr('src');
      }

      // If still no image, try data-src
      if (!image) {
        image = $el.find('img').first().attr('data-src');
      }

      // Clean up link - remove newlines and whitespace
      if (link) {
        link = link.replace(/[\r\n\t]/g, '').trim();
      }

      // Clean up image
      if (image) {
        image = image.replace(/[\r\n\t]/g, '').trim();
      }

      const { brand, model } = parseBrandModel(title);
      const price = parsePrice(priceText);

      if (title && price > 0 && link) {
        // Build clean URL
        let cleanUrl = '';
        if (link.startsWith('http')) {
          cleanUrl = link;
        } else if (link.startsWith('/')) {
          cleanUrl = `https://www.runningwarehouse.com${link}`;
        } else {
          cleanUrl = `https://www.runningwarehouse.com/${link}`;
        }

        // Build clean image URL
        let cleanImage = 'https://placehold.co/600x400?text=Running+Shoe';
        if (image && !image.includes('blank.gif')) {
          if (image.startsWith('http')) {
            cleanImage = image;
          } else if (image.startsWith('/')) {
            cleanImage = `https://www.runningwarehouse.com${image}`;
          } else {
            cleanImage = `https://www.runningwarehouse.com/${image}`;
          }
        }

        deals.push({
          title,
          brand,
          model,
          price,
          originalPrice: null,
          store: 'Running Warehouse',
          url: cleanUrl,
          image: cleanImage,
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
      const priceText =
        $el
          .find('[data-gtm_impression_price]')
          .first()
          .attr("data-gtm_impression_price") ||
        $el
          .find(".price, .sale-price, [class*='price']")
          .first()
          .text()
          .trim();

      // Parse all $X.XX numbers we can see in the price area
      const dollarMatches =
        (priceText.match(/\$[\d.,]+/g) || [])
          .map((txt) => parsePrice(txt))
          .filter((n) => Number.isFinite(n));

      // Fallback: parse the whole string as a single price
      let sale = parsePrice(priceText);
      let original = null;

      if (dollarMatches.length >= 2) {
        // For strings like "$99.88 $140.00" we treat the lower as sale, higher as original
        sale = Math.min(...dollarMatches);
        original = Math.max(...dollarMatches);
      }

      const discountPct =
        Number.isFinite(sale) &&
        Number.isFinite(original) &&
        original > 0 &&
        sale < original
          ? Math.round(((original - sale) / original) * 100)
          : 0;

      if (title && sale > 0 && link) {
        deals.push({
          title,
          store: "Running Warehouse",
          price: sale,              // current sale price
          originalPrice: original,  // previous price (null if none)
          image: imageUrl,
          url: link,
          discount: discountPct > 0 ? `${discountPct}% OFF` : null
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
  if (!title) return { brand: 'Unknown', model: '' };
  
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
function parseSaleAndOriginalPrices(text) {
  if (!text) {
    return { salePrice: 0, originalPrice: 0 };
  }

  // Grab all dollar-ish numbers in the string
  const matches = text.match(/\d[\d,]*\.?\d*/g);
  if (!matches) {
    return { salePrice: 0, originalPrice: 0 };
  }

  const values = matches
    .map((m) => parseFloat(m.replace(/,/g, "")))
    .filter((v) => Number.isFinite(v));

  if (!values.length) {
    return { salePrice: 0, originalPrice: 0 };
  }

  // If there’s only one price, assume no discount
  if (values.length === 1) {
    const v = values[0];
    return { salePrice: v, originalPrice: v };
  }

  // On Running Warehouse, the lower number is the sale, higher is original
  const salePrice = Math.min(...values);
  const originalPrice = Math.max(...values);

  return { salePrice, originalPrice };
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
