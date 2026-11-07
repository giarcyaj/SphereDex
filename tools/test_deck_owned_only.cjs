'use strict';

// Run with: node tools/test_deck_owned_only.cjs
// The deck builder "Owned only" toggle, extracted from src/paldeck.html.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');
const m = /function deckOwnedPass\([^)]*\)\{[\s\S]*?\n  \}/.exec(source);
assert.ok(m, 'deckOwnedPass exists');
const box = {};
vm.createContext(box);
vm.runInContext(m[0], box);

test('off keeps every card', () => {
  assert.equal(box.deckOwnedPass({}, 'X1', false), true);
});
test('on keeps only cards with at least one copy', () => {
  const own = { A: { qty: 2 }, B: { qty: 0 } };
  assert.equal(box.deckOwnedPass(own, 'A', true), true);
  assert.equal(box.deckOwnedPass(own, 'B', true), false);
  assert.equal(box.deckOwnedPass(own, 'C', true), false);
  assert.equal(box.deckOwnedPass(null, 'A', true), false);
});
test('deck search wires the toggle in and clicking it does not close the list', () => {
  assert.ok(source.includes('id="deckOwnedOnly"'));
  assert.ok(source.includes('deckOwnedPass(ownMap, c.id, ownedOnly)'));
  assert.ok(source.includes('!e.target.closest(".deckown")'));
});
