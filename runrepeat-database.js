// /api/scrapers/runrepeat-database.js
//
// RunRepeat shoe database scraper
// - Scrapes ranking pages to collect shoe URLs
// - Scrapes individual shoe pages concurrently
// - Extracts a normalized shoe-spec schema
// - Uploads result to Vercel Blob as shoe-database.json
//
// ENV:
// - BLOB_READ_WRITE_TOKEN
//
// OPTIONAL:
// - RUNREPEAT_START_PAGE
// - RUNREPEAT_END_PAGE
// - RUNREPEAT_CONCURRENCY
//
// Notes:
// - This uses built-in fetch (Node 18+)
// - No Selenium / no browser / no chromedriver
// - HTML patterns may need adjustment if RunRepeat changes markup

import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const SOURCE = "RunRepeat";
const BASE_URL = "https://runrepeat.com";
const RANKING_BASE =
  "https://runrepeat.com/ranking/rankings-of-running-shoes?gender=women&page=";

const SCHEMA_VERSION = 1;
const START_PAGE = Math.max(1, Number(process.env.RUNREPEAT_START_PAGE || 1));
const END_PAGE = Math.max(START_PAGE, Number(process.env.RUNREPEAT_END_PAGE || 12));
const CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.RUNREPEAT_CONCURRENCY || 6)));

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

