// /api/scrapers/dsw-firecrawl.js
//
// DSW clearance running shoes scraper
//
// ✅ Uses Firecrawl raw HTML
// ✅ Scrapes all pages from exactly 1 category path:
//    https://www.dsw.com/category/clearance/shoes/athletic-sneakers/running?gender=Men,Women
// ✅ Uses DSW page params like &No=2, &No=3, &No=4
// ✅ Price rule:
//    - Targets .product-tile__price only (ignores .product-tile__messaging)
//    - Strips .aria-hidden-content spans before parsing to avoid duplicate prices
//    - salePrice = first money value found; originalPrice always null
//    - DSW clearance tiles only show the clearance price, not original — originalPrice is intentionally null
// ✅ Sets shoeType = "unknown" for all deals
// ✅ Skips hidden-price phrases like:
//    "see price in cart", "see price in bag", "add to bag to see price", etc.
// ✅ Writes FULL top-level JSON + deals[] to Vercel Blob key: dsw-clearance.json
// ✅ Returns LIGHTWEIGHT response (no deals array) + blobUrl
// ✅ imageURL constructed from listingURL (styleId + activeColor) — not scraped from DOM
// ✅ No scroll actions needed; fast Firecrawl settings
// ✅ Pagination stops when a page has fewer than 60 tiles
// ✅ Content-Disposition: inline so response renders in browser instead of downloading
//
// ENV required:
// - FIRECRAWL_API_KEY
// - BLOB_READ_WRITE_TOKEN
//
// Optional:
// - CRON_SECRET

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = { maxDuration: 120 };

const STORE = "DSW";
const SCHEMA_VERSION = 1;
const VIA = "firecrawl-raw-html";
const BLOB_PATH = "dsw-clearance.json";

const SOURCE_URL =
  "https://www.dsw.com/category/clearance/shoes/athletic-sneakers/running?gender=Men,Women";

const PAGE_SIZE = 60;
const MAX_PAGES = 20;

const HIDDEN_PRICE_PATTERNS = [
  /see\s+price\s+in\s+cart/i,
  /see\s+price\s+in\s+bag/i,
  /price\s+in\s+cart/i,
  /price\s+in\s+bag/i,
  /add\s+to\s+bag\s+to\s+see\s+price/i,
  /add\s+to\s+cart\s+to\s+see\s+price/i,
  /add\s+for\s+price/i,
  /see\s+final\s+price/i,
];

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toAbsoluteUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://www.dsw.com${url}`;
  return `https://www.dsw.com/${url.replace(/^\/+/, "")}`;
}

function parseAllMoney(text) {
  if (!text) return [];
  const matches = [...String(text).replace(/,/g, "").matchAll(/\$?\s*(\d+(?:\.\d{1,2})?)/g)];
  return matches.map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
}

function hasHiddenPriceText(text) {
  const s = cleanText(text);
  return HIDDEN_PRICE_PATTERNS.some((re) => re.test(s));
}

