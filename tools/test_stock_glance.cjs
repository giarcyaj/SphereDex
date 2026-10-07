'use strict';

// Run with: node tools/test_stock_glance.cjs
// The at a glance stock line on a sealed product page.
//
// Amber is the point of this feature, and it covers two different unknowns: a product no shop in that
// market lists, and a reading too old to trust because the checker stopped running. Calling either of them
// "out of stock" would be a guess presented as a fact, so both say go and look.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'paldeck.html'), 'utf8');

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
function sandbox(asOf, state) {
  const sb = {
    STOCK: { region: 'co.uk', asOf, state, at: Date.now() },
    STOCK_STALE_MS: 2 * HOUR,
    esc: (s) => String(s),
    Date,
  };
  vm.createContext(sb);
  vm.runInContext([appFunction('stockGlance'), appFunction('stockGlanceHtml')].join('\n'), sb);
  return sb;
}
const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');

test('a product in stock reads green', () => {
  const sb = sandbox(stamp(5 * 60000), { 'box-ebp01': 'in' });
  assert.equal(sb.stockGlance('box-ebp01').cls, 'in');
  assert.match(sb.stockGlanceHtml('box-ebp01'), /class="sdstock in"/);
});

test('a product out of stock reads red', () => {
  const sb = sandbox(stamp(5 * 60000), { 'pack-ebp01': 'out' });
  assert.equal(sb.stockGlance('pack-ebp01').cls, 'out');
  assert.match(sb.stockGlanceHtml('pack-ebp01'), /class="sdstock out"/);
});

test('a product no shop lists reads amber, never red', () => {
  // 5 of the 14 sealed products are not in the checker's list at all. Showing those as out of stock would
  // be a claim nothing supports.
  const sb = sandbox(stamp(5 * 60000), { 'box-ebp01': 'in' });
  const g = sb.stockGlance('demo-deck');
  assert.equal(g.cls, 'unk');
  assert.match(g.note, /do not track/);
});

test('a reading older than two hours goes amber even when it says in stock', () => {
  // The checker runs every 30 minutes, so two hours means four missed runs. A green light off that is a
  // guess, and the worse failure, because it sends someone to a shop for nothing.
  const sb = sandbox(stamp(3 * HOUR), { 'box-ebp01': 'in' });
  assert.equal(sb.stockGlance('box-ebp01').cls, 'unk');
  assert.match(sb.stockGlance('box-ebp01').text, /unconfirmed/);
});

test('a reading just inside the window is still trusted', () => {
  const sb = sandbox(stamp(1.5 * HOUR), { 'box-ebp01': 'in' });
  assert.equal(sb.stockGlance('box-ebp01').cls, 'in');
});

test('a market that has never been polled says nothing at all rather than red', () => {
  const sb = sandbox(null, null);
  assert.equal(sb.stockGlance('box-ebp01'), null, 'no data yet renders no line');
  assert.equal(sb.stockGlanceHtml('box-ebp01'), '');
});

test('an unparseable timestamp is treated as current rather than silently amber forever', () => {
  // Date.parse returning NaN must not quietly disable the feature; the readings are still real.
  const sb = sandbox('not a date', { 'box-ebp01': 'in' });
  assert.equal(sb.stockGlance('box-ebp01').cls, 'in');
});

test('the colour is never the only signal', () => {
  // Red and green alone would fail the people most likely to need this line.
  const sb = sandbox(stamp(60000), { 'box-ebp01': 'in', 'pack-ebp01': 'out' });
  assert.match(sb.stockGlanceHtml('box-ebp01'), /In stock/);
  assert.match(sb.stockGlanceHtml('pack-ebp01'), /Out of stock/);
});
