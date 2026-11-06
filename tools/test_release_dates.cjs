'use strict';

// Release dates for Eternal Ascent. The EN booster moved from 29 Jan 2027 to 30 Jan 2027.
// Trial decks stay 18 Dec 2026. A stale sweep row must not put the booster back, and an
// uncoded duplicate must not become a second product.
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONIX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function releaseSandbox(sealed, expansions) {
  const store = {};
  const sb = {
    SEALED: sealed,
    BROWSE_EXPANSIONS: expansions,
    RELEASE_OVERRIDES: {},
    MONTHS, _MONIX: MONIX,
    Date, Math, isNaN, isFinite, Number, String, JSON,
    decodeEntities: (x) => String(x == null ? '' : x),
    apiBase: () => '',
    lsGet: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    lsSet: (k, v) => { store[k] = String(v); },
    window: {}
  };
  vm.createContext(sb);
  vm.runInContext([
    'monDateTime', 'releaseDayTime', 'sealKind', 'sealDate', 'sealPreRaw', 'asofMs', 'adoptServerDate',
    'releaseAlias', 'relNews', 'applyReleases', 'parseNewsDate', 'buildReleaseOverrides'
  ].map(appFunction).join('\n'), sb);
  return sb;
}

function baked() {
  return [
    { id: 'td-ea-rg', set: 'Eternal Ascent', name: 'Trial Deck, Red · Green', code: 'TD03', pre: true, date: 'Dec 18, 2026', nk: ['TD03', 'Red・Green'] },
    { id: 'td-ea-bp', set: 'Eternal Ascent', name: 'Trial Deck, Blue · Purple', code: 'TD04', pre: true, date: 'Dec 18, 2026', nk: ['TD04', 'Blue・Purple'] },
    { id: 'box-bp03', set: 'Eternal Ascent', name: 'Booster Box', code: 'BP03', pre: true, date: 'Jan 30, 2027', banner: 'BOX_BANNER_BP03', nk: ['BP03', 'Eternal Ascent'], link: 'https://en.palworld-official-cardgame.com/news/post-15', srcAt: '2026-11-06T03:13:14Z' },
    { id: 'pack-bp03', set: 'Eternal Ascent', name: 'Booster Pack', pre: true, date: 'Jan 30, 2027', nk: ['BP03', 'Eternal Ascent'], link: 'https://en.palworld-official-cardgame.com/news/post-15', srcAt: '2026-11-06T03:13:14Z' },
    { id: 'box-bp02', set: 'Legends Awaken', name: 'Booster Box', code: 'BP02', pre: true, date: 'Oct 30, 2026', nk: ['Legends Awaken'] }
  ];
}

const DELAY = 'Notice of Release Date Delay for Booster Pack "Eternal Ascent" The booster was originally scheduled for release on Friday, January 29, 2027. (Before) Scheduled for release on Friday, January 29, 2027 (After) Scheduled for release on Saturday, January 30, 2027';
const MIXED = 'Trial Deck "Eternal Ascent Red・Green" release date December 18, 2026. Booster Pack Eternal Ascent release date January 30, 2027.';

test('a delay notice adopts 30 Jan and a mixed post does not give the booster the trial deck day', () => {
  const sb = releaseSandbox(baked(), []);
  const box = sb.SEALED.filter((p) => p.id === 'box-bp03')[0];
  const deck = sb.SEALED.filter((p) => p.id === 'td-ea-rg')[0];
  assert.equal(sb.parseNewsDate(DELAY, '2026-11-06', box), 'Jan 30, 2027');
  assert.equal(sb.parseNewsDate(MIXED, '2026-11-06', box), 'Jan 30, 2027');
  assert.equal(sb.parseNewsDate(MIXED, '2026-11-06', deck), 'Dec 18, 2026');
  // One date, unchanged: the first day in the item.
  assert.equal(sb.parseNewsDate('Sleeve set will ship October 16, 2026', '2026-10-01', { name: '', nk: ['Card Set Vol'] }), 'Oct 16, 2026');
});

