'use strict';

// Run with: node tools/test_inventory_report.cjs
// The printable collection inventory report (Settings, Export).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');
const start = source.indexOf('function inventoryReportData');
const end = source.indexOf('// ---- end collection inventory report ----');
assert.ok(start > 0 && end > start, 'report block exists');

function make(col, opts = {}) {
  const sb = {
    own: col.own, activeCol: () => col, priceMode: () => 'm', CUR: { code: 'USD', dec: 2 },
    SETS: { A: { name: 'Set A' }, B: { name: 'Set B' } }, RARE_NAME: { R: 'Rare' },
    CARDS: [{ id: 'A-1', set: 'A', name: 'Lamball', rare: 'R' }, { id: 'B-1', set: 'B', name: 'Cattiva <b>', rare: 'R' }],
    SEALED: [{ id: 'S1', set: 'Booster', name: 'Box' }],
    unitOf: (id) => (id === 'A-1' ? 2.5 : 10),
    rawCounts: (e) => ({ '1': e.qty }),
    copyNotesList: (e) => e.notes || [],
    csvEdition: (e) => (e === '1' ? '1st' : ''),
    sealUnit: () => 40,
    money: (n) => '$' + n.toFixed(2),
    esc: (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])),
    ...opts,
  };
  vm.createContext(sb);
  vm.runInContext(source.slice(start, end), sb);
  return sb;
}
const col = () => ({
  name: 'Mine', sealed: { S1: { qty: 2 } },
  own: {
    'A-1': { qty: 3, cond: 'Near Mint', graded: [{ grader: 'PSA', grade: 10, cert: '123', value: 100 }] },
    'B-1': { qty: 1, notes: [{ ed: '1', serial: '7/100' }] },
  },
});

test('lists every owned card, slab and sealed item with totals', () => {
  const c = col();
  const d = make(c).inventoryReportData(c, true);
  assert.equal(d.count, 3 + 1 + 1 + 2);
  assert.equal(d.total, 3 * 2.5 + 100 + 10 + 80);
  assert.deepEqual(Array.from(d.groups.map((g) => g.title)), ['Set A', 'Set B', 'Sealed product']);
  assert.equal(d.groups[1].lines[0].serial, '7/100');
});

test('without prices no value or total appears', () => {
  const c = col();
  const sb = make(c);
  const html = sb.inventoryReportHtml(c, false, '28 October 2026');
  assert.doesNotMatch(html, /Total value|\$|>Value</);
  assert.match(html, /28 October 2026/);
  assert.equal(sb.inventoryReportData(c, false).total, 0);
});

test('with prices the total is shown and names are escaped', () => {
  const c = col();
  const html = make(c).inventoryReportHtml(c, true, 'Today');
  assert.match(html, /Total value: \$197\.50/);
  assert.match(html, /Cattiva &lt;b&gt;/);
  assert.doesNotMatch(html, /Cattiva <b>/);
});

test('building the report changes nothing and handles an empty collection', () => {
  const c = col(); const before = JSON.stringify(c);
  const sb = make(c);
  sb.inventoryReportHtml(c, true, 'x');
  assert.equal(JSON.stringify(c), before);
  const e = { name: 'E', own: {}, sealed: {} };
  assert.match(make(e).inventoryReportHtml(e, true, 'x'), /Nothing in this collection yet/);
});

test('report copy has no dashes and the export chooser wires both buttons', () => {
  const copy = source.slice(start, end).match(/Made with SphereDex[^']*/)[0];
  assert.doesNotMatch(copy, /[-–—]/);
  assert.match(source, /doExportReport\(true\)/);
  assert.match(source, /doExportReport\(false\)/);
});
