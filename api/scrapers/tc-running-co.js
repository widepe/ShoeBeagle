// /api/scrapers/tc_running_co_deals.js
// CommonJS Vercel API route

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

export const config = { maxDuration: 60 };

const STORE = "TC Running Co";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";

const START_URL =
  "https://tcrunningco.com/collections/hawks-spot-flying-good-deals" +
  "?filter.p.m.custom.gender=Unisex" +
  "&filter.p.m.custom.gender=Women" +
  "&filter.p.m.custom.gender=Men" +
  "&filter.p.m.custom.running_type=Track+and+Field" +
  "&filter.p.m.custom.running_type=Cross+Country" +
  "&filter.p.m.custom.running_type=Distance%2FMid-Distance" +
  "&filter.p.m.custom.running_type=Sprints" +
  "&filter.p.m.custom.running_type=Trail+Running" +
  "&filter.p.m.custom.running_type=Road" +
  "&filter.p.m.custom.running_type=Racing" +
  "&filter.v.availability=1";

const HIDDEN_PRICE_PATTERNS = [
  /see\s+price\s+in\s+cart/i,
  /see\s+price\s+in\s+bag/i,
  /add\s+to\s+bag\s+to\s+see\s+price/i,
  /add\s+to\s+cart\s+to\s+see\s+price/i,
  /price\s+in\s+cart/i,
  /price\s+in\s+bag/i,
  /hidden\s+price/i,
];

function nowIso() {
  return new Date().toISOString();
}

function absUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://tcrunningco.com${url}`;
  return `https://tcrunningco.com/${url.replace(/^\/+/, "")}`;
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function parsePrice(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/,/g, "");
  const m = cleaned.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function roundDiscountPercent(salePrice, originalPrice) {
  if (
    !Number.isFinite(salePrice) ||
    !Number.isFinite(originalPrice) ||
    originalPrice <= 0 ||
    salePrice >= originalPrice
  ) {
    return null;
  }
  return Math.round(((originalPrice - salePrice) / originalPrice) * 100);
}

function hasHiddenPrice(text) {
  const t = cleanText(text);
  return HIDDEN_PRICE_PATTERNS.some((re) => re.test(t));
}

