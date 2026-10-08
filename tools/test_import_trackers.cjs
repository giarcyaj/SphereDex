'use strict';

// Run with: node tools/test_import_trackers.cjs
// CSV import from other Palworld TCG trackers (palworldtcg.gg, Palify, Pal Collector). Exercises the real
// app functions from src/paldeck.html against the real card table, without a DOM, native bridges or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');
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
// The baked card table: RAW and RAW2 up to SETS, then the same builder the app uses.
function cardTable() {
  const start = source.indexOf('  var RAW = ['), stop = source.indexOf('  var SETS = {');
  assert.ok(start > 0 && stop > start, 'card table found');
  const box = {};
  vm.createContext(box);
  vm.runInContext(source.slice(start, stop) + '\n' + appConstant('SETS') + '\n' + appConstant('SET_ORDER') + '\n' +
    appConstant('BASE_RARE') + '\n' + appFunction('mkCard') + '\n' +
    'var CARDS = RAW.map(function(a){ return mkCard(a,"EBP01"); }).concat(RAW2.map(function(a){ return mkCard(a, a[12]); }));', box);
  return box;
}
const TABLE = cardTable();

const functionNames = [
  'rawCount', 'rawEditionKey', 'rawEditionLabel', 'rawCounts', 'rawKnownTotal', 'setRawCounts', 'changeRaw',
  'csvNum', 'paidNumber', 'csvPaid', 'csvCell', 'csvEdition', 'csvText', 'collectionCsv',
  'parseCsvRows', 'csvUnguard', 'parseCsvCollection',
  'importOwn', 'importHeaderKey', 'importRoles', 'importSplitNumber', 'importParallel', 'importLang', 'importQty',
  'importCardId', 'importPreview', 'importWhat', 'importToast', 'importName'
];
const constantNames = [
  'RAW_KNOWN', 'CSV_HEADER', 'CSV_NUMCOL', 'CARD_CONDS',
  'IMPORT_PARALLELS', 'IMPORT_BASE_WORDS', 'IMPORT_PARALLEL_WORDS', 'IMPORT_LANGS', 'IMPORT_LANG_QUALIFIERS', 'IMPORT_COLS'
];
const appCode = functionNames.map(appFunction).join('\n') + '\n' + constantNames.map(appConstant).join('\n');
const RARE_NAME = vm.runInNewContext(appConstant('RARE_NAME') + ' RARE_NAME');

function app() {
  const byNumberIdx = {};
  TABLE.CARDS.forEach(c => { byNumberIdx[c.id.toUpperCase()] = c; });
  const col = { id: 'test', name: 'Test collection', own: {}, sealed: {} };
  const box = { id: 'BOX1', name: 'Booster Box', set: 'Dawn of Palpagos', pre: false };
  const sandbox = {
    STATE: { cols: [col], active: col.id }, own: col.own, CARDS: TABLE.CARDS, SEALED: [box], byNumberIdx,
    SETS: TABLE.SETS, RARE_NAME, SETTINGS: { defaultGrader: 'PSA' }, CUR: { code: 'GBP', dec: 2 },
    activeCol: () => col, priceMode: () => 'sold', unitOf: () => 2.5, sealUnit: () => 20
  };
  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox);
  sandbox.col = col;
  sandbox.box = box;
  return sandbox;
}
const plain = value => JSON.parse(JSON.stringify(value));
const A = app();
const idOf = (num, par) => plain(A.importCardId(num, par === undefined ? null : par));
const csv = lines => lines.join('\r\n');
const counts = (a, entry) => plain(a.rawCounts(entry));

test('the real catalogue is loaded', () => {
  assert.ok(TABLE.CARDS.length >= 277, 'every baked printing');
  assert.ok(A.byNumberIdx['EBP01-001OSR'] && A.byNumberIdx['ETD01-012TSP'] && A.byNumberIdx['EPR-002S'] && A.byNumberIdx['ESOUL-001']);
});

test('un-prefixed BP, TD, SOUL and promo numbers map onto SphereDex ids', () => {
  assert.deepEqual(idOf('BP01-045'), { id: 'EBP01-045' });
  assert.deepEqual(idOf('bp01-45'), { id: 'EBP01-045' }, 'case and a short number are tolerated');
  assert.deepEqual(idOf('TD01-012'), { id: 'ETD01-012' });
  assert.deepEqual(idOf('TD02-024'), { id: 'ETD02-024' });
  assert.deepEqual(idOf('SOUL-001'), { id: 'ESOUL-001' });
  assert.deepEqual(idOf('SOUL-014'), { id: 'ESOUL-014' });
  assert.deepEqual(idOf('PR-010'), { id: 'EPR-010' });
  assert.deepEqual(idOf('#BP01-100'), { id: 'EBP01-100' });
});

