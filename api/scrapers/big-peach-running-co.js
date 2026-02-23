// /api/scrapers/big-peach-running-co.js  (CommonJS)
//
// Big Peach Running Co (RunFree storefront) — Deals! Footwear page
// Writes ONE blob: .../big-peach-running-co.json
//
// Page:
//  - https://shop.bigpeachrunningco.com/category/17804/deals-footwear
//
// Required env vars:
// - BLOB_READ_WRITE_TOKEN
// - FIRECRAWL_API_KEY
//
// Optional env vars:
// - BIGPEACH_PROXY         default "auto"
// - BIGPEACH_TIMEOUT_MS    default 60000

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "Big Peach Running Co";
const SCHEMA_VERSION = 1;
const DEALS_URL = "https://shop.bigpeachrunningco.com/category/17804/deals-footwear";
const BASE = "https://shop.bigpeachrunningco.com";

function nowIso() {
  return new Date().toISOString();
}

function requireEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function optStr(name, def) {
  const v = String(process.env[name] || "").trim();
  return v || def;
}

function optInt(name, def) {
  const raw = String(process.env[name] || "").trim();
  const n = raw ? Number(raw) : def;
  return Number.isFinite(n) ? Math.floor(n) : def;
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function parseMoney(s) {
  const m = String(s || "").replace(/,/g, "").match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function absUrl(relOrAbs) {
  try {
    return new URL(relOrAbs, BASE).toString();
  } catch {
    return null;
  }
}

function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&");
}

function parseBgImageUrl(styleAttr) {
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

function deriveModel(listingName, brand) {
  const ln = cleanText(listingName);
  const b = cleanText(brand);
  if (!ln) return "";
  if (b && ln.toLowerCase().startsWith((b + " ").toLowerCase())) {
    return ln.slice(b.length).trim();
  }
  return ln;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
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

// Read total page count from the pagination buttons in the HTML
function getTotalPages(html) {
  const $ = cheerio.load(html);
  const pages = $(".page[data-page]")
    .map((_, el) => parseInt($(el).attr("data-page"), 10))
    .get()
    .filter((n) => Number.isFinite(n) && n > 0);
  return pages.length > 0 ? Math.max(...pages) : 1;
}

function parseDealsFromHtml(html) {
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
  const dealsFound = tiles.length;

  const deals = [];
  tiles.each((_, el) => {
    const $el = $(el);

    const rel =
      $el.attr("data-url") ||
      $el.find("a[href^='/product/']").attr("href") ||
      null;
    const listingURL = absUrl(rel);
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
    let originalPrice = parseMoney($price.find(".struck").first().text());
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
      sample("missingBothPrices", {
        listingURL,
        priceText: cleanText($price.text()),
      });
      return;
    }

    if (salePrice >= originalPrice) {
      dropCounts.notMarkdown++;
      return;
    }

    const nameLower = name.toLowerCase();
    let gender = "unisex";
    if (nameLower.includes("women") || nameLower.includes("womens") || nameLower.includes("woman")) {
      gender = "womens";
    } else if (nameLower.includes("men") || nameLower.includes("mens") || nameLower.includes("man")) {
      gender = "mens";
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
      gender,
      shoeType: "unknown",
    });
  });

  return { dealsFound, dealsExtracted: deals.length, deals, dropCounts, dropSamples };
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

function mergeDropCounts(a, b) {
  return {
    missingListingURL: a.missingListingURL + b.missingListingURL,
    missingImageURL: a.missingImageURL + b.missingImageURL,
    missingNameBrand: a.missingNameBrand + b.missingNameBrand,
    missingBothPrices: a.missingBothPrices + b.missingBothPrices,
    notMarkdown: a.notMarkdown + b.notMarkdown,
  };
}

// Scrapes one page via Firecrawl.
// pageNum=1 loads normally.
// pageNum>1 clicks that page number button before capturing HTML.
async function fetchPageHtml(url, pageNum, apiKey, proxy, timeout) {
  const actions = [
    { type: "wait", milliseconds: 2000 },
    { type: "wait", selector: ".product.clickable" },
  ];

  if (pageNum > 1) {
    actions.push(
      { type: "click", selector: `.page[data-page='${pageNum}']` },
      { type: "wait", milliseconds: 2500 },
      { type: "wait", selector: ".product.clickable" }
    );
  }

  actions.push(
    { type: "scroll", direction: "down" },
    { type: "wait", milliseconds: 800 },
    { type: "scroll", direction: "down" },
    { type: "wait", milliseconds: 800 }
  );

  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["html"],
      onlyMainContent: false,
      maxAge: 0,
      proxy,
      timeout,
      actions,
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Firecrawl failed (page ${pageNum}): ${res.status} ${res.statusText} ${txt}`.trim());
  }

  const json = await res.json();
  const html = json?.data?.html;
  if (!html) throw new Error(`Firecrawl response missing data.html (page ${pageNum})`);
  return html;
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();

  // Uncomment to protect this endpoint with a secret when not testing:
  // const secret = process.env.CRON_SECRET;
  // if (secret && req.headers["authorization"] !== `Bearer ${secret}`) {
  //   return res.status(401).json({ error: "Unauthorized" });
  // }

  try {
    requireEnv("BLOB_READ_WRITE_TOKEN");
    const apiKey = requireEnv("FIRECRAWL_API_KEY");
    const proxy = optStr("BIGPEACH_PROXY", "auto");
    const timeout = optInt("BIGPEACH_TIMEOUT_MS", 60000);

    // Scrape page 1 and detect how many pages exist
    const page1Html = await fetchPageHtml(DEALS_URL, 1, apiKey, proxy, timeout);
    const totalPages = getTotalPages(page1Html);
    const page1Parsed = parseDealsFromHtml(page1Html);

    let allDeals = [...page1Parsed.deals];
    let totalDealsFound = page1Parsed.dealsFound;
    let combinedDropCounts = page1Parsed.dropCounts;
    let combinedDropSamples = [...page1Parsed.dropSamples];

    // Scrape any additional pages
    for (let p = 2; p <= totalPages; p++) {
      const pageHtml = await fetchPageHtml(DEALS_URL, p, apiKey, proxy, timeout);
      const pageParsed = parseDealsFromHtml(pageHtml);
      allDeals = [...allDeals, ...pageParsed.deals];
      totalDealsFound += pageParsed.dealsFound;
      combinedDropCounts = mergeDropCounts(combinedDropCounts, pageParsed.dropCounts);
      combinedDropSamples = [...combinedDropSamples, ...pageParsed.dropSamples].slice(0, 6);
    }

    const deals = dedupeByListingUrl(allDeals);

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: "firecrawl",
      sourceUrls: [DEALS_URL],
      pagesFetched: totalPages,
      dealsFound: totalDealsFound,
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
        totalPages,
        tilesSeen: totalDealsFound,
        dealsKept: deals.length,
        dropCounts: combinedDropCounts,
        dropSamples: combinedDropSamples,
        proxy,
      },
    });
  } catch (e) {
    return res.status(500).json({
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: "firecrawl",
      ok: false,
      error: e?.message || "unknown error",
      scrapeDurationMs: Date.now() - t0,
    });
  }
};
