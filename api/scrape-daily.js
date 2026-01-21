// api/scrape-daily.js
// Daily scraper for running shoe deals
// Runs once per day via Vercel Cron

const axios = require('axios');
const cheerio = require('cheerio');
const { put } = require('@vercel/blob');
const { ApifyClient } = require('apify-client');
const { cleanModelName } = require('./modelNameCleaner');

// Optional JSDoc to document the shape, not required to work:
/**
 * @typedef {Object} Deal
 * @property {string} title
 * @property {string} brand
 * @property {string} model
 * @property {number|null} price
 * @property {number|null} originalPrice
 * @property {string} store
 * @property {string} url
 * @property {string|null} image
 * @property {string|null} discount
 * @property {string} scrapedAt
 */

const apifyClient = new ApifyClient({
  token: process.env.APIFY_TOKEN,
});

/**
 * CENTRALIZED FILTER: Validates that a deal is a legitimate running shoe
 * @param {Deal} deal - The deal to validate
 * @returns {boolean} - True if valid running shoe deal, false otherwise
 */
function isValidRunningShoe(deal) {
  // Basic data integrity checks
  if (!deal || !deal.url || !deal.title) {
    return false;
  }
  
  // Must have valid prices
  if (!deal.price || !deal.originalPrice) {
    return false;
  }
  
  // Sale price must be less than original price
  if (deal.price >= deal.originalPrice) {
    return false;
  }
  
  // Price must be in reasonable range for shoes ($10-$1000)
  if (deal.price < 10 || deal.price > 1000) {
    return false;
  }
  
  // Discount must be between 5% and 90%
  const discount = ((deal.originalPrice - deal.price) / deal.originalPrice) * 100;
  if (discount < 5 || discount > 90) {
    return false;
  }
  
  // Product type filtering - exclude non-shoe items
  const title = (deal.title || '').toLowerCase();
  
  // List of non-shoe items to exclude
   const excludePatterns = [
    'sock', 'socks',
    'apparel', 'shirt', 'shorts', 'tights', 'pants',
    'hat', 'cap', 'beanie',
    'insole', 'insoles',
    'laces', 'lace',
    'accessories', 'accessory',
    'hydration', 'bottle', 'flask',
    'watch', 'watches',
    'gear', 'equipment',
    'bag', 'bags', 'pack', 'backpack',
    'vest', 'vests',
    'jacket', 'jackets',
    'bra', 'bras',
    'underwear', 'brief',
    'glove', 'gloves', 'mitt',
    'compression sleeve',
    'arm warmer', 'leg warmer',
    'headband', 'wristband',
    'sunglasses', 'eyewear',
    'sleeve', 'sleeves', 
    'throw',  //  track & field throw shoes
    'out of stock', 
    'kids', 'kid',  
    'youth', 
    'junior', 'juniors' 
  ];
  
  // Check if title contains any excluded patterns
  for (const pattern of excludePatterns) {
    // Use word boundary to avoid false positives
    const regex = new RegExp(`\\b${pattern}\\b`, 'i');
    if (regex.test(title)) {
      return false;
    }
  }
  
  return true;
}

/**
 * Runs the Road Runner Apify actor and returns its dataset as Deal[].
 */
async function fetchRoadRunnerDeals() {
  if (!process.env.APIFY_ROADRUNNER_ACTOR_ID) {
    throw new Error('APIFY_ROADRUNNER_ACTOR_ID is not set');
  }

  // 1. Start a run of your actor and wait for it to finish
  const run = await apifyClient
    .actor(process.env.APIFY_ROADRUNNER_ACTOR_ID)
    .call({});

  // 2. Read all items from default dataset for this run
  const allItems = [];
  let offset = 0;
  const limit = 500; // plenty for Road Runner sale pages

  while (true) {
    const { items, total } = await apifyClient
      .dataset(run.defaultDatasetId)
      .listItems({ offset, limit });

    allItems.push(...items);
    offset += items.length;

    if (offset >= total || items.length === 0) break;
  }

  // Safety: ensure store is set
  for (const d of allItems) {
    if (!d.store) d.store = 'Road Runner Sports';
  }

  return allItems;
}

