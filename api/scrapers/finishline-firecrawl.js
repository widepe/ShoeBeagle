// /api/scrapers/finishline-firecrawl.js
//
// Finish Line (Firecrawl -> Cheerio parse) -> writes blob /finishline.json
//
// NOTE (per your instruction): This scraper fetches ONLY ONE PAGE per URL (page 1).
// It does NOT paginate and does not attempt ?page=2+.
//
// Rules (per your spec):
// - shoeType: "unknown" unless listingName includes trail / track / road (spikes => track)
// - gender: mens / womens / unisex else "unknown"
// - if on-sale text is not a $ price (e.g. "See price in bag"), skip and count skips
// - output your deal schema + your top-level structure
// - Cron Secret check included, but commented out for testing
//
// IMPORTANT FIXES IN THIS VERSION:
// - Uses proxy:"auto" to reduce Finish Line blocking
// - Removes Firecrawl actions (wait/scroll) to reduce engine failures
// - Uses formats:["html"] for maximum compatibility
// - Scrapes both men + women URLs (deduped), still NO pagination
// - Adds debug logs that won’t crash the function
// - Hard timeout around Firecrawl fetch so Vercel never returns "---"

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

const STORE = "Finish Line";
const SCHEMA_VERSION = 1;
const VIA = "firecrawl";

const BLOB_PATHNAME = "finishline.json"; // ✅ stable blob name

const BASE_URLS = [
  "https://www.finishline.com/plp/all-sale/gender=men+category=shoes+activity=running",
  "https://www.finishline.com/plp/all-sale/gender=women+category=shoes+activity=running",
];

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
  const h = String(href).trim();
  if (!h) return null;
  if (h.startsWith("http")) return h;
  return `https://www.finishline.com${h.startsWith("/") ? "" : "/"}${h}`;
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
  return "unknown";
}

