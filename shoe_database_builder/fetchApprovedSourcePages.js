import { fetchPageText } from "./fetchPageText.js";
import { getApprovedSourceCandidates } from "./approvedSources.js";

function isUsablePage(page) {
  return Boolean(page?.ok && page?.url && page?.text && page.text.trim().length > 200);
}

function buildSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function looksLikeSearchOrIndexUrl(url) {
  const value = String(url || "").toLowerCase();

  return (
    value.includes("/search") ||
    value.includes("?s=") ||
    value.includes("?q=") ||
    value.includes("?query=") ||
    value.includes("/tag/") ||
    value.includes("/category/") ||
    value.includes("/reviews") ||
    value.includes("/best-")
  );
}

async function tryFetchCandidate(url, source) {
  const result = await fetchPageText(url);

  if (!isUsablePage(result)) {
    return null;
  }

  const finalUrl = result.url || url;
  if (looksLikeSearchOrIndexUrl(finalUrl)) {
    return null;
  }

  return {
    ok: true,
    url: finalUrl,
    title: result.title || null,
    text: result.text,
    source_name: source.source_name,
    source_type: source.source_type,
    priority: source.priority,
  };
}

async function resolveSourceToPage(source) {
  const directCandidates = Array.isArray(source.direct_url_candidates)
    ? source.direct_url_candidates
    : [];

  for (const url of directCandidates) {
    try {
      const page = await tryFetchCandidate(url, source);
      if (page) return page;
    } catch {}
  }

  const queries = Array.isArray(source.discovery_queries)
    ? source.discovery_queries
    : [];

  for (const query of queries) {
    const searchUrl = buildSearchUrl(query);

    try {
      const result = await fetchPageText(searchUrl);
      if (!result?.ok || !result?.text) continue;

      const text = String(result.text || "");
      const match = text.match(/https?:\/\/[^\s)>"']+/g);
      if (!match || !match.length) continue;

      for (const discoveredUrl of match) {
        try {
          const page = await tryFetchCandidate(discoveredUrl, source);
          if (page) return page;
        } catch {}
      }
    } catch {}
  }

  return null;
}

export async function fetchApprovedSourcePages(candidate) {
  const candidates = getApprovedSourceCandidates(candidate);
  const pages = [];
  const seenUrls = new Set();

  for (const source of candidates) {
    const page = await resolveSourceToPage(source);
    if (!page) {
      console.log("SOURCE_FETCH_FAIL", {
        source_name: source.source_name,
        source_type: source.source_type,
        queries: source.discovery_queries || [],
      });
      continue;
    }

    const key = String(page.url || "").toLowerCase();
    if (!key || seenUrls.has(key)) continue;
    seenUrls.add(key);

    pages.push(page);

    console.log("SOURCE_FETCH_OK", {
      source_name: page.source_name,
      source_type: page.source_type,
      source_url: page.url,
      text_length: page.text.length,
    });
  }

  return pages.sort((a, b) => a.priority - b.priority);
}

export async function fetchOneApprovedSourcePage(source) {
  return resolveSourceToPage(source);
}
