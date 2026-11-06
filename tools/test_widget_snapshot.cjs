'use strict';

// Run with: node tools/test_widget_snapshot.cjs
// The snapshot the Android home-screen widget reads. Prices must never reach it in collector mode,
// and a release without an exact day must not become a countdown.
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

function sandbox(over) {
  const sb = Object.assign({
    SETTINGS: { mode: 'trader' },
    SETS: { EBP02: { name: 'Booster · Legends Awaken' } },
    CARDS: [{ id: 'A' }, { id: 'B' }],
    PRICEBOOK: { A: 12, B: 5 },
    PRICEPREV: { A: 10, B: 5 },
    o: (id) => ({ qty: id === 'A' ? 2 : 0 }),
    cardsValue: () => 24,
    sealedValue: () => 6,
    money: (n) => '$' + Number(n).toFixed(2),
    nextHomeReleaseGroup: () => ({ title: 'Legends Awaken', date: 'Dec 5, 2026' }),
    releaseYmd: () => [2026, 12, 5],
    shortReleaseDate: () => '5 Dec',
    closestSetMissingGoal: () => ({ set: 'EBP02', owned: 40, total: 50, percent: 80 }),
    window: {}, Date, Math, String, JSON,
  }, over || {});
  vm.createContext(sb);
  vm.runInContext(appFunction('widgetSnapshot'), sb);
  return sb;
}

test('trader mode carries release, set progress and value with the day move', () => {
  const s = sandbox().widgetSnapshot();
  assert.equal(s.v, 1);
  assert.equal(s.hidePrices, false);
  assert.equal(s.release.title, 'Legends Awaken');
  assert.equal(s.release.target, new Date(2026, 11, 5).getTime());
  assert.equal(s.release.go, 'releases');
  assert.deepEqual([s.set.name, s.set.owned, s.set.total, s.set.pct], ['Booster · Legends Awaken', 40, 50, 80]);
  assert.equal(s.value.text, '$30.00');
  assert.equal(s.value.move, '+$4.00');
  assert.equal(s.value.up, true);
});

test('collector mode (price hiding) leaves every price out', () => {
  const s = sandbox({ SETTINGS: { mode: 'collector' }, cardsValue: () => { throw new Error('priced'); } }).widgetSnapshot();
  assert.equal(s.hidePrices, true);
  assert.equal(s.value, null);
  assert.ok(!JSON.stringify(s).includes('$'));
});

test('a falling market shows a minus move', () => {
  const s = sandbox({ PRICEBOOK: { A: 8, B: 5 } }).widgetSnapshot();
  assert.equal(s.value.move, '-$4.00');
  assert.equal(s.value.up, false);
});

test('a release with no exact day gives no countdown, and no move without prior prices', () => {
  const s = sandbox({ releaseYmd: () => null, PRICEPREV: {} }).widgetSnapshot();
  assert.equal(s.release, null);
  assert.equal(s.value.move, '');
});

test('nothing to show degrades to nulls instead of throwing', () => {
  const s = sandbox({ nextHomeReleaseGroup: () => null, closestSetMissingGoal: () => null }).widgetSnapshot();
  assert.equal(s.release, null);
  assert.equal(s.set, null);
});

test('the snapshot is pushed only through the native bridge, after Home draws', () => {
  assert.match(source, /pushWidgetSnapshot\(\);\n  \}\n  \/\/ Browse-by-set tiles/);
  assert.match(source, /window\.AndroidWidget && typeof window\.AndroidWidget\.update==="function"/);
});

// Native wiring. The widget code cannot be compiled in CI here, so these guard the seams between the
// page, the bridge, the manifest and the allowed pages.
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const MAIN = 'app/src/main/';

test('the bridge name, the manifest receiver and the provider file line up', () => {
  assert.match(read(MAIN + 'java/app/spheredex/MainActivity.kt'), /addJavascriptInterface\(WidgetBridge\(\), "AndroidWidget"\)/);
  const manifest = read(MAIN + 'AndroidManifest.xml');
  assert.match(manifest, /<receiver\s+android:name="\.SphereWidget"\s+android:exported="false">/);
  assert.match(manifest, /android:resource="@xml\/sphere_widget_info"/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', MAIN, 'res/xml/sphere_widget_info.xml')));
});

test('every page the snapshot can ask for is on the native allow list', () => {
  const gos = [...source.slice(source.indexOf('function widgetSnapshot'), source.indexOf('var _widgetTimer'))
    .matchAll(/go:"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(gos.sort(), ['collection', 'portfolio', 'releases']);
  const list = /PAGES = setOf\(([^)]*)\)/.exec(read(MAIN + 'java/app/spheredex/WidgetStore.kt'))[1];
  for (const g of gos) assert.ok(list.includes('"' + g + '"'), g + ' is allowed natively');
});

test('widget copy has no dashes', () => {
  const copy = read(MAIN + 'res/layout/widget_sphere.xml').match(/android:text="([^"]*)"/g).join('\n')
    + (read(MAIN + 'res/values/strings.xml').match(/>([^<]+)<\/string>/g) || []).join('\n') + '\n' + read(MAIN + 'java/app/spheredex/WidgetStore.kt').match(/"[A-Z][^"]*"/g).join('\n');
  assert.doesNotMatch(copy, /[–—]|\w-\w/);
});
