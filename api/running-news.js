// /api/running-news.js
// Fetches + merges RSS feeds -> returns latest N items as JSON.
//
// Feeds:
//  - https://irunfar.com/feed
//  - https://www.marathoninvestigation.com/feed
//  - https://runnersconnect.net/feed
//  - https://feeds.feedburner.com/stevemagness
//
// Usage:
//   /api/running-news?limit=12

export default async function handler(req, res) {
  try {
    const limit = clampInt(req.query.limit, 12, 1, 50);

const feeds = [
  { name: "iRunFar", url: "https://irunfar.com/feed" },
  { name: "Believe In The Run", url: "https://believeintherun.com/feed" },
  { name: "Marathon Training Academy", url: "https://www.marathontrainingacademy.com/feed" },
  { name: "Running Shoes Guru", url: "https://runningshoesguru.com/feed" },
  { name: "Marathon Investigation", url: "https://www.marathoninvestigation.com/feed" },
  { name: "Runners Connect", url: "https://runnersconnect.net/feed" },
  { name: "Steve Magness", url: "https://feeds.feedburner.com/stevemagness" },

  { name: "Track & Field News", url: "https://trackandfieldnews.com/feed/" },
  { name: "USATF Masters", url: "https://usatfmasters.org/feed/" },
];

    const results = await Promise.all(
      feeds.map(async (f) => {
        const xml = await fetchXml(f.url);
        const items = parseRssItems(xml).map((it) => ({
          ...it,
          source: f.name,
          sourceUrl: f.url,
        }));
        return items;
      })
    );

    const merged = results
      .flat()
      .filter((x) => x.title && x.link)
      .map((x) => ({
        ...x,
        publishedAt: normalizeDate(x.publishedAt),
        imageUrl: normalizeUrl(x.imageUrl),
      }))
      .filter((x) => x.publishedAt)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, limit);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600"); // 15 min
    res.status(200).json({ items: merged });
  } catch (err) {
    res.status(500).json({ error: "Failed to load feeds", details: String(err?.message || err) });
  }
}

function clampInt(v, def, min, max) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

async function fetchXml(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "ShoeBeagleRSS/1.0 (+https://shoebeagle.example)",
      "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    },
  });
  if (!r.ok) throw new Error(`Feed fetch failed (${r.status}) for ${url}`);
  return await r.text();
}

// Lightweight RSS <item> parser with image extraction.
// Extracts imageUrl from (in order):
//  1) <media:content url="...">
//  2) <media:thumbnail url="...">
//  3) <enclosure url="..." type="image/*">
//  4) first <img src="..."> found in content/description HTML
function parseRssItems(xml) {
  const items = [];
  const itemMatches = xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi);

  for (const m of itemMatches) {
    const block = m[1];

    const title = decodeXmlText(extractTag(block, "title"));
    const link = extractTag(block, "link")?.trim() || "";
    const pubDateRaw = extractTag(block, "pubDate") || extractTag(block, "dc:date") || "";

    // keep HTML sources for image extraction
    const descRaw = extractTag(block, "description") || "";
    const contentRaw = extractTag(block, "content:encoded") || "";

    const imageUrl =
      extractMediaUrl(block) ||
      extractEnclosureImageUrl(block) ||
      extractFirstImgSrc(decodeCdata(descRaw)) ||
      extractFirstImgSrc(decodeCdata(contentRaw)) ||
      "";

    const combinedForText = contentRaw || descRaw;
    const description = stripHtml(decodeCdata(decodeXmlText(combinedForText))).trim();

    items.push({
      title: title?.trim() || "",
      link: link?.trim() || "",
      publishedAt: pubDateRaw?.trim() || "",
      description: description ? description.slice(0, 220) : "",
      imageUrl: imageUrl?.trim() || "",
    });
  }

  return items;
}

function extractMediaUrl(itemXml) {
  // <media:content url="..."> or <media:thumbnail url="...">
  const m1 = itemXml.match(/<media:content\b[^>]*\burl=["']([^"']+)["'][^>]*>/i);
  if (m1?.[1]) return m1[1];

  const m2 = itemXml.match(/<media:thumbnail\b[^>]*\burl=["']([^"']+)["'][^>]*>/i);
  if (m2?.[1]) return m2[1];

  return "";
}

function extractEnclosureImageUrl(itemXml) {
  // <enclosure url="..." type="image/jpeg" />
  const m = itemXml.match(/<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*\btype=["']image\/[^"']+["'][^>]*\/?>/i);
  return m?.[1] || "";
}

function extractFirstImgSrc(htmlMaybe) {
  if (!htmlMaybe) return "";
  const html = String(htmlMaybe);

  // handle srcset too (take first URL)
  const mImg = html.match(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i);
  if (mImg?.[1]) return mImg[1];

  const mSrcset = html.match(/<img\b[^>]*\bsrcset=["']([^"']+)["'][^>]*>/i);
  if (mSrcset?.[1]) {
    const first = mSrcset[1].split(",")[0]?.trim()?.split(" ")[0]?.trim();
    return first || "";
  }

  return "";
}

function extractTag(xmlBlock, tagName) {
  const re = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "i");
  const m = xmlBlock.match(re);
  return m ? m[1] : "";
}

function normalizeDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

function normalizeUrl(u) {
  if (!u) return "";
  // basic cleanup; don’t try to “fix” too much
  return String(u).trim();
}

function decodeCdata(s) {
  return (s || "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function stripHtml(s) {
  return (s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function decodeXmlText(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
