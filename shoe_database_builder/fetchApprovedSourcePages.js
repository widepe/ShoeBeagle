import { fetchPageText } from "./fetchPageText.js";
import { getApprovedSourceCandidates } from "./approvedSources.js";
import axios from "axios";
import * as cheerio from "cheerio";

const DISALLOWED_RETAILER_HINTS = [
  "amazon.",
  "ebay.",
  "walmart.",
  "zappos.",
  "fleetfeet.",
  "dickssportinggoods.",
  "rei.",
];

function isUsablePage(page) {
  return Boolean(page?.ok && page?.url && page?.text && page.text.trim().length > 200);
}

function looksLikeNonCanonicalUrl(url) {
  const u = String(url || "").toLowerCase();

  return (
    u.includes("/search") ||
    u.includes("?q=") ||
    u.includes("?s=") ||
    u.includes("?query=") ||
    u.includes("/tag/") ||
    u.includes("/category/")
  );
}

function domainMatches(hostname, patterns = []) {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase();
  const allowed = Array.isArray(patterns) ? patterns : [];
  if (!allowed.length) return true;

  return allowed.some((pattern) => {
    const p = String(pattern || "").toLowerCase().trim();
    if (!p) return false;
    return host === p || host.endsWith(`.${p}`) || host.includes(p);
  });
}

function parseHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeSearchHref(rawHref) {
  const href = String(rawHref || "").trim();
  if (!href) return null;

  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }

  if (href.startsWith("//")) {
    return `https:${href}`;
  }

  if (href.startsWith("/l/?")) {
    try {
      const parsed = new URL(`https://duckduckgo.com${href}`);
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    } catch {
      return null;
    }
  }

  return null;
}

function extractQueryTokens(source) {
  const identity = source?.identity || {};
  const model = String(identity.model || "").toLowerCase().trim();
  const version = String(identity.version || "").toLowerCase().trim();

  return [model, version].filter(Boolean);
}

function looksLikeRelevantResult(page, source) {
  const text = String(page?.text || "").toLowerCase();
  const tokens = extractQueryTokens(source);

  if (!tokens.length) return true;
  return tokens.every((token) => text.includes(token));
}

function isAllowedSourceUrl(url, source) {
  const hostname = parseHostname(url);
  if (!hostname) return false;

  if (source?.source_type === "review") {
    return domainMatches(hostname, source.allowed_domains);
  }

  if (source?.source_type === "brand") {
    if (DISALLOWED_RETAILER_HINTS.some((x) => hostname.includes(x))) {
      return false;
    }

    return domainMatches(hostname, source.allowed_domains);
  }

  return true;
}

async function searchSourceUrls(source) {
  const queries = Array.isArray(source?.discovery_queries)
    ? source.discovery_queries.filter(Boolean).slice(0, 2)
    : [];

  const results = [];
  const seen = new Set();

  for (const q of queries) {
    try {
      const response = await axios.get("https://duckduckgo.com/html/", {
        params: { q },
        timeout: 15000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        },
      });

      const $ = cheerio.load(response.data || "");

      $(".result a.result__a").each((_, el) => {
        const href = normalizeSearchHref($(el).attr("href"));
        if (!href || seen.has(href)) return;
        seen.add(href);
        results.push(href);
      });
    } catch (error) {
      console.log("SOURCE_DISCOVERY_QUERY_ERROR", {
        source_name: source?.source_name || null,
        query: q,
        error: error?.message || String(error),
      });
    }
  }

  return results;
}

async function resolveSourceUrl(source) {
  const candidates = [];

  if (source?.source_url) candidates.push(source.source_url);

  for (const direct of Array.isArray(source?.direct_url_candidates)
    ? source.direct_url_candidates
    : []) {
    candidates.push(direct);
  }

  const discovered = await searchSourceUrls(source);
  for (const url of discovered) candidates.push(url);

  const seen = new Set();

  for (const candidateUrl of candidates) {
    const url = String(candidateUrl || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    if (!isAllowedSourceUrl(url, source)) continue;
    if (looksLikeNonCanonicalUrl(url)) continue;

    return url;
  }

  return null;
}

async function fetchSingleSource(source) {
  const resolvedUrl = await resolveSourceUrl(source);
  if (!resolvedUrl) return null;

  try {
    const result = await fetchPageText(resolvedUrl);

    if (!isUsablePage(result)) {
      console.log("SOURCE_FETCH_FAIL", {
        source_name: source.source_name,
        source_url: resolvedUrl,
        ok: result?.ok || false,
        error: result?.error || "unusable_page",
      });
      return null;
    }

    const finalUrl = result.url || resolvedUrl;

    if (looksLikeNonCanonicalUrl(finalUrl)) {
      console.log("SOURCE_FETCH_SKIP_NONCANONICAL", {
        source_name: source.source_name,
        source_url: finalUrl,
      });
      return null;
    }
    if (!isAllowedSourceUrl(finalUrl, source)) {
      console.log("SOURCE_FETCH_SKIP_DOMAIN", {
        source_name: source.source_name,
        source_url: finalUrl,
      });
      return null;
    }
    if (!looksLikeRelevantResult(result, source)) {
      console.log("SOURCE_FETCH_SKIP_IRRELEVANT", {
        source_name: source.source_name,
        source_url: finalUrl,
      });
      return null;
    }

    const page = {
      ok: true,
      url: finalUrl,
      title: result.title || null,
      text: result.text,
      source_name: source.source_name,
      source_type: source.source_type,
      priority: source.priority,
    };

    console.log("SOURCE_FETCH_OK", {
      source_name: page.source_name,
      source_url: page.url,
      text_length: page.text.length,
    });

    return page;
  } catch (error) {
    console.log("SOURCE_FETCH_ERROR", {
      source_name: source.source_name,
      source_url: resolvedUrl,
      error: error?.message || String(error),
    });
    return null;
  }
}

export async function fetchApprovedSourcePages(candidate) {
  const candidates = getApprovedSourceCandidates(candidate);
  const pages = [];
  const seenUrls = new Set();

  for (const source of candidates) {
    const page = await fetchSingleSource(source);
    if (!page) continue;

    const key = String(page.url || "").toLowerCase();
    if (!key || seenUrls.has(key)) continue;

    seenUrls.add(key);
    pages.push(page);
  }

  return pages.sort((a, b) => a.priority - b.priority);
}

export async function fetchApprovedSourcePage(source) {
  return fetchSingleSource(source);
}
