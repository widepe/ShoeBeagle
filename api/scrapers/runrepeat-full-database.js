// /api/scrapers/runrepeat-full-database.js
//
// RunRepeat full shoe database scraper
// - Pass 1: scrape catalog pages to collect all shoe URLs + catalog info
// - Pass 2: scrape each shoe page for deeper specs
// - Uploads to Vercel Blob as shoe-database.json
//
// ENV:
// - BLOB_READ_WRITE_TOKEN
//
// OPTIONAL:
// - RUNREPEAT_MAX_PAGES=24
// - RUNREPEAT_CONCURRENCY=5
//
// Notes:
// - Uses built-in fetch (Node 18+)
// - No Selenium / no browser
// - Conservative concurrency to avoid hammering RunRepeat
// - Returns null for fields it cannot confidently extract

import { put } from "@vercel/blob";

export const config = { maxDuration: 300 };

const SOURCE = "RunRepeat";
const SCHEMA_VERSION = 1;
const BASE_URL = "https://runrepeat.com";
const CATALOG_URL = "https://runrepeat.com/catalog/running-shoes?page=";

const MAX_PAGES = Math.max(1, Math.min(24, Number(process.env.RUNREPEAT_MAX_PAGES || 24)));
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.RUNREPEAT_CONCURRENCY || 5)));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, timeoutMs = 25000) {
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

    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function stripHtml(html) {
  return normalizeWhitespace(String(html || "").replace(/<[^>]*>/g, " "));
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
  return normalizeWhitespace(stripHtml(htmlDecode(s)));
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

function parseMoney(value) {
  const n = parseNumberLoose(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseMm(value) {
  const n = parseNumberLoose(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseOz(value) {
  const n = parseNumberLoose(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseReviewCount(value) {
  const n = parseNumberLoose(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractFirst(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return cleanText(m[1]);
  }
  return "";
}

function extractAllMatches(html, regex) {
  const out = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function extractJsonLdObjects(html) {
  const blocks = extractAllMatches(
    html,
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  const out = [];
  for (const raw of blocks) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      // ignore bad blocks
    }
  }
  return out;
}

function findProductJsonLd(objects) {
  const flat = [];

  function walk(node) {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    flat.push(node);

    if (Array.isArray(node["@graph"])) {
      for (const item of node["@graph"]) walk(item);
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") walk(value);
    }
  }

  for (const obj of objects || []) walk(obj);

  return (
    flat.find((x) => {
      const t = x?.["@type"];
      if (Array.isArray(t)) return t.includes("Product");
      return t === "Product";
    }) || null
  );
}

function inferBrandAndModel(name) {
  const title = normalizeWhitespace(name);
  if (!title) return { brand: null, model: null };

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

  const first = title.split(" ")[0] || "";
  return {
    brand: first || null,
    model: title.slice(first.length).trim() || null,
  };
}

function normalizeSupportType(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (t.includes("motion control")) return "motion control";
  if (t.includes("stability")) return "stability";
  if (t.includes("neutral")) return "neutral";
  if (t.includes("minimal")) return "minimal";
  if (t.includes("supportive")) return "stability";
  return null;
}

function normalizeDesignType(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;

  if (t.includes("carbon") && t.includes("race")) return "carbon racing shoe";
  if (t.includes("racing")) return "racing shoe";
  if (t.includes("race")) return "racing shoe";
  if (t.includes("recovery")) return "recovery shoe";
  if (t.includes("super trainer")) return "super trainer";
  if (t.includes("tempo")) return "tempo trainer";
  if (t.includes("daily")) return "daily trainer";
  if (t.includes("easy miles")) return "daily trainer";
  if (t.includes("max cushion")) return "max cushion trainer";
  if (t.includes("trail")) return "trail shoe";
  return null;
}

function normalizePlateType(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (t.includes("carbon")) return "carbon plate";
  if (t.includes("nylon")) return "nylon plate";
  if (t.includes("pebax")) return "pebax plate";
  if (t.includes("tpu")) return "tpu plate";
  if (t.includes("plate")) return "plated";
  return "none";
}

function normalizeToeBox(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (t.includes("extra wide")) return "extra wide";
  if (t.includes("roomy")) return "roomy";
  if (t.includes("wide toe box")) return "wide";
  if (t.includes("wide")) return "wide";
  if (t.includes("narrow") || t.includes("snug")) return "narrow";
  if (t.includes("standard") || t.includes("regular") || t.includes("normal")) return "standard";
  return null;
}

function normalizeSurface(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (t.includes("trail")) return "trail";
  if (t.includes("road")) return "road";
  if (t.includes("track")) return "track";
  if (t.includes("treadmill")) return "treadmill";
  return null;
}

function normalizeCushioning(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (t.includes("max")) return "max";
  if (t.includes("high-cushion")) return "high";
  if (t.includes("high cushion")) return "high";
  if (t.includes("plush")) return "high";
  if (t.includes("moderate")) return "medium";
  if (t.includes("medium")) return "medium";
  if (t.includes("firm")) return "low";
  if (t.includes("low")) return "low";
  return null;
}

function buildNotes(parts) {
  const arr = uniqueBy(
    (parts || [])
      .map((x) => cleanText(x))
      .filter(Boolean)
      .filter((x) => x.length >= 4),
    (x) => x.toLowerCase()
  );
  return arr.length ? arr.join(" | ") : null;
}

function extractPageCount(html) {
  const nums = [...html.matchAll(/>\s*(\d+)\s*<\/a>/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) : 1;
}

function extractReviewedCount(html) {
  const m = html.match(/(\d+)\s+shoes reviewed/i);
  return m ? Number(m[1]) : null;
}

function extractCatalogCards(html) {
  // Find likely product links in the catalog
  const links = [...html.matchAll(/<a[^>]+href="(\/[^"#?]+)"[^>]*>([^<]+)<\/a>/gi)]
    .map((m) => ({
      href: absoluteUrl(m[1]),
      text: cleanText(m[2]),
    }))
    .filter((x) => x.href.startsWith(`${BASE_URL}/`))
    .filter((x) => !x.href.includes("/catalog/"))
    .filter((x) => !x.href.includes("/guides/"))
    .filter((x) => x.text && x.text.length > 2);

  const deduped = uniqueBy(links, (x) => x.href);
  const rows = [];

  for (const link of deduped) {
    const { brand, model } = inferBrandAndModel(link.text);
    if (!brand || !model) continue;

    rows.push({
      listingName: link.text,
      brand,
      model,
      sourceUrl: link.href,
      source: SOURCE,
      score: null,
      price: null,
      salePrice: null,
      discountPercent: null,
      store: null,
    });
  }

  // Heuristic local enrichment from nearby catalog text
  const lines = html
    .replace(/>\s+</g, ">\n<")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const byName = new Map(rows.map((r) => [r.listingName.toLowerCase(), r]));

  for (let i = 0; i < lines.length; i++) {
    const text = cleanText(lines[i]);
    if (!text) continue;

    const row = byName.get(text.toLowerCase());
    if (!row) continue;

    const windowText = lines.slice(i, i + 30).map(cleanText).join(" | ");

    const scoreMatch = windowText.match(/\b(\d{2})\b/);
    if (scoreMatch) row.score = Number(scoreMatch[1]);

    const priceMatch = windowText.match(/\$([0-9.,]+)\s+\$([0-9.,]+)/);
    if (priceMatch) {
      row.price = parseMoney(priceMatch[1]);
      row.salePrice = parseMoney(priceMatch[2]);
    } else {
      const singlePrice = windowText.match(/\$([0-9.,]+)/);
      if (singlePrice) row.price = parseMoney(singlePrice[1]);
    }

    const discountMatch = windowText.match(/Save\s+(\d+)%/i);
    if (discountMatch) row.discountPercent = Number(discountMatch[1]);

    const storeMatch = windowText.match(/See on ([A-Za-z0-9 '&.-]+)/i);
    if (storeMatch) row.store = cleanText(storeMatch[1]);
  }

  return rows;
}

function extractFactValue(html, slug) {
  const patterns = [
    new RegExp(`fact-item_${slug}[\\s\\S]*?<div[^>]*>([^<]+)</div>[\\s\\S]*?<div[^>]*>([^<]+)</div>`, "i"),
    new RegExp(`fact-item_${slug}[\\s\\S]*?<div[^>]*>([^<]+)</div>`, "i"),
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const vals = m.slice(1).filter(Boolean).map(cleanText).filter(Boolean);
      if (vals.length) return vals[vals.length - 1];
    }
  }

  return "";
}

function parseProductPage(html, catalogRow) {
  const jsonLd = extractJsonLdObjects(html);
  const product = findProductJsonLd(jsonLd);

  const listingName =
    cleanText(product?.name) ||
    extractFirst(html, [
      /<h1[^>]*class="[^"]*main-shoe-title[^"]*"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i,
      /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
      /<title>([^<]+)<\/title>/i,
    ]) ||
    catalogRow?.listingName ||
    "";

  const inferred = inferBrandAndModel(listingName);

  const brand =
    cleanText(product?.brand?.name || product?.brand) ||
    extractFirst(html, [/aggregate_rating_wrapper[\s\S]*?<img[^>]+alt="([^"]+)"/i]) ||
    catalogRow?.brand ||
    inferred.brand;

  const model =
    inferred.model ||
    catalogRow?.model ||
    null;

  const offers = Array.isArray(product?.offers) ? product.offers[0] : product?.offers || null;

  const price =
    parseMoney(offers?.price) ||
    catalogRow?.price ||
    parseMoney(
      extractFirst(html, [
        /fact-item_price[\s\S]*?\$([0-9.,]+)/i,
      ])
    );

  const score =
    parseNumberLoose(
      extractFirst(html, [/runscore-value[^>]*>([^<]+)</i])
    ) || catalogRow?.score || null;

  const reviewCount =
    parseReviewCount(product?.aggregateRating?.reviewCount) ||
    parseReviewCount(
      extractFirst(html, [/stars-container[\s\S]*?<a[^>]*>([^<]+)</i])
    );

  const ratingValue = parseNumberLoose(product?.aggregateRating?.ratingValue) || null;

  const weightText =
    extractFactValue(html, "weight") ||
    extractFirst(html, [/weight[\s\S]{0,120}?([0-9.]+\s*oz)/i]);

  const dropText =
    extractFactValue(html, "heel-to-toe-drop") ||
    extractFirst(html, [/heel[\s-]*to[\s-]*toe[\s-]*drop[\s\S]{0,120}?([0-9.]+\s*mm)/i]);

  const forefootText =
    extractFactValue(html, "forefoot-height") ||
    extractFirst(html, [/forefoot[\s-]*height[\s\S]{0,120}?([0-9.]+\s*mm)/i]);

  const heelText =
    extractFactValue(html, "heel-height") ||
    extractFirst(html, [/heel[\s-]*height[\s\S]{0,120}?([0-9.]+\s*mm)/i]);

  const supportText =
    extractFactValue(html, "arch-support") ||
    extractFactValue(html, "support") ||
    "";

  const useText =
    extractFactValue(html, "use") ||
    extractFirst(html, [/best suited[\s\S]{0,160}?([^.]+)\./i]) ||
    extractFirst(html, [/best for[\s\S]{0,160}?([^.]+)\./i]);

  const terrainText =
    extractFactValue(html, "terrain") ||
    "";

  const releaseDate =
    extractFactValue(html, "release-date") ||
    extractFirst(html, [/release[\s-]*date[\s\S]{0,100}?([A-Za-z0-9 ,]+)/i]) ||
    null;

  const discontinued =
    /fact-item_discontinued/i.test(html) ||
    /discontinued/i.test(extractFactValue(html, "discontinued"));

  const summary =
    extractFirst(html, [
      /id="bottom_line"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i,
    ]) || "";

  const goodBullets = extractAllMatches(html, /id="the_good"[\s\S]*?<li[^>]*>([\s\S]*?)<\/li>/gi).map(cleanText);
  const badBullets = extractAllMatches(html, /id="the_bad"[\s\S]*?<li[^>]*>([\s\S]*?)<\/li>/gi).map(cleanText);

  const supportNorm = normalizeSupportType(`${supportText} ${summary}`);
  const designNorm = normalizeDesignType(`${useText} ${terrainText} ${summary}`);
  const plateNorm = normalizePlateType(`${summary} ${goodBullets.join(" ")}`);
  const toeBoxNorm = normalizeToeBox(`${summary} ${goodBullets.join(" ")} ${badBullets.join(" ")}`);
  const surfaceNorm = normalizeSurface(`${terrainText} ${useText} ${summary}`);
  const cushioningNorm = normalizeCushioning(`${summary} ${goodBullets.join(" ")}`);

  return {
    schemaVersion: SCHEMA_VERSION,

    listingName: listingName || null,
    brand: brand || null,
    model: model || null,

    price: price ?? null,
    salePrice: catalogRow?.salePrice ?? null,

    score: Number.isFinite(score) ? Math.round(score) : null,
    reviewCount,
    ratingValue,

    weightOz: parseOz(weightText),
    weightText: weightText || null,

    heelStackHeightMm: parseMm(heelText),
    forefootStackHeightMm: parseMm(forefootText),
    stackHeightMm:
      Number.isFinite(parseMm(heelText)) && Number.isFinite(parseMm(forefootText))
        ? `${parseMm(heelText)}/${parseMm(forefootText)}`
        : null,

    heelToToeDropMm: parseMm(dropText),
    heelDrop: parseMm(dropText),

    shoeSupportType: supportNorm,
    shoeDesignType: designNorm,
    plateType: plateNorm,
    toeBox: toeBoxNorm,

    surface: surfaceNorm,
    cushioning: cushioningNorm,

    releaseDate,
    discontinued: !!discontinued,

    notes: buildNotes([
      useText,
      terrainText,
      summary,
      ...goodBullets.slice(0, 2),
      ...badBullets.slice(0, 1),
    ]),

    discountPercent: catalogRow?.discountPercent ?? null,
    store: catalogRow?.store ?? null,

    source: SOURCE,
    sourceUrl: catalogRow?.sourceUrl || null,
  };
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

  return {
    page,
    url,
    cards: extractCatalogCards(html),
    reviewedCount: extractReviewedCount(html),
    pageCount: extractPageCount(html),
  };
}

async function scrapeProductRow(row) {
  try {
    const html = await fetchText(row.sourceUrl);
    const parsed = parseProductPage(html, row);
    await sleep(120);
    return { ok: true, row: parsed, error: null };
  } catch (err) {
    return {
      ok: false,
      row: {
        schemaVersion: SCHEMA_VERSION,
        listingName: row.listingName || null,
        brand: row.brand || null,
        model: row.model || null,
        price: row.price ?? null,
        salePrice: row.salePrice ?? null,
        score: row.score ?? null,
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
        discountPercent: row.discountPercent ?? null,
        store: row.store ?? null,
        source: SOURCE,
        sourceUrl: row.sourceUrl || null,
      },
      error: err?.message || String(err),
    };
  }
}

function isGoodRecord(r) {
  return !!(r && r.brand && r.model && r.sourceUrl);
}

export default async function handler(req, res) {
  const start = Date.now();

  try {
    // Pass 1: catalog
    const first = await scrapeCatalogPage(1);
    const discoveredPages = Math.min(first.pageCount || 1, MAX_PAGES);

    const pageNums = [];
    for (let p = 2; p <= discoveredPages; p++) pageNums.push(p);

    const rest = await mapWithConcurrency(pageNums, CONCURRENCY, async (page) => {
      const pageData = await scrapeCatalogPage(page);
      await sleep(100);
      return pageData;
    });

    const allPages = [first, ...rest].filter(Boolean);
    const catalogRows = uniqueBy(
      allPages.flatMap((p) => p.cards || []),
      (r) => String(r.sourceUrl || "").toLowerCase()
    );

    // Pass 2: product pages
    const enrichedResults = await mapWithConcurrency(catalogRows, CONCURRENCY, async (row) => {
      return await scrapeProductRow(row);
    });

    const shoes = uniqueBy(
      enrichedResults
        .map((x) => x.row)
        .filter(isGoodRecord),
      (r) => `${r.brand.toLowerCase()}|${r.model.toLowerCase()}|${r.sourceUrl.toLowerCase()}`
    );

    const failures = enrichedResults
      .map((x, i) => ({ x, i }))
      .filter(({ x }) => !x.ok && x.error)
      .map(({ x, i }) => ({
        url: catalogRows[i]?.sourceUrl || null,
        error: x.error,
      }))
      .slice(0, 100);

    const payload = {
      source: SOURCE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: new Date().toISOString(),

      pagesFetched: allPages.length,
      catalogPagesDiscovered: first.pageCount || discoveredPages,
      catalogPagesScraped: discoveredPages,
      reviewedCount: first.reviewedCount,

      shoeUrlsFound: catalogRows.length,
      shoesExtracted: shoes.length,

      concurrency: CONCURRENCY,
      scrapeDurationMs: Date.now() - start,
      ok: true,
      error: null,

      pageNotes: allPages.map((p) => ({
        page: p.page,
        url: p.url,
        cards: (p.cards || []).length,
      })),

      failures,
      shoes,
    };

    const blob = await put("shoe-database.json", JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    return res.status(200).json({
      ok: true,
      source: SOURCE,
      pagesFetched: allPages.length,
      reviewedCount: first.reviewedCount,
      shoeUrlsFound: catalogRows.length,
      shoesExtracted: shoes.length,
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
