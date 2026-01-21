// Test file for Holabird Sports scraper
const axios = require('axios');
const cheerio = require('cheerio');
const { cleanModelName } = require('./modelNameCleaner');

/**
 * Scrape Holabird Sports running shoe deals
 * Includes both road running shoes and trail running shoes
 */
async function scrapeHolabirdSports() {
  console.log("[SCRAPER] Starting Holabird Sports scrape...");

  // Both running shoes and trail running shoes deal pages
  const baseUrls = [
    "https://www.holabirdsports.com/collections/running-deals/Type_Running-Shoes+",
    "https://www.holabirdsports.com/collections/shoe-deals/Type_Trail-Running-Shoes+"
  ];

  const deals = [];
  const seenUrls = new Set();

  try {
    // Loop through both collections
    for (const baseUrl of baseUrls) {
      console.log(`[SCRAPER] Scraping collection: ${baseUrl}`);

      // They may have pagination - check up to 3 pages per collection
      for (let page = 1; page <= 3; page++) {
        const url = `${baseUrl}?page=${page}`;
        console.log(`[SCRAPER] Fetching Holabird Sports page ${page}: ${url}`);

        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          timeout: 30000
        });

        const $ = cheerio.load(response.data);

        // Find product links
        $('a[href*="/products/"]').each((_, el) => {
          const $link = $(el);
          const href = $link.attr('href');

          if (!href || !href.includes('/products/')) return;

          // Build full URL
          let fullUrl = href;
          if (!fullUrl.startsWith('http')) {
            fullUrl = 'https://www.holabirdsports.com' + (href.startsWith('/') ? '' : '/') + href;
          }

          // Skip duplicates across both collections
          if (seenUrls.has(fullUrl)) return;

          // Get all text from the link
          const fullText = $link.text().replace(/\s+/g, ' ').trim();

          // Must have price indicator
          if (!fullText.includes('$')) return;

          const title = fullText.trim();
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
            if (imageUrl && !imageUrl.startsWith('http')) {
              if (imageUrl.startsWith('//')) {
                imageUrl = 'https:' + imageUrl;
              } else {
                imageUrl = 'https://www.holabirdsports.com' + (imageUrl.startsWith('/') ? '' : '/') + imageUrl;
              }
            }
          }

          seenUrls.add(fullUrl);

          deals.push({
            title,
            brand,
            model,
            store: "Holabird Sports",
            price: salePrice,
            originalPrice: originalPrice || null,
            url: fullUrl,
            image: imageUrl,
            scrapedAt: new Date().toISOString()
          });
        });

        // Check if there are more pages (if no products found, stop)
        if ($('a[href*="/products/"]').length === 0) {
          console.log(`[SCRAPER] No products found on page ${page}, stopping pagination for this collection`);
          break;
        }

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

// Helper functions copied from your main scraper
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBrandModel(title) {
  if (!title) return { brand: "Unknown", model: "" };

  const brands = [
    "361 Degrees", "adidas", "Allbirds", "Altra", "ASICS", "Brooks", "Craft", "Diadora",
    "HOKA", "Hylo Athletics", "INOV8", "Inov-8", "Karhu", "La Sportiva", "Lems",
    "Merrell", "Mizuno", "New Balance", "Newton", "Nike", "norda", "Nnormal",
    "On Running", "On", "Oofos", "Pearl Izumi", "Puma", "Reebok", "Salomon",
    "Saucony", "Saysh", "Skechers", "Skora", "The North Face", "Topo Athletic", "Topo",
    "Tyr", "Under Armour", "Vibram FiveFingers", "Vibram", "Vivobarefoot",
    "VJ Shoes", "VJ", "X-Bionic", "Xero Shoes", "Xero"
  ];

  const brandsSorted = [...brands].sort((a, b) => b.length - a.length);

  let brand = "Unknown";
  let model = title;

  for (const b of brandsSorted) {
    const escaped = escapeRegExp(b);
    const regex = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i");

    if (regex.test(title)) {
      brand = b;
      model = title.replace(regex, " ").trim();
      model = model.replace(/\s+/g, " ");
      break;
    }
  }

  model = cleanModelName(model);
  return { brand, model };
}

function extractPrices($, $element, fullText) {
  let prices = extractDollarAmounts(fullText);
  const supPrices = extractSuperscriptPrices($, $element);
  if (supPrices.length) {
    prices = prices.concat(supPrices);
  }

  prices = prices.filter(p => Number.isFinite(p) && p >= 10 && p < 1000);
  if (!prices.length) {
    return { salePrice: null, originalPrice: null, valid: false };
  }

  prices = [...new Set(prices.map(p => p.toFixed(2)))].map(s => parseFloat(s));

  if (prices.length < 2) {
    return { salePrice: null, originalPrice: null, valid: false };
  }

  if (prices.length > 3) {
    return { salePrice: null, originalPrice: null, valid: false };
  }

  prices.sort((a, b) => b - a);

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

  if (prices.length === 3) {
    const original = prices[0];
    const remaining = prices.slice(1);
    const [p1, p2] = remaining;
    const tolPrice = 1;

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
    }

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

    const sale = Math.max(...remaining);
    const discountPercent = ((original - sale) / original) * 100;
    if (discountPercent >= 5 && discountPercent <= 90 && sale < original) {
      return { salePrice: sale, originalPrice: original, valid: true };
    }

    return { salePrice: null, originalPrice: null, valid: false };
  }

  return { salePrice: null, originalPrice: null, valid: false };
}

function extractDollarAmounts(text) {
  if (!text) return [];
  const matches = text.match(/\$\s*[\d,]+(?:\.\d{1,2})?/g);
  if (!matches) return [];

  return matches
    .map(m => parseFloat(m.replace(/[$,\s]/g, '')))
    .filter(n => Number.isFinite(n));
}

function extractSuperscriptPrices($, $element) {
  const prices = [];
  if (!$ || !$element || !$element.find) return prices;

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

function findSaveAmount(text) {
  if (!text) return null;
  const match = text.match(/save\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const amount = parseFloat(match[1].replace(/,/g, ''));
  return Number.isFinite(amount) ? amount : null;
}

function findPercentOff(text) {
  if (!text) return null;
  const match = text.match(/(\d+)\s*%\s*off/i);
  if (!match) return null;
  const percent = parseInt(match[1], 10);
  return percent > 0 && percent < 100 ? percent : null;
}

function randomDelay(min = 3000, max = 5000) {
  const wait = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, wait));
}

// Run the test
async function test() {
  try {
    console.log("Starting Holabird Sports test scrape...\n");
    const deals = await scrapeHolabirdSports();
    
    console.log("\n====== RESULTS ======");
    console.log(`Total deals found: ${deals.length}\n`);
    
    // Show first 5 deals as examples
    console.log("Sample deals:");
    deals.slice(0, 5).forEach((deal, i) => {
      console.log(`\n${i + 1}. ${deal.title}`);
      console.log(`   Brand: ${deal.brand}`);
      console.log(`   Model: ${deal.model}`);
      console.log(`   Price: $${deal.price} (was $${deal.originalPrice})`);
      console.log(`   URL: ${deal.url}`);
      if (deal.image) console.log(`   Image: ${deal.image}`);
    });

    console.log(`\n... and ${deals.length - 5} more deals`);
    
  } catch (error) {
    console.error("Test failed:", error);
  }
}

test();
