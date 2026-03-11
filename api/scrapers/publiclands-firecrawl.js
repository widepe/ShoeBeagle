// /api/scrapers/publiclands-sale.js
//
// Public Lands sale running shoes scraper
// - Uses Firecrawl raw HTML via REST endpoint to bypass direct-fetch 403
// - Scrapes exactly 2 listing roots:
//   1) womens-footwear-sale filtered to running
//   2) mens-footwear-sale filtered to running
// - Reads all pages exposed by site pagination, capped at 5 pages per root
// - Drops "See Price In Cart" / "See Price In Bag"
// - Keeps shoeType = "unknown" for all shoes
// - Supports:
//   * single sale + single original
//   * sale range + single original
//   * sale range + original range
// - Writes publiclands-sale.json to Vercel Blob
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//   - FIRECRAWL_API_KEY
//
// TEST:
//   /api/scrapers/publiclands-sale
//
// CRON auth (temporarily commented out for testing)

const auth = req.headers.authorization;
if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  return res.status(401).json({ success: false, error: "Unauthorized" });
}


import { put } from "@vercel/blob";

export const config = { maxDuration: 300 };

const STORE = "Public Lands";
const SCHEMA_VERSION = 1;
const VIA = "firecrawl-rest-html";
const BASE_URL = "https://www.publiclands.com";
const OUTPUT_BLOB = "publiclands-sale.json";
const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v1/scrape";

const SOURCE_URLS = [
  "https://www.publiclands.com/f/womens-footwear-sale?filterFacets=4285%253ARunning%253B5382%253AAthletic%2520%2526%2520Sneakers%253BfacetStore%253ASHIP",
  "https://www.publiclands.com/f/mens-footwear-sale?filterFacets=4285%253ARunning%253B5382%253AAthletic%2520%2526%2520Sneakers%253BfacetStore%253ASHIP",
];

const MAX_PAGES_PER_SOURCE = 5;
const FIRECRAWL_TIMEOUT_MS = 20000;
const FIRECRAWL_WAIT_MS = 1000;

