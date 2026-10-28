'use strict';

// Run with: node tools/test_sw_update.cjs
// Safari rejects registration.update() with "newestWorker is null" when the registration has no
// worker yet. The update promise must be returned into the chain that has the .catch, otherwise
// the rejection is unhandled and shows up as an app error report.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');

test('every registration.update() call is returned into a catch chain', () => {
  const calls = src.split('\n').filter(l => /getRegistration\(\)/.test(l) || /\b(r|reg)\.update\(\)/.test(l));
  const updates = src.match(/[^\n]*\b(r|reg)\.update\(\)[^\n]*/g) || [];
  assert.ok(updates.length >= 2, 'found the update call sites');
  for (const l of updates) {
    assert.match(l, /return (r|reg)\.update\(\)/, 'update promise is returned: ' + l.trim());
    assert.match(l, /\}\)\.catch\(/, 'chain ends in catch: ' + l.trim());
  }
  assert.ok(calls.length);
});
