// /api/test-famous-footwear.js

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const TOKEN = String(process.env.FAMOUS_FOOTWEAR_COVEO_TOKEN || "").trim();

  if (!TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "Missing FAMOUS_FOOTWEAR_COVEO_TOKEN",
    });
  }

  const url =
    "https://caleresproduction4uzryqju.org.coveo.com/rest/organizations/caleresproduction4uzryqju/commerce/v2/search";

  const body = {
    trackingId: "FamousFootwear",
    clientId: "test-client-id",
    context: {
      user: {
        userAgent: "vercel-test",
      },
      view: {
        url: "https://www.famousfootwear.com/browse/sale",
        referrer: "https://www.famousfootwear.com/",
      },
      capture: true,
      cart: [],
      source: ["@coveo/headless@3.42.1"],
    },
    language: "en",
    country: "US",
    currency: "USD",
    query: "",
    page: 1,
    perPage: 12,
    facets: [
      {
        initialNumberOfValues: 12,
        facetId: "webgenders",
        displayName: "Gender",
        numberOfValues: 12,
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
        initialNumberOfValues: 30,
        facetId: "categories",
        displayName: "Category",
        numberOfValues: 30,
        field: "categories",
        type: "hierarchical",
        freezeCurrentValues: false,
        preventAutoSelect: false,
        retrieveCount: 30,
        delimitingCharacter: "|",
        values: [
          { value: "Sandals", state: "idle", children: [] },
          { value: "Boots", state: "idle", children: [] },
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
          { value: "Heels", state: "idle", children: [] },
          { value: "Loafers and Oxfords", state: "idle", children: [] },
          { value: "Slip On Shoes", state: "idle", children: [] },
          { value: "Flats", state: "idle", children: [] },
          { value: "Work and Safety", state: "idle", children: [] },
          { value: "Clogs and Mules", state: "idle", children: [] },
          { value: "Mary Janes", state: "idle", children: [] },
          { value: "Slippers", state: "idle", children: [] },
          { value: "Socks", state: "idle", children: [] },
          { value: "Boat Shoes", state: "idle", children: [] },
          { value: "Hats and Gloves", state: "idle", children: [] },
          { value: "Bags", state: "idle", children: [] },
          { value: "Hair Accessories", state: "idle", children: [] },
          { value: "Shoe Charms", state: "idle", children: [] },
        ],
      },
    ],
    sort: {
      sortCriteria: "relevance",
    },
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
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      },
      body: JSON.stringify(body),
    });

    const text = await resp.text();

    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return res.status(200).json({
      ok: resp.ok,
      status: resp.status,
      contentType: resp.headers.get("content-type"),
      requestBodySent: body,
      responseJson: json,
      responseTextPreview: text.slice(0, 4000),
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
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Unknown error",
    });
  }
}
