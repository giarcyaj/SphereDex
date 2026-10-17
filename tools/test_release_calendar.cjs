'use strict';

// Run with: node tools/test_release_calendar.cjs
// Add to calendar on Releases: an exact release day becomes an all day .ics event. A month only
// date gets nothing, because a guessed day in someone's calendar is worse than no entry.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');

function appFunction(name) {
  const m = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(m, 'App function exists: ' + name);
  for (let e = source.indexOf('}', m.index); e >= 0; e = source.indexOf('}', e + 1)) {
    const d = source.slice(m.index, e + 1);
    try { new vm.Script('(' + d + ')'); return d; } catch (_) { /* keep looking */ }
  }
  throw new Error('Could not extract ' + name);
}

const sb = { Date, Math, String, Number, isNaN, RegExp };
vm.createContext(sb);
['monDateTime', 'fileSlug', 'releaseYmd', 'icsEscape', 'icsFold', 'releaseIcs'].forEach((n) => vm.runInContext(appFunction(n), sb));

test('exact dates parse, month only and missing dates do not', () => {
  assert.deepEqual(Array.from(sb.releaseYmd('Jan 29, 2027')), [2027, 1, 29]);
  assert.deepEqual(Array.from(sb.releaseYmd('2026-10-30')), [2026, 10, 30]);
  assert.equal(sb.releaseYmd('Oct 2026'), null);
  assert.equal(sb.releaseYmd('Release date TBA'), null);
  assert.equal(sb.releaseYmd(''), null);
});

test('builds an all day event that ends the next day', () => {
  const ics = sb.releaseIcs('Eternal Ascent release', 'Jan 29, 2027', 'Release day, Palworld TCG.', 'Eternal Ascent');
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20270129\r\n/);
  assert.match(ics, /DTEND;VALUE=DATE:20270130\r\n/);
  assert.match(ics, /SUMMARY:Eternal Ascent release\r\n/);
  assert.match(ics, /DESCRIPTION:Release day\\, Palworld TCG\.\r\n/);
  assert.match(ics, /UID:eternal-ascent-20270129@spheredex\.app\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
});

test('month end rolls over into the next month', () => {
  const ics = sb.releaseIcs('X', 'Dec 31, 2026', '', 'x');
  assert.match(ics, /DTSTART;VALUE=DATE:20261231/);
  assert.match(ics, /DTEND;VALUE=DATE:20270101/);
});

test('no exact date means no file', () => {
  assert.equal(sb.releaseIcs('X', 'Oct 2026', '', 'x'), '');
});

test('long lines fold at 75 characters', () => {
  const ics = sb.releaseIcs('T', 'Jan 29, 2027', 'word '.repeat(60), 't');
  ics.split('\r\n').forEach((l) => assert.ok(l.length <= 75, 'line too long: ' + l.length));
});