test('numbers exactly as palworldtcg.gg lists them (API sample, 2026-10-08)', () => {
  // card_number values from https://palworldtcg.gg/api/v1/cards?include_parallels=true, with the SphereDex id each
  // is expected to land on. Promo numbers there already carry the E (EPR-002S); Soul cards drop it (SOUL-001).
  const sample = {
    'BP01-001': 'EBP01-001', 'BP01-001-OSR': 'EBP01-001OSR', 'BP01-001-SSP': 'EBP01-001SSP', 'BP01-002-SP': 'EBP01-002SP',
    'BP01-003-SR': 'EBP01-003SR', 'TD01-001-TSP': 'ETD01-001TSP', 'TD01-001-TSR': 'ETD01-001TSR', 'TD02-012': 'ETD02-012',
    'EPR-001': 'EPR-001', 'EPR-002S': 'EPR-002S', 'EPR-011': 'EPR-011', 'SOUL-000': 'ESOUL-000', 'SOUL-001': 'ESOUL-001'
  };
  Object.keys(sample).forEach(n => assert.deepEqual(idOf(n), { id: sample[n] }, n));
});

test('E-prefixed numbers still resolve, including SphereDex ids exactly', () => {
  assert.deepEqual(idOf('EBP01-045'), { id: 'EBP01-045' });
  assert.deepEqual(idOf('EBP01-001OSR'), { id: 'EBP01-001OSR' });
  assert.deepEqual(idOf('ebp01-001osr'), { id: 'EBP01-001OSR' });
  assert.deepEqual(idOf('ETD01-012TSP'), { id: 'ETD01-012TSP' });
  assert.deepEqual(idOf('ESOUL-001'), { id: 'ESOUL-001' });
  assert.deepEqual(idOf('EPR-009S'), { id: 'EPR-009S' });
});

test('every parallel suffix form', () => {
  ['BP01-001-OSR', 'BP01-001OSR', 'BP01-001_OSR', 'BP01-001 OSR', 'BP01-001 (OSR)', 'BP01-001.OSR', 'EBP01-001-OSR']
    .forEach(n => assert.deepEqual(idOf(n), { id: 'EBP01-001OSR' }, n));
  assert.deepEqual(idOf('BP01-001_SSP'), { id: 'EBP01-001SSP' });
  assert.deepEqual(idOf('BP01-002SP'), { id: 'EBP01-002SP' });
  assert.deepEqual(idOf('BP01-003-SR'), { id: 'EBP01-003SR' });
  assert.deepEqual(idOf('TD01-012-TSP'), { id: 'ETD01-012TSP' });
  assert.deepEqual(idOf('TD02-001_TSR'), { id: 'ETD02-001TSR' });
  assert.deepEqual(idOf('EPR-002-S'), { id: 'EPR-002S' });
  // A parallel SphereDex does not have for that card is reported, never dropped back to the regular card.
  assert.deepEqual(idOf('BP01-045-OSR'), { reason: 'No OSR version in SphereDex' });
  assert.deepEqual(idOf('BP01-001-XYZ'), { reason: 'Unknown parallel “XYZ”' });
});

