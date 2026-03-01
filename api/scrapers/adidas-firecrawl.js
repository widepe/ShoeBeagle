// /api/scrapers/adidas-firecrawl.js
// Adidas Sale Scraper (Firecrawl + safe pagination)
//
// Pagination rule:
// - If page has 48 cards → try next ?start=+48
// - If page has < 48 cards → stop
//
// Writes EXACT adidas.json to Vercel Blob

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "Adidas";
const SCHEMA_VERSION = 1;
const VIA = "firecrawl";

const BASE_URLS = [
  "https://www.adidas.com/us/women-running-shoes-sale",
  "https://www.adidas.com/us/men-running-shoes-sale",
];

const PAGE_SIZE = 48;
const MAX_PAGES = 10; // safety cap

function nowIso() {
  return new Date().toISOString();
}

function toAbsUrl(href) {
  const s = String(href || "").trim();
  if (!s) return null;
  if (s.startsWith("http")) return s;
  if (s.startsWith("/")) return `https://www.adidas.com${s}`;
  return `https://www.adidas.com/${s}`;
}

function parseMoney(text) {
  const s = String(text || "").replace(/,/g, "");
  const m = s.match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function computeDiscountPercent(sale, orig) {
  if (!(sale > 0) || !(orig > 0) || sale >= orig) return null;
  return Math.round(((orig - sale) / orig) * 100);
}

function inferGenderFromSubtitle(subtitle) {
  const s = String(subtitle || "").toLowerCase();
  if (s.includes("unisex")) return "unisex";
  if (s.includes("women")) return "womens";
  if (s.includes("men")) return "mens";
  return "unknown";
}

function buildUrl(base, start) {
  if (!start) return base;
  const u = new URL(base);
  u.searchParams.set("start", String(start));
  return u.toString();
}

async function firecrawlHtml(url, apiKey) {
  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["html"],
    }),
  });

  const json = await resp.json().catch(() => null);

  if (!resp.ok) {
    throw new Error(json?.error || `Firecrawl failed (${resp.status})`);
  }

  const html = json?.data?.html;
  if (!html) throw new Error("No HTML returned from Firecrawl");

  return html;
}

module.exports = async function handler(req, res) {
  const started = Date.now();

  try {
    // ✅ YOUR EXACT CRON SECRET CHECK
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers["authorization"] !== `Bearer ${secret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing FIRECRAWL_API_KEY" });
    }

    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      return res.status(500).json({ error: "Missing BLOB_READ_WRITE_TOKEN" });
    }

    const seen = new Set();
    const allDeals = [];

    let pagesFetched = 0;
    let dealsFound = 0;

    const sourceUrls = [];

    for (const baseUrl of BASE_URLS) {
      for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
        const start = pageIndex * PAGE_SIZE;
        const url = buildUrl(baseUrl, start);

        const html = await firecrawlHtml(url, apiKey);
        pagesFetched++;
        sourceUrls.push(url);

        const $ = cheerio.load(html);
        const cards = $("article[data-testid='plp-product-card']");
        const cardCount = cards.length;

        dealsFound += cardCount;

        let newDealsThisPage = 0;

        cards.each((_, el) => {
          const $card = $(el);

          const title = $card
            .find("p[data-testid='product-card-title']")
            .first()
            .text()
            .trim();

          if (!title) return;

          const subtitle = $card
            .find("p[data-testid='product-card-subtitle']")
            .first()
            .text()
            .trim();

          const href =
            $card
              .find("a[data-testid='product-card-image-link']")
              .first()
              .attr("href") ||
            $card
              .find("a[data-testid='product-card-description-link']")
              .first()
              .attr("href");

          const saleText =
            $card
              .find("[data-testid='main-price']")
              .first()
              .text()
              .trim() || "";

          const originalText = $card
            .find("[data-testid='original-price']")
            .first()
            .text()
            .trim();

          const salePrice = parseMoney(saleText);
          const originalPrice = parseMoney(originalText);

          if (!(salePrice > 0) || !(originalPrice > 0)) return;

          const listingURL = toAbsUrl(href);
          const key = listingURL || `${title}-${salePrice}-${originalPrice}`;

          if (seen.has(key)) return;
          seen.add(key);

          allDeals.push({
            listingName: title,
            brand: "Adidas",
            model: title,

            salePrice,
            originalPrice,
            discountPercent: computeDiscountPercent(
              salePrice,
              originalPrice
            ),

            salePriceLow: null,
            salePriceHigh: null,
            originalPriceLow: null,
            originalPriceHigh: null,
            discountPercentUpTo: null,

            store: STORE,
            listingURL,
            imageURL: null,

            gender: inferGenderFromSubtitle(subtitle),
            shoeType: "unknown",
          });

          newDealsThisPage++;
        });

        // ✅ STOP pagination if page not full OR no new unique deals
        if (cardCount < PAGE_SIZE || newDealsThisPage === 0) {
          break;
        }
      }
    }

    const out = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,
      pagesFetched,
      dealsFound,
      dealsExtracted: allDeals.length,
      scrapeDurationMs: Date.now() - started,

      ok: true,
      error: null,
      deals: allDeals,
    };

    const blob = await put("adidas.json", JSON.stringify(out, null, 2), {
      access: "public",
      contentType: "application/json",
      token: blobToken,
      addRandomSuffix: false,
    });

    out.blobUrl = blob.url;

    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err.message || err),
      scrapeDurationMs: Date.now() - started,
    });
  }
};
