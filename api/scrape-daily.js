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

    // Scrape Fleet Feet
    try {
      await sleep(2000); // Be respectful - 2 second delay between sites
      const fleetFeetDeals = await scrapeFleetFeet();
      allDeals.push(...fleetFeetDeals);
      scraperResults['Fleet Feet'] = { success: true, count: fleetFeetDeals.length };
      console.log(`[SCRAPER] Fleet Feet: ${fleetFeetDeals.length} deals`);
    } catch (error) {
      scraperResults['Fleet Feet'] = { success: false, error: error.message };
      console.error('[SCRAPER] Fleet Feet failed:', error.message);
    }

    // Scrape Luke's Locker
    try {
      await sleep(2000); // Be respectful - 2 second delay between sites
      const lukesDeals = await scrapeLukesLocker();
      allDeals.push(...lukesDeals);
      scraperResults["Luke's Locker"] = { success: true, count: lukesDeals.length };
      console.log(`[SCRAPER] Luke's Locker: ${lukesDeals.length} deals`);
    } catch (error) {
      scraperResults["Luke's Locker"] = { success: false, error: error.message };
      console.error("[SCRAPER] Luke's Locker failed:", error.message);
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

    // Save to Vercel Blob Storage (fixed filename, no random suffix)
    const blob = await put('deals.json', JSON.stringify(output, null, 2), {
      access: 'public',
      addRandomSuffix: false
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
  console.log("[SCRAPER] Starting Running Warehouse scrape...");

  // Men's and Women's sale pages
  const urls = [
    "https://www.runningwarehouse.com/catpage-SALEMS.html", // Men's
    "https://www.runningwarehouse.com/catpage-SALEWS.html", // Women's
  ];

  const deals = [];

  try {
    for (const url of urls) {
      console.log(`[SCRAPER] Fetching RW page: ${url}`);

      const response = await axios.get(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        timeout: 30000,
      });

      const html = response.data;
      const $ = cheerio.load(html);

      // Each product is a link with text like:
      // "Clearance Brand Model Men's Shoes - Color $ 111.95 $140.00 *"
      $("a").each((_, el) => {
        const anchor = $(el);
        let text = anchor.text().replace(/\s+/g, " ").trim();

        if (!text.startsWith("Clearance ")) return;
        if (!/Shoes\b/i.test(text)) return;

        // Remove trailing asterisk
        text = text.replace(/\*\s*$/, "").trim();

        const href = anchor.attr("href") || "";
        if (!href) return;

        // Parse sale + original prices
        const { salePrice, originalPrice } = parseSaleAndOriginalPrices(text);
        if (!salePrice || !Number.isFinite(salePrice)) return;

        const price = salePrice;
        const hasValidOriginal =
          Number.isFinite(originalPrice) && originalPrice > price;

        // Clean title (remove prices and normalize spaces)
        const titleWithoutPrices = text
          .replace(/\$\s*\d[\d,]*\.?\d*/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const title = titleWithoutPrices;

        // Parse brand and model
        const { brand, model } = parseBrandModel(title);

        // Build full URL
let cleanUrl = (href || '').trim();

if (/^https?:\/\//i.test(cleanUrl)) {
  // already an absolute URL, leave as-is
} else if (cleanUrl.startsWith('//')) {
  // protocol-relative URL like //www.runningwarehouse.com/...
  cleanUrl = 'https:' + cleanUrl;
} else {
  // relative path like /ASICS_GT_2000_13/...
  cleanUrl = `https://www.runningwarehouse.com/${cleanUrl.replace(/^\/+/, "")}`;
}


        // Try to find image
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
          scrapedAt: new Date().toISOString(),
        });
      });

      // Be polite - 1.5 second delay between pages
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

/**
 * Scrape Fleet Feet clearance running shoes
 */
async function scrapeFleetFeet() {
  console.log("[SCRAPER] Starting Fleet Feet scrape...");

  const urls = [
    "https://www.fleetfeet.com/browse/shoes/mens?clearance=on",
    "https://www.fleetfeet.com/browse/shoes/womens?clearance=on"
  ];

  const deals = [];

  try {
    for (const url of urls) {
      console.log(`[SCRAPER] Fetching Fleet Feet page: ${url}`);

      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 30000
      });

      const $ = cheerio.load(response.data);

      $('a[href^="/products/"]').each((_, el) => {
        const $link = $(el);
        const href = $link.attr('href');

        if (!href || !href.startsWith('/products/')) return;

        const fullText = $link.text().replace(/\s+/g, ' ').trim();

        if (!/running|shoes|race|trail|walking|sneakers/i.test(fullText)) return;
        if (fullText.length < 20) return;

        const titleMatch = fullText.match(/^(.+?)\s*(?:original price|sale|discounted|\$)/i);
        const title = titleMatch ? titleMatch[1].trim() : fullText.split('$')[0].trim();

        const { brand, model } = parseBrandModel(title);

        const priceMatches = fullText.match(/\$\s*[\d,]+\.?\d*/g);
        
        let salePrice = null;
        let originalPrice = null;

        if (priceMatches && priceMatches.length > 0) {
          const prices = priceMatches.map(p => parsePrice(p)).filter(p => p > 0);
          
          if (prices.length === 1) {
            salePrice = prices[0];
          } else if (prices.length >= 2) {
            originalPrice = Math.max(...prices);
            salePrice = Math.min(...prices);
          }
        }

        if (!salePrice || salePrice <= 0) return;

        let imageUrl = null;
        const $img = $link.find('img').first();
        if ($img.length) {
          imageUrl = $img.attr('src') || $img.attr('data-src');
          if (imageUrl && !imageUrl.startsWith('http')) {
            imageUrl = 'https://cdn.fleetfeet.com' + (imageUrl.startsWith('/') ? '' : '/') + imageUrl;
          }
        }

        let fullUrl = href;
        if (!fullUrl.startsWith('http')) {
          fullUrl = 'https://www.fleetfeet.com' + (href.startsWith('/') ? '' : '/') + href;
        }

        deals.push({
          title,
          brand,
          model,
          store: "Fleet Feet",
          price: salePrice,
          originalPrice: originalPrice || null,
          url: fullUrl,
          image: imageUrl,
          scrapedAt: new Date().toISOString()
        });
      });

      await sleep(2000);
    }

    console.log(`[SCRAPER] Fleet Feet scrape complete. Found ${deals.length} deals.`);
    return deals;

  } catch (error) {
    console.error("[SCRAPER] Fleet Feet error:", error.message);
    throw error;
  }
}

/**
 * Scrape Luke's Locker clearance running shoes
 */
async function scrapeLukesLocker() {
  console.log("[SCRAPER] Starting Luke's Locker scrape...");

  const url = "https://lukeslocker.com/collections/closeout";
  const deals = [];

  try {
    console.log(`[SCRAPER] Fetching Luke's Locker page: ${url}`);

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 30000
    });

    const $ = cheerio.load(response.data);

    // Luke's Locker uses similar Shopify structure to Fleet Feet
    // Product links: /collections/closeout/products/altra-womens-torin-7
    $('a[href*="/products/"]').each((_, el) => {
      const $link = $(el);
      const href = $link.attr('href');

      // Skip if not a product link or doesn't contain /products/
      if (!href || !href.includes('/products/')) return;

      // Get all text from the link
      const fullText = $link.text().replace(/\s+/g, ' ').trim();

      // Skip empty or navigation links
      if (fullText.length < 10) return;

      // Look for price indicators - Luke's shows "Sale price" and "Regular price"
      if (!fullText.includes('$')) return;

      // Extract title - usually the first line before "Sale price"
      // Example: "ALTRA WOMEN'S TORIN 7 ALTRA Sale price $99.99 Regular price $150.00"
      const titleMatch = fullText.match(/^(.+?)\s+(?:Sale price|Regular price|\$)/i);
      let title = titleMatch ? titleMatch[1].trim() : '';

      // If title extraction failed, try splitting on brand names
      if (!title || title.length < 5) {
        // Try to find brand name and extract everything before "Sale price"
        const beforePrice = fullText.split(/Sale price|Regular price/i)[0];
        title = beforePrice.replace(/\s+/g, ' ').trim();
      }

      // Skip if we couldn't get a reasonable title
      if (!title || title.length < 5) return;

      // Parse brand and model
      const { brand, model } = parseBrandModel(title);

           // Extract prices - Luke's format: "Price $200.00 $150.00 Save $50.00"
      const priceMatches = fullText.match(/\$\s*[\d,\.]+/g);

      let salePrice = null;
      let originalPrice = null;

      if (priceMatches && priceMatches.length > 0) {
        // Convert to numbers, drop invalids, dedupe, sort high → low
        let prices = [...new Set(
          priceMatches
            .map(p => parsePrice(p))
            .filter(p => p > 0)
        )].sort((a, b) => b - a);

        // If we have at least 3 prices and the smallest is exactly
        // the difference between the two largest, it's "Save $XX" — drop it.
        if (prices.length >= 3) {
          const [orig, sale, maybeSave] = prices;
          if (Math.abs((orig - sale) - maybeSave) < 0.01) {
            prices = prices.slice(0, 2); // keep only orig & sale
          }
        }

        if (prices.length === 1) {
          salePrice = prices[0];
        } else if (prices.length >= 2) {
          // highest = original, second highest = sale
          originalPrice = prices[0];
          salePrice = prices[1];
        }
      }

      // Skip if no valid sale price
      if (!salePrice || salePrice <= 0) return;


      // Get image URL
      let imageUrl = null;
      const $img = $link.find('img').first();
      if ($img.length) {
        imageUrl = $img.attr('src') || $img.attr('data-src');
        // Luke's Locker uses lukeslocker.com CDN
        if (imageUrl && !imageUrl.startsWith('http')) {
          imageUrl = 'https:' + (imageUrl.startsWith('//') ? imageUrl : '//' + imageUrl);
        }
      }

      // Build full URL
      let fullUrl = href;
      if (!fullUrl.startsWith('http')) {
        fullUrl = 'https://lukeslocker.com' + (href.startsWith('/') ? '' : '/') + href;
      }

      deals.push({
        title,
        brand,
        model,
        store: "Luke's Locker",
        price: salePrice,
        originalPrice: originalPrice || null,
        url: fullUrl,
        image: imageUrl,
        scrapedAt: new Date().toISOString()
      });
    });

    console.log(`[SCRAPER] Luke's Locker scrape complete. Found ${deals.length} deals.`);
    return deals;

  } catch (error) {
    console.error("[SCRAPER] Luke's Locker error:", error.message);
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
    'HOKA', 'Hoka', 'HOKA ONE ONE', 'Saucony', 'On', 'ON RUNNING', 'Altra', 'ALTRA', 'Mizuno',
    'Salomon', 'Reebok', 'Under Armour', 'Puma', 'PUMA',
    'Karhu', 'KARHU', 'Topo Athletic', 'Topo', 'Newton', 'Saysh', 'TYR',
    'Craft', 'OOFOS', 'Skora', 'Diadora', 'DIADORA', 'Hylo Athletics', 'HYLO ATHLETICS'
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
  model = model.replace(/\s*-?\s*(Men's|Women's|Mens|Womens|Running|Shoes|Race|Trail|Walking)\s*$/gi, '');
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

  // Only match numbers that follow a $ sign
  const matches = text.match(/\$\s*([\d,]+\.?\d*)/g);
  if (!matches) {
    return { salePrice: 0, originalPrice: 0 };
  }

  const values = matches
    .map(m => parseFloat(m.replace(/[^\d.]/g, "")))
    .filter(v => Number.isFinite(v));

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
 * Helper: Parse price from text, reject numbers 3-5 digits without commas
 */
function parsePrice(priceText) {
  if (!priceText) return 0;

  // Keep only digits (Shopify often renders 200.00 as "20000" via <sup>)
  const digits = priceText.replace(/\D/g, '');
  if (!digits) return 0;

  const intVal = parseInt(digits, 10);
  if (!Number.isFinite(intVal)) return 0;

  // Heuristic:
  // - If there are 1–2 digits, treat as whole dollars (e.g. "50" -> 50)
  // - If 3+ digits, treat last 2 as cents (e.g. "20000" -> 200.00, "9995" -> 99.95)
  if (digits.length <= 2) {
    return intVal;
  }

  return intVal / 100;
}



/**
 * Helper: Sleep function
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
