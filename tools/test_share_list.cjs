'use strict';

// Run with: node tools/test_share_list.cjs
// Share wants and spares as a read-only link: build, encode, decode and clean.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');
function slice() {
  const a = source.indexOf('  // ---- Share wants and spares as a link ----');
  const b = source.indexOf('  function shareListShow(');
  assert.ok(a > 0 && b > a, 'share section found');
  return source.slice(a, b);
}
function box() {
  const sb = { Math, JSON, Object, Array, String, Number, isFinite, btoa, atob,
    rawCount: (n) => { n = Number(n); return isFinite(n) ? Math.max(0, Math.floor(n)) : 0; },
    SETS: { A: { name: 'Set A' } }, esc: (x) => String(x).replace(/</g, '&lt;'),
    cardById: (id) => (id === 'E1' ? { id, name: 'Lamball <b>', set: 'A' } : null) };
  vm.createContext(sb); vm.runInContext(slice(), sb); return sb;
}
const J = (x) => JSON.stringify(x);

test('no ES2015+ syntax that the older WebViews reject', () => {
  const code = slice();
  assert.doesNotMatch(code, /\b(let|const)\s|=>|`|\?\.|\?\?|\.includes\(/);
});
test('spares are copies beyond the first, graded included; singles are not spares', () => {
  const sb = box();
  const l = sb.shareListBuild(['W1'], { E1: { qty: 3 }, E2: { qty: 1 }, E3: { qty: 1, graded: [{}] }, E4: null }, null);
  assert.equal(J(l.w), '["W1"]'); assert.equal(J(l.s), '[["E1",2],["E3",1]]'); assert.equal(l.p, null);
});
test('round trip keeps the list, and a link carries no prices unless asked', () => {
  const sb = box();
  const l = sb.shareListBuild(['W1', 'W2'], { E1: { qty: 2 } }, null);
  const url = sb.shareListLink(l);
  assert.ok(url.startsWith('https://spheredex.app/app/#list='));
  assert.doesNotMatch(url.slice(url.indexOf('=') + 1), /[+\/=]/);
  const back = sb.shareListDecode(url.slice(url.indexOf('#')));
  assert.equal(J(back.w), J(l.w)); assert.equal(J(back.s), J(l.s)); assert.equal(back.p, null);
});
test('prices are included only when a price function is given', () => {
  const sb = box();
  const l = sb.shareListBuild(['W1'], { E1: { qty: 2 } }, (id) => (id === 'W1' ? 1.234 : 0));
  assert.equal(J(l.p), '{"W1":1.23}');
  l.c = 'usd';
  const back = sb.shareListDecode(sb.shareListEncode(sb.shareListClean(Object.assign({}, l, { c: 'usd' }))));
  assert.equal(back.c, 'USD'); assert.equal(back.p.W1, 1.23);
});
test('the sender edition travels in the link and labels the rows, not the viewer setting', () => {
  const sb = box();
  const jp = sb.shareListBuild(['EBP01-001'], { 'EBP01-002': { qty: 2 } }, null, 'jp');
  const back = sb.shareListDecode(sb.shareListEncode(jp));
  assert.equal(back.e, 'jp');
  const html = sb.shareListHtml(back);
  assert.match(html, /<small>BP01-001/); assert.doesNotMatch(html, /<small>EBP01-001/);
  const en = sb.shareListDecode(sb.shareListEncode(sb.shareListBuild(['EBP01-001'], {}, null, 'en')));
  assert.equal(en.e, 'en'); assert.match(sb.shareListHtml(en), /<small>EBP01-001/);
});
test('user facing copy of the share dialog has no hyphens or dashes', () => {
  const a = source.indexOf('id="shareViewScrim"'), b = source.indexOf('</div>\n</div>', a);
  const copy = source.slice(a, b).replace(/<[^>]+>/g, ' ').replace(/id="[^"]*"/g, '');
  assert.doesNotMatch(copy, /[-\u2013\u2014]/);
  assert.doesNotMatch(source.slice(source.indexOf('function shareListStart'), source.indexOf('  // ---- Navigation ----')), /message:"[^"]*[-\u2013\u2014]/);
});
test('empty list cannot be shared', () => {
  assert.equal(box().shareListBuild([], { E1: { qty: 1 } }, null), null);
});
test('hostile or broken links decode to null or are cleaned', () => {
  const sb = box();
  assert.equal(sb.shareListDecode('#list=!!!'), null);
  assert.equal(sb.shareListDecode('#list='), null);
  assert.equal(sb.shareListDecode('#list=' + Buffer.from('not json').toString('base64')), null);
  const evil = Buffer.from(J({ w: ['<img src=x onerror=1>', 'OK1', 'OK1', 5], s: [['E1', 9999], ['E2', -1], ['E3', 'x']], p: { 'a b': 3, OK1: 'NaN' } })).toString('base64');
  const l = sb.shareListDecode('#list=' + evil);
  assert.equal(J(l.w), '["OK1","5"]'); assert.equal(J(l.s), '[["E1",99]]'); assert.equal(l.p, null);
});
test('size is bounded', () => {
  const sb = box(), ids = []; for (let i = 0; i < 5000; i++) ids.push('C' + i);
  assert.equal(sb.shareListClean({ w: ids }).w.length, 1000);
});
test('the viewer escapes card names and never writes to the collection', () => {
  const sb = box();
  const html = sb.shareListHtml(sb.shareListClean({ w: ['E1'], s: [['E1', 2]] }));
  assert.match(html, /Lamball &lt;b>/); assert.doesNotMatch(html, /<b>Lamball <b>/);
  assert.match(html, /×2/);
  const body = source.slice(source.indexOf('  function shareListShow('), source.indexOf('  // ---- Navigation ----'));
  assert.doesNotMatch(body.split('function shareListStart')[0], /STATE\.|save\(\)|own\[/);
});
test('the buttons and the viewer are wired in', () => {
  for (const id of ['wishShareBtn', 'extrasShareBtn', 'shareViewScrim', 'shareViewBody', 'shareViewClose']) assert.ok(source.includes('id="' + id + '"'), id);
  assert.match(source, /shareListOpenFromHash\(\)/);
});
