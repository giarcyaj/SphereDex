'use strict';

// Run with: node tools/test_account_sync.cjs
// Accounts on one phone, follows saved to the account, and the account settings merge (2.4.2).
//
// Three layers:
//  1. Static guards on startup ordering. 2.4.1 shipped a BLANK app because a top level statement read a var
//     that was only assigned further down, so where the new startup code sits is checked, not assumed.
//  2. Unit tests of the real merge functions, extracted from src/paldeck.html.
//  3. Whole flows (sign in, switch accounts, sign out, sync, crash mid switch) driven through the REAL
//     functions in a vm sandbox, against a fake server, a fake localStorage and a virtual clock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'paldeck.html'), 'utf8');

function appFunction(name) {
  const m = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(m, 'App function exists: ' + name);
  for (let e = source.indexOf('}', m.index); e >= 0; e = source.indexOf('}', e + 1)) {
    const d = source.slice(m.index, e + 1);
    try { new vm.Script('(' + d + ')'); return d; } catch (_) { /* keep looking */ }
  }
  throw new Error('Could not extract ' + name);
}
function bodyOf(name) { const f = appFunction(name); return f.slice(f.indexOf('{') + 1, f.length - 1); }
// Comments and string literals are left out, so prose such as "will not let the app save" is not code.
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
const NEW_FUNCS = ['hasOwn', 'alertAt', 'alertEntOk', 'canonEnt', 'alertWins', 'mergeAlertMap', 'mergeAlerts', 'canonAlerts',
  'sameAlerts', 'alertGC', 'alertRec', 'alertStamp', 'paKey', 'stockOnList', 'priceOnList', 'sentPriceAlerts', 'priceAlertByKey',
  'notifPairs', 'paintNotifSwitches', 'alertsChanged', 'migrateDeviceAlerts', 'removePriceAlertKey', 'acctBase', 'setAcctBase',
  'mergeAcct', 'sameAcct', 'colHasCards', 'localHasData', 'colHolds', 'repaintAll', 'sessionStarted', 'whenSynced',
  'finishSignOut', 'localOk', 'deriveLocal', 'loc', 'writeStateRaw', 'freshState', 'readStash', 'writeStash', 'stashKeys',
  'trimStashes', 'personPart', 'applyPerson', 'maskEmail', 'switchOwner', 'beginSession', 'bootAccounts', 'joinLegacyIfOurs',
  'joinLegacy', 'deleteAccountDone'];
const CHANGED_FUNCS = ['normTop', 'save', 'syncPushPrefs', 'stockAlertOn', 'toggleStockAlert', 'stockAlertBtn', 'priceWatch',
  'addPriceAlert', 'removePriceAlertAt', 'renderPriceAlertList', 'openPriceAlert', 'accountSettingsBlob', 'saveAuth', 'api',
  'localHasCards', 'mergeCol', 'mergeStates', 'adoptRemote', 'pullState', 'pushCloud', 'doAuth', 'signOut',
  'handleSessionExpired', 'renderAccountSettings', 'renderAccount', 'onWake'];

// ==== 1. startup ordering and other static guards ===========================================================
const AUTH_AT = source.indexOf('  var AUTH = (function(){');
const DIRTY_LINE = '  if(AUTH.token && AUTH.dirty===undefined){ AUTH.dirty=true; saveAuth(); }\n';
const BOOT_CALL = /\n  try\{ bootAccounts\(\); \}catch\(e\)\{[^\n]*\n/;

test('bootAccounts runs once, right after the AUTH block, inside a try that ends the session on failure', () => {
  assert.ok(AUTH_AT > 0);
  const dirtyAt = source.indexOf(DIRTY_LINE);
  assert.ok(dirtyAt > AUTH_AT, 'the AUTH.dirty line is still there');
  const m = BOOT_CALL.exec(source);
  assert.ok(m, 'the call is a top level statement wrapped in try');
  assert.ok(m.index >= dirtyAt && m.index < source.indexOf('  function paintLogin('), 'between the AUTH.dirty line and paintLogin');
  assert.match(m[0], /reportError\(e,"bootAccounts"\)/);
  assert.match(m[0], /AUTH=\{serverRev:0,email:AUTH\.email\|\|"",expired:true\}; saveAuth\(\);/, 'a failure ends the session, it never merges');
  assert.equal((source.match(/\bbootAccounts\(\)/g) || []).length - (source.match(/function bootAccounts\(\)/g) || []).length, 1, 'called exactly once');
});

test('bootAccounts only marks: no push, save, pull, api, paint or account settings', () => {
  const b = bodyOf('bootAccounts');
  ['pushCloud(', 'save(', 'pullState(', 'applyAccountSettings(', 'alertsChanged(', 'api(', 'setTimeout('].forEach((s) =>
    assert.ok(b.indexOf(s) < 0, 'bootAccounts must not call ' + s));
  assert.doesNotMatch(b, /render/i, 'nothing that paints');
});

test('the migration runs inside the Settings block, in its own try, before the price list and the first prefs', () => {
  const calls = [];
  const re = /migrateDeviceAlerts\(\)/g; let m;
  while ((m = re.exec(source))) if (!/function\s+$/.test(source.slice(m.index - 9, m.index))) calls.push(m.index);
  assert.equal(calls.length, 1, 'one call');
  const at = calls[0];
  assert.equal(source.slice(at - 5, at), 'try{ ', 'wrapped in try');
  assert.match(source.slice(at, at + 120), /^migrateDeviceAlerts\(\); \}catch\(e\)\{ try\{ reportError\(e,"migrateAlerts"\); \}catch\(_\)\{\} \}/);
  const block = source.slice(source.indexOf('    // Notifications (native app only)'), source.indexOf('  // ---- Cloud: accounts + sync'));
  assert.ok(block.indexOf('migrateDeviceAlerts()') > 0, 'inside the Settings block');
  assert.ok(block.indexOf('migrateDeviceAlerts()') < block.indexOf('renderPriceAlertList()'), 'before the price list');
  assert.ok(block.indexOf('migrateDeviceAlerts()') < block.indexOf('syncNotif();  //'), 'before the first prefs');
  assert.ok(at < AUTH_AT, 'and before AUTH exists, which is why it must not read AUTH');
  const mig = bodyOf('migrateDeviceAlerts');
  ['AUTH', 'save(', 'saveSettings(', 'pushCloud(', '$('].forEach((s) => assert.ok(mig.indexOf(s) < 0, 'migrateDeviceAlerts must not use ' + s));
  assert.ok(mig.indexOf('localStorage.setItem(LS_KEY') > 0 && mig.indexOf('localStorage.setItem(LS_KEY') < mig.indexOf('if(ok){ n.stockWatch=[]; n.priceWatch=[];'), 'the record is written before the device lists are emptied');
});

