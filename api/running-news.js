// /api/running-news.js
// Fetches + merges RSS feeds -> returns latest N items as JSON.
//
// Feeds:
//  - https://irunfar.com/feed
//  - https://www.marathoninvestigation.com/feed
//
// Usage:
//   /api/running-news?limit=12

export default async function handler(req, res) {
  try {
    const limit = clampInt(req.query.limit, 12, 1, 50);

const feeds = [
  { name: "iRunFar", url: "https://irunfar.com/feed" },
  { name: "Marathon Investigation", url: "https://www.marathoninvestigation.com/feed" },
  { name: "Runners Connect", url: "https://runnersconnect.net/feed" },
  { name: "Steve Magness", url: "https://feeds.feedburner.com/stevemagness" },
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
        // Normalize date
        publishedAt: normalizeDate(x.publishedAt),
      }))
      .filter((x) => x.publishedAt) // keep only dated items
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, limit);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // Cache a bit on Vercel edge/CDN
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

// Very lightweight RSS <item> parser (WordPress-style RSS)
// (No deps; good enough for these two feeds.)
function parseRssItems(xml) {
  const items = [];
  const itemMatches = xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi);

  for (const m of itemMatches) {
    const block = m[1];

    const title = decodeXmlText(extractTag(block, "title"));
    const link = extractTag(block, "link")?.trim() || "";
    const pubDateRaw = extractTag(block, "pubDate") || extractTag(block, "dc:date") || "";
    const descRaw = extractTag(block, "description") || extractTag(block, "content:encoded") || "";

    const description = stripHtml(decodeCdata(decodeXmlText(descRaw))).trim();

    items.push({
      title: title?.trim() || "",
      link: link?.trim() || "",
      publishedAt: pubDateRaw?.trim() || "",
      description: description ? description.slice(0, 220) : "", // keep short
    });
  }

  return items;
}

function extractTag(xmlBlock, tagName) {
  // Handles <tag>...</tag> including namespaces like dc:date, content:encoded
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
