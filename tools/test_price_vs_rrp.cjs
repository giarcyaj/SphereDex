'use strict';

// Run with: node tools/test_price_vs_rrp.cjs
// Price versus RRP on sealed products. A neutral reading: how far a price sits from the RRP.
// The one thing that must never happen is comparing two prices in different currencies, so shop prices
// are measured against the RRP in the shop's own currency.
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

const HOUR = 3600000;
const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
function sandbox(opts) {
  opts = opts || {};
  const sb = {
    STOCK: { region: 'co.uk', asOf: stamp(5 * 60000), state: opts.state || {}, shops: opts.shops || null, at: Date.now(), seen: null },
    STOCK_STALE_MS: 2 * HOUR,
    SEAL_RRP: { 'box-ebp01': { USD: 57.99, GBP: 45.6 } },
    REGION_CUR: { 'co.uk': 'GBP' },
    ebayReg: () => 'co.uk',
    esc: (s) => String(s),
    money: (n) => '$' + Number(n).toFixed(2),
    moneyIn: (n, c) => (c === 'GBP' ? '£' : '$') + Number(n).toFixed(2),
    Date, Math, isNaN, String, Number,
  };
  vm.createContext(sb);
  vm.runInContext(['rrpDelta', 'sealCheapestShop', 'sealRrpReading', 'sealRrpLineHtml', 'sealRrpBadgeHtml',
    'stockGlance', 'stockSeen', 'stockShops'].map(appFunction).join('\n'), sb);
  return sb;
}

test('a launch spike reads as a percentage over RRP', () => {
  const sb = sandbox();
  assert.equal(sb.rrpDelta(141.36, 45.6).text, '+210% over RRP');
});

test('below RRP reads as under, without a minus sign or a verdict', () => {
  const sb = sandbox();
  assert.equal(sb.rrpDelta(41.04, 45.6).text, '10% under RRP');
});

test('a price at the RRP says so', () => {
  const sb = sandbox();
  assert.equal(sb.rrpDelta(45.6, 45.6).text, 'At RRP');
});

test('an unknown price or RRP gives no reading', () => {
  const sb = sandbox();
  assert.equal(sb.rrpDelta(0, 45.6), null);
  assert.equal(sb.rrpDelta(50, 0), null);
  assert.equal(sb.rrpDelta(null, undefined), null);
});

test('the cheapest in stock shop wins, compared in the shop currency', () => {
  const sb = sandbox({
    state: { 'box-ebp01': 'in' },
    shops: { 'box-ebp01': [
      { shop: 'A', status: 'in', price: 150, url: '' },
      { shop: 'B', status: 'in', price: 91.2, url: '' },
      { shop: 'C', status: 'out', price: 30, url: '' },
    ] },
  });
  const r = sb.sealRrpReading({ id: 'box-ebp01' }, { sold: 0, list: 0 }, 57.99);
  assert.equal(r.src, 'shop');
  assert.equal(r.shop, 'B');
  assert.equal(r.delta.text, '+100% over RRP');   // 91.20 against GBP 45.60, not against the USD RRP
});

test('a stale stock reading is not used for the shop price', () => {
  const sb = sandbox({ state: { 'box-ebp01': 'in' }, shops: { 'box-ebp01': [{ shop: 'B', status: 'in', price: 91.2 }] } });
  sb.STOCK.asOf = stamp(3 * HOUR);
  const r = sb.sealRrpReading({ id: 'box-ebp01' }, { sold: 115.98, list: 0 }, 57.99);
  assert.equal(r.src, 'market');
  assert.equal(r.delta.text, '+100% over RRP');
});

test('with no shop reading it falls back to the market price, sold before live', () => {
  const sb = sandbox();
  const r = sb.sealRrpReading({ id: 'box-ebp01' }, { sold: 86.985, list: 200 }, 57.99);
  assert.equal(r.src, 'market');
  assert.equal(r.delta.text, '+50% over RRP');
  const r2 = sb.sealRrpReading({ id: 'box-ebp01' }, { sold: 0, list: 115.98 }, 57.99);
  assert.equal(r2.delta.text, '+100% over RRP');
});

test('a pre order and a product with no prices draw nothing', () => {
  const sb = sandbox();
  assert.equal(sb.sealRrpLineHtml({ id: 'x', pre: true }, { sold: 100 }, 50), '');
  assert.equal(sb.sealRrpBadgeHtml({ id: 'box-ebp01' }, { sold: 0, list: 0 }, 57.99), '');
  assert.equal(sb.sealRrpLineHtml({ id: 'box-ebp01' }, { sold: 100 }, 0), '');
});

test('a shop in a currency with no known RRP falls back instead of guessing', () => {
  const sb = sandbox({ state: { 'box-ebp01': 'in' }, shops: { 'box-ebp01': [{ shop: 'B', status: 'in', price: 91.2 }] } });
  sb.REGION_CUR['co.uk'] = 'SEK';
  const r = sb.sealRrpReading({ id: 'box-ebp01' }, { sold: 57.99, list: 0 }, 57.99);
  assert.equal(r.src, 'market');
  assert.equal(r.delta.text, 'At RRP');
});

test('the detail sheet and the list both draw it, and the stock paint refreshes it', () => {
  assert.match(source, /id="sdRrpWrap"/);
  assert.match(source, /sealRrpBadgeHtml\(p, pr, rrpShown\)/);
  assert.match(source, /rw\.innerHTML=sealRrpLineHtml\(\{id:id\}/);
});