test('every parallel form from its own column', () => {
  const p = (v, strict) => plain(A.importParallel(v, strict));
  ['OSR', 'osr', '(OSR)', 'Alt Art', 'Alt Art (OSR)', 'Parallel OSR'].forEach(v => assert.deepEqual(p(v, true), { code: 'OSR' }, v));
  assert.deepEqual(p('SSP', true), { code: 'SSP' });
  assert.deepEqual(p('Super Special', false), { code: 'SSP' });
  assert.deepEqual(p('Super Rare', false), { code: 'SR' });
  assert.deepEqual(p('Special', false), { code: 'SP' });
  assert.deepEqual(p('Trial Super Rare', false), { code: 'TSR' });
  assert.deepEqual(p('TSP', false), { code: 'TSP' });
  assert.deepEqual(p('S', false), { code: 'S' });
  ['', 'RR', 'C', 'Common', 'Double Rare', 'Promo', 'Soul', 'Trial Deck', 'Normal', 'Regular'].forEach(v => assert.deepEqual(p(v, true), { code: '' }, v));
  assert.deepEqual(p('Mystery', false), { code: '' }, 'an unknown word in a rarity column is a base rarity');
  assert.deepEqual(p('Mystery', true), { bad: 'Mystery' }, 'a variant column is strict');
  assert.deepEqual(p('Foil', false), { bad: 'Foil' }, 'a parallel that is not named is never guessed');

  const res = A.parseCsvCollection(csv([
    'Card Number,Quantity,Rarity,Variant',
    'BP01-001,1,OSR,',
    'BP01-001,2,RR,',
    'BP01-001,1,,SSP',
    'BP01-003,1,Super Rare,',
    'TD01-012,1,TSP,',
    'EPR-002,1,S,',
    'BP01-001-OSR,1,RR,',
    'BP01-045,1,OSR,',
    'BP01-001,1,,Foil'
  ]));
  assert.deepEqual(Object.keys(res.own).sort(), ['EBP01-001', 'EBP01-001OSR', 'EBP01-001SSP', 'EBP01-003SR', 'EPR-002S', 'ETD01-012TSP']);
  assert.equal(res.own['EBP01-001'].qty, 2);
  assert.equal(res.own['EBP01-001OSR'].qty, 2, 'a suffix on the number wins over the rarity column');
  assert.deepEqual(plain(res.unmatched), [
    { row: 9, raw: 'BP01-045', reason: 'No OSR version in SphereDex' },
    { row: 10, raw: 'BP01-001', reason: 'Parallel “Foil” not recognised' }
  ]);
});

test('a Language column files Japanese and Chinese copies in those editions', () => {
  ['JP', 'ja', 'JPN', 'Japanese', 'japanese', '日本語', 'ja-JP'].forEach(v => assert.equal(A.importLang(v), 'jp', v));
  ['CN', 'zh', 'ZH', 'Chinese', 'Chinese (Simplified)', 'zh-CN', 'zh-Hans', '简体中文', '中文'].forEach(v => assert.equal(A.importLang(v), 'cn', v));
  ['', 'EN', 'en', 'English', 'en-US', ' english '].forEach(v => assert.equal(A.importLang(v), 'en', v));
  ['Korean', 'KO', 'zh-TW', 'Traditional Chinese', '繁體中文', 'constructor'].forEach(v => assert.equal(A.importLang(v), null, v));

  const res = A.parseCsvCollection(csv([
    'card_number,qty,language',
    'BP01-001,2,JP',
    'BP01-001,1,Japanese',
    'BP01-001,3,CN',
    'BP01-001,1,English',
    'BP01-001,1,',
    'BP01-002,1,Korean'
  ]));
  assert.deepEqual(counts(A, res.own['EBP01-001']), { '1': 0, '2': 0, jp: 3, cn: 3, unknown: 2 });
  assert.equal(res.cards, 8);
  assert.deepEqual(plain(res.unmatched), [{ row: 7, raw: 'BP01-002', reason: 'Language “Korean” not supported' }]);
  // No language column at all means English, exactly as before.
  const plainFile = A.parseCsvCollection(csv(['Number,Quantity', 'BP01-001,2']));
  assert.deepEqual(counts(A, plainFile.own['EBP01-001']), { '1': 0, '2': 0, unknown: 2 });
});

test('unknown numbers are reported as unmatched with the raw number and a reason', () => {
  const res = A.parseCsvCollection(csv([
    'Number,Qty',
    'BP01-045,1',
    'BP02-001,1',
    'SS01-001-OSR,2',
    'SOUL-010,1',
    'Lamball,1',
    ',1',
    'BP01-046,lots'
  ]));
  assert.deepEqual(Object.keys(res.own), ['EBP01-045']);
  assert.deepEqual(plain(res.unmatched), [
    { row: 3, raw: 'BP02-001', reason: 'Not in SphereDex yet' },
    { row: 4, raw: 'SS01-001-OSR', reason: 'Not in SphereDex yet' },
    { row: 5, raw: 'SOUL-010', reason: 'Not in SphereDex yet' },
    { row: 6, raw: 'Lamball', reason: 'Not a card number' },
    { row: 7, raw: '', reason: 'No card number' },
    { row: 8, raw: 'BP01-046', reason: 'Quantity “lots” not readable' }
  ]);
  assert.equal(res.skipped, 6);
});