function inferGender(listingName) {
  const s = cleanText(listingName).toLowerCase();
  if (/\bmen'?s\b/.test(s) || /\bmens\b/.test(s)) return "mens";
  if (/\bwomen'?s\b/.test(s) || /\bwomens\b/.test(s)) return "womens";
  if (/\bunisex\b/.test(s)) return "unisex";
  return "unknown";
}

// IMPORTANT: Never edit listingName; only derive brand/model.
function deriveBrandModel(listingName) {
  let s = cleanText(listingName);

  s = s.replace(/\s*-\s*(Women's|Men's|Unisex|Womens|Mens)\s*$/i, "");
  s = s.replace(/\s+Running\s+Shoe\s*$/i, "");
  s = s.replace(/\s+Running\s+Shoes\s*$/i, "");
  s = cleanText(s);

  if (!s) return { brand: "unknown", model: "unknown" };

  const multiWordBrands = [
    "Under Armour",
    "New Balance",
    "On",
    "Brooks",
    "ASICS",
    "Saucony",
    "HOKA",
    "Nike",
    "adidas",
    "PUMA",
    "Mizuno",
    "Altra",
    "Topo",
    "Merrell",
    "Salomon",
    "Reebok",
    "Skechers",
  ];

  for (const b of multiWordBrands) {
    const bl = b.toLowerCase();
    const sl = s.toLowerCase();
    if (sl === bl) return { brand: b, model: "unknown" };
    if (sl.startsWith(bl + " ")) {
      return { brand: b, model: cleanText(s.slice(b.length)) || "unknown" };
    }
  }

  const parts = s.split(" ");
  const brand = parts[0] ? cleanText(parts[0]) : "unknown";
  const model = parts.length > 1 ? cleanText(parts.slice(1).join(" ")) : "unknown";
  return { brand, model };
}

// Builds the product image URL directly from the listing URL.
// DSW Angular app renders placeholder /404/ URLs in the DOM until JS hydrates —
// so we construct the real CDN URL from styleId + activeColor in the listing URL.
// Pattern: https://assets.designerbrands.com/match/Site_Name/{styleId}_{activeColor}_ss_01/
function buildImageUrlFromListingUrl(listingURL) {
  try {
    const url = new URL(listingURL);
    const parts = url.pathname.split("/").filter(Boolean);
    const styleId = parts[parts.length - 1]; // e.g. "587247"
    const activeColor = url.searchParams.get("activeColor"); // e.g. "020"
    if (!styleId || !activeColor) return null;
    return `https://assets.designerbrands.com/match/Site_Name/${styleId}_${activeColor}_ss_01/?quality=70&io=transform:fit,width:1600`;
  } catch {
    return null;
  }
}

function makePageUrl(baseUrl, pageNum) {
  if (pageNum <= 1) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.set("No", String(pageNum));
  return url.toString();
}

function makeDropTracker() {
  const counts = {
    totalTiles: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingSalePrice: 0,
    dropped_hidden_price_text: 0,
    dropped_duplicateAfterMerge: 0,
    kept: 0,
  };

  const bump = (key) => {
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
  };

  function toSummaryArray() {
    const rows = [
      { reason: "dropped_missingListingName", count: counts.dropped_missingListingName, note: "Missing product name on tile" },
      { reason: "dropped_missingListingURL", count: counts.dropped_missingListingURL, note: "Missing product URL on tile" },
      { reason: "dropped_missingImageURL", count: counts.dropped_missingImageURL, note: "Could not construct image URL from listing URL" },
      { reason: "dropped_missingSalePrice", count: counts.dropped_missingSalePrice, note: "No visible parseable sale price found" },
      { reason: "dropped_hidden_price_text", count: counts.dropped_hidden_price_text, note: "Tile contained hidden-price messaging like see price in cart/bag" },
      { reason: "dropped_duplicateAfterMerge", count: counts.dropped_duplicateAfterMerge, note: "Duplicate listingURL already seen" },
      { reason: "kept", count: counts.kept, note: "Included in deals[]" },
    ];
    return rows.filter((r) => r.count > 0 || r.reason === "kept");
  }

  return { counts, bump, toSummaryArray };
}

function initGenderCounts() {
  return {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };
}

async function fetchFirecrawlHtml(url) {
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY");

  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["html"],
      onlyMainContent: false,
      waitFor: 750,
      timeout: 15000,
      mobile: false,
    }),
  });

  const json = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg = json?.error || json?.message || `Firecrawl HTTP ${resp.status}`;
    throw new Error(`${msg} for ${url}`);
  }

  const html = json?.data?.html || json?.html || "";
  if (!html || typeof html !== "string") {
    throw new Error(`Firecrawl returned no HTML for ${url}`);
  }

  return html;
}