function detectShoeType(listingName) {
  const s = String(listingName || "").toLowerCase();
  if (/\btrail\b/.test(s)) return "trail";
  if (/\btrack\b/.test(s)) return "track";
  if (/\bspikes?\b/.test(s)) return "track";
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

// Extract media.finishline.com image URL robustly, even if Firecrawl strips src
function extractImageUrlFromCard(card) {
  let imageURL = null;

  // 1) Try any img first (Firecrawl often keeps at least one)
  let img = card.find("img").first();

  if (img && img.length) {
    imageURL =
      img.attr("src") ||
      img.attr("data-src") ||
      img.attr("data-lazy-src") ||
      img.attr("data-original") ||
      null;

    if (!imageURL) {
      const rawSrcset =
        img.attr("srcset") ||
        img.attr("data-srcset") ||
        img.attr("data-lazy-srcset") ||
        null;

      if (rawSrcset) {
        imageURL = String(rawSrcset).split(",")[0].trim().split(/\s+/)[0] || null;
      }
    }
  }

  // 2) <picture><source>
  if (!imageURL) {
    const source = card.find("picture source").first();
    const sourceSrcset = source.attr("srcset") || source.attr("data-srcset") || null;
    if (sourceSrcset) {
      imageURL = String(sourceSrcset).split(",")[0].trim().split(/\s+/)[0] || null;
    }
  }

  // 3) Regex pull from HTML
  if (!imageURL) {
    const frag = card.html() || "";
    const m = frag.match(/https:\/\/media\.finishline\.com\/[^"'\s<>]+/i);
    if (m && m[0]) imageURL = m[0];
  }

  // 4) SKU fallback
  if (!imageURL) {
    const sku = card.attr("data-sku") || card.find("[data-sku]").first().attr("data-sku") || null;
    if (sku) {
      imageURL = `https://media.finishline.com/s/finishline/${sku}?$Main$?&w=660&h=660&fmt=auto`;
    }
  }

  // 5) Decode &amp; and normalize
  if (imageURL) {
    imageURL = String(imageURL).replace(/&amp;/g, "&").trim();
    // media.finishline.com is already absolute; normalizeUrl handles both cases
    imageURL = normalizeUrl(imageURL);
  }

  return imageURL || null;
}

async function firecrawlScrape(url) {
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY");

  // ✅ Hard timeout so Vercel never hangs / shows ---
  const controller = new AbortController();
  const timeoutMs = 90_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        url,

        // ✅ Most compatible (and what previously returned ok:true)
        formats: ["html"],

        // ✅ Let Firecrawl handle "main content" normally
        // onlyMainContent: true,

        // ✅ Give Finish Line time
        waitFor: 6000,

        // ✅ Best first lever against blocking
        proxy: "auto",

        // ✅ Firecrawl-side timeout
        timeout: 120000,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Firecrawl scrape failed (${res.status}): ${txt.slice(0, 800)}`);
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
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error(`Firecrawl fetch aborted after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- handler ----------
export default async function handler(req, res) {
  const t0 = Date.now();
  const runId = `finishline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  // ✅ Cron Secret (commented out for testing)
  /*
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers["authorization"] !== `Bearer ${secret}`) {
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

    const uniqueUrls = Array.from(
      new Set(BASE_URLS.map((s) => String(s || "").trim()).filter(Boolean))
    );

    for (const pageUrl of uniqueUrls) {
      sourceUrls.push(pageUrl);

      console.log(`[${runId}] FINISHLINE start url=${pageUrl}`);

      const html = await firecrawlScrape(pageUrl);
      pagesFetched += 1;

      console.log(`[${runId}] FINISHLINE got html chars=${html.length}`);

      const $ = cheerio.load(html);

      // ✅ Debug: do we see PDP links at all?
      const pdpLinksCount = $('a[href*="/pdp/"]').length;
      console.log(`[${runId}] FINISHLINE debug: pdpLinks=${pdpLinksCount}`);

      // ✅ Primary selector (your original)
      let cards = $('div[data-testid="product-item"]');

      // ✅ Fallback: if Firecrawl stripped testids, use PDP links and walk up
      if (!cards.length && pdpLinksCount) {
        // Try common card-like containers around PDP links
        cards = $('a[href*="/pdp/"]')
          .map((_, a) => $(a).closest("div").get(0))
          .get();
        // Dedup nodes by reference
        const seen = new Set();
        const uniqueNodes = [];
        for (const node of cards) {
          if (node && !seen.has(node)) {
            seen.add(node);
            uniqueNodes.push(node);
          }
        }
        // Wrap in cheerio collection
        cards = $(uniqueNodes);
      }

      console.log(`[${runId}] FINISHLINE debug: cards=${cards.length}`);

      dealsFound += cards.length;

      // If still nothing, dump tiny head snippet for selector tuning
      if (!cards.length) {
        const sample = $.html().slice(0, 2000);
        console.log(`[${runId}] FINISHLINE debug: htmlHead=${sample.replace(/\s+/g, " ")}`);
        continue;
      }

      cards.each((_, el) => {
        const card = $(el);

        // Listing URL
        const href = card.find('a[href*="/pdp/"]').first().attr("href");
        const listingURL = normalizeUrl(href);
        if (!listingURL) return;

        // Listing name (Finish Line sometimes uses h3/h4/p; try a few)
        const nameNode =
          card.find("h4").first().length
            ? card.find("h4").first()
            : card.find("h3").first().length
              ? card.find("h3").first()
              : card.find('[data-testid*="product-name"]').first().length
                ? card.find('[data-testid*="product-name"]').first()
                : card.find("a").first();

        const listingName = asText(nameNode);
        if (!listingName) return;

        // Price-in-bag detection
        const saleNode = card.find("h4.text-default-onSale, [class*='onSale'], [data-testid*='sale']").first();
        const saleTextRaw = asText(saleNode);

        if (saleNode.length && !/\$\s*\d/.test(saleTextRaw)) {
          // Example: "See price in bag"
          priceInBagSkipped += 1;
          return;
        }

        // Sale + original price (try multiple patterns)
        const saleText =
          saleTextRaw ||
          asText(card.find("[class*='onSale']").first()) ||
          asText(card.find("[data-testid*='sale']").first());

        const originalText =
          asText(card.find("p.line-through, [class*='line-through'], [data-testid*='original']").first());

        const salePrice = parseMoney(saleText);
        const originalPrice = parseMoney(originalText);

        // Keep your honesty rule: must have both
        if (typeof salePrice !== "number" || typeof originalPrice !== "number") return;

        const discountPercent = computeDiscountPercent(salePrice, originalPrice);
        const { brand, model } = parseBrandModel(listingName);

        const gender = detectGender(listingName);
        const shoeType = detectShoeType(listingName);

        const imageURL = extractImageUrlFromCard(card);

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

      priceInBagSkipped,

      deals: allDeals,
    };

    console.log(
      `[${runId}] FINISHLINE blob write start: ${BLOB_PATHNAME} dealsExtracted=${payload.dealsExtracted}`
    );

    const blobRes = await put(BLOB_PATHNAME, JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    console.log(`[${runId}] FINISHLINE blob write done: url=${blobRes.url} time=${Date.now() - t0}ms`);
    console.log(`[${runId}] FINISHLINE expected env url: ${process.env.FINISHLINE_DEALS_BLOB_URL || "not set"}`);

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
    console.log(`[${runId}] FINISHLINE error: ${msg}`);
    return res.status(500).json({ ok: false, runId, error: msg, elapsedMs: Date.now() - t0 });
  }
}
