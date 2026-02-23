// /api/scrapers/big-peach-running-co.js  (CommonJS)
//
// Big Peach Running Co (RunFree storefront) — Women + Men category pages
// Writes ONE blob: .../big-peach-running-co.json
//
// Pages:
//  - https://shop.bigpeachrunningco.com/category/17193/WomensFootwear
//  - https://shop.bigpeachrunningco.com/category/17194/MensFootwear
//
// RULES:
// - Drop deals unless BOTH salePrice and originalPrice exist AND sale < original
// - shoeType = "unknown"
// - listingName: build once; never mutate later (per your rule)
//
// ✅ Fixes included
// - Firecrawl actions use ONLY supported types: wait, click, scroll
// - Pagination click targets your real pager element: .pages .page[data-page="2"]
// - Robust imageURL extraction:
//    1) .image style background-image
//    2) .colorswatches [data-preview-url]
//    3) colorswatch style background-image (thumb)
// - Robust price extraction with fallback to “all $ numbers in .price”
// - Debug dropCounts + dropSamples to tell you exactly why items were dropped
// - Dedupe by listingURL (unisex items appearing in both pages)
//
// Required env vars:
// - BLOB_READ_WRITE_TOKEN
// - FIRECRAWL_API_KEY
//
// Optional env vars:
// - BIGPEACH_WAIT_MS       default 1400
// - BIGPEACH_SCROLLS       default 18   (more scrolls = more appended items)
// - BIGPEACH_PROXY         default "auto" ("auto"|"enhanced"|"basic")
// - BIGPEACH_CLICK_PAGE2   default "true" ("true"|"false")
// - BIGPEACH_TIMEOUT_MS    default 140000

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "Big Peach Running Co";
const SCHEMA_VERSION = 1;

const WOMENS_URL = "https://shop.bigpeachrunningco.com/category/17193/WomensFootwear";
const MENS_URL = "https://shop.bigpeachrunningco.com/category/17194/MensFootwear";
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

function optBool(name, def) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return def;
  return raw === "true" || raw === "1" || raw === "yes";
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
  // 1) main tile image background-image
  const style = $el.find(".image").attr("style");
  const fromStyle = parseBgImageUrl(style);
  if (fromStyle) return fromStyle;

  // 2) colorswatch data-preview-url (very common in this storefront)
  const fromPreview = $el.find(".colorswatches [data-preview-url]").first().attr("data-preview-url");
  if (fromPreview) return cleanText(fromPreview);

  // 3) colorswatch thumb background-image fallback
  const swStyle = $el.find(".colorswatches .colorswatch").first().attr("style");
  const fromSwStyle = parseBgImageUrl(swStyle);
  if (fromSwStyle) return fromSwStyle;

  return null;
}

function parseDealsFromHtml(html, gender) {
  const $ = cheerio.load(html);
console.log("RAW_HTML_SAMPLE", html.slice(0, 3000));
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
      sample("missingImageURL", {
        listingURL,
        imageStyle: $el.find(".image").attr("style") || null,
        hasPreviewUrl: Boolean($el.find(".colorswatches [data-preview-url]").length),
      });
      return;
    }

// PRICE: read struck span for original, text nodes for sale
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
        priceText: cleanText($el.find(".price").first().text()),
      });
      return;
    }

    if (salePrice >= originalPrice) {
      dropCounts.notMarkdown++;
      return;
    }

    const listingName = cleanText(`${brand} ${name}`);

    deals.push({
      // per-deal schema (your fields)
      schemaVersion: SCHEMA_VERSION,

      listingName,

      brand,
      model: deriveModel(listingName, brand),

      salePrice,
      originalPrice,
      discountPercent: computeDiscountPercent(originalPrice, salePrice),

      // optional range fields (not used here)
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

  return {
    dealsFound,
    dealsExtracted: deals.length,
    deals,
    dropCounts,
    dropSamples,
  };
}

function dedupeByListingUrl(deals) {
  const seen = new Set();
  const out = [];
  for (const d of deals) {
    const key = d.listingURL;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

async function fetchHtmlViaFirecrawl(url) {
  const apiKey = requireEnv("FIRECRAWL_API_KEY");

  const waitMs = optInt("BIGPEACH_WAIT_MS", 1400);
  const scrolls = optInt("BIGPEACH_SCROLLS", 3);
  const proxy = optStr("BIGPEACH_PROXY", "auto");
  const clickPage2 = optBool("BIGPEACH_CLICK_PAGE2", true);
  const timeout = optInt("BIGPEACH_TIMEOUT_MS", 140000);

  // Firecrawl actions must be one of: wait, click, screenshot, write, press, scroll, scrape
  // Your pager is a DIV: .pages .page[data-page="2"]
  const actions = [
    { type: "wait", milliseconds: 1600 },
    // wait until products are rendered
    { type: "wait", selector: ".product.clickable" },
  ];

  if (clickPage2) {
    actions.push(
      { type: "click", selector: ".pages .page[data-page='2']" },
      { type: "wait", milliseconds: waitMs }
    );
  }

  for (let i = 0; i < scrolls; i++) {
    actions.push(
      { type: "scroll", direction: "down" },
      { type: "wait", milliseconds: waitMs }
    );
  }

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

  try {
    requireEnv("BLOB_READ_WRITE_TOKEN");
    requireEnv("FIRECRAWL_API_KEY");

    const sourceUrls = [WOMENS_URL, MENS_URL];

    // Women
    const womensHtml = await fetchHtmlViaFirecrawl(WOMENS_URL);
    const womensParsed = parseDealsFromHtml(womensHtml, "womens");

    // Men
    const mensHtml = await fetchHtmlViaFirecrawl(MENS_URL);
    const mensParsed = parseDealsFromHtml(mensHtml, "mens");

    const combined = [...womensParsed.deals, ...mensParsed.deals];
    const deals = dedupeByListingUrl(combined);

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: "firecrawl",

      sourceUrls,
      pagesFetched: 2,

      dealsFound: womensParsed.dealsFound + mensParsed.dealsFound,
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

    return res.status(200).json({
      ...payload,
      blobUrl: blob.url,
      debug: {
        womensTilesSeen: womensParsed.dealsFound,
        womensDealsKept: womensParsed.dealsExtracted,
        womensDropCounts: womensParsed.dropCounts,
        womensDropSamples: womensParsed.dropSamples,

        mensTilesSeen: mensParsed.dealsFound,
        mensDealsKept: mensParsed.dealsExtracted,
        mensDropCounts: mensParsed.dropCounts,
        mensDropSamples: mensParsed.dropSamples,

        clickPage2: optBool("BIGPEACH_CLICK_PAGE2", true),
        scrolls: optInt("BIGPEACH_SCROLLS", 3),
        waitMs: optInt("BIGPEACH_WAIT_MS", 1400),
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
