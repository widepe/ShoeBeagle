// /api/scrapers/rununited-firecrawl.js
//
// RunUnited (BigCommerce + Searchanise) "On Sale" road-running shoes (MEN) — single page only.
// Uses Firecrawl to render JS, then Cheerio to parse the product tiles, then writes run-united.json to Vercel Blob.
//
// Env vars you need:
// - FIRECRAWL_API_KEY
// - BLOB_READ_WRITE_TOKEN
// - RUNUNITED_DEALS_BLOB_URL (optional; used only for reporting/consistency)
//
// Test in browser:
//   /api/scrapers/rununited-firecrawl
//
// Notes:
// - shoeType is forced to "road"
// - This version scrapes ONLY the single URL you gave (page=1)
//
// CRON auth (install CRON_SECRET, but commented out for testing)
// const auth = req.headers.authorization;
// if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
//   return res.status(401).json({ success: false, error: "Unauthorized" });
// }

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = {
  maxDuration: 60, // seconds (raise if needed on Pro)
};

const STORE = "Run United";
const VIA = "firecrawl";

const SOURCE_URL =
  "https://rununited.com/mens/footwear/road-running-shoes/?page=1&rb_custom_field_e70b59714528d5798b1c8adaf0d0ed15=On%20Sale";

function nowIso() {
  return new Date().toISOString();
}

function toNumberFromMoney(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/\s+/g, " ")
    .replace(/[^\d.]/g, "")
    .trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDiscountPercent(labelText, salePrice, originalPrice) {
  // Prefer label like "20% off"
  if (labelText) {
    const m = String(labelText).match(/(\d+)\s*%/);
    if (m) return Number(m[1]);
  }
  // Fallback compute
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
  // Expected: "HOKA Men's Skyflow Frost/Solar Flare Running Shoes"
  // Brand may be multi-word ("New Balance"), so capture lazily up to gender token.
  const s = String(listingName || "").trim();

  const m = s.match(/^(.*?)\s+(Men's|Women's|Unisex|Kids')\s+(.*)$/i);
  if (!m) {
    return { brand: null, gender: null, model: null };
  }

  const brand = m[1].trim();
  const genderRaw = m[2].trim();
  let rest = m[3].trim();

  // Strip common trailing descriptors to get model
  // (keep it conservative; don’t over-trim)
  rest = rest.replace(/\s+Running Shoes\s*$/i, "").trim();
  rest = rest.replace(/\s+Shoes\s*$/i, "").trim();

  const gender =
    /^men/i.test(genderRaw) ? "mens" :
    /^women/i.test(genderRaw) ? "womens" :
    /^kids/i.test(genderRaw) ? "kids" :
    /^unisex/i.test(genderRaw) ? "unisex" :
    null;

  const model = rest || null;
  return { brand: brand || null, gender, model };
}

async function firecrawlGetRenderedHtml(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY");

const body = {
  url,
  formats: ["html"],
  onlyMainContent: false,
  maxAge: 0,
  timeout: 45000,

  actions: [
    // Let the page boot
    { type: "wait", milliseconds: 2000 },

    // Wait until first batch of tiles exists
    { type: "wait", selector: "li.snize-product" },

    // Click "Show more" once
    { type: "click", selector: ".snize-show-more" },

    // Give it time to fetch + render more
    { type: "wait", milliseconds: 2500 },

    // Wait until we have at least ~30 tiles (if it loads to ~40, great)
    { type: "wait", selector: "li.snize-product:nth-of-type(30)" },

    // Click "Show more" a second time (harmless if already loaded all)
    { type: "click", selector: ".snize-show-more" },

    { type: "wait", milliseconds: 2500 },

    // Wait until we have at least ~40
    { type: "wait", selector: "li.snize-product:nth-of-type(40)" },
  ],
};
  console.log("Firecrawl actions:", body.actions);
  console.log("Firecrawl body.waitFor type:", typeof body.waitFor, body.waitFor);  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
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

  tiles.each((_, el) => {
    const $tile = $(el);

    const a = $tile.find("a.snize-view-link").first();
    const listingURL = a.attr("href")?.trim() || null;

    const listingName =
      $tile.find(".snize-title").first().text().replace(/\s+/g, " ").trim() || null;

    const imageURL =
      $tile.find(".snize-thumbnail img.snize-item-image").first().attr("src")?.trim() || null;

    // In your sample:
    // - .snize-price-with-discount is the SALE price ($128)
    // - .snize-discounted-price is the OLD/original price ($160)
    const salePriceText = $tile.find(".snize-price-with-discount").first().text();
    const originalPriceText = $tile.find(".snize-discounted-price").first().text();

    const salePrice = toNumberFromMoney(salePriceText);
    const originalPrice = toNumberFromMoney(originalPriceText);

    const discountLabelText =
      $tile.find(".snize-product-discount-label").first().text().replace(/\s+/g, " ").trim() || "";

    const discountPercent = parseDiscountPercent(discountLabelText, salePrice, originalPrice);

    const { brand, gender, model } = parseTitleForBrandGenderModel(listingName);

    // Honesty rule alignment: keep only deals with both prices
    if (
      !listingURL ||
      !listingName ||
      typeof salePrice !== "number" ||
      typeof originalPrice !== "number"
    ) {
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

      // No ranges expected on these tiles; keep fields but null them
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
  };
}
console.log("RUNUNITED tiles:", dealsFound, "extracted:", dealsExtracted);const { deals, dealsFound, dealsExtracted } = parseDealsFromHtml(html);
console.log("RUNUNITED tiles after actions:", dealsFound, "dealsExtracted:", dealsExtracted);export default async function handler(req, res) {
  const t0 = Date.now();

  try {
    // CRON auth (commented for testing)
    // const auth = req.headers.authorization;
    // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    //   return res.status(401).json({ success: false, error: "Unauthorized" });
    // }

    const { html } = await firecrawlGetRenderedHtml(SOURCE_URL);
    const { deals, dealsFound, dealsExtracted } = parseDealsFromHtml(html);

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

      deals,
    };

    // Write to blob path run-united.json (stable URL if addRandomSuffix: false)
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
