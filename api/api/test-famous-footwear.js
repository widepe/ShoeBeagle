export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const TOKEN = process.env.FAMOUS_FOOTWEAR_COVEO_TOKEN;

  if (!TOKEN) {
    return res.status(500).json({ ok: false, error: "Missing FAMOUS_FOOTWEAR_COVEO_TOKEN" });
  }

  const url =
    "https://caleresproduction4uzryqju.org.coveo.com/rest/organizations/caleresproduction4uzryqju/commerce/v2/search";

  const body = {
    trackingId: "FamousFootwear",
    clientId: "test-client-id",
    context: {
      user: { userAgent: "vercel-test" },
      view: {
        url: "https://www.famousfootwear.com/browse/sale",
        referrer: "https://www.famousfootwear.com/",
      },
      capture: true,
      cart: [],
      source: ["vercel-test"],
    },
    language: "en",
    country: "US",
    currency: "USD",
    page: 1,
    perPage: 12,
    facets: [
      {
        facetId: "webgenders",
        field: "webgenders",
        type: "regular",
        freezeCurrentValues: true,
        preventAutoSelect: true,
        values: [
          { value: "Women's", state: "selected" },
          { value: "Men's", state: "selected" },
        ],
      },
      {
        facetId: "categories",
        field: "categories",
        type: "hierarchical",
        freezeCurrentValues: false,
        preventAutoSelect: false,
        delimitingCharacter: "|",
        values: [
          {
            value: "Sneakers and Athletic Shoes",
            state: "idle",
            children: [
              {
                value: "Running Shoes",
                state: "selected",
                children: [
                  { value: "Performance Running", state: "idle", children: [] },
                  { value: "Lifestyle Running", state: "idle", children: [] },
                ],
              },
            ],
          },
        ],
      },
    ],
    sort: { sortCriteria: "relevance" },
    enableResults: true,
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        accept: "*/*",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        origin: "https://www.famousfootwear.com",
        referer: "https://www.famousfootwear.com/",
        "user-agent": "Mozilla/5.0",
      },
      body: JSON.stringify(body),
    });

    const text = await resp.text();

    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    return res.status(200).json({
      ok: resp.ok,
      status: resp.status,
      contentType: resp.headers.get("content-type"),
      topLevelKeys: json ? Object.keys(json) : null,
      productsLength: json && Array.isArray(json.products) ? json.products.length : null,
      firstProduct:
        json && Array.isArray(json.products) && json.products[0]
          ? {
              ec_name: json.products[0].ec_name,
              ec_brand: json.products[0].ec_brand,
              ec_price: json.products[0].ec_price,
              ec_promo_price: json.products[0].ec_promo_price,
              clickUri: json.products[0].clickUri,
            }
          : null,
      rawPreview: json ? null : text.slice(0, 2000),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
