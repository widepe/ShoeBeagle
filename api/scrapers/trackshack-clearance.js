// /api/scrapers/trackshack-clearance.js
//
// Track Shack clearance shoes scraper (Cheerio, no Apify)
// - Paginates via "next" link if present; else tries ?page=2..N
// - Handles cases where "Next" click doesn't change URL by using ?page=
// - Writes results to blob: /trackshack.json (via env var URL)
//
// REQUIRED ENV:
//   BLOB_READ_WRITE_TOKEN
//   TRACKSHACK_CLEARANCE_BLOB_URL   (FULL public blob URL ending with /trackshack.json)
//
// Optional ENV:
//   TRACKSHACK_MAX_PAGES (default 20)
//   CRON_SECRET (if set, requires Authorization: Bearer <CRON_SECRET>)

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const BASE = "https://shop.trackshack.com";
const START_URL = `${BASE}/collections/track-shack-clearance-shoes`;

function nowIso() {
  return new Date().toISOString();
}

function requireEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function toAbsUrl(maybeRelative) {
  if (!maybeRelative) return null;
  const s = String(maybeRelative).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return "https:" + s;
  return BASE + (s.startsWith("/") ? s : "/" + s);
}

function parseMoney(s) {
  if (!s) return null;
  const m = String(s).replace(/,/g, "").match(/\$?\s*([0-9]+(\.[0-9]{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function extractBgUrl(style) {
  if (!style) return null;
  const m = String(style).match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
  return m ? m[2] : null;
}

// gender: mens | womens | unisex | unknown
function inferGender(listingName) {
  const t = (listingName || "").toLowerCase();

  const hasMen =
    /\bmen'?s\b/.test(t) ||
    /\bmens\b/.test(t) ||
    /\(m\)/.test(t) ||
    /\bmen\b/.test(t);

  const hasWomen =
    /\bwomen'?s\b/.test(t) ||
    /\bwomens\b/.test(t) ||
    /\(w\)/.test(t) ||
    /\bwomen\b/.test(t);

  const hasUnisex = /\bunisex\b/.test(t);

  if (hasUnisex) return "unisex";
  if (hasMen && !hasWomen) return "mens";
  if (hasWomen && !hasMen) return "womens";
  if (hasMen && hasWomen) return "unisex"; // ambiguous -> treat as unisex
  return "unknown";
}

function computeDiscountPercent(sale, original) {
  if (sale == null || original == null) return null;
  if (!Number.isFinite(sale) || !Number.isFinite(original)) return null;
  if (original <= 0) return null;
  if (sale >= original) return null;
  const pct = Math.round(((original - sale) / original) * 100);
  if (!Number.isFinite(pct) || pct <= 0) return null;
  if (pct > 95) return 95;
  return pct;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

function findNextUrl($) {
  // Prefer explicit rel=next first
  let href =
    $('link[rel="next"]').attr("href") ||
    $('a[rel="next"]').attr("href") ||
    $(".pagination a.next").attr("href") ||
    $(".pagination__next a").attr("href") ||
    $('a[aria-label*="Next"]').attr("href");

  if (href) return toAbsUrl(href);

  // Fallback: anchor with text "Next"
  const nextA = $("a")
    .filter((_, a) => /next/i.test(cleanText($(a).text())) && $(a).attr("href"))
    .first();

  href = nextA.attr("href");
  return href ? toAbsUrl(href) : null;
}

function buildPageUrl(pageNum) {
  // Shopify-style collections often accept ?page=2
  const u = new URL(START_URL);
  u.searchParams.set("page", String(pageNum));
  return u.toString();
}

function deriveModel(listingName, brand) {
  // IMPORTANT: we do NOT edit listingName; we only derive model from it.
  // Try removing leading brand if present.
  const ln = cleanText(listingName);
  const b = cleanText(brand);
  if (!ln) return "";
  if (!b) return ln;

  const re = new RegExp("^" + b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+", "i");
  return cleanText(ln.replace(re, "")) || ln;
}

function parseProductsFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const products = [];

  // Your sample shows products directly inside #CollectionGrid
  const nodes = $("#CollectionGrid .product.featureditem.clickable");

  nodes.each((_, el) => {
    const $el = $(el);

    const listingName = cleanText($el.find(".name").first().text());
    const brand = cleanText($el.find(".brand").first().text()) || "Unknown";

    const href = $el.find('a[href^="/product/"]').first().attr("href") || $el.find("a[href]").first().attr("href");
    const listingURL = href ? toAbsUrl(href) : null;

    const style = $el.find(".image").first().attr("style");
    const bg = extractBgUrl(style);
    const imageURL = bg ? toAbsUrl(bg) : null;

    // Prices:
    // <div class="price"><span class="struck">$165.00</span> $99.00</div>
    const struckText = cleanText($el.find(".price .struck").first().text());
    const priceTextAll = cleanText($el.find(".price").first().text());

    const originalPrice = parseMoney(struckText);

    // Remove struck text from full price text to get sale
    const saleText = cleanText(priceTextAll.replace(struckText, ""));
    const salePrice = parseMoney(saleText);

    const discountPercent = computeDiscountPercent(salePrice, originalPrice);

    const store = "Track Shack";
    const gender = inferGender(listingName);

    // As requested: unknown shoeType for these
    const shoeType = "unknown";

    // Canonical 11-field deal object
    const deal = {
      listingName: listingName || "", // keep as-is
      brand,
      model: deriveModel(listingName, brand),
      salePrice: Number.isFinite(salePrice) ? salePrice : null,
      originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
      discountPercent: Number.isFinite(discountPercent) ? discountPercent : null,
      store,
      listingURL: listingURL || "",
      imageURL: imageURL || null,
      gender,
      shoeType,
    };

    // Basic validity gate: require URL + name + prices
    if (deal.listingName && deal.listingURL && deal.salePrice != null && deal.originalPrice != null) {
      products.push(deal);
    }
  });

  const nextUrl = findNextUrl($);

  return { products, nextUrl, countOnPage: nodes.length, pageUrl };
}

function dedupeByUrl(deals) {
  const out = [];
  const seen = new Set();
  for (const d of deals) {
    const key = (d.listingURL || "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    // Optional auth (matches your merge-deals pattern)
    const auth = req.headers.authorization;
    if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const startMs = Date.now();

    const blobUrl = requireEnv("TRACKSHACK_CLEARANCE_BLOB_URL");
    const maxPages = Math.max(1, parseInt(process.env.TRACKSHACK_MAX_PAGES || "20", 10));

    const sourceUrls = [];
    let pagesFetched = 0;

    let dealsFound = 0; // raw found (pre-dedupe)
    let dealsExtracted = 0; // final (post-dedupe)

    const allDeals = [];

    // Pagination strategy:
    // 1) Fetch START_URL
    // 2) If nextUrl exists and changes, follow it
    // 3) ALSO fallback to ?page=2..N (covers cases where UI paginates without URL changes)
    //
    // We stop early if a page produces 0 valid deals OR if it repeats the same first URL.
    const seenFirstUrls = new Set();

    let url = START_URL;
    let nextUrl = null;

    for (let page = 1; page <= maxPages; page++) {
      // Use discovered nextUrl for page>1 if present; else fallback to ?page=
      if (page === 1) {
        url = START_URL;
      } else if (nextUrl) {
        url = nextUrl;
      } else {
        url = buildPageUrl(page);
      }

      sourceUrls.push(url);

      // cache-bust to avoid CDN weirdness
      const cacheBusted = `${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}`;

      const html = await fetchHtml(cacheBusted);
      const parsed = parseProductsFromHtml(html, url);

      pagesFetched += 1;

      const pageDeals = parsed.products || [];
      dealsFound += pageDeals.length;

      // Early stop: no products
      if (!pageDeals.length) {
        break;
      }

      // Early stop: repeating same first product URL (common when ?page= ignored)
      const firstUrl = (pageDeals[0]?.listingURL || "").trim();
      if (firstUrl) {
        if (seenFirstUrls.has(firstUrl)) {
          break;
        }
        seenFirstUrls.add(firstUrl);
      }

      allDeals.push(...pageDeals);

      // Try to follow actual next link, but only if it’s different from current
      const candidateNext = parsed.nextUrl ? String(parsed.nextUrl).trim() : null;
      if (candidateNext && candidateNext !== url) {
        nextUrl = candidateNext;
      } else {
        nextUrl = null;
      }
    }

    const uniqueDeals = dedupeByUrl(allDeals);
    dealsExtracted = uniqueDeals.length;

    const scrapeDurationMs = Date.now() - startMs;

    const payload = {
      store: "Track Shack",
      schemaVersion: 1,
      lastUpdated: nowIso(),
      via: "cheerio",
      sourceUrls,
      pagesFetched,
      dealsFound,
      dealsExtracted,
      scrapeDurationMs,
      ok: true,
      error: null,
      deals: uniqueDeals,
    };

    // ✅ Save to the blob URL you provided in env (must end with /trackshack.json)
    const blobResult = await put(blobUrl, JSON.stringify(payload, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: payload.store,
      pagesFetched,
      dealsFound,
      dealsExtracted,
      blobUrl: blobResult.url,
      scrapeDurationMs,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err?.message || String(err),
    });
  }
};
