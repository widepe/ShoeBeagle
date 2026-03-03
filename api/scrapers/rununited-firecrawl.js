// /api/scrapers/rununited-firecrawl.js
//
// RunUnited (BigCommerce + Searchanise) "On Sale" road-running shoes (MEN) — single URL for now.
// Uses Firecrawl to render JS + click "Show more", then Cheerio to parse tiles,
// then writes run-united.json to Vercel Blob.
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
// - This version scrapes ONLY the single URL you gave.
// - Searchanise typically shows 20 items, then "Show more" loads more. We click it twice.
//
// CRON auth (install CRON_SECRET, but comment it out for testing):
// const auth = req.headers.authorization;
// if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
//   return res.status(401).json({ success: false, error: "Unauthorized" });
// }

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = {
  maxDuration: 60, // seconds
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
  // Brand may be multi-word. Capture lazily up to gender token.
  const s = cleanText(listingName);

  const m = s.match(/^(.*?)\s+(Men's|Women's|Unisex|Kids')\s+(.*)$/i);
  if (!m) return { brand: null, gender: null, model: null };

  const brand = cleanText(m[1]);
  const genderRaw = cleanText(m[2]);
  let rest = cleanText(m[3]);

  // Strip trailing descriptors conservatively
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

  const body = {
    url,
    formats: ["html"],
    onlyMainContent: false,
    maxAge: 0, // avoid cached partial renders while testing
    timeout: 45000,

    // Firecrawl wait rule: each wait action must have ONLY selector OR milliseconds.
    actions: [
      // let scripts boot
      { type: "wait", milliseconds: 2000 },

      // initial tiles present
      { type: "wait", selector: "li.snize-product" },

      // click show more once
      { type: "click", selector: ".snize-show-more" },
      { type: "wait", milliseconds: 2500 },
      { type: "wait", selector: "li.snize-product:nth-of-type(30)" },

      // click show more again (harmless if already loaded all)
      { type: "click", selector: ".snize-show-more" },
      { type: "wait", milliseconds: 2500 },
      { type: "wait", selector: "li.snize-product:nth-of-type(40)" },
    ],
  };

  console.log("Firecrawl actions:", body.actions);

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

  tiles.each((_, el) => {
    const $tile = $(el);

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
    if (typeof salePrice !== "number" || typeof originalPrice !== "number") return;

    deals.push({
      schemaVersion: 1,

      listingName,

      brand: brand || "",
      model: model || "",

      salePrice,
      originalPrice,
      discountPercent: typeof discountPercent === "number" ? discountPercent : null,

      // No ranges expected here
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

export default async function handler(req, res) {
  const t0 = Date.now();

  try {
    // CRON auth (commented for testing)
    // const auth = req.headers.authorization;
    // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    //   return res.status(401).json({ success: false, error: "Unauthorized" });
    // }

    const { html } = await firecrawlGetRenderedHtml(SOURCE_URL);
    const { deals, dealsFound, dealsExtracted } = parseDealsFromHtml(html);

    console.log("RUNUNITED tiles:", dealsFound, "extracted:", dealsExtracted);

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
