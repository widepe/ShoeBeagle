// /api/cheerio_scrapers.js
// Trigger-only runner for independent scraper endpoints.
// Most are Cheerio scrapers.
// Famous Footwear is NOT a Cheerio scraper:
// - it uses the Coveo Commerce API directly from its own Vercel scraper endpoint.
// Going, Going, Gone is also NOT a Cheerio scraper:
// - it uses the DSG Catalog Product API directly from its own Vercel scraper endpoint.
// Big Shoes is also NOT a Cheerio scraper:
// - it uses the Findify API directly from its own Vercel scraper endpoint.
// Adidas is also NOT a Cheerio scraper:
// - it uses Firecrawl raw HTML + Cheerio parsing from its own Vercel scraper endpoint.
// Each scraper runs in its own file and writes its own blob.

export const config = { maxDuration: 60 };

const REQUEST_TOGGLES = {
  REQUIRE_CRON_SECRET: true,
};

const SCRAPER_TOGGLES = {
  RUNNING_WAREHOUSE: true,
  FLEET_FEET: true,
  LUKES_LOCKER: true,
  MARATHON_SPORTS: true,
  FAMOUS_FOOTWEAR: true, // Coveo API scraper, not Cheerio
  GOING_GOING_GONE: true, // DSG Catalog Product API scraper, not Cheerio
  BIGSHOES: true, // Findify API scraper, not Cheerio
  ADIDAS: true, // Firecrawl raw HTML + Cheerio parse, not direct Cheerio
};

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBaseUrl(req) {
  const host = req.headers.host;
  const proto =
    req.headers["x-forwarded-proto"] ||
    (host && host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

async function triggerEndpoint(baseUrl, path, authHeader) {
  const startedAt = Date.now();

  const headers = {};
  if (authHeader) headers.authorization = authHeader;

  const resp = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers,
  });

  let json = null;
  try {
    json = await resp.json();
  } catch {
    json = null;
  }

  return {
    ok: resp.ok,
    status: resp.status,
    durationMs: Date.now() - startedAt,
    path,
    response: json,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const auth = req.headers.authorization;
  if (
    REQUEST_TOGGLES.REQUIRE_CRON_SECRET &&
    process.env.CRON_SECRET &&
    auth !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const baseUrl = getBaseUrl(req);
  const runTimestamp = nowIso();
  const overallStart = Date.now();

  const results = {};

  try {
    if (SCRAPER_TOGGLES.RUNNING_WAREHOUSE) {
      results["Running Warehouse"] = await triggerEndpoint(
        baseUrl,
        "/api/scrapers/running-warehouse-cheerio",
        auth
      );
      await sleep(1000);
    } else {
      results["Running Warehouse"] = {
        ok: true,
        skipped: true,
        path: "/api/scrapers/running-warehouse-cheerio",
      };
    }

    if (SCRAPER_TOGGLES.FLEET_FEET) {
      results["Fleet Feet"] = await triggerEndpoint(
        baseUrl,
        "/api/scrapers/fleet-feet-cheerio",
        auth
      );
      await sleep(1000);
    } else {
      results["Fleet Feet"] = {
        ok: true,
        skipped: true,
        path: "/api/scrapers/fleet-feet-cheerio",
      };
    }

    if (SCRAPER_TOGGLES.LUKES_LOCKER) {
      results["Luke's Locker"] = await triggerEndpoint(
        baseUrl,
        "/api/scrapers/lukes-locker-cheerio",
        auth
      );
      await sleep(1000);
    } else {
      results["Luke's Locker"] = {
        ok: true,
        skipped: true,
        path: "/api/scrapers/lukes-locker-cheerio",
      };
    }

    if (SCRAPER_TOGGLES.MARATHON_SPORTS) {
      results["Marathon Sports"] = await triggerEndpoint(
        baseUrl,
        "/api/scrapers/marathon-sports-cheerio",
        auth
      );
      await sleep(1000);
    } else {
      results["Marathon Sports"] = {
        ok: true,
        skipped: true,
        path: "/api/scrapers/marathon-sports-cheerio",
      };
    }

    if (SCRAPER_TOGGLES.FAMOUS_FOOTWEAR) {
      results["Famous Footwear"] = await triggerEndpoint(
        baseUrl,
        "/api/scrapers/famous-footwear",
        auth
      );
      await sleep(1000);
    } else {
      results["Famous Footwear"] = {
        ok: true,
        skipped: true,
        path: "/api/scrapers/famous-footwear",
      };
    }

    if (SCRAPER_TOGGLES.GOING_GOING_GONE) {
      results["Going, Going, Gone"] = await triggerEndpoint(
        baseUrl,
        "/api/scrapers/going-going-gone",
        auth
      );
      await sleep(1000);
    } else {
      results["Going, Going, Gone"] = {
        ok: true,
        skipped: true,
        path: "/api/scrapers/going-going-gone",
      };
    }

    if (SCRAPER_TOGGLES.BIGSHOES) {
      results["Big Shoes"] = await triggerEndpoint(
        baseUrl,
        "/api/scrapers/bigshoes-findify",
        auth
      );
      await sleep(1000);
    } else {
      results["Big Shoes"] = {
        ok: true,
        skipped: true,
        path: "/api/scrapers/bigshoes-findify",
      };
    }

    if (SCRAPER_TOGGLES.ADIDAS) {
      results["Adidas"] = await triggerEndpoint(
        baseUrl,
        "/api/scrapers/adidas-firecrawl",
        auth
      );
    } else {
      results["Adidas"] = {
        ok: true,
        skipped: true,
        path: "/api/scrapers/adidas-firecrawl",
      };
    }

    return res.status(200).json({
      success: true,
      timestamp: runTimestamp,
      duration: `${Date.now() - overallStart}ms`,
      toggles: {
        scrapers: SCRAPER_TOGGLES,
        request: REQUEST_TOGGLES,
      },
      stores: results,
      note:
        "This runner triggers independent scraper endpoints. Each scraper writes its own blob. Famous Footwear uses the Coveo Commerce API, Going, Going, Gone uses the DSG Catalog Product API, Big Shoes uses the Findify API, and Adidas uses Firecrawl raw HTML + Cheerio parsing, so those are not direct Cheerio scrapers.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
    });
  }
}
