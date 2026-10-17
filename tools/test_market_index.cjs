'use strict';

// Run with: node tools/test_market_index.cjs
// The market index and the like for like split. The index must ignore cards entering or leaving the book,
// and adding cards must never look like a price gain.
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
const ctx = vm.createContext({});
vm.runInContext(['marketIndexSeries', 'marketIndexMove', 'likeForLikeChange'].map(appFunction).join('\n'), ctx);
const addDays = (k, n) => { const d = new Date(k + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('index starts at 1000 and tracks the average price ratio', () => {
  const s = ctx.marketIndexSeries([
    { d: '2026-10-01', map: { a: 10, b: 20 } },
    { d: '2026-10-02', map: { a: 11, b: 20 } },   // +10% and 0% -> +5%
  ]);
  assert.equal(s[0].v, 1000);
  assert.ok(Math.abs(s[1].v - 1050) < 1e-9);
});

test('a card entering the book does not move the index', () => {
  const s = ctx.marketIndexSeries([
    { d: '2026-10-01', map: { a: 10 } },
    { d: '2026-10-02', map: { a: 10, z: 500 } },
  ]);
  assert.ok(Math.abs(s[1].v - 1000) < 1e-9);
});

test('weekly move needs history old enough, otherwise null', () => {
  const s = ctx.marketIndexSeries([
    { d: '2026-10-10', map: { a: 10 } }, { d: '2026-10-17', map: { a: 12 } },
  ]);
  assert.ok(Math.abs(ctx.marketIndexMove(s, 7, '2026-10-17', addDays) - 20) < 1e-9);
  assert.equal(ctx.marketIndexMove(s, 30, '2026-10-17', addDays), null);
  assert.equal(ctx.marketIndexMove([], 7, '2026-10-17', addDays), null);
});

test('like for like ignores cards without a price on both days and reflects price only', () => {
  const r = ctx.likeForLikeChange({ a: 2, b: 1, c: 5 }, { a: 8, b: 10, c: 3 }, { a: 10, b: 10 });
  assert.equal(r.n, 2);
  assert.equal(r.change, 2 * 8 + 10 - (2 * 10 + 10));   // -4, c has no earlier price
  assert.ok(r.pct < 0);
});

test('prices fell but a box of pulls was added: like for like is negative', () => {
  // before: 1 card at 10. now: that card at 8 plus 3 new cards worth 30. Total rose, price effect fell.
  const lf = ctx.likeForLikeChange({ a: 1 }, { a: 8, n1: 10, n2: 10, n3: 10 }, { a: 10, n1: 10, n2: 10, n3: 10 });
  assert.equal(lf.change, -2);
});
