// /api/scrapers/rununited-firecrawl.js
//
// RunUnited (BigCommerce + Searchanise) "On Sale" road-running shoes (MEN) — single URL for now.
// Uses Firecrawl to render JS + click "Show more" repeatedly,
// then Cheerio to parse tiles, then writes run-united.json to Vercel Blob.
//
// Env vars you need:
// - FIRECRAWL_API_KEY
// - BLOB_READ_WRITE_TOKEN
// - RUNUNITED_DEALS_BLOB_URL (optional; only for reporting/consistency)
//
// Test in browser:
//   /api/scrapers/rununited-firecrawl
//
// Notes:
// - shoeType is forced to "road" for this URL.
// - Drops ALL out-of-stock tiles (by class + badge + text fallback).
//
// CRON auth (install CRON_SECRET, but comment it out for testing):
// const auth = req.headers.authorization;
// if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
//   return res.status(401).json({ success: false, error: "Unauthorized" });
// }

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = {
  maxDuration: 60,
};

const STORE = "Run United";
const VIA = "firecrawl";

const SOURCE_URL =
  "https://rununited.com/mens/footwear/road-running-shoes/?page=1&rb_custom_field_e70b59714528d5798b1c8adaf0d0ed15=On%20Sale";

function nowIso() {
  return new Date().toISOString();
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function toNumberFromMoney(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[^\d.]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDiscountPercent(labelText, salePrice, originalPrice) {
  const t = cleanText(labelText);
  const m = t.match(/(\d+)\s*%/);
  if (m) return Number(m[1]);

  if (
    typeof salePrice === "number" &&
    typeof originalPrice === "number" &&
    originalPrice > 0 &&
    salePrice >= 0 &&
    salePrice < originalPrice
  ) {
    return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  }
  return null;
}

function parseTitleForBrandGenderModel(listingName) {
  // Example: "HOKA Men's Skyflow Frost/Solar Flare Running Shoes"
  const s = cleanText(listingName);

  const m = s.match(/^(.*?)\s+(Men's|Women's|Unisex|Kids')\s+(.*)$/i);
  if (!m) return { brand: null, gender: null, model: null };

  const brand = cleanText(m[1]);
  const genderRaw = cleanText(m[2]);
  let rest = cleanText(m[3]);

  rest = rest.replace(/\s+Running Shoes\s*$/i, "").trim();
  rest = rest.replace(/\s+Shoes\s*$/i, "").trim();

  const gender =
    /^men/i.test(genderRaw) ? "mens" :
    /^women/i.test(genderRaw) ? "womens" :
    /^kids/i.test(genderRaw) ? "kids" :
    /^unisex/i.test(genderRaw) ? "unisex" :
    null;

  return { brand: brand || null, gender, model: rest || null };
}

async function firecrawlGetRenderedHtml(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY");

  // Avoid selector-based actions that can hard-fail with "Element not found".
  // Use fixed waits + safe JS that clicks "Show more" up to MAX_CLICKS times.
  const MAX_CLICKS = 10; // bump if you ever need more than 200 items
  const body = {
    url,
    formats: ["html"],
    onlyMainContent: false,
    maxAge: 0,
    timeout: 60000,

    actions: [
      { type: "wait", milliseconds: 12000 },
      { type: "scroll", direction: "down" },
      { type: "wait", milliseconds: 1500 },

      {
        type: "executeJavascript",
        script: `
          (async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));

            let clicks = 0;
            for (let i = 0; i < ${MAX_CLICKS}; i++) {
              // Find the Searchanise "Show more" link
              const btn = document.querySelector('a.snize-pagination-load-more');
              if (!btn) break;

              btn.click();
              clicks++;

              // wait for new tiles to render
              await sleep(1400);

              // nudge scroll so the button stays reachable
              window.scrollTo(0, document.body.scrollHeight);
              await sleep(300);
            }

            return { clicksAttempted: ${MAX_CLICKS}, clicksDone: clicks };
          })();
        `,
      },

      // Extra time for final batch to render
      { type: "wait", milliseconds: 6000 },
      { type: "scroll", direction: "down" },
      { type: "wait", milliseconds: 1500 },
    ],
  };

  console.log("Firecrawl: will try show-more clicks:", MAX_CLICKS);

  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Firecrawl scrape failed (${resp.status}): ${txt}`);
  }

  const json = await resp.json();
  if (!json?.success) {
    throw new Error(`Firecrawl scrape failed: ${JSON.stringify(json)}`);
  }

  const html = json?.data?.html;
  if (!html || typeof html !== "string") {
    throw new Error("Firecrawl returned no html in data.html");
  }

  return { html, raw: json };
}

function parseDealsFromHtml(html) {
  const $ = cheerio.load(html);

  const tiles = $("li.snize-product");
  const deals = [];

  let droppedOutOfStock = 0;
  let droppedMissingPrices = 0;

  tiles.each((_, el) => {
    const $tile = $(el);

    // Drop ALL out of stock, no matter where text is included
    const tileText = $tile.text();
    const isOutOfStock =
      $tile.hasClass("snize-product-out-of-stock") ||
      $tile.find(".snize-out-of-stock").length > 0 ||
      /out\s*of\s*stock/i.test(tileText);

    if (isOutOfStock) {
      droppedOutOfStock++;
      return;
    }

    const a = $tile.find("a.snize-view-link").first();
    const listingURL = cleanText(a.attr("href"));

    const listingName = cleanText($tile.find(".snize-title").first().text());

    const imageURL = cleanText(
      $tile.find(".snize-thumbnail img.snize-item-image").first().attr("src")
    );

    const salePriceText = $tile.find(".snize-price-with-discount").first().text();
    const originalPriceText = $tile.find(".snize-discounted-price").first().text();

    const salePrice = toNumberFromMoney(salePriceText);
    const originalPrice = toNumberFromMoney(originalPriceText);

    const discountLabelText = cleanText(
      $tile.find(".snize-product-discount-label").first().text()
    );

    const discountPercent = parseDiscountPercent(discountLabelText, salePrice, originalPrice);
    const { brand, gender, model } = parseTitleForBrandGenderModel(listingName);

    // Honesty rule: must have both prices + url + title
    if (!listingURL || !listingName) return;
    if (typeof salePrice !== "number" || typeof originalPrice !== "number") {
      droppedMissingPrices++;
      return;
    }

    deals.push({
      schemaVersion: 1,

      listingName,

      brand: brand || "",
      model: model || "",

      salePrice,
      originalPrice,
      discountPercent: typeof discountPercent === "number" ? discountPercent : null,

      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,

      store: STORE,

      listingURL,
      imageURL: imageURL || "",

      gender: gender || "",
      shoeType: "road",
    });
  });

  return {
    deals,
    dealsFound: tiles.length,
    dealsExtracted: deals.length,
    droppedOutOfStock,
    droppedMissingPrices,
  };
}

export default async function handler(req, res) {
  const t0 = Date.now();

  try {
    // CRON auth (commented for testing)
    // const auth = req.headers.authorization;
    // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    //   return res.status(401).json({ success: false, error: "Unauthorized" });
    // }

    const { html } = await firecrawlGetRenderedHtml(SOURCE_URL);
    const {
      deals,
      dealsFound,
      dealsExtracted,
      droppedOutOfStock,
      droppedMissingPrices,
    } = parseDealsFromHtml(html);

    console.log("RUNUNITED tiles:", dealsFound, "extracted:", dealsExtracted);
    console.log("RUNUNITED droppedOutOfStock:", droppedOutOfStock, "droppedMissingPrices:", droppedMissingPrices);

    const payload = {
      store: STORE,
      schemaVersion: 1,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls: [SOURCE_URL],

      pagesFetched: 1,

      dealsFound,
      dealsExtracted,

      scrapeDurationMs: Date.now() - t0,

      ok: true,
      error: null,

      // Optional diagnostics (helpful for validating hand-counts)
      droppedOutOfStock,
      droppedMissingPrices,

      deals,
    };

    const blob = await put("run-united.json", JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    return res.status(200).json({
      ok: true,
      runId: `rununited-${Date.now().toString(36)}`,
      store: STORE,
      pagesFetched: 1,
      dealsFound,
      dealsExtracted,
      droppedOutOfStock,
      droppedMissingPrices,
      blobUrl: blob.url,
      expectedBlobUrl: process.env.RUNUNITED_DEALS_BLOB_URL || null,
      elapsedMs: Date.now() - t0,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      store: STORE,
      error: err?.message || String(err),
      elapsedMs: Date.now() - t0,
    });
  }
}
