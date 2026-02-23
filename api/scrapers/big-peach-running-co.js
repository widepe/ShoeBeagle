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
// - BIGPEACH_WAIT_MS       default 1500
// - BIGPEACH_SCROLLS       default 3
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

function optInt(name, def) {
  const raw = String(process.env[name] || "").trim();
  const n = raw ? Number(raw) : def;
  return Number.isFinite(n) ? Math.floor(n) : def;
}

function optStr(name, def) {
  const v = String(process.env[name] || "").trim();
  return v || def;
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

    // listing URL
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

    // name + brand
    const name = cleanText($el.find(".name").first().text());
    const brand = cleanText($el.find(".brand").first().text());
    if (!name || !brand) {
      dropCounts.missingNameBrand++;
      sample("missingNameBrand", { listingURL, name, brand });
      return;
    }

    // image
    const imageURL = pickImageUrl($el);
    if (!imageURL) {
      dropCounts.missingImageURL++;
      sample("missingImageURL", { listingURL });
      return;
    }

    // prices — struck span = original, text node = sale
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

    // infer gender from name/brand text
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

async function fetchHtmlViaFirecrawl(url) {
  const apiKey = requireEnv("FIRECRAWL_API_KEY");
  const waitMs = optInt("BIGPEACH_WAIT_MS", 800);
  const scrolls = optInt("BIGPEACH_SCROLLS", 2);
  const proxy = optStr("BIGPEACH_PROXY", "auto");
  const timeout = optInt("BIGPEACH_TIMEOUT_MS", 60000);

const actions = [
    { type: "wait", milliseconds: 2000 },
    { type: "wait", selector: ".product.clickable" },
  ];

  for (let i = 0; i < scrolls; i++) {
    actions.push(
      { type: "scroll", direction: "down" },
      { type: "wait", milliseconds: waitMs }
    );
  }

  // click page 2 and wait for new tiles to load

  actions.push(
    { type: "click", selector: ".pages .page[data-page='2']" },
    { type: "wait", milliseconds: 1500 },
    { type: "scroll", direction: "down" },
    { type: "wait", milliseconds: 800 }
  );

  const body = {
    url,
    formats: ["html"],
    onlyMainContent: false,
    maxAge: 0,
    proxy,
    timeout,
    actions,
  };

  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Firecrawl failed: ${res.status} ${res.statusText} ${txt}`.trim());
  }

  const json = await res.json();
  const html = json?.data?.html;
  if (!html) throw new Error("Firecrawl response did not include data.html");
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
    requireEnv("FIRECRAWL_API_KEY");

    const html = await fetchHtmlViaFirecrawl(DEALS_URL);
    const parsed = parseDealsFromHtml(html);
    const deals = dedupeByListingUrl(parsed.deals);

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: "firecrawl",
      sourceUrls: [DEALS_URL],
      pagesFetched: 1,
      dealsFound: parsed.dealsFound,
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
        tilesSeen: parsed.dealsFound,
        dealsKept: parsed.dealsExtracted,
        dropCounts: parsed.dropCounts,
        dropSamples: parsed.dropSamples,
        scrolls: optInt("BIGPEACH_SCROLLS", 3),
        waitMs: optInt("BIGPEACH_WAIT_MS", 1500),
        proxy: optStr("BIGPEACH_PROXY", "auto"),
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
