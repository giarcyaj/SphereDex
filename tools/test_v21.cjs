'use strict';

// Run with: node tools/test_v21.cjs
// Deck legality, deck stats, effect-text search and purchase-price CSV, extracted from src/paldeck.html.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'paldeck.html'), 'utf8');

function appFunction(name) {
  const match = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, 'App function exists: ' + name);
  for (let end = source.indexOf('}', match.index); end >= 0; end = source.indexOf('}', end + 1)) {
    const declaration = source.slice(match.index, end + 1);
    try { new vm.Script('(' + declaration + ')'); } catch (_) { continue; }
    return declaration;
  }
  throw new Error('Could not extract ' + name);
}
function appConstant(name) {
  const match = new RegExp('\\bvar\\s+' + name + '\\s*=[^;]+;').exec(source);
  assert.ok(match, 'App constant exists: ' + name);
  return match[0];
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  ['textAllowsAnyNumber', 'deckCardOf', 'deckLegalityReport', 'deckStatsReport', 'deckLegalitySummary'].map(appFunction).join('\n') + '\n' +
    appConstant('LUCKY_CAP'),
  sandbox
);

function card(partial) {
  return Object.assign({ id: 'X-1', name: 'Sample', kind: 'Pal', sub: 'Normal Pal', color: 'Red', cost: '2', rules: '' }, partial);
}
const beegardeText = 'CONT You may put any number of cards with the same card name as this card into your deck.';

test('a main deck over 8 Lucky Pals is illegal, and 8 is the cap', () => {
  const byId = {};
  const qty = {};
  for (let i = 0; i < 9; i++) {
    const id = 'L-' + i;
    byId[id] = card({ id, name: 'Lucky ' + i, sub: 'Lucky Pal' });
    qty[id] = 1;
  }
  const over = sandbox.deckLegalityReport(qty, byId);
  assert.equal(over.lucky, 9);
  assert.equal(over.luckyCap, 8);
  assert.ok(over.issues.some(issue => /Lucky Pals are over the limit \(9 \/ 8\)/.test(issue)));
  qty['L-8'] = 0;
  const atCap = sandbox.deckLegalityReport(qty, byId);
  assert.equal(atCap.lucky, 8);
  assert.equal(atCap.issues.some(issue => /Lucky Pal/.test(issue)), false);
});

test('Soul cards are not counted toward the Lucky Pal cap or the main deck', () => {
  const report = sandbox.deckLegalityReport(
    { 'S-1': 10, 'P-1': 1 },
    {
      'S-1': card({ id: 'S-1', name: 'Soul', kind: 'Soul', sub: 'Lucky Pal' }),
      'P-1': card({ id: 'P-1', name: 'Pal', sub: 'Lucky Pal' })
    }
  );
  assert.equal(report.souls, 10);
  assert.equal(report.main, 1);
  assert.equal(report.lucky, 1);
});

test('four copies of one name is the limit, except a card whose text allows any number', () => {
  const normal = sandbox.deckLegalityReport(
    { 'N-1': 5 },
    { 'N-1': card({ id: 'N-1', name: 'Lamball – My First Pal' }) }
  );
  assert.ok(normal.issues.some(issue => /Lamball – My First Pal has 5 copies/.test(issue)));

  const swarm = sandbox.deckLegalityReport(
    { 'EBP01-061': 12, 'EBP01-061SP': 3 },
    {
      'EBP01-061': card({ id: 'EBP01-061', name: 'Beegarde – Knight of the Flower Garden', rules: beegardeText }),
      'EBP01-061SP': card({ id: 'EBP01-061SP', name: 'Beegarde – Knight of the Flower Garden', rules: beegardeText })
    }
  );
  assert.equal(swarm.names['Beegarde – Knight of the Flower Garden'], 15);
  assert.deepEqual(JSON.parse(JSON.stringify(swarm.unlimited)), ['Beegarde – Knight of the Flower Garden']);
  assert.equal(swarm.issues.some(issue => /four cards/.test(issue)), false);
});

test('the any-number exception follows the printed sentence, not a single card id', () => {
  assert.equal(sandbox.textAllowsAnyNumber(beegardeText), true);
  assert.equal(sandbox.textAllowsAnyNumber('Draw 1 card.'), false);
  assert.equal(sandbox.textAllowsAnyNumber(''), false);
  const other = sandbox.deckLegalityReport(
    { 'NEW-001': 6 },
    { 'NEW-001': card({ id: 'NEW-001', name: 'Future Pal', rules: 'You may put any number of cards with the same card name as this card into your deck.' }) }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(other.unlimited)), ['Future Pal']);
  assert.equal(other.issues.some(issue => /four cards/.test(issue)), false);
});

test('the main-deck curve counts cost, type, Lucky Pals and colour, and leaves Souls out', () => {
  const report = sandbox.deckStatsReport(
    { A: 3, B: 2, C: 1, D: 4, S: 10 },
    {
      A: card({ id: 'A', cost: '1', kind: 'Pal', color: 'Red', sub: 'Lucky Pal' }),
      B: card({ id: 'B', cost: '1', kind: 'Event', color: 'Red' }),
      C: card({ id: 'C', cost: '4', kind: 'Gear', color: 'Blue' }),
      D: card({ id: 'D', cost: '3', kind: 'Structure', color: 'Colorless' }),
      S: card({ id: 'S', name: 'Soul', kind: 'Soul', cost: '9', sub: 'Lucky Pal' })
    }
  );
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.equal(report.total, 20);
  assert.equal(report.unique, 5);
  assert.equal(report.main, 10);
  assert.equal(report.lucky, 3);
  assert.deepEqual(plain(report.curve), { '1': 5, '3': 4, '4': 1 });
  assert.deepEqual(plain(report.kinds), { Pal: 3, Event: 2, Gear: 1, Structure: 4 });
  assert.deepEqual(plain(report.colors), { Red: 5, Blue: 1, Colorless: 4 });
});

