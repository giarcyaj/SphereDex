'use strict';

// Run with: node tools/test_daily_guess.cjs
// The Daily Pal guess on the Rewards page: one hidden card a day, picked deterministically from card data,
// a clue per wrong guess, and a streak kept on the device.
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

const box = {
  Math, Object, String, Array, RegExp, JSON, Date,
  SETS: { S1: { name: 'Booster Alpha' } },
  fold: (s) => String(s == null ? '' : s).toLowerCase(),
  dayKeyAdd: (k, n) => { const d = new Date(k + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); },
};
vm.createContext(box);
const names = ['dailyHash', 'dailyMask', 'dailyClues', 'dailyPool', 'dailyAnswer', 'dailyCorrect', 'dailyKnownName', 'dailyFinish', 'dailyLiveStreak'];
vm.runInContext(names.map(appFunction).join('\n'), box);

const card = (id, name, extra) => Object.assign({ id, base: id, special: false, nameEn: name, name, set: 'S1', color: 'Red', kind: 'Pal', sub: 'Lucky Pal', cost: '4', power: '400', els: ['Fire'], apt: ['Kindling'], keywords: [], rulesEn: 'When Gobfin attacks, draw a card.' }, extra || {});
const cards = [card('A-001', 'Gobfin Ignis'), card('A-002', 'Suzaku'), card('A-003', 'Bushi'), card('A-001SR', 'Gobfin Ignis', { base: 'A-001', special: true })];

test('the same date picks the same card, and a pool has one entry per card number', () => {
  assert.equal(box.dailyPool(cards).length, 3, 'the SR reprint is not a separate card');
  assert.equal(box.dailyAnswer(cards, '2026-11-06').id, box.dailyAnswer(cards.slice().reverse(), '2026-11-06').id, 'input order does not matter');
  const days = new Set(); for (let i = 1; i <= 20; i++) days.add(box.dailyAnswer(cards, '2026-12-' + String(i).padStart(2, '0')).id);
  assert.ok(days.size > 1, 'different days vary');
  assert.equal(box.dailyAnswer([], '2026-11-06'), null);
});

test('clues never give the name away and a sparse card is left out of the pool', () => {
  const clues = box.dailyClues(cards[0]);
  assert.ok(clues.length >= 3 && clues.length <= 6, 'between 3 and 6 clues so each wrong guess unlocks one');
  const text = clues.map((c) => c.text).join(' ');
  assert.doesNotMatch(text, /Gobfin/i, 'the rules text is masked');
  assert.match(text, /___ attacks/);
  assert.equal(box.dailyPool([card('B-1', 'Bare', { set: 'X', els: [], apt: [], cost: '', power: '', rulesEn: '' })]).length, 0);
  assert.doesNotMatch(clues.map((c) => c.label + c.text).join(' ').replace(/Rules text|Colour and type/g, ''), /[‐-―]|-/, 'no dashes in our clue wording');
});

test('guesses match the name ignoring case, and unknown names are not accepted', () => {
  assert.ok(box.dailyCorrect(cards[0], '  gobfin IGNIS '));
  assert.ok(!box.dailyCorrect(cards[0], 'Suzaku'));
  assert.ok(box.dailyKnownName(cards, 'bushi'));
  assert.ok(!box.dailyKnownName(cards, 'Nonsense'));
  assert.ok(!box.dailyKnownName(cards, ''));
});

test('a win on consecutive days grows the streak, a loss or a gap resets it', () => {
  let s = box.dailyFinish({}, '2026-11-01', true);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), { streak: 1, best: 1, wins: 1, played: 1, last: '2026-11-01' });
  s = box.dailyFinish(s, '2026-11-02', true);
  assert.equal(s.streak, 2); assert.equal(s.best, 2);
  assert.equal(box.dailyFinish(s, '2026-11-02', false).streak, 2, 'a day only counts once');
  const lost = box.dailyFinish(s, '2026-11-03', false);
  assert.equal(lost.streak, 0); assert.equal(lost.best, 2);
  assert.equal(box.dailyFinish(lost, '2026-11-04', true).streak, 1);
  assert.equal(box.dailyFinish(s, '2026-11-05', true).streak, 1, 'a missed day starts again');
  assert.equal(box.dailyLiveStreak(s, '2026-11-03'), 2, 'still alive the day after');
  assert.equal(box.dailyLiveStreak(s, '2026-11-05'), 0, 'lapsed after a missed day');
});

test('the game is wired into Rewards and uses no card art', () => {
  assert.match(source, /id="dailyGuess"/);
  assert.match(source, /renderDailyGuess\(\);\s*\n\s*renderSphereThemes\(\);/, 'drawn with the Rewards page');
  const fn = appFunction('renderDailyGuess');
  assert.doesNotMatch(fn, /<img|IMG_BASE|\.pic\b/, 'text clues only');
  const copy = source.slice(source.indexOf('>Daily Pal guess<'), source.indexOf('id="dailyGuess"'));
  assert.doesNotMatch(copy.replace(/<[^>]+>/g, ''), /[-‐-―]/, 'no dashes in the intro copy');
});