test('news keeps the booster on 30 Jan when a trial deck post is newer', () => {
  // Live /api/news on 6 Nov led with the trial deck post. It names the set and only 18 Dec.
  // The booster post is the next item. Newest match must not borrow the trial deck day.
  const sealed = baked();
  const sb = releaseSandbox(sealed, []);
  const changed = sb.buildReleaseOverrides([
    { date: '2026-11-06', title: 'Trial Decks Eternal Ascent', summary: 'Trial Decks Eternal Ascent Red・Green and Blue・Purple descend into stores on December 18! Preorder at your local game store.' },
    { date: '2026-11-06', title: 'Booster Pack Eternal Ascent', summary: 'Booster Pack Eternal Ascent arrives in stores on January 30, 2027!' },
    { date: '2026-11-06', title: 'Delay', summary: DELAY }
  ]);
  assert.equal(changed, true);
  assert.equal(sb.RELEASE_OVERRIDES['box-bp03'], 'Jan 30, 2027');
  assert.equal(sb.RELEASE_OVERRIDES['pack-bp03'], 'Jan 30, 2027');
  assert.equal(sb.RELEASE_OVERRIDES['td-ea-rg'], 'Dec 18, 2026');
  assert.equal(sb.RELEASE_OVERRIDES['td-ea-bp'], 'Dec 18, 2026');
  assert.equal(sb.RELEASE_OVERRIDES['box-bp02'], undefined);
});

test('a headline correction to an earlier day is the new day, not the original one', () => {
  // Synthetic. Not an Eternal Ascent date. The corrected day is earlier than the day it replaces.
  const sb = releaseSandbox(baked(), []);
  const box = sb.SEALED.filter((p) => p.id === 'box-bp03')[0];
  const text = 'Booster Pack "Sample Set" release date corrected to March 2, 2027, instead of the original date of June 20, 2027.';
  assert.equal(sb.parseNewsDate(text, '2026-10-01', box), 'Mar 2, 2027');
});

test('a stale earlier sweep date and an uncoded duplicate do not move the baked booster', () => {
  const sealed = baked();
  const expansions = [{ name: 'Eternal Ascent', upcoming: true, release: 'Dec 18, 2026', logo: 'LOGO_BP03' }];
  const sb = releaseSandbox(sealed, expansions);
  const changed = sb.applyReleases({
    version: 1793951111865,
    products: [
      { id: 'box-bp03', set: 'Eternal Ascent', name: 'Booster Box', code: 'BP03', date: 'Jan 29, 2027', link: 'https://en.palworld-official-cardgame.com/news/post-10' },
      { id: 'pack-bp03', set: 'Eternal Ascent', name: 'Booster Pack', date: 'Jan 29, 2027' },
      { id: 'box-eternal-ascent', set: 'Eternal Ascent', name: 'Booster Box', date: 'Dec 18, 2026' },
      { id: 'pack-eternal-ascent', set: 'Eternal Ascent', name: 'Booster Pack', date: 'Dec 18, 2026' }
    ],
    sets: { 'Eternal Ascent': { logo: '', release: 'Jan 29, 2027' } }
  });
  assert.equal(changed, false);
  assert.equal(sealed.map((p) => p.id).join(','), 'td-ea-rg,td-ea-bp,box-bp03,pack-bp03,box-bp02');
  assert.equal(sealed.filter((p) => p.id === 'box-bp03')[0].date, 'Jan 30, 2027');
  assert.equal(sealed.filter((p) => p.id === 'pack-bp03')[0].date, 'Jan 30, 2027');
  assert.equal(sealed.filter((p) => p.id === 'td-ea-rg')[0].date, 'Dec 18, 2026');
  assert.equal(sealed.filter((p) => p.id === 'box-bp02')[0].date, 'Oct 30, 2026');
  assert.equal(expansions[0].release, 'Dec 18, 2026', 'an existing expansion keeps its first street date');
});

test('a newer announcement moves the day in either direction, and an older source does not', () => {
  const sealed = baked();
  const sb = releaseSandbox(sealed, [{ name: 'Eternal Ascent', upcoming: true, release: 'Dec 18, 2026', logo: '' }]);
  // Synthetic later delay. The clock is newer than post-15, so the later day applies.
  sb.applyReleases({
    version: 2,
    products: [
      { id: 'box-bp03', set: 'Eternal Ascent', name: 'Booster Box', code: 'BP03', date: 'Feb 6, 2027', asOf: '2026-12-01T00:00:00Z', link: 'https://en.example/later' },
      { id: 'pack-bp03', set: 'Eternal Ascent', name: 'Booster Pack', date: 'Feb 6, 2027', asOf: '2026-12-01T00:00:00Z', link: 'https://en.example/later' }
    ]
  });
  assert.equal(sealed.filter((p) => p.id === 'box-bp03')[0].date, 'Feb 6, 2027');
  // Synthetic earlier correction, newer again than the delay above.
  sb.applyReleases({
    version: 3,
    products: [
      { id: 'box-bp03', set: 'Eternal Ascent', name: 'Booster Box', code: 'BP03', date: 'Jan 15, 2027', asOf: '2027-01-02T00:00:00Z', link: 'https://en.example/earlier' },
      { id: 'pack-bp03', set: 'Eternal Ascent', name: 'Booster Pack', date: 'Jan 15, 2027', asOf: '2027-01-02T00:00:00Z', link: 'https://en.example/earlier' }
    ]
  });
  assert.equal(sealed.filter((p) => p.id === 'box-bp03')[0].date, 'Jan 15, 2027');
  assert.equal(sealed.filter((p) => p.id === 'td-ea-rg')[0].date, 'Dec 18, 2026');
  // The original preorder is older and has no asOf. It must not undo the correction.
  sb.applyReleases({
    version: 4,
    products: [
      { id: 'box-bp03', set: 'Eternal Ascent', name: 'Booster Box', code: 'BP03', date: 'Jan 29, 2027', link: 'https://en.palworld-official-cardgame.com/news/post-10' }
    ]
  });
  assert.equal(sealed.filter((p) => p.id === 'box-bp03')[0].date, 'Jan 15, 2027');
});