const textData = JSON.parse(fs.readFileSync(path.join(root, 'src', 'card-text.json'), 'utf8'));
const searchSandbox = {};
vm.createContext(searchSandbox);
vm.runInContext(
  ['fold', 'palKey', 'attachCardText', 'cardSearchText', 'cardMatchesQuery'].map(appFunction).join('\n'),
  searchSandbox
);

test('effect text and keywords match search, and a card with no text does not match a guess', () => {
  const interrupt = { name: 'Lamball', id: 'EBP01-001', rules: 'ACT Interrupt Nullify the opponent attack.', keywords: ['Interrupt', 'Quick'] };
  assert.equal(searchSandbox.cardMatchesQuery(interrupt, 'nullify'), true);
  assert.equal(searchSandbox.cardMatchesQuery(interrupt, 'Interrupt'), true);
  assert.equal(searchSandbox.cardMatchesQuery(interrupt, 'quick'), true);
  const vanilla = { name: 'Pyrin', id: 'EBP01-013', rules: '', keywords: [] };
  assert.equal(searchSandbox.cardMatchesQuery(vanilla, 'draw a card'), false);
  assert.equal(searchSandbox.cardMatchesQuery(vanilla, 'pyrin'), true);
  const beegarde = textData.cards['EBP01-061'];
  assert.equal(searchSandbox.cardMatchesQuery(
    { name: 'Beegarde – Knight of the Flower Garden', id: 'EBP01-061', rules: beegarde.text, keywords: beegarde.keywords },
    'any number of cards'
  ), true);
});

test('stored rules text attaches by base number and leaves an unknown printing blank', () => {
  const cards = [
    { id: 'EBP01-061', base: 'EBP01-061', name: 'Beegarde' },
    { id: 'EBP01-061SP', base: 'EBP01-061', name: 'Beegarde' },
    { id: 'ESOUL-014', base: 'ESOUL-014', name: 'Lamball, Cattiva & Chikipi' }
  ];
  searchSandbox.CARDS = cards;
  searchSandbox.CARD_TEXT = textData;
  assert.equal(searchSandbox.attachCardText(), 2);
  assert.equal(cards[0].rulesKnown, true);
  assert.equal(cards[1].rules, cards[0].rules);
  assert.match(cards[0].rules, /any number of cards with the same card name/i);
  assert.equal(cards[2].rulesKnown, false);
  assert.equal(cards[2].rules, '');
  assert.deepEqual(JSON.parse(JSON.stringify(cards[2].keywords)), []);
});

test('verified card text covers the cached set and does not invent the missing souls', () => {
  assert.equal(textData.cards['EBP01-061'].anyNumber, true);
  assert.ok(textData.glossary.Interrupt && textData.glossary.Interrupt.text);
  const ids = [...source.matchAll(/"(E(?:BP01|TD01|TD02|PR|SOUL)-\d+[A-Z]*)"/g)].map(m => m[1]);
  const printings = [...new Set(ids)];
  const bases = [...new Set(printings.map(id => id.replace(/(?:OSR|SSP|TSR|TSP|SP|SR)$/, '')))];
  let withText = 0, empty = 0, unknown = 0;
  const unknownIds = [];
  bases.forEach(base => {
    const row = textData.cards[base];
    const copies = printings.filter(id => id.replace(/(?:OSR|SSP|TSR|TSP|SP|SR)$/, '') === base).length;
    if (!row) { unknown += copies; unknownIds.push(base); return; }
    if (row.text) withText += copies; else empty += copies;
  });
  assert.equal(printings.length, 277);
  assert.equal(withText, 248);
  assert.equal(empty, 26);
  assert.equal(unknown, 3);
  assert.equal(withText + empty + unknown, printings.length);
  assert.deepEqual(unknownIds.sort(), ['ESOUL-014', 'ESOUL-015', 'ESOUL-016']);
  assert.equal(Object.keys(textData.cards).length, bases.length - unknownIds.length);
});

test('colourless cards do not spend one of the two colour slots', () => {
  const report = sandbox.deckLegalityReport(
    { A: 1, B: 1, C: 1 },
    {
      A: card({ id: 'A', color: 'Red' }),
      B: card({ id: 'B', color: 'Blue' }),
      C: card({ id: 'C', name: 'Gear', kind: 'Gear', color: 'Colorless' })
    }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(report.colors)).sort(), ['Blue', 'Red']);
  assert.equal(report.issues.some(issue => /two colours/.test(issue)), false);
});

function paidApp() {
  const lamball = { id: 'EBP01-001', name: 'Lamball', set: 'EBP01', rare: 'C', base: 'EBP01-001' };
  const box = { id: 'BOX1', name: 'Booster Box', set: 'Dawn of Palpagos', pre: false };
  const col = { id: 'test', name: 'Test collection', own: {}, sealed: {} };
  const sandbox = {
    STATE: { cols: [col], active: col.id }, own: col.own, CARDS: [lamball], SEALED: [box],
    byNumberIdx: { [lamball.id]: lamball },
    SETS: { EBP01: { name: 'Dawn of Palpagos' } }, RARE_NAME: { C: 'Common' },
    SETTINGS: { defaultGrader: 'PSA' }, CUR: { code: 'GBP', dec: 2 },
    activeCol: () => col, priceMode: () => 'sold', unitOf: () => 4, unitOfEntry: () => 4,
    sealUnit: () => 20
  };
  const names = [
    'rawCount', 'rawEditionKey', 'rawEditionLabel', 'rawCounts', 'rawKnownTotal', 'setRawCounts', 'changeRaw',
    'csvNum', 'paidNumber', 'csvPaid', 'csvCell', 'csvEdition', 'collectionCsv',
    'parseCsvRows', 'csvUnguard', 'parseCsvCollection', 'collectionCostBasis'
  ];
  const code = names.map(appFunction).join('\n') + '\n' + ['RAW_KNOWN', 'CSV_HEADER', 'CSV_NUMCOL', 'CARD_CONDS'].map(appConstant).join('\n');
  vm.runInContext(code, vm.createContext(sandbox));
  sandbox.col = col;
  sandbox.box = box;
  sandbox.lamball = lamball;
  return sandbox;
}

