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
// A real app function from outside the section, for helpers the section calls whose behaviour the tests rely on.
function appFunction(name) {
  const source = fs.readFileSync(FILES.src, 'utf8');
  const match = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, 'App function exists: ' + name);
  for (let end = source.indexOf('}', match.index); end >= 0; end = source.indexOf('}', end + 1)) {
    const declaration = source.slice(match.index, end + 1);
    try { new vm.Script('(' + declaration + ')'); } catch (_) { continue; }
    return vm.runInNewContext('(' + declaration + ')');
  }
  throw new Error('Could not extract ' + name);
}

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

test('pctOf (stubbed in the sandbox) never shows 100% while missing or 0% once owned', () => {
  const whole = fs.readFileSync(FILES.src, 'utf8');
  const m = whole.match(/function pctOf\(n, t\)\{[^\n]*\}/);
  assert.ok(m, 'pctOf is defined on one line');
  const pctOf = vm.runInNewContext('(' + m[0] + ')');
  assert.equal(pctOf(0, 0), 0);
  assert.equal(pctOf(0, 10), 0);
  assert.equal(pctOf(1, 1000), 1);
  assert.equal(pctOf(999, 1000), 99);
  assert.equal(pctOf(5, 10), 50);
  assert.equal(pctOf(10, 10), 100);
  assert.equal(pctOf(12, 10), 100);
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
    esc: (s) => String(s), icon: () => '<i></i>', decodeEntities: (s) => s, dayLabel: (s) => s, monDateTime: appFunction('monDateTime'), pctOf: (n, t) => (t ? Math.round(n / t * 100) : 0), money: (v) => '$' + v,
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

test('featTime parses full dates, month-years, ISO dates, and rejects junk', () => {
  const a = app();
  assert.equal(a.api.time('Oct 30, 2026'), new Date(2026, 9, 30).getTime());
  assert.equal(a.api.time('Dec 2026'), new Date(2026, 11, 28).getTime());
  assert.equal(a.api.time('2026-09-11'), new Date(2026, 8, 11).getTime());
  assert.equal(a.api.time('nonsense'), Infinity);
});

test('the news slide is the newest official post, not an older item listed first', () => {
  const a = app({ visibleNews: () => [
    news({ title: 'Sleeve date', date: 'Aug 28, 2026', source: 'Official site' }),
    news({ title: 'Eternal Ascent preorders', date: '2026-09-11', source: 'Official site' }),
    news({ title: 'A newer video', date: '2026-09-12', source: 'YouTube' }),
  ] });
  assert.equal(a.api.slides()[0].kind, 'news');
  assert.equal(a.api.slides()[0].title, 'Eternal Ascent preorders');
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

test('home headliners are news, update features, collection movers, a card reveal, and the next release', () => {
  const a = app({
    visibleNews: () => [
      news({ title: 'Eternal Ascent preorders', date: '2026-09-11', source: 'Official site' }),
      news({ title: 'Card Reveal', date: '2026-09-25', source: 'X · @PalworldOCG_EN', image: 'https://pbs.twimg.com/media/reveal.jpg' }),
    ],
    moverCard: (dir, scope) => {
      if (scope !== 'collection' || dir !== 'up') return null;
      return { c: { id: 'EBP01-001', name: 'Lamball' }, pct: 3.2, prev: 1, cur: 2 };
    },
    SEALED: [
      { id: 'late', set: 'Dawn reprint', pre: true, date: 'late Oct 2026' },
      { id: 'ss', set: 'Sleeve & Card Set Vol. 1', pre: true, date: 'Oct 16, 2026', banner: 'BOX_BANNER_SS01' },
    ],
    sealDate: (p) => p.date,
  });
  const slides = a.api.slides();
  assert.equal(String(slides.map((s) => s.kind)), 'news,features,movers,reveal,soon');
  assert.equal(slides[0].title, 'Eternal Ascent preorders');
  assert.equal(slides[1].badge, 'Latest update');
  assert.match(slides[1].title, /1\.11/);
  assert.equal(slides[2].title, 'Movers in your collection');
  assert.equal(slides[2].movers[0].name, 'Lamball');
  assert.equal(slides[3].title, 'Card Reveal');
  assert.match(slides[3].meta, /@PalworldOCG_EN/);
  assert.equal(slides[4].title, 'Sleeve & Card Set Vol. 1');
  assert.equal(slides[4].meta, 'Oct 16, 2026');
  assert.equal(slides.some((s) => s.kind === 'ximage'), false);
});

test('a card reveal that is already the news slide is not repeated', () => {
  const dup = news({ title: 'Card reveal: new pal', image: 'https://pbs.twimg.com/media/x.jpg' });
  const a = app({ visibleNews: () => [dup], SET_ORDER: [] });
  assert.equal(String(a.api.slides().map((s) => s.kind)), 'news,features,collection');
  assert.equal(a.api.slides().filter((s) => s.kind === 'reveal').length, 0);
});

test('latest update features stay on screen, and a newer store build says an update is ready', () => {
  const behind = app({ _latestAppVersion: '1.12' });
  const up = behind.api.slides().find((s) => s.kind === 'update');
  assert.ok(up, 'behind build shows the update slide');
  assert.deepEqual(JSON.parse(JSON.stringify(up.notes)), ['Note A for 1.12', 'Note B']);
  assert.equal(behind.api.slides().some((s) => s.kind === 'features'), false);

  const current = app();
  const feat = current.api.slides().find((s) => s.kind === 'features');
  assert.ok(feat, 'current build still shows its own features');
  assert.equal(feat.badge, 'Latest update');
  assert.match(feat.title, /1\.11/);
  assert.deepEqual(JSON.parse(JSON.stringify(feat.notes)), ['Note A for 1.11', 'Note B']);
  assert.equal(current.api.slides().some((s) => s.kind === 'update'), false);

  const ahead = app({
    APP_VERSION: '2.0',
    _latestAppVersion: '1.10',
    RELEASE_HIGHLIGHTS: { '2.0': ['Home headliners', 'Pal pages', 'Deck tools'] },
    updateNotesFor: () => ['Price alerts', 'Sort', 'Filter'],
  });
  const own = ahead.api.slides().find((s) => s.kind === 'features');
  assert.ok(own, 'a build ahead of the store record still shows a features slide');
  assert.deepEqual(JSON.parse(JSON.stringify(own.notes)), ['Home headliners', 'Pal pages', 'Deck tools']);
  assert.equal(ahead.api.slides().some((s) => s.kind === 'update'), false);
});

test('the movers slide is hidden when prices are off', () => {
  const hidden = app({
    SETTINGS: { mode: 'collector' },
    moverCard: (dir, scope) => (scope === 'collection' && dir === 'up'
      ? { c: { id: 'EBP01-001', name: 'Lamball' }, pct: 12.3 } : null),
  });
  const kinds = hidden.api.slides().map((s) => s.kind);
  assert.equal(kinds.includes('movers'), false);
  assert.equal(kinds.includes('collection'), false);
  assert.equal(String(kinds), 'features,soon');

  const shown = app({
    SETTINGS: { mode: 'trader' },
    moverCard: () => null,
    SET_ORDER: [],
    visibleNews: () => [],
  });
  assert.equal(shown.api.slides().some((s) => s.title === 'Movers in your collection'), true);
});

test('the collection slide falls back from movers to a summary', () => {
  const summary = app();
  const s = summary.api.slides().find((x) => x.kind === 'collection');
  assert.equal(s.title, 'Movers in your collection');
  assert.match(s.meta, /0 \/ 277 cards/);
  assert.match(s.meta, /No price moves in your collection yet/);

  const rising = app({ moverCard: (dir, scope) => (dir === 'up' && scope === 'collection'
    ? { c: { id: 'EBP01-001', name: 'Lamball' }, pct: 12.3, prev: 1, cur: 2 } : null) });
  const m = rising.api.slides().find((x) => x.kind === 'movers');
  assert.equal(m.title, 'Movers in your collection');
  assert.equal(m.movers[0].name, 'Lamball');
  assert.equal(rising.api.slides().some((x) => x.kind === 'collection'), false);
});

test('movers in your collection ignore the wider market', () => {
  const a = app({ moverCard: (dir, scope) => {
    if (scope !== 'collection') return { c: { id: 'NO', name: 'MarketOnly' }, pct: 99 };
    if (dir === 'up') return { c: { id: 'EBP01-001', name: 'Lamball' }, pct: 12.3 };
    if (dir === 'down') return { c: { id: 'EBP01-002', name: 'Cattiva' }, pct: -4.5 };
    return null;
  } });
  const m = a.api.slides().find((x) => x.kind === 'movers');
  assert.equal(String(m.movers.map((x) => x.dir + ':' + x.name)), 'up:Lamball,down:Cattiva');
  assert.equal(m.title, 'Movers in your collection');
  a.api.render();
  const html = a.host.innerHTML;
  assert.match(html, /class="featslide[^"]*\bpair\b/, 'two cards get the wide image panel');
  assert.equal((html.match(/class="featpaircard /g) || []).length, 2, 'both cards shown side by side');
  assert.match(html, /↑ \+12\.3%/);
  assert.match(html, /↓ −4\.5%/);
});

test('slides put text and the sharp image in separate columns over a blurred backdrop', () => {
  const a = app({ visibleNews: () => [news({ title: 'Official update', image: 'https://example.test/o.png' })] });
  a.api.render();
  const slide = a.host.innerHTML.split('<button class="featslide')[1];
  assert.match(slide, /<span class="featbg"><img src="https:\/\/example\.test\/o\.png"/);
  assert.match(slide, /<span class="featart"><img class="featart-img zoom" src="https:\/\/example\.test\/o\.png"/);
  assert.ok(slide.indexOf('class="featart') < slide.indexOf('class="featbody"'), 'image panel is its own element, not under the text');
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
  const n = a.host.querySelectorAll('.featslide').length;
  assert.equal(n, 4, 'news, update features, collection, next release');
  assert.equal(a.host.querySelectorAll('.featdot').length, 4);
  assert.equal(a.api.snapshot().slideCount, 4);
  assert.equal(a.api.snapshot().timerActive, true, 'autoplay armed');
  assert.equal(a.registry.sets.length, 1, 'exactly one interval');

  a.tick();
  assert.equal(a.api.snapshot().index, 1, 'tick advances the slide');
  for (let i = 0; i < n - 1; i++) a.tick();
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

test('with no news and no sets, update features and the collection slide still show', () => {
  const a = app({ SET_ORDER: [], visibleNews: () => [] });
  a.api.render();
  assert.equal(a.host.hidden, false);
  assert.equal(String(a.api.slides().map((s) => s.kind)), 'features,collection');
  assert.equal(a.api.snapshot().slideCount, 2);
  assert.equal(a.host.querySelectorAll('.featdot').length, 2);
  assert.match(a.host.innerHTML, /Latest update/);
  assert.match(a.host.innerHTML, /Movers in your collection/);
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

  // keyboard arrows with focus tracking; the dot tap left the index on 1
  const slide = a.host.querySelectorAll('.featslide')[0];
  const last = a.host.querySelectorAll('.featdot').length - 1;
  a.dispatch(a.host, 'keydown', { key: 'ArrowRight', target: slide, preventDefault() {} });
  assert.equal(a.api.snapshot().index, 2, 'ArrowRight advances');
  assert.ok(a.host.querySelectorAll('.featslide')[2].focused > 0, 'focus follows the slide');
  a.dispatch(a.host, 'click', { target: a.host.querySelectorAll('.featdot')[last] });
  a.dispatch(a.host, 'keydown', { key: 'ArrowRight', target: slide, preventDefault() {} });
  assert.equal(a.api.snapshot().index, 0, 'ArrowRight wraps from the last slide');
  a.dispatch(a.host, 'keydown', { key: 'ArrowLeft', target: slide, preventDefault() {} });
  assert.equal(a.api.snapshot().index, last, 'ArrowLeft wraps backwards');
  a.dispatch(a.host, 'keydown', { key: 'ArrowDown', target: slide, preventDefault() {} });
  assert.equal(a.api.snapshot().index, last, 'other keys are ignored');
});

test('openFeatured routes each slide kind to its destination', () => {
  const a = app();
  a.api.open({ kind: 'release', set: 'EBP01' });
  a.api.open({ kind: 'collection' });
  a.api.open({ kind: 'soon' });
  a.api.open({ kind: 'features', version: '1.11' });
  assert.deepEqual(a.shown, ['set:EBP01', 'collection', 'releases']);
  assert.equal(a.toasts.length, 1);
  assert.match(a.toasts[0], /1\.11/);
});

test('swiping horizontally changes the slide without breaking taps', () => {
  const a = app({ visibleNews: () => [news({ title: 'Official update' })] });
  a.api.render();
  a.dispatch(a.host, 'touchstart', { touches: [{ clientX: 200, clientY: 10 }] });
  a.dispatch(a.host, 'touchend', { changedTouches: [{ clientX: 80, clientY: 12 }] });
  assert.equal(a.api.snapshot().index, 1, 'leftward drag advances');
  assert.equal(a.api.snapshot().paused, false, 'autoplay resumes after the swipe');
});

test('a mapped release banner is used for the 2.1 features and update slides', () => {
  const source = fs.readFileSync(FILES.src, 'utf8');
  assert.match(source, /var RELEASE_ART = \{[\s\S]*?"2\.1": "img\/UPDATE_2_1\.webp"[\s\S]*?\};/);
  assert.match(source, /\.featslide\.release \.featbg img \{[^}]*object-fit:contain/);
  assert.match(source, /\.featslide\.release \.featbg img \{[^}]*filter:none/);
  const banner = 'img/UPDATE_2_1.webp';
  const notes = ['Deck check', 'Match tracker', 'Rules text'];
  const base = {
    visibleNews: () => [],
    RELEASE_HIGHLIGHTS: { '2.1': notes, '2.0': ['Older'], '9.9': ['Unmapped one', 'Unmapped two'] },
    RELEASE_ART: { '2.1': banner },
    updateNotesFor: (v) => (v === '2.1' ? notes : ['Unmapped one', 'Unmapped two']),
  };
  const features = app({ ...base, APP_VERSION: '2.1', _latestAppVersion: '2.1' });
  const feat = features.api.slides().find((s) => s.kind === 'features');
  assert.ok(feat, 'current 2.1 build shows a features slide');
  assert.equal(feat.badge, 'Latest update');
  assert.equal(feat.art, banner);
  assert.equal(feat.releaseArt, true);
  features.api.render();
  const featHtml = features.host.innerHTML.match(/<button class="featslide[^"]*\brelease\b[\s\S]*?<\/button>/);
  assert.ok(featHtml, 'features slide is marked release');
  assert.match(featHtml[0], /class="featbg"><img src="img\/UPDATE_2_1\.webp"/);
  assert.equal(featHtml[0].includes('class="featart'), false, 'the collage is the frame, not a side card');
  assert.match(features.host.className, /\bbanneropen\b/);

  const update = app({ ...base, APP_VERSION: '2.0', _latestAppVersion: '2.1' });
  const up = update.api.slides().find((s) => s.kind === 'update');
  assert.ok(up, 'a build behind 2.1 shows the update slide');
  assert.equal(up.badge, 'Update available');
  assert.equal(up.version, '2.1');
  assert.equal(up.art, banner);
  assert.equal(up.releaseArt, true);
  update.api.render();
  assert.match(update.host.innerHTML, /<button class="featslide[^"]*\brelease\b[\s\S]*?src="img\/UPDATE_2_1\.webp"/);

  const fallback = app({ ...base, APP_VERSION: '9.9', _latestAppVersion: '' });
  const own = fallback.api.slides().find((s) => s.kind === 'features');
  assert.ok(own, 'an unmapped version still shows a features slide');
  assert.equal(own.releaseArt, false);
  assert.equal(own.art, 'data:art-ebp01', 'unmapped version keeps the set-art fallback');
  assert.notEqual(own.art, banner);
  fallback.api.render();
  assert.equal(/class="featslide[^"]*\brelease\b/.test(fallback.host.innerHTML), false);
  assert.match(fallback.host.innerHTML, /src="data:art-ebp01"/);
  assert.equal(/\bbanneropen\b/.test(fallback.host.className), false);

  const copies = [
    'docs/app/img/UPDATE_2_1.webp',
    'app/src/main/assets/img/UPDATE_2_1.webp',
    'ios/SphereDex/SphereDex/Resources/img/UPDATE_2_1.webp',
  ].map((rel) => {
    const file = path.join(REPO, rel);
    assert.equal(fs.existsSync(file), true, rel + ' is in the built output');
    return fs.readFileSync(file);
  });
  assert.ok(copies[0].length > 1000 && copies[0].length < 250 * 1024, 'banner is an optimised file under 250KB');
  assert.equal(copies[0].subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(copies[0].subarray(8, 12).toString('ascii'), 'WEBP');
  assert.equal(copies[0].subarray(23, 26).toString('hex'), '9d012a');
  assert.equal(copies[0].readUInt16LE(26) & 0x3fff, 1600);
  assert.equal(copies[0].readUInt16LE(28) & 0x3fff, 900);
  for (const copy of copies.slice(1)) assert.equal(copy.equals(copies[0]), true, 'native bundles mirror the web banner');
});

test('bind is idempotent: re-render never stacks a second set of listeners', () => {
  const a = app({ visibleNews: () => [news({ title: 'Official update' })] });
  a.api.render();
  a.api.render();
  a.api.bind();
  assert.equal(a.host._listeners.click.length, 1, 'exactly one delegated click listener');
  assert.equal(a.host._listeners.keydown.length, 1, 'exactly one keydown listener');
});

// The card of the day's instrument frame is fourteen background layers driven by three parallel lists
// (image, size, position). They are one table read down the page: layer N's image, size and position
// must stay on the same row. A drifted list does not error, it silently draws the wrong graphic, which
// is exactly the kind of thing nobody notices until a user screenshots it. So count them.
test('card of the day: the HUD frame background lists stay in lockstep', () => {
  const css = readSection(FILES.src, 'style');

  // Split on commas at paren depth 0, so gradients keep their own argument lists intact.
  const topLevelParts = (value) => {
    const parts = [];
    let depth = 0, current = '';
    for (const ch of value) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  };

  // Every .cotdhud::after block: the base rule plus each media-query restatement.
  const blocks = [...css.matchAll(/\.cotdhud::after\s*\{([\s\S]*?)\}/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 2, 'found the base frame rule and at least one restatement');

  blocks.forEach((block, n) => {
    const grab = (prop) => {
      const m = block.match(new RegExp(prop + ':([\s\S]*?);'));
      return m ? topLevelParts(m[1]) : null;
    };
    const size = grab('background-size');
    const position = grab('background-position');
    if (!size && !position) return;               // a block that only tweaks inset is fine
    assert.ok(size && position, `block ${n}: restating one list means restating both`);
    assert.equal(size.length, position.length,
      `block ${n}: background-size has ${size.length} layers but background-position has ${position.length}`);
    const image = grab('background-image');
    if (image) {
      assert.equal(image.length, size.length,
        `block ${n}: background-image has ${image.length} layers but the size/position lists have ${size.length}`);
    }
  });

  // The base rule is the one that declares all three, and it is the fourteen-layer table.
  const base = blocks.find((b) => /background-image:/.test(b));
  assert.ok(base, 'the base frame rule declares background-image');
  assert.equal(topLevelParts(base.match(/background-image:([\s\S]*?);/)[1]).length, 14,
    'the frame is the documented fourteen layers');
});

// The foil sweep travels well outside the card panel, so the panel must clip it. Without this it
// spends most of its cycle over the headline instead of the card: measured at 426px of travel across
// the text column on a 1024px viewport before it was fixed.
test('card of the day: the foil sweep is clipped to the card panel', () => {
  const css = readSection(FILES.src, 'style');
  const rule = css.match(/\.cotdart\s*\{([^}]*)\}/);
  assert.ok(rule, '.cotdart has its own rule');
  assert.match(rule[1], /overflow\s*:\s*hidden/, '.cotdart clips, so the sweep cannot reach .featbody');
});