test('normTop runs before the price alert helpers exist, so it never validates follows', () => {
  const b = bodyOf('normTop');
  ['normPriceAlert', 'mergeAlerts', 'priceOnList', 'stockOnList', 'alertEntOk', 'PA_KINDS'].forEach((s) =>
    assert.ok(b.indexOf(s) < 0, 'normTop must not use ' + s));
  assert.ok(source.indexOf('  normTop(STATE);') < source.indexOf('var PRICE_ALERT_MAX=30'), 'it really does run first');
  // its helpers are hoisted declarations with no dependencies
  assert.equal(appFunction('plainObj'), 'function plainObj(v){ return !!v && typeof v==="object" && !Array.isArray(v); }');
  assert.doesNotMatch(bodyOf('localOk'), /[A-Z_]{4,}|loc\(|STATE/, 'localOk reads nothing but its argument');
});

test('every new top level var is a literal declared before STATE', () => {
  const m = /\n  var ALERT_AT_MAX=([\s\S]*?);\n/.exec(source);
  assert.ok(m, 'the literal block exists');
  assert.ok(m.index > source.indexOf('  var LS_KEY = "palvault-v1";'), 'right after LS_KEY');
  assert.ok(m.index < source.indexOf('  var STATE = loadState();'), 'before var STATE');
  const sb = {}; vm.createContext(sb); vm.runInContext('var ALERT_AT_MAX=' + m[1] + ';', sb);
  assert.deepEqual(
    { ALERT_AT_MAX: sb.ALERT_AT_MAX, ALERT_OFF_KEEP: sb.ALERT_OFF_KEEP, PUSH_GEN: sb.PUSH_GEN, OTHER_TAB: sb.OTHER_TAB, SIGNING_OUT: sb.SIGNING_OUT,
      ALERTS_MOVED: sb.ALERTS_MOVED, STASH_PRE: sb.STASH_PRE, ACCT_BASE_KEY: sb.ACCT_BASE_KEY },
    { ALERT_AT_MAX: 4102444800000, ALERT_OFF_KEEP: 200, PUSH_GEN: 0, OTHER_TAB: false, SIGNING_OUT: false, ALERTS_MOVED: false,
      STASH_PRE: 'palvault-stash:', ACCT_BASE_KEY: 'palvault-acct-base' });
  assert.deepEqual(Array.from(sb.PERSON_KEYS), ['displayName', 'defaultAddCol', 'sphere', 'sphereSeen']);
  assert.deepEqual(Array.from(sb.PERSON_NOTIF), ['weeklyDigest', 'milestones', 'availability']);
  assert.doesNotMatch(m[1], /\(/, 'no call of any kind in the initialisers');
  ['ALERT_AT_MAX', 'PUSH_GEN', 'OTHER_TAB', 'SIGNING_OUT', 'ALERTS_MOVED', 'STASH_PRE', 'ACCT_BASE_KEY', 'PERSON_KEYS', 'PERSON_NOTIF']
    .forEach((n) => assert.equal((source.match(new RegExp('\\bvar\\s+' + n + '\\b|,\\s*' + n + '=', 'g')) || []).length, 1, n + ' declared once'));
});

test('a push never carries this device\'s owner tag, and adopt writes the data before the session', () => {
  const push = appFunction('pushCloud');
  assert.match(push, /delete sent\._local;/);
  assert.ok(push.indexOf('delete sent._local') < push.indexOf('api("/api/state","PUT"'), 'deleted before the PUT');
  assert.match(push, /if\(OTHER_TAB \|\| AUTH\.token!==tok\) return;/, 'an answer for an earlier session is dropped first');
  assert.match(push, /AUTH\.dirty=\(PUSH_GEN!==gen\)/, 'a 200 clears dirty only if no edit came after the send');
  const adopt = appFunction('adoptRemote');
  assert.ok(adopt.indexOf('writeStateRaw()') > 0 && adopt.indexOf('writeStateRaw()') < adopt.indexOf('saveAuth()'), 'state before saveAuth');
  assert.match(adopt, /delete blob\._local;/, 'a downloaded owner tag is stripped');
  assert.ok(adopt.indexOf('own=activeCol().own; addBaseline();') < adopt.indexOf('applyAccountSettings('), 'own is this copy before anything can save');
  const pull = appFunction('pullState');
  assert.match(pull, /if\(OTHER_TAB \|\| AUTH\.token!==tok \|\| !r\.ok\) return;/);
  assert.match(pull, /if\(PUSH_GEN!==gen0 \|\| pushing \|\| AUTH\.serverRev!==rev0\) return;/);
});

test('switchOwner points own at the incoming copy straight after installing it', () => {
  const f = appFunction('switchOwner');
  const a = f.indexOf('STATE=next;'), b = f.indexOf('own=activeCol().own; addBaseline();', a);
  assert.ok(a > 0 && b > a);
  assert.match(f.slice(a + 'STATE=next;'.length, b), /^\s*if\(!writeStateRaw\(\)\)\{ STATE=was; return false; \}\s*$/, 'nothing that can reach save() in between');
  const w1 = f.indexOf('writeStash(out,'), w2 = f.indexOf('STATE=next;');
  assert.ok(w1 > 0 && w1 < w2, 'the outgoing copy is set aside before the incoming one is written');
  assert.ok(f.indexOf('try{\n      applyPerson(') > b, 'everything after the consistent write is guarded');
  assert.match(f, /reportError\(e,"switchOwner"\); \}catch\(_\)\{\} try\{ location\.reload\(\); \}/);
});

test('beginSession saves the token last; sign in and reset password guard it apart from network errors', () => {
  const f = appFunction('beginSession');
  assert.ok(f.lastIndexOf('saveAuth()') > f.indexOf('AUTH={token:token'), 'token saved last');
  assert.ok(f.indexOf('switchOwner(em)') < f.indexOf('AUTH={token:token'), 'the data moves before the session exists');
  const s = appFunction('sessionStarted');
  assert.match(s, /try\{ kind=beginSession\(/);
  assert.match(s, /reportError\(e,"beginSession"\)/);
  assert.match(s, /pullState\(\)\.catch\(function\(\)\{\}\)/);
  assert.match(appFunction('doAuth'), /sessionStarted\(r, email, "Signed in as ", acctMsg\);/);
  assert.match(source, /if\(!sessionStarted\(r, RESET_EMAIL, "Password reset\. Signed in as ", fpMsg\)\)\{ done\(\); return; \}/);
  assert.doesNotMatch(source, /AUTH\.token=r\.body\.token/, 'no other path sets a session');
});

test('every 401 says which session it belongs to', () => {
  const a = appFunction('api');
  assert.match(a, /var usedTok=AUTH\.token, hadToken=!!usedTok;/);
  assert.match(a, /handleSessionExpired\(usedTok\)/);
  assert.match(appFunction('handleSessionExpired'), /if\(!AUTH\.token \|\| \(usedTok && AUTH\.token!==usedTok\)\) return;/);
});

test('callers that ignore pullState add a catch, and a wake only pushes', () => {
  const re = /pullState\(\)/g; let m; const bad = [];
  while ((m = re.exec(source))) {
    const after = source.slice(m.index + 11, m.index + 40);
    const before = source.slice(m.index - 9, m.index);
    if (/function\s+$/.test(before)) continue;
    if (!/^\.catch\(function\(\)\{\}\)/.test(after)) bad.push(source.slice(m.index - 40, m.index + 40));
  }
  assert.deepEqual(bad, []);
  const wake = source.slice(source.indexOf('function onWake('), source.indexOf('document.addEventListener("visibilitychange"'));
  assert.match(wake, /if\(AUTH\.token && AUTH\.dirty && !pushing && !SIGNING_OUT\) pushCloud\(true\);/);
  assert.doesNotMatch(wake, /pullState/);
});

test('the new and changed code is ES5', () => {
  NEW_FUNCS.concat(CHANGED_FUNCS).forEach((n) => es5(appFunction(n), n));
});

test('the new copy has no dashes', () => {
  const copy = [
    'The products you follow are saved to your account when you are signed in. This switch turns stock alerts on or off for this device only.',
    'Your price alerts are saved to your account when you are signed in, and every phone you sign in on can alert you. This switch is for this device only. Up to 30 alerts are checked.',
    'Stock alert follows and price alerts are saved to your account too. Each device keeps its own alert switches.',
    'If someone else signs in, they are kept apart and come back when this account signs in here again.',
    'Cards and alerts saved on this device stay, and the next account that signs in on this device takes them in.',
    'This device also has a collection from before this update that is not linked to an account.',
    'Add it to this account',
    "The last account's cards and alerts are kept apart on this device.",
    "There is not enough space on this device to keep the last account's changes apart from yours. Sign in as that account first so they can sync, then try again.",
    'Signed out. Your latest changes are saved on this device and sync the next time you sign in here.',
    'Your account has been deleted. Your collection stays on this device.',
    "Added this device's earlier collection to your account",
    'Following, alerts off here',
    ' Paused. Only ',
    ' price alerts, and ',
  ];
  copy.forEach((c) => {
    assert.ok(source.indexOf(c) >= 0, 'copy is in the app: ' + c);
    assert.doesNotMatch(c, /[-‐-―]/, 'no dash in: ' + c);
  });
  const privacy = fs.readFileSync(path.join(root, 'docs', 'privacy.html'), 'utf8');
  ['the sealed products and card prices you follow for alerts', 'card language', 'alert follows and account settings',
    'If someone else signs in on the same device, your cards and alerts are kept apart from theirs'].forEach((c) =>
    assert.ok(privacy.indexOf(c) >= 0, 'privacy policy says: ' + c));
});

test('no comment still says follows are device local', () => {
  assert.doesNotMatch(source, /stockWatch stays device-local/);
  assert.doesNotMatch(source, /device local like stockWatch/);
});

// ==== 2. the merge functions ================================================================================
function pureSandbox(extra) {
  const sb = Object.assign({
    ALERT_AT_MAX: 4102444800000, ALERT_OFF_KEEP: 200, PRICE_ALERT_MAX: 30,
    PA_KINDS: ['above', 'below', 'up', 'down'], REGION_CUR: { 'co.uk': 'GBP', com: 'USD', de: 'EUR' },
    RAW_KNOWN: ['1', '2', 'jp', 'cn'], RAW_LANGS: { jp: 1, cn: 1 },
    Date, Math, JSON, Object, Array, String, Number, isFinite,
  }, extra || {});
  vm.createContext(sb);
  vm.runInContext(['plainObj', 'hasOwn', 'has', 'alertAt', 'alertEntOk', 'canonEnt', 'alertWins', 'mergeAlertMap', 'mergeAlerts',
    'canonAlerts', 'sameAlerts', 'alertGC', 'alertStamp', 'paKey', 'stockOnList', 'priceOnList', 'normPriceAlert',
    'rawCount', 'rawEditionKey', 'rawCounts', 'rawKnownTotal', 'setRawCounts', 'copyNoteClean', 'mergeRawCounts', 'cloneSlab',
    'slabSig', 'mergeEntry', 'mergeCol', 'normTop', 'localOk', 'colHasCards', 'colHolds', 'mergeStates'].map(appFunction).join('\n'), sb);
  return sb;
}
const J = (x) => JSON.stringify(x);

// A small deterministic generator, so a failure is reproducible.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function randomRecord(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const ats = [0, -5, 1, 2, 3, 3, 1790000000000, 4102444800000, 4102444800001, 'x', null, 2.5];
  const ent = (price) => {
    const t = r();
    if (t < 0.06) return pick([null, 'on', 7, [], { on: 'true', at: 3 }]);
    const e = { on: r() < 0.6, at: pick(ats) };
    if (price && (e.on || r() < 0.3)) e.a = pick([{ id: 'EBP01-001', k: 'above', v: 50, b: 30, r: 'co.uk', m: 'live' },
      { id: 'EBP01-001', k: 'above', v: 50, b: 30, r: 'co.jp', m: 'live', g: 'PSA10' }, 'bad', null, { id: 'EBP01-002', k: 'below', v: 5, b: 9, r: 'de', m: 'sold' }]);
    if (r() < 0.15) e.snooze = Math.floor(r() * 3);
    return e;
  };
  const rec = { v: pick([1, 1, 2, 'z']) };
  ['stock', 'price', 'sealedPrice'].forEach((kind) => {
    if (r() < 0.15) { rec[kind] = pick([null, [], 'x']); return; }
    if (kind === 'sealedPrice' && r() < 0.5) return;
    const m = {};
    for (let i = 0; i < 4; i++) m[pick(['a', 'b', 'c', 'd', '__proto__', 'constructor'])] = ent(kind === 'price');
    rec[kind] = m;
  });
  return r() < 0.08 ? pick([null, undefined, 'junk', []]) : rec;
}

test('mergeAlerts is commutative, associative and idempotent, malformed input included', () => {
  const sb = pureSandbox();
  const r = rng(42);
  for (let i = 0; i < 3000; i++) {
    const a = randomRecord(r), b = randomRecord(r), c = randomRecord(r);
    const ab = sb.mergeAlerts(a, b), ba = sb.mergeAlerts(b, a);
    assert.equal(J(ab), J(ba), 'commutative #' + i);
    assert.equal(J(sb.mergeAlerts(sb.mergeAlerts(a, b), c)), J(sb.mergeAlerts(a, sb.mergeAlerts(b, c))), 'associative #' + i);
    assert.equal(J(sb.mergeAlerts(ab, ab)), J(ab), 'idempotent #' + i);
    assert.equal(J(sb.mergeAlerts(a, a)), J(sb.mergeAlerts(a, null)), 'self merge is a clean #' + i);
    assert.equal(sb.canonAlerts(ab), sb.canonAlerts(ba));
    // the readers take whatever came out, and whatever went in
    [a, b, ab].forEach((x) => { sb.stockOnList(x); sb.priceOnList(x); });
  }
});

test('an off marker beats a follow stamped at the same moment, and a later stamp beats both', () => {
  const sb = pureSandbox();
  const on = { v: 1, stock: { box: { on: true, at: 100 } }, price: {} }, off = { v: 1, stock: { box: { on: false, at: 100 } }, price: {} };
  assert.equal(sb.mergeAlerts(on, off).stock.box.on, false);
  assert.equal(sb.mergeAlerts(off, on).stock.box.on, false);
  const later = { v: 1, stock: { box: { on: true, at: 101 } } };
  assert.equal(sb.mergeAlerts(off, later).stock.box.on, true);
  assert.deepEqual(Array.from(sb.stockOnList(sb.mergeAlerts(off, later))), ['box']);
  // after 2100 is ignored everywhere
  assert.deepEqual(Array.from(sb.stockOnList({ stock: { x: { on: true, at: 4102444800001 } } })), []);
  // a stamp always lands after the newest entry, even when the device clock is behind it
  const ahead = Date.now() + 1e9;
  assert.equal(sb.alertStamp({ stock: { x: { on: true, at: ahead } } }), ahead + 1);
});

test('unknown kinds, markets and fields survive byte for byte', () => {
  const sb = pureSandbox();
  const future = { id: 'EBP01-001', k: 'above', v: 50, b: 30, r: 'co.jp', m: 'live', c: 'JPY', g: 'PSA10', at: 1 };
  const rec = { v: 1, stock: { box: { on: true, at: 5, why: 'restock' } }, price: { 'EBP01-001|above|50|co.jp|live': { on: true, at: 7, a: future, snooze: 3 } },
    sealedPrice: { 'box-bp02': { on: true, at: 9, a: { v: 100 } } } };
  const out = sb.mergeAlerts(rec, { v: 1, stock: {}, price: {} });
  assert.equal(J(out.price['EBP01-001|above|50|co.jp|live']), J(rec.price['EBP01-001|above|50|co.jp|live']), 'a newer market and field');
  assert.equal(J(out.stock.box), J(rec.stock.box), 'a newer entry field');
  assert.equal(J(out.sealedPrice), J(rec.sealedPrice), 'a newer kind');
  assert.equal(sb.priceOnList(out).length, 0, 'this build cannot read co.jp, so it shows and sends nothing for it');
  // and it survives a whole state merge, and a collection merge, with the other side's unknown keys
  const local = { cols: [{ id: 'c1', name: 'Mine', own: {}, binderColour: 'red' }], active: 'c1', alerts: rec, _local: { v: 1, email: 'a@x.com', rev: 3, dirty: false } };
  const remote = { cols: [{ id: 'c1', name: 'Mine', own: {}, coverCard: 'EBP01-002' }], active: 'c1', editions2: { x: 1 }, _acct: { ebayRegion: 'de' }, _local: { email: 'evil' } };
  const m = sb.mergeStates(local, remote);
  assert.equal(J(m.alerts.sealedPrice), J(rec.sealedPrice));
  assert.equal(J(m.editions2), J({ x: 1 }), 'a newer top level key from the server');
  assert.equal(m.cols[0].coverCard, 'EBP01-002', 'a newer collection field from the server');
  assert.equal(m.cols[0].binderColour, 'red');
  assert.equal(m._acct, undefined, 'never the server _acct');
  assert.equal(m._local.email, 'a@x.com', 'and never the server owner tag');
});

test('alertGC keeps every follow and only the newest 200 off markers', () => {
  const sb = pureSandbox();
  const rec = { v: 1, stock: {}, price: {} };
  for (let i = 0; i < 500; i++) rec.price['k' + i] = { on: false, at: 1000 + i };
  for (let i = 0; i < 300; i++) rec.price['on' + i] = { on: true, at: 10 + i, a: { id: 'EBP01-001', k: 'above', v: i + 1, b: 1, r: 'co.uk', m: 'live' } };
  sb.alertGC(rec);
  const keys = Object.keys(rec.price);
  assert.equal(keys.filter((k) => /^on/.test(k)).length, 300, 'no follow is ever dropped');
  const offs = keys.filter((k) => /^k/.test(k));
  assert.equal(offs.length, 200);
  assert.ok(offs.every((k) => +k.slice(1) >= 300), 'the newest ones stay');
});

test('mergeStates on a first join drops an empty placeholder and keeps the account active collection', () => {
  const sb = pureSandbox();
  const guest = { cols: [{ id: 'cG', name: 'My Collection', own: {} }], active: 'cG', wishlist: { 'EBP01-009': true }, wishlistAt: {}, fav: {} };
  const acct = { cols: [{ id: 'cA', name: 'My Collection', own: { 'EBP01-001': { qty: 2, graded: [] } } }], active: 'cA', wishlist: {}, fav: {} };
  const m = sb.mergeStates(guest, acct, { firstJoin: true });
  assert.deepEqual(Array.from(m.cols, (c) => c.id), ['cA']);
  assert.equal(m.active, 'cA');
  assert.equal(m.wishlist['EBP01-009'], true, 'the wishlist still joins');
  // a collection with something in it is kept, and without firstJoin nothing changes
  guest.cols.push({ id: 'cH', name: 'Binder', own: {}, hist: { '2026-10-01': { v: 3 } } });
  assert.deepEqual(Array.from(sb.mergeStates(guest, acct, { firstJoin: true }).cols, (c) => c.id).sort(), ['cA', 'cH']);
  assert.deepEqual(Array.from(sb.mergeStates(guest, acct).cols, (c) => c.id), ['cG', 'cH', 'cA']);
  assert.equal(sb.mergeStates(guest, acct).active, 'cG');
});

function acctSandbox(settings, base, owner) {
  const ls = { 'palvault-currency': 'GBP' };
  if (base !== undefined) ls['palvault-acct-base'] = J({ email: owner || 'a@x.com', acct: base });
  const sb = {
    SETTINGS: settings, CUR: { code: 'GBP' }, SEAL_ED: 'en', LS_MEM: {}, ACCT_BASE_KEY: 'palvault-acct-base',
    STATE: { _local: { v: 1, email: 'a@x.com', rev: 1, dirty: false }, cols: [] },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } },
    JSON, Object, Array, String, isFinite, Math,
  };
  vm.createContext(sb);
  vm.runInContext(['plainObj', 'hasOwn', 'lsGet', 'lsSet', 'localOk', 'loc', 'deriveLocal', 'acctBase', 'setAcctBase', 'accountSettingsBlob', 'mergeAcct', 'sameAcct'].map(appFunction).join('\n') +
    '\n' + /var ACCT_SETTING_KEYS=\[[^\]]*\];/.exec(source)[0], sb);
  return sb;
}

