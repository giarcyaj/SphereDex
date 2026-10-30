'use strict';

// Run with: node tools/test_storage_location.cjs
// Storage location: the optional "Where it is" label on owned cards, its search and its grouped list.
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
const sb = { String, Math, Array, Object, fold: (s) => String(s).toLowerCase() };
vm.createContext(sb);
['whereClean', 'whereMatches', 'whereGroups'].forEach((n) => {
  const code = appFunction(n);
  assert.doesNotMatch(code, /\b(let|const)\s|=>|`|\?\.|\?\?/, n + ' is ES5');
  vm.runInContext(code, sb);
});

test('labels are trimmed and capped', () => {
  assert.equal(sb.whereClean('  Binder   2 '), 'Binder 2');
  assert.equal(sb.whereClean(null), '');
  assert.equal(sb.whereClean('x'.repeat(100)).length, 60);
});
test('search matches the label, case blind', () => {
  assert.equal(sb.whereMatches({ where: 'Binder 2, page 5' }, 'binder 2'), true);
  assert.equal(sb.whereMatches({ where: 'Shoebox A' }, 'binder'), false);
  assert.equal(sb.whereMatches({}, 'binder'), false);
  assert.equal(sb.whereMatches({ where: 'Shoebox A' }, ''), false);
});
test('groups owned cards by location, skipping unlabelled and unowned', () => {
  const cards = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }];
  const own = {
    a: { qty: 2, where: 'Shoebox A' },
    b: { qty: 1, where: 'binder 1' },
    c: { qty: 0, where: 'Binder 1' },
    d: { qty: 1 },
  };
  const g = sb.whereGroups(own, cards);
  assert.deepEqual(JSON.parse(JSON.stringify(g)), [
    { where: 'binder 1', cards: [{ id: 'b', name: 'B', copies: 1 }] },
    { where: 'Shoebox A', cards: [{ id: 'a', name: 'A', copies: 2 }] },
  ]);
});
test('wired into the detail sheet, search and merge', () => {
  assert.match(source, /id="fWhere"/);
  assert.match(source, /whereMatches\(o\(c\.id\), filters\.q\)/);
  assert.match(source, /out\.where=String\(b\.where\)\.trim\(\)/);
});
test('labels named like Object.prototype keys still group', () => {
  const cards = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  const own = { a: { qty: 1, where: 'constructor' }, b: { qty: 1, where: '__proto__' }, c: { qty: 1, where: 'toString' } };
  const g = sb.whereGroups(own, cards);
  assert.equal(g.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(g.map((x) => x.where).sort())), ['__proto__', 'constructor', 'toString']);
});