function inferGender({ title = "", url = "", description = "" }) {
  const hay = `${title} ${url} ${description}`.toLowerCase();

  if (/\bmen['’]s\b|\bmens\b|\bmen\b/.test(hay)) return "mens";
  if (/\bwomen['’]s\b|\bwomens\b|\bwomen\b/.test(hay)) return "womens";
  if (/\bunisex\b/.test(hay)) return "unisex";

  return "unknown";
}

function inferShoeTypeFromJsonSignals({ productType = "", tags = [] }) {
  const hay = `${productType} ${Array.isArray(tags) ? tags.join(" ") : ""}`.toLowerCase();

  if (/\broad\b/.test(hay)) return "road";
  if (/\btrail\b/.test(hay)) return "trail";
  if (/\btrack\b|\btrack\s*&\s*field\b|\btrack\s+and\s+field\b/.test(hay)) return "track";

  return "unknown";
}

function parseBrandModel(listingName, vendor) {
  const title = cleanText(listingName);
  const brand = cleanText(vendor) || title.split(/\s+/)[0] || "Unknown";

  let model = title;

  // Remove leading men's / women's / unisex label from model only.
  model = model.replace(/^(men['’]s|mens|women['’]s|womens|unisex)\s+/i, "").trim();

  // Remove leading brand from model when duplicated.
  const escapedBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  model = model.replace(new RegExp(`^${escapedBrand}\\s+`, "i"), "").trim();

  return {
    brand: brand || "Unknown",
    model: model || title,
  };
}

function parseEmbeddedProductJson($, card) {
  // Best effort only. If not found, shoeType remains unknown.
  const out = {
    productType: "",
    tags: [],
  };

  const jsonScripts = $(card).find('script[type="application/json"], script[type="application/ld+json"]');

  jsonScripts.each((_, el) => {
    const raw = $(el).html();
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);

      const walk = (node) => {
        if (!node || typeof node !== "object") return;

        if (typeof node.product_type === "string" && !out.productType) {
          out.productType = node.product_type;
        }
        if (typeof node.productType === "string" && !out.productType) {
          out.productType = node.productType;
        }
        if (Array.isArray(node.tags) && !out.tags.length) {
          out.tags = node.tags.filter(Boolean).map(String);
        }

        for (const v of Object.values(node)) {
          if (v && typeof v === "object") walk(v);
        }
      };

      walk(parsed);
    } catch {
      // ignore bad JSON blocks
    }
  });

  return out;
}

function getNextPageUrl($, currentUrl) {
  const candidates = [];

  $('link[rel="next"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) candidates.push(href);
  });

  $('a[rel="next"], .pagination a, nav[aria-label*="Pagination"] a').each((_, el) => {
    const href = $(el).attr("href");
    const text = cleanText($(el).text());
    const aria = cleanText($(el).attr("aria-label"));
    if (
      href &&
      (/next/i.test(text) || /next/i.test(aria) || /page\s*\d+/i.test(text))
    ) {
      candidates.push(href);
    }
  });

  for (const href of candidates) {
    const full = absUrl(href);
    if (full && full !== currentUrl) return full;
  }

  // Fallback: increment page param if page=N exists or append page=2
  try {
    const u = new URL(currentUrl);
    const currentPage = Number(u.searchParams.get("page") || "1");
    u.searchParams.set("page", String(currentPage + 1));
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchHtml(url) {
  const resp = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!resp.ok) {
    throw new Error(`Fetch failed ${resp.status} for ${url}`);
  }

  return await resp.text();
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();

  // TEMPORARILY COMMENTED OUT FOR TESTING
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const visited = new Set();
  const sourceUrls = [];
  const allDeals = [];
  const pageSummaries = [];

  const dropCounts = {
    totalTiles: 0,
    dropped_hiddenPrice: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_missingOriginalPrice: 0,
    dropped_missingSalePrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_duplicateAfterMerge: 0,
  };

  const genderCounts = {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };

  let dealsFound = 0;
  let currentUrl = START_URL;
  let pagesFetched = 0;
  const MAX_PAGES = 100;

  try {
    while (currentUrl && !visited.has(currentUrl) && pagesFetched < MAX_PAGES) {
      visited.add(currentUrl);
      sourceUrls.push(currentUrl);

      const html = await fetchHtml(currentUrl);
      const $ = cheerio.load(html);

      const $cards = $('.productgrid--item[data-product-item]');
      if (!$cards.length) {
        // stop if a paginated page returns no products
        break;
      }

      pagesFetched += 1;

      const pageSummary = {
        page: pagesFetched,
        url: currentUrl,
        tilesFound: $cards.length,
        extracted: 0,
        dropped: {
          hiddenPrice: 0,
          missingListingName: 0,
          missingListingURL: 0,
          missingImageURL: 0,
          missingOriginalPrice: 0,
          missingSalePrice: 0,
          saleNotLessThanOriginal: 0,
          duplicateAfterMerge: 0,
        },
        genderCounts: {
          mens: 0,
          womens: 0,
          unisex: 0,
          unknown: 0,
        },
      };

      $cards.each((_, card) => {
        dropCounts.totalTiles += 1;
        dealsFound += 1;

        const cardText = cleanText($(card).text());

        if (hasHiddenPrice(cardText)) {
          dropCounts.dropped_hiddenPrice += 1;
          pageSummary.dropped.hiddenPrice += 1;
          return;
        }

        const title = cleanText(
          $(card).find(".productitem--title a, .productitem--title").first().text()
        );

        if (!title) {
          dropCounts.dropped_missingListingName += 1;
          pageSummary.dropped.missingListingName += 1;
          return;
        }

        const href = $(card)
          .find("a.productitem--image-link, .productitem--title a, a[data-product-page-link]")
          .first()
          .attr("href");
        const listingURL = absUrl(href);

        if (!listingURL) {
          dropCounts.dropped_missingListingURL += 1;
          pageSummary.dropped.missingListingURL += 1;
          return;
        }

        const imageURL = absUrl(
          $(card).find(".productitem--image-primary").first().attr("src") ||
          $(card).find(".productitem--image-alternate").first().attr("src") ||
          $(card).find("img").first().attr("src")
        );

        if (!imageURL) {
          dropCounts.dropped_missingImageURL += 1;
          pageSummary.dropped.missingImageURL += 1;
          return;
        }

        const vendor = cleanText($(card).find(".productitem--vendor").first().text());

        const originalPrice = parsePrice(
          $(card).find(".price__compare-at .money, .price__compare-at--single").first().text()
        );

        if (!Number.isFinite(originalPrice)) {
          dropCounts.dropped_missingOriginalPrice += 1;
          pageSummary.dropped.missingOriginalPrice += 1;
          return;
        }

        const salePrice = parsePrice(
          $(card).find(".price__current .money, .price__current--on-sale .money").first().text()
        );

        if (!Number.isFinite(salePrice)) {
          dropCounts.dropped_missingSalePrice += 1;
          pageSummary.dropped.missingSalePrice += 1;
          return;
        }

        if (!(salePrice < originalPrice)) {
          dropCounts.dropped_saleNotLessThanOriginal += 1;
          pageSummary.dropped.saleNotLessThanOriginal += 1;
          return;
        }

        const description = cleanText($(card).find(".productitem--description").first().text());
        const gender = inferGender({ title, url: listingURL, description });

        const embeddedJsonSignals = parseEmbeddedProductJson($, card);
        const shoeType = inferShoeTypeFromJsonSignals(embeddedJsonSignals);

        const { brand, model } = parseBrandModel(title, vendor);

        const discountPercent = roundDiscountPercent(salePrice, originalPrice);

        const deal = {
          schemaVersion: SCHEMA_VERSION,

          listingName: title,

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

          store: STORE,

          listingURL,
          imageURL,

          gender,
          shoeType: shoeType || "unknown",
        };

        allDeals.push(deal);

        if (genderCounts[gender] == null) genderCounts.unknown += 1;
        else genderCounts[gender] += 1;

        if (pageSummary.genderCounts[gender] == null) pageSummary.genderCounts.unknown += 1;
        else pageSummary.genderCounts[gender] += 1;

        pageSummary.extracted += 1;
      });

      pageSummaries.push(pageSummary);

      const nextUrl = getNextPageUrl($, currentUrl);

      if (!nextUrl || visited.has(nextUrl)) break;

      // Stop early if this page was short, a common Shopify signal for last page.
      if ($cards.length < 24) break;

      currentUrl = nextUrl;
    }

    const deduped = [];
    const seen = new Set();

    for (const deal of allDeals) {
      const key = [
        deal.listingURL,
        deal.salePrice,
        deal.originalPrice,
        deal.gender,
      ].join("||");

      if (seen.has(key)) {
        dropCounts.dropped_duplicateAfterMerge += 1;
        const pageSummary = pageSummaries.find((p) => p.url && deal.listingURL.includes("/products/"));
        if (pageSummary) pageSummary.dropped.duplicateAfterMerge += 1;
        continue;
      }

      seen.add(key);
      deduped.push(deal);
    }

    const lastUpdated = nowIso();
    const scrapeDurationMs = Date.now() - startedAt;

    const blobData = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated,
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: deduped.length,
      mensDeals: genderCounts.mens,
      womensDeals: genderCounts.womens,
      unisexDeals: genderCounts.unisex,
      unknownDeals: genderCounts.unknown,

      scrapeDurationMs,

      ok: true,
      error: null,

      deals: deduped,
    };

const blob = await put("tc-running-co.json", JSON.stringify(blobData, null, 2), {
  access: "public",
  contentType: "application/json",
  addRandomSuffix: false,
  allowOverwrite: true,
});

    return res.status(200).json({
      success: true,
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated,
      via: VIA,

      sourceUrls,
      pagesFetched,

      dealsFound,
      dealsExtracted: deduped.length,

      mensDeals: genderCounts.mens,
      womensDeals: genderCounts.womens,
      unisexDeals: genderCounts.unisex,
      unknownDeals: genderCounts.unknown,

      scrapeDurationMs,

      ok: true,
      error: null,

      dropCounts,
      pageSummaries,

     blobPath: "tc-running-co.json",

      notes: [
        "HTTP response intentionally omits the deals array.",
        "Blob file contains top-level metadata plus deals array only.",
        "Hidden-price tiles are skipped.",
        "shoeType defaults to unknown unless a JSON/category signal is found.",
      ],
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,
      sourceUrls,
      pagesFetched,
      dealsFound,
      dealsExtracted: allDeals.length,
      mensDeals: genderCounts.mens,
      womensDeals: genderCounts.womens,
      unisexDeals: genderCounts.unisex,
      unknownDeals: genderCounts.unknown,
      scrapeDurationMs: Date.now() - startedAt,
      ok: false,
      error: err?.message || String(err),
      dropCounts,
      pageSummaries,
    });
  }
};