/**
 * Runs the Zappos Apify actor and returns its dataset as Deal[].
 */
async function fetchZapposDeals() {
  if (!process.env.APIFY_ZAPPOS_ACTOR_ID) {
    throw new Error('APIFY_ZAPPOS_ACTOR_ID is not set');
  }

  // 1. Start a run of your Zappos actor and wait for it to finish
  const run = await apifyClient
    .actor(process.env.APIFY_ZAPPOS_ACTOR_ID)
    .call({});

  // 2. Read all items from default dataset for this run
  const allItems = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const { items, total } = await apifyClient
      .dataset(run.defaultDatasetId)
      .listItems({ offset, limit });

    allItems.push(...items);
    offset += items.length;

    if (offset >= total || items.length === 0) break;
  }

  // Safety: ensure store is set
  for (const d of allItems) {
    if (!d.store) d.store = 'Zappos';
  }

  return allItems;
}

/**
 * Runs the REI Outlet Apify actor and returns its dataset as Deal[].
 */
async function fetchReiDeals() {
  console.log('[REI DEBUG] fetchReiDeals called');
  
  if (!process.env.APIFY_REI_ACTOR_ID) {
    console.error('[REI DEBUG] APIFY_REI_ACTOR_ID is not set!');
    throw new Error('APIFY_REI_ACTOR_ID is not set');
  }

  console.log('[REI DEBUG] Actor ID:', process.env.APIFY_REI_ACTOR_ID);
  console.log('[REI DEBUG] Starting actor run...');

  // 1. Start a run of your REI actor and wait for it to finish
  const run = await apifyClient
    .actor(process.env.APIFY_REI_ACTOR_ID)
    .call({});

  console.log('[REI DEBUG] Actor run completed. Run ID:', run.id);
  console.log('[REI DEBUG] Default dataset ID:', run.defaultDatasetId);

  // 2. Read all items from default dataset for this run
  const allItems = [];
  let offset = 0;
  const limit = 500; // plenty for REI Outlet

  while (true) {
    console.log('[REI DEBUG] Fetching items. Offset:', offset, 'Limit:', limit);
    
    const { items, total } = await apifyClient
      .dataset(run.defaultDatasetId)
      .listItems({ offset, limit });

    console.log('[REI DEBUG] Received', items.length, 'items. Total in dataset:', total);
    
    allItems.push(...items);
    offset += items.length;

    if (offset >= total || items.length === 0) break;
  }

  console.log('[REI DEBUG] Total items fetched:', allItems.length);

  // Map REI actor items into your unified Deal shape
  const mapped = allItems.map((item) => {
    const brand = item.brand || 'Unknown';
    const model = item.model || '';
    const title =
      item.title ||
      `${brand} ${model}`.trim() ||
      'REI Outlet Shoe';

    return {
      title,
      brand,
      model,
      price: item.price ?? null,
      originalPrice: item.originalPrice ?? null,
      store: item.store || 'REI Outlet',
      url: item.url,
      image: item.image ?? null,
      discount: item.discount ?? null,
      scrapedAt: new Date().toISOString(),
    };
  });

  console.log('[REI DEBUG] Mapped', mapped.length, 'deals');
  return mapped;
}

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
/*
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
      await randomDelay(); // Be respectful - 2 second delay between sites
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
      await randomDelay(); // Be respectful - 2 second delay between sites
      const lukesDeals = await scrapeLukesLocker();
      allDeals.push(...lukesDeals);
      scraperResults["Luke's Locker"] = { success: true, count: lukesDeals.length };
      console.log(`[SCRAPER] Luke's Locker: ${lukesDeals.length} deals`);
    } catch (error) {
      scraperResults["Luke's Locker"] = { success: false, error: error.message };
      console.error("[SCRAPER] Luke's Locker failed:", error.message);
    }

    // Scrape Marathon Sports
    try {
      await randomDelay(); // Be respectful - 2 second delay between sites
      const marathonDeals = await scrapeMarathonSports();
      allDeals.push(...marathonDeals);
      scraperResults["Marathon Sports"] = { success: true, count: marathonDeals.length };
      console.log(`[SCRAPER] Marathon Sports: ${marathonDeals.length} deals`);
    } catch (error) {
      scraperResults["Marathon Sports"] = { success: false, error: error.message };
      console.error("[SCRAPER] Marathon Sports failed:", error.message);
    }
*/
   // Scrape Holabird Sports
    try {
      await randomDelay();
      const holabirdDeals = await scrapeHolabirdSports();
      allDeals.push(...holabirdDeals);
      scraperResults['Holabird Sports'] = { success: true, count: holabirdDeals.length };
      console.log(`[SCRAPER] Holabird Sports: ${holabirdDeals.length} deals`);
    } catch (error) {
      scraperResults['Holabird Sports'] = { success: false, error: error.message };
      console.error('[SCRAPER] Holabird Sports failed:', error.message);
    }    
    /*
    // Scrape Road Runner Sports via Apify
    try {
      await randomDelay(); // keep your politeness delay between sites
      const rrDeals = await fetchRoadRunnerDeals();
      allDeals.push(...rrDeals);
      scraperResults['Road Runner Sports'] = { success: true, count: rrDeals.length };
      console.log(`[SCRAPER] Road Runner Sports: ${rrDeals.length} deals`);
    } catch (error) {
      scraperResults['Road Runner Sports'] = { success: false, error: error.message };
      console.error('[SCRAPER] Road Runner Sports failed:', error.message);
    }

    // Scrape REI Outlet via Apify - ENHANCED ERROR LOGGING
    try {
      console.log('[SCRAPER] ====== STARTING REI OUTLET SCRAPE ======');
      console.log('[SCRAPER] REI Actor ID:', process.env.APIFY_REI_ACTOR_ID);
      console.log('[SCRAPER] Apify Token present:', !!process.env.APIFY_TOKEN);
      
      await randomDelay(); // politeness delay
      console.log('[SCRAPER] Calling fetchReiDeals()...');
      
      const reiDeals = await fetchReiDeals();
      
      console.log('[SCRAPER] fetchReiDeals returned:', reiDeals.length, 'deals');
      allDeals.push(...reiDeals);
      scraperResults['REI Outlet'] = { success: true, count: reiDeals.length };
      console.log(`[SCRAPER] REI Outlet: ${reiDeals.length} deals`);
      console.log('[SCRAPER] ====== REI OUTLET SCRAPE COMPLETE ======');
    } catch (error) {
      console.error('[SCRAPER] ====== REI OUTLET SCRAPE FAILED ======');
      console.error('[SCRAPER] REI Outlet error type:', error.constructor.name);
      console.error('[SCRAPER] REI Outlet error message:', error.message);
      console.error('[SCRAPER] REI Outlet error stack:', error.stack);
      scraperResults['REI Outlet'] = { success: false, error: error.message };
      console.error('[SCRAPER] REI Outlet failed:', error.message);
    }    

    // Scrape Zappos via Apify
    try {
      await randomDelay(); // keep your politeness delay between sites
      const zapposDeals = await fetchZapposDeals();
      allDeals.push(...zapposDeals);
      scraperResults['Zappos'] = { success: true, count: zapposDeals.length };
      console.log(`[SCRAPER] Zappos: ${zapposDeals.length} deals`);
    } catch (error) {
      scraperResults['Zappos'] = { success: false, error: error.message };
      console.error('[SCRAPER] Zappos failed:', error.message);
    }
*/
    console.log(`[SCRAPER] Total deals collected from all sources: ${allDeals.length}`);

    // === CENTRALIZED FILTERING ===
    console.log('[SCRAPER] Applying centralized filters to remove non-shoes and invalid deals...');
    const filteredDeals = allDeals.filter(isValidRunningShoe);
    console.log(`[SCRAPER] Filtering complete. Before: ${allDeals.length}, After: ${filteredDeals.length} (removed ${allDeals.length - filteredDeals.length})`);

    // === DEDUPLICATION BY STORE + URL ===
    console.log('[SCRAPER] De-duplicating deals by store + URL...');
    const uniqueDeals = [];
    const seenStoreUrls = new Set();

    for (const d of filteredDeals) {
      if (!d) continue;

      const urlKey = (d.url || '').trim();

      if (!urlKey) {
        uniqueDeals.push(d);
        continue;
      }

      const compositeKey = `${d.store}|${urlKey}`;
      if (seenStoreUrls.has(compositeKey)) continue;

      seenStoreUrls.add(compositeKey);
      uniqueDeals.push(d);
    }

    console.log(
      `[SCRAPER] De-duplication complete. Before: ${filteredDeals.length}, After: ${uniqueDeals.length} (removed ${filteredDeals.length - uniqueDeals.length} duplicates)`
    );

    // From here on, work with the deduped list
    const dealsToUse = uniqueDeals;

    // STEP 1: Shuffle all deals to randomize baseline order
    console.log('[SCRAPER] Shuffling deals for fair distribution...');
    dealsToUse.sort(() => Math.random() - 0.5);
    
    // STEP 2: Sort by discount percentage (highest first)
    // Stable sort preserves random order for items with same discount
    console.log('[SCRAPER] Sorting by discount percentage...');
    dealsToUse.sort((a, b) => {
      const discountA = a.originalPrice && a.price 
        ? ((a.originalPrice - a.price) / a.originalPrice * 100) 
        : 0;
      const discountB = b.originalPrice && b.price 
        ? ((b.originalPrice - b.price) / b.originalPrice * 100) 
        : 0;
      return discountB - discountA;  // Highest discount first
    });
    
    console.log(
      '[SCRAPER] Deals shuffled and sorted. Top deal:',
      dealsToUse[0]?.title, 
      'at', 
      dealsToUse[0]?.store,
      '- Discount:', 
      dealsToUse[0]?.originalPrice && dealsToUse[0]?.price 
        ? Math.round(
            (dealsToUse[0].originalPrice - dealsToUse[0].price) /
            dealsToUse[0].originalPrice * 100
          ) + '%'
        : 'N/A'
    );

    // Calculate statistics
    const dealsByStore = {};
    dealsToUse.forEach(deal => {
      const storeName = deal.store || 'Unknown';
      dealsByStore[storeName] = (dealsByStore[storeName] || 0) + 1;
    });

    // Prepare output
    const output = {
      lastUpdated: new Date().toISOString(),
      totalDeals: dealsToUse.length,
      dealsByStore,
      scraperResults,
      deals: dealsToUse
    };

    // Save to Vercel Blob Storage (fixed filename, no random suffix)
    const blob = await put('deals.json', JSON.stringify(output, null, 2), {
      access: 'public',
      addRandomSuffix: false
    });

    console.log('[SCRAPER] Saved to blob:', blob.url);

    const duration = Date.now() - startTime;
    console.log(`[SCRAPER] Complete: ${dealsToUse.length} deals in ${duration}ms`);

    return res.status(200).json({
      success: true,
      totalDeals: dealsToUse.length,
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
  const seenUrls = new Set();

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

        // Remove trailing asterisk
        text = text.replace(/\*\s*$/, "").trim();

        const href = anchor.attr("href") || "";
        if (!href) return;

        // UNIVERSAL PRICE PARSER
        const { salePrice, originalPrice, valid } = extractPrices($, anchor, text);
        if (!valid || !salePrice || !Number.isFinite(salePrice)) return;

        const price = salePrice;
        const hasValidOriginal =
          Number.isFinite(originalPrice) && originalPrice > price;

      const title = text.trim();

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

        if (seenUrls.has(cleanUrl)) return;
        seenUrls.add(cleanUrl);

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
      await randomDelay();
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
  const seenUrls = new Set();

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

        const title = fullText.trim();

        const { brand, model } = parseBrandModel(title);

        // UNIVERSAL PRICE PARSER
        const { salePrice, originalPrice, valid } = extractPrices($, $link, fullText);
        if (!valid || !salePrice || salePrice <= 0) return;

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

        if (seenUrls.has(fullUrl)) return;
        seenUrls.add(fullUrl);

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

      await randomDelay();
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
    
      const title = fullText.trim();

      // Parse brand and model
      const { brand, model } = parseBrandModel(title);

      // UNIVERSAL PRICE PARSER
      const { salePrice, originalPrice, valid } = extractPrices($, $link, fullText);
      if (!valid || !salePrice || salePrice <= 0) return;

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
 * Scrape Marathon Sports
 */
async function scrapeMarathonSports() {
  console.log("[SCRAPER] Starting Marathon Sports scrape...");

  const urls = [
    "https://www.marathonsports.com/shop/mens/shoes?sale=1",              // Men's sale shoes
    "https://www.marathonsports.com/shop/womens/shoes?sale=1",            // Women's sale shoes
    "https://www.marathonsports.com/shop?q=running%20shoes&sort=discount" // All running shoes sorted by discount
  ];

  const deals = [];
  const seenUrls = new Set(); // Track unique products to avoid duplicates across pages

  try {
    for (const url of urls) {
      console.log(`[SCRAPER] Fetching Marathon Sports page: ${url}`);

      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 30000
      });

      const $ = cheerio.load(response.data);

      // Marathon Sports: product links are /products/... 
      // But title and price are in parent/sibling elements
      $('a[href^="/products/"]').each((_, el) => {
        const $link = $(el);
        const href = $link.attr('href');

        if (!href) return;

        // Build full URL first for deduplication
        let fullUrl = href;
        if (!fullUrl.startsWith('http')) {
          fullUrl = 'https://www.marathonsports.com' + (href.startsWith('/') ? '' : '/') + href;
        }

        // Skip if we've already seen this product
        if (seenUrls.has(fullUrl)) return;

        // Find the parent container that holds all product info
        const $container = $link.closest('div, article, li').filter(function() {
          // Make sure this container has price info
          return $(this).text().includes('price');
        });

        if (!$container.length) return;

        // Get all text from the container
        const containerText = $container.text().replace(/\s+/g, ' ').trim();

        // Must have price indicators
        if (!containerText.includes('$') || !containerText.includes('price')) return;

        // Extract title from h2, h3, or class containing "title" or "name"
        let title = '';
        const $titleEl = $container.find('h2, h3, .product-title, .product-name, [class*="title"]').first();
        
        if ($titleEl.length) {
          title = $titleEl.text().replace(/\s+/g, ' ').trim();
        } else {
          // Fallback: look for title pattern before "Men's" or "Women's"
          const titleMatch = containerText.match(/^(.+?)\s+(Men's|Women's)/i);
          if (titleMatch) {
            title = titleMatch[1].trim();
          }
        }


        if (!title || title.length < 5) return;

        // Parse brand and model
        const { brand, model } = parseBrandModel(title);

        // Use UNIVERSAL PRICE PARSER on the container text
        const { salePrice, originalPrice, valid } = extractPrices($, $container, containerText);
        
        if (!valid || !salePrice || salePrice <= 0) return;

        // Get image URL - check both link and container
        let imageUrl = null;
        let $img = $link.find('img').first();

        // If not in link, check the container
        if (!$img.length) {
          $img = $container.find('img').first();
        }

        if ($img.length) {
          imageUrl = $img.attr('src') || $img.attr('data-src');
          // Image URLs are already absolute on Marathon Sports
          if (imageUrl && !imageUrl.startsWith('http') && !imageUrl.startsWith('//')) {
            imageUrl = 'https://www.marathonsports.com' + (imageUrl.startsWith('/') ? '' : '/') + imageUrl;
          }
        }

        // Mark this URL as seen
        seenUrls.add(fullUrl);

        deals.push({
          title,
          brand,
          model,
          store: "Marathon Sports",
          price: salePrice,
          originalPrice: originalPrice || null,
          url: fullUrl,
          image: imageUrl,
          scrapedAt: new Date().toISOString()
        });
      });

      // Be polite - delay between pages
      await randomDelay();
    }

    console.log(`[SCRAPER] Marathon Sports scrape complete. Found ${deals.length} deals.`);
    return deals;

  } catch (error) {
    console.error("[SCRAPER] Marathon Sports error:", error.message);
    throw error;
  }
}

