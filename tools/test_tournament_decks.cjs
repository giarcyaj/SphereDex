'use strict';

// Run with: node tools/test_tournament_decks.cjs
// "In N of M winning decks" on card sheets, the Tournament staples filter, and docs/paldex/tournament-decks.json.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'paldeck.html'), 'utf8');
const feedPath = path.join(root, 'docs', 'paldex', 'tournament-decks.json');
const DASHES = /[-‐-―−]/;

function extractBlock() {
  const begin = '/* TOURNAMENT DECKS BEGIN */';
  const end = '/* TOURNAMENT DECKS END */';
  assert.equal(source.split(begin).length - 1, 1, 'TOURNAMENT DECKS BEGIN marker once');
  assert.equal(source.split(end).length - 1, 1, 'TOURNAMENT DECKS END marker once');
  const a = source.indexOf(begin);
  const b = source.indexOf(end);
  assert.ok(a < b);
  return source.slice(a + begin.length, b);
}

// `var NAME = [...]` from the app, bracket matched outside strings and run as JS (the table carries comments).
function appArray(name) {
  const m = new RegExp('var\\s+' + name + '\\s*=\\s*\\[').exec(source);
  assert.ok(m, 'App table exists: ' + name);
  let i = m.index + m[0].length - 1, depth = 0, inStr = false;
  for (let j = i; j < source.length; j++) {
    const ch = source[j];
    if (inStr) { if (ch === '\\') j++; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return vm.runInNewContext('(' + source.slice(i, j + 1) + ')');
  }
  throw new Error('Unterminated ' + name);
}

// `function NAME(...){...}` from the app, brace matched outside strings.
function appFunction(name) {
  const at = source.indexOf('function ' + name + '(');
  assert.ok(at !== -1, 'App function exists: ' + name);
  assert.equal(source.indexOf('function ' + name + '(', at + 1), -1, name + ' is defined once');
  let depth = 0, quote = null;
  for (let j = source.indexOf('{', at); j < source.length; j++) {
    const ch = source[j];
    if (quote) { if (ch === '\\') j++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(at, j + 1);
  }
  throw new Error('Unterminated ' + name);
}

const block = extractBlock();
const CARD_IDS = new Set(appArray('RAW').concat(appArray('RAW2')).map(function(row) { return row[0]; }));

function loadApp(opts) {
  opts = opts || {};
  const store = opts.store || {};
  const sandbox = {
    esc: function(s) {
      return String(s).replace(/[&<>"']/g, function(ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
      });
    },
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

function deck(id, numbers) {
  return {
    placement: 'Champion', player: 'P' + id, source_id: id,
    source_url: 'https://example.invalid/deck?id=' + id,
    cards: numbers.map(function(n) { return { number: n, count: 4, zone: 'pal' }; })
  };
}

function feedOf(events) {
  return { readme: 'test', events: events.map(function(decks, i) {
    return { name: 'Event ' + i, date: '2026-10-0' + (i + 1), date_kind: 'held', source_url: 'https://example.invalid/event' + i, decks: decks };
  }) };
}

function statsOf(ctx, feed) { return ctx.tdCount(ctx.tdNormalise(feed)); }

test('counts each base card once per deck across every event', function() {
  const ctx = loadApp();
  const stats = statsOf(ctx, feedOf([
    [deck(1, ['EBP01-025', 'EBP01-095']), deck(2, ['EBP01-025'])],
    [deck(3, ['EBP01-025', 'ETD01-012']), deck(4, ['EBP01-095'])]
  ]));
  assert.equal(stats.total, 4);
  assert.equal(stats.counts['EBP01-025'], 3);
  assert.equal(stats.counts['EBP01-095'], 2);
  assert.equal(stats.counts['ETD01-012'], 1);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.tdFigure('EBP01-025', stats))), { n: 3, m: 4 });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.tdFigure('EBP01-001', stats))), { n: 0, m: 4 });
});

