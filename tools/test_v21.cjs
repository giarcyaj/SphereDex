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
  ['textAllowsAnyNumber', 'deckCardOf', 'deckLegalityReport', 'deckStatsReport'].map(appFunction).join('\n') + '\n' +
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
    'rawCount', 'rawEditionKey', 'rawEditionLabel', 'rawCounts', 'setRawCounts', 'changeRaw',
    'csvNum', 'paidNumber', 'csvPaid', 'csvCell', 'csvEdition', 'collectionCsv',
    'parseCsvRows', 'csvUnguard', 'parseCsvCollection', 'collectionCostBasis'
  ];
  const code = names.map(appFunction).join('\n') + '\n' + ['CSV_HEADER', 'CSV_NUMCOL', 'CARD_CONDS'].map(appConstant).join('\n');
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
