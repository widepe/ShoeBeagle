/**
 * kohls-scrape.js
 *
 * Scrapes these two Kohl's catalog pages:
 *  1) Sale adult running shoes
 *  2) Clearance adult running shoes
 *
 * Outputs ONE JSON object:
 * {
 *   meta: {...},
 *   deals: [ { 11 canonical fields... }, ... ]
 * }
 *
 * Canonical 11 fields:
 *   listingName, brand, model, salePrice, originalPrice, discountPercent,
 *   store, listingURL, imageURL, gender, shoeType
 *
 * Rules (per you):
 * - Defaults are ALWAYS "unknown" (or null for numeric) unless explicitly present.
 * - shoeType remains "unknown" unless listingName explicitly contains "trail", "road", or "track".
 */

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

// -----------------------------
// CONFIG
// -----------------------------
const SOURCES = [
  {
    key: "sale",
    url: "https://www.kohls.com/catalog/sale-adult-running-shoes.jsp?CN=Promotions:Sale+AgeAppropriate:Adult+Activity:Running+Department:Shoes",
  },
  {
    key: "clearance",
    url: "https://www.kohls.com/catalog/clearance-adult-running-shoes.jsp?CN=Promotions:Clearance+AgeAppropriate:Adult+Activity:Running+Department:Shoes",
  },
];

// Where to write (Vercel Blob path). The public URL you gave corresponds to this pathname:
const BLOB_PATHNAME = "kohls.json";

// Hard stop for safety. (These Kohl’s catalog pages can be large.)
const MAX_ITEMS_TOTAL = 5000;

// Basic headers to reduce trivial blocking.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// -----------------------------
// HELPERS
// -----------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function absUrl(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  return `https://www.kohls.com${href}`;
}

function parseMoney(text) {
  if (!text) return null;
  const m = String(text).replace(/\s+/g, " ").match(/\$?\s*([\d,]+(\.\d{2})?)/);
  if (!m) return null;
  const num = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(num) ? num : null;
}

function calcDiscountPercent(salePrice, originalPrice) {
  if (salePrice == null || originalPrice == null) return null;
  if (!(originalPrice > 0)) return null;
  const pct = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  return Number.isFinite(pct) ? pct : null;
}

// Per your rule: unknown unless explicitly in listing name.
function detectGenderFromListingName(listingName) {
  const s = (listingName || "").toLowerCase();
  if (s.includes("men's") || s.includes("mens ")) return "mens";
  if (s.includes("women's") || s.includes("womens ")) return "womens";
  return "unknown";
}

// Per your rule: unknown unless explicitly says trail/road/track in listing.
function detectShoeTypeFromListingName(listingName) {
  const s = (listingName || "").toLowerCase();
  if (s.includes("trail")) return "trail";
  if (s.includes("road")) return "road";
  if (s.includes("track")) return "track";
  return "unknown";
}

