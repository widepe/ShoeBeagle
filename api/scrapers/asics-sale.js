// api/scrapers/asics-sale.js
//
// ASICS scraper using Puppeteer on Vercel (serverless-friendly Chromium).
// This replaces Firecrawl because Firecrawl is getting blocked (500: all engines failed).
//
// Dependencies:
//   npm i puppeteer-core @sparticuz/chromium
//
// Env vars required:
//   BLOB_READ_WRITE_TOKEN  (for @vercel/blob)
// Optional:
//   ASICS_DEBUG_HTML=1      (write debug HTML blobs)
//   ASICS_DEBUG_SHOT=1      (write a debug screenshot blob)
//
// Output schema (matches merge-deals):
//   { title, brand, model, salePrice, price, store, url, image, gender, shoeType }

const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const { put } = require("@vercel/blob");

function normalizeGender(raw) {
  const g = String(raw || "").trim().toLowerCase();
  if (g === "mens" || g === "men" || g === "m") return "mens";
  if (g === "womens" || g === "women" || g === "w" || g === "ladies") return "womens";
  if (g === "unisex" || g === "u") return "unisex";
  return "unisex";
}

function detectShoeType(title, model) {
  const combined = ((title || "") + " " + (model || "")).toLowerCase();
  if (/\b(trail|trabuco|fujitrabuco|fuji)\b/i.test(combined)) return "trail";
  if (/\b(track|spike|japan|metaspeed|magic speed)\b/i.test(combined)) return "track";
  return "road";
}

