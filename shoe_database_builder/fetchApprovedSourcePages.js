import { fetchPageText } from "./fetchPageText.js";
import { getApprovedSourceCandidates } from "./approvedSources.js";

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

async function fetchSingleSource(source) {
  if (!source?.source_url) {
    return null;
  }

  try {
    const result = await fetchPageText(source.source_url);

    if (!isUsablePage(result)) {
      console.log("SOURCE_FETCH_FAIL", {
        source_name: source.source_name,
        source_url: source.source_url,
        ok: result?.ok || false,
        error: result?.error || "unusable_page",
      });
      return null;
    }

    const finalUrl = result.url || source.source_url;

    if (looksLikeNonCanonicalUrl(finalUrl)) {
      console.log("SOURCE_FETCH_SKIP_NONCANONICAL", {
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
      source_url: source.source_url,
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
