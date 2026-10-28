'use strict';

// Run with: node tools/test_copy_photos.cjs
// Per copy photos: the collection stores only short ids, and the pictures stay on the device.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');
const start = source.indexOf('// OWN PHOTOS');
const end = source.indexOf('function copyNoteCsvCell');
assert.ok(start > 0 && end > start, 'photo block exists');
const sb = {
  rawCount: (v) => Math.max(0, parseInt(v, 10) || 0),
  rawEditionKey: (v) => v || 'unknown',
  rawEditionLabel: (v) => String(v),
  indexedDB: undefined,
};
vm.createContext(sb);
vm.runInContext(source.slice(start, end), sb);
const plain = (x) => JSON.parse(JSON.stringify(x));

test('photoIdsClean keeps only well formed, unique ids and caps the list', () => {
  assert.deepEqual(plain(sb.photoIdsClean(['pabc123', 'pabc123', 'bad id', 7, null, 'pdef4567', 'pghi89012', 'pjkl01234'])), ['pabc123', 'pdef4567', 'pghi89012']);
  assert.deepEqual(plain(sb.photoIdsClean('pabc123')), []);
  assert.deepEqual(plain(sb.photoIdsClean(undefined)), []);
});

test('a numbered copy that only has a photo is kept, one with nothing is not', () => {
  const kept = sb.copyNoteClean({ ph: ['pabc123'] });
  assert.deepEqual(plain(kept), { ph: ['pabc123'] });
  assert.equal(sb.copyNoteClean({ ph: ['nope'] }), null);
  assert.equal(sb.copyNoteClean({}), null);
});

test('photos ride along with serial and note and show in the label', () => {
  const n = sb.copyNoteClean({ serial: '372', run: '750', note: 'Sleeved', ph: ['pabc123', 'pdef4567'] });
  assert.deepEqual(plain(n.ph), ['pabc123', 'pdef4567']);
  assert.equal(sb.copyNoteLabel(n), '372 of 750 · Sleeved · 2 photos');
  assert.equal(sb.copyNoteLabel(sb.copyNoteClean({ ph: ['pabc123'] })), '1 photo');
});

test('copies without photos are unchanged', () => {
  const n = sb.copyNoteClean({ serial: '9', run: '100' });
  assert.deepEqual(plain(n), { serial: '9', run: '100' });
  assert.equal(sb.copyNoteLabel(n), '9 of 100');
});

test('photoFitSize shrinks the long side to the limit and never enlarges', () => {
  assert.deepEqual(plain(sb.photoFitSize(4000, 3000)), { w: 1280, h: 960 });
  assert.deepEqual(plain(sb.photoFitSize(3000, 4000)), { w: 960, h: 1280 });
  assert.deepEqual(plain(sb.photoFitSize(800, 600)), { w: 800, h: 600 });
  assert.deepEqual(plain(sb.photoFitSize(0, 10)), { w: 0, h: 0 });
});

test('photoNewId makes ids the cleaner accepts', () => {
  const id = sb.photoNewId();
  assert.deepEqual(plain(sb.photoIdsClean([id])), [id]);
});

test('without IndexedDB the store fails cleanly instead of throwing', async () => {
  await assert.rejects(sb.photoGet('pabc123'));
  // photoDelete swallows the failure
  sb.photoDelete(['pabc123']);
});

test('photos never enter the stored state as picture data', () => {
  // The only places that write photo data are the IndexedDB put and the id lists.
  assert.doesNotMatch(source, /\.photos\s*=\s*['"]data:/);
  assert.match(source, /PHOTO_DB_NAME="spheredex-photos"/);
});

test('copyNoteClean cleans photo ids the same way photoIdsClean does', () => {
  const ids = ['pabc123', 'pabc123', 'bad id', 'pdef4567', 'pghi89012', 'pjkl01234'];
  assert.deepEqual(plain(sb.copyNoteClean({ ph: ids }).ph), plain(sb.photoIdsClean(ids)));
});