test('mergeAcct: with no base the account wins every key it has', () => {
  const sb = acctSandbox({ ebayRegion: 'co.uk', defaultGrader: 'PSA', priceMode: 'live', mode: 'trader', textScale: 1, cardLang: 'en' }, undefined);
  const out = sb.mergeAcct({ ebayRegion: 'de', defaultGrader: 'BGS', priceMode: 'sold', mode: 'collector', textScale: 1.2, _currency: 'EUR', _edition: 'jp' });
  assert.deepEqual(JSON.parse(J(out)), { ebayRegion: 'de', defaultGrader: 'BGS', priceMode: 'sold', mode: 'collector', textScale: 1.2, _currency: 'EUR', _edition: 'jp', cardLang: 'en' },
    'only a key the account lacks (cardLang, stripped by an older app) keeps this device value');
});

test('mergeAcct: with a base, only what this device changed since keeps its value', () => {
  const base = { ebayRegion: 'co.uk', defaultGrader: 'PSA', priceMode: 'live', mode: 'trader', textScale: 1, cardLang: 'en', _currency: 'GBP', _edition: 'en' };
  const sb = acctSandbox({ ebayRegion: 'co.uk', defaultGrader: 'CGC', priceMode: 'live', mode: 'trader', textScale: 1, cardLang: 'en' }, base);
  const out = sb.mergeAcct({ ebayRegion: 'de', defaultGrader: 'PSA', priceMode: 'live', mode: 'trader', textScale: 1, cardLang: 'en', _currency: 'EUR', _edition: 'en' });
  assert.equal(out.ebayRegion, 'de', 'the other device changed the market');
  assert.equal(out._currency, 'EUR');
  assert.equal(out.defaultGrader, 'CGC', 'this device changed the grader');
  assert.equal(sb.sameAcct(out, { ebayRegion: 'de', defaultGrader: 'PSA' }), false);
  assert.equal(sb.sameAcct({ a: [1, 2] }, { a: [1, 2] }), true, 'values compare as JSON, so arrays and objects never look changed');
  // a base for somebody else is no base at all
  const other = acctSandbox({ ebayRegion: 'co.uk', defaultGrader: 'CGC' }, base, 'b@x.com');
  assert.equal(other.acctBase(), null);
  assert.equal(other.mergeAcct({ ebayRegion: 'de', defaultGrader: 'PSA' }).defaultGrader, 'PSA');
});

