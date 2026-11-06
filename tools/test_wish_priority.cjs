'use strict';

// Run with: node tools/test_wish_priority.cjs
// Wishlist priorities (Must have / Want / Someday), buy prices, the monthly budget and the Buy now list.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');
const start = source.indexOf('// ---- WISHLIST PRIORITY BEGIN ----');
const end = source.indexOf('// ---- WISHLIST PRIORITY END ----');
assert.ok(start > 0 && end > start, 'wishlist priority block exists, once');
assert.equal(source.split('WISHLIST PRIORITY BEGIN').length, 2);

function make(prices) {
  const sb = { STATE: { wishlist: {}, wishlistAt: {} }, mktOf: (id) => prices[id] || 0 };
  vm.createContext(sb);
  vm.runInContext(source.slice(start, end), sb);
  return sb;
}

test('untagged cards are Want; tags cycle and Want clears the entry', () => {
  const sb = make({});
  assert.equal(sb.wishPrio('A'), 'want');
  assert.equal(sb.cycleWishPrio('A'), 'someday');
  assert.equal(sb.cycleWishPrio('A'), 'must');
  assert.equal(sb.cycleWishPrio('A'), 'want');
  assert.equal(sb.STATE.wishPrio.A, undefined);
  sb.setWishPrio('B', 'bogus');
  assert.equal(sb.wishPrio('B'), 'want');
});

test('buy prices and budget ignore junk and clear on zero', () => {
  const sb = make({});
  sb.setWishTarget('A', '12.345');
  assert.equal(sb.wishTarget('A'), 12.35);
  sb.setWishTarget('A', '');
  assert.equal(sb.wishTarget('A'), 0);
  sb.setWishBudget('50'); assert.equal(sb.wishBudget(), 50);
  sb.setWishBudget('-3'); assert.equal(sb.wishBudget(), 0);
  assert.equal('wishBudget' in sb.STATE, false);
});

test('Buy now lists only cards at or under their price, Must haves first, with a running total', () => {
  const sb = make({ A: 10, B: 4, C: 30, D: 5, E: 0 });
  Object.assign(sb.STATE.wishlist, { A: true, B: true, C: true, D: true, E: true, F: true });
  sb.setWishTarget('A', 10); sb.setWishTarget('B', 5); sb.setWishTarget('C', 20); sb.setWishTarget('E', 9);
  sb.setWishPrio('B', 'someday'); sb.setWishPrio('A', 'must');
  // C is over its price, D has no price set, E has no market price, F has neither.
  const r = sb.wishBuyNow();
  assert.deepEqual(Array.from(r.rows.map((x) => x.id)), ['A', 'B']);
  assert.deepEqual(Array.from(r.rows.map((x) => x.cum)), [10, 14]);
  assert.equal(r.total, 14);
  assert.equal(r.budget, 0);
  assert.equal(r.left, null);
});

test('budget flags the cards that run past it', () => {
  const sb = make({ A: 10, B: 8, C: 6 });
  Object.assign(sb.STATE.wishlist, { A: true, B: true, C: true });
  ['A', 'B', 'C'].forEach((id) => sb.setWishTarget(id, 100));
  sb.setWishPrio('C', 'must');
  sb.setWishBudget(20);
  const r = sb.wishBuyNow();
  assert.deepEqual(Array.from(r.rows.map((x) => x.id)), ['C', 'B', 'A']);
  assert.deepEqual(Array.from(r.rows.map((x) => x.over)), [false, false, true]);
  assert.equal(r.total, 24);
  assert.equal(r.left, -4);
});
