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

    /* DISABLED - Running Warehouse turned off per user request
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
    */

    /* DISABLED - JavaScript rendering issue (requires Puppeteer)
    // Scrape Zappos
    try {
      await sleep(2000);
      const zapposDeals = await scrapeZappos();
      allDeals.push(...zapposDeals);
      scraperResults['Zappos'] = { success: true, count: zapposDeals.length };
      console.log(`[SCRAPER] Zappos: ${zapposDeals.length} deals`);
    } catch (error) {
      scraperResults['Zappos'] = { success: false, error: error.message };
      console.error('[SCRAPER] Zappos failed:', error.message);
    }
    */

    // Scrape Dick's Sporting Goods
    try {
      const dicksDeals = await scrapeDicksSportingGoods();
      allDeals.push(...dicksDeals);
      scraperResults["Dick's Sporting Goods"] = { success: true, count: dicksDeals.length };
      console.log(`[SCRAPER] Dick's Sporting Goods: ${dicksDeals.length} deals`);
    } catch (error) {
      scraperResults["Dick's Sporting Goods"] = { success: false, error: error.message };
      console.error("[SCRAPER] Dick's Sporting Goods failed:", error.message);
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

/* DISABLED - Running Warehouse turned off per user request
**
 * Scrape Running Warehouse sale page
 *
async function scrapeRunningWarehouse() {
  console.log("[SCRAPER] Starting Running Warehouse scrape…");

  const urls = [
    "https://www.runningwarehouse.com/catpage-SALEMS.html",
    "https://www.runningwarehouse.com/catpage-SALEWS.html",
  ];

  const deals = [];

  try {
    for (const url of urls) {
      console.log(`[SCRAPER] Fetching RW page: ${url}`);

      const response = await axios.get(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*-/-*;q=0.8",
        },
        timeout: 30000,
      });

      const html = response.data;
      const $ = cheerio.load(html);

      $("a").each((_, el) => {
        const anchor = $(el);
        let text = anchor.text().replace(/\s+/g, " ").trim();

        if (!text.startsWith("Clearance ")) return;
        if (!/Shoes\b/i.test(text)) return;

        text = text.replace(/\*\s*$/, "").trim();

        const href = anchor.attr("href") || "";
        if (!href) return;

        const { salePrice, originalPrice } = parseSaleAndOriginalPrices(text);
        if (!salePrice || !Number.isFinite(salePrice)) return;

        const price = salePrice;
        const hasValidOriginal =
          Number.isFinite(originalPrice) && originalPrice > price;

        let discount = null;
        if (hasValidOriginal) {
          const pct = Math.round(((originalPrice - price) / originalPrice) * 100);
          if (pct > 0) {
            discount = `${pct}% OFF`;
          }
        }

        const titleWithoutPrices = text.replace(/\$\s*\d[\d,]*\.?\d*-/g, "").trim();
        const title = titleWithoutPrices;

        const { brand, model } = parseBrandModel(title);

        let cleanUrl = href;
        if (!/^https?:\/\//i.test(cleanUrl)) {
          cleanUrl = `https://www.runningwarehouse.com/${cleanUrl.replace(/^\/+/, "")}`;
        }

        let cleanImage = null;
        const container = anchor.closest("tr,td,div,li,article");
        if (container.length) {
          const imgEl = container.find("img").first();
          const src =
            imgEl.attr("data-src") ||
            imgEl.attr("data-original") ||
            imgEl.attr("src");
          if (src) {
            if (/^https?:\/\//i.test(src)) {
              cleanImage = src;
            } else {
              cleanImage = `https://www.runningwarehouse.com/${src.replace(
                /^\/+/,
                ""
              )}`;
            }
          }
        }

        deals.push({
          title,
          brand,
          model,
          store: "Running Warehouse",
          price,
          originalPrice: hasValidOriginal ? originalPrice : null,
          url: cleanUrl,
          image: cleanImage,
          discount,
          scrapedAt: new Date().toISOString(),
        });
      });

      await sleep(1500);
    }

    console.log(
      `[SCRAPER] Running Warehouse scrape complete. Found ${deals.length} deals.`
    );
    return deals;
  } catch (error) {
    console.error("[SCRAPER] Running Warehouse error:", error.message);
    throw error;
  }
}
*/

/* DISABLED - JavaScript rendering issue (requires Puppeteer)
**
 * Scrape Zappos clearance/sale page
 *
async function scrapeZappos() {
  const deals = [];
  const url = 'https://www.zappos.com/men-athletic-shoes/CK_XARC81wHAAQLiAgMBAhg.zso';

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ShoeBeagleBot/1.0; +https://shoebeagle.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*-/-*;q=0.8',
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

      const dollarMatches =
        (priceText.match(/\$[\d.,]+/g) || [])
          .map((txt) => parsePrice(txt))
          .filter((n) => Number.isFinite(n));

      let sale = parsePrice(priceText);
      let original = null;

      if (dollarMatches.length >= 2) {
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
          store: "Zappos",
          price: sale,
          originalPrice: original,
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
*/

/**
 * Scrape Dick's Sporting Goods clearance running footwear
 */
async function scrapeDicksSportingGoods() {
  console.log("[SCRAPER] Starting Dick's Sporting Goods scrape...");

  const url = 'https://www.dickssportinggoods.com/f/clearance-running-footwear';
  const deals = [];

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 30000
    });

    const $ = cheerio.load(response.data);

    // Each product is a link with structure like:
    // <a href="/p/nike-mens-pegasus-41-running-shoes-...">
    //   <img data-src="..." />
    //   ...brand/model info in text...
    // </a>
    
    // Find all product links
    $('a[href*="/p/"]').each((_, el) => {
      const $link = $(el);
      const href = $link.attr('href');
      
      // Must be a product page
      if (!href || !href.includes('/p/')) return;
      
      // Get the product title from the link text or nearby text
      let titleText = $link.text().replace(/\s+/g, ' ').trim();
      
      // Sometimes the title is in a specific element within the link
      const titleEl = $link.find('[class*="product"], [data-automation*="name"]').first();
      if (titleEl.length && titleEl.text().trim()) {
        titleText = titleEl.text().replace(/\s+/g, ' ').trim();
      }
      
      // Skip if no valid title
      if (!titleText || titleText.length < 10) return;
      
      // Must contain running-related keywords
      if (!/running|pegasus|ghost|vomero|nimbus|clifton|mach|ride|guide|kayano|boston|ultra|gel-|adizero|fresh foam|fuelcell/i.test(titleText)) return;
      
      // Parse prices from the text
      const priceMatches = titleText.match(/\$\s*[\d,]+\.?\d*/g);
      let salePrice = null;
      let originalPrice = null;
      
      if (priceMatches && priceMatches.length > 0) {
        const prices = priceMatches.map(p => parsePrice(p)).filter(p => p > 0);
        
        if (prices.length === 1) {
          salePrice = prices[0];
        } else if (prices.length >= 2) {
          // First price is usually sale, second is original
          salePrice = Math.min(...prices);
          originalPrice = Math.max(...prices);
        }
      }
      
      // Skip if no valid price
      if (!salePrice || salePrice <= 0) return;
      
      // Clean the title (remove price text)
      const cleanTitle = titleText.replace(/\$\s*[\d,]+\.?\d*/g, '').replace(/\s+/g, ' ').trim();
      
      // Parse brand and model
      const { brand, model } = parseBrandModel(cleanTitle);
      
      // Get image URL
      let imageUrl = null;
      const $img = $link.find('img').first();
      if ($img.length) {
        imageUrl = $img.attr('data-src') || $img.attr('src');
        if (imageUrl && !imageUrl.startsWith('http')) {
          imageUrl = 'https://www.dickssportinggoods.com' + (imageUrl.startsWith('/') ? '' : '/') + imageUrl;
        }
      }
      
      // Build full URL
      let fullUrl = href;
      if (!fullUrl.startsWith('http')) {
        fullUrl = 'https://www.dickssportinggoods.com' + (href.startsWith('/') ? '' : '/') + href;
      }
      
      // Calculate discount
      let discount = null;
      if (originalPrice && originalPrice > salePrice) {
        const pct = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
        if (pct > 0) {
          discount = `${pct}% OFF`;
        }
      }
      
      deals.push({
        title: cleanTitle,
        brand,
        model,
        store: "Dick's Sporting Goods",
        price: salePrice,
        originalPrice: originalPrice || null,
        url: fullUrl,
        image: imageUrl,
        discount,
        scrapedAt: new Date().toISOString()
      });
    });

    console.log(`[SCRAPER] Dick's Sporting Goods scrape complete. Found ${deals.length} deals.`);
    return deals;

  } catch (error) {
    console.error("[SCRAPER] Dick's Sporting Goods error:", error.message);
    throw error;
  }
}

