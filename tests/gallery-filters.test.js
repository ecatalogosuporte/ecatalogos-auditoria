import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterGalleryPairs } from '../gallery-filters.js';

test('approval, search and independent present/absent tool filters use all conditions together', () => {
  const pairs = [
    { name: 'Blusa nova', reviewStatus: 'approved', isUsed: false },
    { name: 'Blusa B2B', reviewStatus: 'approved', isUsed: true, usageTools: ['b2b'] },
    { name: 'Blusa atacado', reviewStatus: 'approved', isUsed: true, usageTools: ['atacado-de-modas'] },
    { name: 'Blusa ambas', reviewStatus: 'approved', isUsed: true, usageTools: ['b2b', 'atacado-de-modas'] },
    { name: 'Blusa rejeitada', reviewStatus: 'rejected' },
    { name: 'Bolsa pendente', reviewStatus: null },
    { name: 'Blusa site', reviewStatus: 'approved', isUsed: true, usageTools: ['site-ecatalogos'] }
  ];
  const names = options => filterGalleryPairs(pairs, options).map(p => p.name);
  assert.equal(names({}).length, 7);
  assert.deepEqual(names({ status: 'approved', tools: { b2b: 'unused' } }), ['Blusa nova', 'Blusa atacado', 'Blusa site']);
  assert.deepEqual(names({ status: 'approved', tools: { b2b: 'unused', 'atacado-de-modas': 'unused' } }), ['Blusa nova', 'Blusa site']);
  assert.deepEqual(names({ status: 'approved', tools: { b2b: 'used', 'atacado-de-modas': 'unused' } }), ['Blusa B2B']);
  assert.deepEqual(names({ status: 'approved', tools: { b2b: 'used', 'atacado-de-modas': 'used' } }), ['Blusa ambas']);
  assert.deepEqual(names({ search: ' BLUSA SITE ', status: 'approved', tools: { 'site-ecatalogos': 'used' } }), ['Blusa site']);
  assert.deepEqual(names({ status: 'approved-unused' }), ['Blusa nova']);
  assert.deepEqual(names({ status: 'rejected' }), ['Blusa rejeitada']);
  assert.deepEqual(names({ status: 'pending' }), ['Bolsa pendente']);
  assert.deepEqual(names({ status: 'rejected', tools: { b2b: 'used' } }), []);
});