test('header synonyms, delimiters, a BOM and quoted fields', () => {
  const files = [
    '﻿Card Number;Qty;Name\r\nBP01-001;2;"Jormuntide; Ignis"\r\n',
    'card_number\tCount\nBP01-001\t2\n',
    'CODE,AMOUNT\nBP01-001,2\n',
    '"Card No.","Owned"\n"BP01-001","2"\n',
    'ID,Copies,Name\nBP01-001,2,"Jormuntide Ignis, ""Savage"""\n',
    'Name,Card #,Quantity Owned\n"Jormuntide Ignis, Savage Lava Dragon",BP01-001,2\n',
    'Set Code,Number,Quantity\nBP01,1,2\n'
  ];
  files.forEach(text => {
    const res = A.parseCsvCollection(text);
    assert.deepEqual(Object.keys(res.own), ['EBP01-001'], text);
    assert.equal(res.own['EBP01-001'].qty, 2, text);
    assert.deepEqual(plain(res.unmatched), [], text);
  });
  // No quantity column: one copy per row.
  const noQty = A.parseCsvCollection('Card Number,Name\nBP01-001,Jormuntide\nBP01-001,Jormuntide\nTD01-001,x\n');
  assert.equal(noQty.own['EBP01-001'].qty, 2);
  assert.equal(noQty.own['ETD01-001'].qty, 1);
  // An owned checkbox, and checklist rows with nothing owned, which are counted but not listed.
  const check = A.parseCsvCollection('Number,Owned\nBP01-001,yes\nBP01-002,0\nBP01-003,no\nBP01-004,2.0\n');
  assert.deepEqual(Object.keys(check.own).sort(), ['EBP01-001', 'EBP01-004']);
  assert.equal(check.own['EBP01-004'].qty, 2);
  assert.equal(check.zero, 2);
  assert.deepEqual(plain(check.unmatched), []);
  // A header the reader does not know still falls back to the tolerant line reader.
  const loose = A.parseCsvCollection('BP01-045 2\nbp01-045,x3\nBP02-001 1\nhello\n');
  assert.equal(loose.own['EBP01-045'].qty, 5);
  assert.deepEqual(plain(loose.unmatched), [
    { row: 3, raw: 'BP02-001', reason: 'Not in SphereDex yet' },
    { row: 4, raw: 'hello', reason: 'No card number found' }
  ]);
  const semicolonsWin = A.parseCsvCollection('Number;Quantity;Notes, more\nBP01-001;3;a, b\n');
  assert.equal(semicolonsWin.own['EBP01-001'].qty, 3, 'the separator the header uses most');
});

test('a SphereDex CSV still round trips exactly', () => {
  const a = app();
  a.col.own['EBP01-001'] = { qty: 4, rawEditions: { '1': 1, '2': 1, jp: 1, unknown: 1 }, cond: 'Lightly Played', notes: 'Binder, page 2', paidRaw: { jp: 3 }, graded: [{ grader: 'PSA', grade: '9.5', value: 40, cert: '123', edition: 'cn', paid: 20 }] };
  a.col.own['EBP01-001OSR'] = { qty: 1, rawEditions: { cn: 1 }, cond: 'Near Mint', notes: '', graded: [] };
  a.col.own['EBP01-003SR'] = { qty: 2, cond: 'Near Mint', notes: '', graded: [] };
  a.col.own['ETD01-012TSP'] = { qty: 1, cond: 'Near Mint', notes: '', graded: [] };
  a.col.own['EPR-002S'] = { qty: 1, cond: 'Near Mint', notes: '=not a formula', graded: [] };
  a.col.own['ESOUL-001'] = { qty: 1, cond: 'Near Mint', notes: '', graded: [] };
  a.col.sealed.BOX1 = { qty: 2, rrp: 0, mkt: 0, last: 0, avg: 0, paid: 90 };
  const text = a.collectionCsv(a.col);
  const res = a.parseCsvCollection(text);
  assert.deepEqual(plain(res.unmatched), []);
  assert.equal(res.zero, 0);
  assert.equal(res.skipped, 0);
  assert.deepEqual(Object.keys(res.own).sort(), Object.keys(a.col.own).sort());
  Object.keys(a.col.own).forEach(id => {
    assert.deepEqual(counts(a, res.own[id]), counts(a, a.col.own[id]), id);
    assert.equal(res.own[id].cond, a.col.own[id].cond, id);
    assert.equal(res.own[id].notes, a.col.own[id].notes, id);
  });
  assert.deepEqual(plain(res.own['EBP01-001'].paidRaw), { jp: 3 });
  assert.deepEqual(plain(res.own['EBP01-001'].graded), [{ grader: 'PSA', grade: '9.5', value: 40, cert: '123', edition: 'cn', paid: 20 }]);
  assert.equal(res.sealed.BOX1.qty, 2);
  assert.equal(res.sealed.BOX1.paid, 90);
  assert.equal(res.cards, 10);
  assert.equal(res.slabs, 1);
  assert.equal(res.sealedItems, 2);
  // And a second trip through export gives the same file.
  a.col.own = res.own; a.own = res.own; a.col.sealed = res.sealed;
  assert.equal(a.collectionCsv(a.col), text);
});

