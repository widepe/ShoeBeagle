const https = require('https');
const http = require('http');

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

// Simple HTTP GET request helper with timeout
function fetch(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// Fallback: Use dummy data if scraping fails
function getDummyData(brand, model) {
  const dummyDeals = [
    {
      brand: "Nike",
      model: "Pegasus",
      title: "Nike Air Zoom Pegasus 40",
      price: 129.99,
      store: "Running Warehouse",
      url: "https://www.runningwarehouse.com",
      image: "https://placehold.co/600x400?text=Nike+Pegasus"
    },
    {
      brand: "Brooks",
      model: "Ghost",
      title: "Brooks Ghost 15",
      price: 139.95,
      store: "Road Runner Sports",
      url: "https://www.roadrunnersports.com",
      image: "https://placehold.co/600x400?text=Brooks+Ghost"
    },
    {
      brand: "Asics",
      model: "Gel-Nimbus",
      title: "Asics Gel-Nimbus 25",
      price: 159.99,
      store: "Running Warehouse",
      url: "https://www.runningwarehouse.com",
      image: "https://placehold.co/600x400?text=Asics+Nimbus"
    },
    {
      brand: "Hoka",
      model: "Clifton",
      title: "Hoka Clifton 9",
      price: 144.95,
      store: "Road Runner Sports",
      url: "https://www.roadrunnersports.com",
      image: "https://placehold.co/600x400?text=Hoka+Clifton"
    }
  ];

  const normalizedBrand = normalize(brand);
  const normalizedModel = normalize(model);

  return dummyDeals
    .filter(deal => {
      const dealBrand = normalize(deal.brand);
      const dealModel = normalize(deal.model);
      return dealBrand.includes(normalizedBrand) && dealModel.includes(normalizedModel);
    })
    .map(deal => ({
      title: deal.title,
      price: deal.price,
      store: deal.store,
      url: deal.url,
      image: deal.image
    }));
}

// Scrape Running Warehouse
async function scrapeRunningWarehouse(brand, model) {
  try {
    const searchQuery = `${brand} ${model}`.replace(/\s+/g, '+');
    const url = `https://www.runningwarehouse.com/searchresults.html?search=${searchQuery}`;
    
    console.log('[Running Warehouse] Attempting fetch:', url);
    const response = await fetch(url);
    
    console.log('[Running Warehouse] Response status:', response.status);
    console.log('[Running Warehouse] Response body length:', response.body?.length || 0);
    
    if (response.status !== 200) {
      console.log('[Running Warehouse] Non-200 status, skipping');
      return [];
    }

    const html = response.body;
    const results = [];

    // Look for product data in HTML
    const titleMatches = [...html.matchAll(/class="[^"]*product[^"]*title[^"]*"[^>]*>([^<]+)</gi)];
    const priceMatches = [...html.matchAll(/\$(\d+\.?\d{0,2})/g)];
    const urlMatches = [...html.matchAll(/href="(\/[^"]*\.html)"/g)];

    console.log('[Running Warehouse] Found matches:', {
      titles: titleMatches.length,
      prices: priceMatches.length,
      urls: urlMatches.length
    });

    const minLength = Math.min(titleMatches.length, priceMatches.length, urlMatches.length);
    
    for (let i = 0; i < Math.min(minLength, 5); i++) {
      const title = titleMatches[i]?.[1]?.trim();
      const price = priceMatches[i]?.[1] ? parseFloat(priceMatches[i][1]) : null;
      const productUrl = urlMatches[i]?.[1] ? `https://www.runningwarehouse.com${urlMatches[i][1]}` : null;

      if (title && price && productUrl && price > 10 && price < 500) {
        results.push({
          title: title,
          price: price,
          store: 'Running Warehouse',
          url: productUrl,
          image: 'https://placehold.co/600x400?text=Running+Shoe'
        });
      }
    }

    console.log('[Running Warehouse] Parsed results:', results.length);
    return results;

  } catch (err) {
    console.error('[Running Warehouse] Error:', err.message);
    return [];
  }
}

// In-memory cache
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

module.exports = async (req, res) => {
  const requestId =
    (req.headers && (req.headers["x-vercel-id"] || req.headers["x-request-id"])) ||
    `local-${Date.now()}`;
  const startedAt = Date.now();

  try {
    const rawQuery = req.query && req.query.query ? req.query.query : "";
    const query = normalize(rawQuery);
    
    console.log("[/api/search] Request:", { requestId,
