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
    
    // Scrape Famous Footwear
    try {
      await sleep(2000); // Be respectful - 2 second delay between sites
      const famousDeals = await scrapeFamousFootwear();
      allDeals.push(...famousDeals);
      scraperResults["Famous Footwear"] = { success: true, count: famousDeals.length };
      console.log(`[SCRAPER] Famous Footwear: ${famousDeals.length} deals`);
    } catch (error) {
      scraperResults["Famous Footwear"] = { success: false, error: error.message };
      console.error("[SCRAPER] Famous Footwear failed:", error.message);
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

        // UNIVERSAL PRICE PARSER
        const { salePrice, originalPrice, valid } = extractPrices($, anchor, text);
        if (!valid || !salePrice || !Number.isFinite(salePrice)) return;

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
 * Scrape Famous Footwear running shoe deals
 * (uses the universal extractPrices helper)
 */
async function scrapeFamousFootwear() {
  console.log("[SCRAPER] Starting Famous Footwear scrape...");

  // TODO: Adjust these URLs to exactly the clearance/sale running-shoe pages you want
  const urls = [
    "https://www.famousfootwear.com/browse/sale/mens?icid=mdd_uncat_click_sale#sortCriteria=relevance&f-webgenders=Men's&cf-categories=Sneakers%20and%20Athletic%20Shoes,Running%20Shoes",
    "https://www.famousfootwear.com/browse/sale?icid=sdd_vwall#sortCriteria=relevance&f-webgenders=Women's&cf-categories=Sneakers%20and%20Athletic%20Shoes,Running%20Shoes"
  ];

  const deals = [];

  try {
    for (const url of urls) {
      console.log(`[SCRAPER] Fetching Famous Footwear page: ${url}`);

      const response = await axios.get(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 30000,
      });

      const $ = cheerio.load(response.data);

      // This selector is a starting point – you may refine it after inspecting Famous Footwear HTML.
      // We look for product tiles with links that contain "$" in their text (so they include prices).
      $("a").each((_, el) => {
        const $link = $(el);
        const href = $link.attr("href") || "";

        // Skip links that don't go to a product page
        if (!href || !href.includes("/product/")) return;

        const fullText = $link.text().replace(/\s+/g, " ").trim();
        if (!fullText.includes("$")) return;

        // Optional: filter a bit to focus on shoes
        if (!/shoe|sneaker|runner|running|athletic/i.test(fullText)) return;

        // Title: text before the first "$"
        const titlePart = fullText.split("$")[0].trim();
        if (!titlePart || titlePart.length < 5) return;

        const title = titlePart;
        const { brand, model } = parseBrandModel(title);

        // UNIVERSAL PRICE EXTRACTOR
        const { salePrice, originalPrice, valid } = extractPrices($, $link, fullText);
        if (!valid || !salePrice || !Number.isFinite(salePrice)) return;

        // Build full URL
        let fullUrl = href;
        if (!/^https?:\/\//i.test(fullUrl)) {
          fullUrl = "https://www.famousfootwear.com" + (href.startsWith("/") ? "" : "/") + href;
        }

        // Image (best-effort – may tweak selectors once you inspect HTML)
        let imageUrl = null;
        const $img = $link.find("img").first();
        if ($img.length) {
          imageUrl = $img.attr("src") || $img.attr("data-src");
          if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
            // Famous Footwear tends to use absolute URLs, but guard just in case
            imageUrl = "https://www.famousfootwear.com" +
              (imageUrl.startsWith("/") ? "" : "/") +
              imageUrl;
          }
        }

        deals.push({
          title,
          brand,
          model,
          store: "Famous Footwear",
          price: salePrice,
          originalPrice: originalPrice || null,
          url: fullUrl,
          image: imageUrl,
          scrapedAt: new Date().toISOString(),
        });
      });

      // Be polite between Famous Footwear pages
      await sleep(1500);
    }

    console.log(`[SCRAPER] Famous Footwear scrape complete. Found ${deals.length} deals.`);
    return deals;
  } catch (error) {
    console.error("[SCRAPER] Famous Footwear error:", error.message);
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
 * Helper: Sleep function
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
