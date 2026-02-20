// /api/scrapers/hoka-firecrawl.js
// Scrape HOKA sale page via Firecrawl, parse HTML with cheerio,
// output Shoe Beagle canonical schema + top-level metadata, then write to Vercel Blob.

import * as cheerio from "cheerio";

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function safeNum(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const s = String(x).replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function computeExactDiscount(sale, orig) {
  if (sale === null || orig === null) return null;
  if (!(sale > 0) || !(orig > 0)) return null;
  const pct = Math.round(((orig - sale) / orig) * 100);
  return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
}

function computeUpToDiscount(saleLow, origHigh) {
  if (saleLow === null || origHigh === null) return null;
  if (!(saleLow > 0) || !(origHigh > 0)) return null;
  const pct = Math.round(((origHigh - saleLow) / origHigh) * 100);
  return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
}

function inferGenderFromUrl(u) {
  const s = String(u || "").toLowerCase();
  if (s.includes("/women") || s.includes("womens") || s.includes("women-")) return "womens";
  if (s.includes("/men") || s.includes("mens") || s.includes("men-")) return "mens";
  if (s.includes("unisex")) return "unisex";
  return "unknown";
}

/**
 * Your rule:
 * shoeType should be unknown unless listing text explicitly says road/trail/track.
 */
function inferShoeTypeFromListingText(text) {
  const s = normalizeWhitespace(text).toLowerCase();

  if (s.includes("trail shoe") || s.includes("trail running shoe") || s.includes("trail-running shoe")) return "trail";
  if (s.includes("road shoe") || s.includes("road running shoe") || s.includes("road-running shoe")) return "road";
  if (s.includes("track shoe") || s.includes("track spike") || s.includes("track spikes")) return "track";

  return "unknown";
}

async function firecrawlScrape({ url }) {
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY env var.");

  const resp = await fetch("https://api.firecrawl.dev/v0/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      pageOptions: {
        // We want HTML for deterministic parsing:
        includeRawHtml: true,
        // OnlyMainContent often hides product-grid content; keep it false for ecommerce:
        onlyMainContent: false,
        // If HOKA is slow/JS heavy, bump waitFor a bit:
        waitFor: 2500,
      },
      // You can also add timeout if needed (ms):
      timeout: 60000,
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Firecrawl scrape failed: ${resp.status} ${resp.statusText}${t ? ` – ${t}` : ""}`);
  }

  const json = await resp.json();
  if (!json?.success) {
    throw new Error(`Firecrawl scrape returned success=false: ${JSON.stringify(json)?.slice(0, 400)}`);
  }

  const data = json.data || {};
  // docs say raw HTML is returned in a key when includeRawHtml=true :contentReference[oaicite:1]{index=1}
  const rawHtml = data.rawHtml || data.html || "";
  const sourceURL = data?.metadata?.sourceURL || url;

  return { rawHtml, sourceURL, firecrawlData: data };
}

async function writeJsonToVercelBlob(blobUrl, data) {
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
  if (!token) throw new Error("Missing BLOB_READ_WRITE_TOKEN env var.");

  if (!/^https?:\/\//i.test(blobUrl)) {
    throw new Error(`Invalid blobUrl (must be full https URL). Got: "${blobUrl}"`);
  }

  const res = await fetch(blobUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(data, null, 2),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Blob write failed: ${res.status} ${res.statusText}${t ? ` – ${t}` : ""}`);
  }
}

