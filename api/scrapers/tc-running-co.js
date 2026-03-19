// /api/scrapers/tc-running-co.js
// CommonJS Vercel API route

const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

export const config = { maxDuration: 60 };

const STORE = "TC Running Co";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";
const BLOB_URL =
  process.env.TCRUNNINGCO_DEALS_BLOB_URL ||
  "https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/tc-running-co.json";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function absUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://tcrunningco.com${url}`;
  return `https://tcrunningco.com/${url.replace(/^\/+/, "")}`;
}

function parsePrice(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/,/g, "");
  const match = cleaned.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const n = Number(match[1]);
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

  if (/\bunisex\b/.test(hay)) return "unisex";
  if (/\bmen['’]s\b|\bmens\b|\bmen\b/.test(hay)) return "mens";
  if (/\bwomen['’]s\b|\bwomens\b|\bwomen\b/.test(hay)) return "womens";

  return "unknown";
}

function inferShoeTypeFromSignals({ productType = "", tags = [], url = "", title = "" }) {
  const hay = `${productType} ${Array.isArray(tags) ? tags.join(" ") : ""} ${url} ${title}`.toLowerCase();

  if (/\btrail\b/.test(hay)) return "trail";
  if (/\btrack\b|\btrack\s*&\s*field\b|\btrack\s+and\s+field\b/.test(hay)) return "track";
  if (/\broad\b/.test(hay)) return "road";

  return "unknown";
}

function parseBrandModel(listingName, vendor) {
  const title = cleanText(listingName);
  const brand = cleanText(vendor) || title.split(/\s+/)[0] || "Unknown";

  let model = title;
  model = model.replace(/^(men['’]s|mens|women['’]s|womens|unisex)\s+/i, "").trim();

  const escapedBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  model = model.replace(new RegExp(`^${escapedBrand}\\s+`, "i"), "").trim();

  return {
    brand: brand || "Unknown",
    model: model || title,
  };
}

function parseEmbeddedProductJson($, card) {
  const out = {
    productType: "",
    tags: [],
  };

  $(card)
    .find('script[type="application/json"], script[type="application/ld+json"]')
    .each((_, el) => {
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

          for (const value of Object.values(node)) {
            if (value && typeof value === "object") walk(value);
          }
        };

        walk(parsed);
      } catch {
        // ignore invalid JSON blocks
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
    if (href && (/next/i.test(text) || /next/i.test(aria))) {
      candidates.push(href);
    }
  });

  for (const href of candidates) {
    const full = absUrl(href);
    if (full && full !== currentUrl) return full;
  }

  try {
    const u = new URL(currentUrl);
    const currentPage = Number(u.searchParams.get("page") || "1");
    u.searchParams.set("page", String(currentPage + 1));
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchHtml(url, attempt = 1) {
  const resp = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      accept: "text/html,application/xhtml+xml",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });

  if (resp.status === 429) {
    if (attempt <= 3) {
      const wait = 1500 * attempt;
      console.warn(`TC Running Co: 429 hit for ${url}, retrying in ${wait}ms...`);
      await sleep(wait);
      return fetchHtml(url, attempt + 1);
    }
    throw new Error(`Fetch failed 429 after retries for ${url}`);
  }

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
  let pagesFetched = 0;
  let currentUrl = START_URL;
  const MAX_PAGES = 100;

  try {
    while (currentUrl && !visited.has(currentUrl) && pagesFetched < MAX_PAGES) {
      visited.add(currentUrl);
      sourceUrls.push(currentUrl);

      const html = await fetchHtml(currentUrl);
      const $ = cheerio.load(html);

      const $cards = $('.productgrid--item[data-product-item]');
      if (!$cards.length) break;

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

        const compareAtText = cleanText(
          $(card).find(".price__compare-at .money, .price__compare-at--single").first().text()
        );
        const currentText = cleanText(
          $(card).find(".price__current .money, .price__current--on-sale .money").first().text()
        );

        if (hasHiddenPrice(`${compareAtText} ${currentText}`)) {
          dropCounts.dropped_hiddenPrice += 1;
          pageSummary.dropped.hiddenPrice += 1;
          return;
        }

        const originalPrice = parsePrice(compareAtText);
        if (!Number.isFinite(originalPrice)) {
          dropCounts.dropped_missingOriginalPrice += 1;
          pageSummary.dropped.missingOriginalPrice += 1;
          return;
        }

        const salePrice = parsePrice(currentText);
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
        const gender = inferGender({
          title,
          url: listingURL,
          description,
        });

        const embeddedJsonSignals = parseEmbeddedProductJson($, card);

        // Per your instruction: default unknown unless JSON/category signals tag it.
        const shoeType = inferShoeTypeFromSignals({
          productType: embeddedJsonSignals.productType,
          tags: embeddedJsonSignals.tags,
          url: "",
          title: "",
        });

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

      currentUrl = nextUrl;

      await sleep(1000 + Math.random() * 800);

      if ($cards.length < 24) break;
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
        continue;
      }

      seen.add(key);
      deduped.push(deal);
    }

    const finalGenderCounts = {
      mens: 0,
      womens: 0,
      unisex: 0,
      unknown: 0,
    };

    for (const deal of deduped) {
      if (finalGenderCounts[deal.gender] == null) finalGenderCounts.unknown += 1;
      else finalGenderCounts[deal.gender] += 1;
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
      mensDeals: finalGenderCounts.mens,
      womensDeals: finalGenderCounts.womens,
      unisexDeals: finalGenderCounts.unisex,
      unknownDeals: finalGenderCounts.unknown,

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

      mensDeals: finalGenderCounts.mens,
      womensDeals: finalGenderCounts.womens,
      unisexDeals: finalGenderCounts.unisex,
      unknownDeals: finalGenderCounts.unknown,

      scrapeDurationMs,

      ok: true,
      error: null,

      dropCounts,
      pageSummaries,

      blobPath: "tc-running-co.json",
      blobUrl: BLOB_URL,
      uploadedBlobUrl: blob.url,

      notes: [
        "HTTP response intentionally omits the deals array.",
        "Blob file contains top-level metadata plus deals array only.",
        "Hidden-price tiles are skipped.",
        "shoeType defaults to unknown unless JSON/category signals are present.",
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
      blobPath: "tc-running-co.json",
      blobUrl: BLOB_URL,
    });
  }
};