/**
 * Scrape Holabird Sports running shoe deals
 * Uses Shopify's JSON API instead of HTML parsing
 */
async function scrapeHolabirdSports() {
  console.log("[SCRAPER] Starting Holabird Sports scrape...");

  const collections = [
    { path: "running-deals", filter: "Type_Running-Shoes+" },
    { path: "shoe-deals", filter: "Type_Trail-Running-Shoes+" }
  ];

  const deals = [];
  const seenUrls = new Set();

  try {
    for (const collection of collections) {
      console.log(`[SCRAPER] Scraping collection: ${collection.path} with filter: ${collection.filter}`);

      let page = 1;
      let hasMore = true;

      while (hasMore && page <= 3) {
        // Build the URL matching the browser format
        const url = `https://www.holabirdsports.com/collections/${collection.path}/${collection.filter}?page=${page}`;
        
        console.log(`[SCRAPER] Fetching page ${page}: ${url}`);

        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'text/html',
          },
          timeout: 30000
        });

        const $ = cheerio.load(response.data);
        
        // Now parse HTML like your other scrapers
        let foundProducts = 0;
        
        $('a[href*="/products/"]').each((_, el) => {
          const $link = $(el);
          const href = $link.attr('href');

          if (!href || !href.includes('/products/')) return;

          const fullText = $link.text().replace(/\s+/g, ' ').trim();
          if (!fullText.includes('$')) return;

          const productUrl = href.startsWith('http') 
            ? href 
            : `https://www.holabirdsports.com${href.startsWith('/') ? '' : '/'}${href}`;

          if (seenUrls.has(productUrl)) return;

          const title = fullText.trim();
          if (!title || title.length < 5) return;

          const { brand, model } = parseBrandModel(title);
          const { salePrice, originalPrice, valid } = extractPrices($, $link, fullText);
          
          if (!valid || !salePrice || salePrice <= 0) return;
          if (!originalPrice || originalPrice <= salePrice) return;

          let imageUrl = null;
          const $img = $link.find('img').first();
          if ($img.length) {
            imageUrl = $img.attr('src') || $img.attr('data-src');
            if (imageUrl && !imageUrl.startsWith('http')) {
              imageUrl = imageUrl.startsWith('//') 
                ? 'https:' + imageUrl 
                : 'https://www.holabirdsports.com' + (imageUrl.startsWith('/') ? '' : '/') + imageUrl;
            }
          }

          seenUrls.add(productUrl);
          foundProducts++;

          deals.push({
            title,
            brand,
            model,
            store: "Holabird Sports",
            price: salePrice,
            originalPrice,
            url: productUrl,
            image: imageUrl,
            scrapedAt: new Date().toISOString()
          });
        });

        console.log(`[SCRAPER] Found ${foundProducts} products on page ${page}`);

        if (foundProducts === 0) {
          hasMore = false;
          break;
        }

        page++;
        await randomDelay();
      }
    }

    console.log(`[SCRAPER] Holabird Sports scrape complete. Found ${deals.length} deals.`);
    return deals;

  } catch (error) {
    console.error("[SCRAPER] Holabird Sports error:", error.message);
    throw error;
  }
}



