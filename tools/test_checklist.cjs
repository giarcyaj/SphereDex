'use strict';

// Run with: node tools/test_checklist.cjs
// The printable checklist is built in the app, offline, as an ASCII PDF.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');
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
const names = ['pdfWinAnsi', 'pdfEscape', 'pdfNum', 'checklistRows', 'pdfAssemble', 'buildChecklistPdf'];
const sandbox = {};
vm.runInContext(names.map(appFunction).join('\n'), vm.createContext(sandbox));

const cards = [
  { id: 'EBP01-002', name: 'Cattiva', rare: 'C', setIdx: 1, seq: 2 },
  { id: 'EBP01-001', name: 'Lamball \u2013 Pal', rare: 'U', setIdx: 1, seq: 1 }
];
const ownedOf = card => card.id === 'EBP01-001';

test('missing mode drops owned cards and include-owned keeps them, sorted by number', () => {
  const missing = sandbox.checklistRows(cards, 'missing', ownedOf);
  assert.equal(missing.map(row => row.id).join(','), 'EBP01-002');
  const all = sandbox.checklistRows(cards, 'all', ownedOf);
  assert.equal(all.map(row => row.id).join(','), 'EBP01-001,EBP01-002');
  assert.equal(all[0].owned, true);
  assert.equal(all[1].owned, false);
});

test('the PDF is an offline ASCII file, greys owned cards, and offers A4 or Letter', () => {
  const rows = sandbox.checklistRows(cards, 'all', ownedOf);
  const a4 = sandbox.buildChecklistPdf(rows, { paper: 'a4', mode: 'all', title: 'Master set', subtitle: 'Owned greyed' });
  assert.equal(a4.startsWith('%PDF-1.4\n'), true);
  assert.equal(a4.trimEnd().endsWith('%%EOF'), true);
  assert.ok([...a4].every(ch => ch.charCodeAt(0) < 128), 'PDF bytes stay ASCII so a UTF-8 save is unchanged');
  assert.equal(a4.includes('\u2013'), false);
  assert.ok(a4.includes('Lamball - Pal'));
  assert.ok(a4.includes('0.55 0.55 0.55 rg'));
  assert.ok(a4.includes('/MediaBox [0 0 595.28 841.89]'));
  const letter = sandbox.buildChecklistPdf(sandbox.checklistRows(cards, 'missing', ownedOf), { paper: 'letter', mode: 'missing', title: 'Set' });
  assert.ok(letter.includes('/MediaBox [0 0 612 792]'));
  assert.equal(letter.includes('EBP01-001'), false);
  assert.ok(letter.includes('EBP01-002'));
  assert.equal(letter.includes('0.55 0.55 0.55 rg'), false);
});