test('a paid amount round-trips through CSV, including an explicit zero, and old files stay unset', () => {
  const a = paidApp();
  assert.equal(a.paidNumber(''), null);
  assert.equal(a.paidNumber('  '), null);
  assert.equal(a.paidNumber('0'), 0);
  assert.equal(a.paidNumber('0.00'), 0);
  assert.equal(a.paidNumber('1,25'), 1.25);
  assert.equal(a.csvPaid(0), '0.00');
  assert.equal(a.csvPaid(null), '');
  const entry = {
    qty: 3,
    rawEditions: { '1': 2, unknown: 1 },
    cond: 'Near Mint',
    notes: 'Kept',
    paidRaw: { '1': 1.5, unknown: 0 },
    graded: [{ grader: 'PSA', grade: '10', value: 40, paid: 25, edition: '1' }]
  };
  a.col.own[a.lamball.id] = entry;
  a.col.sealed[a.box.id] = { qty: 1, rrp: 0, mkt: 0, last: 0, avg: 0, paid: 0 };
  const before = JSON.stringify(a.col);
  const csv = a.collectionCsv(a.col);
  assert.equal(JSON.stringify(a.col), before);
  assert.match(csv.split(/\r\n/)[0], /Paid$/);
  assert.match(csv, /,1\.50/);
  assert.match(csv, /,0\.00/);
  assert.match(csv, /,25\.00/);
  const imported = a.parseCsvCollection(csv);
  assert.equal(imported.own[a.lamball.id].paidRaw['1'], 1.5);
  assert.equal(imported.own[a.lamball.id].paidRaw.unknown, 0);
  assert.equal(imported.own[a.lamball.id].graded[0].paid, 25);
  assert.equal(imported.own[a.lamball.id].notes, 'Kept');
  assert.equal(imported.sealed[a.box.id].paid, 0);
  assert.equal(imported.sealed[a.box.id].qty, 1);
  const legacy = 'Number,Quantity,Name,Type\nEBP01-001,2,Lamball,Card\n';
  const old = a.parseCsvCollection(legacy);
  assert.equal(old.own[a.lamball.id].paidRaw, undefined);
  assert.equal(old.cards, 2);
});

test('deck tools and paid amounts follow Play and Track value unless Settings overrides them', () => {
  const box = { SETTINGS: { onboardIntents: [] } };
  vm.createContext(box);
  vm.runInContext(appFunction('playerToolsOn') + '\n' + appFunction('trackPaidOn'), box);
  assert.equal(box.playerToolsOn(), false);
  assert.equal(box.trackPaidOn(), false);
  box.SETTINGS.onboardIntents = ['player'];
  assert.equal(box.playerToolsOn(), true);
  assert.equal(box.trackPaidOn(), false);
  box.SETTINGS.onboardIntents = ['collector', 'market'];
  assert.equal(box.playerToolsOn(), false);
  assert.equal(box.trackPaidOn(), true);
  box.SETTINGS.playerTools = false;
  box.SETTINGS.trackPaid = false;
  box.SETTINGS.onboardIntents = ['player', 'market'];
  assert.equal(box.playerToolsOn(), false);
  assert.equal(box.trackPaidOn(), false);
  box.SETTINGS.playerTools = true;
  box.SETTINGS.trackPaid = true;
  box.SETTINGS.onboardIntents = [];
  assert.equal(box.playerToolsOn(), true);
  assert.equal(box.trackPaidOn(), true);
  const decks = source.indexOf('>Decks</div>');
  const prices = source.indexOf('Prices &amp; markets');
  const display = source.indexOf('Display &amp; theme');
  assert.ok(decks > 0 && decks < prices, 'Deck tools have their own section, above Prices & markets');
  assert.ok(source.indexOf('id="setPlayerTools"') > decks && source.indexOf('id="setPlayerTools"') < prices);
  assert.ok(source.indexOf('id="setTrackPaid"') > prices && source.indexOf('id="setTrackPaid"') < display);
});

test('a chosen Pal lists every printing, including ones already collected', () => {
  const fn = appFunction('selectedPalMissingGoal');
  assert.match(fn, /cards\.map/);
  assert.doesNotMatch(fn, /missingItems\(cards\)/);
});

test('a Pal tile with nothing to show says no cards yet', () => {
  assert.match(source, /no cards yet/);
  assert.equal(source.includes('No art yet'), false);
  assert.equal(source.includes('no art'), false);
});

test('cost basis ignores copies with no paid amount and keeps an explicit zero', () => {
  const a = paidApp();
  a.own[a.lamball.id] = {
    qty: 3,
    rawEditions: { '1': 2, unknown: 1 },
    paidRaw: { '1': 1.5 },
    graded: [{ grader: 'PSA', grade: '10', value: 40, paid: 0 }]
  };
  a.col.sealed[a.box.id] = { qty: 2, paid: 12 };
  const basis = a.collectionCostBasis();
  assert.equal(basis.copies, 2 + 1 + 2);
  assert.equal(basis.cost, 2 * 1.5 + 0 + 2 * 12);
  assert.equal(basis.value, 2 * 4 + 40 + 2 * 20);
  assert.equal(basis.gain, basis.value - basis.cost);
  const none = paidApp();
  none.own[none.lamball.id] = { qty: 4, edition: '1', graded: [{ grader: 'PSA', grade: '9', value: 10 }] };
  assert.equal(none.collectionCostBasis().copies, 0);
  assert.equal(none.collectionCostBasis().cost, 0);
});