test('a key a newer app added to the account rides along in every push', () => {
  const sb = acctSandbox({ ebayRegion: 'co.uk' }, { ebayRegion: 'co.uk', quickMenu: ['news'], _currency: 'GBP' });
  const blob = sb.accountSettingsBlob();
  assert.deepEqual(Array.from(blob.quickMenu), ['news']);
  assert.equal(blob.ebayRegion, 'co.uk');
});

// ==== 3. whole flows through the real functions ============================================================
// One clock and one timer queue for every device and the server.
const CLOCK = { t: 1790000000000 };
let TIMERS = [], TID = 0;
class VDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(CLOCK.t); }
  static now() { return CLOCK.t; }
}
const drain = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const TIMER_ERRORS = [];
async function run(ms) {
  const end = CLOCK.t + (ms || 0);
  await drain();
  for (let guard = 0; guard < 5000; guard++) {
    const due = TIMERS.filter((t) => t.alive && t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) break;
    CLOCK.t = Math.max(CLOCK.t, due.at); due.alive = false;
    try { due.fn(); } catch (e) { TIMER_ERRORS.push(e); }
    await drain();
  }
  CLOCK.t = Math.max(CLOCK.t, end);
  await drain();
}

class FakeStorage {
  constructor(init) { this.m = new Map(Object.entries(init || {})); this.quota = Infinity; this.writes = 0; this.freezeAt = Infinity; this.full = new Set(); }
  get length() { return this.m.size; }
  key(i) { return Array.from(this.m.keys())[i] == null ? null : Array.from(this.m.keys())[i]; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  size() { let n = 0; for (const [k, v] of this.m) n += k.length + v.length; return n; }
  setItem(k, v) {
    v = String(v);
    if (this.writes >= this.freezeAt) { this.writes++; return; }   // the process died: nothing reaches the disk
    const before = this.m.has(k) ? this.m.get(k).length + k.length : 0;
    if (this.full.has(k) || this.size() - before + k.length + v.length > this.quota) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
    this.writes++; this.m.set(k, v);
  }
  removeItem(k) { if (this.writes >= this.freezeAt) { this.writes++; return; } this.writes++; this.m.delete(k); }
  json(k) { const v = this.getItem(k); return v == null ? null : JSON.parse(v); }
  snapshot() { return Object.fromEntries(this.m); }
}

// The backend's /api/state contract: a PUT at the current rev is accepted and bumps it; any other rev is a 409
// carrying the server copy. A token the server no longer knows is a 401 bad_token.
class FakeServer {
  constructor() { this.accounts = {}; this.tokens = {}; this.n = 0; this.holds = []; this.held = []; this.log = []; }
  account(email, pw, blob, rev) { this.accounts[email] = { pw: pw || 'password1', blob: blob ? JSON.parse(J(blob)) : null, rev: rev || (blob ? 1 : 0) }; return this.accounts[email]; }
  revoke(email) { Object.keys(this.tokens).forEach((t) => { if (this.tokens[t] === email) delete this.tokens[t]; }); }
  // A held request is answered later. early: the answer is what the server said when the request arrived
  // (a slow response); otherwise it is worked out on release (a slow request).
  hold(method, p, early) { this.holds.push({ method, p, early: !!early }); }
  release() { const h = this.held.shift(); if (h) h(); }
  handle(method, p, tok, body) {
    const email = tok ? this.tokens[tok] : null;
    if (p === '/api/login' || p === '/api/signup') {
      const em = String(body.email).toLowerCase();
      if (p === '/api/signup') { if (this.accounts[em]) return [409, { error: 'exists' }]; this.account(em, body.password); }
      const a = this.accounts[em]; if (!a || a.pw !== body.password) return [401, { error: 'Wrong email or password.' }];
      const t = 'tok' + (++this.n); this.tokens[t] = em; return [200, { token: t, email: em }];
    }
    if (tok && !email) return [401, { code: 'bad_token', error: 'Please sign in again.' }];
    if (!email) return [401, { error: 'no token' }];
    const a = this.accounts[email];
    if (p === '/api/state' && method === 'GET') return [200, { rev: a.rev, blob: a.blob ? JSON.parse(J(a.blob)) : null }];
    if (p === '/api/state' && method === 'PUT') {
      if ((body.rev || 0) !== a.rev) return [409, { error: 'conflict', rev: a.rev, blob: a.blob ? JSON.parse(J(a.blob)) : null }];
      a.rev++; a.blob = JSON.parse(J(body.blob)); this.log.push({ email, rev: a.rev }); return [200, { rev: a.rev }];
    }
    if (p === '/api/account' && method === 'DELETE') { delete this.accounts[email]; this.revoke(email); return [200, { ok: true }]; }
    return [404, { error: 'nope' }];
  }
  fetch(url, opts) {
    const p = url.replace(/^https:\/\/api\.test/, '');
    const method = (opts && opts.method) || 'GET';
    const tok = ((opts && opts.headers && opts.headers.Authorization) || '').replace(/^Bearer /, '') || null;
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const answer = () => { const [status, b] = this.handle(method, p, tok, body); return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(JSON.parse(J(b))) }; };
    const hi = this.holds.findIndex((h) => h.method === method && h.p === p);
    if (hi >= 0) {
      const h = this.holds.splice(hi, 1)[0], now = h.early ? answer() : null;
      return new Promise((res) => { this.held.push(() => res(now || answer())); });
    }
    return Promise.resolve(answer());
  }
}

const REAL = ['plainObj', 'hasOwn', 'has', 'lsGet', 'lsSet', 'activeCol', 'cleanCols', 'normTop', 'isEmptyOwn', 'stateReplacer', 'stateJSON',
  'save', 'entCount', 'baseCol', 'addBaseline', 'stampAdds', 'rawCount', 'rawEditionKey', 'rawCounts', 'rawKnownTotal', 'setRawCounts',
  'copyNoteClean', 'mergeRawCounts', 'cloneSlab', 'cardMap', 'sealedMap', 'saveSettings', 'nativePushIface', 'syncPushPrefs',
  'stockAlertOn', 'toggleStockAlert', 'stockAlertBtn', 'alertAt', 'alertEntOk', 'canonEnt', 'alertWins', 'mergeAlertMap', 'mergeAlerts',
  'canonAlerts', 'sameAlerts', 'alertGC', 'alertRec', 'alertStamp', 'paKey', 'stockOnList', 'priceOnList', 'sentPriceAlerts',
  'priceAlertByKey', 'notifPairs', 'paintNotifSwitches', 'alertsChanged', 'migrateDeviceAlerts', 'normPriceAlert', 'priceWatch',
  'addPriceAlert', 'removePriceAlertKey', 'removePriceAlertAt', 'renderPriceAlertList', 'accountSettingsBlob', 'acctBase', 'setAcctBase',
  'mergeAcct', 'sameAcct', 'clearFetchedPrices', 'applyAccountSettings', 'saveAuth', 'apiBase', 'api', 'colHasCards', 'localHasCards',
  'localHasData', 'colHolds', 'slabSig', 'mergeEntry', 'mergeCol', 'mergeStates', 'adoptRemote', 'repaintAll', 'pullState', 'pushCloud',
  'sessionStarted', 'doAuth', 'signOut', 'whenSynced', 'finishSignOut', 'handleSessionExpired', 'localOk', 'deriveLocal', 'loc',
  'writeStateRaw', 'freshState', 'readStash', 'writeStash', 'stashKeys', 'trimStashes', 'personPart', 'applyPerson', 'maskEmail',
  'switchOwner', 'beginSession', 'bootAccounts', 'joinLegacyIfOurs', 'joinLegacy', 'deleteAccountDone'];
