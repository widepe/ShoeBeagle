// /api/scrapers/jdsports-firecrawl.js
//
// ✅ Scrapes 1 JD Sports sale running page via Firecrawl (RAW/HTML)
// ✅ Applies your rules
// ✅ Writes FULL top-level JSON + deals[] to Vercel Blob key: jdsports.json
// ✅ Returns LIGHTWEIGHT response (no deals array) + blobUrl
// ✅ Includes dropCounts + dropReasons[] in the BLOB (and in the lightweight response)
//
// ENV required:
// - FIRECRAWL_API_KEY
// - BLOB_READ_WRITE_TOKEN
//
// Optional:
// - JDSPORTS_DEALS_BLOB_URL (for your merge system / debugging)
// - CRON_SECRET (if you enable cron auth)

import { put } from "@vercel/blob";
import * as cheerio from "cheerio";

function nowIso() {
  return new Date().toISOString();
}
function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function parseMoney(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  const m = t.replace(/[^0-9.]/g, "");
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}
function roundInt(n) {
  return Number.isFinite(n) ? Math.round(n) : null;
}

function inferGender(listingName) {
  const n = listingName.toLowerCase();
  if (n.startsWith("women's ")) return "womens";
  if (n.startsWith("men's ")) return "mens";
  if (n.startsWith("unisex ")) return "unisex";
  return null; // drop
}
function mustBeRunningShoes(listingName) {
  return listingName.toLowerCase().includes("running shoes");
}
function inferShoeType(listingName) {
  const n = listingName.toLowerCase();
  if (n.includes("trail running")) return "trail";
  if (n.includes("road running")) return "road";
  return "unknown";
}

// IMPORTANT: Never edit listingName; only derive brand/model.
function deriveBrandModel(listingName) {
  let s = cleanText(listingName);

  // Remove gender prefix
  s = s.replace(/^(Women's|Men's|Unisex)\s+/i, "");

  // Remove trailing running shoes phrases
  s = s.replace(/\s+(Trail|Road)\s+Running\s+Shoes\s*$/i, "");
  s = s.replace(/\s+Running\s+Shoes\s*$/i, "");
  s = cleanText(s);

  if (!s) return { brand: "unknown", model: "unknown" };

  // multi-word brand fix
  const multiWordBrands = ["New Balance"];
  for (const b of multiWordBrands) {
    const bl = b.toLowerCase();
    const sl = s.toLowerCase();
    if (sl === bl) return { brand: b, model: "unknown" };
    if (sl.startsWith(bl + " ")) {
      return { brand: b, model: cleanText(s.slice(b.length)) || "unknown" };
    }
  }

  // default: first token is brand
  const parts = s.split(" ");
  const brand = parts[0] ? cleanText(parts[0]) : "unknown";
  const model = parts.length > 1 ? cleanText(parts.slice(1).join(" ")) : "unknown";
  return { brand, model };
}

// -----------------------------
// IMAGE URL EXTRACTION (robust)
// -----------------------------
function decodeHtmlEntities(s) {
  return String(s || "").replace(/&amp;/g, "&").trim();
}
function pickFromSrcset(srcset) {
  const s = cleanText(srcset);
  if (!s) return "";
  const first = s.split(",")[0]?.trim() || "";
  return first.split(/\s+/)[0] || "";
}
function normalizeImgUrl(u) {
  let url = decodeHtmlEntities(u);
  if (!url) return "";
  if (url.startsWith("data:")) return "";
  if (url.startsWith("//")) url = "https:" + url;
  return url;
}

function extractImageURLFromDom(node, $) {
  const c = [];

  node.find("img").each((_, img) => {
    const el = $(img);
    c.push(el.attr("src") || "");
    c.push(el.attr("data-src") || "");
    c.push(pickFromSrcset(el.attr("srcset") || ""));
    c.push(pickFromSrcset(el.attr("data-srcset") || ""));
  });

  node.find("source").each((_, src) => {
    const el = $(src);
    c.push(pickFromSrcset(el.attr("srcset") || ""));
    c.push(pickFromSrcset(el.attr("data-srcset") || ""));
  });

  const urls = c.map(normalizeImgUrl).filter(Boolean);
  if (!urls.length) return "";

  return (
    urls.find((u) => u.includes("media.jdsports.com/")) ||
    urls.find((u) => u.includes("jdsports")) ||
    urls[0] ||
    ""
  );
}

function buildImageUrlFromSku(sku) {
  const s = String(sku || "").trim();
  if (!s) return "";
  return `https://media.jdsports.com/s/jdsports/${encodeURIComponent(s)}?$Main$?&w=660&h=660&fmt=auto`;
}

function deriveSkuFromListingURL(listingURL) {
  try {
    const u = new URL(listingURL);
    const parts = u.pathname.split("/").filter(Boolean);
    // Example:
    // /pdp/mens-on-cloudswift-4-running-shoes/prod2872829/3MF11003/002
    // parts = ["pdp","mens-on-cloudswift-4-running-shoes","prod2872829","3MF11003","002"]
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      const prev = parts[parts.length - 2];
      if (prev && last && /^[A-Za-z0-9]+$/.test(prev) && /^[A-Za-z0-9]+$/.test(last)) {
        return `${prev}_${last}`;
      }
    }
  } catch {}
  return "";
}