// The Home catch-up card. awayRows() reads a lot of app state, so the sandbox stubs the DATA and keeps
// the REAL date helpers, which is exactly where this went wrong once: upcomingIso returns a timestamp,
// not a string, and feeding it back through Date.parse silently dropped every reveal.
function awaySandbox(over) {
  const box = {};
  vm.createContext(box);
  vm.runInContext(['awayRows', 'sealDayKnown', 'monDateTime', 'upcomingIso', 'verNum', 'palKey']
    .map(appFunction).join('\n'), box);
  const opened = 1_700_000_000_000;
  Object.assign(box, {
    APP_OPENED_AT: opened,
    PREVIOUS_VISIT: opened - 8 * 24 * 60 * 60 * 1000,
    SEALED: [],
    RELNEWS_KEY: 'palvault-release-news',
    lsGet: () => '[]',
    _upcomingEntries: [],
    CARDS: [],
    SETTINGS: { mode: 'trader' },
    PRICEBOOK: {},
    PRICEPREV: {},
    isWished: () => false,
    has: () => false,
    o: (id) => ({ id: id }),
    isConverted: () => false,
    sealDate: (p) => p.date,
    esc: (v) => String(v),
    money: (n) => '\u00a3' + Number(n).toFixed(2),
    APP_VERSION: '2.1',
    _latestAppVersion: '2.1',
  }, over || {});
  return box;
}

test('the away card reports what happened in the world, not what you did yourself', () => {
  const opened = 1_700_000_000_000, DAY = 24 * 60 * 60 * 1000;
  const at = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');

  // A first open on this device has nothing to be away from.
  assert.equal(awaySandbox({ PREVIOUS_VISIT: 0 }).awayRows().length, 0);

  // A quiet week says nothing rather than padding the card.
  assert.equal(awaySandbox().awayRows().length, 0);

  // Reveals inside the window, and ONLY inside it.
  const reveals = awaySandbox({
    _upcomingEntries: [
      { pal: 'Selyne', revealed_at: at(opened - 2 * DAY) },
      { pal: 'Cattiva', revealed_at: at(opened - 3 * DAY) },
      { pal: 'Depresso', revealed_at: at(opened - 4 * DAY) },
      { pal: 'Grizzbolt', revealed_at: at(opened - 30 * DAY) },
    ],
  }).awayRows();
  assert.equal(reveals.length, 1, 'a reveal from before the last visit is not news');
  assert.equal(reveals[0].line, 'New reveals \u00b7 Selyne, Cattiva and Depresso');
  assert.equal(reveals[0].go, 'paldex');

  // Four or more becomes a count, and the line never carries two "and"s.
  const many = awaySandbox({
    _upcomingEntries: ['Selyne', 'Cattiva', 'Depresso', 'Quivern', 'Chillet']
      .map((p, i) => ({ pal: p, revealed_at: at(opened - (i + 1) * DAY) })),
  }).awayRows();
  assert.equal(many[0].line, 'New reveals \u00b7 Selyne, Cattiva, Depresso and 2 more');
  assert.equal((many[0].line.match(/ and /g) || []).length, 1, 'one "and", never two');

  // The same Pal revealed twice is named once.
  const dupe = awaySandbox({
    _upcomingEntries: [
      { pal: 'Tombat', revealed_at: at(opened - 2 * DAY) },
      { pal: 'Tombat', revealed_at: at(opened - 3 * DAY) },
    ],
  }).awayRows();
  assert.equal(dupe[0].line, 'New reveals \u00b7 Tombat');

  // The biggest wishlist faller, named through palKey so the en dash subtitle never reaches the card.
  const wish = {
    CARDS: [{ id: 'EBP01-001', name: 'Jetragon \u2013 Legendary Guardian Dragon' }],
    isWished: () => true,
    PRICEBOOK: { 'EBP01-001': 14.2 },
    PRICEPREV: { 'EBP01-001': 20 },
  };
  const fell = awaySandbox(wish).awayRows();
  assert.equal(fell.length, 1);
  assert.equal(fell[0].line, 'Jetragon fell to \u00a314.20 on your wishlist');
  assert.equal(fell[0].go, 'wishlist');

  // Collector mode hides every price in the app, this card included.
  assert.equal(
    awaySandbox(Object.assign({}, wish, { SETTINGS: { mode: 'collector' } })).awayRows().length, 0,
    'collector mode shows no money');

  // A converted estimate moving is an exchange rate, not a price fall.
  assert.equal(
    awaySandbox(Object.assign({}, wish, { isConverted: () => true })).awayRows().length, 0);

  // A newer store build is one line, with no feature bullets.
  const behind = awaySandbox({ _latestAppVersion: '2.2' }).awayRows();
  assert.equal(behind.length, 1);
  assert.equal(behind[0].line, 'SphereDex 2.2 is available');
  assert.equal(behind[0].go, '');
  assert.equal(awaySandbox({ _latestAppVersion: '2.0' }).awayRows().length, 0,
    'an older store record is not an update');

  // A product is only called released when its date names a real day: monDateTime falls back to the
  // 28th for a bare month and year, so "late Oct 2026" would announce a date nobody published.
  const box = awaySandbox();
  assert.equal(box.sealDayKnown('2026-10-16'), true);
  assert.equal(box.sealDayKnown('Oct 16, 2026'), true);
  assert.equal(box.sealDayKnown('late Oct 2026'), false);
  assert.equal(box.sealDayKnown(''), false);

  // The card is a world digest now, and the copy rule holds.
  assert.match(source, /While you were away/);
  assert.equal(source.includes('missedUpdate'), false, 'the old recap is gone, not merely unused');
});

