// /api/scrapers/big-peach-running-co.js  (CommonJS)
// Scrapes BOTH:
//   https://shop.bigpeachrunningco.com/category/17193/WomensFootwear
//   https://shop.bigpeachrunningco.com/category/17194/MensFootwear
//
// Writes ONE blob:
//   .../big-peach-running-co.json
//
// RULES:
// - Drop deals if they don't have BOTH salePrice and originalPrice
// - shoeType = "unknown"
// - Uses your canonical per-deal schema + your top-level structure
//
// NOTE:
// This site appends more products without changing URL (AJAX/infinite-style).
// So: we attempt plain fetch first; if tiles aren't in raw HTML, we fall back to Firecrawl
// with "scroll to bottom" actions a few times to force products to load before parsing.
//
// ENV REQUIRED:
// - BLOB_READ_WRITE_TOKEN  (Vercel Blob)
// - FIRECRAWL_API_KEY      (only needed if raw HTML doesn't contain tiles)
// Optional:
// - BIGPEACH_SCROLLS (default 8)   // how many scroll-to-bottom cycles in Firecrawl
// - BIGPEACH_WAIT_MS (default 900) // wait after each scroll in Firecrawl

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

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function parseMoney(s) {
  // "$274.99" -> 274.99
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

function parseBgImageUrl(styleAttr) {
  // background-image: url("https://...")
  const s = String(styleAttr || "");
  const m = s.match(/background-image\s*:\s*url\((["']?)(.*?)\1\)/i);
  return m ? m[2] : null;
}

function deriveModel(listingName, brand) {
  // You told me: never edit listingName; only parse it.
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

async function fetchHtmlPlain(url) {
  const res = await fetch(url, {
    headers: {
      // keep it boring; this is not “bot protection bypass”
      "user-agent": "Mozilla/5.0 (compatible; ShoeBeagleBot/1.0)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

// Firecrawl scrape -> HTML
async function fetchHtmlViaFirecrawl(url) {
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY env var is not set (needed for Firecrawl fallback).");

  const scrolls = optInt("BIGPEACH_SCROLLS", 8);
  const waitMs = optInt("BIGPEACH_WAIT_MS", 900);

  // Firecrawl “scrape” with actions (scroll + wait) to force lazy-loaded products
  const body = {
    url,
    formats: ["html"],
    // Actions are best-effort — if the page is already fully loaded, this is harmless.
    actions: [
      { type: "wait", milliseconds: 1200 },
      { type: "waitForSelector", selector: ".product.clickable", timeout: 15000 },
      ...Array.from({ length: scrolls }).flatMap(() => [
        { type: "scrollToBottom" },
        { type: "wait", milliseconds: waitMs },
      ]),
    ],
  };

  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
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

function parseDealsFromHtml(html, gender) {
  const $ = cheerio.load(html);

  const tiles = $(".product.clickable");
  const dealsFound = tiles.length;

  const deals = [];
  tiles.each((_, el) => {
    const $el = $(el);

    const rel = $el.attr("data-url") || $el.find("a[href^='/product/']").attr("href");
    const listingURL = absUrl(rel);

    const name = cleanText($el.find(".name").first().text());
    const brand = cleanText($el.find(".brand").first().text());

    // image is background-image in .image style attr
    const imageURL = parseBgImageUrl($el.find(".image").attr("style"));

    const originalText = cleanText($el.find(".price .struck").first().text());

    // sale text = price text minus struck
    const $priceClone = $el.find(".price").first().clone();
    $priceClone.find(".struck").remove();
    const saleText = cleanText($priceClone.text());

    const originalPrice = parseMoney(originalText);
    const salePrice = parseMoney(saleText);

    // Must have BOTH prices, and it must be an actual markdown
    if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return;
    if (salePrice <= 0 || originalPrice <= 0) return;
    if (salePrice >= originalPrice) return;

    if (!listingURL || !imageURL || !brand || !name) return;

    const listingName = cleanText(`${brand} ${name}`);

    deals.push({
      // per-deal schema
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

  return { dealsFound, dealsExtracted: deals.length, deals };
}

async function getPageHtml(url) {
  // try raw first
  const raw = await fetchHtmlPlain(url);
  if (raw.includes('class="product clickable"') || raw.includes("product clickable")) {
    return { html: raw, via: "cheerio" };
  }

  // fallback to firecrawl rendered HTML
  const rendered = await fetchHtmlViaFirecrawl(url);
  return { html: rendered, via: "firecrawl" };
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();

  try {
    // Blob token required
    requireEnv("BLOB_READ_WRITE_TOKEN");

    const sourceUrls = [WOMENS_URL, MENS_URL];

    // Fetch + parse womens
    const womensFetched = await getPageHtml(WOMENS_URL);
    const womensParsed = parseDealsFromHtml(womensFetched.html, "womens");

    // Fetch + parse mens
    const mensFetched = await getPageHtml(MENS_URL);
    const mensParsed = parseDealsFromHtml(mensFetched.html, "mens");

    const deals = [...womensParsed.deals, ...mensParsed.deals];

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      // If either needed firecrawl, report firecrawl; else cheerio
      via: womensFetched.via === "firecrawl" || mensFetched.via === "firecrawl" ? "firecrawl" : "cheerio",

      sourceUrls,
      pagesFetched: 2,

      dealsFound: womensParsed.dealsFound + mensParsed.dealsFound,
      dealsExtracted: deals.length,

      scrapeDurationMs: Date.now() - t0,

      ok: true,
      error: null,

      deals,
    };

    // Write blob (no random suffix)
    const blob = await put("big-peach-running-co.json", JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    return res.status(200).json({
      ...payload,
      blobUrl: blob.url,
    });
  } catch (e) {
    return res.status(500).json({
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      ok: false,
      error: e?.message || "unknown error",
      scrapeDurationMs: Date.now() - t0,
    });
  }
};
