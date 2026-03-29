// /lib/modelNameCleaner.js

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripBrandPrefix(text, brand, brandAliases = []) {
  let out = String(text || "").trim();
  const aliases = [brand, ...brandAliases].filter(Boolean);

  for (const alias of aliases) {
    const re = new RegExp(`^${escapeRegex(alias)}\\s+`, "i");
    out = out.replace(re, "").trim();
  }

  return out;
}

function extractVersion(text) {
  const s = normalizeWhitespace(text);

  // v3 / V4
  let m = s.match(/\bv\s*([1-9]\d?)\b/i);
  if (m) {
    return { version: m[1], textWithoutVersion: normalizeWhitespace(s.replace(m[0], " ")) };
  }

  // trailing version number, usually 1-49
  m = s.match(/\b([1-9]\d?)\b\s*$/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n < 50) {
      return { version: String(n), textWithoutVersion: normalizeWhitespace(s.replace(/\b([1-9]\d?)\b\s*$/, " ")) };
    }
  }

  return { version: null, textWithoutVersion: s };
}

function stripGender(text) {
  return normalizeWhitespace(
    String(text || "")
      .replace(/\bmen'?s\b/gi, " ")
      .replace(/\bwomen'?s\b/gi, " ")
      .replace(/\bunisex\b/gi, " ")
      .replace(/\bfor men\b/gi, " ")
      .replace(/\bfor women\b/gi, " ")
      .replace(/\bfor runners\b/gi, " ")
  );
}

function stripShoeTypeWords(text) {
  return normalizeWhitespace(
    String(text || "")
      .replace(/\btrail running shoes?\b/gi, " ")
      .replace(/\broad running shoes?\b/gi, " ")
      .replace(/\brunning shoes?\b/gi, " ")
      .replace(/\brunning shoe\b/gi, " ")
      .replace(/\btrail shoes?\b/gi, " ")
      .replace(/\btrack(?: & field)? shoes?\b/gi, " ")
      .replace(/\brace shoes?\b/gi, " ")
      .replace(/\bwalking shoes?\b/gi, " ")
      .replace(/\bslip-?ons?\b/gi, " ")
      .replace(/\bspikes?\b/gi, " ")
  );
}

function stripWidths(text) {
  return normalizeWhitespace(
    String(text || "")
      .replace(/\bregular\s*\([^)]+\)/gi, " ")
      .replace(/\bwide\s*\([^)]+\)/gi, " ")
      .replace(/\bextra\s*wide\s*\([^)]+\)/gi, " ")
      .replace(/\bnarrow\s*\([^)]+\)/gi, " ")
      .replace(/\bmedium\s*\([^)]+\)/gi, " ")
      .replace(/\bwidth\s*[A-Z0-9]+\b/gi, " ")
      .replace(/\b(?:2E|4E|D|B|EE)\b/gi, " ")
  );
}

function stripPromoNoise(text) {
  return normalizeWhitespace(
    String(text || "")
      .replace(/^(clearance|sale|new|limited|hot|deal)\s+/gi, "")
      .replace(/\b(all sales? final|no returns?|final sale|non-returnable|as-is)\b/gi, " ")
      .replace(/\b(free (shipping|returns)|ships? free|fast shipping)\b/gi, " ")
      .replace(/\b(best seller|top rated|customer favorite|staff picks?)\b/gi, " ")
      .replace(/\b(limited (time|edition)|while supplies last)\b/gi, " ")
      .replace(/\b(new arrival|just in|back in stock|low stock|almost gone)\b/gi, " ")
      .replace(/\b(brand new|new with(out)? box|open box|like new)\b/gi, " ")
      .replace(/\b(in stock|pre-?order|coming soon)\b/gi, " ")
      .replace(/\b(hot deal|deal of the day)\b/gi, " ")
      .replace(/\b(save|on sale|discounted|reduced)\b/gi, " ")
      .replace(/\b\d+%\s*off\b/gi, " ")
      .replace(/\b(was|now|reg|originally)\s*\$[\d,.]+\b/gi, " ")
      .replace(/\b(original|sale)\s*price\b/gi, " ")
      .replace(/\$\s*[\d,]+(?:\.\d{1,2})?/g, " ")
      .replace(/[\*†]/g, " ")
  );
}

function stripParenChunks(text) {
  return normalizeWhitespace(String(text || "").replace(/\([^)]*\)/g, " "));
}

function looksLikeColorTail(part) {
  const p = normalizeWhitespace(part);
  if (!p) return false;

  // slash-heavy endings are very often colors
  if (p.includes("/")) return true;

  // many color-like words in a short tail
  const words = p.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 5) return true;

  return false;
}

function stripTrailingColorTail(text) {
  let s = normalizeWhitespace(text);

  // split on spaced hyphen chunks, often model - color
  const hyphenParts = s.split(/\s+-\s+/);
  if (hyphenParts.length > 1) {
    const last = hyphenParts[hyphenParts.length - 1];
    if (looksLikeColorTail(last)) {
      hyphenParts.pop();
      s = normalizeWhitespace(hyphenParts.join(" - "));
    }
  }

  // split on final comma chunk
  const commaParts = s.split(/\s*,\s*/);
  if (commaParts.length > 1) {
    const last = commaParts[commaParts.length - 1];
    if (looksLikeColorTail(last)) {
      commaParts.pop();
      s = normalizeWhitespace(commaParts.join(", "));
    }
  }

  // final slash-heavy tail after space
  s = s.replace(/\s+[A-Za-z]+(?:\/[A-Za-z]+){1,4}\s*$/g, "");

  return normalizeWhitespace(s);
}

function cleanModelName(input, opts = {}) {
  const brand = opts.brand || "";
  const brandAliases = Array.isArray(opts.brandAliases) ? opts.brandAliases : [];

  let s = normalizeWhitespace(input);
  if (!s) {
    return {
      cleanedModel: "",
      modelBase: "",
      version: null,
    };
  }

  s = stripPromoNoise(s);
  s = stripBrandPrefix(s, brand, brandAliases);
  s = stripGender(s);
  s = stripShoeTypeWords(s);
  s = stripWidths(s);
  s = stripParenChunks(s);
  s = stripTrailingColorTail(s);
  s = normalizeWhitespace(s);

  const { version, textWithoutVersion } = extractVersion(s);
  s = normalizeWhitespace(textWithoutVersion);

  s = s.replace(/\s{2,}/g, " ").trim();

  return {
    cleanedModel: s,
    modelBase: s,
    version,
  };
}

module.exports = { cleanModelName };