test('home bars only measure a goal that has a total', () => {
  const box = {};
  vm.createContext(box);
  vm.runInContext(appFunction('homeTrack'), box);
  assert.equal(box.homeTrack(0, false), '');
  assert.equal(box.homeTrack(40, false), '');
  assert.match(box.homeTrack(0, true), /class="hctrack"/);
  assert.match(box.homeTrack(0, true), /width:0%/);
  assert.match(box.homeTrack(140, true), /width:100%/);
  assert.match(box.homeTrack(-5, true), /width:0%/);
  assert.match(source, /homeTrack\(pct, total>0\)/);
  assert.match(source, /homeTrack\(sphere\.percent, sphere\.total>0\)/);
  assert.match(source, /homeTrack\(closest\.percent, closest\.total>0\)/);
  assert.match(source, /homeTrack\(deck\.percent, deck\.total>0\)/);
  assert.match(source, /homeTrack\(0, false\)/);
  assert.match(source, /homeTrack\(wishPct, wishCount\(\)>0\)/);
  const market = source.slice(source.indexOf('$("homeMarket").innerHTML'), source.indexOf('$("homeCollection").onclick'));
  assert.equal(market.includes('hctrack'), false);
  assert.equal(market.includes('pricedPct'), false);
});

function binom(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return r;
}
function atLeastOne(deck, copies, drawn) {
  const N = Math.floor(+deck), K = Math.min(Math.floor(+copies), N), n = Math.min(Math.floor(+drawn), N);
  if (!(N > 0) || !(K > 0) || !(n > 0)) return 0;
  if (n > N - K) return 1;
  return 1 - binom(N - K, n) / binom(N, n);
}

test('opening-hand and Damage Check odds are hypergeometric', () => {
  const box = {};
  vm.createContext(box);
  vm.runInContext(['hyperAtLeastOne', 'openingHandOdds', 'damageCheckOdds'].map(appFunction).join('\n'), box);
  [ [50, 4, 5], [50, 4, 6], [50, 4, 8], [50, 8, 1], [50, 8, 4], [10, 8, 3], [50, 0, 5], [0, 4, 5], [50, 1, 80], [5, 1, 5] ].forEach((args) => {
    const got = box.hyperAtLeastOne(args[0], args[1], args[2]);
    const want = atLeastOne(args[0], args[1], args[2]);
    assert.ok(Math.abs(got - want) < 1e-12, args.join(',') + ' got ' + got + ' want ' + want);
  });
  const hand = box.openingHandOdds(50, 4);
  assert.equal(hand.handSize, 5);
  assert.equal(hand.opening, box.hyperAtLeastOne(50, 4, 5));
  assert.equal(hand.after1, box.hyperAtLeastOne(50, 4, 6));
  assert.equal(hand.after3, box.hyperAtLeastOne(50, 4, 8));
  assert.ok(hand.opening < hand.after1 && hand.after1 < hand.after3);
  const dmg = box.damageCheckOdds(50, 8);
  assert.equal(dmg[1], box.hyperAtLeastOne(50, 8, 1));
  assert.equal(dmg[4], box.hyperAtLeastOne(50, 8, 4));
  assert.ok(dmg[1] < dmg[2] && dmg[2] < dmg[3] && dmg[3] < dmg[4]);
  assert.equal(box.damageCheckOdds(50, 0)[4], 0);
  assert.equal(box.hyperAtLeastOne(12, 12, 1), 1);
});

test('TCGplayer Mass Entry uses quantity, name, and a set code only when one is known', () => {
  const box = {};
  vm.createContext(box);
  vm.runInContext(['tcgplayerPlainName', 'tcgplayerSetNumber', 'tcgplayerMassEntry'].map(appFunction).join('\n'), box);
  assert.deepEqual(JSON.parse(JSON.stringify(box.tcgplayerSetNumber('EBP01', 'EBP01-023'))), { set: 'BP01', number: '23' });
  assert.deepEqual(JSON.parse(JSON.stringify(box.tcgplayerSetNumber('EBP01', 'EBP01-001OSR'))), { set: 'BP01', number: '1' });
  assert.deepEqual(JSON.parse(JSON.stringify(box.tcgplayerSetNumber('BP01', 'BP01-084'))), { set: 'BP01', number: '84' });
  assert.deepEqual(JSON.parse(JSON.stringify(box.tcgplayerSetNumber('ETD01', 'ETD01-005'))), { set: '', number: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(box.tcgplayerSetNumber('ETD01', 'ESOUL-001'))), { set: '', number: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(box.tcgplayerSetNumber('PR2026', 'PR-014'))), { set: '', number: '' });
  const text = box.tcgplayerMassEntry([
    { qty: 1, name: 'Lamball – My First Pal', set: 'BP01', number: '023' },
    { qty: 2, name: 'Lamball - My First Pal', set: 'bp01', number: '23' },
    { qty: 1, name: 'Grizzbolt – Rumbling Tank', set: '', number: '' },
    { qty: 0, name: 'Dropped', set: 'BP01', number: '1' },
    { qty: 4, name: '  Soul  ', set: '', number: '' }
  ]);
  assert.equal(text, [
    '3 Lamball - My First Pal [BP01] 23',
    '1 Grizzbolt - Rumbling Tank',
    '4 Soul'
  ].join('\n'));
  assert.equal(text.includes('\n\n'), false);
  assert.equal(box.tcgplayerMassEntry([]), '');
  assert.match(box.tcgplayerMassEntry([{ qty: 1, name: 'Lightning Bolt', set: 'SLD', number: '84' }]), /^1 Lightning Bolt \[SLD\] 84$/);
});

