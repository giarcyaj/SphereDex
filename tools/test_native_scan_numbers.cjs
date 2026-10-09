'use strict';

// Run with: node tools/test_native_scan_numbers.cjs
// Card numbers in the native scanners. English prints read EBP01-001; the Japanese print of the same
// card reads BP01-001. Both scanners (Android ScannerActivity.kt + Store.kt, iOS Scanner.swift +
// CardResolver.swift) accept either, resolve a Japanese number to its English card, and hand the web
// app the number without its E so SDScanAdd/readCardNumber opens the Japanese printing.
// Part 1 mirrors the patterns and the resolve fallback in JS and checks them against the real
// catalogue. Part 2 reads the four native files and fails if they drift from the mirror.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const catalogue = JSON.parse(read('app', 'src', 'main', 'assets', 'paldeck_cards.json'));
const NUMBERS = catalogue.cards.map((c) => c.number);

const KT_SCANNER = read('app', 'src', 'main', 'java', 'app', 'spheredex', 'ScannerActivity.kt');
const KT_STORE = read('app', 'src', 'main', 'java', 'app', 'spheredex', 'Store.kt');
const SW_SCANNER = read('ios', 'SphereDex', 'SphereDex', 'Scanner.swift');
const SW_RESOLVER = read('ios', 'SphereDex', 'SphereDex', 'CardResolver.swift');
const SOURCE = read('src', 'paldeck.html');

// ---- the mirror ----

const E_PATTERN = 'E[A-Z]{1,4}\\d{0,2}-?\\d{3}[A-Z]{0,3}';
const JP_PATTERN = '(?<![A-Z0-9])(?:BP\\d{2}|TD\\d{2}|PR|SOUL)-?\\d{3}(?!\\d)[A-Z]{0,3}';
const SPACED_HYPHEN = ' *- *';
const SPACED_RARITY = '(?<=\\d) +(?=[A-Z]{1,3}(?![A-Z0-9]))';
const E_RE = new RegExp(E_PATTERN);
const JP_RE = new RegExp(JP_PATTERN);

// English: every space goes. Japanese: only the spaces around the hyphen and before a rarity tail.
const prep = (text) => String(text).toUpperCase().split(' ').join('');
const prepJp = (text) => String(text).toUpperCase()
  .replace(new RegExp(SPACED_HYPHEN, 'g'), '-').replace(new RegExp(SPACED_RARITY, 'g'), '');
function extractCardNumber(text) { const m = E_RE.exec(prep(text)); return m ? m[0] : null; }
function extractJapaneseCardNumber(text) { const m = JP_RE.exec(prepJp(text)); return m ? m[0] : null; }

const normalize = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const byNormalized = new Map(NUMBERS.map((n) => [normalize(n), n]));
// Store.resolve / CardResolver.resolve: exact normalized match, else the longest stored number the scan begins with.
function resolve(scanned) {
  const s = normalize(scanned);
  if (!s) return null;
  if (byNormalized.has(s)) return byNormalized.get(s);
  let best = null;
  for (const [key, value] of byNormalized) {
    if (key && s.startsWith(key) && (!best || key.length > best.key.length)) best = { key, value };
  }
  return best ? best.value : null;
}
// resolveScan: as read first; a number with no leading E that does not resolve is tried with one.
function resolveScan(scanned) {
  const hit = resolve(scanned);
  if (hit) return { number: hit, japanese: false };
  const s = normalize(scanned);
  if (!s || s.startsWith('E')) return null;
  const jp = resolve('E' + s);
  return jp ? { number: jp, japanese: true } : null;
}
function scannedNumber(raw) {
  const hit = resolveScan(raw);
  if (!hit) return null;
  return hit.japanese ? hit.number.replace(/^E/, '') : hit.number;
}
// English numbers first across every text, then Japanese.
function firstCardNumber(texts) {
  for (const t of texts) { const n = extractCardNumber(t); const v = n && scannedNumber(n); if (v) return v; }
  for (const t of texts) { const n = extractJapaneseCardNumber(t); const v = n && scannedNumber(n); if (v) return v; }
  return null;
}

// The web side: readCardNumber straight from src/paldeck.html, over the same catalogue.
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' is in src/paldeck.html');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
const webCtx = { byNumberIdx: {} };
NUMBERS.forEach((n) => { webCtx.byNumberIdx[n.toUpperCase()] = { id: n }; });
vm.createContext(webCtx);
vm.runInContext(extractFunction(SOURCE, 'readCardNumber'), webCtx);
const readCardNumber = (raw) => JSON.parse(JSON.stringify(webCtx.readCardNumber(raw)));

// ---- part 1: behaviour on the real catalogue ----

test('the catalogue only uses the set code families the Japanese pattern knows', () => {
  for (const n of NUMBERS) {
    const jp = n.slice(1);
    assert.equal(extractJapaneseCardNumber(jp), jp, 'Japanese pattern reads ' + jp + ' (add its set code to both scanners)');
  }
});

