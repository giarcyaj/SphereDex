'use strict';

// Run with: node --test tools/test_trial_deck.cjs
// "I own this deck": marking a Trial Deck as owned adds exactly what is in that box. Exercises the real app
// functions from src/paldeck.html against the real card table, without a DOM or user data.
// The cards are Bushiroad's official card list for each product (manage/card-list-user/list?expansion=ETD01 and
// ETD02, read 28 Oct 2026): 24 deck cards and the ESOUL-001 Soul card, plus one TSR or TSP. The copies are a box
// opened at the official media event and photographed card by card (HOBBY Watch, 2121126, pal_72 and pal_31):
// 22 cards at two and two at three, ten Soul cards, and the special card in place of one normal copy.
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
  vm.runInContext(source.slice(start, stop) + '\n' + appConstant('SETS') + '\n' + appConstant('SET_ORDER') + '\n' +
    appConstant('BASE_RARE') + '\n' + appFunction('mkCard') + '\n' +
    'var CARDS = RAW.map(function(a){ return mkCard(a,"EBP01"); }).concat(RAW2.map(function(a){ return mkCard(a, a[12]); }));\n' +
    appConstant('RAW_KNOWN') + '\n' + appConstant('TRIAL_DECKS') + '\n' +   // RAW_KNOWN's line also declares RAW_LANGS
    ['o', 'has', 'copiesOf', 'rawCount', 'rawEditionKey', 'rawCounts', 'rawKnownTotal', 'setRawCounts', 'changeRaw',
      'trialDeckSetOfSealed', 'trialDeckCards', 'trialDeckSpecials', 'trialDeckCount', 'trialDeckHeld', 'trialDeckFamilyHeld',
      'trialDeckComplete', 'addTrialDeck', 'trialDeckMessage']
      .map(appFunction).join('\n') + '\n' +
    'function defaultEditionFor(){ return null; }', box);
  return box;
}

const range = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + String(i + 1).padStart(3, '0'));
const OFFICIAL = {
  ETD01: {
    deck: range('ETD01-', 24).concat('ESOUL-001'),
    threes: ['ETD01-005', 'ETD01-013'],   // Arsox, Jolthog Cryst
    kinds: { Pal: 34, Gear: 4, Event: 4, Structure: 8 },
    specials: ['ETD01-001TSP', 'ETD01-001TSR', 'ETD01-005TSR', 'ETD01-007TSR', 'ETD01-008TSR', 'ETD01-011TSR', 'ETD01-012TSP',
      'ETD01-012TSR', 'ETD01-014TSR', 'ETD01-017TSR', 'ETD01-018TSR', 'ETD01-022TSR', 'ETD01-023TSR', 'ETD01-024TSR'],
  },
  ETD02: {
    deck: range('ETD02-', 24).concat('ESOUL-001'),
    threes: ['ETD02-005', 'ETD02-013'],   // Eikthyrdeer Terra, Hoocrates
    kinds: { Pal: 34, Gear: 4, Event: 6, Structure: 6 },
    specials: ['ETD02-001TSP', 'ETD02-001TSR', 'ETD02-003TSR', 'ETD02-006TSR', 'ETD02-007TSR', 'ETD02-008TSR', 'ETD02-012TSP',
      'ETD02-012TSR', 'ETD02-014TSR', 'ETD02-016TSR', 'ETD02-018TSR', 'ETD02-021TSR', 'ETD02-023TSR', 'ETD02-024TSR'],
  },
};
const ids = list => Array.from(list, c => c.id).sort();
const held = (a, id) => (a.own[id] ? a.copiesOf(a.own[id]) : 0);
const total = a => Object.keys(a.own).reduce((n, id) => n + held(a, id), 0);

for (const k of Object.keys(OFFICIAL)) {
  test(k + ' lists exactly the official cards and offers exactly its special cards', () => {
    const a = app();
    assert.deepEqual(ids(a.trialDeckCards(k)), OFFICIAL[k].deck.slice().sort());
    assert.deepEqual(ids(a.trialDeckSpecials(k)), OFFICIAL[k].specials.slice().sort());
    assert.ok(Array.from(a.trialDeckSpecials(k)).every(c => c.rare === 'TSR' || c.rare === 'TSP'));
  });

  test(k + ' holds 50 cards and 10 Soul cards, two of each except its two at three, and the press totals per type', () => {
    const a = app();
    const kinds = {};
    let main = 0;
    Array.from(a.trialDeckCards(k)).forEach(c => {
      const n = a.trialDeckCount(k, c);
      if (c.id === 'ESOUL-001') { assert.equal(n, 10); return; }
      assert.equal(n, OFFICIAL[k].threes.includes(c.id) ? 3 : 2, c.id);
      main += n; kinds[c.kind] = (kinds[c.kind] || 0) + n;
    });
    assert.equal(main, 50);
    assert.deepEqual(kinds, OFFICIAL[k].kinds);
  });
}

test('the two decks share nothing but the Soul card', () => {
  const a = app();
  const one = new Set(ids(a.trialDeckCards('ETD01')));
  assert.deepEqual(ids(a.trialDeckCards('ETD02')).filter(id => one.has(id)), ['ESOUL-001']);
});