const REAL_CODE = REAL.map(appFunction).join('\n');
const LITERALS = /\n  (var ALERT_AT_MAX=[\s\S]*?;)\n/.exec(source)[1];
const BOOT_LINE = BOOT_CALL.exec(source)[0];
const PA_LINE = /var PRICE_ALERT_MAX=30, PA_KINDS=[^\n]*/.exec(source)[0];
const ACCT_LINE = /var ACCT_SETTING_KEYS=\[[^\]]*\];/.exec(source)[0];
const CARDS = ['EBP01-001', 'EBP01-002', 'EBP01-003', 'EBP01-004', 'EBP01-005', 'EBP01-006', 'EBP01-009', 'EBP01-023SP'].map((id) => ({ id, name: id, rare: 'C' }));

// One device. reboot() starts the app again on the same storage, the way a relaunch does.
function device(server, storage, opts) {
  opts = opts || {};
  const dev = { server, ls: storage || new FakeStorage(), prefs: [], toasts: [], errors: [], reloads: 0, msgs: [], listeners: [] };
  dev.boot = () => {
    const els = { acctEmail: { value: '' }, acctPw: { value: '' } };
    dev.els = els;
    const win = { addEventListener: (type, fn) => { if (opts.throwOnListen) throw new Error('listen failed'); dev.listeners.push({ type, fn }); } };
    if (opts.native !== false) win.AndroidPush = { setPrefs: (s) => dev.prefs.push(JSON.parse(s)) };
    const ctxTimers = [];
    const sb = {
      window: win, localStorage: dev.ls, navigator: { onLine: true }, location: { hostname: 'test', reload: () => { dev.reloads++; } },
      document: { getElementById: () => null },
      fetch: (u, o) => (sb.navigator.onLine ? server.fetch(u, o) : Promise.reject(new TypeError('Failed to fetch'))),
      setTimeout: (fn, ms) => { const t = { id: ++TID, at: CLOCK.t + (ms || 0), fn, alive: !dev.dead }; TIMERS.push(t); ctxTimers.push(t); return t.id; },
      clearTimeout: (id) => { const t = TIMERS.find((x) => x.id === id); if (t) t.alive = false; },
      Date: VDate, Math, JSON, Object, Array, String, Number, isFinite, Error, TypeError, Promise,
      CARDS, cardById: (id) => CARDS.find((c) => c.id === id),
      REGION_CUR: { 'co.uk': 'GBP', com: 'USD', de: 'EUR' }, CURRENCIES: [{ code: 'GBP' }, { code: 'USD' }, { code: 'EUR' }],
      RAW_KNOWN: ['1', '2', 'jp', 'cn'], RAW_LANGS: { jp: 1, cn: 1 },
      STOCK_TRACKED: { 'co.uk': ['box-bp02', 'ss-vol1', 'box-ebp01'], de: ['box-bp02', 'ss-vol1', 'box-ebp01'] },
      $: (id) => els[id] || null, icon: () => '', esc: (s) => String(s),
      ebayReg: () => sb.SETTINGS.ebayRegion,
      toast: (m) => dev.toasts.push(m), reportError: (e, w) => dev.errors.push(w + ': ' + (e && e.stack || e)),
      acctMsg: (m) => dev.msgs.push(m), netErr: () => 'net error', busyBtn: () => () => {}, setSyncStatus: () => {},
      snapshot: () => {}, askPersist: () => {}, renderAccount: () => {}, paintLogin: () => {}, buildColSel: () => {}, applySettings: () => {},
      render: () => {}, renderQuick: () => {}, applySphere: () => {}, renderSphereThemes: () => {}, resetScanSession: () => {},
      refreshScanSessionUI: () => {}, closeScanReview: () => {}, dismissOverlay: () => {}, reconcileEdition: () => {},
      fetchServerPrices: () => {}, weeklyCollectionStats: () => ({}), collectionMilestoneCount: () => 0,
      scrim: { classList: { contains: () => false } },
    };
    vm.createContext(sb);
    // The app's own top level, in the app's order (src/paldeck.html), with the parts these tests do not need left out.
    CLOCK.t += 7;   // two devices never make a collection in the same millisecond
    vm.runInContext(['"use strict";',
      'var LS_KEY = "palvault-v1"; var LS_MEM={};',
      LITERALS,
      'var STATE=(function(){ var s=null; try{ s=JSON.parse(localStorage.getItem(LS_KEY)); }catch(e){} return (s&&s.cols&&s.cols.length)?s:{cols:[{id:"c"+Date.now(),name:"My Collection",own:{}}],active:null}; })();',
      'if(!STATE.active) STATE.active=STATE.cols[0].id; cleanCols(STATE); var own=activeCol().own; normTop(STATE);',
      'var ADD_BASE={}, ADD_UNDO=30*60*1000, storageWarned=false, LAST_DEVICE_PUSH_PREF_SYNC=0, SEAL_ED="en", CUR={code:"GBP"}, DAYP_KEY="palvault-dayprices", _dayP=null;',
      'var PRICEBOOK={}, PRICEBOOK_SOLD={}, PRICEMETA={}, PRICEMETA_SOLD={}, PRICEPREV={}, PRICESRC={}, PRICESRC_SOLD={};',
      'addBaseline();',
      'var SETTINGS=(function(){ var s={ebayRegion:"co.uk",defaultGrader:"PSA",priceMode:"live",mode:"trader",textScale:1,cardLang:"en",displayName:"",defaultAddCol:"ask",sphere:-1,serverUrl:"https://api.test",notif:{releases:true,news:true,newSets:true,stock:false,stockWatch:[],price:false,priceWatch:[]}}; try{ var d=JSON.parse(localStorage.getItem("palvault-settings")); if(d) Object.assign(s,d); }catch(e){} return s; })();',
      PA_LINE, ACCT_LINE,
      REAL_CODE,
      // the Settings block's notification part
      'if(!SETTINGS.notif) SETTINGS.notif={releases:true,news:true,newSets:true,stock:false,stockWatch:[],price:false,priceWatch:[]};',
      'if(SETTINGS.notif.stock===undefined) SETTINGS.notif.stock=false; if(!Array.isArray(SETTINGS.notif.stockWatch)) SETTINGS.notif.stockWatch=[];',
      'SETTINGS.notif.price=(SETTINGS.notif.price===true); if(!Array.isArray(SETTINGS.notif.priceWatch)) SETTINGS.notif.priceWatch=[];',
      'try{ migrateDeviceAlerts(); }catch(e){ try{ reportError(e,"migrateAlerts"); }catch(_){} }',
      'renderPriceAlertList(); syncPushPrefs();',
      // the AUTH block, then the real bootAccounts statement
      'var AUTH=(function(){ try{ return JSON.parse(localStorage.getItem("palvault-auth"))||{}; }catch(e){ return {}; } })();',
      'if(AUTH.serverRev==null) AUTH.serverRev=0;',
      DIRTY_LINE,
      BOOT_LINE,
      'var pushTimer=null, pushing=false;',
      'function addCard(id, n){ var s=own[id]; if(!s) s=own[id]={qty:0,wish:false,cond:"Near Mint",notes:"",mkt:0,last:0,avg:0,graded:[]}; s.qty=Math.max(0,s.qty+n); save(); }',
      'function wish(id){ STATE.wishlist[id]=true; STATE.wishlistAt[id]=Date.now(); save(); }',
      // the startup pull
      'if(AUTH.token && apiBase()){ pullState().catch(function(){}); }',
    ].join('\n'), sb, { filename: 'app-sandbox.js' });
    dev.ctx = sb;
    dev.timers = ctxTimers;
    return dev;
  };
  dev.kill = () => { dev.timers.forEach((t) => { t.alive = false; }); };   // the process is gone: its timers never fire
  dev.reboot = () => { dev.kill(); return dev.boot(); };
  dev.signIn = async (email, pw, kind) => { dev.els.acctEmail.value = email; dev.els.acctPw.value = pw || 'password1'; dev.ctx.doAuth(kind || 'login', {}); await run(3000); };
  dev.signOut = async () => { dev.ctx.signOut(); await run(10000); };
  dev.add = async (id, n) => { dev.ctx.addCard(id, n == null ? 1 : n); await run(3000); };
  dev.cards = () => { const st = JSON.parse(dev.ctx.stateJSON()); const out = {}; st.cols.forEach((c) => Object.keys(c.own || {}).forEach((id) => { if (c.own[id].qty > 0) out[id] = (out[id] || 0) + c.own[id].qty; })); return out; };
  dev.follows = () => Array.from(dev.ctx.stockOnList(dev.ctx.STATE.alerts));
  dev.lastPrefs = () => dev.prefs[dev.prefs.length - 1];
  dev.owner = () => dev.ctx.loc().email;
  dev.signedIn = () => dev.ctx.AUTH.token ? dev.ctx.AUTH.email : null;
  return dev.boot();
}
function serverCards(server, email) {
  const a = server.accounts[email]; const out = {};
  if (a && a.blob) a.blob.cols.forEach((c) => Object.keys(c.own || {}).forEach((id) => { if (c.own[id].qty > 0) out[id] = (out[id] || 0) + c.own[id].qty; }));
  return out;
}
function serverFollows(server, email) {
  const a = server.accounts[email]; const s = a && a.blob && a.blob.alerts && a.blob.alerts.stock;
  return s ? Object.keys(s).filter((k) => s[k].on === true).sort() : [];
}
// Every flow starts with an empty timer queue, so nothing from an earlier test fires into it.
function flow(name, fn) { test(name, async () => { TIMERS = []; TIMER_ERRORS.length = 0; await fn(); }); }
function noErrors(...devs) {
  devs.forEach((d) => assert.deepEqual(d.errors, [], 'no reported errors'));
  assert.deepEqual(TIMER_ERRORS.map(String), [], 'no timer threw');
}

