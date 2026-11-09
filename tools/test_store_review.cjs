'use strict';

// Run with: node tools/test_store_review.cjs
// The store rating sheet is the platform's own (Play In-App Review, StoreKit). SphereDex may ask
// after a kept scan or a collection milestone, never on the first launch, never after a cancelled
// scan, and at most once per 90 days. The Settings row opens the store page directly. There is no
// "are you enjoying this?" step, and the web build has no bridge so it does nothing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'paldeck.html'), 'utf8');
const gradle = fs.readFileSync(path.join(root, 'app', 'build.gradle.kts'), 'utf8');
const kotlin = fs.readFileSync(path.join(root, 'app', 'src', 'main', 'java', 'app', 'spheredex', 'MainActivity.kt'), 'utf8');
const swift = fs.readFileSync(path.join(root, 'ios', 'SphereDex', 'SphereDex', 'WebViewController.swift'), 'utf8');

const start = source.indexOf('  var REVIEW_KEY=');
const end = source.indexOf('  // The roadmap\'s version history', start);
assert.ok(start > 0 && end > start, 'the review block is in the source');
const slice = source.slice(start, end);
assert.doesNotMatch(slice, /\b(let|const)\s/, 'review block: no let or const');
assert.doesNotMatch(slice, /=>/, 'review block: no arrow functions');
assert.doesNotMatch(slice, /`/, 'review block: no template literals');
assert.doesNotMatch(slice, /\?\.|\?\?|\.includes\(|\.\.\./, 'review block: no ?. ?? includes or spread');

function boot(opts) {
  opts = opts || {};
  const store = {};
  const calls = [];
  const now = { t: opts.now || 1700000000000 };
  const owned = { n: opts.owned || 0 };
  const scrim = { hidden: opts.busy ? false : true };
  const bridge = opts.bridge === false ? undefined : {
    requestReview() { calls.push('request'); },
    openListing() { calls.push('listing'); },
  };
  const sb = {
    window: bridge ? { AndroidReview: bridge } : {},
    lsGet(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    lsSet(k, v) { store[k] = String(v); },
    $(id) { return id === 'scanScrim' || id === 'scanReviewScrim' ? scrim : null; },
    SETTINGS: { scanLoop: false },
    collectionMilestoneCount() { return owned.n; },
    JSON,
    Date: { now() { return now.t; } },
    _calls: calls,
    _store: store,
    _now: now,
    _owned: owned,
    _scrim: scrim,
  };
  vm.createContext(sb);
  vm.runInContext(slice, sb);
  return sb;
}

function sessions(sb, n) {
  for (let i = 0; i < n; i++) sb.reviewNoteLaunch();
}

test('the web build and a missing bridge do nothing', () => {
  const sb = boot({ bridge: false });
  sessions(sb, 3);
  sb.reviewNoteScans(40);
  sb._owned.n = 150;
  sb.reviewWatchOwned(0);
  sb.openStoreListing();
  sb.window.SDScanClosed(false);
  assert.deepEqual(sb._calls, []);
  assert.deepEqual(sb._store, {}, 'no review record is written without a shell');
});

test('the sheet waits for a second launch and for the 10th kept scan', () => {
  const sb = boot();
  sessions(sb, 1);
  for (let i = 0; i < 10; i++) sb.reviewNoteScans(1);
  assert.deepEqual(sb._calls, [], 'ten scans on the first launch do not ask');
  assert.equal(JSON.parse(sb._store['palvault-review']).scans, 10, 'the scans are remembered');

  const carried = boot();
  carried._store['palvault-review'] = sb._store['palvault-review'];
  sessions(carried, 1);
  carried.reviewNoteScans(1);
  assert.deepEqual(carried._calls, ['request'], 'one more kept scan on a later launch asks');

  const fresh = boot();
  sessions(fresh, 2);
  for (let i = 0; i < 9; i++) fresh.reviewNoteScans(1);
  assert.deepEqual(fresh._calls, [], 'nine scans is not enough');
  fresh.reviewNoteScans(1);
  assert.deepEqual(fresh._calls, ['request'], 'the 10th kept scan asks');
});

test('a cancelled scan is not a success, and closing the camera on a miss does not ask', () => {
  const sb = boot();
  sessions(sb, 2);
  sb.reviewNoteScans(0);
  sb.reviewNoteScans(-3);
  sb.window.SDScanClosed(false);
  assert.deepEqual(sb._calls, []);
  assert.equal(JSON.parse(sb._store['palvault-review']).scans, 0);
  const cancel = source.slice(source.indexOf('$("scanCancel").onclick'), source.indexOf('$("scanConfirm").onclick'));
  assert.doesNotMatch(cancel, /reviewNoteScans/, 'Cancel does not count a scan');
});

test('the camera and the check sheet hold the ask until the person is done', () => {
  const sb = boot();
  sessions(sb, 2);
  for (let i = 0; i < 9; i++) sb.reviewNoteScans(1);
  sb.reviewHold = true;
  sb.reviewNoteScans(1);
  assert.deepEqual(sb._calls, [], 'not while the camera is coming back');
  sb.window.SDScanClosed(true);
  assert.deepEqual(sb._calls, [], 'a delivered card opens the check sheet, so this is not the moment');
  sb.reviewHold = true;
  sb.window.SDScanClosed(false);
  assert.deepEqual(sb._calls, ['request'], 'leaving the camera after a kept run asks once');

  const busy = boot();
  sessions(busy, 2);
  busy._scrim.hidden = false;
  for (let i = 0; i < 10; i++) busy.reviewNoteScans(1);
  assert.deepEqual(busy._calls, [], 'not over the open check sheet');
  busy._scrim.hidden = true;
  busy.reviewQuiet();
  assert.deepEqual(busy._calls, ['request']);
});

test('a collection milestone asks from 25 cards up, and the first launch only remembers it', () => {
  const first = boot({ owned: 25 });
  sessions(first, 1);
  first.reviewWatchOwned(24);
  assert.deepEqual(first._calls, [], 'not on the first launch');
  assert.equal(JSON.parse(first._store['palvault-review']).mileDue, 1);

  const second = boot();
  second._store['palvault-review'] = first._store['palvault-review'];
  sessions(second, 2);
  second._owned.n = 26;
  second.reviewWatchOwned(25);
  assert.deepEqual(second._calls, ['request'], 'the next success on a later launch asks');

  const early = boot({ owned: 1 });
  sessions(early, 2);
  early.reviewWatchOwned(0);
  assert.deepEqual(early._calls, [], 'the first card is too soon');

  const fresh = boot({ owned: 25 });
  sessions(fresh, 2);
  fresh.reviewWatchOwned(24);
  assert.deepEqual(fresh._calls, ['request']);
  fresh._calls.length = 0;
  fresh._owned.n = 50;
  fresh.reviewWatchOwned(49);
  assert.deepEqual(fresh._calls, [], 'a second milestone inside 90 days does not ask again');
});

test('the same device asks at most once per 90 days', () => {
  const sb = boot();
  sessions(sb, 2);
  for (let i = 0; i < 10; i++) sb.reviewNoteScans(1);
  assert.deepEqual(sb._calls, ['request']);
  sb._now.t += 10 * 24 * 60 * 60 * 1000;
  sb.reviewNoteScans(1);
  assert.deepEqual(sb._calls, ['request'], 'ten days later is still inside the gap');
  sb._now.t += 91 * 24 * 60 * 60 * 1000;
  sb.reviewNoteScans(1);
  assert.deepEqual(sb._calls, ['request', 'request'], 'after 90 days a new success may ask again');
});

test('the Settings row opens the store page and does not call the in app sheet', () => {
  const sb = boot();
  sb.openStoreListing();
  assert.deepEqual(sb._calls, ['listing']);
  const row = source.slice(source.indexOf('id="rateSetRow"'), source.indexOf('Privacy policy'));
  assert.match(row, /Rate SphereDex/);
  assert.match(row, /hidden/);
  assert.match(row, /Opens the store page so you can leave a rating\./);
  assert.doesNotMatch(row, /[-‐-―]/, 'no hyphens or dashes in the row');
  assert.doesNotMatch(row, /enjoying/i, 'the row does not ask whether someone is enjoying the app');
  assert.match(source, /rb\.onclick=function\(\)\{ openStoreListing\(\); \}/);
  const cap = source.slice(source.indexOf('var cap=$("rateCap")'), source.indexOf('function openSetSphere'));
  assert.doesNotMatch(cap, /Enjoying SphereDex/);
  assert.match(cap, /Rate SphereDex on the/);
});

test('Android uses the Play review library and a market:// listing with an https fallback', () => {
  assert.match(gradle, /com\.google\.android\.play:review-ktx:2\.0\.2/);
  assert.match(kotlin, /ReviewManagerFactory/);
  assert.match(kotlin, /addJavascriptInterface\(ReviewBridge\(\), "AndroidReview"\)/);
  assert.match(kotlin, /fun requestReview\(\)/);
  assert.match(kotlin, /fun openListing\(\)/);
  assert.match(kotlin, /market:\/\/details\?id=/);
  assert.match(kotlin, /https:\/\/play\.google\.com\/store\/apps\/details\?id=/);
  assert.match(kotlin, /window\.SDScanClosed && window\.SDScanClosed/);
});

test('iOS uses StoreKit on the 15 deployment target and the write-review page from Settings', () => {
  const spec = fs.readFileSync(path.join(root, 'ios', 'SphereDex', 'project.yml'), 'utf8');
  assert.match(spec, /iOS: "15\.0"/);
  assert.match(swift, /import StoreKit/);
  assert.match(swift, /AppStore\.requestReview\(in: scene\)/);
  assert.match(swift, /SKStoreReviewController\.requestReview\(in: scene\)/);
  assert.match(swift, /https:\/\/apps\.apple\.com\/app\/id6804377686\?action=write-review/);
  assert.match(swift, /name: "sdreview"/);
  assert.match(swift, /window\.AndroidReview = \{/);
  assert.match(swift, /requestReview: function \(\) \{ try \{ window\.webkit\.messageHandlers\.sdreview\.postMessage\('request'\)/);
  assert.match(swift, /openListing: function \(\) \{ try \{ window\.webkit\.messageHandlers\.sdreview\.postMessage\('listing'\)/);
  assert.match(swift, /window\.SDScanClosed && window\.SDScanClosed/);
  assert.doesNotMatch(swift, /requestStoreReview\(\)[\s\S]{0,80}openWriteReview/, 'the listing path is not the in app sheet');
});
