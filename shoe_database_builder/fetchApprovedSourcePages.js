import { fetchPageText } from "./fetchPageText.js";
import { getApprovedSourceCandidates } from "./approvedSources.js";

function isUsablePage(page) {
  return Boolean(page?.ok && page?.url && page?.text && page.text.trim().length > 200);
}

export async function fetchApprovedSourcePages(candidate) {
  const candidates = getApprovedSourceCandidates(candidate);
  const pages = [];
  const seenUrls = new Set();

  for (const source of candidates) {
    try {
      const result = await fetchPageText(source.source_url);

      if (!isUsablePage(result)) {
        console.log("SOURCE_FETCH_FAIL", {
          source_name: source.source_name,
          source_url: source.source_url,
          ok: result?.ok || false,
          error: result?.error || "unusable_page",
        });
        continue;
      }

      const finalUrl = result.url || source.source_url;
      const dedupeKey = String(finalUrl).toLowerCase();

      if (seenUrls.has(dedupeKey)) {
        continue;
      }

      seenUrls.add(dedupeKey);

      pages.push({
        ok: true,
        url: finalUrl,
        title: result.title || null,
        text: result.text,
        source_name: source.source_name,
        source_type: source.source_type,
        priority: source.priority,
      });

      console.log("SOURCE_FETCH_OK", {
        source_name: source.source_name,
        source_url: finalUrl,
        text_length: result.text.length,
      });
    } catch (error) {
      console.log("SOURCE_FETCH_ERROR", {
        source_name: source.source_name,
        source_url: source.source_url,
        error: error?.message || String(error),
      });
    }
  }

  return pages.sort((a, b) => a.priority - b.priority);
}
