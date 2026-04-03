import { fetchPageText } from "./fetchPageText.js";
import { extractStructuredShoeData } from "./extractStructuredShoeData.js";
import { insertShoeRecord } from "./insertShoeRecord.js";
import { insertEvidenceRows } from "./insertEvidenceRows.js";
import { attachDealsToShoe } from "./attachDealsToShoe.js";
import { verifyShoeIdentity } from "./verifyShoeIdentity.js";
import { normalizeGender, normalizeSurface, toDisplayName, splitModelAndVersion } from "./normalize.js";

function buildSeedEvidence(candidate) {
  const sourceName = candidate.sample_store || "Shoe Beagle Deal Row";
  const sourceUrl = candidate.sample_listing_url || null;

  return [
    {
      field_name: "brand",
      raw_value: candidate.brand,
      normalized_value: candidate.brand,
      source_type: "retailer",
      source_name: sourceName,
      source_url: sourceUrl,
      confidence_score: 0.95,
      is_selected: true,
      notes: "Seeded from sb_shoe_deals candidate row",
    },
    {
      field_name: "model",
      raw_value: candidate.model,
      normalized_value: candidate.model,
      source_type: "retailer",
      source_name: sourceName,
      source_url: sourceUrl,
      confidence_score: 0.95,
      is_selected: true,
      notes: "Seeded from sb_shoe_deals candidate row",
    },
    {
      field_name: "gender",
      raw_value: candidate.gender,
      normalized_value: normalizeGender(candidate.gender),
      source_type: "retailer",
      source_name: sourceName,
      source_url: sourceUrl,
      confidence_score: 0.9,
      is_selected: true,
      notes: "Seeded from sb_shoe_deals candidate row",
    },
    {
      field_name: "surface",
      raw_value: candidate.surface,
      normalized_value: normalizeSurface(candidate.surface),
      source_type: "retailer",
      source_name: sourceName,
      source_url: sourceUrl,
      confidence_score: 0.75,
      is_selected: true,
      notes: "Seeded from sb_shoe_deals candidate row",
    },
  ];
}

