'use strict';

// Run with: node tools/test_work_filter.cjs
// The Work filter on the Cards page, PalDex and the deck builder, extracted from src/paldeck.html.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');

function appFunction(name) {
  const match = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, 'App function exists: ' + name);
  for (let end = source.indexOf('}', match.index); end >= 0; end = source.indexOf('}', end + 1)) {
    const declaration = source.slice(match.index, end + 1);
    try { new vm.Script('(' + declaration + ')'); } catch (_) { continue; }
    return declaration;
  }
  throw new Error('Could not extract ' + name);
}
function appConstant(name) {
  const match = new RegExp('\\bvar\\s+' + name + '\\s*=[^;]+;').exec(source);
  assert.ok(match, 'App constant exists: ' + name);
  return match[0];
}

const box = { CARDS: [
  { id: 'A', kind: 'Pal', apt: ['Kindling', 'Crafting'] },
  { id: 'B', kind: 'Pal', apt: ['Harvesting', 'Marcus'] },
  { id: 'C', kind: 'Event', apt: [] }
] };
vm.createContext(box);
vm.runInContext(appConstant('WORK_TYPES') + '\n' + ['workNames', 'workMatches', 'paldexGroupVisible'].map(appFunction).join('\n'), box);

test('work chips list only real work types present on cards', () => {
  assert.deepEqual(Array.from(box.workNames()), ['Kindling', 'Harvesting', 'Crafting']);
});

test('workMatches passes everything with no chip and any-of with chips', () => {
  const [a, b, c] = box.CARDS;
  assert.equal(box.workMatches(c, []), true);
  assert.equal(box.workMatches(a, ['Crafting']), true);
  assert.equal(box.workMatches(b, ['Crafting']), false);
  assert.equal(box.workMatches(b, ['Crafting', 'Harvesting']), true);
  assert.equal(box.workMatches(c, ['Crafting']), false);
});

test('PalDex work filter combines with status', () => {
  const g = (name, owned, apt) => ({ name, owned, total: 1, cards: [{ rare: 'C', apt }] });
  const groups = [g('Foxparks', 0, ['Kindling']), g('Lamball', 1, ['Crafting']), g('Chikipi', 0, ['Farming'])];
  const names = (status, works) => groups.filter((x) => box.paldexGroupVisible(x, '', status, 'all', [], works)).map((x) => x.name);
  assert.deepEqual(names('all', ['Kindling', 'Farming']), ['Foxparks', 'Chikipi']);
  assert.deepEqual(names('missing', ['Kindling', 'Crafting']), ['Foxparks']);
  assert.deepEqual(names('all', []), ['Foxparks', 'Lamball', 'Chikipi']);
});

test('the Cards page and deck builder wire the filter in', () => {
  assert.match(appFunction('visible'), /workMatches\(c, works\)/);
  assert.match(source, /id="deckWorkChips"/);
  assert.match(source, /id="paldexWorkChips"/);
  assert.match(source, /id="workChips"/);
});
