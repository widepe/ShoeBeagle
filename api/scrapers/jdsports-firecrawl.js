// /api/scrapers/jdsports-firecrawl.js
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
  return null;
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
function deriveBrandModel(listingName) {
  let s = cleanText(listingName);
  s = s.replace(/^(Women's|Men's|Unisex)\s+/i, "");
  s = s.replace(/\s+Running\s+Shoes\s*$/i, "");
  s = s.replace(/\s+(Trail|Road)\s+Running\s+Shoes\s*$/i, "");
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

  const parts = s.split(" ");
  const brand = parts[0] ? cleanText(parts[0]) : "unknown";
  const model = parts.length > 1 ? cleanText(parts.slice(1).join(" ")) : "unknown";
  return { brand, model };
}

async function firecrawlScrapeHtml(url) {
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY");

  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ url, formats: ["html"] }),
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = json?.error || json?.message || `Firecrawl HTTP ${resp.status}`;
    throw new Error(`Firecrawl failed: ${msg}`);
  }
  const html = json?.data?.html || "";
  if (!html) throw new Error("Firecrawl returned empty html");
  return html;
}

function parseDealsFromHtml(html) {
  if (html.includes("Your Access Has Been Denied")) {
    return { blocked: true, dealsFound: 0, deals: [] };
  }

  const $ = cheerio.load(html);
  const tiles = $('div[data-testid="product-item"]');
  const dealsFound = tiles.length;

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

    const imageURL = node.find("img").first().attr("src") || "";

    const listingName = cleanText(
      node.find("h4.text-default-primary").first().text() ||
        node.find("h4").first().text() ||
        ""
    );

    const gender = inferGender(listingName);
    if (!gender) return;

    if (!mustBeRunningShoes(listingName)) return;

    const shoeType = inferShoeType(listingName);

    const saleText = cleanText(node.find("h4.text-default-onSale").first().text() || "");
    const originalText = cleanText(node.find("p.line-through").first().text() || "");

    const salePrice = parseMoney(saleText);
    const originalPrice = parseMoney(originalText);

    // drop $0/missing/invalid
    if (!(Number.isFinite(salePrice) && salePrice > 0)) return;
    if (!(Number.isFinite(originalPrice) && originalPrice > 0)) return;
    if (!(originalPrice > salePrice)) return;
    if (!listingURL) return;

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
    addRandomSuffix: false, // keep exactly key name
  });

  return result?.url || null;
}

export default async function handler(req, res) {
  const startUrl =
    String(req.query?.url || "").trim() ||
    "https://www.jdsports.com/plp/all-sale/category=shoes+activity=running";

  const configuredBlobUrl = String(process.env.JDSPORTS_DEALS_BLOB_URL || "").trim() || null;

  const t0 = Date.now();

  try {
    const html = await firecrawlScrapeHtml(startUrl);
    const parsed = parseDealsFromHtml(html);

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
      };
    }

    const blobUrl = await writeBlobJson("jdsports.json", output);

    // Include these in the response so you can copy/paste into env var once
    output.blobUrl = blobUrl;
    output.configuredBlobUrl = configuredBlobUrl;

    return res.status(200).json(output);
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
      blobUrl: null,
      configuredBlobUrl,
    };

    try {
      output.blobUrl = await writeBlobJson("jdsports.json", output);
    } catch {}

    return res.status(500).json(output);
  }
}
