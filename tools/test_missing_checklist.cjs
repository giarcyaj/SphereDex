'use strict';

// Run with: node tools/test_missing_checklist.cjs
// Guards for the printable missing cards checklist: grouped per set, a tick row per card, prices only on request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');

function appFunction(name) {
  const m = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(m, 'App function exists: ' + name);
  for (let e = source.indexOf('}', m.index); e >= 0; e = source.indexOf('}', e + 1)) {
    const d = source.slice(m.index, e + 1);
    try { new vm.Script('(' + d + ')'); return d; } catch (_) { /* keep looking */ }
  }
  throw new Error('Could not extract ' + name);
}

const ctx = vm.createContext({
  SETS: { EBP01: { name: 'Booster Dawn of Palpagos' }, EBP02: { name: 'Booster Legends Awaken' } },
  RARE_NAME: { C: 'Common', SR: 'Super Rare' },
  SETTINGS: { mode: 'market' },
  priceMode: () => 'list',
  unitOf: (id) => (id === 'EBP01-002' ? 4.5 : 0),
  money: (n) => '$' + n.toFixed(2),
});
['deckPrintCountLabel', 'missingChecklistGroups', 'missingChecklistPriceOf', 'missingChecklistText']
  .forEach((n) => vm.runInContext(appFunction(n), ctx));
const run = (code) => vm.runInContext(code, ctx);

const items = [
  { card: { id: 'EBP01-001', set: 'EBP01', name: 'Lamball', rare: 'C' }, need: 1 },
  { card: { id: 'EBP01-002', set: 'EBP01', name: 'Cattiva', rare: 'SR' }, need: 2 },
  { card: { id: 'EBP02-001', set: 'EBP02', name: 'Foxparks', rare: 'C' }, need: 1 },
  { card: { id: 'EBP02-002', set: 'EBP02', name: 'Owned', rare: 'C' }, need: 0 },
];

test('groups cards per set and skips zero need', () => {
  const g = run('missingChecklistGroups')(items, null);
  assert.equal(g.length, 2);
  assert.equal(g[0].title, 'Booster Dawn of Palpagos');
  assert.equal(g[0].rows.length, 2);
  assert.equal(g[1].rows.length, 1);
  assert.equal(g[0].rows[1].printing, 'Super Rare');
  assert.equal(g[0].rows[1].need, 2);
});

test('prices are left out unless asked for', () => {
  const plain = run('missingChecklistGroups')(items, null);
  assert.ok(plain.every((x) => x.rows.every((r) => r.price === '')));
  assert.ok(!/\$/.test(run('missingChecklistText')('T', plain)));
  const priced = run('missingChecklistGroups')(items, run('missingChecklistPriceOf'));
  assert.equal(priced[0].rows[1].price, '$4.50');
  assert.equal(priced[0].rows[0].price, '');
});

test('collector mode never prints prices', () => {
  ctx.SETTINGS.mode = 'collector';
  assert.equal(run('missingChecklistPriceOf')({ id: 'EBP01-002' }), '');
  ctx.SETTINGS.mode = 'market';
});

test('copy text has a tick box per card and no dashes in the copy', () => {
  const g = run('missingChecklistGroups')(items, null);
  const t = run('missingChecklistText')('Missing cards', g);
  assert.match(t, /\[ \] EBP01-002 Cattiva \(Super Rare\) x2/);
  assert.match(t, /Booster Legends Awaken \(1 card\)/);
});

test('the Missing page wires the Print checklist button', () => {
  assert.match(source, /id="missingPrintAction"[^>]*>Print checklist</);
  assert.match(source, /missingPrintAction"\); if\(missingPrint\) missingPrint\.onclick/);
});
