'use strict';

// Run with: node tools/test_promo_sources.cjs
// Guards the "How to get it" text on the prize only promos EPR-010 and EPR-011.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');
function promoText(id) {
  const m = new RegExp('"' + id + '":"([^"]*)"').exec(source.slice(source.indexOf('var PROMO_SRC')));
  assert.ok(m, 'PROMO_SRC has ' + id);
  return m[1];
}

test('EPR-010 says it is the Grand Challengers Cup champion prize', () => {
  const t = promoText('EPR-010');
  assert.match(t, /Grand Challengers Cup champion/);
  assert.match(t, /October 2026/);
  assert.match(t, /second hand/);
});

test('EPR-011 says it is the Grand Challengers Cup Top 4 prize', () => {
  const t = promoText('EPR-011');
  assert.match(t, /Grand Challengers Cup Top 4/);
  assert.match(t, /second hand/);
});

test('promo how to get it copy has no dashes', () => {
  for (const id of ['EPR-010', 'EPR-011']) assert.doesNotMatch(promoText(id), /[-–—]/);
});