function parseTile($, el) {
  const $tile = $(el);
  const tileText = cleanText($tile.text());

  // Check the full tile text for hidden-price messaging first
  if (hasHiddenPriceText(tileText)) {
    return { ok: false, reason: "dropped_hidden_price_text" };
  }

  const listingName = cleanText(
    $tile.find('[data-testid="product-tile__name"]').first().text()
  );

  if (!listingName) {
    return { ok: false, reason: "dropped_missingListingName" };
  }

  const rawHref =
    $tile.find("a.product-tile__pdp-link").first().attr("href") ||
    $tile.find('a[href*="/product/"]').first().attr("href") ||
    "";

  const listingURL = toAbsoluteUrl(rawHref);
  if (!listingURL) {
    return { ok: false, reason: "dropped_missingListingURL" };
  }

  const imageURL = buildImageUrlFromListingUrl(listingURL);
  if (!imageURL) {
    return { ok: false, reason: "dropped_missingImageURL" };
  }

  // Target .product-tile__price specifically to avoid picking up
  // promotional messaging like "Free Tote with $59 purchase" from
  // .product-tile__messaging which is a sibling element.
  // Also strip .aria-hidden-content spans which repeat the price as
  // "Minimum Clearance Price $XX.XX" causing duplicate money values.
  const $priceEl = $tile.find(".product-tile__price").first().clone();
  $priceEl.find(".aria-hidden-content").remove();
  const priceText = cleanText($priceEl.text());

  if (hasHiddenPriceText(priceText)) {
    return { ok: false, reason: "dropped_hidden_price_text" };
  }

  const moneyValues = parseAllMoney(priceText);
  if (!moneyValues.length) {
    return { ok: false, reason: "dropped_missingSalePrice" };
  }

  // DSW clearance tiles only show the clearance price — original price
  // is not displayed on the tile (only revealed in cart). Always null.
  const salePrice = moneyValues[0];
  const originalPrice = null;

  const gender = inferGender(listingName);
  const derived = deriveBrandModel(listingName);

  return {
    ok: true,
    deal: {
      schemaVersion: 1,
      listingName,
      brand: derived.brand,
      model: derived.model,
      salePrice,
      originalPrice,
      discountPercent: null,
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,
      store: STORE,
      listingURL,
      imageURL,
      gender,
      shoeType: "unknown",
    },
  };
}

function dedupeDeals(deals, drop) {
  const seen = new Set();
  const out = [];

  for (const deal of deals) {
    const key = deal.listingURL;
    if (seen.has(key)) {
      drop.bump("dropped_duplicateAfterMerge");
      continue;
    }
    seen.add(key);
    out.push(deal);
  }

  return out;
}

async function writeBlobJson(key, obj) {
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
  if (!token) throw new Error("Missing BLOB_READ_WRITE_TOKEN");

  const result = await put(key, JSON.stringify(obj, null, 2), {
    access: "public",
    token,
    contentType: "application/json",
    addRandomSuffix: false,
  });

  return result?.url || null;
}

function sendJson(res, status, body) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", "inline");
  return res.status(status).json(body);
}

function toLightweightResponse(output) {
  return {
    store: output.store,
    schemaVersion: output.schemaVersion,
    lastUpdated: output.lastUpdated,
    via: output.via,
    sourceUrls: output.sourceUrls,
    pagesFetched: output.pagesFetched,
    dealsFound: output.dealsFound,
    dealsExtracted: output.dealsExtracted,
    scrapeDurationMs: output.scrapeDurationMs,
    ok: output.ok,
    error: output.error,
    dropCounts: output.dropCounts || null,
    dropReasons: output.dropReasons || null,
    genderCounts: output.genderCounts || null,
    pageSummaries: output.pageSummaries || null,
    blobUrl: output.blobUrl || null,
  };
}