// ─── Utilities ───────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function cleanText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function absoluteUrl(url) {
  const s = String(url || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return `${BASE_URL}${s}`;
  return `${BASE_URL}/${s}`;
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPageUrl(baseUrl, pageNumber) {
  const url = new URL(baseUrl);
  url.searchParams.set("pageNumber", String(pageNumber));
  return url.toString();
}

// ─── Parsing Helpers ─────────────────────────────────────────────────────────

function parseGender(listingName) {
  const s = cleanText(listingName).toLowerCase();
  if (/\bmen'?s\b/.test(s)) return "mens";
  if (/\bwomen'?s\b/.test(s)) return "womens";
  if (/\bunisex\b/.test(s)) return "unisex";
  return "unknown";
}

function parseBrandAndModel(listingName) {
  const raw = cleanText(listingName);
  if (!raw) return { brand: "", model: "" };

  let s = raw;
  s = s.replace(/\bmen'?s\b/gi, "");
  s = s.replace(/\bwomen'?s\b/gi, "");
  s = s.replace(/\bunisex\b/gi, "");
  s = s.replace(/\btrail running shoes?\b/gi, "");
  s = s.replace(/\brunning shoes?\b/gi, "");
  s = s.replace(/\btrack shoes?\b/gi, "");
  s = s.replace(/\bshoes?\b/gi, "");
  s = cleanText(s);

  const parts = s.split(/\s+/).filter(Boolean);
  if (!parts.length) return { brand: "", model: "" };

  const brand = parts[0];
  const model = cleanText(s.slice(brand.length));
  return { brand: brand || "", model: model || "" };
}

function roundDiscountPercent(original, sale) {
  if (
    typeof original !== "number" ||
    typeof sale !== "number" ||
    !Number.isFinite(original) ||
    !Number.isFinite(sale) ||
    original <= 0 ||
    sale < 0 ||
    sale >= original
  ) {
    return null;
  }
  return Math.round(((original - sale) / original) * 100);
}

function extractAttr(tagHtml, attrName) {
  const re = new RegExp(`${escapeRegex(attrName)}="([^"]*)"`, "i");
  const m = String(tagHtml || "").match(re);
  return m ? decodeHtmlEntities(m[1]) : null;
}

function extractFirstMatch(str, regex, group = 1) {
  const m = String(str || "").match(regex);
  return m ? m[group] : null;
}

// ─── HTML Splitting ──────────────────────────────────────────────────────────

function splitTiles(html) {
  const src = String(html || "");

  const titleTagRegex =
    /<a[^>]*class="[^"]*\bproduct-title-link\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi;

  const titleMatches = [...src.matchAll(titleTagRegex)];
  if (!titleMatches.length) return [];

  const tiles = [];

  for (let i = 0; i < titleMatches.length; i++) {
    const match = titleMatches[i];
    const titleStart = match.index ?? -1;
    if (titleStart < 0) continue;

    const before = src.slice(0, titleStart);
    const wrapperMatch = before.match(
      /<div[^>]*class="[^"]*\bproduct-card\b[^"]*"[^>]*>[^<]*$/i
    );

    let start = titleStart;
    if (wrapperMatch && typeof wrapperMatch.index === "number") {
      start = wrapperMatch.index;
    } else {
      start = Math.max(0, titleStart - 4000);
    }

    const nextTitleStart =
      i + 1 < titleMatches.length && typeof titleMatches[i + 1].index === "number"
        ? titleMatches[i + 1].index
        : src.length;

    const chunk = src.slice(start, nextTitleStart);
    tiles.push(chunk);
  }

  return tiles;
}

function countPaginationPages(html) {
  const labels = [
    ...String(html || "").matchAll(/aria-label="Page Number\s+(\d+)"/gi),
  ].map((m) => Number(m[1]));
  const maxPage = labels.length ? Math.max(...labels) : 1;
  return Math.max(1, Math.min(MAX_PAGES_PER_SOURCE, maxPage));
}

// ─── Tile Filters ────────────────────────────────────────────────────────────

function tileHasSeePriceInCart(tileHtml) {
  const s = cleanText(String(tileHtml || "")).toLowerCase();
  return (
    s.includes("see price in cart") ||
    s.includes("see price in bag") ||
    s.includes("price in cart") ||
    s.includes("price in bag")
  );
}

function getTitleAnchor(tileHtml) {
  const m = String(tileHtml).match(
    /<a[^>]*class="[^"]*\bproduct-title-link\b[^"]*"[^>]*>/i
  );
  return m ? m[0] : null;
}

function getPrimaryImageTag(tileHtml) {
  const m = String(tileHtml).match(/<img[^>]+itemprop="image"[^>]*>/i);
  return m ? m[0] : null;
}

// ─── Pricing ─────────────────────────────────────────────────────────────────

function extractAriaLabelPriceRanges(ariaLabel) {
  const label = cleanText(ariaLabel);
  let saleLow = null;
  let saleHigh = null;
  let originalLow = null;
  let originalHigh = null;

  const saleRangeMatch = label.match(
    /New Lower Price:\s*\$([\d.,]+)\s*to\s*\$([\d.,]+)/i
  );
  const saleSingleMatch = label.match(/New Lower Price:\s*\$([\d.,]+)/i);
  const originalRangeMatch = label.match(
    /Previous Price:\s*\$([\d.,]+)\s*to\s*\$([\d.,]+)/i
  );
  const originalSingleMatch = label.match(/Previous Price:\s*\$([\d.,]+)/i);

  if (saleRangeMatch) {
    saleLow = Number(saleRangeMatch[1].replace(/,/g, ""));
    saleHigh = Number(saleRangeMatch[2].replace(/,/g, ""));
  } else if (saleSingleMatch) {
    saleLow = Number(saleSingleMatch[1].replace(/,/g, ""));
    saleHigh = saleLow;
  }

  if (originalRangeMatch) {
    originalLow = Number(originalRangeMatch[1].replace(/,/g, ""));
    originalHigh = Number(originalRangeMatch[2].replace(/,/g, ""));
  } else if (originalSingleMatch) {
    originalLow = Number(originalSingleMatch[1].replace(/,/g, ""));
    originalHigh = originalLow;
  }

  return { saleLow, saleHigh, originalLow, originalHigh };
}

function extractPricing(tileHtml, ariaLabel) {
  const html = String(tileHtml || "");
  const label = cleanText(ariaLabel || "");

  let saleLow = null;
  let saleHigh = null;
  let originalLow = null;
  let originalHigh = null;

  const saleBlockMatch = html.match(
    /class="[^"]*\bprice-sale\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  const originalBlockMatch = html.match(
    /class="[^"]*\bhmf-text-decoration-linethrough\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );

  const saleBlockText = cleanText(
    decodeHtmlEntities((saleBlockMatch?.[1] || "").replace(/<[^>]+>/g, " "))
  );
  const originalBlockText = cleanText(
    decodeHtmlEntities(
      (originalBlockMatch?.[1] || "").replace(/<[^>]+>/g, " ")
    )
  );

  const saleNums = [
    ...saleBlockText.matchAll(/\$?\s*(\d+(?:\.\d{1,2})?)/g),
  ].map((m) => Number(m[1]));
  const originalNums = [
    ...originalBlockText.matchAll(/\$?\s*(\d+(?:\.\d{1,2})?)/g),
  ].map((m) => Number(m[1]));

  if (saleNums.length >= 2) {
    saleLow = saleNums[0];
    saleHigh = saleNums[1];
  } else if (saleNums.length === 1) {
    saleLow = saleNums[0];
    saleHigh = saleNums[0];
  }

  if (originalNums.length >= 2) {
    originalLow = originalNums[0];
    originalHigh = originalNums[1];
  } else if (originalNums.length === 1) {
    originalLow = originalNums[0];
    originalHigh = originalNums[0];
  }

  const ariaParsed = extractAriaLabelPriceRanges(label);
  if (saleLow == null && ariaParsed.saleLow != null) saleLow = ariaParsed.saleLow;
  if (saleHigh == null && ariaParsed.saleHigh != null) saleHigh = ariaParsed.saleHigh;
  if (originalLow == null && ariaParsed.originalLow != null) originalLow = ariaParsed.originalLow;
  if (originalHigh == null && ariaParsed.originalHigh != null) originalHigh = ariaParsed.originalHigh;

  const saleIsRange =
    saleLow != null && saleHigh != null && Number(saleLow) !== Number(saleHigh);
  const originalIsRange =
    originalLow != null &&
    originalHigh != null &&
    Number(originalLow) !== Number(originalHigh);

  let salePrice = null;
  let originalPrice = null;
  let salePriceLow = null;
  let salePriceHigh = null;
  let originalPriceLow = null;
  let originalPriceHigh = null;
  let discountPercent = null;
  let discountPercentUpTo = null;

  if (saleLow != null && saleHigh != null) {
    if (saleIsRange) {
      salePriceLow = saleLow;
      salePriceHigh = saleHigh;
    } else {
      salePrice = saleLow;
    }
  }

  if (originalLow != null && originalHigh != null) {
    if (originalIsRange) {
      originalPriceLow = originalLow;
      originalPriceHigh = originalHigh;
    } else {
      originalPrice = originalLow;
    }
  }

  if (
    !saleIsRange &&
    !originalIsRange &&
    salePrice != null &&
    originalPrice != null
  ) {
    discountPercent = roundDiscountPercent(originalPrice, salePrice);
  } else {
    const honestOriginalHigh =
      originalPriceHigh ?? originalPrice ?? originalLow ?? originalHigh ?? null;
    const honestSaleLow =
      salePriceLow ?? salePrice ?? saleLow ?? saleHigh ?? null;

    if (
      typeof honestOriginalHigh === "number" &&
      typeof honestSaleLow === "number" &&
      honestOriginalHigh > honestSaleLow
    ) {
      discountPercentUpTo = roundDiscountPercent(
        honestOriginalHigh,
        honestSaleLow
      );
    }
  }

  return {
    salePrice,
    originalPrice,
    discountPercent,
    salePriceLow,
    salePriceHigh,
    originalPriceLow,
    originalPriceHigh,
    discountPercentUpTo,
  };
}

// ─── Tile Parser ─────────────────────────────────────────────────────────────

function parseTile(tileHtml, dropCounts, droppedDealsSample, seenUrls) {
  const titleAnchor = getTitleAnchor(tileHtml);
  const imageTag = getPrimaryImageTag(tileHtml);

  const rawListingName =
    extractAttr(titleAnchor, "title") ||
    cleanText(
      decodeHtmlEntities(
        extractFirstMatch(
          tileHtml,
          /<a[^>]*class="[^"]*\bproduct-title-link\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i
        )?.replace(/<[^>]+>/g, " ") || ""
      )
    );
  const listingName = cleanText(rawListingName);

  if (!listingName) {
    dropCounts.dropped_missingListingName++;
    if (droppedDealsSample.length < 100) {
      droppedDealsSample.push({ reason: "missingListingName" });
    }
    return null;
  }

  const rawHref =
    extractAttr(titleAnchor, "href") ||
    extractFirstMatch(
      tileHtml,
      /<a[^>]*class="[^"]*\bimage\b[^"]*"[^>]*href="([^"]+)"/i
    );
  const listingURL = absoluteUrl(rawHref);

  if (!listingURL) {
    dropCounts.dropped_missingListingURL++;
    if (droppedDealsSample.length < 100) {
      droppedDealsSample.push({ reason: "missingListingURL", listingName });
    }
    return null;
  }

  const imageURL = absoluteUrl(extractAttr(imageTag, "src"));

  if (!imageURL) {
    dropCounts.dropped_missingImageURL++;
    if (droppedDealsSample.length < 100) {
      droppedDealsSample.push({
        reason: "missingImageURL",
        listingName,
        listingURL,
      });
    }
    return null;
  }

  if (tileHasSeePriceInCart(tileHtml)) {
    dropCounts.dropped_seePriceInCart++;
    if (droppedDealsSample.length < 100) {
      droppedDealsSample.push({
        reason: "seePriceInCart",
        listingName,
        listingURL,
      });
    }
    return null;
  }

  const ariaLabel = extractAttr(titleAnchor, "aria-label") || "";
  const pricing = extractPricing(tileHtml, ariaLabel);

  const hasAnySale =
    pricing.salePrice != null ||
    (pricing.salePriceLow != null && pricing.salePriceHigh != null);
  const hasAnyOriginal =
    pricing.originalPrice != null ||
    (pricing.originalPriceLow != null && pricing.originalPriceHigh != null);

  if (!hasAnySale) {
    dropCounts.dropped_missingSalePrice++;
    if (droppedDealsSample.length < 100) {
      droppedDealsSample.push({
        reason: "missingSalePrice",
        listingName,
        listingURL,
      });
    }
    return null;
  }

  if (!hasAnyOriginal) {
    dropCounts.dropped_missingOriginalPrice++;
    if (droppedDealsSample.length < 100) {
      droppedDealsSample.push({
        reason: "missingOriginalPrice",
        listingName,
        listingURL,
      });
    }
    return null;
  }

  const honestSaleLow = pricing.salePriceLow ?? pricing.salePrice ?? null;
  const honestOriginalHigh =
    pricing.originalPriceHigh ?? pricing.originalPrice ?? null;

  if (
    typeof honestSaleLow !== "number" ||
    typeof honestOriginalHigh !== "number" ||
    !(honestSaleLow < honestOriginalHigh)
  ) {
    dropCounts.dropped_saleNotLessThanOriginal++;
    if (droppedDealsSample.length < 100) {
      droppedDealsSample.push({
        reason: "saleNotLessThanOriginal",
        listingName,
        listingURL,
        pricing,
      });
    }
    return null;
  }

  if (pricing.discountPercent == null && pricing.discountPercentUpTo == null) {
    dropCounts.dropped_invalidDiscountPercent++;
    if (droppedDealsSample.length < 100) {
      droppedDealsSample.push({
        reason: "invalidDiscountPercent",
        listingName,
        listingURL,
        pricing,
      });
    }
    return null;
  }

  if (seenUrls.has(listingURL)) {
    dropCounts.dropped_duplicateAfterMerge++;
    return null;
  }
  seenUrls.add(listingURL);

  const { brand, model } = parseBrandAndModel(listingName);
  const gender = parseGender(listingName);

  return {
    schemaVersion: SCHEMA_VERSION,
    listingName,
    brand,
    model,
    salePrice: pricing.salePrice,
    originalPrice: pricing.originalPrice,
    discountPercent: pricing.discountPercent,
    salePriceLow: pricing.salePriceLow,
    salePriceHigh: pricing.salePriceHigh,
    originalPriceLow: pricing.originalPriceLow,
    originalPriceHigh: pricing.originalPriceHigh,
    discountPercentUpTo: pricing.discountPercentUpTo,
    store: STORE,
    listingURL,
    imageURL,
    gender,
    shoeType: "unknown",
  };
}