/**
 * Helper: Parse brand and model from title
 */
function parseBrandModel(title) {
  if (!title) return { brand: 'Unknown', model: '' };
  
  const brands = [
    'Nike', 'Adidas', 'adidas', 'New Balance', 'Brooks', 'ASICS', 'Asics',
    'HOKA', 'Hoka', 'Saucony', 'On', 'Altra', 'Mizuno',
    'Salomon', 'Reebok', 'Under Armour', 'Puma', 'PUMA',
    'Karhu', 'Topo Athletic', 'Newton', 'Saysh', 'TYR'
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

  // Clean up common suffixes
  model = model.replace(/\s*-?\s*(Men's|Women's|Mens|Womens|Running|Shoes)\s*$/gi, '');
  model = model.replace(/\s+/g, ' ').trim();

  return { brand, model };
}

/**
 * Helper: Parse sale and original prices from text
 */
function parseSaleAndOriginalPrices(text) {
  if (!text) {
    return { salePrice: 0, originalPrice: 0 };
  }

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

  if (values.length === 1) {
    const v = values[0];
    return { salePrice: v, originalPrice: v };
  }

  const salePrice = Math.min(...values);
  const originalPrice = Math.max(...values);

  return { salePrice, originalPrice };
}

/**
 * Helper: Parse price from text
 */
function parsePrice(priceText) {
  if (!priceText) return 0;
  
  const cleaned = priceText.replace(/[^\d,\.]/g, '');
  const normalized = cleaned.replace(',', '');
  
  const price = parseFloat(normalized);
  return isNaN(price) ? 0 : price;
}

/**
 * Helper: Sleep function
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
