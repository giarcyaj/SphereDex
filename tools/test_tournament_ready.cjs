'use strict';

// Run with: node tools/test_tournament_ready.cjs
// Tournament readiness for a deck: English printings in the main deck, any language in the Soul
// deck, and English release days from SET_META. Casual Ready to build is unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'paldeck.html'), 'utf8');
const DASHES = /[-‐-―−]/;

function appFunction(name) {
  const match = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, 'App function exists: ' + name);
  assert.equal(source.indexOf('function ' + name + '(', match.index + 1), -1, name + ' is defined once');
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

// Release strings from SET_META, without evaluating the art payloads that sit beside them.
function setMetaReleases(src) {
  const start = src.indexOf('var SET_META');
  const end = src.indexOf('function boxSrc', start);
  assert.ok(start !== -1 && end > start, 'SET_META block');
  const block = src.slice(start, end);
  const out = {};
  const re = /(\w+)\s*:\s*\{[^}]*?\brelease:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(block))) out[m[1]] = { release: m[2] };
  return out;
}

const FUNCS = [
  'rawCount', 'rawEditionKey', 'rawCounts',
  'deckCardOf', 'deckEventDay', 'deckDayLabel', 'cardEnglishRelease', 'deckTournamentRelease',
  'deckOwnEntry', 'deckTournamentQty', 'deckTournamentReport', 'deckTournamentNameLines',
  'deckTournamentSummary', 'deckTournamentLabel', 'deckEventStored', 'deckTournamentRowNotes',
  'deckNeedCount', 'deckNeedLabel', 'deckStatusLabel',
  'releaseYmd', 'monDateTime'
];

const RealDate = Date;
function FixedDate(...args) {
  if (args.length === 0) return new RealDate(2026, 9, 22, 12, 0, 0);
  return new RealDate(...args);
}
FixedDate.parse = RealDate.parse;
FixedDate.UTC = RealDate.UTC;
FixedDate.now = function() { return new RealDate(2026, 9, 22, 12, 0, 0).getTime(); };

const sandbox = { Date: FixedDate, byNumberIdx: {}, activeCol: function() { return { own: {}, name: 'My Collection' }; }, lsGet: function() { return null; } };
vm.createContext(sandbox);
vm.runInContext(
  FUNCS.map(appFunction).join('\n') + '\n' +
    ['RAW_KNOWN', 'DECK_TOURNAMENT_RULE', 'DECK_EVENT_CHECKS'].map(appConstant).join('\n'),
  sandbox
);
sandbox.SET_META = setMetaReleases(source);
sandbox.SET_META.LATE = { release: 'late Oct 2026' };

