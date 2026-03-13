// /api/scrapers/newton-specials.js
//
// Newton Running Web Specials scraper
// Scrapes:
//   https://www.newtonrunning.com/collections/web-specials-v2
//
// Writes:
//   newton-specials.json
//
// Rules implemented:
// - Top-level JSON contains metadata + deals array only
// - Tracks why tiles/deals were dropped in dropCounts
// - Includes pageSummaries
// - Includes dealsForMens / dealsForWomens / dealsForUnisex / dealsForUnknown
// - Skips hidden-price tiles like:
//     "see price in cart"
//     "add to bag to see price"
//     "see price in bag"
//     etc.
// - Defensive in case collection later includes non-shoe products
//
// ENV:
//   - BLOB_READ_WRITE_TOKEN
//   - CRON_SECRET (optional; block included below but commented out for testing)
//
// TEST:
//   /api/scrapers/newton-specials

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

export const config = { maxDuration: 60 };

const STORE = "Newton Running";
const SCHEMA_VERSION = 1;
const VIA = "fetch-html";
const BLOB_PATH = "newton-specials.json";

const SOURCE_URL = "https://www.newtonrunning.com/collections/web-specials-v2";

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(url) {
  const s = cleanText(url);
  if (!s) return null;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/")) return `https://www.newtonrunning.com${s}`;
  return `https://www.newtonrunning.com/${s.replace(/^\/+/, "")}`;
}

function parsePrice(text) {
  const s = cleanText(text).replace(/,/g, "");
  const m = s.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function roundPct(n) {
  return Number.isFinite(n) ? Math.round(n) : null;
}

function computeDiscountPercent(salePrice, originalPrice) {
  if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice) || originalPrice <= 0) {
    return null;
  }
  if (salePrice >= originalPrice) return 0;
  return roundPct(((originalPrice - salePrice) / originalPrice) * 100);
}

function isHiddenPriceText(text) {
  const s = cleanText(text).toLowerCase();

  if (!s) return false;

  return (
    s.includes("see price in cart") ||
    s.includes("see price in bag") ||
    s.includes("add to bag to see price") ||
    s.includes("add to cart to see price") ||
    s.includes("price in cart") ||
    s.includes("price in bag") ||
    s.includes("see final price") ||
    s.includes("special price in cart") ||
    s.includes("special price in bag")
  );
}

