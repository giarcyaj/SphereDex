'use strict';

// Run with: node tools/test_upcoming_cards.cjs
// PalDex "Card upcoming in <set>" labels, plus docs/paldex/upcoming-cards.json.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const sourcePath = path.join(root, 'src', 'paldeck.html');
const feedPath = path.join(root, 'docs', 'paldex', 'upcoming-cards.json');
const readmePath = path.join(root, 'docs', 'paldex', 'README.md');
const source = fs.readFileSync(sourcePath, 'utf8');
const ENTRY_FIELDS = ['pal', 'set', 'set_code', 'release_date', 'card_name', 'card_number', 'source_url', 'revealed_at'];
const NO_CARD_PALS = [
  'Anubis', 'Chillet Ignis', 'Frostallion', 'Frostallion Noct', 'Jetragon',
  'Leezpunk Ignis', 'Orserk', 'Prixter', 'Quivern Botan', 'Relaxaurus Lux',
  'Selyne', 'Swee', 'Sweepa', 'Quivern'
];

function extractBlock() {
  const begin = '/* UPCOMING CARDS BEGIN */';
  const end = '/* UPCOMING CARDS END */';
  const starts = [];
  let at = 0;
  while ((at = source.indexOf(begin, at)) !== -1) { starts.push(at); at += begin.length; }
  const ends = [];
  at = 0;
  while ((at = source.indexOf(end, at)) !== -1) { ends.push(at); at += end.length; }
  assert.equal(starts.length, 1, 'UPCOMING CARDS BEGIN marker once');
  assert.equal(ends.length, 1, 'UPCOMING CARDS END marker once');
  assert.ok(starts[0] < ends[0]);
  return source.slice(starts[0] + begin.length, ends[0]);
}

function paldexNames() {
  const m = source.match(/var PALDEX_NO = (\{.*?\});/);
  assert.ok(m, 'PALDEX_NO is present');
  return JSON.parse(m[1]);
}

const block = extractBlock();

function loadApp(opts) {
  opts = opts || {};
  const store = opts.store || {};
  const sandbox = {
    esc: function(s) {
      return String(s).replace(/[&<>"']/g, function(ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
      });
    },
    $: function() { return null; },
    lsGet: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    lsSet: function(k, v) { store[k] = String(v); },
    fetch: opts.fetch || function() { return Promise.reject(new Error('offline')); },
    Date: Date
  };
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  sandbox.store = store;
  return sandbox;
}

function flush() {
  return Promise.resolve().then(function() { return Promise.resolve(); }).then(function() { return Promise.resolve(); });
}

function published() {
  return JSON.parse(fs.readFileSync(feedPath, 'utf8'));
}

test('the published file matches the schema and PalDex names', function() {
  const ctx = loadApp();
  const feed = published();
  const names = paldexNames();
  assert.deepEqual(Object.keys(feed).sort(), ['entries', 'updated_at']);
  assert.equal(typeof feed.updated_at, 'string');
  assert.equal(Number.isNaN(ctx.upcomingIso(feed.updated_at)), false);
  assert.ok(Array.isArray(feed.entries));
  assert.ok(feed.entries.length > 0);
  assert.equal(Object.prototype.hasOwnProperty.call(feed, 'unconfirmed'), false);
  const norm = ctx.upcomingNormalise(feed);
  assert.ok(norm);
  assert.equal(norm.entries.length, feed.entries.length, 'every entry must match docs/paldex/README.md');
  const keys = new Set();
  feed.entries.forEach(function(entry) {
    assert.deepEqual(Object.keys(entry).sort(), ENTRY_FIELDS.slice().sort());
    assert.equal(typeof entry.pal, 'string');
    assert.equal(Object.prototype.hasOwnProperty.call(names, entry.pal), true, 'unknown Pal ' + entry.pal);
    assert.equal(names[entry.pal] !== undefined, true);
    assert.equal(entry.card_name === null || typeof entry.card_name === 'string', true);
    assert.equal(entry.card_number === null || typeof entry.card_number === 'string', true);
    const key = ctx.upcomingKey(entry);
    assert.equal(keys.has(key), false, 'duplicate ' + key);
    keys.add(key);
  });
  NO_CARD_PALS.forEach(function(pal) {
    assert.ok(feed.entries.some(function(entry) { return entry.pal === pal; }), 'missing ' + pal);
  });
  assert.equal(ctx.UPCOMING_CARDS_URL, 'https://spheredex.app/paldex/upcoming-cards.json');
});

