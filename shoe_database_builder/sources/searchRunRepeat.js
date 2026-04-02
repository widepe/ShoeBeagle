export async function searchRunRepeat({ brand, raw_model_text }) {
  const query = encodeURIComponent(`${brand} ${raw_model_text} RunRepeat`);
  const url = `https://duckduckgo.com/html/?q=${query}`;

  try {
    const res = await fetch(url);
    const html = await res.text();

    // Find first RunRepeat link
    const match = html.match(/https:\/\/runrepeat\.com\/[^"]+/i);

    if (!match) return null;

    const pageUrl = match[0];

    const pageRes = await fetch(pageUrl);
    const pageHtml = await pageRes.text();

    const text = pageHtml
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      source_name: "RunRepeat",
      source_type: "review",
      source_url: pageUrl,
      text,
    };
  } catch (err) {
    console.error("RunRepeat fetch failed:", err.message);
    return null;
  }
}