test('marking a deck without a special card adds the whole box, 60 cards at the box counts', () => {
  const a = app();
  assert.equal(a.addTrialDeck('ETD01', ''), 60);
  assert.equal(total(a), 60);
  assert.equal(held(a, 'ETD01-005'), 3);
  assert.equal(held(a, 'ETD01-013'), 3);
  assert.equal(held(a, 'ETD01-007'), 2);
  assert.equal(held(a, 'ESOUL-001'), 10);
});

test('the special card takes the place of one normal copy, so the box is still 60 cards', () => {
  const a = app();
  assert.equal(a.addTrialDeck('ETD01', 'ETD01-007TSR'), 60);
  assert.equal(held(a, 'ETD01-007'), 1);
  assert.equal(held(a, 'ETD01-007TSR'), 1);
  assert.equal(total(a), 60);
  const b = app();
  b.addTrialDeck('ETD02', 'ETD02-012TSP');
  assert.equal(held(b, 'ETD02-012'), 1);
  assert.equal(held(b, 'ETD02-012TSP'), 1);
  assert.equal(held(b, 'ETD02-012TSR'), 0);
});

test('marking the same deck again adds nothing, and the Soul cards stay at ten', () => {
  const a = app();
  a.addTrialDeck('ETD02', 'ETD02-003TSR');
  assert.equal(a.addTrialDeck('ETD02', 'ETD02-003TSR'), 0);
  assert.equal(a.addTrialDeck('ETD02', ''), 0);
  assert.equal(held(a, 'ESOUL-001'), 10);
});

test('cards already held are topped up to the box count, never lowered or doubled, graded copies included', () => {
  const a = app();
  a.changeRaw(a.o('ETD01-005'), 1, 'unknown');   // one Arsox already scanned
  a.changeRaw(a.o('ETD01-004'), 5, 'unknown');   // five Foxparks from elsewhere
  a.o('ETD01-002').graded.push({ co: 'PSA', g: '10' });   // one Jolthog in a slab
  const added = a.addTrialDeck('ETD01', '');
  assert.equal(held(a, 'ETD01-005'), 3);
  assert.equal(held(a, 'ETD01-004'), 5);
  assert.equal(held(a, 'ETD01-002'), 2);
  assert.equal(a.own['ETD01-002'].qty, 1, 'one raw copy beside the slab');
  assert.equal(added, 60 - 1 - 2 - 1);
});

test('both decks give twenty Soul cards, because each box has its own ten', () => {
  const a = app();
  a.addTrialDeck('ETD01', '');
  assert.equal(a.addTrialDeck('ETD02', ''), 60);
  assert.equal(held(a, 'ESOUL-001'), 20);
});

test('a special card from the other deck cannot be added through this one', () => {
  const a = app();
  assert.equal(a.addTrialDeck('ETD01', 'ETD02-012TSP'), 60);
  assert.equal(a.own['ETD02-012TSP'], undefined);
  assert.equal(held(a, 'ETD01-012'), 2);
});

test('each sealed Trial Deck opens its own deck, and nothing else does', () => {
  const a = app();
  assert.equal(a.trialDeckSetOfSealed('td-rb'), 'ETD01');
  assert.equal(a.trialDeckSetOfSealed('td-gp'), 'ETD02');
  assert.equal(a.trialDeckSetOfSealed('box-ebp01'), '');
  assert.equal(a.trialDeckSetOfSealed('td-ea-rg'), '', 'a later deck needs its own checked entry first');
});

test('the dialog shows the box counts on page one and the special card on page two, with no dashes in its copy', () => {
  const a = app();
  const fresh = a.trialDeckMessage('ETD01', 'Main');
  assert.match(fresh, /these 50 cards and 10 Soul cards\. They are added to Main/);
  assert.doesNotMatch(fresh, /already have/);
  a.changeRaw(a.o('ETD01-001'), 1, 'unknown');
  const some = a.trialDeckMessage('ETD01', 'Main');
  assert.match(some, /topped up to the count in the box and nothing is counted twice/);
  const ui = source.slice(source.indexOf('function openTrialDeck'), source.indexOf('function renderMissing'));
  assert.match(ui, /class="doqty">×'\+n\+'/, 'page one shows the copies under each card');
  assert.match(ui, /ok\.textContent = n===1 \? "Next" : "Add deck"/);
  assert.match(ui, /back\.textContent = n===1 \? "Cancel" : "Back"/);
  const page2 = /"(One card in every box is a special printing[^"]*)"/.exec(ui)[1];
  [fresh, some, page2, 'Not sure, skip it', 'I own this deck', 'Which special card was in your box?']
    .forEach(t => assert.doesNotMatch(t, /[-–—]/, t));
  assert.match(source, /data-action="deck">I own this deck</);
  assert.match(source, /id="deckOwnList"/);
  assert.match(source, /id="deckOwnStep2" hidden/);
});

test('the sealed Trial Decks say 60 cards, the 50 card deck and the 10 card Soul deck', () => {
  assert.equal((source.match(/sub:"Starter deck · 60 cards"/g) || []).length, 2);
  assert.doesNotMatch(source, /Starter deck · 40 cards/);
});