test('parallel printings share the base card figure, both on the sheet and in a deck', function() {
  const ctx = loadApp();
  const stats = statsOf(ctx, feedOf([[deck(1, ['EBP01-025']), deck(2, ['EBP01-025SR']), deck(3, ['EBP01-026OSR'])]]));
  assert.equal(stats.counts['EBP01-025'], 2);
  assert.equal(stats.counts['EBP01-026'], 1);
  ['EBP01-025', 'EBP01-025SR', 'EBP01-025SP', 'EBP01-025SSP', 'EBP01-025OSR', 'ebp01-025osr'].forEach(function(id) {
    assert.equal(ctx.tdFigure(id, stats).n, 2, id);
  });
  assert.equal(ctx.tdFigure({ id: 'EBP01-025SSP', base: 'EBP01-025' }, stats).n, 2);
  assert.equal(ctx.tdFigure({ id: 'ETD01-012TSR' }, stats).n, 0);
  assert.equal(ctx.tdSheetHtml({ id: 'EBP01-025OSR', base: 'EBP01-025' }, stats), ctx.tdSheetHtml({ id: 'EBP01-025', base: 'EBP01-025' }, stats));
});

test('a card listed twice in one deck, or with its parallel, counts once', function() {
  const ctx = loadApp();
  const twice = deck(1, ['EBP01-095', 'EBP01-095', 'EBP01-095SR']);
  twice.cards[1].zone = 'event';
  const stats = statsOf(ctx, feedOf([[twice, deck(2, ['EBP01-001'])]]));
  assert.equal(stats.total, 2);
  assert.equal(stats.counts['EBP01-095'], 1);
});

test('empty, missing or broken data shows nothing and never counts a broken deck', function() {
  const ctx = loadApp();
  assert.equal(ctx.tdNormalise(null), null);
  assert.equal(ctx.tdNormalise('nope'), null);
  assert.equal(ctx.tdNormalise({ readme: 'x' }), null);
  assert.equal(ctx.tdNormalise({ events: {} }), null);
  const empty = statsOf(ctx, { events: [] });
  assert.equal(empty.total, 0);
  assert.equal(ctx.tdFigure('EBP01-025', empty), null);
  assert.equal(ctx.tdSheetHtml({ id: 'EBP01-025' }, empty), '');
  assert.equal(ctx.tdAvailable(empty), false);
  assert.equal(ctx.tdSheetHtml({ id: 'EBP01-025' }, null), '');
  assert.deepEqual(ctx.tdFilter([{ id: 'EBP01-025' }], true, null, null).length, 0);

  const noCards = deck(1, []);
  const zero = deck(2, ['EBP01-025']); zero.cards[0].count = 0;
  const half = deck(3, ['EBP01-025', 'EBP01-026']); half.cards[1].count = 1.5;
  const text = deck(4, ['EBP01-025']); text.cards[0].count = '4';
  const blank = deck(5, ['EBP01-025']); blank.cards[0].number = ' ';
  const imageOnly = { placement: 'Runner-up', player: 'X', source_id: 6, cards: null };
  const stats = statsOf(ctx, feedOf([[noCards, zero, half, text, blank, imageOnly, deck(7, ['EBP01-027']), null, 'junk']]));
  assert.equal(stats.total, 1, 'only the one sound deck is counted');
  assert.equal(stats.counts['EBP01-025'], undefined);
  assert.equal(stats.counts['EBP01-027'], 1);
});

test('the same deck listed twice in one event counts once', function() {
  const ctx = loadApp();
  const stats = statsOf(ctx, feedOf([[deck(1, ['EBP01-025']), deck(1, ['EBP01-025']), deck(2, ['EBP01-026'])]]));
  assert.equal(stats.total, 2);
  assert.equal(stats.counts['EBP01-025'], 1);
});

