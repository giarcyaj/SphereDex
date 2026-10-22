'use strict';

// Run with: node tools/test_event_log.cjs
// Event results: the pure log, the deck panel, the match logger, JSON backup and the cloud merge.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
function codeOnly(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? src.length : i + 2; continue; }
    if (c === '"' || c === "'") { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } i++; out += q + q; continue; }
    out += c; i++;
  }
  return out;
}
function es5(code, label) {
  code = codeOnly(code);
  assert.doesNotMatch(code, /\b(let|const)\s/, label + ': no let or const');
  assert.doesNotMatch(code, /=>/, label + ': no arrow functions');
  assert.doesNotMatch(code, /`/, label + ': no template literals');
  assert.doesNotMatch(code, /\?\.|\?\?|\.includes\(|\.\.\.|\.startsWith\(|\.endsWith\(|\.find\(|\.findIndex\(|Array\.from|Object\.values|Object\.entries/, label + ': no ES2015+ syntax or library calls');
}
function visibleText(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function assertNoDashWords(text) {
  assert.doesNotMatch(text, /[A-Za-z][\u2010\u2011\u2012\u2013\u2014\u2015-][A-Za-z]/, 'no dashed word in: ' + text);
  assert.doesNotMatch(text, /[\u2013\u2014]/, 'no en or em dash in: ' + text);
}
// Objects built inside the app sandbox belong to another realm, so deepStrictEqual rejects them.
function same(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

const BEGIN = '/* EVENT LOG BEGIN */';
const END = '/* EVENT LOG END */';
const blockStart = source.indexOf(BEGIN);
const blockEnd = source.indexOf(END);
assert.ok(blockStart > 0 && blockEnd > blockStart, 'event log markers');
assert.equal(source.split(BEGIN).length - 1, 1, 'EVENT LOG BEGIN once');
assert.equal(source.split(END).length - 1, 1, 'EVENT LOG END once');

const FUNCS = ['esc', 'eventClip', 'eventDateOk', 'eventResultCode', 'eventIdOk', 'normEventRound', 'normEventPrize',
  'normEvent', 'normEvents', 'eventRecord', 'deckEventRecord', 'allEventRecord', 'eventRecordText', 'eventRecordWords',
  'eventDateLabel', 'eventRoundsText', 'eventDeckName', 'eventMetaText', 'eventsForView', 'eventDisplayOrder',
  'eventCounts', 'eventSummaryText', 'preferredEventId', 'mergeEvents', 'eventApplyNorm', 'eventList',
  'commitEventDraft', 'commitMatchRound', 'collectionBackup', 'importBackupEvents', 'prizeSuggestions',
  'eventOpt', 'eventDeckSelect', 'eventOptionLabel', 'eventPickSelect', 'eventResultButtons', 'eventFieldHtml',
  'eventNameFields', 'eventPrizeChips', 'eventSheetHtml', 'eventPanelHtml', 'eventRecordStatHtml'];
const CONSTS = /var EVENT_NAME_MAX=80, EVENT_PLACE_MAX=40, EVENT_OPP_MAX=60, EVENT_ROUNDS_MAX=48, EVENT_PRIZES_MAX=30, EVENT_LOG_MAX=500;/.exec(source)[0];

const sandbox = { STATE: {}, Date, Math, JSON, Object, Array, String, Number, isFinite };
vm.createContext(sandbox);
vm.runInContext(CONSTS + '\n' + FUNCS.map(appFunction).join('\n'), sandbox);
const { test } = require('node:test');

test('the event log is ES5 and stays inside its markers', () => {
  es5(source.slice(blockStart, blockEnd), 'event log');
  assert.ok(source.indexOf('function newDeck()') < blockStart, 'the log follows the deck builder');
  assert.ok(blockEnd < source.indexOf('// ---- Missing cards: goal-led collection view'), 'and ends before the missing cards page');
});

test('names, dates, rounds and prizes are normalised', () => {
  assert.equal(sandbox.eventClip('  Shop   challenge  ', 80), 'Shop challenge');
  assert.equal(sandbox.eventClip('   ', 80), '');
  assert.equal(sandbox.eventClip('a'.repeat(90), 80).length, 80);
  assert.equal(sandbox.eventDateOk('2026-10-22'), '2026-10-22');
  assert.equal(sandbox.eventDateOk('2100-12-31'), '2100-12-31');
  assert.equal(sandbox.eventDateOk('2000-01-01'), '2000-01-01');
  ['1999-01-01', '2101-01-01', '2026-13-01', '2026-00-10', '2026-02-00', '2026-02-32', '2026-1-01', 'nope', ''].forEach((v) => {
    assert.equal(sandbox.eventDateOk(v), '', v);
  });
  assert.equal(sandbox.eventResultCode('win'), 'W');
  assert.equal(sandbox.eventResultCode(' LOSS '), 'L');
  assert.equal(sandbox.eventResultCode('draw'), 'D');
  assert.equal(sandbox.eventResultCode('tie'), '');
  assert.equal(sandbox.eventIdOk('e1'), true);
  assert.equal(sandbox.eventIdOk('e_1-2'), true);
  assert.equal(sandbox.eventIdOk('__proto__'), false);
  assert.equal(sandbox.eventIdOk('constructor'), false);
  assert.equal(sandbox.eventIdOk('prototype'), false);
  assert.equal(sandbox.eventIdOk('toString'), true);
  assert.equal(sandbox.eventIdOk('a'.repeat(41)), false);
  assert.equal(sandbox.eventIdOk('has space'), false);
  assert.equal(sandbox.eventIdOk(''), false);
  const n = sandbox.normEvent({
    id: 'e1', name: '  Locals  ', date: '1999-01-01', deckId: 'd1', placing: '1st',
    rounds: [{ result: 'tie' }, { result: 'win', opp: '  Lamball  ' }, { result: 'loss' }, { result: 'draw', opp: 'Katress' }],
    prizes: ['epr-002', 'EPR-002', 'bad prize', 'x', '__PROTO__', 'CONSTRUCTOR']
  });
  assert.equal(n.date, undefined);
  assert.equal(n.deckId, 'd1');
  assert.equal(n.placing, '1st');
  same(n.rounds, [
    { result: 'W', opp: 'Lamball' },
    { result: 'L' },
    { result: 'D', opp: 'Katress' }
  ]);
  same(n.prizes, ['EPR-002']);
  assert.equal(sandbox.normEvent({ id: 'e1', name: '   ', rounds: [], prizes: [] }), null);
  assert.equal(sandbox.normEvent({ id: '__proto__', name: 'Locals', rounds: [], prizes: [] }), null);
  const dup = sandbox.normEvents([
    { id: 'e1', name: 'First', rounds: [], prizes: [] },
    { id: 'e1', name: 'Second', rounds: [], prizes: [] },
    { id: 'bad id', name: 'Nope', rounds: [], prizes: [] },
    null
  ]);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].name, 'First');
});

test('a record is wins, losses and draws, and only for the deck that played', () => {
  const events = [
    { id: 'e1', deckId: 'd1', rounds: [{ result: 'W' }, { result: 'W' }, { result: 'L' }, { result: 'D' }] },
    { id: 'e2', deckId: 'd2', rounds: [{ result: 'L' }] },
    { id: 'e3', rounds: [{ result: 'W' }] }
  ];
  same(sandbox.deckEventRecord(events, 'd1'), { w: 2, l: 1, d: 1, events: 1 });
  same(sandbox.deckEventRecord(events, 'd9'), { w: 0, l: 0, d: 0, events: 0 });
  assert.equal(sandbox.allEventRecord(events).w, 3);
  assert.equal(sandbox.eventRecordText({ w: 2, l: 1, d: 0 }), '2-1-0');
  assert.equal(sandbox.eventRecordWords({ w: 1, l: 1, d: 1 }), '1 win, 1 loss, 1 draw');
  assert.equal(sandbox.eventRecordWords({ w: 0, l: 2, d: 0 }), '0 wins, 2 losses, 0 draws');
  assert.equal(sandbox.eventRoundsText(events[0].rounds.concat([{ result: 'D', opp: 'Katress' }])).indexOf('Win, Win, Loss, Draw, Draw vs Katress'), 0);
  assert.equal(sandbox.eventDateLabel('2026-10-22'), 'Oct 22, 2026');
  assert.equal(sandbox.eventDateLabel('2026-10-02'), 'Oct 2, 2026');
  assert.equal(sandbox.eventDateLabel('nope'), '');
  assert.equal(sandbox.eventMetaText(
    { date: '2026-10-22', deckId: 'd1', placing: '1st' },
    [{ id: 'd1', name: 'Chillet' }]
  ), 'Oct 22, 2026 · Chillet · 1st');
  assert.equal(sandbox.eventDeckName('gone', []), 'Deck removed');
  assert.equal(sandbox.eventDeckName('', []), '');
});

test('the log sorts by date, keeps undated events last, and prefers today for the next game', () => {
  const list = [
    { id: 'a', date: '2026-01-01', name: 'Jan' },
    { id: 'b', name: 'Undated' },
    { id: 'c', date: '2026-05-01', name: 'May first' },
    { id: 'd', date: '2026-05-01', name: 'May later' }
  ];
  same(sandbox.eventDisplayOrder(list).map((e) => e.id), ['d', 'c', 'a', 'b']);
  same(sandbox.eventsForView(list, 'd1', false), []);
  const owned = [{ id: 'a', deckId: 'd1' }, { id: 'b', deckId: 'd2' }];
  same(sandbox.eventsForView(owned, 'd1', false).map((e) => e.id), ['a']);
  assert.equal(sandbox.eventsForView(owned, 'd1', true).length, 2);
  assert.equal(sandbox.preferredEventId([
    { id: 'e1', date: '2026-10-22' },
    { id: 'e2', date: '2026-10-21' },
    { id: 'e3', date: '2026-10-22' }
  ], '2026-10-22'), 'e3');
  assert.equal(sandbox.preferredEventId(list, '2026-10-22'), '');
  assert.equal(sandbox.eventSummaryText([{ id: 'e1', deckId: 'd1', rounds: [{ result: 'W' }] }], 'd1', false), 'This deck: 1 win, 0 losses, 0 draws');
  assert.equal(sandbox.eventSummaryText([{ id: 'e1', rounds: [] }], '', true), '0 wins, 0 losses, 0 draws across 1 event.');
});

test('saving keeps unknown fields, caps new events, and a logged game appends one round', () => {
  const prev = { id: 'e1', name: 'Locals', venue: 'hall', date: '2026-01-01', rounds: [], prizes: [] };
  const edited = sandbox.commitEventDraft([prev], { id: 'e1', name: 'Regionals', rounds: [{ result: 'W' }], prizes: [] });
  assert.equal(edited.ok, true);
  assert.equal(edited.events[0].name, 'Regionals');
  assert.equal(edited.events[0].venue, 'hall');
  assert.equal(edited.events[0].date, undefined);
  assert.equal(prev.name, 'Locals', 'the stored event is not mutated in place');
  assert.equal(sandbox.commitEventDraft([], { id: 'e2', name: '   ' }).error, 'name');

  const full = [];
  for (let i = 0; i < 500; i++) full.push({ id: 'e' + i, name: 'N' + i, rounds: [], prizes: [] });
  assert.equal(sandbox.commitEventDraft(full, { id: 'eNEW', name: 'More', rounds: [], prizes: [] }).error, 'full');
  const renamed = sandbox.commitEventDraft(full, { id: 'e0', name: 'Renamed', rounds: [], prizes: [] });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.events[0].name, 'Renamed');

  const live = { id: 'e1', name: 'Locals', note: 'keep', rounds: [{ result: 'W', opp: 'Lamball', note: 'old' }] };
  const logged = sandbox.commitMatchRound([live], { eventPick: 'e1', result: 'loss', opp: 'Katress', foe: 'Alex' });
  assert.equal(logged.ok, true);
  assert.equal(logged.name, 'Locals');
  assert.equal(logged.events[0].note, 'keep');
  assert.equal(logged.events[0].rounds[0].note, 'old');
  same(logged.events[0].rounds[1], { result: 'L', opp: 'Katress' });
  assert.equal(logged.events[0].foe, undefined);
  assert.equal(live.rounds.length, 1);
  assert.equal(sandbox.commitMatchRound([live], { eventPick: 'e1', result: '', opp: 'Katress' }).error, 'result');

  const capped = { id: 'e9', name: 'Long', rounds: [] };
  for (let i = 0; i < 48; i++) capped.rounds.push({ result: 'W' });
  assert.equal(sandbox.commitMatchRound([capped], { eventPick: 'e9', result: 'W' }).error, 'rounds');
  assert.equal(capped.rounds.length, 48);

  const created = sandbox.commitMatchRound([], { id: 'e4', name: 'Shop challenge', date: '2026-10-22', deckId: 'd1', result: 'W', opp: '', foe: 'Alex' });
  assert.equal(created.ok, true);
  assert.equal(created.events[0].name, 'Shop challenge');
  same(created.events[0].rounds, [{ result: 'W' }]);
  assert.equal(created.events[0].foe, undefined);
  assert.equal(created.events[0].deckId, 'd1');
});

test('cloud merge unions by id and a backup keeps the log only when it has events', () => {
  const merged = sandbox.mergeEvents(
    [{ id: 'e1', name: 'Locals', shop: 'mine' }, { id: 'toString', name: 'Odd' }],
    [{ id: 'e1', name: 'Old' }, { id: 'e2', name: 'Regionals' }, { id: '__proto__', name: 'Bad' }, { id: 'bad id', name: 'No' }]
  );
  same(merged.map((e) => e.id), ['e1', 'e2', 'toString']);
  assert.equal(merged[0].name, 'Locals');
  assert.equal(merged[0].shop, 'mine');
  assert.equal(merged[2].name, 'Odd');

  const backup = sandbox.collectionBackup({ name: 'Mine', own: { a: 1 }, sealed: {} }, []);
  assert.equal(Object.prototype.hasOwnProperty.call(backup, 'events'), false);
  assert.equal(backup.app, 'SphereDex');
  const withLog = sandbox.collectionBackup({ name: 'Mine', own: {}, sealed: {} }, [{ id: 'e1', name: 'Locals', rounds: [{ result: 'win' }], prizes: ['epr-002'] }]);
  assert.equal(withLog.events[0].rounds[0].result, 'W');
  same(withLog.events[0].prizes, ['EPR-002']);

  const imported = sandbox.importBackupEvents(
    [{ id: 'e1', name: 'Local', rounds: [] }, { id: 'e3', name: 'Stay', rounds: [] }],
    [{ id: 'e1', name: 'File', rounds: [{ result: 'W' }] }, { id: 'e2', name: 'New', rounds: [] }, { name: 'no id' }]
  );
  same(imported.map((e) => e.id), ['e1', 'e3', 'e2']);
  assert.equal(imported[0].name, 'File');
  assert.equal(imported[1].name, 'Stay');
  same(sandbox.importBackupEvents([{ id: 'e1', name: 'Local', rounds: [] }], null).map((e) => e.name), ['Local']);
  same(sandbox.importBackupEvents(undefined, [{ id: 'nope' }]), []);
});

test('prize search prefers promo cards and waits for two characters', () => {
  const cards = [
    { id: 'EBP01-010', name: 'Lamball Pal', set: 'EBP01', rare: 'C' },
    { id: 'EPR-001', name: 'Lamball Promo', set: 'PR2026', rare: 'PR' },
    { id: 'ETD01-023', name: 'Lamball Deck', set: 'ETD01', rare: 'TD' },
    { id: 'EPR-009', name: 'Other', set: 'PR2026', rare: 'PR' },
    { id: 'X-1', name: 'Foo', nameEn: 'Lamball English', set: 'EBP01', rare: 'U' }
  ];
  same(sandbox.prizeSuggestions('l', cards), []);
  same(sandbox.prizeSuggestions('  ', cards), []);
  same(sandbox.prizeSuggestions('lamb', cards).map((c) => c.id), ['EPR-001', 'EBP01-010', 'ETD01-023', 'X-1']);
  same(sandbox.prizeSuggestions('epr', cards).map((c) => c.id), ['EPR-001', 'EPR-009']);
  assert.equal(sandbox.prizeSuggestions('english', cards)[0].id, 'X-1');
});

test('the deck panel and both sheets stay free of dashed words', () => {
  const empty = sandbox.eventPanelHtml({ events: [] });
  assert.match(empty, /No events yet/);
  assert.match(empty, /Log event/);
  assertNoDashWords(visibleText(empty));

  const events = [];
  for (let i = 0; i < 6; i++) events.push({ id: 'e' + i, name: 'Shop ' + i, date: '2026-10-22', deckId: i < 5 ? 'd1' : 'd2', placing: '1st', rounds: [{ result: 'W' }, { result: 'L' }], prizes: i === 4 ? ['EPR-002'] : [] });
  const panel = sandbox.eventPanelHtml({
    events: events, deckId: 'd1', all: false, decks: [{ id: 'd1', name: 'Chillet' }],
    ownOf: function () { return 2; },
    cardOf: function () { return { id: 'EPR-002', name: 'Flambelle' }; },
    srcOf: function () { return ''; }
  });
  assert.match(panel, /This deck/);
  assert.match(panel, /All events/);
  assert.match(panel, /Show all 5/);
  assert.match(panel, /own 2/);
  assert.match(panel, /Add Flambelle to your collection/);
  assert.doesNotMatch(panel, /<img/);
  assert.match(panel, /1-1-0/);
  assertNoDashWords(visibleText(panel));
  const withArt = sandbox.eventPanelHtml({
    events: [events[4]], deckId: 'd1', decks: [{ id: 'd1', name: 'Chillet' }],
    cardOf: function () { return { id: 'EPR-002', name: 'Flambelle', pic: 'PR/EPR-002.png' }; },
    srcOf: function () { return 'img/PR/EPR-002.png'; }
  });
  assert.match(withArt, /<img src="img\/PR\/EPR-002.png"/);
  assert.match(sandbox.eventPanelHtml({ events: events, deckId: 'd9', all: false }), /No events for this deck yet/);
  const nasty = sandbox.eventPanelHtml({ events: [{ id: 'e1', name: '<b>Locals</b>', rounds: [], prizes: [] }] });
  assert.match(nasty, /&lt;b&gt;Locals&lt;\/b&gt;/);
  assert.doesNotMatch(nasty, /<b>Locals<\/b>/);

  const edit = sandbox.eventSheetHtml({ mode: 'edit', isNew: true, name: '', date: '2026-10-22', deckId: '', placing: '', rounds: [], prizes: [] }, { decks: [{ id: 'd1', name: 'Chillet' }] });
  assert.match(edit, /Shop challenge/);
  assert.match(edit, /1st, Top 8/);
  assert.match(edit, /Add round/);
  assert.match(edit, /No deck/);
  assert.match(edit, /Prize cards can be added to your collection from the event list/);
  assertNoDashWords(visibleText(edit));

  const round = sandbox.eventSheetHtml({
    mode: 'round', foe: 'Alex', result: '', opp: '', eventPick: 'e1', name: '', date: '2026-10-22', deckId: 'd1'
  }, { decks: [{ id: 'd1', name: 'Chillet' }], events: [{ id: 'e1', name: 'Locals', date: '2026-10-22' }] });
  assert.match(round, /Against Alex/);
  assert.match(round, /New event/);
  assert.match(round, /Locals/);
  assert.match(round, /The table goes back to 10 life for the next game/);
  assert.doesNotMatch(round, /id="eventName"/);
  assertNoDashWords(visibleText(round));

  const fresh = sandbox.eventSheetHtml({ mode: 'round', foe: '', result: 'W', opp: '', eventPick: '', name: '', date: '2026-10-22', deckId: '' }, { decks: [] });
  assert.match(fresh, /id="eventName"/);
  assert.match(fresh, /aria-pressed="true"/);
  assertNoDashWords(visibleText(fresh));

  sandbox.STATE = { events: [{ id: 'e1', deckId: 'd1', rounds: [{ result: 'W' }, { result: 'L' }] }] };
  const stat = sandbox.eventRecordStatHtml({ id: 'd1' });
  assert.match(stat, />1-1-0</);
  assert.match(stat, /title="1 win, 1 loss, 0 draws"/);
  assert.match(stat, />Record</);
  assert.equal(sandbox.eventRecordStatHtml({ id: 'd9' }), '');
  sandbox.STATE = {};
  same(sandbox.eventList(), []);
  assert.equal(sandbox.STATE.events, undefined);
});

test('decks, the match tracker, backup and sync call the log', () => {
  const decks = appFunction('renderDecks');
  assert.ok(decks.indexOf('renderEventLog(d)') > 0 && decks.indexOf('renderEventLog(d)') < decks.indexOf('No decks yet'));
  assert.match(decks, /eventRecordStatHtml\(d\)/);
  const match = appFunction('renderMatch');
  assert.match(match, /data-act="log"/);
  assert.match(match, /Log this game/);
  assert.match(match, /if\(act==="log"\)\{ openMatchLogger\(\); return; \}/);
  assert.match(appFunction('openMatchLogger'), /preferredEventId/);
  assert.match(appFunction('saveEventSheet'), /defaultMatch\(\)/);
  assert.match(appFunction('doExport'), /collectionBackup\(col, eventList\(\)\)/);
  const importer = appFunction('doImport');
  assert.match(importer, /importBackupEvents/);
  assert.match(importer, /sealed:sealedMap\(d&&d\.sealed\)/);
  assert.match(appFunction('mergeStates'), /mergeEvents\(local\.events, remote\.events\)/);
  assert.match(appFunction('closeTopOverlay'), /closeEventSheet\(\)/);
  assert.doesNotMatch(appFunction('doExportCsv'), /eventList|STATE\.events/);
  const privacy = fs.readFileSync(path.join(root, 'docs', 'privacy.html'), 'utf8');
  assert.match(privacy, /event results \(event name, date, deck, round results, opponent decks, placing and prizes\)/);
  assert.match(privacy, /Collections, wishlists, decks, saved trades, event results, notes, and account data are private by default/);
});