test('the preview lists what will be added, in catalogue order, before anything is written', () => {
  const res = A.parseCsvCollection(csv([
    'Number,Quantity,Language,Type,Grader,Grade',
    'TD01-012,1,,,,',
    'BP01-001,2,JP,,,',
    'BP01-001,1,,,,',
    'BP01-001-OSR,1,,Graded,PSA,10',
    'BOX1,1,,Sealed,,',
    'BP02-001,1,,,,'
  ]));
  assert.deepEqual(plain(A.importPreview(res)), [
    { id: 'EBP01-001', name: A.byNumberIdx['EBP01-001'].name, qty: 2, what: 'Japanese' },
    { id: 'EBP01-001', name: A.byNumberIdx['EBP01-001'].name, qty: 1, what: '' },
    { id: 'EBP01-001OSR', name: A.byNumberIdx['EBP01-001OSR'].name, qty: 1, what: 'Graded PSA 10' },
    { id: 'ETD01-012', name: A.byNumberIdx['ETD01-012'].name, qty: 1, what: '' },
    { id: 'BOX1', name: 'Dawn of Palpagos Booster Box', qty: 1, what: 'Sealed' }
  ]);
  assert.equal(A.importWhat(res), '4 cards, 1 slab and 1 sealed item');
  assert.equal(res.unmatched.length, 1);
  // Parsing is pure: the active collection is untouched until the user confirms.
  assert.deepEqual(plain(A.col.own), {});
  const preview = appFunction('openCsvPreview'), importer = appFunction('doImportCsv');
  assert.match(importer, /openCsvPreview\(res, nm, function\(\)\{[^]*STATE\.cols\.push/, 'the collection is only created in the confirm callback');
  assert.doesNotMatch(importer.slice(0, importer.indexOf('openCsvPreview(')), /STATE\.cols\.push|switchCol/);
  assert.match(preview, /var close=function\(\)\{ sc\.hidden=true;/);
  assert.match(preview, /cancel\.onclick=close;/);
  assert.match(source, /<div class="askscrim" id="csvPrevScrim" hidden>/);
  assert.match(source, /"fileIOScrim","csvPrevScrim"\]/, 'Back and Escape close the preview too');
});

test('the closing toast uses the preview wording and counts each left out row once', () => {
  const res = A.parseCsvCollection(csv([
    'Number,Quantity',
    'BP01-001,10',
    'BP01-002,6',
    'BP01-003,0',
    'BP02-001,1',
    'Lamball,1'
  ]));
  assert.equal(res.cards, 16);
  assert.equal(res.zero, 1);
  assert.equal(res.unmatched.length, 2);
  assert.equal(res.skipped, 3, 'skipped still includes quantity 0 rows');
  assert.equal(A.importToast(res), 'Imported 16 cards · 2 couldn\'t be matched', 'quantity 0 rows are not counted as unmatched');
  assert.equal(A.importToast(A.parseCsvCollection('Number,Quantity\nBP01-001,1\nBP01-002,0\n')), 'Imported 1 card');
  const preview = appFunction('openCsvPreview');
  assert.match(preview, /couldn't be matched/, 'the preview and the toast share one wording');
  assert.doesNotMatch(appFunction('doImportCsv'), /skipped/, 'no "lines skipped" toast any more');
  assert.match(appFunction('doImportCsv'), /toast\(importToast\(res\)\)/);
});

test('an imported collection is named after the file, short enough for the header', () => {
  assert.equal(A.importName('palworldtcg-collection.csv'), 'palworldtcg-collection');
  assert.equal(A.importName('My  Pals.txt'), 'My Pals');
  assert.equal(A.importName(''), 'Imported collection');
  assert.equal(A.importName(undefined), 'Imported collection');
  assert.equal(A.importName('.csv'), 'Imported collection');
  const long = A.importName('a very long export file name from some tracker 2026 10 08.csv');
  assert.ok(long.length <= 32, long);
  assert.match(long, /…$/);
  assert.doesNotMatch(appFunction('doImportCsv'), /\(CSV\)/, 'no " (CSV)" suffix');
});

test('the header keeps one row with any collection name', () => {
  // Layout can't be measured here, so guard the rules that make it work.
  assert.match(source, /#colSel \{[^}]*min-width:0;[^}]*white-space:nowrap;[^}]*text-overflow:ellipsis;/);
  const narrow = /@media \(max-width:899px\)\{([^]*?)\n  \}/.exec(source.slice(source.indexOf('Below 900px the toolbar')));
  assert.ok(narrow, 'the narrow header rule exists');
  assert.match(narrow[1], /\.mastutil \{ flex-wrap:nowrap; \}/);
  assert.match(narrow[1], /\.mastutil \.colwrap \{ flex:1 1 0%; min-width:0; \}/);
  assert.match(narrow[1], /\.mastutil #colSel \{ width:100%; max-width:none; \}/);
  assert.match(source, /\.mastutil #curSel \{ flex:0 0 auto; \}/, 'the currency picker keeps its size');
  assert.match(source, /header\.mast \.tbtn\.ghost \{ flex:0 0 auto;/, 'the bell and theme buttons keep their size');
  assert.match(source, /\.no-flexgap \.mastutil\{gap:0\}\.no-flexgap \.mastutil>\*\+\*\{margin-left:6px\}/, 'old WebView fallback');
});

test('the import chooser names the trackers it reads, briefly', () => {
  const m = /setOpt\(b2, 2, "Spreadsheet \(CSV\)", "([^"]+)", doImportCsv\)/.exec(appFunction('openFileIO'));
  assert.ok(m, 'the CSV import option exists');
  assert.match(m[1], /palworldtcg\.gg/);
  assert.match(m[1], /Palify/);
  assert.match(m[1], /Pal Collector/);
  assert.ok(m[1].length <= 60, 'fits in two short lines on a phone: ' + m[1]);
  assert.doesNotMatch(m[1], /[-–—]/);
});

test('import copy has no dashes', () => {
  const literals = fn => (appFunction(fn).match(/"(?:[^"\\]|\\.)*"/g) || []).map(s => s.slice(1, -1));
  const copy = [].concat(
    literals('importCardId').filter(s => /[a-z] [a-z]/i.test(s)),
    (appFunction('parseCsvCollection').match(/miss\([^)]*?"([^"]+)"/g) || []).map(s => s.replace(/^[^"]*"/, '').replace(/"$/, '')),
    literals('openCsvPreview').filter(s => !/[<>=]/.test(s) || /Row |and /.test(s)),
    literals('importWhat'),
    literals('importToast'),
    literals('importName').filter(s => /[a-z] [a-z]/i.test(s)),
    ['Check your import', 'Will be added', 'Not matched']
  );
  assert.ok(copy.length >= 12, JSON.stringify(copy));
  copy.forEach(s => assert.doesNotMatch(s, /[-–—]/, s));
  const modal = source.slice(source.indexOf('<div class="askscrim" id="csvPrevScrim"'), source.indexOf('</div>\n</div>', source.indexOf('id="csvPrevScrim"')));
  assert.match(modal, /Check your import/);
  modal.replace(/<[^>]+>/g, '\n').split('\n').map(s => s.trim()).filter(Boolean).forEach(s => assert.doesNotMatch(s, /[-–—]/, s));
  const info = /csv:"([^"]+)"/.exec(source);
  assert.ok(info, 'the CSV info text exists');
  assert.match(info[1], /palworldtcg\.gg, Palify and Pal Collector/);
  assert.doesNotMatch(info[1].replace(/<code>[^<]*<\/code>/g, ''), /[-–—]/);
});
