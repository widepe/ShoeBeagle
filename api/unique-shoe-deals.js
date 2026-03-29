import { put } from '@vercel/blob';

// Fetch deals from blob storage
const response = await fetch('https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/deals.json');
const data = await response.json();
const deals = data.deals;

const uniqueMap = new Map();

for (const deal of deals) {
  const key = `${deal.brand}|${deal.model}|${deal.gender}`;
  if (!uniqueMap.has(key)) {
    uniqueMap.set(key, {
      brand: deal.brand,
      model: deal.model,
      gender: deal.gender
    });
  }
}

const uniqueDeals = Array.from(uniqueMap.values());

const output = {
  generatedAt: new Date().toISOString(),
  totalUniqueDeals: uniqueDeals.length,
  uniqueDeals
};

console.log(`Total unique deals (brand+model+gender): ${uniqueDeals.length}`);

const blob = await put('unique-shoe-deals.json', JSON.stringify(output, null, 2), {
  access: 'public',
  token: process.env.BLOB_READ_WRITE_TOKEN,
  contentType: 'application/json',
  addRandomSuffix: false
});

console.log('Uploaded to:', blob.url);
