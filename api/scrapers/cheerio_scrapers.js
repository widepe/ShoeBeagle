const axios = require("axios");
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");
const { cleanModelName } = require("./modelNameCleaner");

/** --- CORE PRICE & PARSING HELPERS (As per your source) --- **/
// [Include your existing: normalizeWhitespace, cleanTitleText, absolutizeUrl, 
// pickBestImgUrl, parseBrandModel, detectGender, detectShoeType, extractPrices, etc.]

async function runCheerioScraper(name, urls, scraperFn) {
  console.log(`[CHEERIO] Scraping ${name}...`);
  try {
    return await scraperFn(urls);
  } catch (e) {
    console.error(`${name} failed:`, e.message);
    return [];
  }
}

// Example Scraper wrapper for Fleet Feet
async function scrapeFleetFeet() {
  const urls = ["https://www.fleetfeet.com/browse/shoes/mens?clearance=on", "https://www.fleetfeet.com/browse/shoes/womens?clearance=on"];
  const deals = [];
  // ... [Your existing Fleet Feet logic here] ...
  return deals;
}

// ... [Include your other scrapeXXXX functions here] ...

module.exports = async (req, res) => {
  const startTime = Date.now();
  const allDeals = [];
  
  // Sequential execution to avoid IP bans
  const fleetFeetDeals = await scrapeFleetFeet();
  allDeals.push(...fleetFeetDeals);
  
  // Add Running Warehouse, Lukes, Marathon similarly...

  const output = {
    lastUpdated: new Date().toISOString(),
    scrapeDurationMs: Date.now() - startTime,
    deals: allDeals
  };

  const blob = await put("cheerio_deals_blob.json", JSON.stringify(output, null, 2), {
    access: "public",
    addRandomSuffix: false,
  });

  res.status(200).json({ success: true, blobUrl: blob.url, count: allDeals.length });
};