test('the schema readme names every field and the live URL', function() {
  const readme = fs.readFileSync(readmePath, 'utf8');
  [
    'updated_at', 'entries', 'pal', 'set', 'set_code', 'release_date',
    'card_name', 'card_number', 'source_url', 'revealed_at',
    'https://spheredex.app/paldex/upcoming-cards.json',
    'docs/paldex/upcoming-cards.json',
    'Card upcoming in'
  ].forEach(function(field) {
    assert.ok(readme.includes(field), 'README mentions ' + field);
  });
});

test('a Pal with no cards names the soonest unreleased set', function() {
  const ctx = loadApp();
  const entries = ctx.upcomingNormalise(published()).entries;
  const now = Date.parse('2026-09-28T12:00:00Z');
  const anubis = ctx.upcomingMatch('Anubis', false, entries, now);
  assert.equal(ctx.upcomingPhrase(anubis.set), 'Card upcoming in Legends Awaken');
  assert.equal(anubis.release_date, '2026-10-30');
  assert.equal(anubis.entries.length, 2);
  const quivern = ctx.upcomingMatch('Quivern', false, entries, now);
  assert.equal(ctx.upcomingPhrase(quivern.set), 'Card upcoming in Sleeve & Card Set Vol.1');
  assert.equal(ctx.upcomingMatch('Lamball', false, entries, now), null);
  assert.equal(ctx.upcomingMatch('Cattiva', true, entries, now), null);
  assert.equal(ctx.upcomingMatch('Anubis', true, entries, now), null);
  assert.ok(ctx.upcomingMatch('Anubis', false, entries, Date.parse('2026-10-30T23:00:00Z')));
  assert.equal(ctx.upcomingMatch('Anubis', false, entries, Date.parse('2026-10-31T00:00:00Z')), null);
  assert.equal(ctx.upcomingMatch('Quivern', false, entries, Date.parse('2026-10-17T00:00:00Z')), null);
});

test('the sheet shows a revealed name and source, and never invents one', function() {
  const ctx = loadApp();
  const entries = ctx.upcomingNormalise(published()).entries;
  const now = Date.parse('2026-09-28T12:00:00Z');
  const anubis = ctx.upcomingSheetHtml('Anubis', ctx.upcomingMatch('Anubis', false, entries, now));
  assert.match(anubis, /Card upcoming in Legends Awaken/);
  assert.match(anubis, /30 Oct 2026/);
  const names = anubis.match(/class="upname">([^<]*)</g) || [];
  assert.deepEqual(names, ['class="upname">Anubis – Noble Reaper<']);
  assert.match(anubis, /EBP02-049/);
  assert.match(anubis, /href="https:\/\/x\.com\/PalworldOCG_EN\/status\/2103423638800339279"/);
  assert.match(anubis, />Source</);
  assert.match(anubis, />Official reveal</);
  const orserk = ctx.upcomingSheetHtml('Orserk', ctx.upcomingMatch('Orserk', false, entries, now));
  assert.equal(orserk.includes('upname'), false);
  assert.equal(orserk.includes('upnum'), false);
  assert.match(orserk, /href="https:\/\/x\.com\/PalworldOCG_EN\/status\/2093503912149950892"/);
  assert.match(orserk, />Official reveal</);
});

