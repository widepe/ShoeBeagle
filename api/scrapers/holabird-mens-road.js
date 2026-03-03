// /api/scrapers/holabird-mens-road.js
// Scrapes Holabird Men's Road Running Shoe Deals using Shopify collection products.json (API-first)
// ✅ Canonical 11-field deals schema
// ✅ Top-level structure matches your Zappos-style metadata
// ✅ CRON secret auth is COMMENTED OUT for testing (per request)

const { put } = require("@vercel/blob");

/** -------------------- Helpers -------------------- **/

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function safeParseNumber(x) {
  const n = typeof x === "number" ? x : parseFloat(String(x || ""));
  return Number.isFinite(n) ? n : null;
}

function computeDiscountPercent(originalPrice, salePrice) {
  if (!Number.isFinite(originalPrice) || !Number.isFinite(salePrice)) return null;
  if (originalPrice <= 0 || salePrice <= 0) return null;
  if (salePrice >= originalPrice) return 0;
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

// Simple road/trail/track classifier (excludes trail/track when we want road)
function detectShoeTypeFromText(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(trail|mountain|off-road|hiking|gore-tex|gtx)\b/.test(t)) return "trail";
  if (/\b(track|spike|spikes|xc|cross[\s-]?country)\b/.test(t)) return "track";
  return "road";
}

function getBestImageUrl(product) {
  // Shopify product JSON usually has images[]
  if (product?.image?.src) return product.image.src;
  if (Array.isArray(product?.images) && product.images.length) {
    const first = product.images[0];
    if (typeof first === "string") return first;
    if (first?.src) return first.src;
  }
  if (product?.featured_image) return product.featured_image;
  return null;
}

// IMPORTANT (your Shoe Beagle rule): never edit listingName
// Here, listingName comes from Shopify product.title verbatim.
function buildDealFromProduct(product) {
  const title = String(product?.title || "").trim();
  if (!title) return null;

  const listingURL = product?.handle
    ? `https://www.holabirdsports.com/products/${product.handle}`
    : null;
  if (!listingURL) return null;

  const vendor = String(product?.vendor || "").trim();
  const brand = vendor || "Unknown";

  // Model: best-effort from title by removing leading brand/vendor token (common pattern)
  // If it doesn't match, we just keep full title as model fallback (still useful for search).
  let model = title;
  if (brand && brand !== "Unknown") {
    const re = new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i");
    model = model.replace(re, "");
  }
  model = model
    .replace(/\s+men'?s\b/i, "")
    .replace(/\s+women'?s\b/i, "")
    .replace(/\s+unisex\b/i, "")
    .replace(/\s+running\s+shoes?\b/i, "")
    .replace(/\s+running\s+shoe\b/i, "")
    .trim();

  // Prices: prefer compare_at_price if available, else (no true MSRP in products.json)
  // For honesty rule: require both sale AND original.
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (!variants.length) return null;

  // Choose the best variant:
  // - available first
  // - on-sale (price < compare_at_price) first
  // - lowest sale price (nice for deal lists)
  const scored = variants.map((v) => {
    const sale = safeParseNumber(v?.price);
    const compareAt = safeParseNumber(v?.compare_at_price);
    const available = v?.available === true || v?.available === 1 || v?.available === "1";

    const onSale =
      Number.isFinite(sale) &&
      Number.isFinite(compareAt) &&
      sale > 0 &&
      compareAt > 0 &&
      sale < compareAt;

    return { v, sale, compareAt, available, onSale };
  });

  scored.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.onSale !== b.onSale) return a.onSale ? -1 : 1;
    const as = a.sale ?? Number.POSITIVE_INFINITY;
    const bs = b.sale ?? Number.POSITIVE_INFINITY;
    return as - bs;
  });

  const best = scored[0] || {};
  let salePrice = round2(best.sale);
  let originalPrice = round2(best.compareAt);

  // Require sale
  if (!Number.isFinite(salePrice) || salePrice <= 0) return null;

  // Require original (honesty rule)
  if (!Number.isFinite(originalPrice) || originalPrice <= 0) return null;

  // Flip if swapped
  if (salePrice > originalPrice) [salePrice, originalPrice] = [originalPrice, salePrice];

  // Must be a true discount
  if (salePrice >= originalPrice) return null;

  const imageURL = getBestImageUrl(product);

  // Gender is constrained in the collection URL already, but we lock it to mens.
  const gender = "mens";

  // Ensure road shoes only (exclude trail/track)
  const tagText = Array.isArray(product?.tags) ? product.tags.join(" ") : String(product?.tags || "");
  const typeText = `${title} ${tagText} ${product?.product_type || ""} ${product?.vendor || ""}`;
  const shoeType = detectShoeTypeFromText(typeText);
  if (shoeType !== "road") return null;

  const discountPercent = computeDiscountPercent(originalPrice, salePrice);

  return {
    listingName: title,
    brand,
    model: model || title, // never blank unless title is blank
    salePrice,
    originalPrice,
    discountPercent,
    store: "Holabird Sports",
    listingURL,
    imageURL: imageURL || null,
    gender,
    shoeType,
  };
}

