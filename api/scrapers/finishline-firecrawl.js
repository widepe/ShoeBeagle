// /api/scrapers/finishline-firecrawl.js
//
// Finish Line (Firecrawl -> Cheerio parse) -> writes blob /finishline.json
//
// Pagination pattern:
//   page 1: https://www.finishline.com/plp/<slug>
//   page 2: https://www.finishline.com/plp/<slug>?page=2
//   page 3: https://www.finishline.com/plp/<slug>?page=3
//
// Rules (per your spec):
// - shoeType: "unknown" unless listingName includes trail / track / road
// - gender must be womens / mens / unisex (otherwise exclude deal)
// - if card shows "price in bag" (or similar), skip and count skips
// - output your deal schema + your top-level structure
// - Cron Secret check included, but commented out for testing

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

const STORE = "Finish Line";
const SCHEMA_VERSION = 1;
const VIA = "firecrawl";

// Your running-sale URL (shoe deals)
const BASE_URL =
  "https://www.finishline.com/plp/all-sale/category=shoes+activity=running";

const MAX_PAGES = 6; // adjust as you like

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

function looksLikePriceInBag(cardText) {
  const t = String(cardText || "").toLowerCase();
  return (
    t.includes("price in bag") ||
    t.includes("see price in bag") ||
    t.includes("add to bag for price") ||
    t.includes("in bag for price") ||
    t.includes("see in bag")
  );
}

function buildPageUrl(baseUrl, pageNum) {
  const u = new URL(baseUrl);
  if (pageNum <= 1) {
    u.searchParams.delete("page");
  } else {
    u.searchParams.set("page", String(pageNum));
  }
  return u.toString();
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
  // use html (or rawHtml) per current API
  formats: ["html"],
  // supported in current scrape endpoint
  waitFor: 3000,
  // optional but often helpful on retail sites
  proxy: "auto",
  blockAds: true,
}),

  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Firecrawl scrape failed (${res.status}): ${txt.slice(0, 500)}`);
  }

  const data = await res.json();

  // Try a couple common shapes so it "just works" across Firecrawl versions.
  const html =
    data?.data?.html ||
    data?.data?.[0]?.html ||
    data?.html ||
    "";

  if (!html) {
    // Useful debug without dumping everything:
    const keys = Object.keys(data || {});
    throw new Error(`Firecrawl returned no html. Top-level keys: ${keys.join(", ")}`);
  }

  return html;
}

// ---------- handler ----------
export default async function handler(req, res) {
  const t0 = Date.now();

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

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const pageUrl = buildPageUrl(BASE_URL, pageNum);
      sourceUrls.push(pageUrl);

      const html = await firecrawlScrape(pageUrl);
      pagesFetched += 1;

      const $ = cheerio.load(html);

      // stable selectors from your outerHTML
      const cards = $('div[data-testid="product-item"]');

      // If a page has no products, assume we're past the end and stop.
      if (cards.length === 0) {
        break;
      }

      dealsFound += cards.length;

      cards.each((_, el) => {
        const card = $(el);

// Price-in-bag detection (selector-based, stable)
// If the on-sale node isn't a $ price, it's "See price in bag" (skip + count)
const saleNode = card.find("h4.text-default-onSale").first();
const saleTextRaw = asText(saleNode);

// if the element exists and doesn't contain a currency price, skip
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
        if (!gender) return; // exclude

        const shoeType = detectShoeType(listingName);

        const saleText = asText(card.find("h4.text-default-onSale").first());
        const originalText = asText(card.find("p.line-through").first());

        const salePrice = parseMoney(saleText);
        const originalPrice = parseMoney(originalText);

        // include ONLY if both exist
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
    }

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

      // optional but useful; remove if you want strict top-level only
      priceInBagSkipped,

      deals: allDeals,
    };

    await put("finishline.json", JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false, // ✅ stable name
    });

    console.log(`[Finish Line] priceInBagSkipped=${priceInBagSkipped}`);

    return res.status(200).json({
      ok: true,
      store: STORE,
      pagesFetched,
      dealsFound,
      dealsExtracted,
      priceInBagSkipped,
      blobPath: "/finishline.json",
    });
  } catch (err) {
    const msg = err?.message ? String(err.message) : String(err);

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls: [BASE_URL],
      pagesFetched,

      dealsFound,
      dealsExtracted,

      scrapeDurationMs: Date.now() - t0,

      ok: false,
      error: msg,
    };

    try {
      await put("finishline.json", JSON.stringify(payload, null, 2), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
      });
    } catch (e) {
      console.error("Failed writing error payload to blob:", e?.message || e);
    }

    return res.status(500).json({ ok: false, error: msg });
  }
}