// ─── Firecrawl ───────────────────────────────────────────────────────────────

async function getFirecrawlHtml(url) {
  const apiKey = String(process.env.FIRECRAWL_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);

  try {
    const resp = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        url,
        formats: ["html"],
        onlyMainContent: false,
        waitFor: FIRECRAWL_WAIT_MS,
        proxy: "auto",
        timeout: FIRECRAWL_TIMEOUT_MS,
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(
        `Firecrawl scrape failed (${resp.status}): ${txt.slice(0, 800)}`
      );
    }

    const data = await resp.json();
    const html = data?.data?.html || data?.data?.[0]?.html || data?.html || "";

    if (!html || typeof html !== "string") {
      const keys = Object.keys(data || {});
      throw new Error(
        `Firecrawl returned no html. Top-level keys: ${keys.join(", ")}`
      );
    }

    return html;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(
        `Firecrawl fetch aborted after ${FIRECRAWL_TIMEOUT_MS}ms`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const startedAt = Date.now();

  // CRON auth (temporarily commented out for testing)
  /*
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const dropCounts = {
    totalTiles: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_seePriceInCart: 0,
    dropped_missingSalePrice: 0,
    dropped_missingOriginalPrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_invalidDiscountPercent: 0,
    dropped_duplicateAfterMerge: 0,
  };

  const droppedDealsSample = [];
  const deals = [];
  const seenUrls = new Set();
  const fetchedUrls = [];

  const dealsByGender = {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };

  try {
    for (const sourceUrl of SOURCE_URLS) {
      const page1Url = buildPageUrl(sourceUrl, 1);
      const firstHtml = await getFirecrawlHtml(page1Url);
      fetchedUrls.push(page1Url);

      const totalPages = countPaginationPages(firstHtml);
      const firstTiles = splitTiles(firstHtml);
      dropCounts.totalTiles += firstTiles.length;

      for (const tileHtml of firstTiles) {
        const deal = parseTile(
          tileHtml,
          dropCounts,
          droppedDealsSample,
          seenUrls
        );
        if (deal) {
          deals.push(deal);
          if (deal.gender === "mens") dealsByGender.mens++;
          else if (deal.gender === "womens") dealsByGender.womens++;
          else if (deal.gender === "unisex") dealsByGender.unisex++;
          else dealsByGender.unknown++;
        }
      }

      for (let page = 2; page <= totalPages; page++) {
        const pageUrl = buildPageUrl(sourceUrl, page);
        const html = await getFirecrawlHtml(pageUrl);
        fetchedUrls.push(pageUrl);

        const tiles = splitTiles(html);
        dropCounts.totalTiles += tiles.length;

        for (const tileHtml of tiles) {
          const deal = parseTile(
            tileHtml,
            dropCounts,
            droppedDealsSample,
            seenUrls
          );
          if (deal) {
            deals.push(deal);
            if (deal.gender === "mens") dealsByGender.mens++;
            else if (deal.gender === "womens") dealsByGender.womens++;
            else if (deal.gender === "unisex") dealsByGender.unisex++;
            else dealsByGender.unknown++;
          }
        }
      }
    }

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,
      sourceUrls: SOURCE_URLS,
      pagesFetched: fetchedUrls.length,
      dealsFound: dropCounts.totalTiles,
      dealsExtracted: deals.length,
      scrapeDurationMs: Date.now() - startedAt,
      ok: true,
      error: null,

      dealsByGender,
      droppedByReason: {
        seePriceInCart: dropCounts.dropped_seePriceInCart,
        duplicateAfterMerge: dropCounts.dropped_duplicateAfterMerge,
      },

      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      droppedDealsSample,
      deals,
    };

    const blob = await put(OUTPUT_BLOB, JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: payload.lastUpdated,
      via: VIA,
      sourceUrls: SOURCE_URLS,
      pagesFetched: fetchedUrls.length,
      dealsFound: dropCounts.totalTiles,
      dealsExtracted: deals.length,
      scrapeDurationMs: payload.scrapeDurationMs,
      ok: true,
      error: null,
      dealsByGender,
      droppedByReason: payload.droppedByReason,
      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      blobUrl: blob.url,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      store: STORE,
      error: err?.message || "Unknown error",
      scrapeDurationMs: Date.now() - startedAt,
      dropCounts,
      droppedDealsLogged: droppedDealsSample.length,
      droppedDealsSample,
    });
  }
}
