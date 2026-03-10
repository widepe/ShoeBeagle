const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCanonicalBrandModelHelper } = require('../lib/canonical-brand-models');

test('old JSON shape still works', () => {
  const helper = buildCanonicalBrandModelHelper({
    'Topo Athletic': ['Ultrafly', 'Phantom'],
  });

  assert.equal(helper.resolveCanonicalBrand('Topo Athletic'), 'Topo Athletic');
  assert.deepEqual(helper.getCanonicalModels('Topo Athletic'), ['Ultrafly', 'Phantom']);
});

test('new JSON shape works with alias to canonical', () => {
  const helper = buildCanonicalBrandModelHelper({
    On: { aliases: ['On', 'On Running'], models: ['Cloudmonster'] },
  });

  assert.equal(helper.resolveCanonicalBrand('On Running'), 'On');
  assert.deepEqual(helper.getCanonicalModels('On Running'), ['Cloudmonster']);
});

test('detect canonical brand from listing text using aliases', () => {
  const helper = buildCanonicalBrandModelHelper({
    'Topo Athletic': { aliases: ['Topo', 'Topo Athletic'], models: ['Phantom'] },
  });

  assert.equal(helper.detectCanonicalBrandFromText('Topo Phantom'), 'Topo Athletic');
  assert.equal(helper.parseBrandModelFromText('Topo Phantom').brand, 'Topo Athletic');
});

test('model matching stays within canonical brand model list', () => {
  const helper = buildCanonicalBrandModelHelper({
    'Pearl Izumi': { aliases: ['Pearl Izumi'], models: ['Flow'] },
    VJ: { aliases: ['VJ'], models: ['Flow'] },
  });

  assert.deepEqual(helper.parseBrandModelFromText('VJ Flow'), { brand: 'VJ', model: 'Flow' });
  assert.deepEqual(helper.parseBrandModelFromText('Pearl Izumi Flow'), { brand: 'Pearl Izumi', model: 'Flow' });
});

test('short aliases like On are boundary-aware', () => {
  const helper = buildCanonicalBrandModelHelper({
    On: { aliases: ['On', 'On Running'], models: ['Cloudmonster'] },
  });

  assert.equal(helper.detectCanonicalBrandFromText('Hoka Bondi on sale today'), '');
  assert.equal(helper.detectCanonicalBrandFromText('On Cloudmonster'), 'On');
  assert.equal(helper.detectCanonicalBrandFromText("Men's On Cloudmonster"), 'On');
});
