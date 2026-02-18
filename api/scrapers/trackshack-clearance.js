// /api/scrapers/trackshack-clearance.js
//
// Track Shack clearance shoes scraper (Cheerio, no Apify)
// - Paginates via "next" link if present; else tries ?page=2..N
// - Writes results to blob: /trackshack.json (via env var URL)
//
// REQUIRED ENV:
//   BLOB_READ_WRITE_TOKEN
//   TRACKSHACK_DEALS_BLOB_URL   (FULL public blob URL ending with /trackshack.json)
//
// Optional ENV:
//   TRACKSHACK_MAX_PAGES (default 20)

import * as cheerio from "cheerio";
import { put } from "@vercel/blob";

const BASE = "https://shop.trackshack.com";
const START_URL = `${BASE}/collections/track-shack-clearance-shoes`;

function nowIso() {
  return new Date().toISOString();
}

function requireEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function toAbsUrl(maybeRelative) {
  if (!maybeRelative) return null;
  const s = String(maybeRelative).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return "https:" + s;
  return BASE + (s.startsWith("/") ? s : "/" + s);
}

function parseMoney(s) {
  if (!s) return null;
  const m = String(s).replace(/,/g, "").match(/\$?\s*([0-9]+(\.[0-9]{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function extractBgUrl(style) {
  if (!style) return null;
  const m = String(style).match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
  return m ? m[2] : null;
}

// gender: mens | womens | unisex | unknown
function inferGender(listingName) {
  const t = (listingName || "").toLowerCase();

  const hasMen =
    /\bmen'?s\b/.test(t) ||
    /\bmens\b/.test(t) ||
    /\(m\)/.test(t) ||
    /\bmen\b/.test(t);

  const hasWomen =
    /\bwomen'?s\b/.test(t) ||
    /\bwomens\b/.test(t) ||
    /\(w\)/.test(t) ||
    /\bwomen\b/.test(t);

  const hasUnisex = /\bunisex\b/.test(t);

  if (hasUnisex) return "unisex";
  if (hasMen && !hasWomen) return "mens";
  if (hasWomen && !hasMen) return "womens";
  if (hasMen && hasWomen) return "unisex"; // ambiguous -> treat as unisex
  return "unknown";
}

function computeDiscountPercent(sale, original) {
  if (!sale || !original) return null;
  if (original <= 0) return null;
  const pct = Math.round(((original - sale) / original) * 100);
  if (!isFinite(pct) || pct <= 0) return null;
  return pct;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

function findNextUrl($) {
  // Prefer explicit rel=next first
  let href =
    $('link[rel="next"]').attr("href") ||
    $('a[rel="next"]').attr("href") ||
    $(".pagination a.next").attr("href") ||
    $(".pagination__next a").attr("href") ||
    $('a[aria-label*="Next"]').attr("href");

  if (href) return toAbsUrl(href);

  // Fallback: anchor with text "Next"
  const nextA = $("a")
    .filter((_, a) => /next/i.test(cleanText($(a).text())) && $(a).attr("href"))
    .first();

  href = nextA.attr("href");
  return href ? toAbsUrl(href) : null;
}

function buildPageUrl(pageNum) {
  // classic Shopify-style collections often accept ?page=2
  const u = new URL(START_URL);
  u.searchParams.set("page", String(pageNum));
  return u.toString();
}

function parseProductsFromHtml(html, pageUrl) {
  const