flow('A, then B, then A again on one phone: each sees only their own cards and follows', async () => {
  const server = new FakeServer(); server.account('a@x.com'); server.account('b@x.com');
  const p = device(server);
  await p.add('EBP01-001');                               // a guest card, before anyone signed in
  await p.signIn('a@x.com');
  assert.equal(p.signedIn(), 'a@x.com');
  assert.equal(p.owner(), 'a@x.com');
  await p.add('EBP01-002');
  p.ctx.toggleStockAlert('box-bp02'); await run(3000);
  assert.deepEqual(serverCards(server, 'a@x.com'), { 'EBP01-001': 1, 'EBP01-002': 1 }, 'the guest card joined A, as always');
  assert.deepEqual(serverFollows(server, 'a@x.com'), ['box-bp02'], 'the follow is saved to the account');
  await p.signOut();
  assert.equal(p.signedIn(), null);
  assert.deepEqual(p.cards(), { 'EBP01-001': 1, 'EBP01-002': 1 }, 'a plain sign out keeps the data on the device');
  assert.deepEqual(p.lastPrefs().stockWatch, ['box-bp02'], 'and its alerts keep running');

  await p.signIn('b@x.com');
  assert.equal(p.signedIn(), 'b@x.com');
  assert.deepEqual(p.cards(), {}, 'B does not see A\'s cards');
  assert.deepEqual(p.follows(), [], 'or A\'s follows');
  assert.deepEqual(p.lastPrefs().stockWatch, [], 'and this phone stops alerting for A');
  assert.ok(p.toasts.some((t) => /kept apart on this device/.test(t)));
  await p.add('EBP01-003');
  p.ctx.toggleStockAlert('ss-vol1'); await run(3000);
  assert.deepEqual(serverCards(server, 'b@x.com'), { 'EBP01-003': 1 }, 'nothing of A reached B\'s account');
  assert.deepEqual(serverCards(server, 'a@x.com'), { 'EBP01-001': 1, 'EBP01-002': 1 }, 'nothing of B reached A\'s');

  await p.signOut();
  await p.signIn('a@x.com');
  assert.deepEqual(p.cards(), { 'EBP01-001': 1, 'EBP01-002': 1 }, 'A gets their cards back');
  assert.deepEqual(p.follows(), ['box-bp02'], 'and their follow');
  assert.deepEqual(p.lastPrefs().stockWatch, ['box-bp02']);
  assert.deepEqual(serverFollows(server, 'b@x.com'), ['ss-vol1']);
  assert.ok(p.ls.getItem('palvault-stash:b@x.com'), 'B is set aside, ready for when B comes back');
  assert.equal(p.ls.getItem('palvault-stash:a@x.com'), null, 'A\'s own stash was taken back');
  noErrors(p);
});

flow('a guest joining an account keeps the account\'s market, grader and currency', async () => {
  const server = new FakeServer();
  server.account('a@x.com', null, { cols: [{ id: 'cA', name: 'My Collection', own: { 'EBP01-005': { qty: 1, graded: [] } } }], active: 'cA',
    _acct: { ebayRegion: 'de', defaultGrader: 'BGS', priceMode: 'live', mode: 'trader', textScale: 1, cardLang: 'en', _currency: 'EUR', _edition: 'en' } }, 4);
  const p = device(server);
  await p.add('EBP01-001');
  assert.equal(p.ctx.SETTINGS.ebayRegion, 'co.uk');
  await p.signIn('a@x.com');
  assert.equal(p.ctx.SETTINGS.ebayRegion, 'de', 'the account\'s market wins');
  assert.equal(p.ctx.SETTINGS.defaultGrader, 'BGS');
  assert.equal(p.ls.getItem('palvault-currency'), 'EUR');
  await run(3000);
  assert.equal(server.accounts['a@x.com'].blob._acct.ebayRegion, 'de', 'and the server keeps it');
  assert.deepEqual(serverCards(server, 'a@x.com'), { 'EBP01-001': 1, 'EBP01-005': 1 });
  assert.equal(server.accounts['a@x.com'].blob.active, 'cA', 'the account\'s own collection stays active');
  noErrors(p);
});

flow('a guest with only a wishlist keeps it when signing in to an account with cards', async () => {
  const server = new FakeServer();
  server.account('a@x.com', null, { cols: [{ id: 'cA', name: 'Main', own: { 'EBP01-005': { qty: 1, graded: [] } } }], active: 'cA' }, 2);
  const p = device(server);
  p.ctx.wish('EBP01-009'); await run(10);
  await p.signIn('a@x.com');
  await run(3000);
  assert.equal(p.ctx.STATE.wishlist['EBP01-009'], true);
  assert.equal(server.accounts['a@x.com'].blob.wishlist['EBP01-009'], true, 'it reached the account');
  assert.deepEqual(server.accounts['a@x.com'].blob.cols.map((c) => c.id), ['cA'], 'without a second, empty My Collection');
  assert.equal(p.ctx.STATE.active, 'cA');
  noErrors(p);
});

flow('an edit made while a push is in flight is not lost when that push is accepted', async () => {
  const server = new FakeServer(); server.account('a@x.com');
  const p = device(server);
  await p.signIn('a@x.com');
  server.hold('PUT', '/api/state');
  p.ctx.addCard('EBP01-001', 1); await run(1500);         // the debounced push for card 1 is now in flight
  assert.equal(p.ctx.pushing, true);
  p.ctx.addCard('EBP01-002', 1); await run(100);          // edited while it flies
  server.release(); await run(50);                         // card 1 accepted; the push for card 2 has not gone yet
  assert.equal(p.ctx.AUTH.dirty, true, 'card 2 is not on the server, so the copy is still unsynced');
  p.reboot(); await run(5000);                             // and the app is closed before that push could go
  assert.deepEqual(serverCards(server, 'a@x.com'), { 'EBP01-001': 1, 'EBP01-002': 1 }, 'the second card still reached the server');
  assert.deepEqual(p.cards(), { 'EBP01-001': 1, 'EBP01-002': 1 });
  assert.equal(p.ctx.AUTH.dirty, false);
  noErrors(p);
});

flow('a pull answer that a push has overtaken is dropped, not adopted', async () => {
  const server = new FakeServer(); server.account('a@x.com');
  const p = device(server);
  await p.signIn('a@x.com'); await p.add('EBP01-001');
  server.hold('GET', '/api/state', true);                  // a slow answer, as the server stood when it was asked
  p.ctx.pullState().catch(() => {}); await run(10);
  await p.add('EBP01-002');                                // pushed and accepted meanwhile
  const rev = p.ctx.AUTH.serverRev;
  server.release(); await run(3000);
  assert.deepEqual(p.cards(), { 'EBP01-001': 1, 'EBP01-002': 1 }, 'the newer card is still on the phone');
  assert.equal(p.ctx.AUTH.serverRev, rev, 'and the sync position did not go back');
  noErrors(p);
});

flow('a late 401 from the previous session does not sign the next person out', async () => {
  const server = new FakeServer(); server.account('a@x.com'); server.account('b@x.com');
  const p = device(server);
  await p.signIn('a@x.com');
  server.hold('GET', '/api/state');
  p.ctx.pullState().catch(() => {}); await run(10);         // a pull for A, still out
  server.revoke('a@x.com');                                // A's token dies on the server meanwhile
  p.ctx.finishSignOut(p.ctx.AUTH.token);
  await p.signIn('b@x.com');
  assert.equal(p.signedIn(), 'b@x.com');
  server.release(); await run(3000);                       // the 401 for A's token finally lands
  assert.equal(p.signedIn(), 'b@x.com', 'B is still signed in');
  assert.equal(p.owner(), 'b@x.com');
  noErrors(p);
});

flow('a crash at any point of an account switch leaves one owner\'s data under that owner, and loses nothing', async () => {
  for (let cut = 0; cut <= 12; cut++) {
    const server = new FakeServer(); server.account('a@x.com'); server.account('b@x.com', null, { cols: [{ id: 'cB', name: 'B', own: { 'EBP01-006': { qty: 4, graded: [] } } }], active: 'cB' }, 3);
    const p = device(server);
    await p.signIn('a@x.com');
    await p.add('EBP01-001');
    p.ctx.navigator.onLine = false;
    await p.add('EBP01-002');                               // unsynced
    await p.signOut();
    p.ctx.navigator.onLine = true;
    p.ls.freezeAt = p.ls.writes + cut;                      // the process dies after `cut` more writes
    try { p.ctx.beginSession('b@x.com', 'tokB'); } catch (_) { /* a frozen disk can make anything fail */ }
    p.kill();
    p.ls.freezeAt = Infinity;
    const q = p.boot();
    const owner = q.owner(), cards = q.cards(), auth = q.ctx.AUTH;
    if (owner === 'a@x.com') {
      assert.deepEqual(cards, { 'EBP01-001': 1, 'EBP01-002': 1 }, 'cut ' + cut + ': A\'s copy whole');
      assert.ok(!auth.token, 'cut ' + cut + ': and not signed in as B');
    } else {
      assert.equal(owner, 'b@x.com', 'cut ' + cut);
      assert.ok(!('EBP01-001' in cards), 'cut ' + cut + ': none of A\'s cards under B');
      const stash = q.ls.json('palvault-stash:a@x.com');
      assert.ok(stash && stash.state, 'cut ' + cut + ': A\'s copy is set aside');
      const s = {}; stash.state.cols.forEach((c) => Object.keys(c.own).forEach((id) => { if (c.own[id].qty > 0) s[id] = c.own[id].qty; }));
      assert.deepEqual(s, { 'EBP01-001': 1, 'EBP01-002': 1 }, 'cut ' + cut + ': whole, unsynced card included');
      assert.equal(stash.state._local.dirty, true, 'cut ' + cut + ': and marked unsynced');
      if (auth.token) assert.equal(auth.email, 'b@x.com');
    }
    assert.deepEqual(q.errors, [], 'cut ' + cut);
    // and A can always get it all back
    await q.signOut(); await q.signIn('a@x.com'); await run(3000);
    assert.deepEqual(serverCards(server, 'a@x.com'), { 'EBP01-001': 1, 'EBP01-002': 1 }, 'cut ' + cut + ': A\'s account ends with everything');
  }
});