function extractImageURL(node, $, listingURL) {
  // 1) DOM extraction
  const fromDom = extractImageURLFromDom(node, $);
  if (fromDom) return fromDom;

  // 2) data-sku attribute (if Firecrawl kept it)
  const skuAttr = node.attr("data-sku") || node.find("[data-sku]").first().attr("data-sku") || "";
  if (skuAttr) {
    const url = buildImageUrlFromSku(skuAttr);
    if (url) return url;
  }

  // 3) derive SKU from listingURL path segments
  const derivedSku = deriveSkuFromListingURL(listingURL);
  const fromUrl = buildImageUrlFromSku(derivedSku);
  if (fromUrl) return fromUrl;

  return "";
}

// -----------------------------
// FIRECRAWL
// -----------------------------
async function firecrawlScrapeHtml(url) {
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY");

  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["html"],

      maxAge: 0,
      storeInCache: false,

      waitFor: 2000,
      removeBase64Images: true,

      timeout: 60000,
    }),
  });

  const json = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg = json?.error || json?.message || `Firecrawl HTTP ${resp.status}`;
    throw new Error(`Firecrawl failed: ${msg}`);
  }

  const html = json?.data?.rawHtml || json?.data?.html || "";
  if (!html) throw new Error("Firecrawl returned empty rawHtml/html");
  return html;
}

function makeDropTracker() {
  const counts = {
    totalTiles: 0,

    dropped_gender: 0,
    dropped_notRunningShoes: 0,
    dropped_missingUrl: 0,

    dropped_saleMissingOrZero: 0,
    dropped_originalMissingOrZero: 0,
    dropped_notADeal: 0,

    kept: 0,

    __debug_firstTile: null,
  };

  const bump = (key) => {
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
  };

  function toSummaryArray() {
    const rows = [
      { reason: "dropped_gender", count: counts.dropped_gender, note: "Name must start with Women's / Men's / Unisex" },
      { reason: "dropped_notRunningShoes", count: counts.dropped_notRunningShoes, note: "Name must include 'running shoes'" },
      { reason: "dropped_missingUrl", count: counts.dropped_missingUrl, note: "No PDP link found" },
      { reason: "dropped_saleMissingOrZero", count: counts.dropped_saleMissingOrZero, note: "Sale price missing/invalid/0" },
      { reason: "dropped_originalMissingOrZero", count: counts.dropped_originalMissingOrZero, note: "Original price missing/invalid/0" },
      { reason: "dropped_notADeal", count: counts.dropped_notADeal, note: "originalPrice must be > salePrice" },
      { reason: "kept", count: counts.kept, note: "Included in deals[]" },
    ];
    return rows.filter((r) => r.count > 0 || r.reason === "kept");
  }

  return { counts, bump, toSummaryArray };
}

function parseDealsFromHtml(html, drop) {
  if (html.includes("Your Access Has Been Denied")) {
    return { blocked: true, dealsFound: 0, deals: [] };
  }

  const $ = cheerio.load(html);
  const tiles = $('div[data-testid="product-item"]');

  drop.counts.totalTiles = tiles.length;

  // dealsFound = unique PDP URLs
  const hrefSet = new Set();
  tiles.each((_, el) => {
    const href = $(el).find('a[href*="/pdp/"]').first().attr("href") || "";
    if (!href) return;
    const abs = href.startsWith("http") ? href : `https://www.jdsports.com${href}`;
    hrefSet.add(abs);
  });
  const dealsFound = hrefSet.size;

  const deals = [];

  tiles.each((_, el) => {
    const node = $(el);

    const a = node.find('a[href*="/pdp/"]').first();
    const href = a.attr("href") || "";
    const listingURL = href
      ? href.startsWith("http")
        ? href
        : `https://www.jdsports.com${href}`
      : "";

    if (!listingURL) {
      drop.bump("dropped_missingUrl");
      return;
    }

    const listingName = cleanText(
      node.find("h4.text-default-primary").first().text() ||
        node.find("h4").first().text() ||
        ""
    );

    const gender = inferGender(listingName);
    if (!gender) {
      drop.bump("dropped_gender");
      return;
    }

    if (!mustBeRunningShoes(listingName)) {
      drop.bump("dropped_notRunningShoes");
      return;
    }

    const shoeType = inferShoeType(listingName);

    const saleText = cleanText(node.find("h4.text-default-onSale").first().text() || "");
    const originalText = cleanText(node.find("p.line-through").first().text() || "");

    const salePrice = parseMoney(saleText);
    const originalPrice = parseMoney(originalText);

    if (!(Number.isFinite(salePrice) && salePrice > 0)) {
      drop.bump("dropped_saleMissingOrZero");
      return;
    }
    if (!(Number.isFinite(originalPrice) && originalPrice > 0)) {
      drop.bump("dropped_originalMissingOrZero");
      return;
    }
    if (!(originalPrice > salePrice)) {
      drop.bump("dropped_notADeal");
      return;
    }

    const imageURL = extractImageURL(node, $, listingURL) || "";

    const discountPercent = roundInt(((originalPrice - salePrice) / originalPrice) * 100);
    const { brand, model } = deriveBrandModel(listingName);

    deals.push({
      schemaVersion: 1,
      listingName,
      brand,
      model,
      salePrice,
      originalPrice,
      discountPercent,
      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,
      store: "JD Sports",
      listingURL,
      imageURL,
      gender,
      shoeType,
    });

    drop.bump("kept");
  });

  return { blocked: false, dealsFound, deals };
}