test('JSON import clamps bad quantities and never records a negative value', () => {
  const box = { recordDayPrices() {} };
  vm.createContext(box);
  vm.runInContext(['plainObj', 'rawCount', 'cardMap', 'sealedMap', 'cardValue', 'clampMoney', 'snapshot'].map(appFunction).join('\n'), box);
  const src = { 'EBP01-002': { qty: -4, mkt: 2.84, addAt: 5 } };
  const mapped = JSON.parse(JSON.stringify(box.cardMap(src)));
  assert.equal(src['EBP01-002'].qty, -4);
  assert.deepEqual(mapped, { 'EBP01-002': { qty: 0, mkt: 2.84, addAt: 5 } });

  const mixed = JSON.parse(JSON.stringify(box.cardMap({
    'EBP01-001': { qty: 'lots' },
    'EBP01-002': { qty: -4 },
    'EBP01-003': null,
    'EBP01-004': { qty: 2.9 },
    'EBP01-005': { qty: 0 },
    'EBP01-006': { qty: 2, rawEditions: { '1': -3, '2': 1.8 } }
  })));
  assert.equal(mixed['EBP01-001'].qty, 0);
  assert.equal(mixed['EBP01-002'].qty, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(mixed, 'EBP01-003'), false);
  assert.equal(mixed['EBP01-004'].qty, 2);
  assert.equal(mixed['EBP01-005'].qty, 0);
  assert.deepEqual(mixed['EBP01-006'], { qty: 2, rawEditions: { '1': 0, '2': 1 } });
  assert.equal(box.cardMap([1, 2, 3]), null);
  assert.deepEqual(JSON.parse(JSON.stringify(box.cardMap({ 'EBP01-001': { qty: 2 } }))), { 'EBP01-001': { qty: 2 } });

  const sealed = JSON.parse(JSON.stringify(box.sealedMap({ box: { qty: -2, mkt: 9 }, bad: null })));
  assert.deepEqual(sealed, { box: { qty: 0, mkt: 9 } });
  assert.deepEqual(JSON.parse(JSON.stringify(box.sealedMap(null))), {});
  assert.match(appFunction('doImport'), /sealed:sealedMap\(d&&d\.sealed\)/);

  assert.equal(box.cardValue({ qty: -4, mkt: 2.84 }), 0);
  assert.equal(box.cardValue({ qty: 'lots', mkt: 5 }), 0);
  assert.equal(box.cardValue({ qty: 2.9, mkt: 1 }), 2);
  assert.equal(box.cardValue({ qty: 0, mkt: 5 }), 0);
  assert.equal(box.cardValue({ qty: 4, mkt: 2.84 }), 11.36);

  const col = { hist: {} };
  box.activeCol = () => col;
  box.todayKey = () => '2026-09-28';
  box.cardsValue = () => -11.36;
  box.sealedValue = () => 0;
  box.cardsValueMode = () => -11.36;
  box.sealedValueMode = () => -1;
  box.collCounts = () => ({ cards: -4, graded: 0, sealed: -2 });
  box.snapshot();
  assert.equal(col.hist['2026-09-28'], undefined);

  box.cardsValue = () => 10.5;
  box.sealedValue = () => 0;
  box.cardsValueMode = (mode) => (mode === 'sold' ? 0 : 10.5);
  box.sealedValueMode = () => 0;
  box.collCounts = () => ({ cards: 2, graded: 0, sealed: 0 });
  box.snapshot();
  const point = col.hist['2026-09-28'];
  assert.equal(point.v, 10.5);
  assert.equal(point.vLive, 10.5);
  assert.equal(point.cards, 2);
  assert.ok(point.v >= 0 && point.cards >= 0 && point.sealed >= 0);
});

test('PalDex status and variant filters combine', () => {
  const box = {};
  vm.createContext(box);
  vm.runInContext(appFunction('paldexGroupVisible'), box);
  const variants = [
    { id: 'normal', rares: ['C', 'U', 'R', 'RR'] },
    { id: 'rare', rares: ['SR'] },
    { id: 'promo', rares: ['PR'] }
  ];
  function group(name, owned, rares) {
    return { name, owned, total: rares.length, cards: rares.map((rare) => ({ rare })) };
  }
  const groups = [
    group('Lamball', 0, ['C', 'SR']),
    group('Fuack', 0, ['C', 'U']),
    group('Cattiva', 1, ['SR', 'C', 'C']),
    group('Promo Pal', 0, ['PR'])
  ];
  function names(status, variant) {
    return groups.filter((g) => box.paldexGroupVisible(g, '', status, variant, variants)).map((g) => g.name);
  }
  assert.deepEqual(names('missing', 'rare'), ['Lamball']);
  assert.deepEqual(names('all', 'rare'), ['Lamball', 'Cattiva']);
  assert.deepEqual(names('started', 'rare'), ['Cattiva']);
  assert.deepEqual(names('missing', 'normal'), ['Lamball', 'Fuack']);
  assert.deepEqual(names('missing', 'promo'), ['Promo Pal']);
  assert.deepEqual(names('complete', 'rare'), []);
  assert.equal(appFunction('paldexFiltered').includes('return paldexGroupVisible('), true);
});

test('the legality summary uses the deck counts, not only the 50 and 10 requirements', () => {
  const report = sandbox.deckLegalityReport(
    { 'S-1': 3, 'P-1': 50 },
    {
      'S-1': card({ id: 'S-1', name: 'Soul', kind: 'Soul', color: '' }),
      'P-1': card({ id: 'P-1', name: 'Pal', color: 'Red' })
    }
  );
  assert.equal(report.main, 50);
  assert.equal(report.souls, 3);
  assert.equal(sandbox.deckLegalitySummary(report), '50 / 50 main · 3 / 10 Souls · Lucky Pals 0/8 · Red');
  assert.equal(source.includes('50-card main deck · 10 Soul cards'), false);
});