function dedupeByUrl(deals) {
  const seen = new Set();
  const out = [];
  for (const d of deals) {
    const key = d?.listingURL;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** -------------------- Shopify collection scrape -------------------- **/

const STORE = "Holabird Sports";
const VIA = "shopify-json";

// Your current collection (tag-constrained)
const SOURCE_COLLECTION_URL =
  "https://www.holabirdsports.com/collections/shoe-deals/Gender_Mens+Type_Running-Shoes+";

function buildProductsJsonUrl(page) {
  // Shopify supports /collections/<handle>/<tag constraints>/products.json
  const base = `${SOURCE_COLLECTION_URL}/products.json`;
  const u = new URL(base);
  u.searchParams.set("limit", "250");
  u.searchParams.set("page", String(page));
  return u.toString();
}

async function fetchProductsPage(page) {
  const url = buildProductsJsonUrl(page);
  const startedAt = Date.now();

  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const durationMs = Date.now() - startedAt;

    if (!res.ok) {
      return { ok: false, status: res.status, url, durationMs, json: null, error: `HTTP ${res.status}` };
    }

    const json = await res.json(); // { products: [...] }
    const products = Array.isArray(json?.products) ? json.products : [];
    return { ok: true, status: res.status, url, durationMs, json: { products }, error: null };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    return { ok: false, status: null, url, durationMs, json: null, error: e?.message || "Fetch error" };
  }
}

async function scrapeAllPages({ maxPages = 80, stopAfterEmptyPages = 2 }) {
  const pageNotes = [];
  const allProducts = [];

  let emptyStreak = 0;

  for (let page = 1; page <= maxPages; page++) {
    const r = await fetchProductsPage(page);

    const products = Array.isArray(r.json?.products) ? r.json.products : [];
    const count = products.length;

    pageNotes.push({
      page: `products.json page=${page}`,
      success: r.ok,
      count,
      error: r.error || null,
      url: r.url,
      duration: `${r.durationMs}ms`,
      status: r.status,
    });

    if (r.ok && count > 0) {
      allProducts.push(...products);
      emptyStreak = 0;
    } else {
      emptyStreak += 1;
    }

    if (emptyStreak >= stopAfterEmptyPages) break;
  }

  return {
    ok: true,
    sourceUrls: [SOURCE_COLLECTION_URL],
    pagesFetched: pageNotes.length,
    dealsFound: allProducts.length,
    pageNotes,
    products: allProducts,
  };
}

/** -------------------- Top-level builder -------------------- **/

function buildTopLevel({
  sourceUrls,
  pagesFetched,
  dealsFound,
  dealsExtracted,
  scrapeDurationMs,
  ok,
  error,
  pageNotes,
  deals,
}) {
  return {
    store: STORE,
    schemaVersion: 1,
    lastUpdated: new Date().toISOString(),
    via: VIA,
    sourceUrls,
    pagesFetched,
    dealsFound,
    dealsExtracted,
    scrapeDurationMs,
    ok: Boolean(ok),
    error: error || null,
    pageNotes: pageNotes || [],
    deals: deals || [],
  };
}

/** -------------------- Vercel handler -------------------- **/

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // ✅ COMMENTED OUT FOR TESTING (per request)
  /*
  const auth = String(req.headers.authorization || "").trim();
  const CRON_SECRET = String(process.env.CRON_SECRET || "").trim();
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const start = Date.now();

  try {
    const scraped = await scrapeAllPages({
      maxPages: 80,
      stopAfterEmptyPages: 2,
    });

    // Transform → canonical deals
    const rawDeals = [];
    for (const p of scraped.products) {
      const deal = buildDealFromProduct(p);
      if (deal) rawDeals.push(deal);
    }

    const deals = dedupeByUrl(rawDeals);

    const durationMs = Date.now() - start;

    const output = buildTopLevel({
      sourceUrls: [SOURCE_COLLECTION_URL, `${SOURCE_COLLECTION_URL}/products.json`],
      pagesFetched: scraped.pagesFetched,
      dealsFound: scraped.dealsFound,
      dealsExtracted: deals.length,
      scrapeDurationMs: durationMs,
      ok: true,
      error: null,
      pageNotes: scraped.pageNotes,
      deals,
    });

    const blob = await put("holabird-mens-road.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      ok: true,
      store: output.store,
      dealsExtracted: output.dealsExtracted,
      pagesFetched: output.pagesFetched,
      dealsFound: output.dealsFound,
      scrapeDurationMs: output.scrapeDurationMs,
      blobUrl: blob.url,
      lastUpdated: output.lastUpdated,
    });
  } catch (err) {
    const durationMs = Date.now() - start;

    const output = buildTopLevel({
      sourceUrls: [SOURCE_COLLECTION_URL],
      pagesFetched: 0,
      dealsFound: 0,
      dealsExtracted: 0,
      scrapeDurationMs: durationMs,
      ok: false,
      error: err?.message || String(err),
      pageNotes: [],
      deals: [],
    });

    await put("holabird-mens-road.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(500).json({ ok: false, error: output.error });
  }
};
