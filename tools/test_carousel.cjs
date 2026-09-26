'use strict';

// Run with: node tools/test_carousel.cjs
// Guards the FEATURED CAROUSEL section of src/paldeck.html (the Home featured window) and exercises
// its real code in a vm sandbox with a stub DOM, the same approach as tools/test_editions.cjs.
// The structural tests are the regression guard: the carousel must stay inside its BEGIN/END markers,
// stay identical across all four shipped copies, and expose the FEATURED_CAROUSEL API seam.
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
const BEGIN = { style: 'FEATURED CAROUSEL BEGIN (styles', logic: 'FEATURED CAROUSEL BEGIN (logic' };
const END = { style: 'FEATURED CAROUSEL END (styles)', logic: 'FEATURED CAROUSEL END (logic)' };

function readSection(file, kind) {
  const text = fs.readFileSync(file, 'utf8');
  const begin = text.indexOf(BEGIN[kind]);
  const end = text.indexOf(END[kind]);
  assert.ok(begin >= 0, `${file}: ${kind} BEGIN marker present`);
  assert.ok(end > begin, `${file}: ${kind} END marker present after BEGIN`);
  const again = text.indexOf(BEGIN[kind], begin + 1);
  assert.equal(again, -1, `${file}: exactly one ${kind} section`);
  // Slice from the start of the BEGIN line so the leading `// ====` stays part of the section.
  return text.slice(text.lastIndexOf('\n', begin) + 1, end);
}
const srcSection = (kind) => readSection(FILES.src, kind);

// ---- structural guards -------------------------------------------------------------------

test('carousel CSS and logic stay inside their markers in the canonical source', () => {
  srcSection('style');
  srcSection('logic');
});

