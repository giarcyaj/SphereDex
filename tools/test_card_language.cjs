'use strict';

// Run with: node tools/test_card_language.cjs
// Card language: the printed Japanese name and effect, and what must NOT follow the display language.
//
// The bug this whole feature nearly shipped with is worth naming, because the tests below exist to stop it
// coming back. A third party feed mapped the English promo series onto the Japanese one positionally, and
// the two do not run in step: EPR-001 Lamball carried Flambelle's Japanese name and Flambelle's effect. It
// looks like perfectly good data right up until a Japanese reader sees it. So the bake verifies every card
// against cost, power and strike, and these tests pin the result.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'paldeck.html'), 'utf8');
const ja = JSON.parse(fs.readFileSync(path.join(root, 'src', 'card-text-ja.json'), 'utf8'));
const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'app', 'src', 'main', 'assets', 'paldeck_cards.json'), 'utf8'));
const cards = catalogue.cards || catalogue;

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

const runtime = /var CARD_TEXT_JA = (\{.*?\});\n/s.exec(source);
assert.ok(runtime, 'the generated CARD_TEXT_JA literal is embedded in the app');
const CARD_TEXT_JA = JSON.parse(runtime[1]);

const sandbox = { SETTINGS: { cardLang: 'en' }, CARD_TEXT_JA, CARDS: [] };
vm.createContext(sandbox);
vm.runInContext(
  ['cardLang', 'jaFor', 'applyCardLang', 'readCardNumber', 'fold'].map(appFunction).join('\n'),
  sandbox
);

// Values built inside the vm sandbox are a different realm's objects, so deepEqual on them fails on
// reference identity alone. The other suites round trip through JSON for the same reason.
const plain = (v) => JSON.parse(JSON.stringify(v));
const make = (id, nameEn, rulesEn) => ({ id, name: nameEn, nameEn, rules: rulesEn, rulesEn });

// ---- the data -------------------------------------------------------------------------------------------

test('the Japanese name of a card is the Japanese PAL name, not a translation of the English', () => {
  // Proof the text is the real print rather than something generated: a translator renders Chillet as a
  // reading of "Chillet". The printed Japanese card calls it something else entirely.
  assert.match(ja.cards['EBP01-025SSP'].name, /オコチョ/);
  assert.match(ja.cards['EBP01-001'].name, /アグニドラ/);
  assert.ok(!/Chillet|Jormuntide/i.test(ja.cards['EBP01-025SSP'].name + ja.cards['EBP01-001'].name));
});

test('the promo series is mapped by verification, not by its number', () => {
  // The exact rows a positional mapping gets wrong. EPR-001 is PR-017 in Japan, not PR-001.
  assert.equal(ja.cards['EPR-001'].sourceNumber, 'PR-017');
  assert.equal(ja.cards['EPR-002'].sourceNumber, 'PR-001');
  // Lamball must not be carrying Flambelle's name, which is what the naive mapping produced.
  assert.notEqual(ja.cards['EPR-001'].name, ja.cards['EPR-002'].name);
});

test('two different cards never share a Japanese name unless they are the same card', () => {
  const byName = new Map();
  for (const [num, entry] of Object.entries(ja.cards)) {
    if (!byName.has(entry.name)) byName.set(entry.name, []);
    byName.get(entry.name).push(num);
  }
  const english = new Map(cards.map((c) => [c.number, c.name]));
  for (const [jaName, numbers] of byName) {
    if (numbers.length < 2) continue;
    // The one real exception, confirmed against the publisher's own list: every Japanese Soul card prints
    // the single name ソウル whatever Pals are illustrated on it, so different English Souls share it.
    if (numbers.every((n) => n.startsWith('ESOUL'))) continue;
    const names = new Set(numbers.map((n) => english.get(n)));
    assert.equal(names.size, 1,
      'cards sharing the Japanese name ' + jaName + ' must be the same card, got ' + [...names].join(' / '));
  }
});

test('the Soul exception is exactly that, an exception, and does not leak past the Souls', () => {
  // If a non Soul card ever ends up carrying ソウル, the exemption above would hide it. It must not.
  for (const [num, entry] of Object.entries(ja.cards)) {
    if (entry.name === 'ソウル') assert.ok(num.startsWith('ESOUL'), num + ' is a Soul');
  }
});

test('every entry records how it was resolved, so a mapping can be audited later', () => {
  for (const [num, entry] of Object.entries(ja.cards)) {
    assert.ok(entry.match, num + ' records how it resolved');
    assert.ok(entry.sourceNumber, num + ' records which Japanese card it came from');
  }
});

test('the runtime copy embedded in the app matches the committed data', () => {
  for (const [num, entry] of Object.entries(ja.cards)) {
    assert.equal(CARD_TEXT_JA[num].n, entry.name, num + ' name matches');
    assert.equal(CARD_TEXT_JA[num].t || '', entry.text || '', num + ' text matches');
  }
  assert.equal(Object.keys(CARD_TEXT_JA).length, Object.keys(ja.cards).length);
});

// ---- the behaviour --------------------------------------------------------------------------------------