function buildSnippets(candidate, pageResult, extraPages = []) {
  const snippets = [];

  snippets.push({
    source_name: candidate.sample_store || "Shoe Beagle Deal Row",
    source_type: "retailer",
    source_url: candidate.sample_listing_url || null,
    text: [
      `Brand: ${candidate.brand}`,
      `Raw model text: ${candidate.model}`,
      `Gender: ${candidate.gender}`,
      `Surface: ${candidate.surface}`,
      `Listing name: ${candidate.sample_listing_name || ""}`,
      `Store: ${candidate.sample_store || ""}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  if (pageResult?.ok) {
    snippets.push({
      source_name: candidate.sample_store || "Retailer Listing Page",
      source_type: "retailer",
      source_url: candidate.sample_listing_url || null,
      text: pageResult.text,
    });
  }

  for (const page of extraPages) {
    if (!page?.ok || !page.text || !page.url) continue;

    snippets.push({
      source_name: "Manufacturer",
      source_type: "brand",
      source_url: page.url,
      text: page.text,
    });
  }

  return snippets;
}

function mergeSeedEvidence(extracted, seedEvidence) {
  const existing = Array.isArray(extracted.evidence) ? extracted.evidence : [];
  return [...seedEvidence, ...existing];
}

function hasRealEnrichmentEvidence(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  return list.some(
    (ev) =>
      ev &&
      ev.notes !== "Seeded from sb_shoe_deals candidate row" &&
      ["brand", "review", "lab", "retailer", "ai", "other"].includes(
        String(ev.source_type || "").toLowerCase()
      )
  );
}

async function fetchManufacturerPage(aiClient, verifiedCandidate) {
  const { brand, verified_model, verified_version } = verifiedCandidate;

  const nameParts = [brand, verified_model, verified_version]
    .filter(Boolean)
    .join(" ");

  const prompt = `
You are helping locate the official manufacturer product page for a running shoe.

Goal:
- Given the shoe name and brand, identify ONE official manufacturer URL for the specific shoe (not a generic brand page, not a retailer, not a review site).

Rules:
- Return a single URL string only.
- It must be an official brand domain for the shoe:
  - Brooks: brooksrunning.com
  - Saucony: saucony.com
  - HOKA: hoka.com
  - On: on-running.com
  - New Balance: newbalance.com
  - Nike: nike.com
  - Adidas: adidas.com
- Do NOT return retailer URLs (e.g. Backcountry, Running Warehouse, Amazon).
- Do NOT return review URLs (RunRepeat, Doctors of Running, etc.).
- If no clear official product page exists, return "null".

Shoe:
- Brand: ${brand}
- Name: ${nameParts}
`.trim();

  const response = await aiClient.chat.completions.create({
    model: "sonar",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You return only an official manufacturer product URL or the string null.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const text = (response.choices?.[0]?.message?.content || "").trim();

  if (!text || text.toLowerCase() === "null") {
    return { ok: false, url: null, title: null, text: "", error: "no_url" };
  }

  const url = text.split(/\s+/)[0].trim().replace(/^"|"$/g, "");
  if (!url.startsWith("http")) {
    return { ok: false, url: null, title: null, text: "", error: "bad_url" };
  }

  return await fetchPageText(url);
}

async function fetchManufacturerPage(aiClient, verifiedCandidate) {
  const { brand, verified_model, verified_version } = verifiedCandidate;

  const nameParts = [brand, verified_model, verified_version]
    .filter(Boolean)
    .join(" ");

  const prompt = `
You are helping locate the official manufacturer product page for a running shoe.

Goal:
- Given the shoe name and brand, identify ONE official manufacturer URL for the specific shoe (not a generic brand page, not a retailer, not a review site).

Rules:
- Return a single URL string only.
- It must be an official brand domain for the shoe:
  - Brooks: brooksrunning.com
  - Saucony: saucony.com
  - HOKA: hoka.com
  - On: on-running.com
  - New Balance: newbalance.com
  - Nike: nike.com
  - Adidas: adidas.com
- Do NOT return retailer URLs (e.g. Backcountry, Running Warehouse, Amazon).
- Do NOT return review URLs (RunRepeat, Doctors of Running, etc.).
- If no clear official product page exists, return "null".

Shoe:
- Brand: ${brand}
- Name: ${nameParts}
`.trim();

  const response = await aiClient.chat.completions.create({
    model: "sonar",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You return only an official manufacturer product URL or the string null.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const text = (response.choices?.[0]?.message?.content || "").trim();

  if (!text || text.toLowerCase() === "null") {
    return { ok: false, url: null, title: null, text: "", error: "no_url" };
  }

  const url = text.split(/\s+/)[0].trim().replace(/^"|"$/g, "");
  if (!url.startsWith("http")) {
    return { ok: false, url: null, title: null, text: "", error: "bad_url" };
  }

  return await fetchPageText(url);
}


export async function researchOneShoe({ db, aiClient, candidate }) {
  const pageResult = await fetchPageText(candidate.sample_listing_url);

  const verified = await verifyShoeIdentity(aiClient, {
    candidate,
    pageResult,
  });

  if (!verified.verified) {
    const error = new Error(
      verified.mismatch_reason ||
        `Listing page identity could not be verified for ${candidate.brand} ${candidate.model} (${candidate.gender})`
    );

    error.stage = "verify_identity";
    error.brand = candidate.brand;
    error.model = candidate.model;
    error.gender = candidate.gender;
    error.store = candidate.sample_store || null;
    error.listingUrl = candidate.sample_listing_url || null;
    error.verification = verified;
    throw error;
  }

  const baseBrand = verified.brand || candidate.brand;
  const baseName = verified.display_name || candidate.model;
  const split = splitModelAndVersion(baseName, baseBrand);

  const verifiedCandidate = {
    ...candidate,
    brand: baseBrand,
    model: split.raw_model_text,
    raw_model_text: split.raw_model_text,
    verified_model: verified.model || split.model,
    verified_version: verified.version || split.version,
    gender: verified.gender || candidate.gender,
  };

  const manufacturerPage = await fetchManufacturerPage(aiClient, verifiedCandidate);

  const snippets = buildSnippets(verifiedCandidate, pageResult, [
    manufacturerPage,
  ]);

  let extracted = await extractStructuredShoeData(aiClient, {
    candidate: verifiedCandidate,
    snippets,
  });

  extracted.brand = extracted.brand || verified.brand || candidate.brand;
  extracted.model = extracted.model || verified.model || candidate.model;
  extracted.version =
    extracted.version !== undefined && extracted.version !== null
      ? extracted.version
      : verified.version || null;
  extracted.gender = extracted.gender || verified.gender || candidate.gender;

  extracted.display_name =
    extracted.display_name ||
    toDisplayName({
      brand: extracted.brand,
      model: extracted.version
        ? `${extracted.model}${/^v/i.test(extracted.version) ? extracted.version : ` ${extracted.version}`}`
        : extracted.model,
      gender: extracted.gender,
    }).replace(/\s+\((mens|womens|unisex|unknown)\)$/i, "");

  const seedEvidence = buildSeedEvidence(verifiedCandidate);
  extracted.evidence = mergeSeedEvidence(extracted, seedEvidence);

  if (!hasRealEnrichmentEvidence(extracted.evidence)) {
    console.warn(
      "NO ENRICHMENT EVIDENCE",
      JSON.stringify(
        {
          brand: extracted.brand,
          model: extracted.model,
          version: extracted.version,
          gender: extracted.gender,
          listingUrl: candidate.sample_listing_url || null,
        },
        null,
        2
      )
    );
  }

  const client = await db.connect();

  try {
    await client.query("begin");

    const shoeId = await insertShoeRecord(client, extracted);

    await insertEvidenceRows(client, shoeId, extracted.evidence);

    await attachDealsToShoe(client, {
      shoeId,
      brand: extracted.brand,
      model: extracted.version
        ? `${extracted.model}${/^v/i.test(extracted.version) ? extracted.version : ` ${extracted.version}`}`
        : extracted.model,
      version: extracted.version,
      gender: extracted.gender,
    });

    await client.query("commit");

    return {
      shoeId,
      extracted,
      pageResult,
      verified,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