function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Helper: Parse brand and model from title
 */
function parseBrandModel(title) {
  if (!title) return { brand: "Unknown", model: "" };

  // Keep your brand list, but you can add/remove freely
  const brands = [
    "361 Degrees", "adidas", "Allbirds", "Altra", "ASICS", "Brooks", "Craft", "Diadora",
    "HOKA", "Hylo Athletics", "INOV8", "Inov-8", "Karhu", "La Sportiva", "Lems",
    "Merrell", "Mizuno", "New Balance", "Newton", "Nike", "norda", "Nnormal",
    "On Running", "On", "Oofos", "Pearl Izumi", "Puma", "Reebok", "Salomon",
    "Saucony", "Saysh", "Skechers", "Skora", "The North Face", "Topo Athletic", "Topo",
    "Tyr", "Under Armour", "Vibram FiveFingers", "Vibram", "Vivobarefoot",
    "VJ Shoes", "VJ", "X-Bionic", "Xero Shoes", "Xero"
  ];

  // IMPORTANT: match longer brand names first (prevents "On" matching before "On Running")
  const brandsSorted = [...brands].sort((a, b) => b.length - a.length);

  let brand = "Unknown";
  let model = title;

  for (const b of brandsSorted) {
    const escaped = escapeRegExp(b);

    // Allow spaces/hyphens to behave naturally, but require "whole word-ish" matches.
    // Use lookarounds so brands with spaces/symbols still match cleanly.
    const regex = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i");

   if (regex.test(title)) {
     brand = b;

     // Remove the same boundary-safe match we detected
     model = title.replace(regex, " ").trim();
     model = model.replace(/\s+/g, " ");

     break;
     }
}

  // Delegate cleanup (your modelNameCleaner)
  model = cleanModelName(model);

  return { brand, model };
}


