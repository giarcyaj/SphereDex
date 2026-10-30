'use strict';

// Run with: node tools/test_multi_scan.cjs
// Guards the on-device multi-card photo scan in src/paldeck.html: the section stays inside its
// markers, the four shipped copies match, and the detector / matcher behave on synthetic pixels.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const REPO = path.join(__dirname, '..');
const FILES = {
  src: path.join(REPO, 'src', 'paldeck.html'),
  web: path.join(REPO, 'docs', 'app', 'index.html'),
  android: path.join(REPO, 'app', 'src', 'main', 'assets', 'spheredex.html'),
  ios: path.join(REPO, 'ios', 'SphereDex', 'SphereDex', 'Resources', 'spheredex.html'),
};
const BEGIN = 'MULTI SCAN BEGIN (logic';
const END = 'MULTI SCAN END (logic)';

function readSection(file) {
  const text = fs.readFileSync(file, 'utf8');
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  assert.ok(begin >= 0, `${file}: BEGIN marker present`);
  assert.ok(end > begin, `${file}: END marker present after BEGIN`);
  assert.equal(text.indexOf(BEGIN, begin + 1), -1, `${file}: exactly one section`);
  return text.slice(text.lastIndexOf('\n', begin) + 1, end);
}

test('multi-scan logic stays inside its markers in the canonical source', () => {
  const section = readSection(FILES.src);
  assert.match(section, /function detect\(/);
  assert.match(section, /function matchDescriptor\(/);
  assert.match(section, /window\.MULTI_SCAN = MULTI_SCAN/);
});

test('multi-scan definitions never leak outside the marked section', () => {
  const whole = fs.readFileSync(FILES.src, 'utf8');
  const logic = readSection(FILES.src);
  const defs = (text) => (text.match(/\bvar\s+MULTI_SCAN\s*=/g) || []).length;
  assert.equal(defs(logic), 1);
  assert.equal(defs(whole), defs(logic));
});

test('all four shipped copies carry a byte-identical multi-scan section', () => {
  const sections = Object.values(FILES).map(readSection);
  for (let i = 1; i < sections.length; i++) {
    assert.equal(sections[i], sections[0], 'multi-scan section matches the canonical source');
  }
});

function engine() {
  const sandbox = { window: {}, Uint8ClampedArray, Float32Array, Float64Array, Uint8Array, Uint32Array, Int32Array };
  vm.runInContext(readSection(FILES.src) + '\n', vm.createContext(sandbox));
  return sandbox.window.MULTI_SCAN;
}

function fill(rgba, w, h, r, g, b) {
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
  }
}
function paintCard(rgba, w, x, y, cw, ch, seed) {
  for (let yy = y; yy < y + ch; yy++) {
    for (let xx = x; xx < x + cw; xx++) {
      const i = (yy * w + xx) * 4;
      const n = (xx * 17 + yy * 13 + seed * 40) & 63;
      rgba[i] = 30 + n * 3;
      rgba[i + 1] = 20 + ((seed * 50 + xx) & 80);
      rgba[i + 2] = 70 + ((yy + seed * 15) & 90);
      rgba[i + 3] = 255;
    }
  }
}

test('auto detect finds separated cards in reading order and ignores a flat photo', () => {
  const MS = engine();
  const w = 640, h = 420;
  const rgba = new Uint8ClampedArray(w * h * 4);
  fill(rgba, w, h, 96, 72, 48);
  paintCard(rgba, w, 30, 40, 160, 220, 1);
  paintCard(rgba, w, 240, 36, 160, 220, 2);
  paintCard(rgba, w, 450, 44, 160, 220, 3);
  const quads = MS.detect(rgba, w, h);
  assert.equal(quads.length, 3);
  const centers = quads.map((q) => q.pts.reduce((s, p) => s + p.x, 0) / 4);
  assert.ok(centers[0] < centers[1] && centers[1] < centers[2], 'left to right');
  centers.forEach((cx, i) => {
    const expect = [110, 320, 530][i];
    assert.ok(Math.abs(cx - expect) < 40, `card ${i} center ${cx}`);
  });
  const flat = new Uint8ClampedArray(w * h * 4);
  fill(flat, w, h, 40, 40, 40);
  assert.equal(MS.detect(flat, w, h).length, 0);
});

test('binder grid keeps busy pockets and skips an empty one', () => {
  const MS = engine();
  const w = 900, h = 1200;
  const rgba = new Uint8ClampedArray(w * h * 4);
  fill(rgba, w, h, 16, 16, 18);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (r === 1 && c === 1) continue;
      paintCard(rgba, w, 50 + c * 290, 50 + r * 390, 200, 280, r * 3 + c + 1);
    }
  }
  const quads = MS.grid(rgba, w, h, 3, 3);
  assert.equal(quads.length, 8);
});

test('a crop matches its own art, and a different pattern stays unmatched', () => {
  const MS = engine();
  function pattern(seed, w, h) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    paintCard(rgba, w, 0, 0, w, h, seed);
    return rgba;
  }
  const a = pattern(3, 80, 112);
  const b = pattern(9, 80, 112);
  const da = MS.describe(a, 80, 112, false);
  const db = MS.describe(b, 80, 112, false);
  const matrix = new Float32Array(MS.DESC * 2);
  matrix.set(da, 0);
  matrix.set(db, MS.DESC);
  const hit = MS.matchDescriptor(a, 80, 112, matrix, ['EBP01-001', 'EBP01-006'], ['EBP01-001', 'EBP01-006']);
  assert.equal(hit.matched, true);
  assert.equal(hit.id, 'EBP01-001');
  assert.ok(hit.score > 0.9);
  // Same artwork under another printing must not count as a rival card.
  const alt = new Float32Array(MS.DESC * 3);
  alt.set(da, 0);
  alt.set(da, MS.DESC);
  alt.set(db, MS.DESC * 2);
  const same = MS.matchDescriptor(a, 80, 112, alt, ['EBP01-001', 'EBP01-001SR', 'EBP01-006'], ['EBP01-001', 'EBP01-001', 'EBP01-006']);
  assert.equal(same.matched, true);
  assert.equal(same.id === 'EBP01-001' || same.id === 'EBP01-001SR', true);
  const blank = new Uint8ClampedArray(80 * 112 * 4);
  fill(blank, 80, 112, 12, 12, 12);
  const miss = MS.matchDescriptor(blank, 80, 112, matrix, ['EBP01-001', 'EBP01-006'], ['EBP01-001', 'EBP01-006']);
  assert.equal(miss.matched, false);
  assert.equal(miss.id, '');
});

test('warp of an upright quad reproduces the source card', () => {
  const MS = engine();
  const w = 200, h = 280;
  const rgba = new Uint8ClampedArray(w * h * 4);
  fill(rgba, w, h, 20, 20, 20);
  paintCard(rgba, w, 20, 20, 160, 224, 4);
  const quad = [{ x: 20, y: 20 }, { x: 180, y: 20 }, { x: 180, y: 244 }, { x: 20, y: 244 }];
  const crop = MS.warp(rgba, w, h, quad, 80, 112);
  let colored = 0;
  for (let i = 0; i < crop.length; i += 4) if (crop[i] > 40) colored++;
  assert.ok(colored > 80 * 112 * 0.5, 'warped crop is the card, not the empty border');
});
