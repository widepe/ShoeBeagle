// /api/scrapers/big-peach-running-co.js  (CommonJS)
//
// Scrapes BOTH category pages (Women + Men) using Firecrawl-rendered DOM + pagination clicks,
// then writes ONE blob: .../big-peach-running-co.json
//
// Pages:
//  - https://shop.bigpeachrunningco.com/category/17193/WomensFootwear
//  - https://shop.bigpeachrunningco.com/category/17194/MensFootwear
//
// Rules:
// - Drop deals unless BOTH salePrice and originalPrice exist AND sale < original
// - shoeType = "unknown"
// - Write canonical deal objects using your schema (including optional range fields set to null)
//
// Required env vars:
// - BLOB_READ_WRITE_TOKEN
// - FIRECRAWL_API_KEY
//
// Optional env vars:
// - BIGPEACH_MAX_PAGE        default 6   (click page numbers 2..MAX_PAGE)
// - BIGPEACH_WAIT_MS         default 1200 (wait between actions)
// - BIGPEACH_PROXY           default "auto" ("basic"|"enhanced"|"auto")

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

function parseBgImageUrl(styleAttr) {
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

    const imageURL = parseBgImageUrl($el.find(".image").attr("style"));

    const originalText = cleanText($el.find(".price .struck").first().text());

    // sale text = .price minus .struck
    const $priceClone = $el.find(".price").first().clone();
    $priceClone.find(".struck").remove();
    const saleText = cleanText($priceClone.text());

    const originalPrice = parseMoney(originalText);
    const salePrice = parseMoney(saleText);

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

function buildPaginationActions(maxPage, waitMs) {
  // We click page numbers 2..maxPage using executeJavascript, because:
  // - URL does not change
  // - clicking appends products to existing list
  // Firecrawl supports executeJavascript actions. :contentReference[oaicite:2]{index=2}
  const actions = [
    { type: "wait", milliseconds: 1500 },
    // wait for the product grid to exist (after JS renders)
    { type: "wait", selector: ".product.clickable" },
  ];

  for (let p = 2; p <= maxPage; p++) {
    actions.push(
      {
        type: "executeJavascript",
        script: `
          (function(){
            const targetText = "${p}";
            // Try common pagination patterns: links/buttons with exact text
            const candidates = Array.from(document.querySelectorAll('a,button'));
            const el = candidates.find(x => (x.textContent || "").trim() === targetText);
            if (el) el.click();
          })();
        `,
      },
      { type: "wait", milliseconds: waitMs }
    );
  }

  // Add a few scrolls down to encourage any lazy loading within the final page
  actions.push(
    { type: "scroll", direction: "down" },
    { type: "wait", milliseconds: waitMs },
    { type: "scroll", direction: "down" },
    { type: "wait", milliseconds: waitMs }
  );

  return actions;
}

async function fetchHtmlViaFirecrawl(url) {
  const apiKey = requireEnv("FIRECRAWL_API_KEY");
  const maxPage = optInt("BIGPEACH_MAX_PAGE", 6);
  const waitMs = optInt("BIGPEACH_WAIT_MS", 1200);
  const proxy = optStr("BIGPEACH_PROXY", "auto");

  const body = {
    url,
    formats: ["html"],
    onlyMainContent: false, // IMPORTANT: product grid is not "main content" reliably
    maxAge: 0,              // IMPORTANT: avoid cached partial renders
    proxy,                  // "auto" retries with enhanced if needed
    actions: buildPaginationActions(maxPage, waitMs),
  };

  // v2 scrape endpoint (per current docs)
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

    const deals = [...womensParsed.deals, ...mensParsed.deals];

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: "firecrawl",

      sourceUrls,
      pagesFetched: 2,

      // NOTE: dealsFound is how many tiles were present AFTER paging clicks
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
        maxPageClicked: optInt("BIGPEACH_MAX_PAGE", 6),
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