test('every English number reads and resolves exactly as before', () => {
  for (const n of NUMBERS) {
    assert.equal(extractCardNumber(n), n);
    assert.equal(extractCardNumber(n.replace('-', '')), n.replace('-', ''));
    assert.deepEqual(resolveScan(n), { number: n, japanese: false });
    assert.equal(firstCardNumber([n]), n);
    assert.equal(extractJapaneseCardNumber(n), null, 'the Japanese pattern never grabs the tail of ' + n);
  }
});

test('every Japanese number resolves to its English card and reaches the web as printed', () => {
  for (const n of NUMBERS) {
    const jp = n.slice(1);
    assert.equal(extractCardNumber(jp), null, 'the English pattern does not read ' + jp);
    assert.deepEqual(resolveScan(jp), { number: n, japanese: true });
    assert.equal(firstCardNumber([jp]), jp);
    assert.deepEqual(readCardNumber(jp), { id: n, edition: 'jp' }, 'the web opens the Japanese printing of ' + n);
    assert.deepEqual(readCardNumber(n), { id: n, edition: '' });
  }
});

test('real Japanese reads, parallels, promos and OCR noise', () => {
  const cases = [
    ['BP01-001', 'BP01-001'],
    ['BP01-001OSR', 'BP01-001OSR'],
    ['bp01-001 osr', 'BP01-001OSR'],
    ['BP01 - 001', 'BP01-001'],
    ['BP01001', 'BP01-001'],               // hyphen lost: the canonical number goes to the web
    ['TD01-012', 'TD01-012'],
    ['PR-001', 'PR-001'],
    ['SOUL-000', 'SOUL-000'],
    ['Chillet BP01-025 RR', 'BP01-025'],
    ['No.01 BP01-025', 'BP01-025'],
    ['BP01-025 RR ©Pocketpair', 'BP01-025'],
    ['ETD01-012', 'ETD01-012'],
    ['EBP01-001OSR', 'EBP01-001OSR'],
    ['EPR-001', 'EPR-001'],
  ];
  for (const [text, want] of cases) assert.equal(firstCardNumber([text]), want, text);
  assert.equal(scannedNumber('BP01-001OSR'), 'BP01-001OSR');
  assert.deepEqual(readCardNumber('BP01-001OSR'), { id: 'EBP01-001OSR', edition: 'jp' });
});

test('an E number wins when both appear, and an E number is never reinterpreted', () => {
  assert.equal(firstCardNumber(['BP01-002 EBP01-001']), 'EBP01-001');
  assert.equal(firstCardNumber(['BP01-002', 'EBP01-001']), 'EBP01-001');
  assert.equal(firstCardNumber(['EBP01-001', 'BP01-002']), 'EBP01-001');
  assert.equal(resolveScan('EBP01-999'), null);
  assert.equal(resolveScan('ETD09-001'), null);
});

test('words, rules text and non cards are not read as Japanese numbers', () => {
  const none = [
    'Deal 100 damage', 'HP 100', 'BP 100', 'BP100', 'BP1-001', 'BP01-0012', 'XBP01-001', '2BP01-001',
    'PRESS 001', 'SUPPORT 001', 'SOULBP01-001', 'TD-001', 'TD1-001', 'PR 12', 'Pocketpair 2025',
  ];
  for (const t of none) assert.equal(extractJapaneseCardNumber(t), null, t);
  assert.equal(firstCardNumber(['BP01-999']), null);
  assert.equal(firstCardNumber(['TD12345']), null);
  assert.equal(firstCardNumber(['Draw 2 cards.', 'Rest 1 Pal.']), null);
});

// ---- part 2: the native code matches the mirror ----

function literal(src, re, what) {
  const m = re.exec(src);
  assert.ok(m, what + ' found');
  return m[1].replace(/\\\\/g, '\\');
}
const squash = (s) => s.replace(/\s+/g, ' ');

test('Android patterns match the mirror', () => {
  assert.equal(literal(KT_SCANNER, /private val CARD_NUMBER = Regex\("((?:[^"\\]|\\.)*)"\)/, 'CARD_NUMBER'), E_PATTERN);
  assert.equal(literal(KT_SCANNER, /private val JP_CARD_NUMBER = Regex\("((?:[^"\\]|\\.)*)"\)/, 'JP_CARD_NUMBER'), JP_PATTERN);
  assert.equal(literal(KT_SCANNER, /private val SPACED_HYPHEN = Regex\("((?:[^"\\]|\\.)*)"\)/, 'SPACED_HYPHEN'), SPACED_HYPHEN);
  assert.equal(literal(KT_SCANNER, /private val SPACED_RARITY = Regex\("((?:[^"\\]|\\.)*)"\)/, 'SPACED_RARITY'), SPACED_RARITY);
  assert.ok(KT_SCANNER.includes('CARD_NUMBER.find(text.uppercase().replace(" ", ""))?.value'), 'English prep unchanged');
  assert.ok(KT_SCANNER.includes('JP_CARD_NUMBER.find(text.uppercase().replace(SPACED_HYPHEN, "-").replace(SPACED_RARITY, ""))?.value'), 'Japanese prep');
});

