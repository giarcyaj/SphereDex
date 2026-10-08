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
    'csvNum', 'paidNumber', 'csvPaid', 'csvCell', 'csvEdition', 'csvText', 'collectionCsv',
    'parseCsvRows', 'csvUnguard', 'parseCsvCollection', 'collectionCostBasis',
    'importOwn', 'importHeaderKey', 'importRoles', 'importSplitNumber', 'importParallel', 'importLang', 'importQty', 'importCardId'
  ];
  const code = names.map(appFunction).join('\n') + '\n' + ['RAW_KNOWN', 'CSV_HEADER', 'CSV_NUMCOL', 'CARD_CONDS',
    'IMPORT_PARALLELS', 'IMPORT_BASE_WORDS', 'IMPORT_PARALLEL_WORDS', 'IMPORT_LANGS', 'IMPORT_LANG_QUALIFIERS', 'IMPORT_COLS'].map(appConstant).join('\n');
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

test('every version spot agrees, and this build has release highlights', () => {
  // Deliberately derives the version instead of pinning it. The old form asserted "2.1" in six places,
  // so every release broke it and had to hand edit it, which is precisely the step that gets skipped.
  // What is worth guarding is not the NUMBER, it is that the four places never drift apart: the app
  // footer, Android, the XcodeGen spec Xcode Cloud actually builds from, and the committed pbxproj.
  const m = source.match(/var APP_VERSION = "([^"]+)";/);
  assert.ok(m, 'APP_VERSION is in the source');
  const version = m[1];

  const gradle = fs.readFileSync(path.join(__dirname, '../app/build.gradle.kts'), 'utf8');
  const gm = gradle.match(/versionName = "([^"]+)"/);
  assert.ok(gm, 'versionName is in build.gradle.kts');
  assert.equal(gm[1], version, `Android versionName ${gm[1]} does not match APP_VERSION ${version}`);
  assert.match(gradle, /versionCode = System\.getenv\("VERSION_CODE"\)\?\.toIntOrNull\(\) \?: \d+/);

  const spec = fs.readFileSync(path.join(__dirname, '../ios/SphereDex/project.yml'), 'utf8');
  const sm = spec.match(/MARKETING_VERSION: "([^"]+)"/);
  const sb = spec.match(/CURRENT_PROJECT_VERSION: "([^"]+)"/);
  assert.ok(sm && sb, 'project.yml carries both iOS version fields');
  assert.equal(sm[1], version, `iOS MARKETING_VERSION ${sm[1]} does not match APP_VERSION ${version}`);

  // project.yml is the one Xcode Cloud builds from; the pbxproj is for local Xcode. They must agree, or
  // a Simulator build and a store build report different versions.
  const project = fs.readFileSync(path.join(__dirname, '../ios/SphereDex/SphereDex.xcodeproj/project.pbxproj'), 'utf8');
  assert.equal((project.match(new RegExp('MARKETING_VERSION = ' + version.replace(/\./g, '\\.') + ';', 'g')) || []).length, 2,
    `pbxproj MARKETING_VERSION should be ${version} in both configs`);
  assert.equal((project.match(new RegExp('CURRENT_PROJECT_VERSION = ' + sb[1] + ';', 'g')) || []).length, 2,
    `pbxproj CURRENT_PROJECT_VERSION should be ${sb[1]} in both configs`);

  // The release needs its three "What's new" lines, or the update headliner shows an empty slide.
  const highlights = source.match(/var RELEASE_HIGHLIGHTS = \{[\s\S]*?\n  \};/);
  assert.ok(highlights, 'RELEASE_HIGHLIGHTS is in the source');
  const box = {};
  vm.createContext(box);
  vm.runInContext(highlights[0] + '\n' + ['verNum', 'missedVisitPhrase'].map(appFunction).join('\n'), box);
  assert.ok(box.RELEASE_HIGHLIGHTS[version], `RELEASE_HIGHLIGHTS has no entry for ${version}`);
  assert.equal(box.RELEASE_HIGHLIGHTS[version].length, 3, `${version} needs exactly three highlight lines`);
  for (const line of box.RELEASE_HIGHLIGHTS[version]) {
    assert.equal(/[-\u2013\u2014]/.test(line), false, `no dashes in user facing copy: ${line}`);
  }

  // An older store record must never read as an update to install.
  const older = Object.keys(box.RELEASE_HIGHLIGHTS).filter((v) => box.verNum(v) < box.verNum(version));
  assert.ok(older.length > 0, 'there is at least one earlier release to compare against');
  for (const v of older) {
    assert.equal(box.verNum(v) > box.verNum(version), false, `${v} must not out-rank ${version}`);
  }
  assert.match(source, /if\(latest && verNum\(latest\) > verNum\(APP_VERSION\)\) offerUpdate\(latest\);/);
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

