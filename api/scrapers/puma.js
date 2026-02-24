// api/puma.js  (CommonJS)
// Scrape PUMA running shoes sale listing and write to a Vercel Blob.
//
// ENV required:
//   PUMA_DEALS_BLOB_URL = https://....public.blob.vercel-storage.com/puma.json
//
// ENV optional (recommended if you have it):
//   PUMA_GRAPHQL_ENDPOINT = full URL to the site GraphQL endpoint (if you’ve discovered it)
//
// Notes:
// - We do NOT rely on "offset=" working (often it doesn't). We stop when a page yields 0 new items.
// - If GraphQL works, we use it to fetch all items cleanly.
// - If GraphQL is not available, we fall back to HTML list items: li[data-test-id="product-list-item"].

const cheerio = require("cheerio");

// Node 18+ has global fetch
const { put } = require("@vercel/blob");

function nowIso() {
  return new Date().toISOString();
}

function requireEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function optEnv(name) {
  const v = String(process.env[name] || "").trim();
  return v || null;
}

function absUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function parseMoney(s) {
  const t = String(s || "").replace(/[^\d.]/g, "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Your rule:
// - Gender is clearly stated on card: "Men's ..." or "Women's ...", else "unknown"
// - If AFTER gender it states "road running" => shoeType road
// - If AFTER gender it states "trail running" => shoeType trail
// - otherwise shoeType unknown
function parseGenderAndTypeFromSubtitle(subtitleRaw) {
  const subtitle = String(subtitleRaw || "").trim();
  const low = subtitle.toLowerCase();

  let gender = "unknown";
  if (/\bmen'?s\b/.test(low)) gender = "mens";
  else if (/\bwomen'?s\b/.test(low)) gender = "womens";

  // "after gender it states road running / trail running" — we interpret as:
  // the subtitle contains "... road running ..." or "... trail running ..."
  let shoeType = "unknown";
  if (low.includes("road running")) shoeType = "road";
  else if (low.includes("trail running")) shoeType = "trail";

  return { gender, shoeType, subtitle };
}

function buildListingName({ brand, model, subtitle }) {
  const parts = [brand, model, subtitle].filter(Boolean);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

async function fetchText(url, headers = {}) {
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ...headers,
    },
  });
  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, text };
}

function discoverGraphqlEndpointFromHtml(html, origin) {
  // Heuristics:
  // 1) look for absolute URLs containing "graphql"
  // 2) fallback to common relative paths on Next sites
  const candidates = new Set();

  const reAbs = /https?:\/\/[^\s"'<>]+graphql[^\s"'<>]*/gi;
  let m;
  while ((m = reAbs.exec(html))) candidates.add(m[0]);

  // Common relative endpoints
  candidates.add(new URL("/api/graphql", origin).toString());
  candidates.add(new URL("/graphql", origin).toString());

  // return first plausible
  for (const c of candidates) {
    if (String(c).toLowerCase().includes("graphql")) return c;
  }
  return null;
}

async function tryGraphqlSearchAll({
  listingUrl,
  graphqlEndpoint,
  dropCounts,
  sourceUrls,
}) {
  // We do NOT know the exact GraphQL query name/shape on the server from here.
  // You already pasted a response with: data.searchProducts.itemsSection.results.totalItems = 270
  //
  // So: this function expects you to provide a working endpoint AND we’ll attempt a
  // "best guess" POST that many PUMA/FH (Fredhopper) setups accept.
  //
  // If it fails, caller falls back to HTML.

  const origin = new URL(listingUrl).origin;

  // Build FH params (these appear in your pasted payload)
  // We’ll use them in a generic way; if your endpoint needs different structure,
  // this will fail fast and fallback will kick in.
  const viewSize = 24;

  // NOTE: if your endpoint requires special headers/cookies, HTML fallback is safer.
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    origin,
    referer: listingUrl,
  };

  const all = [];
  const seen = new Set();

  // We’ll attempt up to 100 pages; break when no new items.
  for (let startIndex = 0; startIndex < 2400; startIndex += viewSize) {
    const body = {
      // A very common pattern is:
      // { "operationName": "...", "variables": {...}, "query": "..." }
      //
      // But we don’t have the query text. So we can only support GraphQL
      // if you’re routing through an endpoint that accepts FH params directly
      // (some do), OR if you later paste the real query.
      //
      // Because of that uncertainty, we keep this "best-effort" and fail fast.
      fh_view_size: viewSize,
      fh_start_index: startIndex,
      // We keep the original listing URL filters by sending the path piece.
      // Many FH-backed endpoints accept this kind of location parameter:
      fh_location: "/catalog01/en_US/categories<{catalog01_us}>/categories<{catalog01_us_us0sale}>/categories<{catalog01_us_us0sale_us0sale0all0sale}>/product_division>{shoes}/sport_type>{running}",
    };

    const resp = await fetch(graphqlEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new Error(`GraphQL HTTP ${resp.status}`);
    }

    const json = await resp.json();
    const items =
      json?.data?.searchProducts?.itemsSection?.items ||
      json?.data?.searchProducts?.itemsSection?.itemsSection?.items ||
      null;

    if (!Array.isArray(items)) {
      // Not the expected shape -> fail and fallback.
      throw new Error("GraphQL response shape not recognized");
    }

    let addedThisPage = 0;

    for (const it of items) {
      const hit = it?.productSearchHit;
      const master = hit?.masterProduct;
      const variant = hit?.variantProduct;

      const model = String(master?.header || "").trim();
      const subtitle = String(master?.subHeader || variant?.subHeader || "").trim();

      const { gender, shoeType } = parseGenderAndTypeFromSubtitle(subtitle);

      const salePrice = Number(variant?.productPrice?.salePrice);
      const originalPrice = Number(variant?.productPrice?.price);

      const img =
        variant?.preview ||
        master?.image?.href ||
        master?.image?.verticalImageHref ||
        null;

      // Link building is not obvious from GraphQL alone; many include it in link[0].urlParams.
      // We’ll skip GraphQL if we can’t build a URL.
      const detailParams = it?.link?.find((x) => x?.name === "Detail")?.urlParams || "";
      // If you have a better URL in your real payload, swap it in here.
      // For now we require styleNumber to build a PDP URL reliably.
      const styleNumber = String(variant?.styleNumber || it?.id || "").trim();
      if (!styleNumber) continue;

      // PDP pattern on site is usually /us/en/pd/<slug>/<id>?swatch=<color>
      // Without slug, we can’t guarantee the exact path. So we consider GraphQL incomplete
      // unless we have link params that include fh_secondid or a direct link.
      let listingURL = null;
      if (detailParams) {
        // This is NOT a PDP URL, but it’s at least a stable detail link in many FH installs.
        listingURL = `${listingUrl.split("?")[0]}?${detailParams}`;
      }

      const key = styleNumber;
      if (seen.has(key)) {
        dropCounts.dropped_duplicate++;
        continue;
      }
      seen.add(key);

      if (!model) dropCounts.dropped_missingModel++;
      if (!img) dropCounts.dropped_missingImage++;
      if (!listingURL) dropCounts.dropped_missingUrl++;
      if (!Number.isFinite(salePrice) || salePrice <= 0) dropCounts.dropped_saleMissingOrZero++;
      if (!Number.isFinite(originalPrice) || originalPrice <= 0) dropCounts.dropped_originalMissingOrZero++;

      // We still enforce your merge rule philosophy: must have sale + original and be a deal.
      if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice) || salePrice <= 0 || originalPrice <= 0) {
        continue;
      }
      if (salePrice >= originalPrice) {
        dropCounts.dropped_notADeal++;
        continue;
      }

      const discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);

      const deal = {
        listingName: buildListingName({ brand: "Puma", model, subtitle }),
        brand: "Puma",
        model,

        salePrice,
        originalPrice,
        discountPercent,

        salePriceLow: null,
        salePriceHigh: null,
        originalPriceLow: null,
        originalPriceHigh: null,
        discountPercentUpTo: null,

        store: "PUMA",
        listingURL,
        imageURL: img,

        gender,
        shoeType,
      };

      all.push(deal);
      addedThisPage++;
    }

    sourceUrls.push(`${graphqlEndpoint} (POST startIndex=${startIndex})`);

    if (addedThisPage === 0) {
      dropCounts.stopped_noNewFromGraphql++;
      break;
    }
  }

  return all;
}

