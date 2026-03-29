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

  // decimal versions like 1.0, 2.0, 3.5 (must come FIRST)
  let m = s.match(/\b([1-9]\d?\.\d)\b/);
  if (m) {
    return {
      version: m[1],
      matchText: m[0],
      index: m.index,
    };
  }
  
  // v8 / V14
     m = s.match(/\bv\s*([1-9]\d?)\b/i);  if (m) {
    return {
      version: m[1],
      matchText: m[0],
      index: m.index,
    };
  }

  // trailing number under 60 as oldest version shoe is Pegasus since 1983
  m = s.match(/\b([1-9]\d?)\b(?!.*\b[1-9]\d?\b)/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n < 60) {
      return {
        version: String(n),
        matchText: m[0],
        index: m.index,
      };
    }
  }

  return {
    version: null,
    matchText: null,
    index: -1,
  };
}

function keepUpToVersion(text, versionInfo) {
  if (!versionInfo || !versionInfo.version || versionInfo.index < 0) {
    return normalizeWhitespace(text);
  }

  const end = versionInfo.index + versionInfo.matchText.length;
  return normalizeWhitespace(String(text || "").slice(0, end));
}

function stripGender(text) {
  return normalizeWhitespace(
    String(text || "")
      .replace(/\bmen'?s\b/gi, " ")
      .replace(/\bwomen'?s\b/gi, " ")
      .replace(/\bunisex\b/gi, " ")
      .replace(/\bfor men\b/gi, " ")
      .replace(/\bfor women\b/gi, " ")
  );
}

function stripShoeTypeWords(text) {
  const before = normalizeWhitespace(String(text || ""));
  const after = normalizeWhitespace(
    before
      .replace(/\btrail running shoes?\b/gi, " ")
      .replace(/\broad running shoes?\b/gi, " ")
      .replace(/\brunning shoes?\b/gi, " ")
      .replace(/\brunning shoe\b/gi, " ")
      .replace(/\btrail shoes?\b/gi, " ")
      .replace(/\btrack(?: & field)? shoes?\b/gi, " ")
      .replace(/\brace shoes?\b/gi, " ")
      .replace(/\bwalking shoes?\b/gi, " ")
      .replace(/\btraining shoes?\b/gi, " ")
      .replace(/\btraining shoe\b/gi, " ")
      .replace(/\bsneakers?\b/gi, " ")
      .replace(/\btennis shoes?\b/gi, " ")
      .replace(/\bgolf shoes?\b/gi, " ")
      .replace(/\bhiking shoes?\b/gi, " ")
      .replace(/\bslip-?ons?\b/gi, " ")
      .replace(/\bspikes?\b/gi, " ")
  );

  return {
    text: after,
    removed: after !== before,
  };
}

function stripWidths(text) {
  return normalizeWhitespace(
    String(text || "")
      .replace(/\(\s*wide width\s*\)/gi, " ")
      .replace(/\(\s*extra wide width\s*\)/gi, " ")
      .replace(/\(\s*narrow width\s*\)/gi, " ")
      .replace(/\bwide width\b/gi, " ")
      .replace(/\bextra wide width\b/gi, " ")
      .replace(/\bnarrow width\b/gi, " ")
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

  // Strong signal: slash-separated colors
  if (p.includes("/")) return true;

  // 1-3 plain words at the end are often colors
  const words = p.split(/\s+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 3) {
    // avoid obvious model-ish words
    const joined = words.join(" ").toLowerCase();
    if (
      /\b(max|elite|pro|trainer|trail|tempo|turbo|boost|nitro|flow|ride|speed|fly|pegasus|vomero|ghost|bondi|clifton|kayano|nimbus)\b/i.test(
        joined
      )
    ) {
      return false;
    }
    return true;
  }

  return false;
}

function stripTrailingColorTail(text) {
  let s = normalizeWhitespace(text);

  // Hyphen tail: "Model 2 - Blue/Gold"
  const hyphenParts = s.split(/\s+-\s+/);
  if (hyphenParts.length > 1) {
    const last = hyphenParts[hyphenParts.length - 1];
    if (looksLikeColorTail(last)) {
      hyphenParts.pop();
      s = normalizeWhitespace(hyphenParts.join(" - "));
    }
  }

  // Comma tail
  const commaParts = s.split(/\s*,\s*/);
  if (commaParts.length > 1) {
    const last = commaParts[commaParts.length - 1];
    if (looksLikeColorTail(last)) {
      commaParts.pop();
      s = normalizeWhitespace(commaParts.join(", "));
    }
  }

  // Final slash tail
  s = s.replace(/\s+[A-Za-z]+(?:\/[A-Za-z]+){1,4}\s*$/g, "");

  // Final 1-word color-like tail, only if enough model remains
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 3) {
    const tail = words[words.length - 1];
    if (/^[A-Za-z]+$/.test(tail) && looksLikeColorTail(tail)) {
      words.pop();
      s = words.join(" ");
    }
  }

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

  const shoeTypeResult = stripShoeTypeWords(s);
  s = shoeTypeResult.text;

  s = stripWidths(s);
  s = stripParenChunks(s);
  s = normalizeWhitespace(s);

  const versionInfo = extractVersion(s);
  const version = versionInfo.version;

  // Do NOT cut at version.
  // Just strip known junk from the tail.
  s = stripTrailingColorTail(s);

  s = normalizeWhitespace(s);

  return {
    cleanedModel: s,
    modelBase: s,
    version,
  };
}

module.exports = { cleanModelName };
