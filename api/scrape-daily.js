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
/* TEMPORARILY DISABLED - TESTING ZAPPOS
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
  console.log("[SCRAPER] Starting Running Warehouse scrape…");

  // These are the two main sale pages you were already using
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

      // Each product is essentially a big link whose text looks like:
      // "Clearance Brand Model Men's Shoes - Color $ 111.95 $140.00 *"
      $("a").each((_, el) => {
        const anchor = $(el);
        let text = anchor.text().replace(/\s+/g, " ").trim();

        if (!text.startsWith("Clearance ")) return;
        if (!/Shoes\b/i.test(text)) return;

        // Peel off the trailing asterisk, etc
        text = text.replace(/\*\s*$/, "").trim();

        const href = (anchor.attr("href") || "").trim().replace(/[\n\r]/g, "");
        if (!href) return;

        // Parse sale + original prices out of the text
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

        // Clean title (drop the prices from the text)
        const titleWithoutPrices = text.replace(/\$\s*\d[\d,]*\.?\d*/g, "").trim();
        const title = titleWithoutPrices;

        // Brand/model from the title, using your existing helper
        const { brand, model } = parseBrandModel(title);


        // Try to find an image somewhere in the same product “chunk”
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
          url: href,
          image: cleanImage,
          discount,
          scrapedAt: new Date().toISOString(),
        });
      });

      // Be polite so adding 3sec pause between pages being looked at
      await sleep(3000);
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
 * Scrape Zappos clearance/ on sale page
 */
async function scrapeZappos() {
  const deals = [];
  const url = 'const url = 'https://www.zappos.com/filters/running-shoes/4AEB4gIBHA.zso?t=running%20shoes';';
  
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
      
      // Get the product URL
      const link = $el.find('a[href*="/product/"]').first().attr('href');
      const fullLink = link && !link.startsWith('http') 
        ? `https://www.zappos.com${link}` 
        : link;
      
      // Get the image
      const imgSrc = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src');
      const imageUrl = imgSrc || null;
      
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

      if (title && sale > 0 && fullLink) {
        const { brand, model } = parseBrandModel(title);
        
        deals.push({
          title,
          brand,
          model,
          store: "Zappos",
          price: sale,
          originalPrice: original,
          image: imageUrl,
          url: fullLink,
          discount: discountPct > 0 ? `${discountPct}% OFF` : null,
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

  // Match dollar amounts like $114.88 or $155.00
  // This avoids matching model numbers like "5" in "Pegasus Trail 5"
  const matches = text.match(/\$\s*(\d[\d,]*\.?\d*)/g);
  if (!matches) {
    return { salePrice: 0, originalPrice: 0 };
  }

  const values = matches
    .map((m) => {
      // Remove $ and any spaces, then parse
      const cleaned = m.replace(/[$\s]/g, '').replace(/,/g, '');
      return parseFloat(cleaned);
    })
    .filter((v) => Number.isFinite(v) && v > 0);

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