// ---- Promo types: each Releases promo box opens the Promo set narrowed to its own type ----
const promoBox = {};
vm.createContext(promoBox);
vm.runInContext(appConstant('PROMO_TYPES') + '\n' + ['promoTypeOf', 'promoTypeDef', 'promoTypeAllows'].map(appFunction).join('\n'), promoBox);
const promoIds = Array.from(source.matchAll(/\["(E[A-Z]+-\d+[A-Z]*)",[^\]]*"PR2026"\]/g), (m) => m[1]);

test('promo cards sort into their four types by card code', () => {
  const type = (id) => promoBox.promoTypeOf({ id, set: 'PR2026' });
  assert.equal(type('EPR-001'), 'demo');
  assert.equal(type('ESOUL-000'), 'demo');
  assert.equal(type('EPR-002'), 'tournament');
  assert.equal(type('EPR-009S'), 'tournament');
  assert.equal(type('ESOUL-008'), 'tournament');
  assert.equal(type('EPR-012'), 'masters');
  assert.equal(type('EPR-020'), 'masters');
  assert.equal(type('ESOUL-016'), 'masters');
  assert.equal(type('EPR-010'), 'special');
  // A promo nobody has classified yet still lands somewhere instead of vanishing from every box.
  assert.equal(type('EPR-099'), 'special');
});

test('every promo in the catalogue has a type, and every type has cards', () => {
  assert.ok(promoIds.length >= 20, 'found ' + promoIds.length + ' promo rows');
  const keys = promoBox.PROMO_TYPES.map((t) => t.key);
  const seen = {};
  promoIds.forEach((id) => {
    const k = promoBox.promoTypeOf({ id, set: 'PR2026' });
    assert.ok(keys.includes(k), id + ' has no promo type');
    seen[k] = (seen[k] || 0) + 1;
  });
  keys.forEach((k) => assert.ok(seen[k] > 0, 'no promo cards are typed ' + k));
});

test('a promo type only narrows promo cards', () => {
  const allows = promoBox.promoTypeAllows;
  const tourney = { id: 'EPR-002S', set: 'PR2026' }, demo = { id: 'EPR-001', set: 'PR2026' }, booster = { id: 'EBP01-001', set: 'EBP01' };
  assert.equal(allows(demo, []), true);
  assert.equal(allows(tourney, ['tournament']), true);
  assert.equal(allows(demo, ['tournament']), false);
  assert.equal(allows(demo, ['tournament', 'demo']), true);
  assert.equal(allows(booster, ['tournament']), true);
});

test('the promo boxes open on their own type, and every filter reset clears it', () => {
  assert.equal((source.match(/openSet\("PR2026","all",g\.key\)/g) || []).length, 2, 'row tap and View promos both pass the type');
  assert.match(source, /if\(k==="PR2026" && promoTypeDef\(promo\)\) filters\.promos\[promo\]=true;/);
  const resets = (source.match(/filters\.keywords=\{\};/g) || []).length;
  const promoResets = (source.match(/filters\.keywords=\{\}; filters\.promos=\{\};/g) || []).length;
  assert.ok(resets > 0 && promoResets === resets, promoResets + ' of ' + resets + ' filter resets clear the promo type');
  assert.match(source, /\["exps","sets","colors","els","kinds","keywords","rares","promos"\]/, 'Filters counts a promo type choice');
});

test('promo type copy has no dashes', () => {
  promoBox.PROMO_TYPES.forEach((t) => {
    [t.title, t.chip, t.date, t.desc].forEach((text) => assert.doesNotMatch(text, /[-–—]/, t.key + ': ' + text));
  });
});

test('a promo type can never stay on while hidden', () => {
  // syncSetChips drops the choice whenever the Promo set leaves the Set filter, and the grid and the bar
  // only read it while the Promo set is in scope, so no path can leave an invisible promo filter behind.
  assert.match(appFunction('syncSetChips'), /var promoOn=setFilterCodes\(\)\.indexOf\("PR2026"\)!==-1;\s*if\(!promoOn\) filters\.promos=\{\};/);
  const vis = appFunction('visible');
  assert.match(vis, /var promos=sets\.indexOf\("PR2026"\)!==-1 \? keysOn\(filters\.promos\|\|\{\}\) : \[\];/);
  assert.match(vis, /if \(!promoTypeAllows\(c, promos\)\) return false;/);
  assert.match(appFunction('paintPromoScope'), /var keys=setFilterCodes\(\)\.indexOf\("PR2026"\)!==-1 \? keysOn\(filters\.promos\|\|\{\}\) : \[\];/);
});