function inferGender(title, bullets) {
  const hay = `${cleanText(title)} ${bullets.map(cleanText).join(" ")}`.toLowerCase();

  if (/\bwomen'?s\b/.test(hay)) return "womens";
  if (/\bmen'?s\b/.test(hay)) return "mens";
  if (/\bunisex\b/.test(hay)) return "unisex";

  // Support simple tile shorthand like "W" / "M"
  if (bullets.some((b) => cleanText(b).toUpperCase() === "W")) return "womens";
  if (bullets.some((b) => cleanText(b).toUpperCase() === "M")) return "mens";

  return "unknown";
}

function inferShoeType(title, bullets) {
  const hay = `${cleanText(title)} ${bullets.map(cleanText).join(" ")}`.toLowerCase();

  if (hay.includes("trail")) return "trail";
  if (hay.includes("track") || hay.includes("spike")) return "track";

  if (
    hay.includes("trainer") ||
    hay.includes("running") ||
    hay.includes("neutral") ||
    hay.includes("stability") ||
    hay.includes("performance trainer") ||
    hay.includes("daily trainer")
  ) {
    return "road";
  }

  return "unknown";
}

function normalizeModel(title) {
  let s = cleanText(title);

  s = s.replace(/^women'?s\s+/i, "");
  s = s.replace(/^men'?s\s+/i, "");
  s = s.replace(/^unisex\s+/i, "");

  return s || null;
}

function looksLikeShoe(title, bullets, href) {
  const hay = `${cleanText(title)} ${bullets.map(cleanText).join(" ")} ${cleanText(href)}`.toLowerCase();

  const obviousNonShoe =
    hay.includes("sock") ||
    hay.includes("socks") ||
    hay.includes("hat") ||
    hay.includes("visor") ||
    hay.includes("shirt") ||
    hay.includes("tee") ||
    hay.includes("tank") ||
    hay.includes("bra") ||
    hay.includes("tight") ||
    hay.includes("short") ||
    hay.includes("jacket") ||
    hay.includes("hoodie") ||
    hay.includes("belt") ||
    hay.includes("bottle") ||
    hay.includes("pack") ||
    hay.includes("accessory") ||
    hay.includes("gift card");

  if (obviousNonShoe) return false;

  const shoeSignals =
    hay.includes("gravity") ||
    hay.includes("motion") ||
    hay.includes("distance") ||
    hay.includes("fate") ||
    hay.includes("momentum") ||
    hay.includes("trainer") ||
    hay.includes("running") ||
    hay.includes("neutral") ||
    hay.includes("stability") ||
    hay.includes("shoe") ||
    hay.includes("/products/");

  return shoeSignals;
}

function makeDropCounts() {
  return {
    totalTiles: 0,
    dropped_missingHref: 0,
    dropped_missingTitle: 0,
    dropped_hiddenPrice: 0,
    dropped_notShoe: 0,
    dropped_missingSalePrice: 0,
    dropped_duplicate: 0,
  };
}

function makeGenderCounts() {
  return {
    mens: 0,
    womens: 0,
    unisex: 0,
    unknown: 0,
  };
}

function incrementGenderCount(counts, gender) {
  if (gender === "mens") counts.mens++;
  else if (gender === "womens") counts.womens++;
  else if (gender === "unisex") counts.unisex++;
  else counts.unknown++;
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  // Uncomment for production.
  /*
  // CRON_SECRET
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  */

  const dropCounts = makeDropCounts();

  try {
    const response = await fetch(SOURCE_URL, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${SOURCE_URL}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const deals = [];
    const seen = new Set();
    const sourceUrls = [SOURCE_URL];

    const pageGenderCounts = makeGenderCounts();

    const $tiles = $("a.newton-collection-shogun-item");
    dropCounts.totalTiles = $tiles.length;

    $tiles.each((_, el) => {
      const $tile = $(el);

      const href = cleanText($tile.attr("href"));
      if (!href) {
        dropCounts.dropped_missingHref++;
        return;
      }

      const listingURL = absoluteUrl(href);

      const title = cleanText($tile.find("h3.title").first().text());
      if (!title) {
        dropCounts.dropped_missingTitle++;
        return;
      }

      const bullets = [];
      $tile.find("ul li").each((__, li) => {
        const txt = cleanText($(li).text());
        if (txt) bullets.push(txt);
      });

      const fullTileText = cleanText($tile.text());
      if (isHiddenPriceText(fullTileText)) {
        dropCounts.dropped_hiddenPrice++;
        return;
      }

      if (!looksLikeShoe(title, bullets, href)) {
        dropCounts.dropped_notShoe++;
        return;
      }

      const $priceWrap = $tile.find(".newton-collection-items-item-price").first();
      const priceWrapText = cleanText($priceWrap.text());

      if (isHiddenPriceText(priceWrapText)) {
        dropCounts.dropped_hiddenPrice++;
        return;
      }

      const salePriceText = cleanText(
        $priceWrap.clone().find(".text-line-through").remove().end().text()
      );
      const originalPriceText = cleanText(
        $priceWrap.find(".text-line-through").first().text()
      );

      const salePrice = parsePrice(salePriceText);
      const originalPrice = parsePrice(originalPriceText);

      if (!Number.isFinite(salePrice)) {
        dropCounts.dropped_missingSalePrice++;
        return;
      }

      const imageURL = absoluteUrl(
        $tile.find("img.collection-shoe-image").first().attr("src") ||
        $tile.find("img").first().attr("src")
      );

      const gender = inferGender(title, bullets);
      const shoeType = inferShoeType(title, bullets);

      const deal = {
        schemaVersion: SCHEMA_VERSION,

        listingName: title,

        brand: "Newton",
        model: normalizeModel(title),

        salePrice,
        originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
        discountPercent: computeDiscountPercent(salePrice, originalPrice),

        salePriceLow: null,
        salePriceHigh: null,
        originalPriceLow: null,
        originalPriceHigh: null,
        discountPercentUpTo: null,

        store: STORE,

        listingURL,
        imageURL,

        gender,
        shoeType,
      };

      const dedupeKey = `${deal.listingURL}__${deal.salePrice}__${deal.originalPrice ?? "null"}`;
      if (seen.has(dedupeKey)) {
        dropCounts.dropped_duplicate++;
        return;
      }
      seen.add(dedupeKey);

      deals.push(deal);
      incrementGenderCount(pageGenderCounts, gender);
    });

    const payload = {
      store: STORE,
      schemaVersion: SCHEMA_VERSION,

      lastUpdated: nowIso(),
      via: VIA,

      sourceUrls,

      pagesFetched: 1,

      dealsFound: $tiles.length,
      dealsExtracted: deals.length,
      dealsForMens: pageGenderCounts.mens,
      dealsForWomens: pageGenderCounts.womens,
      dealsForUnisex: pageGenderCounts.unisex,
      dealsForUnknown: pageGenderCounts.unknown,

      scrapeDurationMs: Date.now() - startedAt,

      ok: true,
      error: null,

      dropCounts,

      pageSummaries: [
        {
          page: 1,
          url: SOURCE_URL,
          tilesFound: $tiles.length,
          dealsExtracted: deals.length,
          dealsForMens: pageGenderCounts.mens,
          dealsForWomens: pageGenderCounts.womens,
          dealsForUnisex: pageGenderCounts.unisex,
          dealsForUnknown: pageGenderCounts.unknown,
          dropCounts: { ...dropCounts },
        },
      ],

      deals,
    };

    const blob = await put(BLOB_PATH, JSON.stringify(payload, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      store: STORE,
      blobPath: BLOB_PATH,
      blobUrl: blob.url,
      pagesFetched: payload.pagesFetched,
      dealsFound: payload.dealsFound,
      dealsExtracted: payload.dealsExtracted,
      dealsForMens: payload.dealsForMens,
      dealsForWomens: payload.dealsForWomens,
      dealsForUnisex: payload.dealsForUnisex,
      dealsForUnknown: payload.dealsForUnknown,
      scrapeDurationMs: payload.scrapeDurationMs,
      ok: payload.ok,
      error: payload.error,
      dropCounts: payload.dropCounts,
      pageSummaries: payload.pageSummaries,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      store: STORE,
      schemaVersion: SCHEMA_VERSION,
      lastUpdated: nowIso(),
      via: VIA,
      sourceUrls: [SOURCE_URL],
      pagesFetched: 1,
      dealsFound: 0,
      dealsExtracted: 0,
      dealsForMens: 0,
      dealsForWomens: 0,
      dealsForUnisex: 0,
      dealsForUnknown: 0,
      scrapeDurationMs: Date.now() - startedAt,
      ok: false,
      error: error?.message || String(error),
      dropCounts,
      pageSummaries: [],
    });
  }
}
