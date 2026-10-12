'use strict';

// Run with: node tools/test_release_startup.cjs
// Issue 39: applyReleased() runs at startup and sealShipped reads _MONIX. The month table is a
// `var`, so a copy that assigns it one statement later is hoisted as undefined and the first
// October pre order throws TypeError: Cannot read properties of undefined (reading 'oct').
// The stock glance suite extracts those functions into a sandbox that already has _MONIX, so it
// never sees the real load order. This runs the built page's own script, in order, with no table
// planted in the sandbox.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const builtPath = path.join(root, 'docs', 'app', 'index.html');

// From the sealed catalogue through whichever comes last: the _MONIX assignment, or the
// startup applyReleased() call. That is the order the page actually runs.
function startupSlice(html) {
  const sealedAt = html.indexOf('var SEALED = [');
  const monixAt = html.indexOf('var _MONIX=');
  const callAt = html.indexOf('\n  applyReleased();');
  assert.ok(sealedAt > 0, 'built page has the sealed catalogue');
  assert.equal(html.indexOf('var _MONIX=', monixAt + 1), -1, '_MONIX is assigned once');
  assert.ok(callAt > 0, 'built page calls applyReleased at startup');
  const start = Math.min(sealedAt, monixAt);
  const end = html.indexOf(';', Math.max(monixAt, callAt)) + 1;
  assert.ok(end > start, 'startup slice has an end');
  return html.slice(start, end);
}

function loadBuiltApp() {
  const html = fs.readFileSync(builtPath, 'utf8');
  const slice = startupSlice(html);
  const store = {};
  const sandbox = {
    window: {},
    lsGet: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    lsSet: function(k, v) { store[k] = String(v); }
  };
  assert.equal(Object.prototype.hasOwnProperty.call(sandbox, '_MONIX'), false, 'the sandbox must not plant _MONIX');
  vm.createContext(sandbox);
  vm.runInContext(slice, sandbox);
  sandbox.store = store;
  return sandbox;
}

test('startup applyReleased reads _MONIX after it is assigned', function() {
  const ctx = loadBuiltApp();
  assert.equal(ctx._MONIX.oct, 9);
  assert.equal(ctx.sealShipped({ date: 'Oct 16, 2024' }), true, 'a past October date is readable');
  assert.equal(ctx.sealShipped({ date: 'Oct 16, 2099' }), false, 'a future October date is readable');
  const october = ctx.SEALED.filter(function(p) {
    return p.preRaw === true && /^Oct\s+\d{1,2},/.test(p.date || '');
  });
  assert.ok(october.length >= 1, 'an October pre order was in the startup pass (' + october.length + ')');
});