test('an upcoming PalDex tile names its set once', () => {
  const fn = appFunction('renderPaldex');
  assert.match(fn, /soon \|\| "no printings yet/);
  assert.match(fn, /soon \? "" : "not printed yet"/);
  assert.equal(fn.includes('soon || "not printed yet"'), false);
});

test('2.1 is this build, and a store record of 2.0 is not an update', () => {
  assert.match(source, /var APP_VERSION = "2\.1";/);
  const highlights = source.match(/var RELEASE_HIGHLIGHTS = \{[\s\S]*?\n  \};/);
  assert.ok(highlights, 'RELEASE_HIGHLIGHTS is in the source');
  const box = {};
  vm.createContext(box);
  vm.runInContext(highlights[0] + '\n' + ['verNum', 'missedVisitPhrase'].map(appFunction).join('\n'), box);
  assert.equal(box.RELEASE_HIGHLIGHTS['2.1'].length, 3);
  assert.match(box.RELEASE_HIGHLIGHTS['2.1'][1], /Match tracker/);
  assert.ok(box.verNum('2.1') > box.verNum('2.0'));
  assert.equal(box.verNum('2.0') > box.verNum('2.1'), false);
  assert.match(source, /if\(latest && verNum\(latest\) > verNum\(APP_VERSION\)\) offerUpdate\(latest\);/);
  const ver = box.verNum('2.1');
  const latest = box.verNum('2.0');
  const behind = latest > ver;
  const notes = behind ? ['Old store note'] : box.RELEASE_HIGHLIGHTS['2.1'];
  assert.equal(behind, false);
  assert.deepEqual(JSON.parse(JSON.stringify(notes)), JSON.parse(JSON.stringify(box.RELEASE_HIGHLIGHTS['2.1'])));
  const gradle = fs.readFileSync(path.join(__dirname, '../app/build.gradle.kts'), 'utf8');
  assert.match(gradle, /versionName = "2\.1"/);
  assert.match(gradle, /versionCode = System\.getenv\("VERSION_CODE"\)\?\.toIntOrNull\(\) \?: 13/);
  const spec = fs.readFileSync(path.join(__dirname, '../ios/SphereDex/project.yml'), 'utf8');
  assert.match(spec, /MARKETING_VERSION: "2\.1"/);
  assert.match(spec, /CURRENT_PROJECT_VERSION: "17"/);
  const project = fs.readFileSync(path.join(__dirname, '../ios/SphereDex/SphereDex.xcodeproj/project.pbxproj'), 'utf8');
  assert.equal((project.match(/MARKETING_VERSION = 2\.1;/g) || []).length, 2);
  assert.equal((project.match(/CURRENT_PROJECT_VERSION = 17;/g) || []).length, 2);
});

test('sign-in column forms do not use the 180px flex basis as height', () => {
  assert.match(source, /\.acctform input, \.acctform \.pwwrap \{ flex:1 1 180px; min-width:0; max-width:100%; \}/);
  assert.match(source, /\.acctform\.stack input, \.acctform\.stack \.pwwrap \{ flex:0 0 auto; width:100%; \}/);
  assert.equal((source.match(/class="acctform stack"/g) || []).length, 3);
  assert.equal(source.includes('acctform" style="flex-direction:column'), false);
});

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(escaped + '\\s*\\{[^}]*\\}').exec(source);
  assert.ok(match, 'CSS rule exists: ' + selector);
  return match[0];
}

const chromeBin = '/usr/local/bin/google-chrome';
const puppeteerPkg = '/tmp/pw/package.json';
const canMeasureSignIn = fs.existsSync(chromeBin) && fs.existsSync(puppeteerPkg);

test('sign-in inputs stay a single line at 1280, 390 and 320px', { skip: !canMeasureSignIn }, async () => {
  const { createRequire } = require('node:module');
  const puppeteer = createRequire(puppeteerPkg)('puppeteer-core');
  const css = [
    '* { box-sizing: border-box; }',
    'body { margin: 0; }',
    cssBlock('.acctcard'),
    cssBlock('.sortsel'),
    cssBlock('input.sortsel'),
    cssBlock('.acctform'),
    cssBlock('.acctform input, .acctform .pwwrap'),
    cssBlock('.acctform.stack'),
    cssBlock('.acctform.stack input, .acctform.stack .pwwrap'),
    cssBlock('.pwwrap'),
    cssBlock('.pwwrap input'),
    cssBlock('.pweye'),
    cssBlock('.acctform.stack > * + *')
  ].join('\n');
  const html = '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div class="acctcard"><div class="acctform stack">' +
    '<input class="sortsel" id="acctEmail" type="email" placeholder="you@email.com">' +
    '<div class="pwwrap"><input class="sortsel" id="acctPw" type="password" placeholder="Password (8+ characters)"><button type="button" class="pweye">show</button></div>' +
    '</div></div>';
  const browser = await puppeteer.launch({ executablePath: chromeBin, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    for (const width of [1280, 390, 320]) {
      await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'load' });
      const measured = await page.evaluate(() => {
        const rect = (el) => el.getBoundingClientRect();
        const email = document.getElementById('acctEmail');
        const wrap = document.querySelector('.pwwrap');
        const pw = document.getElementById('acctPw');
        return {
          email: rect(email).height,
          wrap: rect(wrap).height,
          pw: rect(pw).height,
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth
        };
      });
      assert.ok(measured.email >= 36 && measured.email <= 64, width + ' email height ' + measured.email);
      assert.ok(measured.wrap >= 36 && measured.wrap <= 64, width + ' password row height ' + measured.wrap);
      assert.ok(measured.pw >= 36 && measured.pw <= 64, width + ' password height ' + measured.pw);
      if (width === 320) assert.ok(measured.scroll <= measured.client + 1, 'overflow ' + measured.scroll + ' > ' + measured.client);
    }
  } finally {
    await browser.close();
  }
});

