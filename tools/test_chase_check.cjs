'use strict';

// Run with: node tools/test_chase_check.cjs
// The "Buying one second hand?" panel on chase card sheets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');
const start = source.indexOf('var CHASE_RARITIES');
const end = source.indexOf('function tdSheetHtml');
assert.ok(start > 0 && end > start, 'chase block exists');
const sb = { esc: (s) => String(s) };
vm.createContext(sb);
vm.runInContext(source.slice(start, end), sb);

test('panel shows only on premium rarities', () => {
  for (const r of ['SSS', 'SSP', 'SP', 'OSR', 'TSP', 'TSR']) assert.ok(sb.chaseCheckApplies({ rare: r }), r);
  for (const r of ['C', 'U', 'R', 'RR', 'SR', 'TD', 'PR']) assert.ok(!sb.chaseCheckApplies({ rare: r }), r);
  assert.equal(sb.chaseCheckHtml({ id: 'X', rare: 'C' }), '');
  assert.match(sb.chaseCheckHtml({ id: 'X', rare: 'SSP' }), /Buying one second hand\?/);
});

test('Ribbuny ETD01-024TSR carries the error print note, other cards do not', () => {
  assert.match(sb.chaseCheckHtml({ id: 'ETD01-024TSR', rare: 'TSR' }), /error print/);
  assert.doesNotMatch(sb.chaseCheckHtml({ id: 'ETD01-001TSR', rare: 'TSR' }), /error print/);
});

test('price verdict only flags an asking price far below recent sold', () => {
  const sold = [100, 110, 90, 100, 100];
  assert.equal(sb.chasePriceVerdict(30, sold), 'far-below');
  assert.equal(sb.chasePriceVerdict(80, sold), 'ok');
  assert.equal(sb.chasePriceVerdict(50, sold), 'ok');
  assert.equal(sb.chasePriceVerdict('', sold), 'unknown');
  assert.equal(sb.chasePriceVerdict(10, [100]), 'unknown');
  assert.equal(sb.chasePriceVerdict(10, []), 'unknown');
});

test('panel copy has no dashes', () => {
  const html = sb.chaseCheckHtml({ id: 'X', rare: 'SSP' }).replace(/<[^>]*>/g, '');
  assert.doesNotMatch(html, /[-–—]/);
});