/**
 * UNIVERSAL PRICE EXTRACTOR
 * Uses the shared logic we discussed.
 * Returns: { salePrice: number|null, originalPrice: number|null, valid: boolean }
 */
function extractPrices($, $element, fullText) {
  // 1) Extract all $ amounts from text
  let prices = extractDollarAmounts(fullText);

  // 2) Try to reconstruct prices with superscript cents from DOM
  const supPrices = extractSuperscriptPrices($, $element);
  if (supPrices.length) {
    prices = prices.concat(supPrices);
  }

  // 3) Filter to reasonable shoe price range
  prices = prices.filter(p => Number.isFinite(p) && p >= 10 && p < 1000);
  if (!prices.length) {
    return { salePrice: null, originalPrice: null, valid: false };
  }

  // 4) Deduplicate prices (same value appearing multiple times in the text)
  prices = [...new Set(prices.map(p => p.toFixed(2)))].map(s => parseFloat(s));

  // If <2 prices → we don't know if it's discounted
  if (prices.length < 2) {
    return { salePrice: null, originalPrice: null, valid: false };
  }

  // If 4+ unique prices → too ambiguous
  if (prices.length > 3) {
    return { salePrice: null, originalPrice: null, valid: false };
  }

  // Sort high → low
  prices.sort((a, b) => b - a);

  // === 2 PRICES: max = original, min = sale, with sanity checks ===
  if (prices.length === 2) {
    const original = prices[0];
    const sale = prices[1];

    if (!(sale < original)) {
      return { salePrice: null, originalPrice: null, valid: false };
    }

    const discountPercent = ((original - sale) / original) * 100;
    if (discountPercent < 5 || discountPercent > 90) {
      return { salePrice: null, originalPrice: null, valid: false };
    }

    return { salePrice: sale, originalPrice: original, valid: true };
  }

  // === 3 PRICES: original = largest, other two are sale & savings ===
  if (prices.length === 3) {
    const original = prices[0];
    const remaining = prices.slice(1); // [x, y]
    const [p1, p2] = remaining;
    const tolPrice = 1; // $1 tolerance

    // 3a) "Save $X" pattern
    const saveAmount = findSaveAmount(fullText);
    if (saveAmount != null) {
      const isP1Save = Math.abs(p1 - saveAmount) <= tolPrice;
      const isP2Save = Math.abs(p2 - saveAmount) <= tolPrice;

      if (isP1Save && !isP2Save) {
        const sale = p2;
        const discountPercent = ((original - sale) / original) * 100;
        if (discountPercent >= 5 && discountPercent <= 90 && sale < original) {
          return { salePrice: sale, originalPrice: original, valid: true };
        }
      } else if (isP2Save && !isP1Save) {
        const sale = p1;
        const discountPercent = ((original - sale) / original) * 100;
        if (discountPercent >= 5 && discountPercent <= 90 && sale < original) {
          return { salePrice: sale, originalPrice: original, valid: true };
        }
      }
      // If both or neither look like save amount, fall through.
    }

    // 3b) "% off" pattern (e.g. "25% off")
    const percentOff = findPercentOff(fullText);
    if (percentOff != null) {
      const expectedSale = original * (1 - percentOff / 100);
      let saleCandidate = null;
      let bestDiff = Infinity;

      for (const p of remaining) {
        const diff = Math.abs(p - expectedSale);
        if (diff <= tolPrice && diff < bestDiff) {
          bestDiff = diff;
          saleCandidate = p;
        }
      }

      if (saleCandidate != null) {
        const discountPercent = ((original - saleCandidate) / original) * 100;
        if (discountPercent >= 5 && discountPercent <= 90 && saleCandidate < original) {
          return {
            salePrice: saleCandidate,
            originalPrice: original,
            valid: true
          };
        }
      }
    }

    // 3c) Fallback: assume larger of remaining is sale
    const sale = Math.max(...remaining);
    const discountPercent = ((original - sale) / original) * 100;
    if (discountPercent >= 5 && discountPercent <= 90 && sale < original) {
      return { salePrice: sale, originalPrice: original, valid: true };
    }

    return { salePrice: null, originalPrice: null, valid: false };
  }

  // Should never reach here, but just in case:
  return { salePrice: null, originalPrice: null, valid: false };
}

