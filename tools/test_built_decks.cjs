'use strict';

// Run with: node tools/test_built_decks.cjs
// Built decks hold their copies: a built deck reserves its cards, other decks count only free copies,
// and Extras skips reserved copies.
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

function make(deckList, own, tools) {
  const state = { decks: deckList };
  const sb = {
    STATE: state,
    byNumberIdx: { CHILLET: {}, LAMBALL: {} },
    activeCol: () => ({ own: own, name: 'Mine' }),
    playerToolsOn: () => tools !== false,
    copiesOf: (s) => (+s.qty || 0) + (Array.isArray(s.graded) ? s.graded.length : 0),
  };
  vm.createContext(sb);
  vm.runInContext(['decks', 'deckBuilt', 'deckLockedQty', 'deckFreeQty', 'extraCopies', 'deckNeedCount', 'deckNeedLabel', 'deckNeedFirstCount']
    .map(appFunction).join('\n'), sb);
  return sb;
}

const own = { CHILLET: { qty: 4 } };
const A = () => ({ id: 'a', name: 'A', cards: { CHILLET: 4 } });
const B = () => ({ id: 'b', name: 'B', cards: { CHILLET: 4 } });

test('without a built deck, two decks both say Ready to build on 4 copies', () => {
  const sb = make([A(), B()], own);
  assert.equal(sb.deckNeedLabel(A()), 'Ready to build');
  assert.equal(sb.deckNeedLabel(B()), 'Ready to build');
});

test('a built deck reserves its copies so the other deck needs them', () => {
  const a = Object.assign(A(), { built: true });
  const sb = make([a, B()], own);
  assert.equal(sb.deckNeedLabel(a), 'Ready to build');   // never held back by its own reservation
  assert.equal(sb.deckNeedLabel(B()), 'Need 4 cards');
  assert.equal(sb.deckFreeQty(own, 'CHILLET', 'b'), 0);
  assert.equal(sb.deckNeedFirstCount(B().cards, own, 'b'), 1);
});

test('partial reservation leaves the free copies for the other deck', () => {
  const a = Object.assign(A(), { built: true, cards: { CHILLET: 3 } });
  const sb = make([a, B()], own);
  assert.equal(sb.deckFreeQty(own, 'CHILLET', 'b'), 1);
  assert.equal(sb.deckNeedLabel(B()), 'Need 3 cards');
});

test('unbuilding releases the copies', () => {
  const a = A();
  const sb = make([a, B()], own);
  a.built = true;
  assert.equal(sb.deckNeedLabel(B()), 'Need 4 cards');
  delete a.built;
  assert.equal(sb.deckNeedLabel(B()), 'Ready to build');
});

test('Extras skips reserved copies', () => {
  const a = Object.assign(A(), { built: true, cards: { CHILLET: 3 } });
  const sb = make([a], own);
  assert.equal(sb.extraCopies('CHILLET', own.CHILLET), 1);   // 4 owned, 3 held: not an extra
  assert.equal(sb.extraCopies('LAMBALL', { qty: 3 }), 3);
  const sb2 = make([A()], own);
  assert.equal(sb2.extraCopies('CHILLET', own.CHILLET), 4);
});

test('reservations are ignored when Player tools are off', () => {
  const a = Object.assign(A(), { built: true });
  const sb = make([a, B()], own, false);
  assert.equal(sb.deckLockedQty('CHILLET'), 0);
});

test('the Built button exists, a duplicate drops the flag, and copy has no dashes', () => {
  assert.match(source, /id="deckBuilt"/);
  assert.match(source, /delete copy\.built;/);
  assert.match(source, /held by built/);
  assert.doesNotMatch('Mark built Built Deck built, its copies are reserved Copies released held by built deck', /[-–—]/);
});
