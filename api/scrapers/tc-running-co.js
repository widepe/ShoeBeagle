// /api/scrapers/tc-running-co.js
// Shopify JSON endpoint scraper for TC Running Co

const { put } = require("@vercel/blob");

export const config = { maxDuration: 60 };

const STORE = "TC Running Co";
const SCHEMA_VERSION = 1;
const VIA = "shopify-products-json";

const START_URL =
  "https://tcrunningco.com/collections/hawks-spot-flying-good-deals/products.json" +
  "?filter.p.m.custom.gender=Men" +
  "&filter.p.m.custom.gender=Women" +
  "&filter.p.m.custom.gender=Unisex" +
  "&filter.p.m.custom.running_type=Racing" +
  "&filter.p.m.custom.running_type=Road" +
  "&filter.p.m.custom.running_type=Trail+Running" +
  "&filter.p.m.custom.running_type=Distance%2FMid-Distance" +
  "&filter.p.m.custom.running_type=Cross+Country" +
  "&filter.p.m.custom.running_type=Stability" +
  "&filter.p.m.custom.running_type=Neutral" +
  "&filter.p.m.custom.running_type=Recovery" +
  "&filter.v.availability=1";

const BLOB_URL =
  process.env.TCRUNNINGCO_DEALS_BLOB_URL ||
  "https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/tc-running-co.json";

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

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripHtml(html) {
  return cleanText(String(html || "").replace(/<[^>]*>/g, " "));
}

function parseMoney(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/,/g, "").replace(/^\$/, "").trim());
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
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

function hasHiddenPriceText(text) {
  const t = cleanText(text);
  return HIDDEN_PRICE_PATTERNS.some((re) => re.test(t));
}

function uniqNumbers(nums) {
  return [...new Set(nums.filter((n) => Number.isFinite(n)).map((n) => Number(n.toFixed(2))))];
}

function minNum(nums) {
  return nums.length ? Math.min(...nums) : null;
}