/**
 * Extract $X or $X.YY values from text
 */
function extractDollarAmounts(text) {
  if (!text) return [];
  const matches = text.match(/\$\s*[\d,]+(?:\.\d{1,2})?/g);
  if (!matches) return [];

  return matches
    .map(m => parseFloat(m.replace(/[$,\s]/g, '')))
    .filter(n => Number.isFinite(n));
}

/**
 * Extract prices where cents are in superscript / small tags
 */
function extractSuperscriptPrices($, $element) {
  const prices = [];
  if (!$ || !$element || !$element.find) return prices;

  // Look for elements that might contain "$DOLLARS" with children holding cents
  $element.find('sup, .cents, .price-cents, small').each((_, el) => {
    const $centsEl = $(el);
    const centsText = $centsEl.text().trim();
    if (!/^\d{1,2}$/.test(centsText)) return;

    const $parent = $centsEl.parent();
    const parentTextWithoutChildren = $parent
      .clone()
      .children()
      .remove()
      .end()
      .text();

    const dollarMatch = parentTextWithoutChildren.match(/\$\s*(\d+)/);
    if (!dollarMatch) return;

    const dollars = parseInt(dollarMatch[1], 10);
    const cents = parseInt(centsText, 10);
    if (!Number.isFinite(dollars) || !Number.isFinite(cents)) return;

    const price = dollars + cents / 100;
    if (price >= 10 && price < 1000) {
      prices.push(price);
    }
  });

  return prices;
}

/**
 * Find "Save $X" amount in text
 */
function findSaveAmount(text) {
  if (!text) return null;
  const match = text.match(/save\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const amount = parseFloat(match[1].replace(/,/g, ''));
  return Number.isFinite(amount) ? amount : null;
}

/**
 * Find "X% off" in text
 */
function findPercentOff(text) {
  if (!text) return null;
  const match = text.match(/(\d+)\s*%\s*off/i);
  if (!match) return null;
  const percent = parseInt(match[1], 10);
  return percent > 0 && percent < 100 ? percent : null;
}

/**
 * Random delay between min and max ms
 * Default: 3–5 seconds
 */
function randomDelay(min = 3000, max = 5000) {
  const wait = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, wait));
}