function uniqueStrings(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function extractAllMatches(html, regex) {
  const out = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    out.push(m[1]);
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

function extractJsonLdObjects(html) {
  const blocks = extractAllMatches(
    html,
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  const out = [];
  for (const raw of blocks) {
    const txt = raw.trim();
    if (!txt) continue;
    try {
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      // ignore invalid JSON-LD blocks
    }
  }
  return out;
}

function findProductJsonLd(objects) {
  const flat = [];

  function walk(node) {
    if (!node || typeof node !== "object") return;
    flat.push(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    if (Array.isArray(node["@graph"])) {
      for (const item of node["@graph"]) walk(item);
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") walk(value);
    }
  }

  for (const obj of objects) walk(obj);

  return (
    flat.find((x) => {
      const t = x?.["@type"];
      if (Array.isArray(t)) return t.includes("Product");
      return t === "Product";
    }) || null
  );
}

function parseNumberLoose(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const s = String(value).replace(/,/g, "");
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function parseMoney(value) {
  const n = parseNumberLoose(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseReviewCount(value) {
  const n = parseNumberLoose(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function parseMm(value) {
  const n = parseNumberLoose(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseOz(value) {
  const n = parseNumberLoose(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function inferBrandFromName(name) {
  const title = normalizeWhitespace(name);
  if (!title) return "";
  const first = title.split(" ")[0];
  return first || "";
}

function inferModelFromName(name, brand) {
  const title = normalizeWhitespace(name);
  const b = normalizeWhitespace(brand);
  if (!title) return "";
  if (b && title.toLowerCase().startsWith(b.toLowerCase() + " ")) {
    return title.slice(b.length).trim();
  }
  return title;
}

function normalizeSupportType(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (t.includes("motion control")) return "motion control";
  if (t.includes("stability")) return "stability";
  if (t.includes("neutral")) return "neutral";
  if (t.includes("minimal")) return "minimal";
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
  if (t.includes("max cushion")) return "max cushion trainer";
  if (t.includes("stability trainer")) return "stability trainer";
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
  if (t.includes("forked")) return "forked plate";
  if (t.includes("plate")) return "plated";
  return "none";
}

function normalizeToeBox(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (t.includes("extra wide")) return "extra wide";
  if (t.includes("roomy")) return "roomy";
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
  if (t.includes("high")) return "high";
  if (t.includes("medium")) return "medium";
  if (t.includes("low")) return "low";
  return null;
}

function buildNotes(parts) {
  const cleaned = uniqueStrings(
    parts
      .map((x) => cleanText(x))
      .filter(Boolean)
      .filter((x) => x.length >= 4)
  );
  if (!cleaned.length) return null;
  return cleaned.join(" | ");
}

function extractShoeLinksFromRanking(html) {
  const hrefs = extractAllMatches(html, /<a[^>]+href="([^"]+)"[^>]*>/gi)
    .map((u) => absoluteUrl(u))
    .filter((u) => u.startsWith(BASE_URL + "/"))
    .filter((u) => !u.includes("/ranking/"))
    .filter((u) => !u.includes("/compare"))
    .filter((u) => !u.includes("/best"))
    .filter((u) => !u.includes("/guides"))
    .filter((u) => !u.includes("/news"));

  const likelyProducts = hrefs.filter((u) => {
    const path = u.replace(BASE_URL, "");
    const segments = path.split("/").filter(Boolean);
    return segments.length === 1 && !segments[0].includes("?");
  });

  return uniqueStrings(likelyProducts);
}

function extractFactValue(html, factSlug) {
  const patterns = [
    new RegExp(`fact-item_${factSlug}[\\s\\S]*?<div[^>]*>([^<]+)</div>[\\s\\S]*?<div[^>]*>([^<]+)</div>`, "i"),
    new RegExp(`fact-item_${factSlug}[\\s\\S]*?<div[^>]*>([^<]+)</div>`, "i"),
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const candidates = m.slice(1).filter(Boolean).map(cleanText).filter(Boolean);
      if (candidates.length) return candidates[candidates.length - 1];
    }
  }

  return "";
}

function parseRunRepeatPage(html, url) {
  const jsonLdObjects = extractJsonLdObjects(html);
  const product = findProductJsonLd(jsonLdObjects);

  const name =
    cleanText(product?.name) ||
    extractFirst(html, [
      /<h1[^>]*class="[^"]*main-shoe-title[^"]*"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i,
      /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
      /<title>([^<]+)<\/title>/i,
    ]);

  const brand =
    cleanText(product?.brand?.name || product?.brand) ||
    extractFirst(html, [
      /aggregate_rating_wrapper[\s\S]*?<img[^>]+alt="([^"]+)"/i,
    ]) ||
    inferBrandFromName(name);

  const model = inferModelFromName(name, brand);

  const offers = Array.isArray(product?.offers) ? product.offers[0] : product?.offers || null;
  const price =
    parseMoney(offers?.price) ||
    parseMoney(
      extractFirst(html, [
        /fact-item_price[\s\S]*?\$([0-9.,]+)/i,
      ])
    );

  const score =
    parseNumberLoose(
      extractFirst(html, [
        /runscore-value[^>]*>([^<]+)</i,
      ])
    ) || null;

  const reviewCount =
    parseReviewCount(product?.aggregateRating?.reviewCount) ||
    parseReviewCount(
      extractFirst(html, [
        /stars-container[\s\S]*?<a[^>]*>([^<]+)</i,
      ])
    );

  const ratingValue =
    parseNumberLoose(product?.aggregateRating?.ratingValue) || null;

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
    extractFirst(html, [
      /Best for[\s\S]{0,150}?<[^>]+>([\s\S]*?)</i,
    ]);

  const terrainText =
    extractFactValue(html, "terrain") || "";

  const releaseDate =
    extractFactValue(html, "release-date") ||
    extractFirst(html, [/release[\s-]*date[\s\S]{0,100}?([A-Za-z0-9 ,]+)/i]) ||
    null;

  const discontinued =
    /fact-item_discontinued/i.test(html) || /discontinued/i.test(extractFactValue(html, "discontinued"));

  const goodBullets = extractAllMatches(html, /id="the_good"[\s\S]*?<li[^>]*>([\s\S]*?)<\/li>/gi).map(cleanText);
  const badBullets = extractAllMatches(html, /id="the_bad"[\s\S]*?<li[^>]*>([\s\S]*?)<\/li>/gi).map(cleanText);
  const summaryBottom = extractFirst(html, [
    /id="bottom_line"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i,
  ]);

  const supportNorm = normalizeSupportType(supportText);
  const designNorm = normalizeDesignType(`${useText} ${terrainText}`);
  const surfaceNorm = normalizeSurface(terrainText || useText);
  const plateNorm = normalizePlateType(`${useText} ${summaryBottom} ${goodBullets.join(" ")}`);
  const toeBoxNorm = normalizeToeBox(`${summaryBottom} ${goodBullets.join(" ")} ${badBullets.join(" ")}`);
  const cushioningNorm = normalizeCushioning(`${summaryBottom} ${goodBullets.join(" ")} ${useText}`);

  const heelStack = parseMm(heelText);
  const forefootStack = parseMm(forefootText);
  const heelToToeDrop = parseMm(dropText);
  const weightOz = parseOz(weightText);

  return {
    schemaVersion: SCHEMA_VERSION,

    brand: brand || null,
    model: model || null,

    price,
    salePrice: null,

    score: Number.isFinite(score) ? Math.round(score) : null,
    reviewCount,
    ratingValue,

    weightOz,
    weightText: weightText || null,

    heelStackHeightMm: heelStack,
    forefootStackHeightMm: forefootStack,
    stackHeightMm:
      Number.isFinite(heelStack) && Number.isFinite(forefootStack)
        ? `${heelStack}/${forefootStack}`
        : null,

    heelToToeDropMm: heelToToeDrop,
    heelDrop: heelToToeDrop, // compatibility alias if you want one

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
      summaryBottom,
      ...goodBullets.slice(0, 2),
      ...badBullets.slice(0, 1),
    ]),

    source: SOURCE,
    sourceUrl: url,
  };
}

function isGoodShoeRecord(row) {
  if (!row) return false;
  if (!row.brand || !row.model) return false;
  if (!row.sourceUrl) return false;
  return true;
}

function dedupeShoes(rows) {
  const seen = new Set();
  const out = [];

  for (const row of rows) {
    const key = `${String(row.brand || "").toLowerCase()}|${String(row.model || "").toLowerCase()}|${String(
      row.sourceUrl || ""
    ).toLowerCase()}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }

  return out;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) break;
      results[current] = await worker(items[current], current);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => runner());
  await Promise.all(runners);
  return results;
}

async function collectRankingUrls() {
  const urls = new Set();
  const pageNotes = [];

  for (let page = START_PAGE; page <= END_PAGE; page++) {
    const url = `${RANKING_BASE}${page}`;
    try {
      const html = await fetchText(url);
      const found = extractShoeLinksFromRanking(html);
      found.forEach((u) => urls.add(u));

      pageNotes.push({
        page,
        url,
        shoeLinksFound: found.length,
        cumulativeUnique: urls.size,
      });

      await sleep(300);
    } catch (err) {
      pageNotes.push({
        page,
        url,
        error: err?.message || String(err),
      });
    }
  }

  return {
    urls: [...urls],
    pageNotes,
  };
}

async function scrapeShoePage(url) {
  try {
    const html = await fetchText(url);
    const parsed = parseRunRepeatPage(html, url);
    return {
      ok: true,
      row: parsed,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      row: null,
      error: err?.message || String(err),
    };
  }
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    const ranking = await collectRankingUrls();
    const shoeUrls = ranking.urls;

    const pageResults = await mapWithConcurrency(shoeUrls, CONCURRENCY, async (url) => {
      const result = await scrapeShoePage(url);
      await sleep(150);
      return { url, ...result };
    });

    const rawRows = pageResults.filter((x) => x.ok && x.row).map((x) => x.row);
    const goodRows = rawRows.filter(isGoodShoeRecord);
    const shoes = dedupeShoes(goodRows);

    const failures = pageResults
      .filter((x) => !x.ok)
      .map((x) => ({
        url: x.url,
        error: x.error,
      }))
      .slice(0, 50);

    const payload = {
      source: SOURCE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: new Date().toISOString(),

      startPage: START_PAGE,
      endPage: END_PAGE,
      concurrency: CONCURRENCY,

      pagesFetched: ranking.pageNotes.length,
      shoeUrlsFound: shoeUrls.length,
      shoesParsed: rawRows.length,
      shoesExtracted: shoes.length,
      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      pageNotes: ranking.pageNotes,
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
      pagesFetched: ranking.pageNotes.length,
      shoeUrlsFound: shoeUrls.length,
      shoesExtracted: shoes.length,
      blobUrl: blob.url,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      elapsedMs: Date.now() - startedAt,
    });
  }
}