function maxNum(nums) {
  return nums.length ? Math.max(...nums) : null;
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBrandModel(listingName, vendor) {
  const title = cleanText(listingName);
  const brand = cleanText(vendor) || title.split(/\s+/)[0] || "Unknown";

  let model = title;
  model = model.replace(/^(men['’]s|mens|women['’]s|womens|unisex)\s+/i, "").trim();

  const brandRe = new RegExp(`^${escapeRegex(brand)}\\s+`, "i");
  model = model.replace(brandRe, "").trim();

  return {
    brand: brand || "Unknown",
    model: model || title,
  };
}

function inferGender(product) {
  const tags = Array.isArray(product.tags) ? product.tags.join(" ") : "";
  const hay = `${product.title || ""} ${tags} ${product.product_type || ""} ${product.handle || ""}`.toLowerCase();

  if (/\bunisex\b/.test(hay)) return "unisex";
  if (/\bmen['’]s\b|\bmens\b|\bmen\b/.test(hay)) return "mens";
  if (/\bwomen['’]s\b|\bwomens\b|\bwomen\b/.test(hay)) return "womens";

  return "unknown";
}

function inferShoeType(product) {
  const tags = Array.isArray(product.tags) ? product.tags.join(" ") : "";
  const hay = `${product.product_type || ""} ${tags}`.toLowerCase();

  if (/\btrail\b/.test(hay)) return "trail";
  if (/\broad\b/.test(hay)) return "road";

  if (
    /\btrack\b/.test(hay) ||
    /\btrack\s*&\s*field\b/.test(hay) ||
    /\btrack\s+and\s+field\b/.test(hay) ||
    /\bcross\s+country\b/.test(hay) ||
    /\bsprints?\b/.test(hay) ||
    /\bdistance\/mid-distance\b/.test(hay) ||
    /\bdistance\b/.test(hay) ||
    /\bmid-distance\b/.test(hay) ||
    /\bspike\b/.test(hay)
  ) {
    return "track";
  }

  return "unknown";
}

function isFootwearProduct(product) {
  const tags = Array.isArray(product.tags) ? product.tags.join(" ") : "";
  const body = stripHtml(product.body_html);
  const hay = `${product.title || ""} ${product.product_type || ""} ${tags} ${body}`.toLowerCase();

  const explicitNonFootwear =
    /\b(apparel|jacket|shorts|tights|singlet|bra|shirt|hoodie|pants|gloves|hat|socks?|sunglasses|belt|bottle|pack|vest)\b/.test(
      hay
    );

  const explicitFootwear =
    /\bfootwear\b/.test(String(product.product_type || "").toLowerCase()) ||
    /\bshoe\b/.test(hay) ||
    /\bspike\b/.test(hay) ||
    /\btrainer\b/.test(hay) ||
    /\bsneaker\b/.test(hay) ||
    /\bclog\b/.test(hay);

  if (explicitNonFootwear && !explicitFootwear) return false;
  return explicitFootwear;
}

function getImageUrl(product) {
  if (Array.isArray(product.images) && product.images.length) {
    const src = product.images[0] && product.images[0].src;
    if (src) return src;
  }

  if (Array.isArray(product.variants)) {
    for (const variant of product.variants) {
      if (variant && variant.featured_image && variant.featured_image.src) {
        return variant.featured_image.src;
      }
    }
  }

  return null;
}

function buildListingUrl(product) {
  if (!product || !product.handle) return null;
  return `https://tcrunningco.com/products/${product.handle}`;
}

function summarizeVariantPricing(product) {
  const variants = Array.isArray(product.variants) ? product.variants : [];

  const availableVariants = variants.filter((v) => v && v.available === true);
  const discountedAvailableVariants = availableVariants
    .map((v) => {
      const salePrice = parseMoney(v.price);
      const originalPrice = parseMoney(v.compare_at_price);
      return { salePrice, originalPrice, raw: v };
    })
    .filter(
      (v) =>
        Number.isFinite(v.salePrice) &&
        Number.isFinite(v.originalPrice) &&
        v.salePrice < v.originalPrice
    );

  return {
    totalVariants: variants.length,
    availableVariants: availableVariants.length,
    discountedAvailableVariants,
  };
}

async function fetchJson(url, attempt = 1) {
  const resp = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      accept: "application/json,text/plain,*/*",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
      referer: "https://tcrunningco.com/",
    },
  });

  if (resp.status === 429) {
    if (attempt <= 6) {
      const wait = 2500 * attempt + Math.floor(Math.random() * 1000);
      await sleep(wait);
      return fetchJson(url, attempt + 1);
    }
    throw new Error(`Fetch failed 429 after retries for ${url}`);
  }

  if (!resp.ok) {
    throw new Error(`Fetch failed ${resp.status} for ${url}`);
  }

  return await resp.json();
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();

  // TEMPORARILY COMMENTED OUT FOR TESTING
  // const auth = req.headers.authorization;
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ success: false, error: "Unauthorized" });
  // }

  const sourceUrls = [];
  const allDeals = [];
  const pageSummaries = [];

  const dropCounts = {
    totalProducts: 0,
    dropped_notFootwear: 0,
    dropped_hiddenPrice: 0,
    dropped_missingListingName: 0,
    dropped_missingListingURL: 0,
    dropped_missingImageURL: 0,
    dropped_noAvailableVariants: 0,
    dropped_missingOriginalPrice: 0,
    dropped_missingSalePrice: 0,
    dropped_saleNotLessThanOriginal: 0,
    dropped_duplicateAfterMerge: 0,
  };

  let page = 1;
  let pagesFetched = 0;
  let dealsFound = 0;
  const MAX_PAGES = 100;

  try {
    while (page <= MAX_PAGES) {
      const pageUrl = `${START_URL}?page=${page}`;
      let payload;

      try {
        payload = await fetchJson(pageUrl);
      } catch (err) {
        if (String(err?.message || err).includes("429")) break;
        throw err;
      }

      const products = Array.isArray(payload?.products) ? payload.products : [];
      if (!products.length) break;

      sourceUrls.push(pageUrl);
      pagesFetched += 1;

      const pageSummary = {
        page,
        url: pageUrl,
        productsFound: products.length,
        extracted: 0,
        dropped: {
          notFootwear: 0,
          hiddenPrice: 0,
          missingListingName: 0,
          missingListingURL: 0,
          missingImageURL: 0,
          noAvailableVariants: 0,
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

      for (const product of products) {
        dropCounts.totalProducts += 1;
        dealsFound += 1;

        const listingName = cleanText(product.title);
        if (!listingName) {
          dropCounts.dropped_missingListingName += 1;
          pageSummary.dropped.missingListingName += 1;
          continue;
        }

        if (!isFootwearProduct(product)) {
          dropCounts.dropped_notFootwear += 1;
          pageSummary.dropped.notFootwear += 1;
          continue;
        }

        const listingURL = buildListingUrl(product);
        if (!listingURL) {
          dropCounts.dropped_missingListingURL += 1;
          pageSummary.dropped.missingListingURL += 1;
          continue;
        }

        const imageURL = getImageUrl(product);
        if (!imageURL) {
          dropCounts.dropped_missingImageURL += 1;
          pageSummary.dropped.missingImageURL += 1;
          continue;
        }

        const searchableText = [
          product.title,
          product.product_type,
          Array.isArray(product.tags) ? product.tags.join(" ") : "",
          stripHtml(product.body_html),
        ].join(" ");

        if (hasHiddenPriceText(searchableText)) {
          dropCounts.dropped_hiddenPrice += 1;
          pageSummary.dropped.hiddenPrice += 1;
          continue;
        }

        const pricing = summarizeVariantPricing(product);

        if (!pricing.availableVariants) {
          dropCounts.dropped_noAvailableVariants += 1;
          pageSummary.dropped.noAvailableVariants += 1;
          continue;
        }

        if (!pricing.discountedAvailableVariants.length) {
          const availableSalePrices = pricing.availableVariants
            ? (product.variants || [])
                .filter((v) => v && v.available === true)
                .map((v) => parseMoney(v.price))
                .filter((n) => Number.isFinite(n))
            : [];

          const availableOriginalPrices = pricing.availableVariants
            ? (product.variants || [])
                .filter((v) => v && v.available === true)
                .map((v) => parseMoney(v.compare_at_price))
                .filter((n) => Number.isFinite(n))
            : [];

          if (!availableSalePrices.length) {
            dropCounts.dropped_missingSalePrice += 1;
            pageSummary.dropped.missingSalePrice += 1;
            continue;
          }

          if (!availableOriginalPrices.length) {
            dropCounts.dropped_missingOriginalPrice += 1;
            pageSummary.dropped.missingOriginalPrice += 1;
            continue;
          }

          dropCounts.dropped_saleNotLessThanOriginal += 1;
          pageSummary.dropped.saleNotLessThanOriginal += 1;
          continue;
        }

        const salePrices = uniqNumbers(
          pricing.discountedAvailableVariants.map((v) => v.salePrice)
        );
        const originalPrices = uniqNumbers(
          pricing.discountedAvailableVariants.map((v) => v.originalPrice)
        );
        const discounts = uniqNumbers(
          pricing.discountedAvailableVariants.map((v) =>
            roundDiscountPercent(v.salePrice, v.originalPrice)
          )
        );

        const hasSingleSale = salePrices.length === 1;
        const hasSingleOriginal = originalPrices.length === 1;
        const hasSingleDiscount = discounts.length === 1;

        const gender = inferGender(product);
        const shoeType = inferShoeType(product);
        const { brand, model } = parseBrandModel(listingName, product.vendor);

        const deal = {
          schemaVersion: SCHEMA_VERSION,

          listingName,

          brand,
          model,

          salePrice: hasSingleSale ? salePrices[0] : null,
          originalPrice: hasSingleOriginal ? originalPrices[0] : null,
          discountPercent:
            hasSingleSale && hasSingleOriginal && hasSingleDiscount
              ? discounts[0]
              : null,

          salePriceLow: hasSingleSale ? null : minNum(salePrices),
          salePriceHigh: hasSingleSale ? null : maxNum(salePrices),

          originalPriceLow: hasSingleOriginal ? null : minNum(originalPrices),
          originalPriceHigh: hasSingleOriginal ? null : maxNum(originalPrices),

          discountPercentUpTo:
            hasSingleSale && hasSingleOriginal && hasSingleDiscount
              ? null
              : maxNum(discounts),

          store: STORE,

          listingURL,
          imageURL,

          gender,
          shoeType,
        };

        allDeals.push(deal);
        pageSummary.extracted += 1;

        if (pageSummary.genderCounts[gender] == null) pageSummary.genderCounts.unknown += 1;
        else pageSummary.genderCounts[gender] += 1;
      }

      pageSummaries.push(pageSummary);
      page += 1;

      await sleep(250 + Math.floor(Math.random() * 350));
    }

    const deduped = [];
    const seen = new Set();

    for (const deal of allDeals) {
      const key = [
        deal.listingURL,
        deal.salePrice ?? "",
        deal.originalPrice ?? "",
        deal.salePriceLow ?? "",
        deal.salePriceHigh ?? "",
        deal.originalPriceLow ?? "",
        deal.originalPriceHigh ?? "",
        deal.gender,
      ].join("||");

      if (seen.has(key)) {
        dropCounts.dropped_duplicateAfterMerge += 1;
        continue;
      }

      seen.add(key);
      deduped.push(deal);
    }

    const genderCounts = {
      mens: 0,
      womens: 0,
      unisex: 0,
      unknown: 0,
    };

    for (const deal of deduped) {
      if (genderCounts[deal.gender] == null) genderCounts.unknown += 1;
      else genderCounts[deal.gender] += 1;
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
      blobUrl: BLOB_URL,
      uploadedBlobUrl: blob.url,

      notes: [
        "HTTP response intentionally omits the deals array.",
        "Blob file contains top-level metadata plus deals array only.",
        "Hidden-price items are skipped if any hidden-price text appears in JSON fields.",
        "shoeType defaults to unknown unless tags or product_type clearly indicate road, trail, or track.",
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
      mensDeals: 0,
      womensDeals: 0,
      unisexDeals: 0,
      unknownDeals: 0,
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