function parseDealsFromHtml({ html, baseUrl, dropCounts }) {
  const $ = cheerio.load(html);

  const tiles = $('li[data-test-id="product-list-item"]');
  const deals = [];
  const seen = new Set();

  tiles.each((_, el) => {
    const $el = $(el);
    const productId = String($el.attr("data-product-id") || "").trim();

    const href = $el.find('a[data-test-id="product-list-item-link"]').attr("href") || "";
    const listingURL = absUrl(baseUrl, href);

    const model = String($el.find("h2").first().text() || "").trim();

    const subtitle = String($el.find("h3").first().text() || "").trim();
    const { gender, shoeType } = parseGenderAndTypeFromSubtitle(subtitle);

    const img =
      $el.find('img[src]').first().attr("src") ||
      $el.find("img").first().attr("data-src") ||
      null;

    const saleText = $el.find('[data-test-id="sale-price"]').first().text();
    const origText = $el.find('[data-test-id="price"]').first().text();

    const salePrice = parseMoney(saleText);
    const originalPrice = parseMoney(origText);

    dropCounts.totalTiles++;

    const key = productId || listingURL || `${model}::${saleText}::${origText}`;
    if (seen.has(key)) {
      dropCounts.dropped_duplicate++;
      return;
    }
    seen.add(key);

    if (!listingURL) { dropCounts.dropped_missingUrl++; return; }
    if (!img) { dropCounts.dropped_missingImage++; return; }
    if (!model) { dropCounts.dropped_missingModel++; return; }
    if (!salePrice || salePrice <= 0) { dropCounts.dropped_saleMissingOrZero++; return; }
    if (!originalPrice || originalPrice <= 0) { dropCounts.dropped_originalMissingOrZero++; return; }
    if (salePrice >= originalPrice) { dropCounts.dropped_notADeal++; return; }

    const discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);

    deals.push({
      listingName: buildListingName({ brand: "Puma", model, subtitle }),
      brand: "Puma",
      model,

      salePrice,
      originalPrice,
      discountPercent,

      salePriceLow: null,
      salePriceHigh: null,
      originalPriceLow: null,
      originalPriceHigh: null,
      discountPercentUpTo: null,

      store: "PUMA",
      listingURL,
      imageURL: img,

      gender,
      shoeType,
    });
  });

  return { deals, tilesFound: tiles.length };
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();

  // You can override the start URL by calling:
  //   /api/puma?url=https://us.puma.com/us/en/sale/all-sale?...&offset=0
  const startUrl =
    String(req.query?.url || "").trim() ||
    "https://us.puma.com/us/en/sale/all-sale?filter_product_division=%3E%7Bshoes%7D&filter_sport_type=%3E%7Brunning%7D&offset=0";

  const blobUrl = requireEnv("PUMA_DEALS_BLOB_URL");
  const graphqlEnv = optEnv("PUMA_GRAPHQL_ENDPOINT");

  const out = {
    store: "PUMA",
    schemaVersion: 1,
    lastUpdated: nowIso(),
    via: "cheerio",
    sourceUrls: [],
    pagesFetched: 0,
    dealsFound: 0,
    dealsExtracted: 0,
    scrapeDurationMs: 0,
    ok: true,
    error: null,
    dropCounts: {
      totalTiles: 0,
      dropped_duplicate: 0,
      dropped_missingUrl: 0,
      dropped_missingImage: 0,
      dropped_missingModel: 0,
      dropped_saleMissingOrZero: 0,
      dropped_originalMissingOrZero: 0,
      dropped_notADeal: 0,
      stopped_noNewFromHtml: 0,
      stopped_noNewFromGraphql: 0,
    },
    deals: [],
    blobUrl,
  };

  const origin = new URL(startUrl).origin;

  try {
    // 1) Fetch the first page HTML
    const first = await fetchText(startUrl);
    out.pagesFetched++;
    out.sourceUrls.push(startUrl);

    if (!first.ok) throw new Error(`HTTP ${first.status} fetching start URL`);

    // 2) Try GraphQL (optional): env -> else discover from HTML
    let graphqlEndpoint = graphqlEnv;
    if (!graphqlEndpoint) {
      graphqlEndpoint = discoverGraphqlEndpointFromHtml(first.text, origin);
      // If discover just returns generic /api/graphql but it’s not real, it’ll fail and we’ll fallback.
    }

    // Attempt GraphQL only if we have something plausible
    if (graphqlEndpoint) {
      try {
        const gqlDeals = await tryGraphqlSearchAll({
          listingUrl: startUrl,
          graphqlEndpoint,
          dropCounts: out.dropCounts,
          sourceUrls: out.sourceUrls,
        });

        if (gqlDeals.length > 0) {
          out.via = "graphql";
          out.deals = gqlDeals;
          out.dealsFound = gqlDeals.length;
          out.dealsExtracted = gqlDeals.length;
        }
      } catch (e) {
        // GraphQL attempt failed -> fall back to HTML paging below
        out.sourceUrls.push(`GraphQL failed (${graphqlEndpoint}): ${e?.message || "error"}`);
      }
    }

    // 3) If GraphQL didn’t populate deals, fall back to HTML paging using offset= increments
    if (!Array.isArray(out.deals) || out.deals.length === 0) {
      out.via = "cheerio";

      const pageSize = 24;
      const maxPages = 100; // safety
      const all = [];
      const seenKeys = new Set();

      // Parse page 0 first (we already have HTML)
      {
        const { deals, tilesFound } = parseDealsFromHtml({
          html: first.text,
          baseUrl: origin,
          dropCounts: out.dropCounts,
        });

        out.dealsFound += tilesFound;
        for (const d of deals) {
          const key = d.listingURL || d.imageURL || d.listingName;
          if (seenKeys.has(key)) {
            out.dropCounts.dropped_duplicate++;
            continue;
          }
          seenKeys.add(key);
          all.push(d);
        }
      }

      // Now page forward using offset=
      for (let page = 1; page < maxPages; page++) {
        const offset = page * pageSize;

        // Replace/append offset param
        const u = new URL(startUrl);
        u.searchParams.set("offset", String(offset));
        const url = u.toString();

        const r = await fetchText(url);
        out.pagesFetched++;
        out.sourceUrls.push(url);

        if (!r.ok) break;

        const before = all.length;
        const { deals, tilesFound } = parseDealsFromHtml({
          html: r.text,
          baseUrl: origin,
          dropCounts: out.dropCounts,
        });

        out.dealsFound += tilesFound;

        for (const d of deals) {
          const key = d.listingURL || d.imageURL || d.listingName;
          if (seenKeys.has(key)) {
            out.dropCounts.dropped_duplicate++;
            continue;
          }
          seenKeys.add(key);
          all.push(d);
        }

        const added = all.length - before;

        // ✅ Critical stop condition:
        // If this page added 0 new unique deals, we're looping the same content. Stop immediately.
        if (added === 0) {
          out.dropCounts.stopped_noNewFromHtml++;
          break;
        }
      }

      out.deals = all;
      out.dealsExtracted = all.length;
    }

    // Final counts
    out.dealsExtracted = Array.isArray(out.deals) ? out.deals.length : 0;

    // 4) Write to blob
    // We “put” to the *exact* blob URL you provided, using it as pathname.
    // Vercel Blob wants a pathname, not full URL, so we extract the path.
    const blobPathname = new URL(blobUrl).pathname.replace(/^\//, "");

    await put(blobPathname, JSON.stringify(out, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    out.ok = true;
    out.error = null;
  } catch (e) {
    out.ok = false;
    out.error = e?.message || String(e);
  } finally {
    out.scrapeDurationMs = Date.now() - t0;
  }

  res.status(out.ok ? 200 : 500).json(out);
};
