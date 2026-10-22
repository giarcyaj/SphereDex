'use strict';

// Run with: node tools/test_trade_check.cjs
// The trade checker: two lists, market totals, a collection move, and history that can be opened again.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'paldeck.html'), 'utf8');
const DASH = /[-–—−]/;

function appFunction(name) {
  const m = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(m, 'App function exists: ' + name);
  for (let e = source.indexOf('}', m.index); e >= 0; e = source.indexOf('}', e + 1)) {
    const d = source.slice(m.index, e + 1);
    try { new vm.Script('(' + d + ')'); return d; } catch (_) { /* keep looking */ }
  }
  throw new Error('Could not extract ' + name);
}
function es5(code, label) {
  assert.doesNotMatch(code, /\b(let|const)\s/, label + ': no let or const');
  assert.doesNotMatch(code, /=>/, label + ': no arrow functions');
  assert.doesNotMatch(code, /`/, label + ': no template literals');
  assert.doesNotMatch(code, /\?\.|\?\?|\.includes\(|\.\.\./, label + ': no ?. ?? includes or spread');
}
function tradeSlice() {
  const a = source.indexOf('  // ---- Trade checker ----');
  const b = source.indexOf('  // ---- Navigation ----');
  assert.ok(a > 0 && b > a, 'trade section sits in front of navigation');
  return source.slice(a, b);
}
function same(a, b){ assert.equal(JSON.stringify(a), JSON.stringify(b)); }
function sandbox(names, extra) {
  const sb = Object.assign({
    Date, Math, JSON, Object, Array, String, Number, isFinite,
    moneyIn: (n) => '£' + n,
    RAW_KNOWN: ['1', '2', 'jp', 'cn'], RAW_LANGS: { jp: 1, cn: 1 },
  }, extra || {});
  vm.createContext(sb);
  vm.runInContext(names.map(appFunction).join('\n'), sb);
  return sb;
}
const DATA = ['tradeQty', 'tradeMap', 'tradeDraftNorm', 'tradeLinesNorm', 'tradeRecordNorm', 'tradeNewer', 'normTrades',
  'tradeNet', 'tradeOwnedQty', 'tradeGiveBlocked', 'tradeHasLines', 'tradeSideCopies', 'tradePriceOf', 'tradeValue',
  'tradeBalance', 'tradeDiffKind', 'tradeMoney', 'tradeDiffText', 'tradeUnpricedWords', 'tradeCopiesText', 'tradeTotalText',
  'tradeEachText', 'tradeBasisText', 'tradeSavedBasis', 'tradeEmptyHist', 'tradeClearText', 'tradeDeleteText', 'tradeColLine',
  'tradeListEmpty', 'tradeNameOf', 'tradeBlockText', 'tradeMoveWord', 'tradeCommitText', 'tradeWarnText', 'tradeHistCopies',
  'tradeLinesConv', 'mergeTradeLists', 'tradeBackupPayload', 'tradeImportMerge', 'tradeSnapshotLines', 'tradeNewId', 'tradeSnapshot',
  'tradeLinesOf', 'tradeDraftLines', 'tradeSortLines'];
const APPLY = ['rawCount', 'rawEditionKey', 'rawCounts', 'rawKnownTotal', 'setRawCounts', 'changeRaw',
  'copyNoteClean', 'copyNotesList', 'setCopyNotes', 'tradeQty', 'tradeMap', 'tradeOwnedQty', 'tradeGiveBlocked',
  'tradeNet', 'tradeTakeCopies', 'tradeApplyToOwn'];

function prose(sb) {
  const balReceive = sb.tradeBalance([{ id: 'A', qty: 1, unit: 2 }], [{ id: 'B', qty: 1, unit: 5 }], () => 0);
  const balEven = sb.tradeBalance([{ id: 'A', qty: 1, unit: 2 }], [{ id: 'B', qty: 1, unit: 2 }], () => 0);
  const balNone = sb.tradeBalance([{ id: 'A', qty: 1, unit: null }], [{ id: 'B', qty: 2, unit: 0 }], () => 9);
  const balEmpty = sb.tradeBalance([], [], () => 9);
  return [
    sb.tradeDiffText(balReceive, 'GBP', false),
    sb.tradeDiffText(balReceive, 'GBP', true),
    sb.tradeDiffText(balEven, 'GBP', false),
    sb.tradeDiffText(balNone, 'GBP', false),
    sb.tradeDiffText(balEmpty, 'GBP', false),
    sb.tradeUnpricedWords(0), sb.tradeUnpricedWords(1), sb.tradeUnpricedWords(4),
    sb.tradeCopiesText(0), sb.tradeCopiesText(1), sb.tradeCopiesText(3),
    sb.tradeTotalText(balNone.give, 'GBP', false), sb.tradeTotalText(balEmpty.give, 'GBP', false),
    sb.tradeTotalText(balReceive.get, 'GBP', true),
    sb.tradeEachText(null, 'GBP', false), sb.tradeEachText(1.5, 'GBP', true),
    sb.tradeBasisText('live'), sb.tradeBasisText('sold'),
    sb.tradeSavedBasis({ mode: 'live' }), sb.tradeSavedBasis({ mode: 'sold' }),
    sb.tradeEmptyHist(), sb.tradeClearText(), sb.tradeDeleteText(),
    sb.tradeColLine('Main'), sb.tradeColLine(''),
    sb.tradeListEmpty('give', true), sb.tradeListEmpty('give', false), sb.tradeListEmpty('get', false),
    sb.tradeBlockText([{ id: 'Chillet', need: 2, have: 0 }], (id) => id),
    sb.tradeBlockText([{ id: 'Chillet', need: 2, have: 0, graded: true }], (id) => id),
    sb.tradeBlockText([{ id: 'Chillet', need: 3, have: 1 }], (id) => id),
    sb.tradeBlockText([{ id: 'A', need: 2, have: 0 }, { id: 'B', need: 1, have: 0 }], (id) => id),
    sb.tradeCommitText({ give: { A: 3 }, get: { A: 2 } }, sb.tradeNet({ A: 3 }, { A: 2 }), 'Main'),
    sb.tradeCommitText({ give: { A: 1 }, get: {} }, sb.tradeNet({ A: 1 }, {}), 'Main'),
    sb.tradeCommitText({ give: {}, get: {} }, { give: {}, get: {} }, 'Main'),
    sb.tradeWarnText({ give: { A: 1 }, get: { A: 1 } }, { A: { qty: 1 } }, (id) => id),
    sb.tradeHistCopies({ give: [{ qty: 2 }], get: [{ qty: 1 }] }),
    'Add a card to one side first', 'That trade could not be saved', 'Trade saved',
    'No owned cards match. Turn off From my collection to search every card.',
    'No cards match.', 'You own 2', 'Compare what you give and what you get',
    'No cards on this side.', 'No trades saved yet', 'Remove from history',
  ];
}

test('the trade section is ES5 and the data helpers parse', () => {
  const slice = tradeSlice();
  es5(slice, 'trade section');
  DATA.forEach((n) => es5(appFunction(n), n));
  es5(appFunction('renderTrades'), 'renderTrades');
  es5(appFunction('tradeCommit'), 'tradeCommit');
  es5(appFunction('tradeRowHtml'), 'tradeRowHtml');
});

test('priced copies add up and a missing price is left out of the money', () => {
  const sb = sandbox(DATA);
  const book = (id) => (id === 'A' ? 1.5 : id === 'B' ? 4 : 0);
  const give = [{ id: 'A', qty: 2 }];
  const get = [{ id: 'B', qty: 1 }, { id: 'C', qty: 3, unit: null }];
  const bal = sb.tradeBalance(give, get, book);
  assert.equal(bal.give.total, 3);
  assert.equal(bal.give.copies, 2);
  assert.equal(bal.get.total, 4);
  assert.equal(bal.get.unpriced, 3);
  assert.equal(bal.unpriced, 3);
  assert.equal(bal.diff, 1);
  assert.equal(sb.tradeDiffKind(bal), 'receive');
  const frozen = sb.tradeValue([{ id: 'A', qty: 2, unit: null }], () => 9);
  assert.equal(frozen.total, 0);
  assert.equal(frozen.unpriced, 2);
  assert.equal(frozen.copies, 2);
  const live = sb.tradeValue([{ id: 'A', qty: 2 }], () => 1.5);
  assert.equal(live.total, 3);
  assert.equal(sb.tradeTotalText({ copies: 2, total: 0 }, 'GBP', false), 'No price');
  assert.equal(sb.tradeDiffText(sb.tradeBalance(
    [{ id: 'A', qty: 1, unit: null }], [{ id: 'B', qty: 1, unit: null }], () => 8
  ), 'GBP', false), 'No market price on these cards');
});

test('a card on both sides only needs the difference owned, and a shortfall does not change the collection', () => {
  const sb = sandbox(APPLY);
  const own = { A: { qty: 1, graded: [{ grader: 'PSA', grade: '10' }], rawEditions: { unknown: 1 } } };
  const net = sb.tradeNet({ A: 3 }, { A: 2 });
  same(net, { give: { A: 1 }, get: {} });
  same(sb.tradeGiveBlocked(net.give, own), []);
  assert.equal(sb.tradeGiveBlocked({ A: 3 }, own).length, 1);
  const before = JSON.parse(JSON.stringify(own));
  const blocked = sb.tradeApplyToOwn(own, { give: { A: 3 }, get: {} });
  assert.equal(blocked.ok, false);
  same(own, before);
  const applied = sb.tradeApplyToOwn(own, net);
  assert.equal(applied.ok, true);
  assert.equal(own.A.qty, 0);
  assert.equal(own.A.graded[0].grade, '10');
});

test('giving takes unspecified copies first and receiving uses the default printing', () => {
  const sb = sandbox(APPLY, {
    cardById: (id) => ({ id, name: 'Chillet', set: id.indexOf('EBP') === 0 ? 'EBP01' : 'X' }),
    defaultEditionFor: (card) => (card && card.set === 'EBP01' ? '1' : null),
  });
  const held = {
    qty: 5,
    rawEditions: { unknown: 2, '1': 3 },
    graded: [{ grader: 'PSA', grade: '10' }],
    copyNotes: [{ serial: '1', run: '10' }, { serial: '2', run: '10' }, { serial: '3', run: '10' }],
  };
  const own = { A: held };
  const moved = sb.tradeApplyToOwn(own, { give: { A: 3 }, get: { 'EBP01-001': 2, 'X-1': 1 } });
  assert.equal(moved.ok, true);
  assert.equal(held.qty, 2);
  assert.equal(held.rawEditions.unknown, 0);
  assert.equal(held.rawEditions['1'], 2);
  assert.equal(held.graded[0].grade, '10');
  assert.equal(held.copyNotes.length, 2);
  assert.equal(own['EBP01-001'].qty, 2);
  assert.equal(own['EBP01-001'].rawEditions['1'], 2);
  same(own['EBP01-001'].graded, []);
  assert.equal(own['X-1'].rawEditions.unknown, 1);
  assert.equal(own['X-1'].qty, 1);
});

test('a saved trade freezes the price, including no price', () => {
  const sb = sandbox(DATA, { isConverted: (id) => id === 'B' });
  const rec = sb.tradeSnapshot(
    { give: { A: 2 }, get: { B: 1 }, note: '  event  ', ownedOnly: true },
    { id: 't9', at: 5, colId: 'c', colName: 'Main', cur: 'GBP', mode: 'live' },
    (id) => (id === 'A' ? 0 : 1.25)
  );
  assert.equal(rec.give[0].unit, null);
  assert.equal(rec.give[0].conv, undefined);
  assert.equal(rec.get[0].unit, 1.25);
  assert.equal(rec.get[0].conv, 1);
  assert.equal(rec.note, 'event');
  assert.equal(rec.mode, 'live');
  assert.equal(rec.cur, 'GBP');
  const again = sb.tradeValue(rec.give, () => 50);
  assert.equal(again.total, 0);
  assert.equal(again.unpriced, 2);
});

test('history is cleaned without inventing keys, and the same id keeps the first copy', () => {
  const sb = sandbox(DATA);
  const fresh = {};
  sb.normTrades(fresh);
  assert.equal(fresh.trades, undefined);
  assert.equal(fresh.tradeDraft, undefined);
  const messy = { trades: [
    { id: 't1', at: 1, give: [{ id: 'A', qty: 1, unit: 2 }], get: [] },
    { id: 't1', at: 9, give: [{ id: 'B', qty: 4, unit: 9 }], get: [] },
    { id: 'bad', at: 3, give: [], get: [] },
    { id: '_skip', at: 4, give: [{ id: 'A', qty: 1, unit: 1 }], get: [] },
  ] };
  sb.normTrades(messy);
  assert.equal(messy.trades.length, 1);
  assert.equal(messy.trades[0].give[0].id, 'A');
  assert.equal(messy.tradeDraft, undefined);
  const many = { trades: [] };
  for (let i = 0; i < 105; i++) many.trades.push({ id: 't' + i, at: i + 1, give: [{ id: 'A', qty: 1, unit: 1 }], get: [] });
  sb.normTrades(many);
  assert.equal(many.trades.length, 100);
  assert.equal(many.trades[0].id, 't104');
  assert.equal(many.trades[99].id, 't5');
  const draft = { tradeDraft: { give: { ' EBP01-001 ': 2, 'EBP01-001': 3 }, get: {}, note: '  hi  ', ownedOnly: false } };
  sb.normTrades(draft);
  assert.equal(draft.trades, undefined);
  assert.equal(draft.tradeDraft.give['EBP01-001'], 5);
  assert.equal(draft.tradeDraft.note, 'hi');
  assert.equal(draft.tradeDraft.ownedOnly, false);
});

test('backup keeps trades and a draft only when they have something, and import merges them', () => {
  const sb = sandbox(DATA);
  const base = { app: 'SphereDex', name: 'Main', own: { A: 1 }, sealed: { box: 1 } };
  const empty = sb.tradeBackupPayload(base, [], { give: {}, get: {}, note: '', ownedOnly: true });
  same(Object.keys(empty).sort(), ['app', 'name', 'own', 'sealed']);
  assert.equal(empty.own.A, 1);
  assert.equal(empty.sealed.box, 1);
  const full = sb.tradeBackupPayload(base,
    [{ id: 't1', at: 2, give: [{ id: 'A', qty: 1, unit: 2 }], get: [] }],
    { give: { A: 1 }, get: {}, note: 'hi', ownedOnly: false });
  assert.equal(full.trades[0].id, 't1');
  assert.equal(full.tradeDraft.note, 'hi');
  assert.equal(full.app, 'SphereDex');
  const state = {
    trades: [{ id: 't1', at: 1, give: [{ id: 'A', qty: 1, unit: 1 }], get: [] }],
    tradeDraft: { give: { A: 1 }, get: {}, note: 'keep', ownedOnly: true },
  };
  sb.tradeImportMerge(state, { name: 'Imported' });
  assert.equal(state.trades[0].id, 't1');
  assert.equal(state.tradeDraft.note, 'keep');
  sb.tradeImportMerge(state, {
    trades: [{ id: 't2', at: 5, give: [], get: [{ id: 'B', qty: 1, unit: null }] }],
    tradeDraft: { give: {}, get: { B: 2 }, note: 'new', ownedOnly: true },
  });
  same(state.trades.map((t) => t.id), ['t2', 't1']);
  assert.equal(state.tradeDraft.note, 'keep');
  assert.equal(state.trades[0].get[0].unit, null);
  const bare = {};
  const took = sb.tradeImportMerge(bare, {
    trades: [{ id: 't3', at: 4, give: [{ id: 'C', qty: 1, unit: null }], get: [] }],
    tradeDraft: { give: { C: 1 }, get: {}, note: 'in', ownedOnly: false },
  });
  assert.equal(took.draft, true);
  assert.equal(bare.trades[0].id, 't3');
  assert.equal(bare.tradeDraft.note, 'in');
  assert.equal(bare.tradeDraft.ownedOnly, false);
});

test('local history is merged by id and this device keeps a draft that already has cards', () => {
  const sb = sandbox(DATA);
  const merged = sb.mergeTradeLists(
    [{ id: 't1', at: 1, give: [{ id: 'A', qty: 1, unit: 2 }], get: [] }],
    [{ id: 't1', at: 8, give: [{ id: 'Z', qty: 9, unit: 9 }], get: [] }, { id: 't2', at: 3, give: [], get: [{ id: 'B', qty: 1, unit: 4 }] }]
  );
  same(merged.map((t) => t.id), ['t2', 't1']);
  assert.equal(merged.filter((t) => t.id === 't1')[0].give[0].id, 'A');
});

test('I give can stay inside the owned cards', () => {
  const sb = sandbox(['fold', 'cardSearchText', 'cardMatchesQuery', 'rawCount', 'tradeSearchRank', 'tradePick'].concat(DATA), {
    CARDS: [
      { id: 'EBP01-001', name: 'Chillet', set: 'EBP01' },
      { id: 'EBP01-002', name: 'Lamball', set: 'EBP01' },
    ],
  });
  const own = { 'EBP01-001': { qty: 2 } };
  same(sb.tradePick('ch', true, own).map((c) => c.id), ['EBP01-001']);
  same(sb.tradePick('la', true, own).map((c) => c.id), []);
  same(sb.tradePick('la', false, own).map((c) => c.id), ['EBP01-002']);
  same(sb.tradePick('c', false, own), []);
});

test('a guest with only a trade is worth keeping at sign in', () => {
  function has(state) {
    const sb = { STATE: state };
    vm.createContext(sb);
    vm.runInContext(['localHasCards', 'localHasData'].map(appFunction).join('\n'), sb);
    return sb.localHasData();
  }
  const empty = { trades: [], tradeDraft: { give: {}, get: {} }, cols: [], wishlist: {}, fav: {}, decks: [] };
  assert.equal(has(Object.assign({}, empty, { trades: [{ id: 't1' }] })), true);
  assert.equal(has(Object.assign({}, empty, { tradeDraft: { give: { A: 1 }, get: {} } })), true);
  assert.equal(has(Object.assign({}, empty, { tradeDraft: { give: {}, get: {}, note: 'only a note' } })), false);
  assert.equal(has(empty), false);
});

test('the page, the backup and the sync path are wired, and the copy has no dashes', () => {
  assert.match(source, /id="page-trades"/);
  assert.match(source, /data-page="trades"/);
  assert.match(appFunction('showPage'), /if \(p==="trades"\) renderTrades\(\);/);
  assert.match(appFunction('doExport'), /tradeBackupPayload\(/);
  const importer = appFunction('doImport');
  assert.match(importer, /tradeImportMerge\(STATE, d\)/);
  assert.match(importer, /sealed:sealedMap\(d&&d\.sealed\)/);
  assert.match(appFunction('mergeStates'), /mergeTradeLists\(local\.trades, remote\.trades\)/);
  assert.match(appFunction('localHasData'), /STATE\.trades/);
  assert.match(appFunction('normTop'), /normTrades\(st\)/);
  assert.match(appFunction('repaintAll'), /renderTrades\(\)/);
  assert.match(appFunction('tradeStatHtml'), /class="n priceui"/);
  assert.match(appFunction('renderTradeStats'), /kind==="empty"/);
  const page = source.slice(source.indexOf('id="page-trades"'), source.indexOf('id="page-sealed"'));
  const qsub = /<p class="qsub">([^<]*)<\/p>/.exec(page);
  assert.ok(qsub, 'intro copy');
  assert.match(qsub[1], /I give list/);
  assert.match(qsub[1], /Graded slabs stay/);
  assert.doesNotMatch(qsub[1], DASH);
  [
    'The JSON backup also keeps your trade history.',
    'Restore it into SphereDex, with trade history',
    'A SphereDex file. Trade history is merged.',
    'From my collection',
    'Search cards you own',
    'Search every card',
    'Optional name or event',
    'Compare what you give and what you get',
  ].forEach((s) => {
    assert.ok(source.indexOf(s) >= 0, s);
    assert.doesNotMatch(s, DASH, s);
  });
  const sb = sandbox(DATA);
  prose(sb).forEach((s) => assert.doesNotMatch(String(s), DASH, String(s)));
  assert.match(sb.tradeDiffText(sb.tradeBalance([{ id: 'A', qty: 1, unit: 1 }], [{ id: 'B', qty: 1, unit: 3 }], () => 0), 'GBP', true), /You receive \u2248 £2 more/);
  assert.equal(sb.tradeHistCopies({ give: [{ qty: 2 }], get: [{ qty: 1 }] }), 'Gave 2 \u00b7 Got 1');
  assert.match(sb.tradeCommitText({ give: { A: 3 }, get: { A: 2 } }, sb.tradeNet({ A: 3 }, { A: 2 }), 'Main'), /Cards on both sides count as the difference/);
});