function parseMoney(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const s = String(value);
  const m = s.match(/([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function absolutize(url) {
  if (!url) return null;
  const u = String(url).trim();
  if (!u) return null;
  if (u.startsWith("http")) return u;
  if (u.startsWith("//")) return `https:${u}`;
  if (u.startsWith("/")) return `https://www.asics.com${u}`;
  return `https://www.asics.com/${u}`;
}

async function launchBrowser() {
  const isVercel = !!process.env.VERCEL;

  const executablePath = isVercel ? await chromium.executablePath() : undefined;

  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });
}

async function scrapePage(page, url, gender) {
  const result = {
    page: gender,
    success: false,
    count: 0,
    error: null,
    url,
  };

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

    // Some sites lazy-load; give a beat
    await page.waitForTimeout(1500);

    // Try to wait for any product link (.html) to appear
    // If it never appears, we still proceed and try JSON-LD.
    try {
      await page.waitForSelector('a[href$=".html"]', { timeout: 12000 });
    } catch (_) {}

    // Optional debug HTML
    if (process.env.ASICS_DEBUG_HTML === "1") {
      const html = await page.content();
      const safe = gender.replace(/\W+/g, "-").toLowerCase();
      await put(`debug-asics-${safe}.html`, html, { access: "public", addRandomSuffix: false });
    }

    // Optional screenshot
    if (process.env.ASICS_DEBUG_SHOT === "1") {
      const buf = await page.screenshot({ fullPage: true, type: "png" });
      const safe = gender.replace(/\W+/g, "-").toLowerCase();
      await put(`debug-asics-${safe}.png`, buf, { access: "public", addRandomSuffix: false });
    }

    // Extract in page context
    const items = await page.evaluate(() => {
      const out = [];

      // 1) JSON-LD Product data (best if present)
      const ldNodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const n of ldNodes) {
        try {
          const json = JSON.parse(n.textContent || "null");
          const arr = Array.isArray(json) ? json : [json];
          for (const obj of arr) {
            if (!obj) continue;

            // Some pages: { "@type":"ItemList", "itemListElement":[{item:{@type:"Product"...}}] }
            const list = obj.itemListElement || obj.itemListElements || null;
            if (Array.isArray(list)) {
              for (const el of list) {
                const p = el?.item || el;
                if (p && (p["@type"] === "Product" || p["@type"] === "IndividualProduct")) {
                  out.push({
                    title: p.name || null,
                    url: p.url || null,
                    image: Array.isArray(p.image) ? p.image[0] : p.image || null,
                    offers: p.offers || null,
                  });
                }
              }
            }

            if (obj["@type"] === "Product" || obj["@type"] === "IndividualProduct") {
              out.push({
                title: obj.name || null,
                url: obj.url || null,
                image: Array.isArray(obj.image) ? obj.image[0] : obj.image || null,
                offers: obj.offers || null,
              });
            }
          }
        } catch (_) {}
      }

      // 2) If JSON-LD gave nothing, try DOM links
      if (out.length === 0) {
        const links = Array.from(document.querySelectorAll('a[href$=".html"]'))
          .map((a) => ({
            url: a.getAttribute("href") || "",
            title: a.getAttribute("aria-label") || a.textContent || "",
            node: a,
          }))
          .filter((x) => x.url && x.url.includes("/us/en-us/") && x.title && x.title.trim().length > 3);

        // Deduplicate by href
        const seen = new Set();
        for (const l of links) {
          if (seen.has(l.url)) continue;
          seen.add(l.url);

          // attempt to find an image near the link
          const card = l.node.closest("li, article, div");
          const img = card ? card.querySelector("img") : null;

          out.push({
            title: (l.title || "").replace(/\s+/g, " ").trim(),
            url: l.url,
            image: img?.getAttribute("src") || img?.getAttribute("data-src") || img?.getAttribute("srcset") || null,
            offers: null,
          });
        }
      }

      return out;
    });

    // Normalize to your schema
    const deals = [];

    for (const it of items) {
      const titleRaw = (it.title || "").replace(/\s+/g, " ").trim();
      if (!titleRaw || titleRaw.length < 3) continue;

      const urlAbs = absolutize(it.url);
      if (!urlAbs) continue;

      // Offers may be object or array
      const offers = it.offers;
      let price = null;
      let salePrice = null;

      // Try interpret structured offers
      if (offers) {
        const o = Array.isArray(offers) ? offers[0] : offers;

        // Some schemas include price and priceSpecification
        const p1 = o?.price;
        const p2 = o?.highPrice; // sometimes
        const p3 = o?.priceSpecification?.price;

        // If there's a "price" and also "priceSpecification" we can attempt
        const candidate = parseMoney(p1) ?? parseMoney(p3) ?? parseMoney(p2);

        // We don't know original vs sale from LD reliably; keep as salePrice if only one.
        salePrice = candidate;
      }

      // If no structured offers, leave nulls; merge-deals will filter out if needed.
      const model = titleRaw.replace(/^ASICS\s+/i, "").trim();
      const genderNorm = normalizeGender(gender);

      deals.push({
        title: titleRaw,
        brand: "ASICS",
        model,
        salePrice: salePrice != null ? salePrice : null,
        price: price != null ? price : null,
        store: "ASICS",
        url: urlAbs,
        image: absolutize(it.image) || null,
        gender: genderNorm,
        shoeType: detectShoeType(titleRaw, model),
      });
    }

    // Dedup by url
    const uniq = [];
    const seen = new Set();
    for (const d of deals) {
      if (!d.url) continue;
      if (seen.has(d.url)) continue;
      seen.add(d.url);
      uniq.push(d);
    }

    result.success = true;
    result.count = uniq.length;
    return { result, deals: uniq };
  } catch (e) {
    result.success = false;
    result.error = e?.message || String(e);
    return { result, deals: [] };
  }
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // NOTE: re-enable CRON_SECRET guard after testing
  // const cronSecret = process.env.CRON_SECRET;
  // if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
  //   return res.status(401).json({ error: "Unauthorized" });
  // }

  const start = Date.now();

  const pages = [
    {
      url: "https://www.asics.com/us/en-us/mens-clearance-shoes/c/aa60101000/running/",
      label: "Men's Clearance",
      gender: "mens",
    },
    {
      url: "https://www.asics.com/us/en-us/womens-clearance-shoes/c/aa20106000/running/",
      label: "Women's Clearance",
      gender: "womens",
    },
    {
      url: "https://www.asics.com/us/en-us/styles-leaving-asics-com/c/aa60400001/running/?prefn1=c_productGender&prefv1=Women%7CMen",
      label: "Last Chance Styles",
      gender: "unisex",
    },
  ];

  let browser = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // A realistic UA helps sometimes
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );

    const allDeals = [];
    const pageResults = [];

    for (const p of pages) {
      const { result, deals } = await scrapePage(page, p.url, p.label);
      pageResults.push(result);
      allDeals.push(...deals);

      // tiny delay between pages
      await page.waitForTimeout(1500);
    }

    // dealsByGender counts
    const dealsByGender = { mens: 0, womens: 0, unisex: 0 };
    for (const d of allDeals) {
      const g = normalizeGender(d.gender);
      d.gender = g;
      dealsByGender[g] += 1;
    }

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "ASICS",
      segments: ["Men's Clearance", "Women's Clearance", "Last Chance Styles"],
      totalDeals: allDeals.length,
      dealsByGender,
      pageResults,
      deals: allDeals,
    };

    const blob = await put("asics-sale.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;

    return res.status(200).json({
      success: true,
      totalDeals: allDeals.length,
      dealsByGender,
      pageResults,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated,
      note:
        "This endpoint uses puppeteer-core + @sparticuz/chromium. If ASICS blocks headless, you may need a proxy/residential scraping service.",
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e?.message || String(e),
      duration: `${Date.now() - start}ms`,
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }
};
