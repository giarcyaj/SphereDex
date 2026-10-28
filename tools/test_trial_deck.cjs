'use strict';

// Run with: node --test tools/test_trial_deck.cjs
// "I own this deck": marking a Trial Deck as owned adds exactly that deck's cards. Exercises the real app
// functions from src/paldeck.html against the real card table, without a DOM or user data. The expected lists
// are Bushiroad's official card list for each product (manage/card-list-user/list?expansion=ETD01 and ETD02,
// read 28 Oct 2026): every box holds the 24 deck cards and the ESOUL-001 Soul card, plus one TSR or TSP.
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

function app() {
  const start = source.indexOf('  var RAW = ['), stop = source.indexOf('  var SETS = {');
  assert.ok(start > 0 && stop > start, 'card table found');
  const box = { own: {} };
  vm.createContext(box);
  vm.runInContext(source.slice(start, stop) + '\n' + appConstant('SETS') + '\n' + appConstant('SET_ORDER') + '\n' + appConstant('BASE_RARE') + '\n' +
    appFunction('mkCard') + '\n' +
    'var CARDS = RAW.map(function(a){ return mkCard(a,"EBP01"); }).concat(RAW2.map(function(a){ return mkCard(a, a[12]); }));\n' +
    appConstant('RAW_KNOWN') + '\n' + appConstant('TRIAL_DECKS') + '\n' +   // RAW_KNOWN's line also declares RAW_LANGS
    ['o', 'has', 'rawCount', 'rawEditionKey', 'rawCounts', 'rawKnownTotal', 'setRawCounts', 'changeRaw',
      'trialDeckSetOfSealed', 'trialDeckCards', 'trialDeckSpecials', 'trialDeckOwns', 'addTrialDeck', 'trialDeckMessage']
      .map(appFunction).join('\n') + '\n' +
    'function defaultEditionFor(){ return null; }', box);
  return box;
}

const range = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + String(i + 1).padStart(3, '0'));
const OFFICIAL = {
  ETD01: {
    deck: range('ETD01-', 24).concat('ESOUL-001'),
    specials: ['ETD01-001TSP', 'ETD01-001TSR', 'ETD01-005TSR', 'ETD01-007TSR', 'ETD01-008TSR', 'ETD01-011TSR', 'ETD01-012TSP',
      'ETD01-012TSR', 'ETD01-014TSR', 'ETD01-017TSR', 'ETD01-018TSR', 'ETD01-022TSR', 'ETD01-023TSR', 'ETD01-024TSR'],
  },
  ETD02: {
    deck: range('ETD02-', 24).concat('ESOUL-001'),
    specials: ['ETD02-001TSP', 'ETD02-001TSR', 'ETD02-003TSR', 'ETD02-006TSR', 'ETD02-007TSR', 'ETD02-008TSR', 'ETD02-012TSP',
      'ETD02-012TSR', 'ETD02-014TSR', 'ETD02-016TSR', 'ETD02-018TSR', 'ETD02-021TSR', 'ETD02-023TSR', 'ETD02-024TSR'],
  },
};
const ids = list => Array.from(list, c => c.id).sort();

for (const k of Object.keys(OFFICIAL)) {
  test(k + ' adds exactly the official deck cards and offers exactly its special cards', () => {
    const a = app();
    assert.deepEqual(ids(a.trialDeckCards(k)), OFFICIAL[k].deck.slice().sort());
    assert.deepEqual(ids(a.trialDeckSpecials(k)), OFFICIAL[k].specials.slice().sort());
    assert.ok(Array.from(a.trialDeckSpecials(k)).every(c => c.rare === 'TSR' || c.rare === 'TSP'));
  });
}

test('the two decks share nothing but the Soul card', () => {
  const a = app();
  const one = new Set(ids(a.trialDeckCards('ETD01')));
  assert.deepEqual(ids(a.trialDeckCards('ETD02')).filter(id => one.has(id)), ['ESOUL-001']);
});

test('marking a deck adds one of each card plus the picked special card, and nothing from the other deck', () => {
  const a = app();
  const added = a.addTrialDeck('ETD02', 'ETD02-012TSP');
  assert.equal(added.length, 26);
  assert.deepEqual(Object.keys(a.own).filter(id => a.own[id].qty > 0).sort(), OFFICIAL.ETD02.deck.concat('ETD02-012TSP').sort());
  Object.keys(a.own).forEach(id => assert.equal(a.own[id].qty, 1, id));
});

test('marking the same deck again adds nothing, and cards already owned keep their counts', () => {
  const a = app();
  a.changeRaw(a.o('ETD01-004'), 3, 'unknown');
  a.o('ETD01-007').graded.push({ co: 'PSA', g: '10' });
  const first = a.addTrialDeck('ETD01', '');
  assert.equal(first.length, 23);
  assert.equal(a.own['ETD01-004'].qty, 3);
  assert.equal(a.own['ETD01-007'].qty, 0, 'a graded copy counts as owned, so no raw copy is added');
  assert.equal(a.addTrialDeck('ETD01', '').length, 0);
  assert.equal(a.addTrialDeck('ETD01', 'ETD01-012TSR').length, 1, 'the special card can still be added later');
});

test('a special card from the other deck cannot be added through this one', () => {
  const a = app();
  assert.equal(a.addTrialDeck('ETD01', 'ETD02-012TSP').length, 25);
  assert.equal(a.own['ETD02-012TSP'], undefined);
});

test('the Soul card is shared, so marking both decks adds it once', () => {
  const a = app();
  a.addTrialDeck('ETD01', '');
  const second = a.addTrialDeck('ETD02', '');
  assert.equal(second.length, 24);
  assert.equal(a.own['ESOUL-001'].qty, 1);
});

test('each sealed Trial Deck opens its own deck, and nothing else does', () => {
  const a = app();
  assert.equal(a.trialDeckSetOfSealed('td-rb'), 'ETD01');
  assert.equal(a.trialDeckSetOfSealed('td-gp'), 'ETD02');
  assert.equal(a.trialDeckSetOfSealed('box-ebp01'), '');
  assert.equal(a.trialDeckSetOfSealed('td-ea-rg'), '', 'a later deck needs its own checked entry first');
});

test('the dialog copy says one of each, names the collection and uses no dashes', () => {
  const a = app();
  const fresh = a.trialDeckMessage('ETD01', 'Main');
  assert.match(fresh, /24 cards in this deck and its Soul card to Main, one of each/);
  a.addTrialDeck('ETD01', '');
  const after = a.trialDeckMessage('ETD01', 'Main');
  assert.match(after, /already have all 24 cards/);
  [fresh, after, 'Not sure, skip it', 'I own this deck', 'Which special card was in your box?']
    .forEach(t => assert.doesNotMatch(t, /[-–—]/, t));
  const ui = source.slice(source.indexOf('function openTrialDeck'), source.indexOf('function renderMissing'));
  assert.match(ui, /Not sure, skip it/);
  assert.match(source, /data-action="deck">I own this deck</);
  assert.match(source, /Which special card was in your box\?/);
});

test('the sealed Trial Decks say 60 cards, the 50 card deck and the 10 card Soul deck', () => {
  assert.equal((source.match(/sub:"Starter deck · 60 cards"/g) || []).length, 2);
  assert.doesNotMatch(source, /Starter deck · 40 cards/);
});
