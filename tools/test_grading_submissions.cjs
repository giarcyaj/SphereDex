'use strict';

// Run with: node tools/test_grading_submissions.cjs
// Grading submissions: raw copies sent to a grader stay counted, show as At the grader, and become a slab
// (with the grading fee added to what was paid) when logged as returned.
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
const names = ['rawCount', 'rawEditionKey', 'rawCounts', 'rawKnownTotal', 'setRawCounts', 'changeRaw', 'paidNumber',
  'awayDate', 'awayClean', 'awayList', 'setAway', 'sendForGrading', 'returnFromGrader', 'mergeEntry', 'slabSig', 'cloneSlab', 'mergeRawCounts'];
function load() {
  const ctx = vm.createContext({
    GRADERS: ['PSA', 'BGS', 'CGC', 'SGC', 'HGA', 'GMA', 'ACE', 'TAG', 'Other'],
    RAW_KNOWN: ['1', '2', 'jp', 'cn'], RAW_LANGS: { jp: 1, cn: 1 },
    copyNoteClean: () => null, Object, Array, Math, JSON, Date, Number, String,
  });
  let code = '';
  for (const n of names) { try { code += appFunction(n) + '\n'; } catch (e) { if (n !== 'mergeRawCounts') throw e; } }
  vm.runInContext(code, ctx);
  return ctx;
}
const A = load();

test('sending keeps the copy counted and marks it away', () => {
  const e = { qty: 2, graded: [] };
  assert.equal(A.sendForGrading(e, { grader: 'PSA', svc: 'Regular', sent: '2026-10-01', due: '2026-12-01', fee: 25 }), true);
  assert.equal(e.qty, 2);
  assert.equal(A.awayList(e).length, 1);
  assert.equal(A.awayList(e)[0].fee, 25);
});

test('cannot send more copies than are at home', () => {
  const e = { qty: 1, graded: [] };
  assert.equal(A.sendForGrading(e, { grader: 'PSA' }), true);
  assert.equal(A.sendForGrading(e, { grader: 'PSA' }), false);
  assert.equal(A.awayList(e).length, 1);
});

test('away rows never outnumber the raw copies left', () => {
  const e = { qty: 2, graded: [], away: [{ grader: 'PSA' }, { grader: 'BGS' }] };
  e.qty = 1;
  assert.equal(A.awayList(e).length, 1);
});

test('return turns a raw copy into a slab and carries paid plus fee', () => {
  const e = { qty: 2, graded: [], paidRaw: { unknown: 10 } };
  A.sendForGrading(e, { grader: 'PSA', fee: 25 });
  const slab = A.returnFromGrader(e, 0, '10', 80, true);
  assert.equal(e.qty, 1);
  assert.equal(e.graded.length, 1);
  assert.equal(slab.grader, 'PSA'); assert.equal(slab.grade, '10'); assert.equal(slab.value, 80);
  assert.equal(slab.paid, 35);
  assert.equal(A.awayList(e).length, 0);
  assert.equal(e.away, undefined);
});

test('return does not invent a paid amount when none is tracked', () => {
  const e = { qty: 1, graded: [] };
  A.sendForGrading(e, { grader: 'CGC' });
  assert.equal('paid' in A.returnFromGrader(e, 0, '9', 0, true), false);
  const f = { qty: 1, graded: [], paidRaw: { unknown: 5 } };
  A.sendForGrading(f, { grader: 'CGC', fee: 20 });
  assert.equal('paid' in A.returnFromGrader(f, 0, '9', 0, false), false);
});

test('return keeps the printing', () => {
  const e = { qty: 1, graded: [], rawEditions: { '1': 1, '2': 0, unknown: 0 } };
  assert.equal(A.sendForGrading(e, { grader: 'PSA', ed: '1' }), true);
  assert.equal(A.returnFromGrader(e, 0, '10', 0, true).edition, '1');
  assert.equal(e.qty, 0);
});

test('bad input is cleaned', () => {
  const x = A.awayClean({ grader: 'Nope', sent: 'soon', fee: -3, svc: '  Express  ' });
  assert.equal(x.grader, 'Other'); assert.equal(x.sent, undefined); assert.equal(x.fee, undefined); assert.equal(x.svc, 'Express');
  assert.equal(A.returnFromGrader({ qty: 1 }, 0, '10', 0, true), null);
});

test('merging two devices keeps rows only one wrote', () => {
  const a = { qty: 1, graded: [], away: [{ grader: 'PSA', sent: '2026-10-01' }] };
  const b = { qty: 1, graded: [] };
  assert.equal(A.mergeEntry(a, b).away.length, 1);
  assert.equal(A.mergeEntry(b, a).away.length, 1);
  assert.equal(A.mergeEntry(a, a).away.length, 1);
});

test('a return builds on pending slab edits, never on the older saved list', () => {
  // The card sheet edits a working copy of the slabs (gwork). The Returned handler must write that copy into
  // the holding before it appends the new slab, or unsaved edits and removals come back.
  const at = source.indexOf('id="awayRetOk"') >= 0 ? source.indexOf('b=$("awayRetOk"))) b.onclick') : -1;
  assert.ok(at > 0, 'Returned handler exists');
  const body = source.slice(at, at + 1400);
  const sync = body.indexOf('s.graded=gwork.');
  const ret = body.indexOf('returnFromGrader(');
  assert.ok(sync > 0 && ret > sync, 'slabs are synced from gwork before returnFromGrader runs');
});