test('shortcut openers leave no filter the screen does not show', () => {
  // A product pick without its set is ignored by setFilterCodes, so the Set Sphere shortcut goes through openSet.
  assert.match(appFunction('openSetSphere'), /^function openSetSphere\(id, earned\)\{ openSet\(id, earned\?"all":"missing"\); \}$/);
  // Writing the search box fires no input event, so these openers set the search filter themselves.
  assert.match(appFunction('openMissingCollection'), /filters\.q=query\|\|"";[^]*input\.value=filters\.q;/);
  assert.match(appFunction('openSinceVisit'), /filters\.q="";/);
});

test('a push that links to the app website opens Home, not the browser', () => {
  const at = source.indexOf('window.SDOpenPush = function(url){');
  assert.ok(at > 0, 'SDOpenPush exists');
  const body = source.slice(at, source.indexOf('\n  };', at));
  const home = body.indexOf('showPage("home"); return;'), outside = body.indexOf('window.open(url');
  assert.ok(home > 0 && outside > home, 'the site check runs before the outside link branch');
  const tail = '/i.test(url)){ showPage("home"); return; }';
  const end = body.indexOf(tail), start = body.lastIndexOf('if(/', end);
  assert.ok(start > 0 && end > start, 'site pattern found');
  const re = new RegExp(body.slice(start + 4, end), 'i');
  ['https://spheredex.app', 'https://spheredex.app/', 'https://www.spheredex.app/', 'https://spheredex.app/app/', 'https://spheredex.app/app/index.html']
    .forEach((u) => assert.ok(re.test(u), u + ' should open Home'));
  ['https://spheredex.app/roadmap', 'https://spheredex.app.example.com/', 'https://en.palworld-official-cardgame.com/news/']
    .forEach((u) => assert.ok(!re.test(u), u + ' should still open outside'));
});

// ---- Want list CSV: the wishlist and every Missing goal, exported for a spreadsheet ----
function wantApp(overrides) {
  const cards = [
    { id: 'EBP01-001', name: 'Jormuntide Ignis – Savage Lava Dragon', kind: 'Pal', sub: 'Lucky Pal', rare: 'RR', set: 'EBP01', setIdx: 0, seq: 1 },
    { id: 'EBP01-025SSP', name: 'Chillet – Dragon Whisperer', kind: 'Pal', sub: 'Normal Pal', rare: 'SSP', set: 'EBP01', setIdx: 0, seq: 25 },
    { id: 'ESOUL-001', name: 'Soul', kind: 'Soul', sub: '', rare: 'TD', set: 'ETD01', setIdx: 1, seq: 1000 }
  ];
  const own = {};
  const sandbox = Object.assign({
    CARDS: cards, own: own,
    SETS: { EBP01: { name: 'Dawn of Palpagos' }, ETD01: { name: 'Trial Deck Red Blue' } },
    RARE_NAME: { RR: 'Double Rare', SSP: 'Super Special', TD: 'Trial Deck' },
    SETTINGS: {}, CUR: { code: 'GBP', dec: 2 }, SEAL_ED: 'en',
    STATE: { wishlist: {}, wishlistAt: {} },
    priceMode: () => 'sold', unitOf: () => 4, marketPriceLabel: () => 'last sold',
    toast() {}, saveTextFile() {}
  }, overrides || {});
  const names = ['rawCount', 'csvNum', 'csvCell', 'csvText', 'csvDay', 'wantSearch', 'wantListCsv',
    'isWished', 'wishlistAt', 'wishlistWantItems', 'missingWantItems', 'ownsForCompletion', 'has',
    'edKw', 'edCode'];
  const code = names.map(appFunction).join('\n') + '\n' + ['WANT_HEADER', 'WANT_NUMCOL'].map(appConstant).join('\n');
  vm.runInContext(code, vm.createContext(sandbox));
  sandbox.cards = cards;
  return sandbox;
}
const wantRows = (csv) => csv.replace(/^﻿/, '').trim().split('\r\n');

