// /api/scrapers/rununited-firecrawl.js

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = { maxDuration: 90 };

const STORE = "Run United";
const VIA = "firecrawl";

const SOURCES = [
  // ROAD
  {
    url: "https://rununited.com/mens/footwear/road-running-shoes/?page=1&rb_custom_field_e70b59714528d5798b1c8adaf0d0ed15=On%20Sale",
    shoeType: "road",
  },
  {
    url: "https://rununited.com/womens/footwear/road-running-shoes/?page=1&rb_custom_field_e70b59714528d5798b1c8adaf0d0ed15=On%20Sale",
    shoeType: "road",
  },

  // TRAIL
  {
    url: "https://rununited.com/mens/footwear/trail-running-shoes/?page=1&rb_custom_field_e70b59714528d5798b1c8adaf0d0ed15=On%20Sale&rb_custom_field_69a256025f66e4ce5d15c9dd7225d357=Running",
    shoeType: "trail",
  },
  {
    url: "https://rununited.com/womens/footwear/trail-running-shoes/?page=1&rb_custom_field_69a256025f66e4ce5d15c9dd7225d357=Running&rb_custom_field_e70b59714528d5798b1c8adaf0d0ed15=On%20Sale",
    shoeType: "trail",
  },

  // TRACK
  {
    url: "https://rununited.com/mens/footwear/track-running-shoes/?page=1&rb_custom_field_69a256025f66e4ce5d15c9dd7225d357=Running&rb_custom_field_e70b59714528d5798b1c8adaf0d0ed15=On%20Sale",
    shoeType: "track",
  },
  {
    url: "https://rununited.com/womens/footwear/track-running-shoes/?page=1&rb_custom_field_69a256025f66e4ce5d15c9dd7225d357=Running&rb_custom_field_e70b59714528d5798b1c8adaf0d0ed15=On%20Sale",
    shoeType: "track",
  },
];

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function toNumberFromMoney(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[^\d.]/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDiscountPercent(labelText, salePrice, originalPrice) {
  const m = cleanText(labelText).match(/(\d+)\s*%/);
  if (m) return Number(m[1]);

  if (
    typeof salePrice === "number" &&
    typeof originalPrice === "number" &&
    originalPrice > 0 &&
    salePrice < originalPrice
  ) {
    return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  }
  return null;
}

function parseTitleForBrandGenderModel(name) {
  const s = cleanText(name);
  const m = s.match(/^(.*?)\s+(Men's|Women's|Unisex|Kids')\s+(.*)$/i);
  if (!m) return { brand: null, gender: null, model: null };

  let model = cleanText(m[3])
    .replace(/\s+Running Shoes\s*$/i, "")
    .replace(/\s+Shoes\s*$/i, "");

  return {
    brand: cleanText(m[1]),
    gender: /^men/i.test(m[2])
      ? "mens"
      : /^women/i.test(m[2])
      ? "womens"
      : null,
    model,
  };
}

async function firecrawlPage(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  const MAX_CLICKS = 10;

  const body = {
    url,
    formats: ["html"],
    onlyMainContent: false,
    maxAge: 0,
    timeout: 60000,
    actions: [
      { type: "wait", milliseconds: 12000 },
      {
        type: "executeJavascript",
        script: `
          (async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            let clicks = 0;
            for (let i = 0; i < ${MAX_CLICKS}; i++) {
              const btn = document.querySelector('a.snize-pagination-load-more');
              if (!btn) break;
              btn.click();
              clicks++;
              await sleep(1400);
              window.scrollTo(0, document.body.scrollHeight);
              await sleep(300);
            }
            return clicks;
          })();
        `,
      },
      { type: "wait", milliseconds: 6000 },
    ],
  };

  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(await resp.text());
  }

  const json = await resp.json();
  return json.data.html;
}

function parseDeals(html, shoeType) {
  const $ = cheerio.load(html);
  const tiles = $("li.snize-product");
  const deals = [];

  tiles.each((_, el) => {
    const $tile = $(el);

    const isOut =
      $tile.hasClass("snize-product-out-of-stock") ||
      $tile.find(".snize-out-of-stock").length > 0 ||
      /out\s*of\s*stock/i.test($tile.text());

    if (isOut) return;

    const listingName = cleanText($tile.find(".snize-title").text());
    const listingURL = cleanText(
      $tile.find("a.snize-view-link").attr("href")
    );

    const salePrice = toNumberFromMoney(
      $tile.find(".snize-price-with-discount").text()
    );
    const originalPrice = toNumberFromMoney(
      $tile.find(".snize-discounted-price").text()
    );

    if (!salePrice || !originalPrice) return;

    const discountPercent = parseDiscountPercent(
      $tile.find(".snize-product-discount-label").text(),
      salePrice,
      originalPrice
    );

    const imageURL = cleanText(
      $tile.find(".snize-thumbnail img.snize-item-image").first().attr("src")
    );

    const { brand, gender, model } =
      parseTitleForBrandGenderModel(listingName);

    deals.push({
      schemaVersion: 1,
      listingName,
      brand: brand || "",
      model: model || "",
      salePrice,
      originalPrice,
      discountPercent,
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,
      store: STORE,
      listingURL,
      imageURL,
      gender: gender || "",
      shoeType,
    });
  });

  return { deals, totalTiles: tiles.length };
}

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    let allDeals = [];
    let totalTiles = 0;

    for (const source of SOURCES) {
      console.log("Scraping:", source.url);
      const html = await firecrawlPage(source.url);
      const { deals, totalTiles: count } = parseDeals(
        html,
        source.shoeType
      );
      totalTiles += count;
      allDeals.push(...deals);
    }

    const payload = {
      store: STORE,
      schemaVersion: 1,
      lastUpdated: new Date().toISOString(),
      via: VIA,
      sourceUrls: SOURCES.map((s) => s.url),
      pagesFetched: SOURCES.length,
      dealsFound: totalTiles,
      dealsExtracted: allDeals.length,
      scrapeDurationMs: Date.now() - t0,
      ok: true,
      error: null,
      deals: allDeals,
    };

    const blob = await put(
      "run-united.json",
      JSON.stringify(payload, null, 2),
      {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
        token: process.env.BLOB_READ_WRITE_TOKEN,
      }
    );

    res.status(200).json({
      ok: true,
      pagesFetched: SOURCES.length,
      dealsFound: totalTiles,
      dealsExtracted: allDeals.length,
      blobUrl: blob.url,
      elapsedMs: Date.now() - t0,
    });
  } catch (err) {
    res.status(200).json({
      ok: false,
      error: err.message,
      elapsedMs: Date.now() - t0,
    });
  }
}
