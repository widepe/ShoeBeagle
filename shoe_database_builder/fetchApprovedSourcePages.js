import { fetchPageText } from "./fetchPageText.js";
import { getApprovedSourceCandidates } from "./approvedSources.js";

function isUsablePage(page) {
  return Boolean(page?.ok && page?.url && page?.text && page.text.trim().length > 200);
}

async function fetchOneSource(source) {
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

    return {
      ok: true,
      url: result.url || source.source_url,
      title: result.title || null,
      text: result.text,
      source_name: source.source_name,
      source_type: source.source_type,
      priority: source.priority,
    };
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
    const page = await fetchOneSource(source);
    if (!page) continue;

    const dedupeKey = String(page.url || "").toLowerCase();
    if (!dedupeKey || seenUrls.has(dedupeKey)) continue;

    seenUrls.add(dedupeKey);
    pages.push(page);

    console.log("SOURCE_FETCH_OK", {
      source_name: page.source_name,
      source_url: page.url,
      text_length: page.text.length,
    });
  }

  return pages.sort((a, b) => a.priority - b.priority);
}

export async function fetchOneApprovedSourcePage(source) {
  return fetchOneSource(source);
}
