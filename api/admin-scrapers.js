import fs from "fs/promises";
import path from "path";

export const config = { maxDuration: 60 };

const BLOB_BASE =
  "https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com";

function getClientIp(req) {
  const xfwd = req.headers["x-forwarded-for"];
  if (typeof xfwd === "string" && xfwd.trim()) {
    return xfwd.split(",")[0].trim();
  }

  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }

  const socketIp =
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    "";

  return String(socketIp || "").trim();
}

function normalizeIp(ip) {
  let out = String(ip || "").trim();
  if (out.startsWith("::ffff:")) out = out.replace("::ffff:", "");
  if (out === "::1") out = "127.0.0.1";
  return out;
}

function isAllowedIp(req) {
  const clientIp = normalizeIp(getClientIp(req));

  const allowed = String(process.env.ADMIN_ALLOWED_IPS || "")
    .split(",")
    .map((s) => normalizeIp(s))
    .filter(Boolean);

  const allowLocalhost =
    String(process.env.ADMIN_ALLOW_LOCALHOST || "false").toLowerCase() ===
    "true";

  const ok =
    (allowLocalhost && clientIp === "127.0.0.1") ||
    allowed.includes(clientIp);

  return { ok, clientIp };
}

async function loadCanonicalStores() {
  const filePath = path.join(process.cwd(), "lib", "canonical-stores.json");
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("canonical-stores.json must be an array");
  }

  return parsed.sort((a, b) =>
    String(a.displayName).localeCompare(String(b.displayName))
  );
}

function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();

  return `${proto}://${host}`;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  return {
    ok: res.ok,
    status: res.status,
    json,
  };
}

function getBlobCandidates(store) {
  if (Array.isArray(store.expectedBlob)) return store.expectedBlob;
  if (store.expectedBlob) return [store.expectedBlob];
  return [];
}

function getScraperCandidates(store) {
  const candidates = [];

  candidates.push(`/api/scrapers/${store.id}`);

  for (const blob of getBlobCandidates(store)) {
    const file = blob.split("/").pop().replace(".json", "");
    candidates.push(`/api/scrapers/${file}`);
  }

  return [...new Set(candidates)];
}

async function triggerStore(req, store) {
  const base = getBaseUrl(req);

  const headers = process.env.CRON_SECRET
    ? { authorization: `Bearer ${process.env.CRON_SECRET}` }
    : {};

  if (store.scraperType === "apify") {
    const route = `/api/scrapers/apify_scrapers?storeId=${store.id}`;
    const result = await fetchJson(base + route, {
      headers,
    });

    return {
      ok: result.ok,
      route,
      triggerJson: result.json,
    };
  }

  const routes = getScraperCandidates(store);

  for (const route of routes) {
    const result = await fetchJson(base + route, {
      headers,
    });

    if (result.ok) {
      return {
        ok: true,
        route,
        triggerJson: result.json,
      };
    }
  }

  return { ok: false };
}

async function loadBlob(store) {
  for (const blob of getBlobCandidates(store)) {
    const result = await fetchJson(blob + "?_=" + Date.now());
    if (result.ok) {
      const data = result.json;

      const deals = Array.isArray(data)
        ? data
        : Array.isArray(data.deals)
        ? data.deals
        : [];

      return {
        blobUrl: blob,
        blobData: data,
        deals,
      };
    }
  }

  return {
    blobUrl: null,
    blobData: null,
    deals: [],
  };
}

async function loadHistory(store) {
  const result = await fetchJson(
    `${BLOB_BASE}/scraper-data.json?_=${Date.now()}`
  );

  if (!result.ok) return [];

  const days = result.json?.days || [];

  return days
    .map((day) => {
      const match = (day.scrapers || []).find(
        (s) =>
          s.scraper === store.displayName ||
          s.scraper === store.id
      );

      if (!match) return null;

      return {
        dayUTC: day.dayUTC,
        ok: !!match.ok,
        count: match.count,
        durationMs: match.durationMs,
        via: match.via,
      };
    })
    .filter(Boolean)
    .slice(0, 30);
}

export default async function handler(req, res) {
  const access = isAllowedIp(req);

  if (!access.ok) {
    return res.status(403).json({
      ok: false,
      error: `Forbidden for IP ${access.clientIp}`,
    });
  }

  try {
    const action = req.query.action;
    const stores = await loadCanonicalStores();

    if (action === "list") {
      return res.json({
        ok: true,
        stores,
      });
    }

    const storeId = req.query.storeId || req.body?.storeId;

    const store = stores.find((s) => s.id === storeId);

    if (!store) {
      return res.status(404).json({
        ok: false,
        error: "Store not found",
      });
    }

    if (action === "details") {
      const blob = await loadBlob(store);
      const history = await loadHistory(store);

      return res.json({
        ok: true,
        store,
        latestBlob: blob,
        history,
      });
    }

    if (action === "run") {
      const trigger = await triggerStore(req, store);

      const blob = await loadBlob(store);
      const history = await loadHistory(store);

      return res.json({
        ok: true,
        store,
        triggerResult: trigger,
        latestBlob: blob,
        history,
      });
    }

    return res.status(400).json({
      ok: false,
      error: "Invalid action",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
