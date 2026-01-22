const { put } = require("@vercel/blob");
const axios = require("axios");
const cheerio = require("cheerio");

const MENS_ROAD = "https://www.holabirdsports.com/collections/shoe-deals/Gender_Mens+Type_Running-Shoes+";

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const start = Date.now();
  const logs = [];

  try {
    logs.push(`Starting scrape of: ${MENS_ROAD}`);
    
    const resp = await axios.get(MENS_ROAD, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    });

    logs.push(`Got response, status: ${resp.status}, content-length: ${resp.data.length}`);

    const $ = cheerio.load(resp.data);
    
    const allLinks = $('a').length;
    const productLinks = $('a[href*="/products/"]').length;
    
    logs.push(`Total links on page: ${allLinks}`);
    logs.push(`Links with /products/: ${productLinks}`);

    if (productLinks === 0) {
      // Page might be JS-rendered, let's check what we got
      const title = $('title').text();
      const bodyLength = $('body').text().length;
      logs.push(`Page title: ${title}`);
      logs.push(`Body text length: ${bodyLength}`);
      
      // Sample some hrefs
      const sampleHrefs = [];
      $('a').slice(0, 5).each((_, el) => {
        const href = $(el).attr('href');
        if (href) sampleHrefs.push(href);
      });
      logs.push(`Sample hrefs: ${sampleHrefs.join(', ')}`);
    } else {
      // We found product links, let's see why they're not being processed
      let processedCount = 0;
      let skippedReasons = {
        noDollarSign: 0,
        noTitle: 0,
        noPrices: 0,
        duplicates: 0
      };
      
      const seen = new Set();
      
      $('a[href*="/products/"]').each((_, el) => {
        const $link = $(el);
        const href = $link.attr('href');
        
        if (!href || !href.includes('/products/')) return;
        
        const productUrl = href.startsWith('http') ? href : 'https://www.holabirdsports.com' + href;
        
        if (seen.has(productUrl)) {
          skippedReasons.duplicates++;
          return;
        }
        
        const $container = $link.closest("li, article, div").first();
        const containerText = $container.text().replace(/\s+/g, ' ').trim();
        
        if (!containerText || !containerText.includes("$")) {
          skippedReasons.noDollarSign++;
          return;
        }
        
        const title = $link.find("img").first().attr("alt") || 
                      $container.find("h2,h3,[class*='title'],[class*='name']").first().text() ||
                      $link.text();
        
        if (!title || title.trim().length < 3) {
          skippedReasons.noTitle++;
          return;
        }
        
        // Extract prices
        const priceMatches = containerText.match(/\$\s*[\d,]+(?:\.\d{1,2})?/g);
        const prices = priceMatches ? priceMatches.map(m => parseFloat(m.replace(/[$,\s]/g, ''))).filter(n => n >= 10 && n < 1000) : [];
        
        if (prices.length < 2) {
          skippedReasons.noPrices++;
          return;
        }
        
        seen.add(productUrl);
        processedCount++;
      });
      
      logs.push(`Processed: ${processedCount} products`);
      logs.push(`Skipped reasons: ${JSON.stringify(skippedReasons)}`);
    }

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "Holabird Sports",
      segment: "mens-road",
      totalDeals: 0,
      deals: [],
      debugLogs: logs
    };

    const blob = await put("holabird-mens-road-debug.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      totalDeals: 0,
      blobUrl: blob.url,
      duration: `${Date.now() - start}ms`,
      timestamp: output.lastUpdated,
      debugLogs: logs
    });
  } catch (err) {
    logs.push(`ERROR: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message, debugLogs: logs });
  }
};