test('rows that break the schema or repeat a reveal are dropped', function() {
  const ctx = loadApp();
  const feed = published();
  const extra = JSON.parse(JSON.stringify(feed));
  extra.entries.push(Object.assign({}, extra.entries[0], { source_url: 'http://insecure.example/card' }));
  extra.entries.push(JSON.parse(JSON.stringify(extra.entries[0])));
  extra.entries.push(Object.assign({}, extra.entries[0], { pal: 'Not A Pal', source_url: 'https://example.invalid/nope' }));
  const norm = ctx.upcomingNormalise(extra);
  assert.equal(norm.entries.length, feed.entries.length + 1);
  assert.equal(norm.entries.filter(function(entry) { return entry.pal === 'Not A Pal'; }).length, 1);
  assert.equal(ctx.upcomingNormalise({ updated_at: '2026-09-28T00:00:00Z', entries: 'nope' }), null);
  assert.equal(ctx.upcomingPassed('not-a-date', Date.parse('2026-09-28T00:00:00Z')), true);
});

test('offline load keeps the bundled copy, and a live file replaces it', async function() {
  const offline = loadApp();
  offline.upcomingLoad();
  await flush();
  const bundled = offline.upcomingNormalise(offline.UPCOMING_CARDS_FALLBACK).entries;
  assert.ok(bundled.length > 0);
  const still = offline.upcomingMatch('Anubis', false, offline._upcomingEntries, Date.parse('2026-09-28T12:00:00Z'));
  assert.equal(offline.upcomingPhrase(still.set), 'Card upcoming in Legends Awaken');

  const live = {
    updated_at: '2026-09-29T00:00:00Z',
    entries: [{
      pal: 'Lamball',
      set: 'Example Set',
      set_code: 'EX01',
      release_date: '2026-12-01',
      card_name: null,
      card_number: null,
      source_url: 'https://example.invalid/lamball',
      revealed_at: '2026-09-29T00:00:00Z'
    }]
  };
  let requested = null;
  const ctx = loadApp({
    fetch: function(url, init) {
      requested = { url: url, init: init };
      return Promise.resolve({ ok: true, json: function() { return Promise.resolve(live); } });
    }
  });
  ctx.upcomingLoad();
  await flush();
  assert.equal(requested.url, 'https://spheredex.app/paldex/upcoming-cards.json');
  assert.equal(requested.init.cache, 'no-store');
  assert.equal(ctx._upcomingEntries.length, 1);
  assert.equal(ctx._upcomingEntries[0].pal, 'Lamball');
  assert.equal(ctx._upcomingEntries[0].card_name, null);
  const saved = JSON.parse(ctx.store['palvault-upcoming-cards']);
  assert.equal(saved.feed.entries[0].pal, 'Lamball');

  const again = loadApp({
    store: ctx.store,
    fetch: function() { return Promise.reject(new Error('offline')); }
  });
  again.upcomingLoad();
  await flush();
  assert.equal(again._upcomingEntries.length, 1);
  assert.equal(again._upcomingEntries[0].set, 'Example Set');
});

test('a bad live payload leaves the bundled copy in place', async function() {
  const ctx = loadApp({
    fetch: function() {
      return Promise.resolve({ ok: true, json: function() { return Promise.resolve({ updated_at: 'nope', entries: {} }); } });
    }
  });
  const before = ctx._upcomingEntries.length;
  ctx.upcomingLoad();
  await flush();
  assert.equal(ctx._upcomingEntries.length, before);
  assert.equal(ctx.store['palvault-upcoming-cards'], undefined);
});

test('Eternal Ascent lists the booster and both trial decks', function() {
  assert.match(source, /code:"EBP03", name:"Booster Box"/);
  assert.match(source, /id:"box-bp03"[^}]*date:"Jan 29, 2027"/);
  assert.match(source, /id:"pack-bp03"[^}]*date:"Jan 29, 2027"/);
  assert.match(source, /id:"td-ea-rg"[^}]*nk:\["TD03","Red・Green"\][^}]*date:"Dec 18, 2026"/);
  assert.match(source, /id:"td-ea-bp"[^}]*nk:\["TD04","Blue・Purple"\][^}]*date:"Dec 18, 2026"/);
  assert.match(source, /id="upScrim"/);
});
