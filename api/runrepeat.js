// runrepeat-database.js
// Builds a running shoe spec database from RunRepeat
// Uploads to Vercel Blob: shoe-database.json

import { put } from "@vercel/blob";

const BASE_URL =
  "https://runrepeat.com/ranking/rankings-of-running-shoes?gender=women&page=";

const START_PAGE = 1;
const END_PAGE = 10;

const STORE = "RunRepeat";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHTML(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  return await res.text();
}

function extract(regex, html) {
  const m = html.match(regex);
  return m ? m[1].trim() : null;
}

function extractLinks(html) {
  const regex = /href="(https:\/\/runrepeat\.com\/[^"]+)"/g;
  const links = new Set();

  let match;

  while ((match = regex.exec(html)) !== null) {
    const url = match[1];

    if (
      !url.includes("ranking") &&
      !url.includes("compare") &&
      !url.includes("best")
    ) {
      links.add(url);
    }
  }

  return [...links];
}

function parseShoe(html, url) {
  const brand = extract(
    /aggregate_rating_wrapper.*?alt="([^"]+)"/s,
    html
  );

  const model = extract(
    /main-shoe-title.*?<span[^>]*>(.*?)<\/span>/s,
    html
  );

  const score = extract(
    /runscore-value[^>]*>(.*?)</,
    html
  );

  const reviewCount = extract(
    /stars-container.*?<a[^>]*>(.*?)</s,
    html
  );

  const price = extract(
    /fact-item_price.*?\$([0-9.]+)/s,
    html
  );

  const weight = extract(
    /fact-item_weight.*?>([0-9.]+\s?oz)/s,
    html
  );

  const heelDrop = extract(
    /heel-to-toe-drop.*?>([0-9.]+\s?mm)/s,
    html
  );

  const heelStack = extract(
    /heel-height.*?>([0-9.]+\s?mm)/s,
    html
  );

  const forefootStack = extract(
    /forefoot-height.*?>([0-9.]+\s?mm)/s,
    html
  );

  return {
    brand,
    model,

    price: price ? Number(price) : null,
    salePrice: null,

    score: score ? Number(score) : null,
    reviewCount: reviewCount
      ? Number(reviewCount.replace(/[^\d]/g, ""))
      : null,

    weight,

    heelStackHeight: heelStack,
    forefootStackHeight: forefootStack,
    heelToToeDrop: heelDrop,

    shoeSupportType: null,
    shoeDesignType: null,
    plateType: null,

    toeBox: null,

    surface: null,
    cushioning: null,

    notes,

    releaseDate: null,
    discontinued: null,

    source: STORE,
    sourceUrl: url
  };
}

async function scrapeListingPages() {
  const urls = new Set();

  for (let page = START_PAGE; page <= END_PAGE; page++) {
    const url = BASE_URL + page;

    console.log("Scraping listing page", page);

    const html = await getHTML(url);

    const links = extractLinks(html);

    links.forEach((l) => urls.add(l));

    await sleep(1000);
  }

  return [...urls];
}

async function scrapeShoes(urls) {
  const shoes = [];

  for (const url of urls) {
    console.log("Scraping shoe", url);

    try {
      const html = await getHTML(url);

      const shoe = parseShoe(html, url);

      if (shoe.brand && shoe.model) {
        shoes.push(shoe);
      }

      await sleep(500);
    } catch (e) {
      console.log("Failed:", url);
    }
  }

  return shoes;
}

export default async function handler(req, res) {
  const start = Date.now();

  try {
    const urls = await scrapeListingPages();

    console.log("Total shoes found:", urls.length);

    const shoes = await scrapeShoes(urls);

    const payload = {
      source: STORE,
      lastUpdated: new Date().toISOString(),
      shoesFound: urls.length,
      shoesExtracted: shoes.length,
      scrapeDurationMs: Date.now() - start,
      shoes
    };

    const blob = await put(
      "shoe-database.json",
      JSON.stringify(payload, null, 2),
      {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json"
      }
    );

    return res.status(200).json({
      ok: true,
      blobUrl: blob.url,
      shoes: shoes.length
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