flow('no room to keep the last account\'s unsynced changes: the sign in is refused and nothing changes', async () => {
  const server = new FakeServer(); server.account('a@x.com'); server.account('b@x.com');
  const p = device(server);
  await p.signIn('a@x.com');
  for (let i = 0; i < 40; i++) p.ctx.addCard('X-' + i, 1);
  await run(3000);
  p.ctx.navigator.onLine = false;
  await p.add('EBP01-001');
  await p.signOut();
  p.ctx.navigator.onLine = true;
  const before = p.ls.snapshot();
  p.ls.quota = p.ls.size() + 1500;                        // room for a small stash, not for a whole second copy
  await p.signIn('b@x.com');
  assert.equal(p.signedIn(), null, 'not signed in');
  assert.ok(p.msgs.some((m) => /not enough space/.test(m)), 'and told why');
  assert.deepEqual(p.ls.snapshot(), before, 'not one stored value changed');
  assert.equal(p.cards()['EBP01-001'], 1);
  noErrors(p);
});

flow('no room for a synced copy: only its follows are kept, and the account brings back the rest', async () => {
  const server = new FakeServer(); server.account('a@x.com'); server.account('b@x.com');
  const p = device(server);
  await p.signIn('a@x.com');
  for (let i = 0; i < 40; i++) p.ctx.addCard('X-' + i, 1);
  p.ctx.toggleStockAlert('box-bp02'); await run(3000);
  await p.signOut();
  assert.equal(p.ctx.loc().dirty, false, 'everything reached the account');
  p.ls.quota = p.ls.size() + 1500;
  await p.signIn('b@x.com');
  assert.equal(p.signedIn(), 'b@x.com');
  const stash = p.ls.json('palvault-stash:a@x.com');
  assert.equal(stash.state, null, 'no room for the collection, which the account already holds');
  assert.ok(stash.alerts.stock['box-bp02'].on, 'the follows are kept');
  p.ls.quota = Infinity;
  await p.signOut(); await p.signIn('a@x.com'); await run(3000);
  assert.equal(Object.keys(p.cards()).length, 40, 'the collection comes back from the account');
  assert.deepEqual(p.follows(), ['box-bp02']);
  noErrors(p);
});

flow('2.4.1 leftovers: the same account takes its copy back, a stranger is kept apart until asked', async () => {
  // A 2.4.1 install signed out after syncing: no owner tag, the prepull copy exists, no session.
  const leftover = (ids) => new FakeStorage({
    'palvault-v1': J({ cols: [{ id: 'cA', name: 'Main', own: Object.fromEntries(ids.map((id) => [id, { qty: 1, graded: [] }])) }], active: 'cA', wishlist: {}, fav: {} }),
    'palvault-v1-prepull': J({ cols: [{ id: 'cA', name: 'Main', own: {} }], active: 'cA' }),
    'palvault-auth': J({ serverRev: 0, lastBackupAt: 5 }),
  });
  const server = new FakeServer();
  server.account('a@x.com', null, { cols: [{ id: 'cA', name: 'Main', own: { 'EBP01-001': { qty: 1, graded: [] } } }], active: 'cA' }, 7);
  server.account('s@x.com', null, { cols: [{ id: 'cS', name: 'Theirs', own: { 'EBP01-004': { qty: 1, graded: [] } } }], active: 'cS' }, 2);
  const p = device(server, leftover(['EBP01-001', 'EBP01-002']));
  assert.equal(p.owner(), '?', 'owner unknown');
  await p.signIn('a@x.com'); await run(3000);
  assert.deepEqual(p.cards(), { 'EBP01-001': 1, 'EBP01-002': 1 }, 'its own account takes it back by itself');
  assert.deepEqual(serverCards(server, 'a@x.com'), { 'EBP01-001': 1, 'EBP01-002': 1 });
  assert.equal(p.ls.getItem('palvault-stash:?'), null);
  assert.equal(p.ctx.AUTH.lastBackupAt, 5, 'the backup line survives a sign in');

  const q = device(server, leftover(['EBP01-003']));
  await q.signIn('s@x.com'); await run(3000);
  assert.deepEqual(q.cards(), { 'EBP01-004': 1 }, 'a stranger sees only their own account');
  assert.ok(q.ls.json('palvault-stash:?').state, 'the leftover is kept apart');
  q.ctx.joinLegacy(); await run(3000);                     // the Account page button, after its confirm
  assert.deepEqual(serverCards(server, 's@x.com'), { 'EBP01-003': 1, 'EBP01-004': 1 });
  assert.equal(q.ls.getItem('palvault-stash:?'), null);
  noErrors(p, q);
});

flow('an older app that dropped the follows from the server is put right by the next pull', async () => {
  const server = new FakeServer(); server.account('a@x.com');
  const p = device(server);
  await p.signIn('a@x.com');
  p.ctx.toggleStockAlert('box-bp02'); await run(3000);
  const a = server.accounts['a@x.com'];
  delete a.blob.alerts; a.rev++;                            // a 2.4.1 merge pushed a blob without the record
  p.reboot(); await run(3000);
  assert.deepEqual(serverFollows(server, 'a@x.com'), ['box-bp02'], 'back on the server');
  // and a stale write back of a follow that was removed loses to the unfollow
  p.ctx.toggleStockAlert('box-bp02'); await run(3000);
  a.blob.alerts.stock['box-bp02'] = { on: true, at: 1 }; a.rev++;
  p.reboot(); await run(3000);
  assert.deepEqual(serverFollows(server, 'a@x.com'), []);
  assert.deepEqual(p.follows(), []);
  noErrors(p);
});

flow('two phones: a 409 merges settings so each keeps only what it changed', async () => {
  const server = new FakeServer(); server.account('a@x.com');
  const p = device(server), t = device(server);
  await p.signIn('a@x.com'); await t.signIn('a@x.com'); await run(3000);
  p.reboot(); await run(3000);                              // both agree on the same copy
  p.ctx.SETTINGS.ebayRegion = 'de'; p.ctx.saveSettings(); await run(3000);      // the phone changes the market
  t.ctx.SETTINGS.defaultGrader = 'CGC'; t.ctx.saveSettings(); await run(3000);  // the tablet, still behind, changes the grader
  p.reboot(); await run(3000);
  const acct = server.accounts['a@x.com'].blob._acct;
  assert.equal(acct.ebayRegion, 'de');
  assert.equal(acct.defaultGrader, 'CGC');
  assert.equal(p.ctx.SETTINGS.defaultGrader, 'CGC');
  assert.equal(t.ctx.SETTINGS.ebayRegion, 'de');
  // and two phones that agree do not keep pushing at each other
  const rev = server.accounts['a@x.com'].rev;
  p.reboot(); t.reboot(); await run(3000);
  assert.equal(server.accounts['a@x.com'].rev, rev, 'no push loop');
  noErrors(p, t);
});

flow('stock alerts switched off by hand stay off for follows that arrive from another phone', async () => {
  const server = new FakeServer(); server.account('a@x.com');
  const p = device(server), t = device(server);
  await p.signIn('a@x.com'); await t.signIn('a@x.com');
  // the Settings switch, as its onchange sets it
  t.ctx.SETTINGS.notif.stock = false; t.ctx.SETTINGS.notif.stockOff = true; t.ctx.saveSettings();
  p.ctx.toggleStockAlert('ss-vol1'); await run(3000);
  t.reboot(); await run(3000);
  assert.deepEqual(t.follows(), ['ss-vol1'], 'the follow arrived');
  assert.equal(t.ctx.SETTINGS.notif.stock, false, 'but this device stays off');
  assert.equal(t.lastPrefs().stock, false);
  assert.match(t.ctx.stockAlertBtn({ id: 'ss-vol1' }), /Following, alerts off here/);
  assert.equal(t.ctx.toggleStockAlert('ss-vol1'), true, 'a tap turns this device on and keeps the follow');
  assert.deepEqual(t.follows(), ['ss-vol1']);
  assert.match(t.ctx.stockAlertBtn({ id: 'ss-vol1' }), /Stock alerts on/);
  // a phone that never touched its switch starts alerting
  const u = device(server); await u.signIn('a@x.com'); await run(3000);
  assert.equal(u.ctx.SETTINGS.notif.stock, true);
  assert.deepEqual(u.lastPrefs().stockWatch, ['ss-vol1']);
  noErrors(p, t, u);
});

