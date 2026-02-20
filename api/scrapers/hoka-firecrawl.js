// /api/scrapers/hoka-sale.js
//
// HOKA Sale (Shoes) scraper
// URL: https://www.hoka.com/en/us/sale/?prefn1=type&prefv1=shoes
//
// RULES (per you):
// - Gender MUST be present in the listing tile text (NO fallback to URL or elsewhere).
// - Allowed genders only: "womens", "mens", "unisex"
// - If gender missing OR not one of those -> EXCLUDE the deal.
// - Keep unisex if explicitly present.
// - Deal included only if BOTH sale and original prices are present as numbers.
//
// Output schema aligns with Shoe Beagle canonical fields.

const cheerio = require("cheerio");

const TARGET_URL = "https://www.hoka.com/en/us/sale/?prefn1=type&prefv1=shoes";

function nowIso() {
  return new Date().toISOString();
}

function toAbsUrl(href) {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  return new URL(href, "https://www.hoka.com").toString();
}

function parseMoney(s) {
  const m = String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function normalizeGenderFromListing(label) {
  const s = String(label || "").trim().toLowerCase();

  // NO fallback. If empty => reject.
  if (!s) return null;

  if (s === "women" || s === "women's" || s === "womens") return "womens";
  if (s === "men" || s === "men's" || s === "mens") return "mens";
  if (s === "unisex") return "unisex";

  return null;
}

// Try common price patterns you might see on SFCC / Deckers sites.
// We REQUIRE both sale & original; if we can't confidently find both, skip.
function extractPrices($tile) {
  // sale often appears in: .price .sales
  const saleText =
    $tile.find(".price .sales").first().text().trim() ||
    $tile.find(".sales").first().text().trim() ||
    "";

  // original often appears in: .price .strike-through, .price .list, .price .value (varies)
  const originalText =
    $tile.find(".price .strike-through").first().text().trim() ||
    $tile.find(".price .list").first().text().trim() ||
    $tile.find(".strike-through").first().text().trim() ||
    $tile.find(".list").first().text().trim() ||
    "";

  const salePrice = parseMoney(saleText);
  const originalPrice = parseMoney(originalText);

  // Require both
  if (salePrice == null || originalPrice == null) return null;

  // Basic sanity
  if (originalPrice <= 0 || salePrice <= 0) return null;

  return { salePrice, originalPrice };
}

function computeDiscountPercent(salePrice, originalPrice) {
  if (!Number.isFinite(salePrice) || !Number.isFinite(originalPrice) || originalPrice <= 0) return null;
  const pct = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  if (!Number.isFinite(pct)) return null;
  // allow 0% but usually sale < original
  return pct;
}

module.exports = async function handler(req, res) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 25000);

    const resp = await fetch(TARGET_URL, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    }).finally(() => clearTimeout(t));

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return res.status(502).json({
        success: false,
        error: `Fetch failed: ${resp.status} ${resp.statusText}`,
        url: TARGET_URL,
        sample: text ? text.slice(0, 400) : null,
        lastUpdated: nowIso(),
      });
    }

    const html = await resp.text();
    const $ = cheerio.load(html);

    const deals = [];

    // This matches your snippet: div.tile-suggest ... a.product-suggestion__link ... etc.
    $(".tile-suggest").each((_, el) => {
      const $tile = $(el);

      const a = $tile.find("a.product-suggestion__link").first();
      const href = a.attr("href") || "";
      const listingURL = toAbsUrl(href);
      if (!listingURL) return;

      // ✅ Gender MUST come from listing label ONLY (NO fallback)
      const genderLabel = $tile.find(".name > span").first().text();
      const gender = normalizeGenderFromListing(genderLabel);
      if (!gender) return; // exclude if missing/unknown

      // Product name (model) from listing tile
      // Your snippet is:
      // <div class="name"><span>Women's</span><br/>Bondi 9</div>
      // We'll take the text content of .name, remove the gender label, and trim.
      let nameText = $tile.find(".name").first().text().replace(/\s+/g, " ").trim();
      const gl = String(genderLabel || "").replace(/\s+/g, " ").trim();
      if (gl) nameText = nameText.replace(new RegExp(`^${escapeRegExp(gl)}\\s*`, "i"), "").trim();
      const modelName = nameText || null;
      if (!modelName) return;

      // Image
      const img = $tile.find("img.suggestion-img, img").first();
      const imageURL = img.attr("data-src") || img.attr("src") || null;

      // Prices: require both sale + original
      const prices = extractPrices($tile);
      if (!prices) return;

      const { salePrice, originalPrice } = prices;
      const discountPercent = computeDiscountPercent(salePrice, originalPrice);

      // listingName: keep it simple and stable (don’t “parse-clean” it)
      // NOTE: You did not mention a listingName rule here; this preserves the visible name.
      const listingName = `${genderLabel ? String(genderLabel).trim() : ""} ${modelName}`.trim();

      deals.push({
        listingName,
        brand: "hoka",
        model: modelName,

        salePrice,
        originalPrice,
        discountPercent,

        store: "HOKA",
        listingURL,
        imageURL,

        gender,
        shoeType: "shoes",
      });
    });

    return res.status(200).json({
      success: true,
      store: "HOKA",
      url: TARGET_URL,
      lastUpdated: nowIso(),
      totalDeals: deals.length,
      deals,
      metadata: {
        genderRule: "MUST be present in tile listing label; no fallback; allowed: womens/mens/unisex",
        priceRule: "requires both salePrice and originalPrice",
      },
    });
  } catch (err) {
    const msg = err && err.name === "AbortError" ? "Fetch timed out" : String(err?.message || err);
    return res.status(500).json({
      success: false,
      error: msg,
      url: TARGET_URL,
      lastUpdated: nowIso(),
    });
  }
};

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