test('iOS patterns match the mirror', () => {
  assert.equal(literal(SW_SCANNER, /cardNumberRegex = try! NSRegularExpression\(pattern: "((?:[^"\\]|\\.)*)"\)/, 'cardNumberRegex'), E_PATTERN);
  assert.equal(literal(SW_SCANNER, /jpCardNumberRegex = try! NSRegularExpression\(pattern: "((?:[^"\\]|\\.)*)"\)/, 'jpCardNumberRegex'), JP_PATTERN);
  assert.match(SW_SCANNER, /jpCardNumberRegex\.firstMatch/);
  const sw = squash(SW_SCANNER);
  assert.ok(sw.includes('let t = text.uppercased().replacingOccurrences(of: " ", with: "")'), 'English prep unchanged');
  const jpPrep = 'let t = text.uppercased() .replacingOccurrences(of: "' + SPACED_HYPHEN + '", with: "-", options: .regularExpression)'
    + ' .replacingOccurrences(of: "' + SPACED_RARITY.replace(/\\/g, '\\\\') + '", with: "", options: .regularExpression)';
  assert.ok(sw.includes(jpPrep), 'Japanese prep');
});

test('Android resolve fallback and pass order match the mirror', () => {
  const store = squash(KT_STORE);
  assert.ok(store.includes('fun resolveScan(scanned: String): Pair<Card, Boolean>? { resolve(scanned)?.let { return it to false } val s = normalizeNum(scanned) if (s.isEmpty() || s.startsWith("E")) return null return resolve("E$s")?.let { it to true } }'), 'Store.resolveScan');
  const sc = squash(KT_SCANNER);
  const e = sc.indexOf('for (t in texts) { val num = extractCardNumber(t) ?: continue; scannedNumber(num)?.let { return it } }');
  const j = sc.indexOf('for (t in texts) { val num = extractJapaneseCardNumber(t) ?: continue; scannedNumber(num)?.let { return it } }');
  assert.ok(e > 0 && j > e, 'English pass, then Japanese pass');
  assert.ok(sc.includes('return if (japanese) card.number.removePrefix("E") else card.number'), 'Japanese read goes to the web without its E');
  assert.ok(sc.includes('private fun numberFrom(text: Text): String? = firstCardNumber(text.textBlocks.map { it.text })'));
  assert.ok(sc.includes('private fun numberFromLines(lines: List<String>): String? = firstCardNumber(lines)'));
  assert.equal((KT_SCANNER.match(/store\.resolve\(num\)/g) || []).length, 0, 'no caller bypasses resolveScan');
});

test('iOS resolve fallback and pass order match the mirror', () => {
  const res = squash(SW_RESOLVER);
  assert.ok(res.includes('func resolveScan(_ scanned: String) -> (number: String, japanese: Bool)? { if let hit = resolve(scanned) { return (hit, false) } let s = normalize(scanned) if s.isEmpty || s.hasPrefix("E") { return nil } if let hit = resolve("E" + s) { return (hit, true) } return nil }'), 'CardResolver.resolveScan');
  const sc = squash(SW_SCANNER);
  const e = sc.indexOf('for t in texts { if let raw = extractCardNumber(from: t), let num = scannedNumber(raw) { return num } }');
  const j = sc.indexOf('for t in texts { if let raw = extractJapaneseCardNumber(from: t), let num = scannedNumber(raw) { return num } }');
  assert.ok(e > 0 && j > e, 'English pass, then Japanese pass');
  assert.ok(sc.includes('return hit.japanese && hit.number.hasPrefix("E") ? String(hit.number.dropFirst()) : hit.number'), 'Japanese read goes to the web without its E');
  assert.ok(sc.includes('private func numberFromLines(_ lines: [String]) -> String? { firstCardNumber(lines) }'));
  assert.ok(sc.includes('if let card = firstCardNumber(lines) { return card }'), 'recogniseText reads numbers through firstCardNumber');
  assert.equal((SW_SCANNER.match(/extractCardNumber\(from: line\), let card = resolver\.resolve/g) || []).length, 0, 'no caller bypasses resolveScan');
});

test('the web hands any scanned number through readCardNumber', () => {
  const fn = extractFunction(SOURCE, 'scanAddById');
  assert.match(fn, /readCardNumber\(id\)/);
  assert.match(fn, /read\.edition==="jp"\) \? "jp"/);
  assert.match(SOURCE, /window\.SDScanAdd = scanAddById;/);
});
