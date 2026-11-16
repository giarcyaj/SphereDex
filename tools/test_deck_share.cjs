'use strict';

// Run with: node tools/test_deck_share.cjs
// Share a deck as a link: the link carries the deck, and only known card numbers come back out.
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
function sandbox() {
  const byNumberIdx = {
    'EBP01-001': { id: 'EBP01-001', setIdx: 0, seq: 1 },
    'EBP01-002': { id: 'EBP01-002', setIdx: 0, seq: 2 },
    'EBP02-010': { id: 'EBP02-010', setIdx: 1, seq: 10 },
  };
  const sb = { Object, Array, String, Math, parseInt, encodeURIComponent, decodeURIComponent, byNumberIdx, DECK_LINE_MAX: 60,
    DECK_SHARE_BASE: 'https://spheredex.app/app/#deck=' };
  vm.createContext(sb);
  vm.runInContext(['deckShareCode', 'deckShareUrl', 'parseDeckShare', 'deckShareCopies'].map(appFunction).join('\n'), sb);
  return sb;
}

test('a deck survives the round trip through its link', () => {
  const sb = sandbox();
  const d = { name: 'Fire & Ice, v2', cards: { 'EBP02-010': 2, 'EBP01-002': 4, 'EBP01-001': 1 } };
  const url = sb.deckShareUrl(d);
  assert.match(url, /^https:\/\/spheredex\.app\/app\/#deck=/);
  const res = sb.parseDeckShare(url);
  assert.equal(res.name, 'Fire & Ice, v2');
  assert.equal(JSON.stringify(res.cards), JSON.stringify({ 'EBP01-001': 1, 'EBP01-002': 4, 'EBP02-010': 2 }));
  assert.equal(res.skipped, 0);
  assert.equal(sb.deckShareCopies(res), 7);
});

test('a bare code and a hash both read back', () => {
  const sb = sandbox();
  const code = sb.deckShareCode({ name: 'A', cards: { 'EBP01-001': 3 } });
  assert.equal(sb.parseDeckShare(code).cards['EBP01-001'], 3);
  assert.equal(sb.parseDeckShare('#deck=' + code).cards['EBP01-001'], 3);
});

test('unknown cards, bad counts and huge counts are handled', () => {
  const sb = sandbox();
  const res = sb.parseDeckShare('#deck=Hacked~NOPE-1:4,EBP01-001:0,EBP01-002:999,EBP01-001:x,<script>:1');
  assert.equal(JSON.stringify(res.cards), JSON.stringify({ 'EBP01-002': 60 }));
  assert.equal(res.skipped, 4);
});

test('text without a code is not a deck link', () => {
  const sb = sandbox();
  assert.equal(sb.parseDeckShare('4 EBP01-001 Lamball\n2 EBP01-002'), null);
  assert.equal(sb.parseDeckShare(''), null);
});

test('share UI is wired and its copy has no dashes', () => {
  assert.match(source, /id="deckShare"/);
  assert.match(source, /"deckExport","deckShare"/);
  const block = source.slice(source.indexOf('// ---- Share a deck as a link ----'), source.indexOf('function downloadDeckText'));
  const strings = block.match(/"[^"\n]*"/g).filter((s) => /[A-Za-z]{3} [A-Za-z]{2}/.test(s));
  strings.forEach((s) => assert.doesNotMatch(s, /[–—]|\w-\w/, 'user copy has no dash: ' + s));
});

test('a deck link waits for onboarding and the nav is rebuilt when player tools turn on', () => {
  const check = appFunction('checkSharedDeckLink');
  assert.match(check, /if\(!SETTINGS\.onboarded\) return;/);
  assert.ok(check.indexOf('SETTINGS.onboarded') < check.indexOf('replaceState'), 'hash is kept until onboarding is done');
  assert.match(appFunction('finishOnboard'), /checkSharedDeckLink\(\)/);
  assert.match(appFunction('importSharedDeck'), /applyFeatureFlags\(\); buildNavMenu\(\); buildQuickMenuSettings\(\);/);
});