test('switching to Japanese swaps the displayed name and effect, and switching back restores them', () => {
  const c = make('EBP01-001', 'Jormuntide Ignis', 'Stand this card.');
  sandbox.CARDS = [c];
  sandbox.SETTINGS.cardLang = 'ja';
  sandbox.applyCardLang();
  assert.equal(c.name, CARD_TEXT_JA['EBP01-001'].n);
  assert.equal(c.rules, CARD_TEXT_JA['EBP01-001'].t);
  sandbox.SETTINGS.cardLang = 'en';
  sandbox.applyCardLang();
  assert.equal(c.name, 'Jormuntide Ignis');
  assert.equal(c.rules, 'Stand this card.');
});

test('a card with no Japanese print keeps its English name instead of going blank', () => {
  // ESOUL-004 has no Japanese record at all. A blank name would be worse than an English one.
  assert.equal(ja.cards['ESOUL-004'], undefined);
  const c = make('ESOUL-004', 'Soul', '');
  sandbox.CARDS = [c];
  sandbox.SETTINGS.cardLang = 'ja';
  sandbox.applyCardLang();
  assert.equal(c.name, 'Soul');
  sandbox.SETTINGS.cardLang = 'en';
});

test('the English name survives on the card, so sorting and the card sheet always have it', () => {
  const c = make('EBP01-001', 'Jormuntide Ignis', '');
  sandbox.CARDS = [c];
  sandbox.SETTINGS.cardLang = 'ja';
  sandbox.applyCardLang();
  assert.equal(c.nameEn, 'Jormuntide Ignis');
  assert.ok(c.nameJa);
  sandbox.SETTINGS.cardLang = 'en';
});

test('sorting reads the English name, so changing language never reorders a list', () => {
  assert.match(source, /if \(s==="name"\) return \(a\.nameEn\|\|a\.name\)\.localeCompare\(b\.nameEn\|\|b\.name\)/);
  assert.match(source, /name:function\(a,b\)\{ return \(a\.nameEn\|\|a\.name\)\.localeCompare\(b\.nameEn\|\|b\.name\); \}/);
});

test('search still matches the English name while Japanese is on display, and matches the Japanese too', () => {
  const body = appFunction('cardMatchesQuery');
  assert.match(body, /c\.nameEn && fold\(c\.nameEn\)/);
  assert.match(body, /c\.nameJa &&/);
});

test('Japanese text is marked as Japanese, so kanji do not render with another region glyphs', () => {
  assert.match(source, /class="rulestext"'\+\(jaNow\?' lang="ja"':''\)/);
  assert.match(source, /id="mTitle"'\+\(\(typeof cardLang==="function" && cardLang\(\)==="ja" && c\.nameJa\)\?' lang="ja"':''\)/);
});

// ---- the scanner ----------------------------------------------------------------------------------------

test('a scanned English number resolves with no edition, as it always did', () => {
  sandbox.byNumberIdx = {};
  cards.forEach((c) => { sandbox.byNumberIdx[c.number.toUpperCase()] = { id: c.number }; });
  assert.deepEqual(plain(sandbox.readCardNumber('EBP01-001')), { id: 'EBP01-001', edition: '' });
  assert.deepEqual(plain(sandbox.readCardNumber(' ebp01-025ssp ')), { id: 'EBP01-025SSP', edition: '' });
});

test('a scanned JAPANESE number resolves to the same card and reports the edition', () => {
  // This is the whole point: a Japanese card prints BP01-001 where the English one prints EBP01-001, every
  // catalogue id carries the E, so before this a Japanese card matched nothing and the scan simply failed.
  assert.deepEqual(plain(sandbox.readCardNumber('BP01-001')), { id: 'EBP01-001', edition: 'jp' });
  assert.deepEqual(plain(sandbox.readCardNumber('BP01-025SSP')), { id: 'EBP01-025SSP', edition: 'jp' });
  assert.deepEqual(plain(sandbox.readCardNumber('TD01-001')), { id: 'ETD01-001', edition: 'jp' });
});

test('a number that is not a card at all stays unrecognised rather than guessing', () => {
  assert.equal(sandbox.readCardNumber('ZZ99-999'), null);
  assert.equal(sandbox.readCardNumber(''), null);
  assert.equal(sandbox.readCardNumber(null), null);
  assert.equal(sandbox.readCardNumber('BP99-001'), null);
});

test('the English reading is never reinterpreted as Japanese', () => {
  // Stripping or adding an E must only ever happen when the plain lookup failed, or an English card could
  // be tagged as a Japanese copy and quietly valued as the wrong printing.
  for (const c of cards) {
    const read = sandbox.readCardNumber(c.number);
    assert.equal(read.edition, '', c.number + ' is an English print');
  }
});

test('a saved Japanese preference applies on load, not only when the setting is touched', () => {
  // The card text is attached hundreds of lines before SETTINGS is assigned, so the applyCardLang inside
  // attachCardText always reads the default. Without a second call once the stored settings exist, a person
  // who chose Japanese saw English every time they opened the app until they went and changed it again.
  const attach = source.indexOf('attachCardText();');
  const settings = source.indexOf('var SETTINGS = (function()');
  assert.ok(attach > 0 && settings > attach, 'settings really are loaded after the card text is attached');
  const after = source.indexOf('\n  applyCardLang();', settings);
  assert.ok(after > settings, 'applyCardLang runs again once SETTINGS exists');
});
