const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync('src/paldeck.html', 'utf8');
function fn(name) {
  const start = src.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  const end = src.indexOf('\n  function ', start + 1);
  return src.slice(start, end < 0 ? undefined : end);
}
const ctx = {
  CARDS: [{id:'a',set:'A'}, {id:'b',set:'B'}, {id:'c',set:'C'}, {id:'soul',set:'A'}],
  entries: {a:{qty:3,graded:[{value:40}]}, b:{qty:2}, c:{qty:99}},
  o(id) { return this.entries[id] || {}; },
  rawCount(q) { return +q || 0; },
  unitOf(id, mode) { return ({a:10,b:5,soul:1}[id] || 0) * (mode === 'sold' ? 2 : 1); },
  priceMode() { return 'live'; },
  money(n) { return 'GBP ' + n.toFixed(2); },
  esc(s) { return s; }
};
// Functions execute as plain globals, as they do inside the app.
ctx.o = id => ctx.entries[id] || {};
vm.createContext(ctx);
vm.runInContext(fn('cardValueMode') + '\n' + fn('setCollectionValueHtml'), ctx);
const both = ctx.setCollectionValueHtml(['A','B']);
assert.match(both, /Live listings<\/span><b>GBP 80.00/);
assert.match(both, /Sold listings<\/span><b>GBP 120.00/);
assert.equal((ctx.setCollectionValueHtml(['C']).match(/GBP 0.00/g) || []).length, 2);
ctx.priceMode = () => 'sold';
assert.equal(ctx.setCollectionValueHtml(['A','B']), both, 'Both totals stay visible regardless of selected mode');
assert.match(ctx.setCollectionValueHtml(['A']), /Your collection value/);
assert.match(fn('oneSetTile'), /setCollectionValueHtml\(\[k\]\)/);
assert.match(fn('expansionTile'), /setCollectionValueHtml\(x.sets\)/);
assert.match(fn('renderSetBrowse'), /setCollectionValueHtml\(SET_ORDER\)/);
assert.doesNotMatch(fn('upcomingTile'), /setCollectionValueHtml/);
console.log('Set collection values: quantities, graded, grouping, empty sets, price modes and tile integration passed');