async function writeBlobJson(key, obj) {
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
  if (!token) throw new Error("Missing BLOB_READ_WRITE_TOKEN");

  const result = await put(key, JSON.stringify(obj, null, 2), {
    access: "public",
    token,
    contentType: "application/json",
    addRandomSuffix: false, // keep exactly jdsports.json
  });

  return result?.url || null;
}

function toLightweightResponse(output) {
  return {
    store: output.store,
    schemaVersion: output.schemaVersion,
    lastUpdated: output.lastUpdated,
    via: output.via,
    sourceUrls: output.sourceUrls,
    pagesFetched: output.pagesFetched,
    dealsFound: output.dealsFound,
    dealsExtracted: output.dealsExtracted,
    scrapeDurationMs: output.scrapeDurationMs,
    ok: output.ok,
    error: output.error,

    dropCounts: output.dropCounts || null,
    dropReasons: output.dropReasons || null,

    blobUrl: output.blobUrl || null,
    configuredBlobUrl: output.configuredBlobUrl || null,
  };
}

export default async function handler(req, res) {
  // Avoid req.query (Vercel runtime uses deprecated url.parse() under the hood)
  const urlObj = new URL(req.url, "http://localhost");

  // -----------------------------
  // CRON SECRET (optional)
  // -----------------------------
  const isCron = String(urlObj.searchParams.get("cron") || "") === "1";
  if (isCron) {
    const expected = String(process.env.CRON_SECRET || "").trim();
    const got = String(urlObj.searchParams.get("secret") || req.headers["x-cron-secret"] || "").trim();
    if (!expected) return res.status(500).json({ ok: false, error: "Missing CRON_SECRET env var" });
    if (!got || got !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const startUrl =
    String(urlObj.searchParams.get("url") || "").trim() ||
    "https://www.jdsports.com/plp/all-sale/category=shoes+activity=running";

  const configuredBlobUrl = String(process.env.JDSPORTS_DEALS_BLOB_URL || "").trim() || null;

  const t0 = Date.now();

  try {
    const html = await firecrawlScrapeHtml(startUrl);

    const drop = makeDropTracker();
    const parsed = parseDealsFromHtml(html, drop);

    const scrapeDurationMs = Date.now() - t0;

    let output;
    if (parsed.blocked) {
      output = {
        store: "JD Sports",
        schemaVersion: 1,
        lastUpdated: nowIso(),
        via: "firecrawl",
        sourceUrls: [startUrl],
        pagesFetched: 1,
        dealsFound: 0,
        dealsExtracted: 0,
        scrapeDurationMs,
        ok: false,
        error: "Blocked: Your Access Has Been Denied",
        deals: [],
        dropCounts: { totalTiles: 0, kept: 0, __debug_firstTile: null },
        dropReasons: [{ reason: "blocked", count: 1, note: "JD Sports returned an access denied page" }],
      };
    } else {
      output = {
        store: "JD Sports",
        schemaVersion: 1,
        lastUpdated: nowIso(),
        via: "firecrawl",
        sourceUrls: [startUrl],
        pagesFetched: 1,
        dealsFound: parsed.dealsFound,
        dealsExtracted: parsed.deals.length,
        scrapeDurationMs,
        ok: true,
        error: null,
        deals: parsed.deals,
        dropCounts: drop.counts,
        dropReasons: drop.toSummaryArray(),
      };
    }

    output.blobUrl = await writeBlobJson("jdsports.json", output);
    output.configuredBlobUrl = configuredBlobUrl;

    return res.status(200).json(toLightweightResponse(output));
  } catch (err) {
    const scrapeDurationMs = Date.now() - t0;

    const output = {
      store: "JD Sports",
      schemaVersion: 1,
      lastUpdated: nowIso(),
      via: "firecrawl",
      sourceUrls: [startUrl],
      pagesFetched: 1,
      dealsFound: 0,
      dealsExtracted: 0,
      scrapeDurationMs,
      ok: false,
      error: String(err?.message || err),
      deals: [],
      dropCounts: null,
      dropReasons: null,
      blobUrl: null,
      configuredBlobUrl,
    };

    // Best-effort failure blob
    try {
      output.blobUrl = await writeBlobJson("jdsports.json", output);
    } catch {}

    return res.status(500).json(toLightweightResponse(output));
  }
}
