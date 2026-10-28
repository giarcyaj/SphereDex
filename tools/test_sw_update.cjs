'use strict';
// Run with: node tools/test_sw_update.cjs
// Registration.update() rejects with "Failed to update a ServiceWorker ... bad HTTP response code (499)"
// when the script fetch fails. A bare call leaves that rejection unhandled, which the global
// unhandledrejection hook reports as an app error. Every update() call must swallow its promise.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');
test('every registration.update() call has its rejection handled', () => {
  const calls = [...src.matchAll(/\b(?:r|reg)\.update\(\)/g)];
  assert.ok(calls.length >= 2, 'found the update calls');
  assert.equal([...src.matchAll(/var u=(?:r|reg)\.update\(\); if\(u ?&& ?u\.catch\) u\.catch/g)].length, calls.length);
});