// Conservative parsing: brand = first word token; model = remainder after brand,
// stripped of common suffixes. Defaults to "unknown" if can't confidently derive.
function parseBrandModel(listingName) {
  const name = (listingName || "").trim();
  if (!name) return { brand: "unknown", model: "unknown" };

  const parts = name.split(/\s+/);
  const brand = parts[0] ? parts[0].trim() : "unknown";

  let rest = parts.slice(1).join(" ").trim();
  if (!rest) return { brand, model: "unknown" };

  // Strip gender phrases and common ending phrases, but keep it conservative.
  rest = rest
    .replace(/\bmen'?s\b/gi, "")
    .replace(/\bwomen'?s\b/gi, "")
    .replace(/\bunisex\b/gi, "")
    .replace(/\brunning shoes?\b/gi, "")
    .replace(/\bshoes?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const model = rest ? rest : "unknown";
  return { brand, model };
}

function uniqByKey(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyFn(it);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

// -----------------------------
// CORE SCRAPE
// -----------------------------
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function extractDealsFromHtml(html, sourceLabel) {
  const $ = cheerio.load(html);

  const deals = [];

  // Loop anchor from your screenshot: div[data-webid]
  $("div[data-webid]").each((_, el) => {
    const card = $(el);

    // listingName: highlighted text node
    const listingName = card.find('a[data-dte="product-title"]').first().text().trim();

    // URL: /product/prd-...
    const href = card.find('a[href^="/product/prd-"]').first().attr("href") || null;
    const listingURL = absUrl(href);

    // Image
    const imageURL =
      card.find('img[data-dte="product-image"]').first().attr("src") || null;

    // Prices
    const salePriceText = card.find('span[data-dte="product-sub-sale-price"]').first().text().trim();
    const regPriceText = card.find('span[data-dte="product-sub-regular-price"]').first().text().trim();

    const salePrice = parseMoney(salePriceText);
    const originalPrice = parseMoney(regPriceText);
    const discountPercent = calcDiscountPercent(salePrice, originalPrice);

    // Defaults are unknown unless explicit
    const gender = detectGenderFromListingName(listingName);
    const shoeType = detectShoeTypeFromListingName(listingName);

    const { brand, model } = parseBrandModel(listingName);

    // If listingName is missing, skip (can’t create a safe deal row).
    if (!listingName) return;

    deals.push({
      listingName,                  // string
      brand: brand || "unknown",     // string
      model: model || "unknown",     // string
      salePrice: salePrice ?? null,  // number|null
      originalPrice: originalPrice ?? null, // number|null
      discountPercent: discountPercent ?? null, // number|null
      store: "Kohls",                // string
      listingURL: listingURL ?? null,// string|null
      imageURL: imageURL ?? null,    // string|null
      gender,                        // 'mens'|'womens'|'unknown' (your rule)
      shoeType,                      // 'road'|'trail'|'track'|'unknown' (your rule)
      // (Optional extra internal fields could go here, but keeping it strictly 11 fields)
    });
  });

  // Deduplicate by listingURL if present; otherwise by listingName+imageURL
  const deduped = uniqByKey(deals, (d) => d.listingURL || `${d.listingName}||${d.imageURL || ""}`);

  // Cap to protect you from accidental runaway.
  return deduped.slice(0, MAX_ITEMS_TOTAL).map((d) => ({
    ...d,
    // keep store as Kohls; sourceLabel only goes in metadata (not per-deal) to keep exactly 11 fields
  }));
}

async function scrapeAll() {
  const startedAt = new Date().toISOString();

  const perSourceCounts = {};
  const allDeals = [];

  for (const src of SOURCES) {
    const html = await fetchHtml(src.url);
    const deals = extractDealsFromHtml(html, src.key);

    perSourceCounts[src.key] = deals.length;
    allDeals.push(...deals);

    // tiny delay to be polite
    await sleep(600);
  }

  // Final dedupe across both pages
  const deals = uniqByKey(allDeals, (d) => d.listingURL || `${d.listingName}||${d.imageURL || ""}`)
    .slice(0, MAX_ITEMS_TOTAL);

  const meta = {
    store: "Kohls",
    scrapedAt: new Date().toISOString(),
    startedAt,
    sourcePages: SOURCES.map((s) => ({ key: s.key, url: s.url })),
    countsBySource: perSourceCounts,
    totalDeals: deals.length,
    notes: [
      "Defaults: gender and shoeType are 'unknown' unless explicitly present in listingName.",
      "shoeType is only set if listingName contains 'trail', 'road', or 'track' (case-insensitive).",
      "listingName is taken from a[data-dte='product-title'] (not img alt).",
    ],
  };

  return { meta, deals };
}

async function writeToBlob(obj) {
  // Requires: BLOB_READ_WRITE_TOKEN in env (Vercel Blob).
  // Example:
  //   export BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..."
  //
  // This writes/overwrites kohls.json at your blob store (public).
  const body = JSON.stringify(obj, null, 2);

  const res = await put(BLOB_PATHNAME, body, {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
  });

  return res;
}

// -----------------------------
// RUN
// -----------------------------
(async () => {
  try {
    const data = await scrapeAll();
    const blobRes = await writeToBlob(data);

    console.log("✅ Scrape complete.");
    console.log("Total deals:", data.meta.totalDeals);
    console.log("Counts by source:", data.meta.countsBySource);
    console.log("Blob URL:", blobRes.url);
  } catch (err) {
    console.error("❌ Kohl's scrape failed:", err);
    process.exitCode = 1;
  }
})();