test('the want list CSV carries the card type the TCGplayer copy throws away', () => {
  const a = wantApp();
  const csv = a.wantListCsv([{ card: a.cards[0], need: 2 }, { card: a.cards[2], need: 1 }]);
  const rows = wantRows(csv);
  assert.equal(rows[0], 'Bought,Number,Need,Have,Name,Card type,Subtype,Set,Rarity,Unit estimate,Line estimate,Currency,Price basis,Wishlisted,eBay search,Notes');
  // A Pal and a Soul are told apart, which is the whole point of the request.
  assert.match(rows[1], /^,EBP01-001,2,0,Jormuntide Ignis – Savage Lava Dragon,Pal,Lucky Pal,Dawn of Palpagos,Double Rare,4\.00,8\.00,GBP,last sold,,/);
  assert.match(rows[2], /,ESOUL-001,1,0,Soul,Soul,,Trial Deck Red Blue,Trial Deck,/);
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'a BOM so Excel reads the accents');
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(rows.length, 3);
});

test('the eBay search cell is a phrase eBay will not read as an exclusion', () => {
  const a = wantApp();
  // eBay reads a leading "-" as "exclude this word", so a printed en dash becomes a space, while the card
  // number keeps its own hyphen because eBay reads that as part of the word.
  assert.equal(a.wantSearch(a.cards[0]), 'Jormuntide Ignis Savage Lava Dragon EBP01-001 palworld card');
  assert.equal(a.wantSearch({ id: 'X-1', name: 'A - B — C' }), 'A B C X-1 palworld card');
  // The Japanese price toggle carries into the search, exactly as the app's own eBay links do.
  const jp = wantApp({ SEAL_ED: 'jp' });
  assert.equal(jp.wantSearch(jp.cards[1]), 'Chillet Dragon Whisperer BP01-025SSP Japanese palworld card');
});

test('the want list counts what you already hold and never creates a holding', () => {
  const a = wantApp();
  a.own['EBP01-001'] = { qty: 2, graded: [{ grader: 'PSA', grade: '10' }] };
  const before = JSON.stringify(a.own);
  const rows = wantRows(a.wantListCsv([{ card: a.cards[0], need: 1 }, { card: a.cards[1], need: 1 }]));
  assert.equal(JSON.stringify(a.own), before, 'exporting is a pure read');
  assert.match(rows[1], /^,EBP01-001,1,3,/, 'two raw copies plus one slab');
  assert.match(rows[2], /^,EBP01-025SSP,1,0,/, 'a card you do not own reads 0, not blank');
});

test('collector mode blanks the money cells but keeps every column', () => {
  const a = wantApp({ SETTINGS: { mode: 'collector' } });
  const rows = wantRows(a.wantListCsv([{ card: a.cards[0], need: 2 }]));
  assert.equal(rows[0].split(',').length, 16);
  assert.equal(rows[1].split(',').length, 16, 'one shape in both price modes');
  assert.match(rows[1], /Double Rare,,,,,/, 'no unit, line, currency or basis');
  assert.match(rows[1], /palworld card/, 'a shopping list still helps you shop');
});

test('the wishlist date is a sortable day, and a wish from before dates existed stays blank', () => {
  const a = wantApp();
  a.STATE.wishlist['EBP01-001'] = true;
  a.STATE.wishlistAt['EBP01-001'] = new Date(2026, 9, 6, 12).getTime();
  a.STATE.wishlist['ESOUL-001'] = true;   // migrated: wished, but no date was recorded
  const items = a.wishlistWantItems();
  assert.deepEqual(JSON.parse(JSON.stringify(items.map((i) => i.card.id))), ['EBP01-001', 'ESOUL-001']);
  assert.deepEqual(JSON.parse(JSON.stringify(items.map((i) => i.need))), [1, 1]);
  const rows = wantRows(a.wantListCsv(items));
  assert.match(rows[1], /,2026-10-06,/);
  assert.equal(a.csvDay(0), '');
  assert.equal(a.csvDay(undefined), '');
  assert.ok(!/,1970-/.test(rows[2]), 'no 1970 for a wish with no date');
});

test('a Missing goal exports in card number order, whatever the screen is sorted by', () => {
  const a = wantApp();
  const data = { items: [{ card: a.cards[2], need: 1 }, { card: a.cards[1], need: 3 }, { card: a.cards[0], need: 1 }] };
  const ids = (list) => JSON.parse(JSON.stringify(list.map((i) => i.card.id)));
  const first = ids(a.missingWantItems('master', data));
  assert.deepEqual(first, ['EBP01-001', 'EBP01-025SSP', 'ESOUL-001']);
  data.items.reverse();   // the Sort control re-sorts the on screen list in place after the hero is built
  assert.deepEqual(ids(a.missingWantItems('master', data)), first, 'the same file every time');
  // Cards you already own drop out of every goal except a deck, where you may still need another copy.
  a.own['EBP01-001'] = { qty: 1 };
  assert.deepEqual(ids(a.missingWantItems('master', data)), ['EBP01-025SSP', 'ESOUL-001']);
  assert.deepEqual(ids(a.missingWantItems('deck', data)), first);
  assert.equal(a.missingWantItems('master', { items: [{ card: a.cards[1], need: 0 }] }).length, 0);
  assert.equal(a.missingWantItems('master', null).length, 0);
});