function parseDealsFromHokaHtml({ html, pageUrl, store, brandDefault }) {
  const $ = cheerio.load(html);
  const dealsByUrl = new Map();

  // Broad candidate selectors (HOKA changes frequently; keep this resilient)
  const candidates = [
    "a[href*='/products/']",
    "a[href*='/product/']",
    "[data-testid*=product] a[href]",
    "[class*=product] a[href]",
    "article a[href]",
  ].join(",");

  $(candidates).each((_, el) => {
    const $a = $(el);
    let href = normalizeWhitespace($a.attr("href") || "");
    if (!href) return;

    const listingURL = href.startsWith("http") ? href : new URL(href, pageUrl).toString();

    // Dedupe early
    if (dealsByUrl.has(listingURL)) return;

    // Try to find a “card” container
    const $card = $a.closest("[data-testid*=product], article, li, div").first();

    const name =
      normalizeWhitespace($card.find("[data-testid*=title], [class*=title], [class*=name]").first().text()) ||
      normalizeWhitespace($a.attr("title") || "") ||
      normalizeWhitespace($a.text());

    if (!name || name.length < 3) return;

    // Image
    let img =
      normalizeWhitespace($card.find("img").first().attr("src") || "") ||
      normalizeWhitespace($card.find("img").first().attr("data-src") || "") ||
      normalizeWhitespace($card.find("img").first().attr("data-lazy") || "");
    const imageURL = img ? (img.startsWith("http") ? img : new URL(img, pageUrl).toString()) : null;

    // Prices: grab all $ amounts in card text and pick min/max
    const textBlob = normalizeWhitespace($card.text());
    const priceMatches = textBlob.match(/\$[0-9]+(?:\.[0-9]{2})?/g) || [];
    const nums = priceMatches
      .map((p) => safeNum(p))
      .filter((n) => n !== null);

    // Heuristic: sale=min, original=max if there are 2+
    const salePrice = nums.length ? Math.min(...nums) : null;
    const originalPrice = nums.length >= 2 ? Math.max(...nums) : null;

    // If no real pricing, skip (matches your “only include with sale+original” philosophy,
    // but we won’t be overly strict here — merge-deals can enforce too).
    // If you want strict here, uncomment:
    // if (salePrice === null || originalPrice === null) return;

    const gender = inferGenderFromUrl(listingURL);

    // shoeType rule: only from listing text
    const shoeType = inferShoeTypeFromListingText(textBlob);

    const discountPercent = computeExactDiscount(salePrice, originalPrice);

    // (We’re not doing ranges from HTML heuristic — keep nulls)
    const deal = {
      schemaVersion: 1,

      listingName: name,

      brand: brandDefault,
      model: name,

      salePrice,
      originalPrice,
      discountPercent,

      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,

      store,

      listingURL,
      imageURL,

      gender,
      shoeType,
    };

    dealsByUrl.set(listingURL, deal);
  });

  return Array.from(dealsByUrl.values());
}

export default async function handler(req, res) {
  try {
    const store = "HOKA";
    const brandDefault = "HOKA";
    const startUrl = "https://www.hoka.com/en/us/sale/";

    const blobUrl = normalizeWhitespace(process.env.HOKA_DEALS_BLOB_URL || "");
    const hasBlob = /^https?:\/\//i.test(blobUrl);

    // Quick env visibility (safe)
    const envDiag = {
      FIRECRAWL_API_KEY_present: Boolean((process.env.FIRECRAWL_API_KEY || "").trim()),
      HOKA_DEALS_BLOB_URL_present: Boolean((process.env.HOKA_DEALS_BLOB_URL || "").trim()),
      BLOB_READ_WRITE_TOKEN_present: Boolean((process.env.BLOB_READ_WRITE_TOKEN || "").trim()),
    };

    if (!envDiag.FIRECRAWL_API_KEY_present) {
      return res.status(500).json({ success: false, error: "Missing FIRECRAWL_API_KEY", envDiag });
    }

    const t0 = Date.now();

    // 1) Scrape via Firecrawl
    const { rawHtml, sourceURL } = await firecrawlScrape({ url: startUrl });

    if (!rawHtml || rawHtml.length < 2000) {
      // If this happens, HOKA may have served a bot page or minimal shell
      return res.status(502).json({
        success: false,
        error: "Firecrawl returned empty/too-small HTML (possible bot page or JS shell).",
        envDiag,
        sourceURL,
      });
    }

    // 2) Parse HTML
    const deals = parseDealsFromHokaHtml({
      html: rawHtml,
      pageUrl: sourceURL || startUrl,
      store,
      brandDefault,
    });

    const output = {
      store,
      schemaVersion: 1,

      lastUpdated: nowIso(),
      via: "vercel-firecrawl",

      sourceUrls: [startUrl],

      pagesFetched: 1,

      dealsFound: deals.length,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - t0,

      ok: true,
      error: null,

      deals,
    };

    // 3) Write blob (optional but expected)
    if (hasBlob) {
      await writeJsonToVercelBlob(blobUrl, output);
    } else {
      output.ok = false;
      output.error = "Missing/invalid HOKA_DEALS_BLOB_URL (must be full https URL).";
    }

    return res.status(200).json({
      success: true,
      wroteBlob: hasBlob,
      blobUrlHost: hasBlob ? new URL(blobUrl).host : null,
      envDiag,
      deals: deals.length,
      output,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e?.message ? String(e.message) : String(e),
    });
  }
}
