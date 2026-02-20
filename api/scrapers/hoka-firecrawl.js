const cheerio = require("cheerio");

function decodeHtmlEntities(s = "") {
  // Minimal decode for the patterns you’ll see in data-* JSON
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function absUrl(href, base = "https://www.hoka.com") {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  return base.replace(/\/+$/, "") + "/" + href.replace(/^\/+/, "");
}

function parseMoney(text) {
  // "$112.00" -> 112, "112.00" -> 112
  if (!text) return null;
  const m = String(text).replace(/,/g, "").match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/**
 * Parse one Hoka product tile HTML node (the `.product` wrapper or its inner HTML).
 * Returns Shoe Beagle canonical-ish object. (You still need to find originalPrice.)
 */
function parseHokaProductTile(tileHtml) {
  const $ = cheerio.load(tileHtml);

  const $product = $(".product").first();
  const $imgContainer = $product.find(".image-container[data-product-price]").first();
  const $link = $product.find('a.js-pdp-link.pdp-link').first();
  const $img = $product.find("img.tile-image").first();

  // ✅ listingName: pick the cleanest raw source you have (don’t mutate later)
  const listingName =
    $imgContainer.attr("data-product-name") ||
    $img.attr("alt") ||
    null;

  const listingURL = absUrl($link.attr("href"));
  const imageURL = $img.attr("src") || $img.attr("data-src") || null;

  const salePrice = parseMoney($imgContainer.attr("data-product-price"));

  // 🔎 original price: NOT shown in your snippet.
  // Common patterns to try:
  // - ".price .value" / ".strike-through" / ".price--original" etc.
  // You’ll need to inspect the rest of the tile HTML to confirm the selector.
  const originalPrice =
    parseMoney($product.find(".price .strike-through, .price .price--original, .product-price__original").first().text()) ||
    null;

  // Sizes: data-all-sizes is JSON but HTML-escaped
  let allSizes = null;
  const rawSizes = $product.attr("data-all-sizes");
  if (rawSizes) {
    try {
      allSizes = JSON.parse(decodeHtmlEntities(rawSizes));
    } catch (e) {
      allSizes = null;
    }
  }

  return {
    listingName,         // IMPORTANT: keep exactly what you set here
    brand: "hoka",
    model: listingName,  // or parse model from listingName if you want
    salePrice,
    originalPrice,
    store: "HOKA",
    listingURL,
    imageURL,
    gender: "unknown",
    shoeType: "unknown",
    // optional debug:
    _sizes: allSizes,
  };
}