test('Match and Portfolio stay on the phone screen', { skip: !canMeasureSignIn }, async () => {
  const { createRequire } = require('node:module');
  const http = require('node:http');
  const puppeteer = createRequire(puppeteerPkg)('puppeteer-core');
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(source);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: chromeBin, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('palvault-settings', JSON.stringify({
        theme: 'dark', onboarded: true, playerTools: true, mode: 'trader', ebayRegion: 'com', trackPaid: true
      }));
      localStorage.setItem('palvault-v1', JSON.stringify({
        cols: [{
          id: 'c1', name: 'My Collection', own: {},
          hist: {
            '2026-09-27': { v: 10, vLive: 10, cards: 1, graded: 0, sealed: 0 },
            '2026-09-28': { v: 12.5, vLive: 12.5, cards: 2, graded: 0, sealed: 0 }
          }
        }],
        active: 'c1', wishlist: {}, decks: []
      }));
    });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().startsWith('http://127.0.0.1:' + port + '/')) req.continue();
      else req.abort();
    });
    await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => {
      const onboard = document.querySelector('#onboard');
      return onboard && onboard.hidden && document.querySelector('#matchBoard');
    });
    async function openPage(name) {
      await page.evaluate((pageName) => {
        document.querySelector('.tab[data-page="' + pageName + '"]').click();
      }, name);
      await page.waitForFunction((pageName) => {
        const active = document.querySelector('section.page.active');
        return active && active.id === 'page-' + pageName;
      }, {}, name);
    }
    async function layout() {
      return page.evaluate(() => {
        const buttons = Array.prototype.map.call(document.querySelectorAll('#matchBoard button'), (el) => {
          const r = el.getBoundingClientRect();
          return { w: r.width, h: r.height, label: el.getAttribute('aria-label') || el.textContent.trim() };
        });
        const nav = document.querySelector('.navmenu .navbar');
        const home = document.querySelector('#navPrimarySlots [data-page="home"]');
        const nr = nav.getBoundingClientRect();
        const hr = home.getBoundingClientRect();
        const hit = document.elementFromPoint(hr.left + hr.width / 2, hr.top + hr.height / 2);
        return {
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
          buttons,
          nav: { left: nr.left, right: nr.right, top: nr.top, bottom: nr.bottom },
          homeHit: !!(hit && home.contains(hit))
        };
      });
    }
    for (const width of [320, 360, 375, 390]) {
      await page.setViewport({ width, height: width === 320 ? 640 : 800, deviceScaleFactor: 1 });
      await openPage('match');
      let measured = await layout();
      assert.ok(measured.scroll <= measured.client + 1, width + ' match overflow ' + measured.scroll + ' > ' + measured.client);
      assert.ok(measured.nav.left >= -1 && measured.nav.right <= measured.client + 1, width + ' nav ' + JSON.stringify(measured.nav));
      assert.ok(measured.nav.bottom <= measured.height + 1, width + ' nav below the screen');
      assert.equal(measured.homeHit, true, width + ' Home is not tappable');
      assert.ok(measured.buttons.length >= 8, width + ' missing match controls');
      measured.buttons.forEach((button) => {
        assert.ok(button.w + 0.5 >= 40 && button.h + 0.5 >= 40, width + ' ' + button.label + ' is ' + button.w + 'x' + button.h);
      });
      if (width === 320) {
        const round = await page.evaluate(() => {
          const step = document.querySelector('#matchBoard .matchrow .matchstep');
          const label = step.querySelector('span');
          const range = document.createRange();
          range.selectNodeContents(label);
          const text = range.getBoundingClientRect();
          const box = label.getBoundingClientRect();
          const plus = step.querySelector('button[data-d="1"]');
          const midX = text.left + text.width / 2;
          const midY = text.top + text.height / 2;
          const hit = document.elementFromPoint(midX, midY);
          return {
            word: label.textContent,
            textW: text.width,
            boxW: box.width,
            covered: !!(hit && plus.contains(hit)),
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth
          };
        });
        assert.equal(round.word, 'Round');
        assert.ok(round.boxW + 1 >= round.textW, 'ROUND is clipped ' + round.boxW + ' < ' + round.textW);
        assert.ok(round.textW >= 40, 'ROUND text is only ' + round.textW);
        assert.equal(round.covered, false, 'the round + button covers ROUND');
        assert.ok(round.scroll <= round.client + 1, '320 round row overflow ' + round.scroll);
      }
      await page.evaluate(() => document.querySelector('#navPrimarySlots [data-page="home"]').click());
      await page.waitForFunction(() => document.querySelector('section.page.active').id === 'page-home');
      await openPage('match');
      await page.evaluate(() => document.querySelector('#matchBoard [data-act="reset"]').click());
      await page.waitForSelector('#askScrim:not([hidden])');
      const confirm = await page.evaluate(() => {
        const ok = document.getElementById('askOk');
        const r = ok.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          w: r.width, h: r.height, text: ok.textContent,
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
          hit: !!(hit && (hit === ok || ok.contains(hit)))
        };
      });
      assert.equal(confirm.text, 'Reset');
      assert.ok(confirm.w + 0.5 >= 40 && confirm.h + 0.5 >= 40, width + ' reset confirm ' + confirm.w + 'x' + confirm.h);
      assert.equal(confirm.hit, true, width + ' reset confirm is not tappable');
      assert.ok(confirm.scroll <= confirm.client + 1, width + ' confirm overflow');
      await page.evaluate(() => document.getElementById('askCancel').click());
    }
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await openPage('match');
    const wideButtons = await page.evaluate(() => {
      return Array.prototype.map.call(document.querySelectorAll('#matchBoard .matchmid .tbtn'), (el) => {
        const r = el.getBoundingClientRect();
        return { h: r.height, label: el.textContent.trim() };
      });
    });
    assert.ok(wideButtons.length >= 3, 'missing match text buttons at 1280');
    wideButtons.forEach((button) => {
      assert.ok(button.h + 0.5 >= 40, '1280 ' + button.label + ' is ' + button.h + 'px tall');
    });
    for (const width of [320, 360]) {
      await page.setViewport({ width, height: 640, deviceScaleFactor: 1 });
      await openPage('portfolio');
      const measured = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
        rows: document.querySelectorAll('#pdHost .pdrow').length
      }));
      assert.ok(measured.rows >= 1, width + ' portfolio has no history rows');
      assert.ok(measured.scroll <= measured.client + 1, width + ' portfolio overflow ' + measured.scroll + ' > ' + measured.client);
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
