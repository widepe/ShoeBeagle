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
// - listingName is constructed once; do not mutate later
//
// Required env vars:
// - BLOB_READ_WRITE_TOKEN
// - FIRECRAWL_API_KEY
//
// Optional env vars:
// - BIGPEACH_MAX_PAGE   default 12  (attempt clicks 2..MAX_PAGE; safe if fewer pages exist)
// - BIGPEACH_WAIT_MS    default 1400
// - BIGPEACH_PROXY      default "auto"  ("auto"|"enhanced"|"basic")

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
  // minimal decoding for style attributes we care about
  return String(s || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&");
}

function parseBgImageUrl(styleAttr) {
  // Handles both:
  //  background-image: url("https://...")
  //  background-image: url(&quot;https://...&quot;)
  const s = decodeHtmlEntities(styleAttr);

  // capture inside url(...)
  const m = s.match(/url\(\s*([^)]+?)\s*\)/i);
  if (!m) return null;

  // strip wrapping quotes
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

function parseDealsFromHtml(html, gender) {
  const $ = cheerio.load(html);

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

    const name = cleanText($el.find(".name").first().text());
    const brand = cleanText($el.find(".brand").first().text());

    const imageURL = parseBgImageUrl($el.find(".image").attr("style"));

    // PRICE (robust): require two prices.
    // Prefer .struck for original if present, but also handle general cases.
    const originalText = cleanText($el.find(".price .struck").first().text());

    const $priceClone = $el.find(".price").first().clone();
    $priceClone.find(".struck").remove();
    const saleText = cleanText($priceClone.text());

    let originalPrice = parseMoney(originalText);
    let salePrice = parseMoney(saleText);

    // Fallback: if either missing, parse all numbers inside .price
    if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) {
      const priceTextAll = cleanText($el.find(".price").first().text());
      const matches = priceTextAll.match(/\$?\s*\d{1,4}(?:,\d{3})*(?:\.\d{2})?/g) || [];
      const nums = matches.map(parseMoney).filter(n => Number.isFinite(n));
      const uniq = Array.from(new Set(nums.map(n => n.toFixed(2)))).map(s => Number(s));
      if (uniq.length >= 2) {
        originalPrice = Math.max(...uniq);
        salePrice = Math.min(...uniq);
      }
    }

    // Must have BOTH prices and be a real markdown
    if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return;
    if (salePrice <= 0 || originalPrice <= 0) return;
    if (salePrice >= originalPrice) return;

    if (!listingURL || !imageURL || !brand || !name) return;

    const listingName = cleanText(`${brand} ${name}`);

    deals.push({
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

// Build Firecrawl actions that actually click your pagination:
// <div class="pages"><div class="page" data-page="1">...</div><div class="page current" data-page="2">2</div></div>
function buildPaginationActions(maxPage, waitMs) {
  const actions = [
    { type: "wait", milliseconds: 1600 },
    { type: "waitForSelector", selector: ".product.clickable", timeout: 20000 },
  ];

  // Click pages 2..maxPage if present
  for (let p = 2; p <= maxPage; p++) {
    actions.push(
      {
        type: "executeJavascript",
        script: `
          (function(){
            const sel = '.pages .page[data-page="${p}"]';
            const el = document.querySelector(sel);
            if (el) el.click();
          })();
        `,
      },
      { type: "wait", milliseconds: waitMs },
      // encourage lazy-load append
      { type: "scrollToBottom" },
      { type: "wait", milliseconds: waitMs }
    );
  }

  return actions;
}

async function fetchHtmlViaFirecrawl(url) {
  const apiKey = requireEnv("FIRECRAWL_API_KEY");
  const maxPage = optInt("BIGPEACH_MAX_PAGE", 12);
  const waitMs = optInt("BIGPEACH_WAIT_MS", 1400);
  const proxy = optStr("BIGPEACH_PROXY", "auto");

  const body = {
    url,
    formats: ["html"],
    onlyMainContent: false,
    maxAge: 0,
    proxy,
    actions: buildPaginationActions(maxPage, waitMs),
  };

  // Using v1 scrape endpoint (widely supported). If your account uses v2, swap URL accordingly.
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
        mensTilesSeen: mensParsed.dealsFound,
        mensDealsKept: mensParsed.dealsExtracted,
        maxPageClicked: optInt("BIGPEACH_MAX_PAGE", 12),
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
