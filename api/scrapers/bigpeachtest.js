// /api/scrapers/big-peach-running-co-firecrawl.js  (CommonJS)
//
// Big Peach Running Co (RunFree storefront) — Deals! Footwear page
// ✅ Plain Cheerio scraper (no Firecrawl) — RunFree platform same as Track Shack
// Writes ONE blob: .../big-peach-running-co.json
//
// Page:
//  - https://shop.bigpeachrunningco.com/category/17804/deals-footwear
//
// Required env vars:
// - BLOB_READ_WRITE_TOKEN
//
// Optional env vars:
// - BIGPEACH_MAX_PAGES    default 20
// - CRON_SECRET

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

module.exports.config = { maxDuration: 90 };

const STORE = "Big Peach Running Co";
const SCHEMA_VERSION = 1;
const BASE = "https://shop.bigpeachrunningco.com";
const START_URL = `${BASE}/category/17804/deals-footwear`;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function toAbsUrl(maybeRelative) {
  if (!maybeRelative) return null;
  const s = String(maybeRelative).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return "https:" + s;
  return BASE + (s.startsWith("/") ? s : "/" + s);
}

function parseMoney(s) {
  if (!s) return null;
  const m = String(s).replace(/,/g, "").match(/\$?\s*([0-9]+(\.[0-9]{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&");
}

function parseBgImageUrl(styleAttr) {
  if (!styleAttr) return null;
  const s = decodeHtmlEntities(styleAttr);
  const m = s.match(/url\(\s*([^)]+?)\s*\)/i);
  if (!m) return null;
  let inner = m[1].trim();
  if (
    (inner.startsWith('"') && inner.endsWith('"')) ||
    (inner.startsWith("'") && inner.endsWith("'"))
  ) {
    inner = inner.slice(1, -1).trim();
  }
  return inner || null;
}

function pickImageUrl($el) {
  const style = $el.find(".image").attr("style");
  const fromStyle = parseBgImageUrl(style);
  if (fromStyle) return fromStyle;

  const fromPreview = $el.find(".colorswatches [data-preview-url]").first().attr("data-preview-url");
  if (fromPreview) return cleanText(fromPreview);

  const swStyle = $el.find(".colorswatches .colorswatch").first().attr("style");
  const fromSwStyle = parseBgImageUrl(swStyle);
  if (fromSwStyle) return fromSwStyle;

  return null;
}

function inferGender(name) {
  const t = (name || "").toLowerCase();
  const hasWomen = /\bwomen'?s?\b|\bwoman\b/.test(t);
  const hasMen = /\bmen'?s?\b|\bman\b/.test(t);
  const hasUnisex = /\bunisex\b/.test(t);
  if (hasUnisex) return "unisex";
  if (hasWomen && !hasMen) return "womens";
  if (hasMen && !hasWomen) return "mens";
  if (hasMen && hasWomen) return "unisex";
  return "unknown";
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return null;
  const pct = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  if (pct > 95) return 95;
  return pct;
}

function deriveModel(listingName, brand) {
  const ln = cleanText(listingName);
  const b = cleanText(brand);
  if (!ln) return "";
  if (!b) return ln;
  const re = new RegExp("^" + b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+", "i");
  return cleanText(ln.replace(re, "")) || ln;
}

function findNextUrl($, currentUrl) {
  let href =
    $('link[rel="next"]').attr("href") ||
    $('a[rel="next"]').attr("href") ||
    $(".pagination a.next").attr("href") ||
    $(".pagination__next a").attr("href") ||
    $('a[aria-label*="Next"]').attr("href");

  if (href) return toAbsUrl(href);

  const nextA = $("a")
    .filter((_, a) => /next/i.test(cleanText($(a).text())) && $(a).attr("href"))
    .first();

  href = nextA.attr("href");
  return href ? toAbsUrl(href) : null;
}

function buildPageUrl(pageNum) {
  return `${START_URL}?page=${pageNum}`;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

function parseProductsFromHtml(html) {
  const $ = cheerio.load(html);

  const dropCounts = {
    missingListingURL: 0,
    missingImageURL: 0,
    missingNameBrand: 0,
    missingBothPrices: 0,
    notMarkdown: 0,
  };

  const dropSamples = [];
  function sample(reason, obj) {
    if (dropSamples.length < 6) dropSamples.push({ reason, ...obj });
  }

  const tiles = $(".product.clickable");
  const tilesFound = tiles.length;
  const deals = [];

  tiles.each((_, el) => {
    const $el = $(el);

    const rel =
      $el.attr("data-url") ||
      $el.find("a[href^='/product/']").attr("href") ||
      $el.find("a[href]").first().attr("href") ||
      null;

    const listingURL = toAbsUrl(rel);
    if (!listingURL) {
      dropCounts.missingListingURL++;
      sample("missingListingURL", { rel });
      return;
    }

    const name = cleanText($el.find(".name").first().text());
    const brand = cleanText($el.find(".brand").first().text());
    if (!name || !brand) {
      dropCounts.missingNameBrand++;
      sample("missingNameBrand", { listingURL, name, brand });
      return;
    }

    const imageURL = pickImageUrl($el);
    if (!imageURL) {
      dropCounts.missingImageURL++;
      sample("missingImageURL", { listingURL });
      return;
    }

    const $price = $el.find(".price").first();
    const struckText = cleanText($price.find(".struck").first().text());
    const originalPrice = parseMoney(struckText);

    let salePrice = null;
    $price.contents().each((_, node) => {
      if (node.type === "text") {
        const val = parseMoney(node.data);
        if (Number.isFinite(val) && val > 0) {
          salePrice = val;
        }
      }
    });

    if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) {
      dropCounts.missingBothPrices++;
      sample("missingBothPrices", { listingURL, priceText: cleanText($price.text()) });
      return;
    }

    if (salePrice >= originalPrice) {
      dropCounts.notMarkdown++;
      return;
    }

    const listingName = cleanText(`${brand} ${name}`);

    deals.push({
      schemaVersion: SCHEMA_VERSION,
      listingName,
      brand,
      model: deriveModel(listingName, brand),
      salePrice,
      originalPrice,
      discountPercent: computeDiscountPercent(originalPrice, salePrice),
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,
      store: STORE,
      listingURL,
      imageURL,
      gender: inferGender(name),
      shoeType: "unknown",
    });
  });

  const nextUrl = findNextUrl($);
  return { deals, tilesFound, dropCounts, dropSamples, nextUrl };
}

function dedupeByListingUrl(deals) {
  const seen = new Set();
  const out = [];
  for (const d of deals) {
    if (!d.listingURL || seen.has(d.listingURL)) continue;
    seen.add(d.listingURL);
    out.push(d);
  }
  return out;
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();

/*  // CRON SECRET
  const CRON_SECRET = String(process.env.CRON_SECRET || "").trim();
  if (CRON_SECRET) {
    const auth = String(req.headers.authorization || "").trim();
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
*/
  try {
    const maxPages = Math.max(1, parseInt(process.env.BIGPEACH_MAX_PAGES || "20", 10));

    const sourceUrls = [];
    let pagesFetched = 0;
    let totalTilesFound = 0;

    const allDeals = [];
    const seenFirstUrls = new Set();
    const combinedDropCounts = {
      missingListingURL: 0,
      missingImageURL: 0,
      missingNameBrand: 0,
      missingBothPrices: 0,
      notMarkdown: 0,
    };
    const combinedDropSamples = [];

    let nextUrl = null;

    for (let page = 1; page <= maxPages; page++) {
      const url = page === 1 ? START_URL : (nextUrl || buildPageUrl(page));

      sourceUrls.push(url);

      const cacheBusted = `${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}`;
      const html = await fetchHtml(cacheBusted);
      const parsed = parseProductsFromHtml(html);

      pagesFetched++;
      totalTilesFound += parsed.tilesFound;

      // merge drop counts
      for (const k of Object.keys(combinedDropCounts)) {
        combinedDropCounts[k] += parsed.dropCounts[k] || 0;
      }
      if (combinedDropSamples.length < 6) {
        combinedDropSamples.push(...parsed.dropSamples.slice(0, 6 - combinedDropSamples.length));
      }

      const pageDeals = parsed.deals || [];
      if (!pageDeals.length) break;

      // Early exit if page repeats
      const firstUrl = (pageDeals[0]?.listingURL || "").trim();
      if (firstUrl) {
        if (seenFirstUrls.has(firstUrl)) break;
        seenFirstUrls.add(firstUrl);
      }

      allDeals.push(...pageDeals);

      const candidateNext = parsed.nextUrl ? String(parsed.nextUrl).trim() : null;
      nextUrl = (candidateNext && candidateNext !== url) ? candidateNext : null;
    }

    const deals = dedupeByListingUrl(allDeals);

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: "cheerio",
      sourceUrls,
      pagesFetched,
      dealsFound: totalTilesFound,
      dealsExtracted: deals.length,
      scrapeDurationMs: Date.now() - t0,
      ok: true,
      error: null,
      deals,
    };

    const blob = await put("big-peach-running-co.json", JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    const { deals: _omitted, ...payloadWithoutDeals } = payload;
    return res.status(200).json({
      ...payloadWithoutDeals,
      blobUrl: blob.url,
      debug: {
        pagesFetched,
        tilesSeen: totalTilesFound,
        dealsKept: deals.length,
        dropCounts: combinedDropCounts,
        dropSamples: combinedDropSamples,
      },
    });
  } catch (e) {
    return res.status(500).json({
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: "cheerio",
      ok: false,
      error: e?.message || "unknown error",
      scrapeDurationMs: Date.now() - t0,
    });
  }
};