function card(partial) {
  return Object.assign({ id: 'X1', name: 'Sample', kind: 'Pal', set: 'EBP01' }, partial);
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('SET_META dates used by the check are the ones already on the set tiles', () => {
  assert.equal(sandbox.SET_META.EBP01.release, 'Jul 30, 2026');
  assert.equal(sandbox.SET_META.ETD01.release, 'Jul 30, 2026');
  assert.equal(sandbox.SET_META.ETD02.release, 'Jul 30, 2026');
  assert.equal(sandbox.SET_META.ESS01.release, 'Oct 16, 2026');
  assert.equal(sandbox.SET_META.PR2026.release, '2026');
});

test('an exact English release day is kept, and a year or a vague month is not invented', () => {
  assert.equal(sandbox.cardEnglishRelease(card({ set: 'EBP01' })), '2026-07-30');
  assert.equal(sandbox.cardEnglishRelease(card({ set: 'ESS01', id: 'ESS01-001' })), '2026-10-16');
  assert.equal(sandbox.cardEnglishRelease(card({ set: 'PR2026', id: 'EPR-012' })), '');
  assert.equal(sandbox.cardEnglishRelease(card({ set: 'LATE' })), '');
  assert.equal(sandbox.cardEnglishRelease(card({ set: 'EBP02' })), '');
  assert.equal(sandbox.cardEnglishRelease(null), '');
  assert.equal(sandbox.releaseYmd('late Oct 2026'), null);
  assert.equal(sandbox.releaseYmd('Nov 2026 to Mar 2027'), null);
});

test('the event day defaults to today and rejects a date that is not a real day', () => {
  assert.equal(sandbox.deckEventDay(''), '2026-10-22');
  assert.equal(sandbox.deckEventDay('nope'), '2026-10-22');
  assert.equal(sandbox.deckEventDay('2026-02-31'), '2026-10-22');
  assert.equal(sandbox.deckEventDay('2026-10-16'), '2026-10-16');
  assert.equal(sandbox.deckDayLabel('2026-10-16'), '16 Oct 2026');
});

test('Japanese and Chinese copies do not count in the main deck, and do count as Soul cards', () => {
  const jp = { qty: 4, rawEditions: { jp: 4 } };
  const cn = { qty: 3, rawEditions: { cn: 3 } };
  const mixed = { qty: 4, rawEditions: { '1': 2, jp: 1, cn: 1 } };
  const unspecified = { qty: 4 };
  const legacyJp = { qty: 4, edition: 'jp' };
  assert.equal(sandbox.deckTournamentQty(card({}), jp), 0);
  assert.equal(sandbox.deckTournamentQty(card({}), cn), 0);
  assert.equal(sandbox.deckTournamentQty(card({}), mixed), 2);
  assert.equal(sandbox.deckTournamentQty(card({}), unspecified), 4);
  assert.equal(sandbox.deckTournamentQty(card({}), legacyJp), 0);
  assert.equal(sandbox.deckTournamentQty(card({ kind: 'Soul' }), jp), 4);
  assert.equal(sandbox.deckTournamentQty(card({}), { qty: 0, graded: [{ edition: '1' }] }), 0);
  assert.equal(sandbox.deckTournamentQty(card({}), null), 0);
});

test('casual Ready to build still counts Japanese copies', () => {
  sandbox.byNumberIdx = { 'EBP01-001': card({ id: 'EBP01-001' }) };
  const cards = { 'EBP01-001': 4 };
  const own = { 'EBP01-001': { qty: 4, rawEditions: { jp: 4 } } };
  assert.equal(sandbox.deckNeedCount(cards, own), 0);
  sandbox.activeCol = function() { return { own: own, name: 'My Collection' }; };
  assert.equal(sandbox.deckNeedLabel({ cards: cards }), 'Ready to build');
});

test('a main deck of Japanese copies is not tournament ready, and the same copies cover a Soul deck', () => {
  const pal = card({ id: 'EBP01-001', name: 'Lamball' });
  const soul = card({ id: 'ESOUL-001', name: 'Soul', kind: 'Soul', set: 'ETD01' });
  const own = {
    'EBP01-001': { qty: 4, rawEditions: { jp: 4 } },
    'ESOUL-001': { qty: 2, rawEditions: { cn: 2 } }
  };
  const blocked = sandbox.deckTournamentReport(
    { 'EBP01-001': 4 }, { 'EBP01-001': pal }, own, '2026-10-22'
  );
  assert.equal(blocked.state, 'bad');
  assert.equal(blocked.ready, false);
  assert.equal(blocked.shortMain, 4);
  assert.equal(blocked.leftOut, 4);
  assert.equal(sandbox.deckTournamentLabel(blocked), 'Not for this event');
  const sum = sandbox.deckTournamentSummary(blocked);
  assert.equal(sum.title, 'Not for this event');
  assert.match(sum.lines[0], /Need 4 English cards for the main deck. Japanese and Chinese copies are not counted/);
  const missing = sandbox.deckTournamentSummary(sandbox.deckTournamentReport(
    { 'EBP01-001': 1 }, { 'EBP01-001': pal }, {}, '2026-10-22'
  ));
  assert.equal(missing.lines[0], 'Need 1 English card for the main deck.');

  const souls = sandbox.deckTournamentReport(
    { 'ESOUL-001': 2 }, { 'ESOUL-001': soul }, own, '2026-10-22'
  );
  assert.equal(souls.state, 'ok');
  assert.equal(souls.shortSoul, 0);
  assert.equal(sandbox.deckTournamentLabel(souls), 'Tournament ready');
});

test('a card is legal on its English release day and not the day before', () => {
  const sleeve = card({ id: 'ESS01-001', name: 'Quivern', set: 'ESS01' });
  const own = { 'ESS01-001': { qty: 1, rawEditions: { '1': 1 } } };
  const onDay = sandbox.deckTournamentReport({ 'ESS01-001': 1 }, { 'ESS01-001': sleeve }, own, '2026-10-16');
  assert.equal(onDay.state, 'ok');
  assert.equal(onDay.late.length, 0);
  const before = sandbox.deckTournamentReport({ 'ESS01-001': 1 }, { 'ESS01-001': sleeve }, own, '2026-10-15');
  assert.equal(before.state, 'bad');
  assert.equal(before.late.length, 1);
  assert.equal(before.late[0].release, '2026-10-16');
  const lateSum = sandbox.deckTournamentSummary(before);
  assert.match(lateSum.lines.join('\n'), /Quivern \(ESS01-001\) releases 16 Oct 2026/);
  assert.deepEqual(plain(sandbox.deckTournamentRowNotes(sleeve, 1, own['ESS01-001'], '2026-10-15')), ['Not legal yet']);
  assert.deepEqual(plain(sandbox.deckTournamentRowNotes(sleeve, 1, own['ESS01-001'], '2026-10-16')), []);
});

test('a promo with no exact release day is called out and does not pretend to be legal', () => {
  const promo = card({ id: 'EPR-012', name: 'Foxparks', set: 'PR2026' });
  const own = { 'EPR-012': { qty: 1 } };
  const report = sandbox.deckTournamentReport({ 'EPR-012': 1 }, { 'EPR-012': promo }, own, '2026-10-22');
  assert.equal(report.state, 'warn');
  assert.equal(report.ready, false);
  assert.equal(report.undated.length, 1);
  assert.equal(sandbox.deckTournamentLabel(report), 'Check release dates');
  const sum = sandbox.deckTournamentSummary(report);
  assert.match(sum.lines[0], /Foxparks \(EPR-012\) has no English release date on file/);
  assert.deepEqual(plain(sandbox.deckTournamentRowNotes(promo, 1, own['EPR-012'], '2026-10-22')), []);
});

test('English shortfall is badged on the row and a lowercase deck id still finds the collection', () => {
  const pal = card({ id: 'EBP01-010', name: 'Cattiva' });
  const own = { 'EBP01-010': { qty: 4, rawEditions: { jp: 3, cn: 0, '2': 1 } } };
  const notes = sandbox.deckTournamentRowNotes(pal, 4, sandbox.deckOwnEntry(own, 'ebp01-010', pal), '2026-10-22');
  assert.deepEqual(plain(notes), ['English 1/4']);
  const report = sandbox.deckTournamentReport({ 'ebp01-010': 4 }, { 'EBP01-010': pal }, own, '2026-10-22');
  assert.equal(report.shortMain, 3);
  assert.equal(report.state, 'bad');
});

test('an empty deck has no tournament verdict, and nine undated cards keep a short tail', () => {
  const empty = sandbox.deckTournamentReport({}, {}, {}, '2026-10-22');
  assert.equal(empty.state, 'empty');
  assert.equal(sandbox.deckTournamentLabel(empty), '');
  assert.equal(sandbox.deckTournamentSummary(empty).lines[0], 'Add cards to check this deck for an event.');
  const qty = {}, byId = {}, own = {};
  for (let i = 0; i < 9; i++) {
    const id = 'P' + i;
    qty[id] = 1;
    own[id] = { qty: 1 };
    byId[id] = card({ id: id, name: 'Promo ' + i, set: 'PR2026' });
  }
  const report = sandbox.deckTournamentReport(qty, byId, own, '2026-10-22', function() { return ''; });
  assert.equal(report.undated.length, 9);
  const lines = sandbox.deckTournamentSummary(report).lines;
  assert.equal(lines.length, 9);
  assert.equal(lines[8], 'And 1 more card with no English release date on file.');
});

test('the status line keeps Ready to build and adds the tournament verdict beside it', () => {
  const pal = card({ id: 'EBP01-001', name: 'Lamball' });
  sandbox.byNumberIdx = { 'EBP01-001': pal };
  const cards = { 'EBP01-001': 2 };
  sandbox.activeCol = function() { return { own: { 'EBP01-001': { qty: 2, rawEditions: { jp: 2 } } }, name: 'My Collection' }; };
  sandbox.lsGet = function() { return '2026-10-22'; };
  const text = sandbox.deckStatusLabel({ cards: cards });
  assert.match(text, /^Ready to build · Not for this event$/);
  sandbox.activeCol = function() { return { own: { 'EBP01-001': { qty: 2 } }, name: 'My Collection' }; };
  assert.equal(sandbox.deckStatusLabel({ cards: cards }), 'Ready to build · Tournament ready');
});

test('tournament copy has no dashes', () => {
  assert.equal(DASHES.test(sandbox.DECK_TOURNAMENT_RULE), false);
  sandbox.DECK_EVENT_CHECKS.forEach(function(row) {
    assert.equal(DASHES.test(row[1]), false, row[1]);
  });
  assert.deepEqual(plain(sandbox.DECK_EVENT_CHECKS).map(function(row) { return row[0]; }), ['sleeves', 'markers', 'navi']);
  const titles = ['Tournament ready', 'Check release dates', 'Not for this event', 'Tournament'];
  titles.forEach(function(t) { assert.equal(DASHES.test(t), false, t); });
  const own = { A: { qty: 1 } };
  const ok = sandbox.deckTournamentSummary(sandbox.deckTournamentReport(
    { A: 1 }, { A: card({ id: 'A', name: 'Lamball', set: 'EBP01' }) }, own, '2026-10-22'
  ));
  ok.lines.forEach(function(line) { assert.equal(DASHES.test(line), false, line); });
  const phrases = [
    'Need 1 English card for the main deck. Japanese and Chinese copies are not counted.',
    'Need 2 English cards for the main deck. Japanese and Chinese copies are not counted.',
    'Need 1 Soul card. Any language counts for the Soul deck.',
    'English copies cover the main deck. Soul cards are covered in any language. Every card released on or before 22 Oct 2026.',
    'Add cards to check this deck for an event.',
    'And 1 more card that releases after this event.',
    'And 2 more cards that release after this event.',
    'English 0/4',
    'Not legal yet'
  ];
  phrases.forEach(function(line) { assert.equal(DASHES.test(line), false, line); });
});
