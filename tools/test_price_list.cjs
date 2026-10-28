'use strict';

// Run with: node tools/test_price_list.cjs
// Price a list: paste card numbers with quantities, see the total without adding anything.
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
const sb = { Math, isFinite, PRICE_LIST_QTY_MAX: 999 };
vm.createContext(sb);
vm.runInContext(['priceListParse', 'priceListTotals'].map(appFunction).join('\n'), sb);
const IDX = { 'EBP01-001': {}, 'EBP01-002': {}, 'EBP01-003': {} };
const plain = (v) => JSON.parse(JSON.stringify(v));

test('parses quantities in either order and merges repeats', () => {
  const r = plain(sb.priceListParse('4 EBP01-001\nebp01-002 x2\nEBP01-001\n# note\n', IDX));
  assert.deepEqual(r.lines, [{ id: 'EBP01-001', qty: 5 }, { id: 'EBP01-002', qty: 2 }]);
  assert.deepEqual(r.unknown, []);
});
test('several numbers on one line count once each, unknown numbers are reported', () => {
  const r = plain(sb.priceListParse('EBP01-001 EBP01-002 ZZZ99-123\n0 EBP01-003', IDX));
  assert.deepEqual(r.lines, [{ id: 'EBP01-001', qty: 1 }, { id: 'EBP01-002', qty: 1 }]);
  assert.deepEqual(r.unknown, ['ZZZ99-123']);
});
test('quantity is capped', () => {
  assert.equal(sb.priceListParse('5000 EBP01-001', IDX).lines[0].qty, 999);
});
test('totals price lines, count new versus owned, and flag unpriced copies', () => {
  const prices = { 'EBP01-001': 1.5, 'EBP01-002': 0 };
  const owned = { 'EBP01-001': 2 };
  const t = plain(sb.priceListTotals([{ id: 'EBP01-001', qty: 4 }, { id: 'EBP01-002', qty: 3 }],
    (id) => prices[id], (id) => owned[id] || 0));
  assert.equal(t.total, 6);
  assert.equal(t.unpriced, 3);
  assert.equal(t.copies, 7);
  assert.equal(t.newCards, 1);
  assert.equal(t.ownedCards, 1);
  assert.equal(t.rows[0].isNew, false);
  assert.equal(t.rows[1].sum, null);
});
test('pricing never touches the collection', () => {
  const fn = appFunction('priceListRun') + appFunction('priceListTotals') + appFunction('priceListParse');
  assert.doesNotMatch(fn, /changeRaw|save\(|quickAdd|addToCollection/);
});
test('wired into Quick Add with no dashes in new copy', () => {
  assert.match(source, /id="qPriceBtn"/);
  assert.match(source, /pb=\$\("qPriceBtn"\);[^\n]*openPriceList/);
  const modal = source.slice(source.indexOf('id="plScrim"'), source.indexOf('id="eventScrim"'));
  assert.doesNotMatch(modal.replace(/<[^>]+>/g, ' '), /[-–—−]/);
});
