// /api/scrapers/finishline-firecrawl.js
//
// Finish Line (Firecrawl -> Cheerio parse) -> writes blob /finishline.json
//
// NOTE (per your instruction): This scraper fetches ONLY ONE PAGE (page 1).
// It does NOT paginate and does not attempt ?page=2+.
//
// Rules (per your spec):
// - shoeType: "unknown" unless listingName includes trail / track / road
// - gender must be womens / mens / unisex (otherwise exclude deal)
// - if on-sale text is not a $ price (e.g. "See price in bag"), skip and count skips
// - output your deal schema + your top-level structure
// - Cron Secret check included, but commented out for testing

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

const STORE = "Finish Line";
const SCHEMA_VERSION = 1;
const VIA = "firecrawl";

const BLOB_PATHNAME = "finishline.json"; // ✅ stable blob name -> .../finishline.json

// Your running-sale URL (shoe deals)
const BASE_URL =
  "https://www.finishline.com/plp/all-sale/category=shoes+activity=running";

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v1/scrape";

// ---------- helpers ----------
function nowIso() {
  return new Date().toISOString();
}

function asText($el) {
  return ($el?.text?.() || "").replace(/\s+/g, " ").trim();
}

function normalizeUrl(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  return `https://www.finishline.com${href.startsWith("/") ? "" : "/"}${href}`;
}

function parseMoney(str) {
  const m = String(str || "").match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function computeDiscountPercent(sale, original) {
  if (typeof sale !== "number" || typeof original !== "number" || original <= 0) return null;
  const pct = Math.round(((original - sale) / original) * 100);
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}

function detectGender(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (s.startsWith("men's") || s.startsWith("mens")) return "mens";
  if (s.startsWith("women's") || s.startsWith("womens")) return "womens";
  if (s.startsWith("unisex")) return "unisex";
  return null; // exclude
}

function detectShoeType(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (/\btrail\b/.test(s)) return "trail";
  if (/\btrack\b/.test(s)) return "track";
  if (/\broad\b/.test(s)) return "road";
  return "unknown";
}

function stripLeadingGender(listingName) {
  return String(listingName || "")
    .replace(/^Men’s\s+/i, "")
    .replace(/^Men's\s+/i, "")
    .replace(/^Mens\s+/i, "")
    .replace(/^Women’s\s+/i, "")
    .replace(/^Women's\s+/i, "")
    .replace(/^Womens\s+/i, "")
    .replace(/^Unisex\s+/i, "")
    .trim();
}

function parseBrandModel(listingName) {
  const s = stripLeadingGender(listingName);

  const multiWordBrands = [
    "New Balance",
    "Under Armour",
    "On Running",
    "HOKA ONE ONE",
    "Hoka One One",
  ];

  for (const b of multiWordBrands) {
    if (s.toLowerCase().startsWith(b.toLowerCase() + " ")) {
      const brand = b;
      const model = s.slice(b.length).trim();
      return { brand, model: model || s };
    }
  }

  const firstWord = s.split(/\s+/)[0] || "";
  const brand = firstWord || s || "unknown";
  const model = s.slice(brand.length).trim() || s || "unknown";
  return { brand, model };
}

async function firecrawlScrape(url) {
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY");

  const res = await fetch(FIRECRAWL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["html"],
      // render: true, // ❌ Firecrawl v2 rejects this key
      waitFor: 3000,
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Firecrawl scrape failed (${res.status}): ${txt.slice(0, 500)}`);
  }

  const data = await res.json();

  const html =
    data?.data?.html ||
    data?.data?.[0]?.html ||
    data?.html ||
    "";

  if (!html) {
    const keys = Object.keys(data || {});
    throw new Error(`Firecrawl returned no html. Top-level keys: ${keys.join(", ")}`);
  }

  return html;
}

// ---------- handler ----------
export default async function handler(req, res) {
  const t0 = Date.now();
  const runId = `finishline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  // ✅ Cron Secret (commented out for testing)
  /*
  const expected = String(process.env.CRON_SECRET || "").trim();
  const got = String(req.headers["x-cron-secret"] || "").trim();
  if (!expected || got !== expected) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  */

  let pagesFetched = 0;
  let dealsFound = 0;
  let dealsExtracted = 0;
  let priceInBagSkipped = 0;

  try {
    const allDeals = [];
    const sourceUrls = [];

    // ✅ Per your instruction: scrape ONE page only (page 1)
    const pageUrl = BASE_URL;
    sourceUrls.push(pageUrl);

    const html = await firecrawlScrape(pageUrl);
    pagesFetched = 1;

    const $ = cheerio.load(html);

    const cards = $('div[data-testid="product-item"]');
    dealsFound = cards.length;

    cards.each((_, el) => {
      const card = $(el);

      // Price-in-bag detection (selector-based, stable)
      const saleNode = card.find("h4.text-default-onSale").first();
      const saleTextRaw = asText(saleNode);

      if (saleNode.length && !/\$\s*\d/.test(saleTextRaw)) {
        priceInBagSkipped += 1;
        return;
      }

      const href = card.find('a[href*="/pdp/"]').first().attr("href");
      const listingURL = normalizeUrl(href);
      if (!listingURL) return;

      const img = card.find("img").first();
      const imageURL = img.attr("src") || null;

      const listingName = asText(card.find("h4").first());
      if (!listingName) return;

      const gender = detectGender(listingName);
      if (!gender) return;

      const shoeType = detectShoeType(listingName);

      const saleText = asText(card.find("h4.text-default-onSale").first());
      const originalText = asText(card.find("p.line-through").first());

      const salePrice = parseMoney(saleText);
      const originalPrice = parseMoney(originalText);

      if (typeof salePrice !== "number" || typeof originalPrice !== "number") return;

      const discountPercent = computeDiscountPercent(salePrice, originalPrice);
      const { brand, model } = parseBrandModel(listingName);

      allDeals.push({
        schemaVersion: SCHEMA_VERSION,

        listingName,

        brand,
        model,

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

        gender,
        shoeType,
      });
    });

    dealsExtracted = allDeals.length;

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,

      pagesFetched,

      dealsFound,
      dealsExtracted,

      scrapeDurationMs: Date.now() - t0,

      ok: true,
      error: null,

      priceInBagSkipped,

      deals: allDeals,
    };

    // ✅ Blob write (HOKA-style logging)
    console.log(
      `[${runId}] FINISHLINE blob write start: ${BLOB_PATHNAME} dealsExtracted=${payload.dealsExtracted}`
    );

    const blobRes = await put(BLOB_PATHNAME, JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    console.log(
      `[${runId}] FINISHLINE blob write done: url=${blobRes.url} time=${Date.now() - t0}ms`
    );
    console.log(
      `[${runId}] FINISHLINE expected env url: ${process.env.FINISHLINE_DEALS_BLOB_URL || "not set"}`
    );

    return res.status(200).json({
      ok: true,
      runId,
      store: STORE,
      pagesFetched,
      dealsFound,
      dealsExtracted,
      priceInBagSkipped,
      blobUrl: blobRes.url,
      elapsedMs: Date.now() - t0,
    });
  } catch (err) {
    const msg = err?.message ? String(err.message) : String(err);

    return res.status(500).json({ ok: false, runId, error: msg, elapsedMs: Date.now() - t0 });
  }
}
