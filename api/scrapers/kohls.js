// /api/run-kohls.js  (CommonJS)
// Hit this route manually to test: /api/run-kohls

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

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

const BLOB_PATHNAME = "kohls.json";
const MAX_ITEMS_TOTAL = 5000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

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

function detectGenderFromListingName(listingName) {
  const s = (listingName || "").toLowerCase();
  if (s.includes("men's") || s.includes("mens ")) return "mens";
  if (s.includes("women's") || s.includes("womens ")) return "womens";
  return "unknown";
}

// Your rule: unknown unless explicitly says trail/road/track in the listing text
function detectShoeTypeFromListingName(listingName) {
  const s = (listingName || "").toLowerCase();
  if (s.includes("trail")) return "trail";
  if (s.includes("road")) return "road";
  if (s.includes("track")) return "track";
  return "unknown";
}

function parseBrandModel(listingName) {
  const name = (listingName || "").trim();
  if (!name) return { brand: "unknown", model: "unknown" };

  const parts = name.split(/\s+/);
  const brand = parts[0] ? parts[0].trim() : "unknown";

  let rest = parts.slice(1).join(" ").trim();
  if (!rest) return { brand, model: "unknown" };

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

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function extractDealsFromHtml(html) {
  const $ = cheerio.load(html);
  const deals = [];

  $("div[data-webid]").each((_, el) => {
    const card = $(el);

    // listingName MUST come from the highlighted listing text
    const listingName = card.find('a[data-dte="product-title"]').first().text().trim();
    if (!listingName) return;

    const href = card.find('a[href^="/product/prd-"]').first().attr("href") || null;
    const listingURL = absUrl(href);

    const imageURL = card.find('img[data-dte="product-image"]').first().attr("src") || null;

    const salePriceText = card.find('span[data-dte="product-sub-sale-price"]').first().text().trim();
    const regPriceText = card.find('span[data-dte="product-sub-regular-price"]').first().text().trim();

    const salePrice = parseMoney(salePriceText);
    const originalPrice = parseMoney(regPriceText);
    const discountPercent = calcDiscountPercent(salePrice, originalPrice);

    const gender = detectGenderFromListingName(listingName);
    const shoeType = detectShoeTypeFromListingName(listingName);

    const { brand, model } = parseBrandModel(listingName);

    deals.push({
      listingName,
      brand: brand || "unknown",
      model: model || "unknown",
      salePrice: salePrice ?? null,
      originalPrice: originalPrice ?? null,
      discountPercent: discountPercent ?? null,
      store: "Kohls",
      listingURL: listingURL ?? null,
      imageURL: imageURL ?? null,
      gender,
      shoeType,
    });
  });

  return uniqByKey(deals, (d) => d.listingURL || `${d.listingName}||${d.imageURL || ""}`)
    .slice(0, MAX_ITEMS_TOTAL);
}

async function scrapeAll() {
  const startedAt = new Date().toISOString();
  const perSourceCounts = {};
  const allDeals = [];

  for (const src of SOURCES) {
    const html = await fetchHtml(src.url);
    const deals = extractDealsFromHtml(html);
    perSourceCounts[src.key] = deals.length;
    allDeals.push(...deals);
  }

  const deals = uniqByKey(allDeals, (d) => d.listingURL || `${d.listingName}||${d.imageURL || ""}`)
    .slice(0, MAX_ITEMS_TOTAL);

  return {
    meta: {
      store: "Kohls",
      scrapedAt: new Date().toISOString(),
      startedAt,
      sourcePages: SOURCES,
      countsBySource: perSourceCounts,
      totalDeals: deals.length,
      notes: [
        "Defaults: gender and shoeType are 'unknown' unless explicitly present in listingName.",
        "shoeType only set if listingName contains trail/road/track.",
        "listingName comes from a[data-dte='product-title'] (not img alt).",
      ],
    },
    deals,
  };
}

module.exports = async function handler(req, res) {
  try {
    const data = await scrapeAll();

    const blobRes = await put(BLOB_PATHNAME, JSON.stringify(data, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    res.status(200).json({
      ok: true,
      totalDeals: data.meta.totalDeals,
      countsBySource: data.meta.countsBySource,
      blobUrl: blobRes.url,
    });
  } catch (err) {
    // This makes the REAL error show up in Vercel logs and in the response
    console.error("Kohls scrape failed:", err);
    res.status(500).json({
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
};
