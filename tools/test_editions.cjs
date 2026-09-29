'use strict';

// Run with: node tools/test_editions.cjs
// Exercise the real embedded app functions, without loading DOM/native bridges or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');
function appFunction(name) {
  const match = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, 'App function exists: ' + name);
  // Let the JS parser identify the closing brace, including nested functions, comments and regexes.
  // The first prefix that parses as one function expression is exactly this declaration.
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
const functionNames = [
  'rawCount', 'rawEditionKey', 'rawEditionLabel', 'rawCounts', 'setRawCounts',
  'changeRaw', 'langKey', 'emptyLangBucket', 'copyLangBucket', 'langCounts', 'setLangCounts',
  'changeRawLang', 'gradedLang', 'rawQtyInLang', 'ownsInLang', 'has', 'csvLang', 'langOfCsv',
  'mergeRawCounts', 'csvNum', 'paidNumber', 'csvPaid', 'csvCell', 'csvEdition', 'collectionCsv',
  'parseCsvRows', 'csvUnguard', 'parseCsvCollection', 'scanRestore', 'scanMoveVariant',
  'scanSessionTotal', 'slabSig', 'cloneSlab', 'mergeLangCounts', 'mergeEntry', 'globalEditDistance', 'globalTextScore',
  'fold', 'plainObj', 'cardMap', 'parseDeckList', 'isEmptyOwn'
];
const appCode = functionNames.map(appFunction).join('\n') + '\n' +
  ['CSV_HEADER', 'CSV_NUMCOL', 'CARD_CONDS', 'DECK_LINE_MAX'].map(appConstant).join('\n');
