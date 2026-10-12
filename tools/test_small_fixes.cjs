'use strict';

// Run with: node tools/test_small_fixes.cjs
// Guards for the small 2.4.2 fixes outside the sync logic: the shop list that snapped shut, the switches
// that said on while the phone blocked every alert, the doubled Android cold start registration and the
// iOS token that rode along in a backup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'paldeck.html'), 'utf8');
const ACTIVITY = fs.readFileSync(path.join(root, 'app', 'src', 'main', 'java', 'app', 'spheredex', 'MainActivity.kt'), 'utf8');
const SWIFT = fs.readFileSync(path.join(root, 'ios', 'SphereDex', 'SphereDex', 'WebViewController.swift'), 'utf8');

function appFunction(name) {
  const m = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(m, 'App function exists: ' + name);
  for (let e = source.indexOf('}', m.index); e >= 0; e = source.indexOf('}', e + 1)) {
    const d = source.slice(m.index, e + 1);
    try { new vm.Script('(' + d + ')'); return d; } catch (_) { /* keep looking */ }
  }
  throw new Error('Could not extract ' + name);
}
function es5(code, label) {
  assert.doesNotMatch(code, /\b(let|const)\s/, label + ': no let or const');
  assert.doesNotMatch(code, /=>/, label + ': no arrow functions');
  assert.doesNotMatch(code, /`/, label + ': no template literals');
  assert.doesNotMatch(code, /\?\.|\?\?|\.includes\(|\.\.\./, label + ': no ?. ?? includes or spread');
}

// ---- the shop list keeps its open state -----------------------------------------------------------
// Just enough DOM for #sdStock: setting innerHTML builds a fresh, closed list, the way the browser does.
function stockBox(pid) {
  const box = { attrs: { 'data-pid': pid }, rest: null, btn: null, html: '' };
  box.getAttribute = (k) => (k in box.attrs ? box.attrs[k] : null);
  Object.defineProperty(box, 'innerHTML', {
    get() { return box.html; },
    set(v) {
      box.html = v;
      box.rest = /sdrest/.test(v) ? { hidden: true } : null;
      box.btn = /sdmore/.test(v) ? {
        onclick: null, aria: 'false', setAttribute(k, val) { if (k === 'aria-expanded') this.aria = val; },
        firstChild: { textContent: '▾' }, lastChild: { firstChild: { nodeType: 3, nodeValue: 'Show the ' } },
      } : null;
    },
  });
  box.querySelector = (sel) => (sel === '.sdrest' ? box.rest : sel === '.sdmore' ? box.btn : null);
  return box;
}
function paintSandbox(html) {
  const els = {};
  const sb = { els, $: (id) => els[id] || null, stockGlanceHtml: () => html, String };
  vm.createContext(sb);
  vm.runInContext(['stockShopsOpen', 'wireStockShops', 'stockPaint'].map(appFunction).join('\n'), sb);
  return sb;
}
const WITH_REST = '<p class="sdstock in"></p><ul class="sdshops"></ul><ul class="sdshops sdrest" hidden></ul><button class="sdmore"></button>';

test('a stock reading that lands after the list was opened leaves it open', () => {
  const sb = paintSandbox(WITH_REST);
  const box = stockBox('box-ebp01'); sb.els.sdStock = box;
  box.innerHTML = WITH_REST; sb.wireStockShops();
  box.btn.onclick();                                   // the person opens the list
  assert.equal(box.rest.hidden, false);
  assert.equal(sb.stockPaint('box-ebp01', false), true);   // then the fetch lands and repaints
  assert.equal(box.rest.hidden, false, 'still open after the repaint');
  assert.equal(box.btn.aria, 'true');
  assert.equal(box.btn.lastChild.firstChild.nodeValue, 'Hide the ', 'and the button says Hide');
});

test('a list nobody opened stays closed after a repaint', () => {
  const sb = paintSandbox(WITH_REST);
  const box = stockBox('box-ebp01'); sb.els.sdStock = box;
  box.innerHTML = WITH_REST; sb.wireStockShops();
  sb.stockPaint('box-ebp01', false);
  assert.equal(box.rest.hidden, true);
  assert.equal(box.btn.lastChild.firstChild.nodeValue, 'Show the ');
});

test('another product never inherits the open list', () => {
  const sb = paintSandbox(WITH_REST);
  const box = stockBox('box-ebp01'); sb.els.sdStock = box;
  box.innerHTML = WITH_REST; sb.wireStockShops(); box.btn.onclick();
  assert.equal(sb.stockShopsOpen('pack-ebp01'), false);
  assert.equal(sb.stockShopsOpen('box-ebp01'), true);
});

test('a repaint with no other shops left draws no button and does not throw', () => {
  const sb = paintSandbox('<p class="sdstock in"></p><ul class="sdshops"></ul>');
  const box = stockBox('box-ebp01'); sb.els.sdStock = box;
  box.innerHTML = WITH_REST; sb.wireStockShops(); box.btn.onclick();
  assert.equal(sb.stockPaint('box-ebp01', false), true);
  assert.equal(box.rest, null);
});

test('both sheets rebuild with the list the way it was', () => {
  const fn = appFunction('openSealedDetail');
  assert.match(fn, /var keepShops=scrim\.classList\.contains\("open"\) && stockShopsOpen\(p\.id\);/, 'read before the sheet is rebuilt');
  assert.equal((fn.match(/wireStockShops\(keepShops\);/g) || []).length, 2, 'the pre order sheet and the released sheet');
  assert.doesNotMatch(fn, /wireStockShops\(\);/);
  assert.ok(fn.indexOf('keepShops') < fn.indexOf('$("mMain").innerHTML'), 'read before mMain is replaced');
});

test('the new shop list code is ES5', () => {
  ['stockShopsOpen', 'wireStockShops', 'stockPaint'].forEach((n) => es5(appFunction(n), n));
});

// ---- notifications the phone blocks ---------------------------------------------------------------
function notifSandbox(native) {
  const els = {
    notifOsOff: { hidden: true },
    sdStockNote: { hidden: true, getAttribute: (k) => (k === 'data-on' ? '1' : null) },
  };
  const sb = {
    window: native ? { AndroidPush: { setPrefs() {} } } : {},
    els, $: (id) => els[id] || null,
    // Since 2.4.2 a followed product lives in the synced record (STATE.alerts), not in notif.stockWatch.
    SETTINGS: { notif: { stock: true } },
    STATE: { alerts: { v: 1, stock: { 'box-ebp01': { on: true, at: 1790000000000 } }, price: {} } },
    ALERT_AT_MAX: 4102444800000,
    STOCK_TRACKED: { 'co.uk': ['box-ebp01'] },
    ebayReg: () => 'co.uk',
    icon: () => '', esc: (s) => String(s),
  };
  vm.createContext(sb);
  const slice = source.slice(source.indexOf('  function nativePushIface()'), source.indexOf('  function toggleStockAlert('));
  // only the declarations the note needs, not the weekly recap helpers in between
  const want = ['nativePushIface', 'plainObj', 'alertAt', 'alertEntOk', 'stockOnList', 'stockAlertOn', 'notifBlocked', 'paintNotifOs', 'stockAlertNote', 'stockAlertToast', 'stockAlertBtn'];
  vm.runInContext(want.map(appFunction).join('\n'), sb);
  vm.runInContext(/var NOTIF_OS_OK=null;/.exec(slice)[0] + /var NOTIF_OFF_NOTE="[^"]+";/.exec(slice)[0] +
    /window\.SDNotifPerm=function\(ok\)\{[^\n]+/.exec(slice)[0], sb);
  return sb;
}

test('nothing changes until the phone has said', () => {
  const sb = notifSandbox(true);
  assert.equal(sb.notifBlocked(), false);
  assert.match(sb.stockAlertNote({ id: 'box-ebp01' }), / hidden /, 'the sheet note starts hidden');
  assert.equal(sb.stockAlertToast(true, false), "You'll be notified when this is in stock.");
  assert.equal(sb.stockAlertToast(true, true), "You'll be notified when you can pre order this.");
  assert.equal(sb.stockAlertToast(false, false), 'Stock alert removed.');
});

test('a phone that blocks notifications gets the note on Settings and on the sheet', () => {
  const sb = notifSandbox(true);
  sb.window.SDNotifPerm(false);
  assert.equal(sb.notifBlocked(), true);
  assert.equal(sb.els.notifOsOff.hidden, false, 'the Settings note shows');
  assert.equal(sb.els.sdStockNote.hidden, false, 'and the open sheet note for a followed product');
  assert.doesNotMatch(sb.stockAlertNote({ id: 'box-ebp01' }), / hidden /);
  assert.match(sb.stockAlertToast(true, false), /phone settings/, 'the toast does not promise an alert that cannot arrive');
  sb.window.SDNotifPerm(true);
  assert.equal(sb.els.notifOsOff.hidden, true, 'turning them back on hides it again');
  assert.equal(sb.els.sdStockNote.hidden, true);
});

test('only a real true or false counts, and the web never shows the note', () => {
  const sb = notifSandbox(true);
  sb.window.SDNotifPerm('false');
  assert.equal(sb.notifBlocked(), false, 'a string is not an answer');
  sb.window.SDNotifPerm(null);
  assert.equal(sb.notifBlocked(), false);
  const web = notifSandbox(false);
  web.window.SDNotifPerm(false);
  assert.equal(web.notifBlocked(), false, 'no push bridge, no note');
  assert.equal(web.stockAlertNote({ id: 'box-ebp01' }), '', 'and no note markup at all');
});

test('the Settings note is in the page, hidden until the phone says otherwise', () => {
  assert.match(source, /<div class="sdesc" id="notifOsOff" hidden /);
});

test('the new copy has no dashes and the new code is ES5', () => {
  const slice = source.slice(source.indexOf('var NOTIF_OS_OK=null;'), source.indexOf('  function toggleStockAlert('));
  es5(slice, 'notification note');
  const strings = (slice.match(/"[^"]*"/g) || []).filter((s) => /[a-z] [a-z]/i.test(s) && !/[:;=<]/.test(s));
  assert.ok(strings.length >= 5, 'the note and the toasts were found (' + strings.length + ')');
  strings.forEach((s) => assert.doesNotMatch(s, /[-‐-―]/, 'no dash in ' + s));
  const note = /id="notifOsOff"[^>]*>([^<]+)</.exec(source)[1];
  assert.doesNotMatch(note, /[-‐-―]/);
});

test('SDNotifPerm is defined at the top level, so a shell calling it after load always finds it', () => {
  // It is assigned where the push helpers are, long before the AUTH block, and reads nothing that is
  // assigned later: the 2.4.1 blank app came from exactly that kind of ordering.
  const at = source.indexOf('window.SDNotifPerm=function');
  assert.ok(at > 0 && at < source.indexOf('var AUTH = (function(){'));
  assert.doesNotMatch(appFunction('paintNotifOs'), /AUTH|STATE/);
});

test('Android reports the phone setting after the page loads and on every resume', () => {
  assert.match(ACTIVITY, /NotificationManagerCompat\.from\(this\)/);
  assert.match(ACTIVITY, /areNotificationsEnabled\(\)/, 'the Android 13 permission and the app switch');
  assert.match(ACTIVITY, /getNotificationChannel\(Push\.CHANNEL_ID\)\?\.importance != NotificationManager\.IMPORTANCE_NONE/, 'and the channel every alert uses');
  assert.match(ACTIVITY, /if \(!pageLoaded\) return/, 'never into a page that has not loaded');
  assert.match(ACTIVITY, /window\.SDNotifPerm && window\.SDNotifPerm\(\$\{notificationsAllowed\(\)\}\)/);
  const resume = ACTIVITY.slice(ACTIVITY.indexOf('override fun onResume()'), ACTIVITY.indexOf('override fun onNewIntent'));
  assert.match(resume, /reportNotificationsAllowed\(\)/);
  const finished = ACTIVITY.slice(ACTIVITY.indexOf('override fun onPageFinished'), ACTIVITY.indexOf('// Make window.prompt'));
  assert.match(finished, /reportNotificationsAllowed\(\)/);
});

test('iOS reports the phone setting after the page loads and whenever the app comes to the front', () => {
  assert.match(SWIFT, /^import UserNotifications$/m);
  assert.match(SWIFT, /UIApplication\.didBecomeActiveNotification/);
  assert.match(SWIFT, /getNotificationSettings/);
  assert.match(SWIFT, /case \.denied: arg = "false"/);
  assert.match(SWIFT, /PushRouter\.shared\.pageReady\(\)\s+reportNotificationsAllowed\(\)/);
});

// ---- Android cold start --------------------------------------------------------------------------
test('an Android cold start registers once natively, not twice', () => {
  const create = ACTIVITY.slice(ACTIVITY.indexOf('override fun onCreate('), ACTIVITY.indexOf('override fun onResume()'));
  assert.doesNotMatch(create, /Push\.fetchAndRegister\(this\)/, 'onCreate goes through the resume throttle');
  assert.match(create, /Push\.refreshOnResume\(this\)/);
  assert.equal((ACTIVITY.match(/Push\.refreshOnResume\(this\)/g) || []).length, 2, 'onCreate and onResume');
});

// ---- sealed art that only lived on the website -----------------------------------------------------
test('every sealed picture the bundled image list names is baked in, and its product points at it', () => {
  const built = fs.readFileSync(path.join(root, 'docs', 'app', 'index.html'), 'utf8');
  const line = built.slice(built.indexOf('window.CARD_IMG='), built.indexOf('};', built.indexOf('window.CARD_IMG=')) + 1);
  const cardImg = JSON.parse(line.slice('window.CARD_IMG='.length));
  const fb = JSON.parse(/var SEALED_IMAGES_FALLBACK = (\{.*\});/.exec(source)[1]);
  const sealedSrc = source.slice(source.indexOf('var SEALED = ['), source.indexOf('];', source.indexOf('var SEALED = [')));
  fb.products.forEach((e) => {
    ['box', 'banner'].forEach((field) => {
      if (!e[field]) return;
      const key = e[field].slice(e[field].lastIndexOf('/') + 1, -5);
      assert.equal(cardImg[key], 'img/' + key + '.webp', key + ' is in the baked map');
      assert.ok(fs.existsSync(path.join(root, 'docs', 'app', 'img', key + '.webp')), key + ' file is baked');
      const row = sealedSrc.split('\n').some((l) => l.indexOf('{ id:"' + e.id + '",') >= 0 && l.indexOf(' ' + field + ':"' + key + '"') >= 0);
      assert.ok(row, e.id + ' points its ' + field + ' at ' + key + ', or the feed rule leaves the tile blank');
    });
  });
});