test('carousel definitions never leak outside the marked section', () => {
  const whole = fs.readFileSync(FILES.src, 'utf8');
  const logic = readSection(FILES.src, 'logic');
  const defs = (text) => (text.match(/\bfunction\s+feat[A-Z]\w*\s*\(/g) || []).length
    + (text.match(/\bvar\s+FEAT_MS\b/g) || []).length
    + (text.match(/\bvar\s+_featSlides\b/g) || []).length;
  assert.ok(defs(logic) > 0, 'section actually contains the carousel definitions');
  assert.equal(defs(whole), defs(logic), 'every carousel definition lives inside the markers');
});

test('all four shipped copies carry a byte-identical carousel section', () => {
  // rebuild.py enforces LF-only output and src/paldeck.html is LF (pinned in .gitattributes),
  // so this comparison is exact: any real drift, including line-ending drift, fails here.
  for (const kind of ['style', 'logic']) {
    const sections = Object.values(FILES).map((f) => readSection(f, kind));
    for (let i = 1; i < sections.length; i++) {
      assert.equal(sections[i], sections[0], `${kind} section matches the canonical source`);
    }
  }
});

test('the FEATURED_CAROUSEL API seam stays intact', () => {
  const a = app();
  assert.deepEqual(
    Object.keys(a.window.FEATURED_CAROUSEL).sort(),
    ['art', 'bind', 'intervalMs', 'keys', 'newsSet', 'open', 'paint', 'pause', 'render',
     'slides', 'snapshot', 'start', 'stop', 'target', 'time', 'visible'].sort()
  );
  assert.equal(a.window.FEATURED_CAROUSEL.intervalMs, 5200);
});

// ---- sandbox: run the real section against a stub DOM -------------------------------------

function parseButtons(html, cls) {
  const out = [];
  const re = new RegExp('<button class="' + cls + '[^"]*"[^>]*>', 'g');
  let m;
  while ((m = re.exec(html))) out.push(makeNode(m[0]));
  return out;
}
function makeNode(openTag) {
  const node = {
    style: {}, attrs: {}, focused: 0, parentNode: null,
    className: (openTag.match(/class="([^"]*)"/) || [, ''])[1],
    classList: {
      add(c) { if (!node.classList.contains(c)) node.className = (node.className + ' ' + c).trim(); },
      remove(c) { node.className = node.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains(c) { return node.className.split(/\s+/).includes(c); },
    },
    setAttribute(k, v) { node.attrs[k] = String(v); },
    removeAttribute(k) { delete node.attrs[k]; },
    getAttribute(k) { return k in node.attrs ? node.attrs[k] : null; },
    focus() { node.focused++; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { node._listeners[type] = (node._listeners[type] || []).concat(fn); },
  };
  node._listeners = {};
  const dataI = (openTag.match(/data-i="(\d+)"/) || [])[1];
  if (dataI != null) node.attrs['data-i'] = dataI;
  return node;
}
function stubElement(id) {
  const el = makeNode('<span>');
  el.hidden = false;
  let html = '';
  let sets = 0;
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set(v) { html = v; sets++; el._slides = parseButtons(v, 'featslide'); el._dots = parseButtons(v, 'featdot'); },
  });
  el._htmlSetCount = () => sets;
  el.querySelectorAll = (sel) => (sel === '.featslide' ? el._slides || [] : sel === '.featdot' ? el._dots || [] : []);
  return el;
}
function app(opts) {
  const host = stubElement('homeFeatured');
  const track = stubElement('featTrack');
  const pageHome = makeNode('<section>');
  pageHome.classList.add('active');
  const ids = { homeFeatured: host, featTrack: track, 'page-home': pageHome };
  const registry = { sets: [], cleared: 0 };
  const document_ = {
    hidden: false,
    getElementById(id) { return ids[id] || null; },
    createElement() { return makeNode('<div>'); },
  };
  const window_ = { matchMedia: () => ({ matches: false }), IS_NATIVE: false, IS_IOS: false, open() {} };
  const shown = [];
  const toasts = [];
  const dispatch = (el, type, event) => (el._listeners[type] || []).forEach((fn) => fn(event));
  const sandbox = {
    document: document_, window: window_, navigator: {}, location: { reload() {} },
    setInterval(fn) { registry.sets.push(fn); return registry.sets.length; },
    clearInterval() { registry.cleared++; registry.sets.length = 0; },
    setTimeout() { return 0; }, clearTimeout() {},
    $: (id) => document_.getElementById(id),
    esc: (s) => String(s), icon: () => '<i></i>', decodeEntities: (s) => s, money: (v) => '$' + v,
    imgSrc: (c) => 'img:' + c.id,
    showPage: (p) => shown.push(p), openSet: (k) => shown.push('set:' + k), toast: (m) => toasts.push(m),
    OFFICIAL_NEWS: 'https://example.test/news',
    APP_VERSION: '1.11', verNum: (s) => parseFloat(String(s)) || 0, _latestAppVersion: undefined,
    updateNotesFor: (v) => ['Note A for ' + v, 'Note B'],
    SET_ORDER: ['EBP01', 'EBP02', 'PR2026', 'LA02'],
    SET_META: {
      EBP01: { name: 'Dawn of Palpagos', release: 'Jul 9, 2026', art: 'data:art-ebp01' },
      EBP02: { name: 'Legends Awaken', release: 'Jun 12, 2026', art: 'data:art-ebp02' },
      PR2026: { name: 'Promos', release: '' }, LA02: { name: 'Future Set', release: 'Dec 2026' },
    },
    SETS: { EBP01: { name: 'Dawn of Palpagos' }, EBP02: { name: 'Legends Awaken' } },
    SET_SPHERE_TRACKS: [],
    visibleNews: () => [],
    SETTINGS: { mode: 'market' }, TOTAL: 277, CARDS: [], has: () => false, o: (id) => id,
    setProgress: () => ({ owned: {}, tot: { EBP01: 1, EBP02: 1 } }),
    moverCard: () => null, pwPick: () => null,
    ...opts,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(srcSection('logic') + '\n', context);
  return {
    window: window_, host, track, shown, toasts, registry, sandbox, dispatch,
    api: window_.FEATURED_CAROUSEL,
    tick: () => { const fn = registry.sets[registry.sets.length - 1]; if (fn) fn(); },
  };
}
const news = (over) => ({ title: 'T', date: 'Sep 25, 2026', link: 'https://x.test/1', ...over });

// ---- behaviour ----------------------------------------------------------------------------

test('featTime parses full dates, month-years, and rejects junk', () => {
  const a = app();
  assert.equal(a.api.time('Oct 30, 2026'), new Date(2026, 9, 30).getTime());
  assert.equal(a.api.time('Dec 2026'), new Date(2026, 11, 28).getTime());
  assert.equal(a.api.time('nonsense'), Infinity);
});

test('official news becomes slide 1 and maps its set art by title', () => {
  const a = app({ visibleNews: () => [
    news({ title: 'Card List Added for "Dawn of Palpagos"', image: 'https://example.test/o.png' }),
  ] });
  const slides = a.api.slides();
  assert.equal(slides[0].kind, 'news');
  assert.equal(slides[0].set, 'EBP01');
  assert.equal(slides[0].art, 'https://example.test/o.png');
});

test('an X post with an image becomes its own slide and feeds the reveal slide', () => {
  const a = app({ visibleNews: () => [
    news({ title: 'Official update' }),
    news({ title: 'New from the official account', source: 'x:PalworldOCG_EN', image: 'https://pbs.twimg.com/media/a.jpg' }),
    news({ title: 'Card reveal: new pal', source: 'x:PalworldOCG_EN', image: 'https://pbs.twimg.com/media/b.jpg' }),
  ] });
  // kinds arrays are built inside the sandbox, so compare realm-safely.
  assert.equal(String(a.api.slides().map((s) => s.kind)), 'news,ximage,collection,reveal');
  assert.match(a.api.slides()[3].meta, /@PalworldOCG_EN/);
});

test('the reveal slide deduplicates against the news slide it would repeat', () => {
  const dup = news({ title: 'Card reveal: new pal', image: 'https://pbs.twimg.com/media/x.jpg' });
  const a = app({ visibleNews: () => [dup] });
  assert.equal(String(a.api.slides().map((s) => s.kind)), 'news,collection');
});

test('an update slide appears only when the app is behind the store build', () => {
  const behind = app({ _latestAppVersion: '1.12' });
  const up = behind.api.slides().find((s) => s.kind === 'update');
  assert.ok(up, 'behind build shows the update slide');
  assert.deepEqual(up.notes, ['Note A for 1.12', 'Note B']);

  const current = app();
  assert.ok(!current.api.slides().some((s) => s.kind === 'update'));
});

test('the collection slide falls back from movers to a summary', () => {
  const summary = app();
  const s = summary.api.slides().find((x) => x.kind === 'collection');
  assert.match(s.title, /0 \/ 277 cards · 0%/);

  const rising = app({ moverCard: (dir) => (dir === 'up'
    ? { c: { id: 'EBP01-001', name: 'Lamball' }, pct: 12.3, prev: 1, cur: 2 } : null) });
  const m = rising.api.slides().find((x) => x.kind === 'movers');
  assert.match(m.title, /Biggest riser today/);
  assert.equal(m.movers[0].name, 'Lamball');
});

test('slides cap at five', () => {
  const a = app({ visibleNews: () => Array.from({ length: 9 }, (_, i) => news({
    title: 'Card reveal ' + i, source: i % 2 ? 'x:PalworldOCG_EN' : 'official',
    image: 'https://pbs.twimg.com/media/' + i + '.jpg',
  })) });
  assert.ok(a.api.slides().length <= 5);
});

test('renderFeatured paints slides, dots and wires autoplay through the API', () => {
  const a = app({ visibleNews: () => [news({ title: 'Official update' })] });
  a.api.render();
  assert.equal(a.host.hidden, false);
  assert.match(a.host.innerHTML, /class="feattrack"/);
  assert.equal(a.host.querySelectorAll('.featslide').length, 2);
  assert.equal(a.host.querySelectorAll('.featdot').length, 2);
  assert.equal(a.api.snapshot().slideCount, 2);
  assert.equal(a.api.snapshot().timerActive, true, 'autoplay armed');
  assert.equal(a.registry.sets.length, 1, 'exactly one interval');

  a.tick(); // manual autoplay tick
  assert.equal(a.api.snapshot().index, 1, 'tick advances the slide');
  a.tick();
  assert.equal(a.api.snapshot().index, 0, 'autoplay wraps');
});

test('re-rendering identical slides keeps the DOM and restarts nothing but the timer', () => {
  const a = app({ visibleNews: () => [news({ title: 'Official update' })] });
  a.api.render();
  const afterFirst = a.host._htmlSetCount();
  a.api.render();
  assert.equal(a.host._htmlSetCount(), afterFirst, 'sig path skips the repaint');
  assert.equal(a.api.snapshot().timerActive, true);
});

test('with no news and no sets, the collection summary is the lone slide (hide path stays defensive)', () => {
  const a = app({ SET_ORDER: [], visibleNews: () => [] });
  a.api.render();
  assert.equal(a.host.hidden, false);
  assert.equal(a.api.snapshot().slideCount, 1);
  assert.equal(a.host.querySelectorAll('.featdot').length, 0, 'a single slide renders no dots');
  assert.match(a.host.innerHTML, /Your collection/);
});

test('dot taps, slide taps and arrows all steer the carousel', () => {
  const a = app({ visibleNews: () => [news({ title: 'Official update' })] });
  a.api.render();

  // dot tap
  a.dispatch(a.host, 'click', { target: a.host.querySelectorAll('.featdot')[1] });
  assert.equal(a.api.snapshot().index, 1);

  // slide tap opens the slide's destination
  a.dispatch(a.host, 'click', { target: a.host.querySelectorAll('.featslide')[0] });
  assert.deepEqual(a.shown, ['news'], 'news slide opens the news page');

  // keyboard arrows with focus tracking; the dot tap left the index on 1, so Right wraps to 0
  const slide = a.host.querySelectorAll('.featslide')[0];
  a.dispatch(a.host, 'keydown', { key: 'ArrowRight', target: slide, preventDefault() {} });
  assert.equal(a.api.snapshot().index, 0, 'ArrowRight wraps from the last slide');
  assert.ok(a.host.querySelectorAll('.featslide')[0].focused > 0, 'focus follows the slide');
  a.dispatch(a.host, 'keydown', { key: 'ArrowLeft', target: slide, preventDefault() {} });
  assert.equal(a.api.snapshot().index, 1, 'ArrowLeft wraps backwards');
  a.dispatch(a.host, 'keydown', { key: 'ArrowDown', target: slide, preventDefault() {} });
  assert.equal(a.api.snapshot().index, 1, 'other keys are ignored');
});

test('openFeatured routes each slide kind to its destination', () => {
  const a = app();
  a.api.open({ kind: 'release', set: 'EBP01' });
  a.api.open({ kind: 'collection' });
  assert.deepEqual(a.shown, ['set:EBP01', 'collection']);
});

test('swiping horizontally changes the slide without breaking taps', () => {
  const a = app({ visibleNews: () => [news({ title: 'Official update' })] });
  a.api.render();
  a.dispatch(a.host, 'touchstart', { touches: [{ clientX: 200, clientY: 10 }] });
  a.dispatch(a.host, 'touchend', { changedTouches: [{ clientX: 80, clientY: 12 }] });
  assert.equal(a.api.snapshot().index, 1, 'leftward drag advances');
  assert.equal(a.api.snapshot().paused, false, 'autoplay resumes after the swipe');
});

test('bind is idempotent: re-render never stacks a second set of listeners', () => {
  const a = app({ visibleNews: () => [news({ title: 'Official update' })] });
  a.api.render();
  a.api.render();
  a.api.bind();
  assert.equal(a.host._listeners.click.length, 1, 'exactly one delegated click listener');
  assert.equal(a.host._listeners.keydown.length, 1, 'exactly one keydown listener');
});