const card = { id: 'EBP01-001', name: 'Lamball', set: 'EBP01', rare: 'C', base: 'EBP01-001' };
const variant = { ...card, id: 'EBP01-001-SR', rare: 'SR' };
function app() {
  const col = { id: 'test', name: 'Test collection', own: {} };
  const state = { cols: [col], active: col.id, wishlist: {} };
  const sandbox = {
    STATE: state, own: col.own, CARDS: [card], SEALED: [],
    byNumberIdx: { [card.id]: card, [variant.id]: variant },
    SETS: { EBP01: { name: 'Dawn of Palpagos' } }, RARE_NAME: { C: 'Common' },
    SETTINGS: { defaultGrader: 'PSA' }, CUR: { code: 'GBP', dec: 2 },
    scanSession: { items: [], value: 0, ts: 0 },
    activeCol: () => col, scanColById: id => state.cols.find(c => c.id === id),
    priceMode: () => 'sold', unitOf: () => 2.5, unitOfEntry: () => 2.5,
    save() {}, scanRefreshPages() {}, refreshScanSessionUI() {}, renderScanReview() {}, toast() {}
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(appCode, context);
  return context;
}
const plain = value => JSON.parse(JSON.stringify(value));
function expectCounts(context, entry, first, second, unknown) {
  assert.deepEqual(plain(context.rawCounts(entry)), { '1': first, '2': second, unknown });
  assert.equal(entry.qty, first + second + unknown);
}
function capture(id, edition, qty = 1) {
  return { id, edition, qty, dest: 'collection', type: 'raw', colId: 'test', before: '', beforeEntries: { [id]: '' }, value: 2.5 * qty };
}

test('legacy edition and unspecified copies migrate without changing the original entry', () => {
  const a = app();
  const first = { qty: 3, edition: '1' }, unknown = { qty: 2 };
  expectCounts(a, first, 3, 0, 0);
  expectCounts(a, unknown, 0, 0, 2);
  assert.deepEqual(first, { qty: 3, edition: '1' });
  assert.deepEqual(unknown, { qty: 2 });
  assert.equal(a.rawCount(-1), 0);
  assert.equal(a.rawCount(Infinity), 0);
  assert.equal(a.rawCount(2.8), 2);
});

test('mixed raw additions and edition-specific removal preserve other copies', () => {
  const a = app(), entry = { qty: 2, edition: '1', notes: 'Keep this note' };
  a.changeRaw(entry, 1, '2');
  expectCounts(a, entry, 2, 1, 0);
  assert.equal(entry.edition, undefined);
  a.changeRaw(entry, 1, 'unknown');
  a.changeRaw(entry, -5, '2');
  expectCounts(a, entry, 2, 0, 1);
  a.changeRaw(entry, -1, 'unknown');
  expectCounts(a, entry, 2, 0, 0);
  assert.equal(entry.edition, '1');
  assert.equal(entry.notes, 'Keep this note');
  a.changeRaw(entry, -2, '1');
  expectCounts(a, entry, 0, 0, 0);
  assert.equal(entry.edition, undefined);
});

test('cloud edition correction keeps the maximum total instead of duplicating a copy', () => {
  const a = app();
  const older = { qty: 1, rawEditions: { unknown: 1 }, rawEditionsAt: 10 };
  const corrected = { qty: 1, rawEditions: { '1': 1 }, rawEditionsAt: 20 };
  const original = JSON.stringify([older, corrected]);
  const merged = a.mergeEntry(older, corrected);
  expectCounts(a, merged, 1, 0, 0);
  assert.equal(merged.edition, '1');
  assert.equal(JSON.stringify([older, corrected]), original);
  const withOldClientAddition = a.mergeEntry(corrected, { qty: 3 });
  expectCounts(a, withOldClientAddition, 1, 0, 2);
});

test('mixed editions and unspecified copies survive CSV export/import', () => {
  const a = app();
  const entry = { qty: 6, rawEditions: { '1': 2, '2': 3, unknown: 1 }, cond: 'Near Mint', notes: 'Mixed, editions', graded: [] };
  const col = { own: { [card.id]: entry } };
  const before = JSON.stringify(col);
  const csv = a.collectionCsv(col), rows = a.parseCsvRows(csv);
  assert.equal(rows.length, 4, 'one header and one row per raw edition');
  const imported = a.parseCsvCollection(csv);
  expectCounts(a, imported.own[card.id], 2, 3, 1);
  assert.equal(imported.cards, 6);
  assert.equal(imported.own[card.id].notes, 'Mixed, editions');
  assert.equal(JSON.stringify(col), before, 'export must not mutate the collection');
  const unlabelled = a.parseCsvCollection('EBP01-001 2\nEBP01-001 3');
  expectCounts(a, unlabelled.own[card.id], 0, 0, 5);
});

test('undoing an older raw scan leaves later same-card scans and manual edits', () => {
  const a = app(), entry = { qty: 0, graded: [] };
  a.own[card.id] = entry;
  const first = capture(card.id, '1'), second = capture(card.id, '2');
  a.changeRaw(entry, 1, '1');
  second.before = JSON.stringify(entry);
  second.beforeEntries[card.id] = second.before;
  a.changeRaw(entry, 1, '2');
  a.changeRaw(entry, 1, '1');
  entry.notes = 'Written after scanning';
  a.scanRestore(first);
  expectCounts(a, a.own[card.id], 1, 1, 0);
  assert.equal(a.own[card.id].notes, 'Written after scanning');
  a.scanRestore(second);
  expectCounts(a, a.own[card.id], 1, 0, 0);
});

test('correcting a scanned printing moves only that scan quantity and edition', () => {
  const a = app();
  a.own[card.id] = { qty: 4, rawEditions: { '1': 2, '2': 2 }, graded: [], notes: 'Source note' };
  a.own[variant.id] = { qty: 1, edition: '1', graded: [], notes: 'Target note' };
  const item = capture(card.id, '2', 2);
  a.scanSession.items.push(item);
  a.scanMoveVariant(item, variant.id);
  assert.equal(item.id, variant.id);
  expectCounts(a, a.own[card.id], 2, 0, 0);
  expectCounts(a, a.own[variant.id], 1, 2, 0);
  assert.equal(a.own[card.id].notes, 'Source note');
  assert.equal(a.own[variant.id].notes, 'Target note');
  a.scanRestore(item);
  expectCounts(a, a.own[card.id], 2, 0, 0);
  expectCounts(a, a.own[variant.id], 1, 0, 0);
});

test('graded copies from different editions remain distinct during cloud merge', () => {
  const a = app();
  const first = { grader: 'PSA', grade: '10', value: 40, edition: '1' };
  const second = { ...first, edition: '2' };
  assert.notEqual(a.slabSig(first), a.slabSig(second));
  const merged = a.mergeEntry({ qty: 0, graded: [first] }, { qty: 0, graded: [second] });
  assert.equal(merged.graded.length, 2);
  assert.deepEqual(plain(merged.graded.map(g => g.edition)).sort(), ['1', '2']);
});

test('global search tolerates a one-character typo without returning unrelated cards', () => {
  const a = app();
  assert.ok(a.globalTextScore('Lambll', 'Lamball EBP01-001') > 0);
  assert.ok(a.globalTextScore('Dawn of Palpagos', 'Dawn of Palpagos') > 0);
  assert.equal(a.globalTextScore('Pineapple', 'Lamball EBP01-001'), 0);
});

test('search ignores accents and case', () => {
  const a = app();
  assert.equal(a.fold('Jörmuntide'), 'jormuntide');
  assert.ok(a.globalTextScore('Jörmuntide', 'Jormuntide EBP01-001') > 0);
});

test('a backup keeps only object card entries and rejects non-object maps', () => {
  const a = app();
  assert.deepEqual(plain(a.cardMap({ foo: 'bar', 'EBP01-001': 'x' })), {});
  assert.deepEqual(plain(a.cardMap({ 'EBP01-001': { qty: 2 }, 'EBP01-002': null, 'EBP01-003': [1] })), { 'EBP01-001': { qty: 2 } });
  assert.equal(a.cardMap([1, 2, 3]), null);
  assert.equal(a.cardMap('x'), null);
});

test('deck import skips negative or zero quantities and caps a line at a full deck', () => {
  const a = app();
  const res = a.parseDeckList('-3 EBP01-001\n0 EBP01-001\n999999 EBP01-001-SR\n2x EBP01-001');
  assert.deepEqual(plain(res.cards), { 'EBP01-001-SR': 60, 'EBP01-001': 2 });
  assert.equal(res.added, 2);
  assert.equal(res.skipped, 2);
});

test('a collection with no language record is English and is not rewritten on read', () => {
  const a = app();
  const entry = { qty: 2, edition: '1', notes: 'Already here' };
  const before = JSON.stringify(entry);
  assert.deepEqual(plain(a.langCounts(entry)), { en: { '1': 2, '2': 0, unknown: 0 }, jp: { '1': 0, '2': 0, unknown: 0 } });
  assert.equal(a.ownsInLang(entry, 'en'), true);
  assert.equal(a.ownsInLang(entry, 'jp'), false);
  assert.equal(a.ownsInLang(entry, 'both'), true);
  assert.equal(JSON.stringify(entry), before);
  assert.equal(entry.langs, undefined);
});

test('Japanese copies are stored beside English and do not move the English count', () => {
  const a = app();
  const entry = { qty: 2, edition: '1', notes: 'Keep this note', graded: [] };
  a.changeRawLang(entry, 1, '2', 'jp');
  assert.deepEqual(plain(a.langCounts(entry).en), { '1': 2, '2': 0, unknown: 0 });
  assert.deepEqual(plain(a.langCounts(entry).jp), { '1': 0, '2': 1, unknown: 0 });
  assert.equal(entry.qty, 3);
  assert.equal(entry.notes, 'Keep this note');
  a.changeRaw(entry, 1, '1');
  assert.equal(a.langCounts(entry).en['1'], 3);
  assert.equal(a.langCounts(entry).jp['2'], 1);
  assert.equal(a.rawQtyInLang(entry, 'jp'), 1);
  assert.equal(a.rawQtyInLang(entry, 'both'), entry.qty);
});

test('CSV keeps English and Japanese apart, and an old file without Language stays English', () => {
  const a = app();
  const entry = { qty: 0, cond: 'Near Mint', notes: 'Split', graded: [{ grader: 'PSA', grade: '10', value: 4, lang: 'jp' }, { grader: 'PSA', grade: '9', value: 3 }] };
  a.changeRaw(entry, 2, '1');
  a.changeRawLang(entry, 1, '2', 'jp');
  const col = { own: { [card.id]: entry } };
  const before = JSON.stringify(col);
  const csv = a.collectionCsv(col);
  assert.match(csv.split('\r\n')[0], /,Language,Paid$/);
  assert.match(csv, /,EN,/);
  assert.match(csv, /,JP,/);
  const imported = a.parseCsvCollection(csv);
  assert.equal(a.langCounts(imported.own[card.id]).en['1'], 2);
  assert.equal(a.langCounts(imported.own[card.id]).jp['2'], 1);
  assert.equal(a.gradedLang(imported.own[card.id].graded[0]), 'jp');
  assert.equal(a.gradedLang(imported.own[card.id].graded[1]), 'en');
  assert.equal(JSON.stringify(col), before, 'export must not mutate the collection');
  const oldFile = a.parseCsvCollection('Number,Quantity,Edition\nEBP01-001,2,1st\n');
  expectCounts(a, oldFile.own[card.id], 2, 0, 0);
  assert.equal(oldFile.own[card.id].langs, undefined);
  const labelledEn = a.parseCsvCollection('Number,Quantity,Edition,Language,Type\nEBP01-001,1,2nd,EN,Card\n');
  expectCounts(a, labelledEn.own[card.id], 0, 1, 0);
  assert.equal(labelledEn.own[card.id].langs, undefined);
  const labelledJp = a.parseCsvCollection('Number,Quantity,Edition,Language,Type\nEBP01-001,1,1st,Japanese,Card\n');
  assert.equal(a.langCounts(labelledJp.own[card.id]).jp['1'], 1);
  assert.equal(a.langCounts(labelledJp.own[card.id]).en['1'], 0);
  const paidOnly = a.parseCsvCollection('Number,Quantity,Edition,Paid,Type\nEBP01-001,1,1st,1.50,Card\n');
  expectCounts(a, paidOnly.own[card.id], 1, 0, 0);
  assert.equal(paidOnly.own[card.id].langs, undefined);
  assert.equal(paidOnly.own[card.id].paidRaw['1'], 1.5);
});

test('an English slab and a Japanese slab of the same grade stay distinct', () => {
  const a = app();
  const english = { grader: 'PSA', grade: '10', value: 40 };
  const japanese = { grader: 'PSA', grade: '10', value: 40, lang: 'jp' };
  assert.equal(a.gradedLang(english), 'en');
  assert.notEqual(a.slabSig(english), a.slabSig(japanese));
  const merged = a.mergeEntry({ qty: 0, graded: [english] }, { qty: 0, graded: [japanese] });
  assert.equal(merged.graded.length, 2);
});

test('untouched card entries count as empty; anything the user or a price wrote does not', () => {
  const a = app();
  const blank = { qty: 0, wish: false, cond: 'Near Mint', notes: '', mkt: 0, last: 0, avg: 0, graded: [], sold: 0, list: 0, pAt: 0 };
  assert.equal(a.isEmptyOwn(blank), true);
  assert.equal(a.isEmptyOwn({ ...blank, qty: 1 }), false);
  assert.equal(a.isEmptyOwn({ ...blank, graded: [{ grader: 'PSA', grade: '10' }] }), false);
  assert.equal(a.isEmptyOwn({ ...blank, cond: 'Played' }), false);
  assert.equal(a.isEmptyOwn({ ...blank, notes: 'trade' }), false);
  assert.equal(a.isEmptyOwn({ ...blank, sold: 3.2 }), false);
  assert.equal(a.isEmptyOwn({ ...blank, rawEditions: { '1': 0, '2': 0, unknown: 0 } }), false);
});