export default async function handler(req, res) {
  // CRON_SECRET
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const t0 = Date.now();
  const drop = makeDropTracker();
  const genderCounts = initGenderCounts();

  try {
    const rawDeals = [];
    const pageSummaries = [];
    const fetchedPageUrls = [];

    const firstHtml = await fetchFirecrawlHtml(SOURCE_URL);

    for (let page = 1; page <= MAX_PAGES; page++) {
      const pageUrl = makePageUrl(SOURCE_URL, page);

      let html;
      try {
        html = page === 1 ? firstHtml : await fetchFirecrawlHtml(pageUrl);
      } catch (err) {
        pageSummaries.push({
          sourceUrl: SOURCE_URL,
          page,
          pageUrl,
          shoeType: "unknown",
          ok: false,
          error: String(err?.message || err),
          totalTiles: 0,
          extractedDealsBeforeDedupe: 0,
          extractedDeals: 0,
          mensDeals: 0,
          womensDeals: 0,
          unisexDeals: 0,
          unknownDeals: 0,
          dropCounts: {
            missingListingName: 0,
            missingListingURL: 0,
            missingImageURL: 0,
            missingSalePrice: 0,
            hidden_price_text: 0,
          },
        });
        continue;
      }

      const $ = cheerio.load(html);
      const $tiles = $("app-product-tile");

      if ($tiles.length === 0) {
        break;
      }

      fetchedPageUrls.push(pageUrl);

      const pageDropCounts = {
        missingListingName: 0,
        missingListingURL: 0,
        missingImageURL: 0,
        missingSalePrice: 0,
        hidden_price_text: 0,
      };

      const pageGenderCounts = {
        mens: 0,
        womens: 0,
        unisex: 0,
        unknown: 0,
      };

      const pageDeals = [];

      $tiles.each((_, el) => {
        drop.bump("totalTiles");

        const result = parseTile($, el);

        if (!result.ok) {
          if (result.reason === "dropped_missingListingName") pageDropCounts.missingListingName += 1;
          if (result.reason === "dropped_missingListingURL") pageDropCounts.missingListingURL += 1;
          if (result.reason === "dropped_missingImageURL") pageDropCounts.missingImageURL += 1;
          if (result.reason === "dropped_missingSalePrice") pageDropCounts.missingSalePrice += 1;
          if (result.reason === "dropped_hidden_price_text") pageDropCounts.hidden_price_text += 1;

          drop.bump(result.reason);
          return;
        }

        const deal = result.deal;
        pageDeals.push(deal);
        rawDeals.push(deal);
        drop.bump("kept");

        if (Object.prototype.hasOwnProperty.call(pageGenderCounts, deal.gender)) {
          pageGenderCounts[deal.gender] += 1;
        }
        if (Object.prototype.hasOwnProperty.call(genderCounts, deal.gender)) {
          genderCounts[deal.gender] += 1;
        }
      });

      pageSummaries.push({
        sourceUrl: SOURCE_URL,
        page,
        pageUrl,
        shoeType: "unknown",
        ok: true,
        error: null,
        totalTiles: $tiles.length,
        extractedDealsBeforeDedupe: pageDeals.length,
        extractedDeals: pageDeals.length,
        mensDeals: pageGenderCounts.mens,
        womensDeals: pageGenderCounts.womens,
        unisexDeals: pageGenderCounts.unisex,
        unknownDeals: pageGenderCounts.unknown,
        dropCounts: pageDropCounts,
      });

      if ($tiles.length < PAGE_SIZE) {
        break;
      }
    }

    const deals = dedupeDeals(rawDeals, drop);
    const scrapeDurationMs = Date.now() - t0;

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,
      sourceUrls: [SOURCE_URL],
      pagesFetched: fetchedPageUrls.length,
      dealsFound: drop.counts.totalTiles,
      dealsExtracted: deals.length,
      scrapeDurationMs,
      ok: true,
      error: null,
      dropCounts: drop.counts,
      dropReasons: drop.toSummaryArray(),
      genderCounts,
      pageSummaries,
      deals,
      blobUrl: null,
    };

    output.blobUrl = await writeBlobJson(BLOB_PATH, output);
    return sendJson(res, 200, toLightweightResponse(output));
  } catch (err) {
    const scrapeDurationMs = Date.now() - t0;

    const output = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,
      sourceUrls: [SOURCE_URL],
      pagesFetched: 0,
      dealsFound: 0,
      dealsExtracted: 0,
      scrapeDurationMs,
      ok: false,
      error: String(err?.message || err),
      dropCounts: drop.counts,
      dropReasons: drop.toSummaryArray(),
      genderCounts,
      pageSummaries: [],
      deals: [],
      blobUrl: null,
    };

    try {
      output.blobUrl = await writeBlobJson(BLOB_PATH, output);
    } catch {}

    return sendJson(res, 500, toLightweightResponse(output));
  }
}