test('a want list is refused on import instead of landing as cards you own', () => {
  const a = paidApp();
  const want = ['Bought,Number,Need,Have,Name', ',EBP01-001,2,0,Lamball'].join('\r\n');
  const res = a.parseCsvCollection(want);
  assert.equal(res.wantList, true);
  assert.equal(res.added, 0);
  assert.deepEqual(Object.keys(res.own), []);
  // A real collection CSV is untouched by the new guard.
  const real = a.parseCsvCollection(['Number,Quantity', 'EBP01-001,2'].join('\r\n'));
  assert.equal(real.wantList, undefined);
  assert.equal(real.added, 1);
});

test('want list copy has no dashes', () => {
  const headers = appConstant('WANT_HEADER');
  (headers.match(/"([^"]+)"/g) || []).forEach((h) => assert.doesNotMatch(h, /[-–—]/, h));
  // Read the real strings out of the app, never a copy typed in here: a literal in a test drifts away from
  // the app silently and then proves nothing.
  const said = (fn) => (appFunction(fn).match(/toast\("[^"]*"/g) || []).map((m) => m.slice(7, -1));
  const refusal = (appFunction('doImportCsv').match(/toast\("That is a want list[^"]*"/g) || []).map((m) => m.slice(7, -1));
  const toasts = said('exportWantList').concat(refusal);
  assert.ok(toasts.indexOf('Nothing to export yet') >= 0, JSON.stringify(toasts));
  assert.ok(toasts.some((t) => /want list, not a collection/.test(t)), JSON.stringify(toasts));
  assert.ok(toasts.length >= 3, JSON.stringify(toasts));
  toasts.forEach((t) => assert.doesNotMatch(t, /[-–—]/, t));
  // The one toast built from pieces, so it cannot be read whole above.
  assert.match(appFunction('exportWantList'), /"Exported "\+n\+" card"\+\(n===1\?"":"s"\)/);
  assert.equal((source.match(/>Spreadsheet \(CSV\)<\/button>/g) || []).length, 2, 'both buttons use the app house wording');
});

test('the Missing page exports what is on screen now, not what was there when the page drew', () => {
  const a = wantApp();
  const data = { items: [{ card: a.cards[0], need: 1 }, { card: a.cards[1], need: 1 }] };
  assert.equal(a.missingWantItems('master', data).length, 2);
  a.own['EBP01-001'] = { qty: 1 };   // collected from the list, which patches the page without re-rendering
  assert.equal(a.missingWantItems('master', data).length, 1, 'a collected card leaves the list');
  // So the click handlers must call it again rather than close over the render time snapshot.
  const render = appFunction('renderMissing');
  assert.match(render, /missingCsvAction[\s\S]*exportWantList\(missingWantItems\(missingGoal, activeMissingGoal\(\)\)/);
  assert.match(render, /missingTcgAction[\s\S]*copyTcgplayerRows\(missingTcgRows\(missingGoal, activeMissingGoal\(\)\)\)/);
});

test('every new wrapping row carries the full no-flexgap fallback', () => {
  // Old Android WebViews collapse flex gap. A wrapping row needs all three rules, or a wrapped line sits
  // flush against the one above it.
  ['modeexport', 'missingactions', 'missingfoot'].forEach((cls) => {
    assert.match(source, new RegExp('\\.' + cls + ' \\{[^}]*flex-wrap:wrap'), cls + ' wraps');
    assert.match(source, new RegExp('\\.no-flexgap \\.' + cls + '\\{gap:0\\}'), cls + ' clears the gap');
    assert.match(source, new RegExp('\\.no-flexgap \\.' + cls + '>\\*\\+\\*\\{margin-left:\\d+px\\}'), cls + ' spaces along the row');
    assert.match(source, new RegExp('\\.no-flexgap \\.' + cls + '>\\*\\{margin-bottom:\\d+px\\}'), cls + ' spaces wrapped lines');
  });
});