test('the staple rule sits in one constant and its edges hold', function() {
  const ctx = loadApp();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.TOURNAMENT_STAPLE)), { share: 0.25, minDecks: 2 });
  assert.equal(ctx.tdIsStaple(2, 8), true, 'exactly 25% and 2 decks');
  assert.equal(ctx.tdIsStaple(1, 8), false);
  assert.equal(ctx.tdIsStaple(2, 9), false, '22% falls short');
  assert.equal(ctx.tdIsStaple(3, 9), true);
  assert.equal(ctx.tdIsStaple(1, 4), false, '25% but a single deck');
  assert.equal(ctx.tdIsStaple(1, 1), false, '100% of one deck is still one deck');
  assert.equal(ctx.tdIsStaple(2, 4), true);
  assert.equal(ctx.tdIsStaple(4, 16), true);
  assert.equal(ctx.tdIsStaple(3, 16), false);
  assert.equal(ctx.tdIsStaple(0, 0), false);
  assert.equal(ctx.tdIsStaple(15, 15), true);
  ctx.TOURNAMENT_STAPLE.share = 0.5;
  ctx.TOURNAMENT_STAPLE.minDecks = 3;
  assert.equal(ctx.tdIsStaple(2, 4), false, 'the constant is what the rule reads');
  assert.equal(ctx.tdIsStaple(3, 6), true);
  assert.match(ctx.tdRuleText(), /50% of the winning decks/);
});

test('the sheet line reads N of M, stays quiet at zero, and uses no dashes', function() {
  const ctx = loadApp();
  assert.equal(ctx.tdPhrase(14, 46), 'In 14 of 46 winning decks at official events');
  assert.equal(ctx.tdPhrase(0, 46), '');
  const decks = [];
  for (let i = 1; i <= 8; i++) decks.push(deck(i, i <= 2 ? ['EBP01-025', 'EBP01-095'] : ['EBP01-095']));
  decks[0].cards.push({ number: 'EBP01-001', count: 1, zone: 'pal' });
  const stats = statsOf(ctx, feedOf([decks]));
  const staple = ctx.tdSheetHtml({ id: 'EBP01-025' }, stats);
  assert.match(staple, /In 2 of 8 winning decks at official events/);
  assert.match(staple, /Tournament staple/);
  const single = ctx.tdSheetHtml({ id: 'EBP01-001' }, stats);
  assert.match(single, /In 1 of 8 winning decks/);
  assert.equal(single.includes('Tournament staple'), false);
  assert.equal(ctx.tdSheetHtml({ id: 'EBP01-002' }, stats), '');
  [ctx.tdPhrase(3, 15), ctx.tdRuleText(), 'Tournament staples', 'Tournament staple', 'No tournament staples left for this goal.'].forEach(function(copy) {
    assert.equal(DASHES.test(copy), false, 'no dash in: ' + copy);
  });
});

