// /api/scrapers/runrepeat-catalog-fast.js
//
// Fast RunRepeat catalog scraper
// - Scrapes ONLY catalog pages, not individual shoe pages
// - Much faster than page-by-page product scraping
// - Saves to Vercel Blob as shoe-database.json
//
// ENV:
// - BLOB_READ_WRITE_TOKEN
// Optional:
// - RUNREPEAT_CONCURRENCY=8
// - RUNREPEAT_MAX_PAGES=24

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const SOURCE = "RunRepeat";
const SCHEMA_VERSION = 1;
const BASE_URL = "https://runrepeat.com";
const CATALOG_URL = "https://runrepeat.com/catalog/running-shoes?page=";

const CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.RUNREPEAT_CONCURRENCY || 8)));
const MAX_PAGES = Math.max(1, Math.min(24, Number(process.env.RUNREPEAT_MAX_PAGES || 24)));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        pragma: "no-cache",
        "cache-control": "no-cache",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }

    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function htmlDecode(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanText(s) {
  return normalizeWhitespace(
    htmlDecode(String(s || "").replace(/<[^>]*>/g, " "))
  );
}

function absoluteUrl(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return `https:${u}`;
  if (u.startsWith("/")) return `${BASE_URL}${u}`;
  return `${BASE_URL}/${u.replace(/^\/+/, "")}`;
}

function parseNumberLoose(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const m = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function inferBrandAndModel(name) {
  const title = normalizeWhitespace(name);
  if (!title) return { brand: null, model: null };

  const tokens = title.split(" ");
  const first = tokens[0] || "";

  const multiWordBrands = [
    "New Balance",
    "Under Armour",
    "La Sportiva",
  ];

  for (const brand of multiWordBrands) {
    if (title.toLowerCase().startsWith(brand.toLowerCase() + " ")) {
      return {
        brand,
        model: title.slice(brand.length).trim() || null,
      };
    }
  }

  return {
    brand: first || null,
    model: title.slice(first.length).trim() || null,
  };
}

function extractPageCount(html) {
  const matches = [...html.matchAll(/>\s*(\d+)\s*<\/a>/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  const max = matches.length ? Math.max(...matches) : null;
  return max && max > 0 ? max : 1;
}

function extractReviewedCount(html) {
  const m = html.match(/(\d+)\s+shoes reviewed/i);
  return m ? Number(m[1]) : null;
}

function extractCards(html) {
  // Split on numbered list items in the product list area.
  // This is intentionally simple and fast.
  const chunks = html.split(/\n\s*\d+\.\s+/).slice(1);

  const rows = [];

  for (const chunk of chunks) {
    const titleMatch = chunk.match(/【\d+†([^】]+)】/);
    const name = titleMatch ? cleanText(titleMatch[1]) : "";

    if (!name) continue;

    const scoreMatch = chunk.match(/\n\s*(\d{2})\s*\n/);
    const score = scoreMatch ? Number(scoreMatch[1]) : null;

    const priceMatch = chunk.match(/\$([0-9.,]+)\s+\$([0-9.,]+)/);
    const originalPrice = priceMatch ? parseNumberLoose(priceMatch[1]) : null;
    const salePrice = priceMatch ? parseNumberLoose(priceMatch[2]) : null;

    const saveMatch = chunk.match(/Save\s+(\d+)%/i);
    const discountPercent = saveMatch ? Number(saveMatch[1]) : null;

    const retailerMatch = chunk.match(/See on ([^†<\n]+).*?(https?:\/\/[^\s)]+)?/i);
    const store = retailerMatch ? cleanText(retailerMatch[1]) : null;

    const linkMatch = chunk.match(/【\d+†([^】]+)】/); // same visible title ref only
    let sourceUrl = "";
    // The open() text doesn't expose hrefs inline, so when scraping live HTML below
    // we use direct anchor parsing instead. This fallback is here for safety only.

    const { brand, model } = inferBrandAndModel(name);

    rows.push({
      schemaVersion: SCHEMA_VERSION,
      brand,
      model,
      price: originalPrice,
      salePrice,
      score,
      reviewCount: null,
      ratingValue: null,
      weightOz: null,
      weightText: null,
      heelStackHeightMm: null,
      forefootStackHeightMm: null,
      stackHeightMm: null,
      heelToToeDropMm: null,
      heelDrop: null,
      shoeSupportType: null,
      shoeDesignType: null,
      plateType: null,
      toeBox: null,
      surface: null,
      cushioning: null,
      releaseDate: null,
      discontinued: false,
      notes: discountPercent != null ? `Save ${discountPercent}%` : null,
      source: SOURCE,
      sourceUrl,
      listingName: name,
      store,
      originalPrice,
      discountPercent,
    });
  }

  return rows;
}

function extractCardsFromLiveHtml(html) {
  const rows = [];

  // Grab product anchors like /hoka-bondi-9 from catalog pages
  const productLinks = [...html.matchAll(/<a[^>]+href="(\/[^"#?]+)"[^>]*>([^<]+)<\/a>/gi)]
    .map((m) => ({
      href: absoluteUrl(m[1]),
      text: cleanText(m[2]),
    }))
    .filter((x) => x.href.startsWith(`${BASE_URL}/`))
    .filter((x) => !x.href.includes("/catalog/"))
    .filter((x) => !x.href.includes("/guides/"))
    .filter((x) => x.text && x.text.length > 2);

  const dedupedLinks = uniqueBy(productLinks, (x) => x.href);

  for (const link of dedupedLinks) {
    const { brand, model } = inferBrandAndModel(link.text);
    if (!brand || !model) continue;

    rows.push({
      schemaVersion: SCHEMA_VERSION,
      brand,
      model,
      price: null,
      salePrice: null,
      score: null,
      reviewCount: null,
      ratingValue: null,
      weightOz: null,
      weightText: null,
      heelStackHeightMm: null,
      forefootStackHeightMm: null,
      stackHeightMm: null,
      heelToToeDropMm: null,
      heelDrop: null,
      shoeSupportType: null,
      shoeDesignType: null,
      plateType: null,
      toeBox: null,
      surface: null,
      cushioning: null,
      releaseDate: null,
      discontinued: false,
      notes: null,
      source: SOURCE,
      sourceUrl: link.href,
      listingName: link.text,
      store: null,
      originalPrice: null,
      discountPercent: null,
    });
  }

  // Now enrich sequentially from the rendered card order blocks for visible score/price/discount.
  // This part is heuristic but fast.
  const lines = html
    .replace(/>\s+</g, ">\n<")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const byName = new Map(rows.map((r) => [r.listingName.toLowerCase(), r]));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = cleanText(line);
    if (!text) continue;

    const row = byName.get(text.toLowerCase());
    if (!row) continue;

    // inspect nearby lines
    const windowText = lines.slice(i, i + 30).map(cleanText).join(" | ");

    const scoreMatch = windowText.match(/\b(\d{2})\b/);
    if (scoreMatch && row.score == null) row.score = Number(scoreMatch[1]);

    const priceMatch = windowText.match(/\$([0-9.,]+)\s+\$([0-9.,]+)/);
    if (priceMatch) {
      row.originalPrice = parseNumberLoose(priceMatch[1]);
      row.salePrice = parseNumberLoose(priceMatch[2]);
      row.price = row.originalPrice;
    }

    const discountMatch = windowText.match(/Save\s+(\d+)%/i);
    if (discountMatch) row.discountPercent = Number(discountMatch[1]);

    const storeMatch = windowText.match(/See on ([A-Za-z0-9 '&.-]+)/i);
    if (storeMatch) row.store = cleanText(storeMatch[1]);
  }

  return rows;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function scrapeCatalogPage(page) {
  const url = `${CATALOG_URL}${page}`;
  const html = await fetchText(url);

  const cards = extractCardsFromLiveHtml(html);

  return {
    page,
    url,
    cards,
    reviewedCount: extractReviewedCount(html),
    pageCount: extractPageCount(html),
  };
}

export default async function handler(req, res) {
  const start = Date.now();

  try {
    // Fetch page 1 first so we know true page count
    const first = await scrapeCatalogPage(1);
    const discoveredPages = Math.min(first.pageCount || 1, MAX_PAGES);

    const remainingPages = [];
    for (let p = 2; p <= discoveredPages; p++) remainingPages.push(p);

    const rest = await mapWithConcurrency(remainingPages, CONCURRENCY, async (page) => {
      const result = await scrapeCatalogPage(page);
      await sleep(100);
      return result;
    });

    const allPages = [first, ...rest].filter(Boolean);

    const allRows = allPages.flatMap((p) => p.cards || []);
    const uniqueRows = uniqueBy(
      allRows.filter((r) => r.brand && r.model && r.sourceUrl),
      (r) => `${r.brand.toLowerCase()}|${r.model.toLowerCase()}|${r.sourceUrl.toLowerCase()}`
    );

    const payload = {
      source: SOURCE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: new Date().toISOString(),
      pagesFetched: allPages.length,
      catalogPagesDiscovered: first.pageCount || discoveredPages,
      catalogPagesScraped: discoveredPages,
      reviewedCount: first.reviewedCount,
      shoesExtracted: uniqueRows.length,
      scrapeDurationMs: Date.now() - start,
      ok: true,
      error: null,
      pageNotes: allPages.map((p) => ({
        page: p.page,
        url: p.url,
        cards: (p.cards || []).length,
      })),
      shoes: uniqueRows,
    };

    const blob = await put("shoe-database.json", JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    return res.status(200).json({
      ok: true,
      pagesFetched: allPages.length,
      reviewedCount: first.reviewedCount,
      shoesExtracted: uniqueRows.length,
      blobUrl: blob.url,
      elapsedMs: Date.now() - start,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      elapsedMs: Date.now() - start,
    });
  }
}