flow('price alerts follow the account; past 30 the oldest are shown as paused, and the limit counts them all', async () => {
  const server = new FakeServer(); server.account('a@x.com');
  const p = device(server);
  await p.signIn('a@x.com');
  for (let i = 1; i <= 3; i++) { p.ctx.addPriceAlert({ id: 'EBP01-001', k: 'above', v: 10 * i, b: 5, r: 'co.uk', m: 'live', c: 'GBP', at: CLOCK.t }); CLOCK.t += 10; }
  await run(3000);
  assert.equal(p.ctx.priceWatch().length, 3);
  assert.equal(p.lastPrefs().priceWatch.length, 3);
  const t = device(server); await t.signIn('a@x.com'); await run(3000);
  assert.equal(t.ctx.priceWatch().length, 3, 'they come back on another phone');
  assert.equal(t.ctx.SETTINGS.notif.price, true);
  const k = t.ctx.priceOnList(t.ctx.STATE.alerts)[0].key;
  t.ctx.removePriceAlertKey(k); await run(3000);
  t.ctx.removePriceAlertKey(k);                             // a row tapped twice, or already removed elsewhere
  p.reboot(); await run(3000);
  assert.equal(p.ctx.priceWatch().length, 2, 'a removal syncs too');
  // more than 30 on the record (a union of two phones' old lists): only the newest 30 are sent
  const rec = p.ctx.alertRec();
  for (let i = 0; i < 31; i++) rec.price['EBP01-002|below|' + (i + 1) + '|co.uk|live'] = { on: true, at: 1790000000000 + i, a: { id: 'EBP01-002', k: 'below', v: i + 1, b: 50, r: 'co.uk', m: 'live' } };
  assert.equal(p.ctx.sentPriceAlerts().length, 30);
  assert.equal(p.ctx.priceOnList(rec).length, 33);
  noErrors(p, t);
});

flow('the update moves follows into the record once, and marks them to sync', async () => {
  const server = new FakeServer(); server.account('a@x.com', null, { cols: [{ id: 'cA', name: 'Main', own: {} }], active: 'cA' }, 3);
  const old = new FakeStorage({
    'palvault-v1': J({ cols: [{ id: 'cA', name: 'Main', own: { 'EBP01-001': { qty: 1, graded: [] } } }], active: 'cA', wishlist: {}, fav: {} }),
    'palvault-settings': J({ notif: { releases: true, news: true, newSets: true, stock: false, stockWatch: ['box-bp02', 7, ''], price: true,
      priceWatch: [{ id: 'EBP01-001', k: 'above', v: 50, b: 31.5, r: 'co.uk', m: 'live', c: 'GBP', at: 1 }, { id: 'GONE-001', k: 'above', v: 5, b: 1, r: 'co.uk', m: 'live' }, { junk: 1 }] } }),
    'palvault-auth': J({ token: 'stale', email: 'A@x.com', serverRev: 3, dirty: false }),
  });
  server.tokens.stale = 'a@x.com';
  const p = device(server, old);
  assert.deepEqual(p.follows(), ['box-bp02']);
  assert.equal(p.ctx.priceWatch().length, 2, 'an alert for a card this build does not know is kept, not dropped');
  assert.equal(p.ctx.SETTINGS.notif.stockOff, true, 'stock was off beside a list: off by hand');
  assert.equal(p.ctx.SETTINGS.notif.priceOff, undefined);
  assert.deepEqual(p.ls.json('palvault-settings').notif.stockWatch, [], 'the device lists are emptied');
  assert.equal(p.owner(), 'a@x.com', 'the copy is tagged with its signed in owner');
  assert.deepEqual(p.prefs[0].stockWatch, ['box-bp02'], 'the very first prefs carry the moved follows');
  await run(3000);
  assert.deepEqual(serverFollows(server, 'a@x.com'), ['box-bp02'], 'and they reach the account');
  assert.deepEqual(serverCards(server, 'a@x.com'), { 'EBP01-001': 1 });
  const rec = J(p.ctx.STATE.alerts);
  p.reboot();
  assert.equal(J(p.ctx.STATE.alerts), rec, 'a second launch changes nothing');
  assert.equal(p.ctx.ALERTS_MOVED, false);
  noErrors(p);
});

test('the migration waits for a disk that has room, and never empties the lists first', () => {
  const store = new FakeStorage({ 'palvault-settings': J({ notif: { stock: true, stockWatch: ['box-bp02'], price: false, priceWatch: [] } }) });
  store.full.add('palvault-v1');                            // the big value does not fit; the small settings one still would
  const p = device(new FakeServer(), store);
  assert.deepEqual(p.ls.json('palvault-settings').notif.stockWatch, ['box-bp02'], 'still on disk, so the next launch tries again');
  assert.deepEqual(p.follows(), ['box-bp02'], 'and this session still alerts for it');
  store.full.clear();
  const q = device(new FakeServer(), store);
  assert.deepEqual(q.follows(), ['box-bp02'], 'the next launch moves it');
  assert.deepEqual(q.ls.json('palvault-settings').notif.stockWatch, []);
  noErrors(p);
});

flow('deleting the account keeps the collection on the device, for the next account to take in', async () => {
  const server = new FakeServer(); server.account('a@x.com'); server.account('b@x.com');
  const p = device(server);
  await p.signIn('a@x.com'); await p.add('EBP01-001');
  p.ctx.api('/api/account', 'DELETE').then((r) => { if (r.ok) p.ctx.deleteAccountDone(); }); await run(100);
  assert.equal(p.signedIn(), null);
  assert.equal(p.owner(), '', 'the data is this device\'s own again');
  await p.signIn('b@x.com'); await run(3000);
  assert.deepEqual(serverCards(server, 'b@x.com'), { 'EBP01-001': 1 }, 'as the delete note says');
  noErrors(p);
});

flow('sign out first sends what is not synced; offline, it keeps the copy marked unsynced', async () => {
  const server = new FakeServer(); server.account('a@x.com');
  const p = device(server);
  await p.signIn('a@x.com');
  p.ctx.addCard('EBP01-001', 1);                            // a push is pending
  p.ctx.signOut();
  assert.equal(p.ctx.SIGNING_OUT, true, 'waits for the push');
  p.ctx.signOut();                                          // a second tap does nothing
  await run(10000);
  assert.equal(p.ctx.SIGNING_OUT, false);
  assert.deepEqual(serverCards(server, 'a@x.com'), { 'EBP01-001': 1 });
  assert.equal(p.ctx.loc().dirty, false);
  assert.ok(p.toasts.indexOf('Signed out (data stays on this device)') >= 0);
  await p.signIn('a@x.com');
  p.ctx.navigator.onLine = false;
  await p.add('EBP01-002');
  await p.signOut();
  assert.equal(p.ctx.loc().dirty, true);
  assert.match(p.toasts[p.toasts.length - 1], /sync the next time you sign in here/);
  noErrors(p);
});

test('a session whose data belongs to someone else ends at startup, and a failed startup check ends it too', () => {
  const store = new FakeStorage({
    'palvault-v1': J({ cols: [{ id: 'c1', name: 'B', own: {} }], active: 'c1', _local: { v: 1, email: 'b@x.com', rev: 2, dirty: false } }),
    'palvault-auth': J({ token: 'tA', email: 'a@x.com', serverRev: 4, dirty: false }),
  });
  const p = device(new FakeServer(), store);
  assert.equal(p.ctx.AUTH.token, undefined, 'signed out');
  assert.equal(p.ctx.AUTH.expired, true);
  assert.equal(p.owner(), 'b@x.com', 'the data stays with its owner');
  const q = device(new FakeServer(), new FakeStorage({ 'palvault-auth': J({ token: 'tA', email: 'a@x.com', serverRev: 4 }) }), { throwOnListen: true });
  assert.equal(q.ctx.AUTH.token, undefined, 'bootAccounts threw, so the session ended rather than risk a merge');
  assert.ok(q.errors.some((e) => /^bootAccounts/.test(e)), 'and it was reported');
});

flow('web: another tab signing in makes this one stop writing and reload', async () => {
  const server = new FakeServer(); server.account('a@x.com');
  const p = device(server, null, { native: false });
  await p.signIn('a@x.com');
  const l = p.listeners.find((x) => x.type === 'storage');
  l.fn({ key: 'palvault-auth', newValue: J({ token: p.ctx.AUTH.token, serverRev: 9 }) });
  assert.equal(p.ctx.OTHER_TAB, false, 'the same session saving its position is not a switch');
  l.fn({ key: 'palvault-auth', newValue: J({ token: 'someone-else' }) });
  assert.equal(p.ctx.OTHER_TAB, true);
  assert.equal(p.reloads, 1);
  const before = p.ls.getItem('palvault-v1');
  p.ctx.addCard('EBP01-001', 1); await run(3000);
  assert.equal(p.ls.getItem('palvault-v1'), before, 'nothing written from the old tab');
  assert.equal(p.ctx.STATE.alerts, undefined, 'and the web never invents a follows record');
  assert.equal(p.prefs.length, 0, 'or sends push prefs');
  noErrors(p);
});

test('the Account page masks the owner of the data on this device', () => {
  const sb = {}; vm.createContext(sb); vm.runInContext(appFunction('maskEmail'), sb);
  assert.equal(sb.maskEmail('alice@gmail.com'), 'a•••@gmail.com');
  assert.equal(sb.maskEmail('nope'), '•••');
});