test('the staples filter narrows Cards, Wishlist and Missing lists the same way', function() {
  const ctx = loadApp();
  const decks = [];
  for (let i = 1; i <= 8; i++) decks.push(deck(i, i <= 2 ? ['EBP01-025', 'EBP01-095'] : ['EBP01-095']));
  decks[0].cards.push({ number: 'EBP01-001', count: 1, zone: 'pal' });
  const stats = statsOf(ctx, feedOf([decks]));
  const card = function(id) { return { id: id, base: id.replace(/(?:OSR|SSP|TSR|TSP|SP|SR)$/, '') }; };
  const cards = [card('EBP01-001'), card('EBP01-025'), card('EBP01-025OSR'), card('EBP01-095'), card('EBP01-099')];
  const ids = function(list) { return list.map(function(c) { return c.id; }); };
  assert.deepEqual(ids(ctx.tdFilter(cards, true, null, stats)), ['EBP01-025', 'EBP01-025OSR', 'EBP01-095']);
  assert.equal(ctx.tdFilter(cards, false, null, stats), cards, 'off leaves the list untouched');
  const wishlist = [cards[0], cards[2]];
  assert.deepEqual(ids(ctx.tdFilter(wishlist, true, null, stats)), ['EBP01-025OSR']);
  const missing = cards.map(function(c) { return { card: c, need: 1 }; });
  const shown = ctx.tdFilter(missing, true, function(item) { return item.card; }, stats);
  assert.deepEqual(shown.map(function(item) { return item.card.id; }), ['EBP01-025', 'EBP01-025OSR', 'EBP01-095']);

  // Wiring: the Cards grid and the Wishlist mode share visible() and the Filters sheet, but the staples toggle
  // is kept per mode; Missing has its own chip.
  const visibleFn = appFunction('visible');
  assert.match(visibleFn, /if \(wishMode && !isWished\(c\.id\)\) return false;/);
  assert.match(visibleFn, /if \(staplesOn\(mode\) && !tdIsStapleCard\(c\)\) return false;/);
  assert.match(source, /<div class="filterpanel" id="filterPanel" hidden>[\s\S]*?id="stapleChips"[\s\S]*?id="clearFilters"/);
  assert.match(source, /var filters = \{[^\n]*staples:\{\}/);
  assert.match(appFunction('updateFilterCount'), /if\(staplesOn\(\)\) n\+\+;/);
  assert.match(appFunction('updateFilterCount'), /\$\("stapleChip"\)[^\n]*aria-pressed", staplesOn\(\)/, 'the chip shows the state of the mode on screen');
  const resets = source.split('filters.keywords={}; filters.promos={};').length - 1;
  assert.ok(resets > 0);
  assert.equal(source.split('filters.keywords={}; filters.promos={}; filters.staples={};').length - 1, resets, 'every filter reset clears staples in every mode');
  assert.equal(/filters\.staples\s*(?:&&|\?|\)|=\s*!)/.test(source), false, 'nothing reads filters.staples as one shared flag');
  assert.match(source, /id="missingStaples"[^>]*hidden>Tournament staples</);
  assert.match(source, /var shown=tdFilter\(items, missingStaples, function\(item\)\{ return item\.card; \}\);/);
  assert.match(source, /tdSheetHtml\(c\)\+/);
  assert.match(source, /if\(typeof tdLoad==="function"\) tdLoad\(\);/);
});

// The real visible(), colMode() and staples helpers from the app, over a small stub binder.
function loadGrid() {
  const filtersDecl = /var filters = \{[^\n]*\};/.exec(source);
  assert.ok(filtersDecl, 'filters declaration');
  const wished = { 'EBP01-001': 1, 'EBP01-025': 1, 'EBP01-095': 1 };
  const staple = { 'EBP01-025': 1, 'EBP01-095': 1 };
  const card = function(id, i) { return { id: id, name: id, set: 'EBP01', color: 'red', kind: 'pal', rare: 'C', els: [], keywords: [], setIdx: 0, seq: i }; };
  const sandbox = {
    CARDS: ['EBP01-001', 'EBP01-025', 'EBP01-095', 'EBP01-099'].map(card),
    wishMode: false, favMode: false, gradedMode: false, collectedMode: false,
    RECENT: {}, SINCE_VISIT: {}, RARE_ORDER: { C: 0 }, sortDir: 1, ownShowGraded: true,
    fold: function(s) { return String(s).toLowerCase(); },
    keysOn: function(obj) { return Object.keys(obj).filter(function(k) { return obj[k]; }); },
    setFilterCodes: function() { return []; },
    promoTypeAllows: function() { return true; },
    cardMatchesQuery: function(c, q) { return c.id.toLowerCase().indexOf(q.toLowerCase()) !== -1; },
    tdIsStapleCard: function(c) { return !!staple[c.id]; },
    isWished: function(id) { return !!wished[id]; },
    isFav: function() { return false; },
    o: function() { return {}; }, has: function() { return false; },
    rawCount: function() { return 0; }, copiesOf: function() { return 0; },
    recentIds: function() { return {}; }, recentFilterOn: function() { return false; }, sinceVisitOn: function() { return false; },
    addedAt: function() { return 0; }, mktOf: function() { return 0; }
  };
  vm.createContext(sandbox);
  vm.runInContext([filtersDecl[0], appFunction('colMode'), appFunction('staplesOn'), appFunction('setStaples'), appFunction('visible'), appFunction('wishCountText')].join('\n'), sandbox);
  sandbox.ids = function() { return vm.runInContext('visible()', sandbox).map(function(c) { return c.id; }); };
  sandbox.mode = function(m) { vm.runInContext('wishMode=' + (m === 'wish') + '; favMode=' + (m === 'fav') + ';', sandbox); };
  return sandbox;
}

test('Tournament staples on in Cards does not filter Wishlist, and the reverse', function() {
  const g = loadGrid();
  g.mode('col');
  assert.deepEqual(g.ids(), ['EBP01-001', 'EBP01-025', 'EBP01-095', 'EBP01-099']);
  vm.runInContext('setStaples(true)', g);
  assert.deepEqual(g.ids(), ['EBP01-025', 'EBP01-095'], 'Cards narrows to staples');
  g.mode('wish');
  assert.equal(vm.runInContext('staplesOn()', g), false);
  assert.deepEqual(g.ids(), ['EBP01-001', 'EBP01-025', 'EBP01-095'], 'Wishlist opens whole');
  g.mode('fav');
  assert.equal(vm.runInContext('staplesOn()', g), false, 'other modes stay off too');

  const h = loadGrid();
  h.mode('wish');
  vm.runInContext('setStaples(true)', h);
  assert.deepEqual(h.ids(), ['EBP01-025', 'EBP01-095'], 'Wishlist narrows to staples');
  h.mode('col');
  assert.deepEqual(h.ids(), ['EBP01-001', 'EBP01-025', 'EBP01-095', 'EBP01-099'], 'Cards stays whole');
  h.mode('wish');
  assert.deepEqual(h.ids(), ['EBP01-025', 'EBP01-095'], 'Wishlist remembers its own toggle');

  // Every other filter is still shared between the modes, as before.
  vm.runInContext('filters.q="025"', h);
  h.mode('col');
  assert.deepEqual(h.ids(), ['EBP01-025']);
  vm.runInContext('filters.q=""; filters.staples={}', h);
  h.mode('wish');
  assert.deepEqual(h.ids(), ['EBP01-001', 'EBP01-025', 'EBP01-095'], 'a reset clears the toggle in every mode');
});

test('the Wishlist count line says when it shows only part of the wishlist', function() {
  const g = loadGrid();
  assert.equal(g.wishCountText(8, 8, '$40.10'), '8 on your wishlist · est. $40.10', 'unfiltered wording is unchanged');
  assert.equal(g.wishCountText(0, 0, '$0.00'), '0 on your wishlist · est. $0.00');
  assert.equal(g.wishCountText(4, 8, '$18.55'), '4 of 8 on your wishlist · est. $18.55 for the 4 shown');
  assert.equal(g.wishCountText(1, 8, '$2.00'), '1 of 8 on your wishlist · est. $2.00 for the 1 shown');
  assert.equal(g.wishCountText(0, 8, '$0.00'), '0 of 8 on your wishlist shown');
  [g.wishCountText(8, 8, '$1'), g.wishCountText(4, 8, '$1'), g.wishCountText(0, 8, '$1')].forEach(function(copy) {
    assert.equal(DASHES.test(copy), false, 'no dash in: ' + copy);
  });

  // The Wishlist mode feeds it the shown cards and the whole wishlist present in the card table.
  const count = appFunction('renderCountAndStats');
  assert.match(count, /if\(m==="wish"\) \$\("countLine"\)\.textContent = wishCountText\(cards\.length, CARDS\.filter\(function\(c\)\{ return isWished\(c\.id\); \}\)\.length, money\(cards\.reduce\(/);
  g.mode('wish');
  vm.runInContext('setStaples(true)', g);
  const shown = g.ids().length;
  const total = g.CARDS.filter(function(c) { return g.isWished(c.id); }).length;
  assert.equal(g.wishCountText(shown, total, '$5.00'), '2 of 3 on your wishlist · est. $5.00 for the 2 shown');
});

test('the published file is sound: real cards, positive counts, sources, no repeats', function() {
  const feed = published();
  const raw = fs.readFileSync(feedPath, 'utf8');
  assert.equal(raw.includes('\r'), false, 'LF only');
  assert.equal(typeof feed.readme, 'string');
  assert.ok(feed.readme.length > 40);
  assert.ok(Array.isArray(feed.events) && feed.events.length > 0);
  const deckKeys = new Set();
  const eventUrls = new Set();
  let total = 0;
  feed.events.forEach(function(ev) {
    assert.equal(typeof ev.name, 'string');
    assert.ok(ev.name.trim(), 'event name');
    assert.match(ev.date, /^\d{4}-\d{2}-\d{2}$/, ev.name + ' date');
    assert.ok(ev.date_kind === 'held' || ev.date_kind === 'published', ev.name + ' date_kind');
    if (ev.date_kind === 'held') assert.match(ev.date_source, /^https:\/\/\S+$/, ev.name + ' says where the held date comes from');
    assert.match(ev.source_url, /^https:\/\/\S+$/, ev.name + ' source_url');
    assert.equal(eventUrls.has(ev.source_url), false, 'duplicate event ' + ev.source_url);
    eventUrls.add(ev.source_url);
    assert.ok(Array.isArray(ev.decks) && ev.decks.length > 0, ev.name + ' has decks');
    ev.decks.forEach(function(d) {
      const label = ev.name + ' / ' + d.placement + ' / ' + d.player;
      assert.equal(typeof d.placement, 'string');
      assert.ok(d.placement.trim(), label + ' placement');
      assert.equal(typeof d.player, 'string');
      assert.ok(Number.isInteger(d.source_id) && d.source_id > 0, label + ' source_id');
      assert.match(d.source_url, /^https:\/\/\S+$/, label + ' source_url');
      if (d.deck_code !== undefined) assert.match(d.deck_code, /^[A-Z0-9]+$/, label + ' deck_code');
      const key = d.source_url;
      assert.equal(deckKeys.has(key), false, 'duplicate deck ' + key);
      deckKeys.add(key);
      assert.ok(Array.isArray(d.cards) && d.cards.length > 0, label + ' has cards');
      d.cards.forEach(function(c) {
        assert.equal(typeof c.number, 'string');
        assert.ok(Number.isInteger(c.count) && c.count > 0, label + ' ' + c.number + ' count');
        assert.equal(typeof c.zone, 'string');
        assert.ok(CARD_IDS.has(c.number), label + ': ' + c.number + ' is not in the SphereDex card table');
      });
      total++;
    });
  });
  const ctx = loadApp();
  const stats = ctx.tdCount(ctx.tdNormalise(feed));
  assert.equal(stats.total, total, 'every transcribed deck is counted');
});

test('the bundled copy agrees with the published file for every event it carries', function() {
  const ctx = loadApp();
  const feed = published();
  const bundled = JSON.parse(JSON.stringify(ctx.TOURNAMENT_DECKS_FALLBACK));
  assert.ok(bundled.events.length > 0);
  bundled.events.forEach(function(ev) {
    const live = feed.events.find(function(e) { return e.source_url === ev.source_url; });
    assert.ok(live, 'bundled event is in the file: ' + ev.name);
    assert.deepEqual(ev, live);
  });
  assert.equal(ctx.TOURNAMENT_DECKS_URL, 'https://spheredex.app/paldex/tournament-decks.json');
  assert.equal(ctx.tdAvailable(), true, 'the bundled copy is in use before any fetch');
});

test('offline load keeps the bundled copy, and a live file replaces and is cached', async function() {
  const offline = loadApp();
  const before = offline._tdStats.total;
  offline.tdLoad();
  await flush();
  assert.equal(offline._tdStats.total, before);

  const live = feedOf([[deck(1, ['EBP01-001']), deck(2, ['EBP01-001'])]]);
  let requested = null;
  const ctx = loadApp({
    fetch: function(url, init) {
      requested = { url: url, init: init };
      return Promise.resolve({ ok: true, json: function() { return Promise.resolve(live); } });
    }
  });
  ctx.tdLoad();
  await flush();
  assert.equal(requested.url, 'https://spheredex.app/paldex/tournament-decks.json');
  assert.equal(requested.init.cache, 'no-store');
  assert.equal(ctx._tdStats.total, 2);
  assert.equal(ctx.tdFigure('EBP01-001').n, 2);
  assert.ok(JSON.parse(ctx.store['palvault-tournament-decks']).feed.events.length === 1);

  const again = loadApp({ store: ctx.store });
  again.tdLoad();
  await flush();
  assert.equal(again._tdStats.total, 2, 'the saved copy wins over the bundled one when offline');
});

test('a bad live payload leaves the bundled copy in place', async function() {
  const ctx = loadApp({
    fetch: function() {
      return Promise.resolve({ ok: true, json: function() { return Promise.resolve({ events: 'nope' }); } });
    }
  });
  const before = ctx._tdStats.total;
  ctx.tdLoad();
  await flush();
  assert.equal(ctx._tdStats.total, before);
  assert.equal(ctx.store['palvault-tournament-decks'], undefined);
});
