import axios from "axios";
import * as cheerio from "cheerio";

function collapseWhitespace(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
}

function extractMetaContent($, selectors) {
  for (const sel of selectors) {
    const val = $(sel).attr("content");
    if (val && String(val).trim()) return collapseWhitespace(val);
  }
  return null;
}

export async function fetchPageText(url) {
  if (!url) {
    return {
      ok: false,
      url: null,
      status: null,
      title: null,
      text: "",
      error: "No URL provided",
    };
  }

  try {
    const response = await axios.get(url, {
      timeout: 20000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const html = response.data;
    const $ = cheerio.load(html);

    $("script, style, noscript, svg").remove();

    const title =
      collapseWhitespace($("title").first().text()) ||
      extractMetaContent($, [
        'meta[property="og:title"]',
        'meta[name="twitter:title"]',
      ]) ||
      null;

    const metaDescription = extractMetaContent($, [
      'meta[name="description"]',
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
    ]);

    const bodyText = collapseWhitespace($("body").text());

    const textParts = [title, metaDescription, bodyText].filter(Boolean);
    const text = collapseWhitespace(textParts.join("\n\n")).slice(0, 25000);

    return {
      ok: true,
      url,
      status: response.status,
      title,
      text,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: error?.response?.status || null,
      title: null,
      text: "",
      error: error?.message || "Unknown fetch error",
    };
  }
}