test('the same URL without asOf cannot roll back a stamped day, and a stamped edit can', () => {
  const sealed = baked();
  const sb = releaseSandbox(sealed, [{ name: 'Eternal Ascent', upcoming: true, release: 'Dec 18, 2026', logo: '' }]);
  const link = 'https://en.palworld-official-cardgame.com/news/post-15';
  sb.applyReleases({
    version: 2,
    products: [
      { id: 'box-bp03', set: 'Eternal Ascent', name: 'Booster Box', code: 'BP03', date: 'Jan 29, 2027', link: link },
      { id: 'pack-bp03', set: 'Eternal Ascent', name: 'Booster Pack', date: 'Jan 29, 2027', link: link }
    ]
  });
  assert.equal(sealed.filter((p) => p.id === 'box-bp03')[0].date, 'Jan 30, 2027');
  assert.equal(sealed.filter((p) => p.id === 'box-bp03')[0].srcAt, '2026-11-06T03:13:14Z');
  // Naive site-local time is not a revision.
  sb.applyReleases({
    version: 3,
    products: [
      { id: 'box-bp03', set: 'Eternal Ascent', name: 'Booster Box', code: 'BP03', date: 'Jan 20, 2027', asOf: '2026-12-01T00:00:00', link: link }
    ]
  });
  assert.equal(sealed.filter((p) => p.id === 'box-bp03')[0].date, 'Jan 30, 2027');
  sb.applyReleases({
    version: 4,
    products: [
      { id: 'box-bp03', set: 'Eternal Ascent', name: 'Booster Box', code: 'BP03', date: 'Jan 20, 2027', asOf: '2026-12-01T00:00:00Z', link: link },
      { id: 'pack-bp03', set: 'Eternal Ascent', name: 'Booster Pack', date: 'Jan 20, 2027', asOf: '2026-12-01T00:00:00Z', link: link },
      { id: 'box-newset', set: 'Brand New', name: 'Booster Box', code: 'BP09', date: 'Mar 1, 2027' }
    ],
    sets: { 'Brand New': { release: 'Mar 1, 2027', logo: '' } }
  });
  assert.equal(sealed.filter((p) => p.id === 'box-bp03')[0].date, 'Jan 20, 2027');
  assert.equal(sealed.filter((p) => p.id === 'pack-bp03')[0].date, 'Jan 20, 2027');
  assert.equal(sealed.filter((p) => p.id === 'td-ea-rg')[0].date, 'Dec 18, 2026');
  assert.ok(sealed.some((p) => p.id === 'box-newset' && p.date === 'Mar 1, 2027'));
  assert.equal(sb.BROWSE_EXPANSIONS.filter((x) => x.name === 'Eternal Ascent')[0].release, 'Dec 18, 2026');
  assert.equal(sb.BROWSE_EXPANSIONS.filter((x) => x.name === 'Brand New')[0].release, 'Mar 1, 2027');
});

test('an unstamped legacy product still accepts an unstamped feed day', () => {
  const sealed = baked();
  const sb = releaseSandbox(sealed, []);
  sb.applyReleases({
    version: 2,
    products: [
      { id: 'box-bp02', set: 'Legends Awaken', name: 'Booster Box', code: 'BP02', date: 'Nov 2, 2026' }
    ]
  });
  assert.equal(sealed.filter((p) => p.id === 'box-bp02')[0].date, 'Nov 2, 2026');
  assert.equal(sealed.filter((p) => p.id === 'box-bp02')[0].srcAt, undefined);
  assert.equal(sealed.filter((p) => p.id === 'box-bp03')[0].date, 'Jan 30, 2027');
});
