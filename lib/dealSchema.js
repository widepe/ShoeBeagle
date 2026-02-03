// lib/dealSchema.js

const REQUIRED_KEYS = [
  "listingName",
  "brand",
  "model",
  "salePrice",
  "originalPrice",
  "discountPercent",
  "store",
  "listingURL",
  "imageURL",
  "gender",
  "shoeType",
];

const ALLOWED_GENDER = new Set(["mens", "womens", "unisex", "unknown"]);
const ALLOWED_TYPE = new Set(["road", "trail", "track", "unknown"]);

function isNumOrNull(x) {
  return x === null || (typeof x === "number" && Number.isFinite(x));
}
function isStrOrNull(x) {
  return x === null || typeof x === "string";
}

function assertDealSchema(deal) {
  const errors = [];
  if (!deal || typeof deal !== "object") return ["deal is not an object"];

  for (const k of REQUIRED_KEYS) {
    if (!(k in deal)) errors.push(`missing key: ${k}`);
  }

  if (typeof deal.listingName !== "string") errors.push("listingName must be string");
  if (typeof deal.brand !== "string") errors.push("brand must be string");
  if (typeof deal.model !== "string") errors.push("model must be string");
  if (!isNumOrNull(deal.salePrice)) errors.push("salePrice must be number|null");
  if (!isNumOrNull(deal.originalPrice)) errors.push("originalPrice must be number|null");
  if (!isNumOrNull(deal.discountPercent)) errors.push("discountPercent must be number|null");
  if (typeof deal.store !== "string") errors.push("store must be string");
  if (!isStrOrNull(deal.listingURL)) errors.push("listingURL must be string|null");
  if (!isStrOrNull(deal.imageURL)) errors.push("imageURL must be string|null");

  if (typeof deal.gender !== "string" || !ALLOWED_GENDER.has(deal.gender))
    errors.push("gender must be mens|womens|unisex|unknown");

  if (typeof deal.shoeType !== "string" || !ALLOWED_TYPE.has(deal.shoeType))
    errors.push("shoeType must be road|trail|track|unknown");

  return errors;
}

module.exports = { REQUIRED_KEYS, assertDealSchema };
