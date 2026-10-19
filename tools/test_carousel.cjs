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
// The source text of a real app function from outside the section: the shortest slice from its
// declaration to a closing brace that parses on its own.
function appFunctionSource(name) {
  const source = fs.readFileSync(FILES.src, 'utf8');
  const match = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, 'App function exists: ' + name);
  for (let end = source.indexOf('}', match.index); end >= 0; end = source.indexOf('}', end + 1)) {
    const declaration = source.slice(match.index, end + 1);
    try { new vm.Script('(' + declaration + ')'); } catch (_) { continue; }
    return declaration;
  }
  throw new Error('Could not extract ' + name);
}
// A real app function from outside the section, for helpers the section calls whose behaviour the tests rely on.
function appFunction(name) {
  return vm.runInNewContext('(' + appFunctionSource(name) + ')');
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
    ['art', 'bind', 'intervalMs', 'keys', 'leads', 'newsBanner', 'newsFrom', 'newsSet', 'open', 'paint', 'pause',
     'render', 'slides', 'snapshot', 'start', 'stop', 'target', 'time', 'visible'].sort()
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
// The carousel compares release dates against "now". Fixtures name real dates, so the suite runs on a
// fixed clock: with the real one, every fixture release turned into a past one on the day it arrived.
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
class FixedDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
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
  const opened = [];
  const window_ = { matchMedia: () => ({ matches: false }), IS_NATIVE: false, IS_IOS: false, open(u) { opened.push(String(u)); } };
  const shown = [];
  const toasts = [];
  const dispatch = (el, type, event) => (el._listeners[type] || []).forEach((fn) => fn(event));
  const sandbox = {
    document: document_, window: window_, navigator: {}, location: { reload() {} }, Date: FixedDate,
    setInterval(fn) { registry.sets.push(fn); return registry.sets.length; },
    clearInterval() { registry.cleared++; registry.sets.length = 0; },
    setTimeout() { return 0; }, clearTimeout() {},
    $: (id) => document_.getElementById(id),
    esc: (s) => String(s), icon: () => '<i></i>', decodeEntities: (s) => s, dayLabel: (s) => s, monDateTime: appFunction('monDateTime'), pctOf: (n, t) => (t ? Math.round(n / t * 100) : 0), money: (v) => '$' + v,
    imgSrc: (c) => 'img:' + c.id,
    showPage: (p) => shown.push(p), openSet: (k) => shown.push('set:' + k), toast: (m) => toasts.push(m),
    OFFICIAL_NEWS: 'https://example.test/news',
    // The server reports this build as live by default, so its own release slide shows on every platform.
    APP_VERSION: '1.11', verNum: (s) => parseFloat(String(s)) || 0, _latestAppVersion: '1.11',
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
    storeUrl: () => '',
    roadmapUrl: (v) => 'https://spheredex.app/roadmap#v' + String(v || '').replace(/\./g, '-'),
    MONTHS: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    ...opts,
  };
  const context = vm.createContext(sandbox);
  // The release timeline slide reads real dates, so give the sandbox the app's own date helpers.
  // They run INSIDE the context, not through appFunction, because they call each other and monDateTime.
  vm.runInContext(
    ['releaseYmd', 'releaseDaysUntil', 'shortReleaseDate'].map(appFunctionSource).join('\n') + '\n',
    context,
  );
  vm.runInContext(srcSection('logic') + '\n', context);
  return {
    window: window_, host, track, shown, toasts, opened, registry, sandbox, dispatch,
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

test('home headliners are news, update features, collection movers and the next release', () => {
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
  assert.equal(String(slides.map((s) => s.kind)), 'news,features,movers,soon');
  // The English account's reveal is newer than the website post, so it is the latest news.
  assert.equal(slides[0].title, 'Card Reveal');
  assert.match(slides[0].meta, /Official X$/);
  assert.equal(slides[1].badge, 'Latest update features');
  assert.match(slides[1].title, /1\.11/);
  assert.equal(slides[2].title, 'Movers in your collection');
  assert.equal(slides[2].movers[0].name, 'Lamball');
  assert.equal(slides[3].title, 'Sleeve & Card Set Vol. 1');
  // The release slide is a timeline now: a countdown and a short date on the headline, and the
  // releases after it as rows. With one upcoming release there are no rows and it reads as before.
  assert.equal(slides[3].meta, 'In 2 days · 16 Oct');
  // The reprint after it has a month only date, so it is a row with its own words and no countdown:
  // releaseYmd refuses to invent a day and the timeline refuses to guess one.
  assert.equal(slides[3].rows.length, 1);
  assert.equal(slides[3].rows[0].date, 'late Oct 2026');
  assert.equal(slides[3].rows[0].name, 'Dawn reprint');
  assert.equal(slides[3].badge, 'Release timeline');
  assert.equal(slides.some((s) => s.kind === 'ximage' || s.kind === 'reveal'), false);
});

// The five headliners have one fixed order. A slide with nothing to show is omitted, and the
// others stay in this sequence. features/update share a slot, and so do movers and the
// empty-collection fallback.
test('home carousel order is news, what is new, movers, card of the day, then next release', () => {
  const SLOT_ORDER = ['news', 'update', 'movers', 'cotd', 'soon'];
  const slot = (kind) => ({ features: 'update', update: 'update', movers: 'movers', collection: 'movers' }[kind] || kind);
  function assertRelative(slides, label) {
    const kinds = slides.map((s) => s.kind);
    const positions = kinds.map((k) => SLOT_ORDER.indexOf(slot(k)));
    assert.ok(positions.every((p) => p >= 0), label + ' uses only the five headliner slots: ' + kinds);
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i] > positions[i - 1], label + ' keeps relative order, got ' + kinds.join(','));
    }
    assert.ok(kinds.length <= 5, label + ' stays within five');
    assert.equal(new Set(kinds.map(slot)).size, kinds.length, label + ' has one slide per slot');
  }
  const catalogue = {
    visibleNews: () => [
      news({ title: 'Eternal Ascent preorders', date: '2026-09-11', source: 'Official site' }),
      news({ title: 'Card Reveal', date: '2026-09-25', source: 'X · @PalworldOCG_EN', image: 'https://pbs.twimg.com/media/reveal.jpg' }),
    ],
    moverCard: (dir, scope) => {
      if (scope === 'all' && dir === 'up') return { c: { id: 'EBP01-009', name: 'Jormuntide', els: ['Dragon'] }, pct: 8.1, prev: 10, cur: 12 };
      if (scope === 'collection' && dir === 'up') return { c: { id: 'EBP01-001', name: 'Lamball' }, pct: 3.2, prev: 1, cur: 2 };
      if (scope === 'collection' && dir === 'down') return { c: { id: 'EBP01-002', name: 'Cattiva' }, pct: -4.5, prev: 5, cur: 4 };
      return null;
    },
    SEALED: [
      { id: 'ss', set: 'Sleeve & Card Set Vol. 1', pre: true, date: 'Oct 16, 2026', banner: 'BOX_BANNER_SS01' },
    ],
    sealDate: (p) => p.date,
  };

  const full = app(catalogue);
  const slides = full.api.slides();
  // String(), not deepEqual: slides are built inside the vm, so their arrays are a different realm.
  assert.equal(String(slides.map((s) => s.kind)), 'news,features,movers,cotd,soon');
  assert.equal(slides.length, 5, 'a full set is exactly five');
  assert.equal(slides[0].badge, 'Latest news');
  assert.equal(slides[1].badge, 'Latest update features');
  assert.equal(slides[2].movers.map((m) => m.dir).join(','), 'up,down', 'movers carries the riser and the faller');
  assert.equal(slides[3].badge, 'Card of the day');
  assert.equal(slides[3].title, 'Jormuntide');
  assert.equal(slides[4].badge, 'Next release');
  assertRelative(slides, 'full');

  const behind = app({ ...catalogue, _latestAppVersion: '1.12' });
  assert.equal(String(behind.api.slides().map((s) => s.kind)), 'news,update,movers,cotd,soon');
  assert.equal(behind.api.slides()[1].badge, 'New update available');
  assertRelative(behind.api.slides(), 'behind');

  // News and movers have nothing to show. What remains keeps the same order.
  const sparse = app({
    visibleNews: () => [],
    SETTINGS: { mode: 'collector' },
    moverCard: (dir, scope) => (scope === 'all' && dir === 'up'
      ? { c: { id: 'EBP01-009', name: 'Jormuntide', els: ['Dragon'] }, pct: 8.1, prev: 10, cur: 12 } : null),
    SET_ORDER: ['LA02'],
    SET_META: { LA02: { name: 'Future Set', release: 'Dec 2026' } },
    SEALED: [],
  });
  assert.equal(String(sparse.api.slides().map((s) => s.kind)), 'features,cotd,soon');
  assertRelative(sparse.api.slides(), 'sparse');

  // No next release and no riser: card of the day falls back to a featured card only when there is a
  // catalogue to pick from, so with none the slide is left out and nothing else moves up.
  const noRelease = app({
    visibleNews: () => [
      news({ title: 'Eternal Ascent preorders', date: '2026-09-11', source: 'Official site' }),
      news({ title: 'Card Reveal', date: '2026-09-25', source: 'X · @PalworldOCG_EN', image: 'https://pbs.twimg.com/media/reveal.jpg' }),
    ],
    moverCard: () => null,
    pwPick: () => null,
    SET_ORDER: ['EBP01'],
    SET_META: { EBP01: { name: 'Dawn of Palpagos', release: 'Jul 9, 2026', art: 'data:art-ebp01' } },
    SEALED: [],
  });
  assert.equal(String(noRelease.api.slides().map((s) => s.kind)), 'news,features,collection');
  assertRelative(noRelease.api.slides(), 'no release');
});

test('a card reveal can be the news slide, and is never shown twice', () => {
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
  assert.equal(feat.badge, 'Latest update features');
  assert.match(feat.title, /1\.11/);
  assert.deepEqual(JSON.parse(JSON.stringify(feat.notes)), ['Note A for 1.11', 'Note B']);
  assert.equal(current.api.slides().some((s) => s.kind === 'update'), false);

  const ahead = app({
    APP_VERSION: '2.0',
    _latestAppVersion: '1.10',
    RELEASE_HIGHLIGHTS: { '2.0': ['Home headliners', 'Pal pages', 'Deck tools'], '1.10': ['Binder view', 'Set totals', 'Search'] },
    updateNotesFor: () => ['Price alerts', 'Sort', 'Filter'],
  });
  const own = ahead.api.slides().find((s) => s.kind === 'features');
  assert.ok(own, 'a build ahead of the store record still shows a features slide');
  // Its own lines wait for the server, so it shows the newest release the server does offer.
  assert.equal(own.version, '1.10');
  assert.deepEqual(JSON.parse(JSON.stringify(own.notes)), ['Binder view', 'Set totals', 'Search']);
  assert.equal(ahead.api.slides().some((s) => s.kind === 'update'), false);
});

test('an out of date app meets the update slide after latest news', () => {
  const behind = app({
    _latestAppVersion: '1.12',
    visibleNews: () => [news({ title: 'Official update', source: 'Official site' })],
    moverCard: (dir, scope) => (scope === 'all' && dir === 'up'
      ? { c: { id: 'EBP01-009', name: 'Jormuntide' }, pct: 4, prev: 1, cur: 2 } : null),
  });
  const kinds = behind.api.slides().map((s) => s.kind);
  assert.equal(kinds[0], 'news', 'latest news stays first, even when an update is waiting');
  assert.equal(kinds[1], 'update', 'the update slide is second');
  assert.ok(kinds.indexOf('update') < kinds.indexOf('cotd'), 'the update stays ahead of the card of the day');
  assert.equal(behind.api.slides()[1].badge, 'New update available');
  assert.equal(kinds.filter((k) => k === 'update').length, 1);
  assert.equal(new Set(kinds).size, kinds.length, 'no kind appears twice');
  const noNews = app({ _latestAppVersion: '1.12' });
  assert.equal(noNews.api.slides()[0].kind, 'update', 'with no news the update slide takes the first slot');
  const current = app();
  assert.equal(current.api.slides().some((s) => s.kind === 'update'), false, 'an up to date app has no update slide at all');
});

test('the update slide uses the banner the server names, because an old build has none for a newer version', () => {
  const url = 'https://spheredex.app/app/img/UPDATE_1_12.webp';
  // RELEASE_ART only knows this build's own releases, exactly like a real install that predates 1.12.
  const behind = app({
    _latestAppVersion: '1.12',
    RELEASE_ART: { '1.11': 'img/UPDATE_1_11.webp' },
    _latestArt: url,
  });
  const up = behind.api.slides().find((s) => s.kind === 'update');
  assert.equal(up.art, url);
  assert.equal(up.releaseArt, true, 'it renders as a release banner, not as set art');

  // With no server url it must not invent one: it falls back to set art and is not a banner.
  const noArt = app({ _latestAppVersion: '1.12', RELEASE_ART: { '1.11': 'img/UPDATE_1_11.webp' } });
  const plain = noArt.api.slides().find((s) => s.kind === 'update');
  assert.equal(plain.releaseArt, false);
  assert.notEqual(plain.art, url);

  // A bundled banner for that version still wins, so an app that does carry it stays offline capable.
  const bundled = app({ _latestAppVersion: '1.12', RELEASE_ART: { '1.12': 'img/UPDATE_1_12.webp' }, _latestArt: url });
  assert.equal(bundled.api.slides().find((s) => s.kind === 'update').art, 'img/UPDATE_1_12.webp');
});

test('tapping the update slide goes to the store, and tapping the features slide goes to the roadmap', () => {
  // iOS and Android: storeUrl answers, so the tap leaves for the store and says nothing.
  for (const store of ['https://apps.apple.com/app/id6804377686',
                       'https://play.google.com/store/apps/details?id=app.spheredex']) {
    const a = app({ _latestAppVersion: '1.12', storeUrl: () => store });
    a.api.open(a.api.slides().find((s) => s.kind === 'update'));
    assert.deepEqual(a.opened, [store]);
    assert.deepEqual(a.toasts, [], 'no toast when the store actually opens');
  }

  // The web has no store, so the newest build is the next load: it keeps the reload path.
  const web = app({ _latestAppVersion: '1.12' });
  web.api.open(web.api.slides().find((s) => s.kind === 'update'));
  assert.deepEqual(web.opened, [], 'the web never opens a store page');
  assert.equal(web.toasts.length, 1);
  assert.match(web.toasts[0], /Reloading/);

  // Up to date: the tap opens that version's own section of the roadmap.
  const current = app();
  current.api.open(current.api.slides().find((s) => s.kind === 'features'));
  assert.deepEqual(current.opened, ['https://spheredex.app/roadmap#v1-11']);
  assert.deepEqual(current.toasts, [], 'the roadmap replaces the old "you are on x" toast');

  // If opening is impossible the old toast is still there rather than a dead tap.
  const blocked = app({ roadmapUrl: () => '' });
  blocked.api.open(blocked.api.slides().find((s) => s.kind === 'features'));
  assert.equal(blocked.toasts.length, 1);
  assert.match(blocked.toasts[0], /SphereDex 1\.11/);
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
  assert.ok(a.api.slides().length <= 5, 'extra news items do not become extra slides');
  assert.equal(a.api.slides().filter((s) => s.kind === 'news').length, 1, 'one news slide however many stories');
  assert.match(srcSection('logic'), /return out\.slice\(0,\s*5\)/, 'the cap is five');
});

// Today's feed, in miniature: the website last posted a week ago, the English account posted an
// announcement and a reveal this morning, the Japanese account and a fan site posted later still.
const FEED_OCT14 = [
  news({ title: 'New cards from Booster Pack Vol. 2 revealed', date: '2026-10-14', published: '2026-10-14T09:00:00.000Z', source: 'X · @PalworldOCG', link: 'https://x.com/PalworldOCG/status/3', image: 'https://pbs.twimg.com/media/jp.jpg' }),
  news({ title: 'A fan site story', date: '2026-10-15', source: 'FoilWire', link: 'https://foilwire.com/a' }),
  news({ title: 'Important Announcement Regarding Legends Awaken Product Availability', date: '2026-10-14', published: '2026-10-14T01:00:02.000Z', source: 'X · @PalworldOCG_EN', link: 'https://x.com/PalworldOCG_EN/status/1' }),
  news({ title: 'Card reveal: Pengullet (Legends Awaken)', date: '2026-10-14', published: '2026-10-14T02:00:01.000Z', source: 'X · @PalworldOCG_EN', link: 'https://x.com/PalworldOCG_EN/status/2' }),
  news({ title: 'Legends Awaken Release Tournament', date: '2026-10-07', published: '2026-10-07T09:00:03.000Z', source: 'Official site', link: 'https://en.palworld-official-cardgame.com/events/la' }),
  news({ title: '11 Million Packs', date: '2026-10-07', published: '2026-10-07T06:30:00.000Z', source: 'Official site', link: 'https://en.palworld-official-cardgame.com/news/post-20', image: 'https://example.test/press.jpg' }),
];

test('the news slide is the newest story from the official site or @PalworldOCG_EN', () => {
  const a = app({ visibleNews: () => FEED_OCT14 });
  const lead = a.api.slides()[0];
  assert.equal(lead.kind, 'news');
  // The 02:00 reveal beats the 01:00 announcement on the same day; the Japanese account and the fan site
  // are newer still, but they never lead.
  assert.equal(lead.title, 'Card reveal: Pengullet (Legends Awaken)');
  assert.match(lead.meta, /Official X$/);
  assert.equal(a.api.leads(FEED_OCT14[0]), false, 'the Japanese account does not lead');
  assert.equal(a.api.leads(FEED_OCT14[1]), false, 'a fan site does not lead');
  assert.equal(a.api.leads(FEED_OCT14[2]), true);
  assert.equal(a.api.leads(news({ title: 'Seed item' })), true, 'seed items with no source still count as official');

  // Without the English account the website leads again, labelled as such, newest publish time first.
  const site = app({ visibleNews: () => FEED_OCT14.filter((n) => !/PalworldOCG_EN/.test(n.source)) });
  assert.equal(site.api.slides()[0].title, 'Legends Awaken Release Tournament');
  assert.match(site.api.slides()[0].meta, /Official site$/);
});

// One day of the feed where some English account posts carry no publish time. The old comparator let an
// untimed story tie with everything on its day, which is not a consistent order, so card 1 depended on
// the order the feed arrived in.
const FEED_OCT07_MIXED = [
  news({ title: '11 Million Packs', date: '2026-10-07', published: '2026-10-07T06:30:00.000Z', source: 'Official site', link: 'https://en.palworld-official-cardgame.com/news/post-20' }),
  news({ title: 'Untimed reveal A', date: '2026-10-07', source: 'X · @PalworldOCG_EN', link: 'https://x.com/PalworldOCG_EN/status/11' }),
  news({ title: 'Untimed reveal B', date: '2026-10-07', source: 'X · @PalworldOCG_EN', link: 'https://x.com/PalworldOCG_EN/status/12' }),
  news({ title: 'Legends Awaken Release Tournament', date: '2026-10-07', published: '2026-10-07T09:00:00.000Z', source: 'Official site', link: 'https://en.palworld-official-cardgame.com/events/la' }),
  news({ title: 'Card reveal at two', date: '2026-10-07', published: '2026-10-07T02:00:00.000Z', source: 'X · @PalworldOCG_EN', link: 'https://x.com/PalworldOCG_EN/status/13' }),
];
function permutations(list) {
  if (list.length <= 1) return [list.slice()];
  const out = [];
  list.forEach((item, i) => {
    const rest = list.slice(0, i).concat(list.slice(i + 1));
    permutations(rest).forEach((p) => out.push([item].concat(p)));
  });
  return out;
}

test('card 1 is the newest timed story of the day whatever order the feed arrives in', () => {
  let feed = FEED_OCT07_MIXED;
  const a = app({ visibleNews: () => feed });
  const orders = permutations(FEED_OCT07_MIXED);
  assert.equal(orders.length, 120);
  for (const order of orders) {
    feed = order;
    const lead = a.api.slides()[0];
    const seen = order.map((n) => n.title).join(' | ');
    assert.equal(lead.kind, 'news', seen);
    assert.equal(lead.title, 'Legends Awaken Release Tournament', seen);
    assert.match(lead.meta, /Official site$/, seen);
  }
});

test('within a day an untimed story sorts after every timed one, and two untimed stories tie', () => {
  const featNewer = app().sandbox.featNewer;
  assert.equal(typeof featNewer, 'function');
  const [packs, untimedA, untimedB, tournament, reveal] = FEED_OCT07_MIXED;
  for (const timed of [packs, tournament, reveal]) {
    assert.ok(featNewer(untimedA, timed) > 0, 'untimed after ' + timed.title);
    assert.ok(featNewer(timed, untimedA) < 0, timed.title + ' before untimed');
  }
  assert.equal(featNewer(untimedA, untimedB), 0, 'two untimed stories tie');
  assert.ok(featNewer(tournament, packs) < 0, '09:00 before 06:30');
  assert.ok(featNewer(packs, reveal) < 0, '06:30 before 02:00');
  // The day still comes first: an untimed story from a newer day beats a timed one from an older day.
  const nextDay = news({ title: 'Next day, untimed', date: '2026-10-08', source: 'Official site' });
  assert.ok(featNewer(nextDay, tournament) < 0);
  assert.ok(featNewer(tournament, nextDay) > 0);
  // Every input order sorts to the same timed sequence, with the untimed pair last.
  for (const order of permutations(FEED_OCT07_MIXED)) {
    const titles = order.slice().sort(featNewer).map((n) => n.title);
    assert.deepEqual(titles.slice(0, 3), ['Legends Awaken Release Tournament', '11 Million Packs', 'Card reveal at two']);
    assert.deepEqual(titles.slice(3).sort(), ['Untimed reveal A', 'Untimed reveal B']);
  }
});

test('the news slide says where its story came from', () => {
  const a = app();
  assert.equal(a.api.newsFrom(news({ source: 'X · @PalworldOCG_EN', link: 'https://x.com/PalworldOCG_EN/status/1' })), 'Official X');
  assert.equal(a.api.newsFrom(news({ source: 'x:PalworldOCG_EN', link: 'https://x.com/PalworldOCG_EN/status/1' })), 'Official X');
  assert.equal(a.api.newsFrom(news({ source: 'X · @PalworldOCG', link: 'https://x.com/PalworldOCG/status/1' })), '@PalworldOCG on X');
  assert.equal(a.api.newsFrom(news({ source: 'Official site' })), 'Official site');
  assert.equal(a.api.newsFrom(news({})), 'Official site');
  assert.equal(a.api.newsFrom(news({ source: 'FoilWire' })), 'FoilWire');
});

test('a story with no picture shows the box art of the product it names', () => {
  const a = app({ visibleNews: () => [news({ title: 'Legends Awaken Release Tournament', date: '2026-10-07', source: 'Official site' })] });
  a.window.CARD_IMG = { BOX_BANNER_BP02: 'img/BOX_BANNER_BP02.webp', BOX_BANNER_EBP01_2E: 'img/BOX_BANNER_EBP01_2E.webp' };
  assert.equal(a.api.slides()[0].art, 'img/BOX_BANNER_BP02.webp');
  // The reprint is checked before the first set it also names.
  assert.equal(a.api.newsBanner(news({ title: 'Dawn of Palpagos 2nd Edition ships late October' })), 'img/BOX_BANNER_EBP01_2E.webp');
  // A story with its own picture keeps it.
  const own = app({ visibleNews: () => [news({ title: 'Legends Awaken', source: 'Official site', image: 'https://example.test/own.jpg' })] });
  own.window.CARD_IMG = { BOX_BANNER_BP02: 'img/BOX_BANNER_BP02.webp' };
  assert.equal(own.api.slides()[0].art, 'https://example.test/own.jpg');
  // No banner for the product: the set art fallback is unchanged.
  const none = app({ visibleNews: () => [news({ title: 'Card List Added for "Dawn of Palpagos"', source: 'Official site' })] });
  assert.equal(none.api.slides()[0].art, 'data:art-ebp01');
});

test('dismissing everything in the bell does not empty the news slide', () => {
  const a = app({ visibleNews: () => [], _newsList: [news({ title: 'Still the latest', source: 'Official site' })] });
  assert.equal(a.api.slides()[0].kind, 'news');
  assert.equal(a.api.slides()[0].title, 'Still the latest');
});

test('card of the day is always there: a featured card when nothing rose today', () => {
  const CARDS = [
    { id: 'EBP01-001', name: 'Lamball', rare: 'C' },
    { id: 'EBP01-010', name: 'Anubis', rare: 'OSR' },
    { id: 'EBP01-011', name: 'Jetragon', rare: 'SR' },
  ];
  const priced = app({ CARDS, PRICEBOOK: { 'EBP01-001': 2, 'EBP01-010': 40 }, todayKey: () => '2026-10-14' });
  const cotd = priced.api.slides().find((s) => s.kind === 'cotd');
  assert.ok(cotd, 'the slot is filled with no riser at all');
  assert.equal(cotd.badge, 'Card of the day');
  assert.equal(cotd.cotd.featured, true);
  assert.ok(['Lamball', 'Anubis'].includes(cotd.title), 'picked from the cards with a price: ' + cotd.title);
  // The same card all day.
  const again = app({ CARDS, PRICEBOOK: { 'EBP01-001': 2, 'EBP01-010': 40 }, todayKey: () => '2026-10-14' });
  assert.equal(again.api.slides().find((s) => s.kind === 'cotd').title, cotd.title);
  priced.api.render();
  assert.match(priced.host.innerHTML, /No big movers yet today/);
  assert.doesNotMatch(priced.host.innerHTML, /\+0\.0%/, 'never a zero gain');

  // No prices yet: a chase rarity, shown with its rarity instead of a price.
  const unpriced = app({ CARDS, todayKey: () => '2026-10-14' });
  const pick = unpriced.api.slides().find((s) => s.kind === 'cotd');
  assert.ok(['Anubis', 'Jetragon'].includes(pick.title), 'a chase card: ' + pick.title);
  unpriced.api.render();
  assert.match(unpriced.host.innerHTML, /<i>rarity<\/i>/);

  // A real riser still wins.
  const rising = app({ CARDS, PRICEBOOK: { 'EBP01-001': 2 }, moverCard: (dir, scope) => (scope === 'all' && dir === 'up'
    ? { c: { id: 'EBP01-011', name: 'Jetragon' }, pct: 8.1, prev: 10, cur: 12 } : null) });
  const real = rising.api.slides().find((s) => s.kind === 'cotd');
  assert.equal(real.title, 'Jetragon');
  assert.notEqual(real.cotd.featured, true);
});

test('the next release names a reprint and shows its own banner', () => {
  const a = app({
    SEALED: [
      { id: 'box-ebp01-2e', set: 'Dawn of Palpagos', rel: 'Dawn of Palpagos 2nd Edition', box: 'BOX_BANNER_EBP01_2E', banner: 'BOX_BANNER_EBP01', pre: true, date: 'late Oct 2026' },
      { id: 'box-bp02', set: 'Legends Awaken', box: 'BOX_EBP02', banner: 'BOX_BANNER_BP02', pre: true, date: 'Oct 30, 2026' },
    ],
    sealDate: (p) => p.date,
  });
  a.window.CARD_IMG = { BOX_BANNER_EBP01_2E: 'img/2e.webp', BOX_BANNER_EBP01: 'img/1e.jpg', BOX_BANNER_BP02: 'img/bp02.webp', BOX_EBP02: 'img/box.webp' };
  const soon = a.api.slides().find((s) => s.kind === 'soon');
  // The headline needs a real day, so the reprint's "late Oct 2026" cannot hold it while a dated release
  // is waiting. It still names itself, as a row, which is where a date with no day belongs.
  assert.equal(soon.title, 'Legends Awaken');
  assert.equal(soon.rows[0].name, 'Dawn of Palpagos 2nd Edition');
  assert.equal(soon.rows[0].date, 'late Oct 2026');
  // On its own the reprint is the headline again, with its own banner rather than the July set's.
  const only = app({
    SEALED: [{ id: 'box-ebp01-2e', set: 'Dawn of Palpagos', rel: 'Dawn of Palpagos 2nd Edition', box: 'BOX_BANNER_EBP01_2E', banner: 'BOX_BANNER_EBP01', pre: true, date: 'late Oct 2026' }],
    sealDate: (p) => p.date,
  });
  only.window.CARD_IMG = { BOX_BANNER_EBP01_2E: 'img/2e.webp', BOX_BANNER_EBP01: 'img/1e.jpg' };
  const alone = only.api.slides().find((s) => s.kind === 'soon');
  assert.equal(alone.title, 'Dawn of Palpagos 2nd Edition');
  assert.equal(alone.art, 'img/2e.webp', 'the reprint banner, not the July set');
  assert.equal(alone.badge, 'Next release', 'one release is not a timeline');
  // A product whose box is a box shot, not a banner, keeps its banner.
  const b = app({ SEALED: [{ id: 'box-bp02', set: 'Legends Awaken', box: 'BOX_EBP02', banner: 'BOX_BANNER_BP02', pre: true, date: 'Oct 30, 2026' }], sealDate: (p) => p.date });
  b.window.CARD_IMG = { BOX_BANNER_BP02: 'img/bp02.webp', BOX_EBP02: 'img/box.webp' };
  assert.equal(b.api.slides().find((s) => s.kind === 'soon').art, 'img/bp02.webp');
});

test('an up to date build with no banner of its own uses the one the server names for its version', () => {
  const art = 'https://spheredex.app/app/img/UPDATE_1_11.webp';
  const a = app({ RELEASE_ART: {}, _latestArt: art, _latestAppVersion: '1.11', RELEASE_HIGHLIGHTS: { '1.11': ['One', 'Two', 'Three'] } });
  const feat = a.api.slides().find((s) => s.kind === 'features');
  assert.equal(feat.art, art);
  assert.equal(feat.releaseArt, true);
  // A banner baked into the build still wins over the server's.
  const baked = app({ RELEASE_ART: { '1.11': 'img/UPDATE_1_11.webp' }, _latestArt: art, _latestAppVersion: '1.11', RELEASE_HIGHLIGHTS: { '1.11': ['One'] } });
  assert.equal(baked.api.slides().find((s) => s.kind === 'features').art, 'img/UPDATE_1_11.webp');
  // Server art for some other version is never put on this one.
  const other = app({ RELEASE_ART: {}, _latestArt: art, _latestAppVersion: '1.10', RELEASE_HIGHLIGHTS: { '1.11': ['One'], '1.09': ['Old'] } });
  const f2 = other.api.slides().find((s) => s.kind === 'features');
  assert.notEqual(f2 && f2.version, '1.11');
});

// Runs the real fetchServerPrices against a stubbed price server, recording every toast and repaint.
async function refreshPrices({ live, page, silent }) {
  const calls = { toasts: [], render: 0, renderFeatured: 0, renderSetBrowse: 0, refreshLabel: 0 };
  const store = {};
  const sandbox = {
    _curPage: page,
    apiBase: () => 'https://api.example.test', ebayReg: () => 'uk',
    api: () => Promise.resolve({ ok: true, body: { prices: {}, live, sold: {} } }),
    toast: (m) => calls.toasts.push(String(m)),
    priceFetchOk() {}, priceFetchFailed() {}, priceErr: () => 'price error',
    saneSold: (id, v) => v, stampSoldMark() {},
    lsGet: (k) => (k in store ? store[k] : null), lsSet: (k, v) => { store[k] = String(v); },
    localStorage: { setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; }, getItem: (k) => store[k] || null },
    console: { warn() {} },
    renderFoot() {}, renderPriceSources() {},
    render: () => { calls.render++; },
    renderSetBrowse: () => { calls.renderSetBrowse++; },
    renderFeatured: () => { calls.renderFeatured++; },
    updateRefreshLabel: () => { calls.refreshLabel++; },
    PRICEBOOK: {}, PRICEMETA: {}, PRICEPREV: {}, PRICESRC: {},
    PRICEBOOK_SOLD: {}, PRICEMETA_SOLD: {}, PRICESRC_SOLD: {},
    PRICEASOF: 0, LIVE_ASOF: 0, SOLD_ASOF: 0, LIVE_COV: null, SOLD_COV: null,
  };
  const context = vm.createContext(sandbox);
  const fetchServerPrices = vm.runInContext('(' + appFunctionSource('fetchServerPrices') + ')', context);
  await fetchServerPrices(silent);
  return { calls, sandbox };
}
const TWO_PRICES = { 'EBP01-001': { market: 2, source: 'ebay' }, 'EBP01-010': { market: 40, source: 'ebay' } };

test('the app keeps Home current while it stays open', () => {
  const source = fs.readFileSync(FILES.src, 'utf8');
  const timer = /setInterval\(function\(\)\{\s*if\(document\.hidden\) return;\s*try\{ primeNewsBell\(\); \}catch\(e\)\{\}\s*try\{ checkAppVersion\(\); \}catch\(e\)\{\}\s*try\{ priceBookGate\(\); \}catch\(e\)\{\}\s*\}, 30\*60\*1000\);/;
  assert.match(source, timer, 'a 30 minute refresh while the page is visible');
});

test('Refresh now on Settings says how many prices it updated, and nothing else', async () => {
  const { calls, sandbox } = await refreshPrices({ live: TWO_PRICES, page: 'settings', silent: false });
  assert.deepEqual(calls.toasts, ['Updated 2 market prices'], 'one toast, and never "No market prices available yet"');
  assert.ok(calls.toasts[0].startsWith('Updated'));
  assert.equal(calls.render, 1);
  assert.equal(calls.renderFeatured, 0, 'the carousel is not repainted off Home');
  assert.equal(sandbox.PRICEBOOK['EBP01-010'], 40);
});

test('new prices repaint the carousel on Home, with the same single toast', async () => {
  const { calls } = await refreshPrices({ live: TWO_PRICES, page: 'home', silent: false });
  assert.equal(calls.renderFeatured, 1, 'the movers and card of the day are repainted once');
  assert.equal(calls.toasts.length, 1);
  assert.ok(calls.toasts[0].startsWith('Updated'), calls.toasts[0]);
  // A background refresh repaints Home just the same, without a toast.
  const quiet = await refreshPrices({ live: TWO_PRICES, page: 'home', silent: true });
  assert.equal(quiet.calls.renderFeatured, 1);
  assert.deepEqual(quiet.calls.toasts, []);
});

test('a refresh that brings no prices says so once, and repaints nothing', async () => {
  for (const page of ['settings', 'home']) {
    const { calls } = await refreshPrices({ live: {}, page, silent: false });
    assert.deepEqual(calls.toasts, ['No market prices available yet'], page);
    assert.equal(calls.render, 0, page);
    assert.equal(calls.renderFeatured, 0, page);
    assert.equal(calls.refreshLabel, 1, page + ': the refresh label still updates');
  }
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
  // features leaves for the roadmap rather than toasting the version back at the reader.
  assert.deepEqual(a.opened, ['https://spheredex.app/roadmap#v1-11']);
  assert.deepEqual(a.toasts, []);
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
  assert.equal(feat.badge, 'Latest update features');
  assert.equal(feat.art, banner);
  assert.equal(feat.releaseArt, true);
  features.api.render();
  const featHtml = features.host.innerHTML.match(/<button class="featslide[^"]*\brelease\b[\s\S]*?<\/button>/);
  assert.ok(featHtml, 'features slide is marked release');
  assert.match(featHtml[0], /class="featbg"><img src="img\/UPDATE_2_1\.webp"/);
  assert.equal(featHtml[0].includes('class="featart'), false, 'the collage is the frame, not a side card');
  assert.equal(featHtml[0].includes('class=\"featbody\"'), false, 'the banner already carries the copy, so it is not repeated');
  assert.match(featHtml[0], /<img src=\"img\/UPDATE_2_1\.webp\" alt=\"[^\"]+\"/, 'the words that live only in the art reach a screen reader');
  // Every slide is the same size now, so the carousel must never switch to the old growing mode.
  assert.equal(/\bbanneropen\b/.test(features.host.className), false, 'the carousel keeps one height');

  const update = app({ ...base, APP_VERSION: '2.0', _latestAppVersion: '2.1' });
  const up = update.api.slides().find((s) => s.kind === 'update');
  assert.ok(up, 'a build behind 2.1 shows the update slide');
  assert.equal(up.badge, 'New update available');
  assert.equal(up.version, '2.1');
  assert.equal(up.art, banner);
  assert.equal(up.releaseArt, true);
  update.api.render();
  assert.match(update.host.innerHTML, /<button class="featslide[^"]*\brelease\b[\s\S]*?src="img\/UPDATE_2_1\.webp"/);

  const fallback = app({ ...base, APP_VERSION: '9.9', _latestAppVersion: '9.9' });
  const own = fallback.api.slides().find((s) => s.kind === 'features');
  assert.ok(own, 'an unmapped version still shows a features slide');
  assert.equal(own.releaseArt, false);
  assert.equal(own.art, 'data:art-ebp01', 'unmapped version keeps the set-art fallback');
  assert.notEqual(own.art, banner);
  fallback.api.render();
  assert.equal(/class="featslide[^"]*\brelease\b/.test(fallback.host.innerHTML), false);
  assert.match(fallback.host.innerHTML, /src="data:art-ebp01"/);
  assert.equal(/\bbanneropen\b/.test(fallback.host.className), false);
  // The rule that made this one slide taller than the rest is gone from the stylesheet entirely.
  assert.equal(/\.featured\.banneropen\s*\{/.test(source), false, 'no height override is left for the release slide');
  assert.match(source, /\.featslide\.release \.featart, \.featslide\.release \.featbody \{ display:none; \}/);

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

// The real release tables and version compare from the app, so the gate is tested on what ships.
function releaseTables() {
  const source = fs.readFileSync(FILES.src, 'utf8');
  const hi = source.match(/var RELEASE_HIGHLIGHTS = (\{[\s\S]*?\n  \});/);
  const art = source.match(/var RELEASE_ART = (\{[\s\S]*?\n  \});/);
  assert.ok(hi && art, 'RELEASE_HIGHLIGHTS and RELEASE_ART are in the source');
  return {
    RELEASE_HIGHLIGHTS: vm.runInNewContext('(' + hi[1] + ')'),
    RELEASE_ART: vm.runInNewContext('(' + art[1] + ')'),
    verNum: appFunction('verNum'),
    visibleNews: () => [],
  };
}
const featuresSlide = (a) => a.api.slides().find((s) => s.kind === 'features');

test('in the iOS and Android apps the 2.4 slide waits until the store offers 2.4', () => {
  const t = releaseTables();
  for (const platform of [{ isIosApp: () => true, isAndroidApp: () => false }, { isIosApp: () => false, isAndroidApp: () => true }]) {
    const early = featuresSlide(app({ ...t, ...platform, APP_VERSION: '2.4', _latestAppVersion: '2.3' }));
    assert.ok(early, 'a features slide still shows');
    assert.equal(early.version, '2.3');
    assert.equal(early.title, 'What’s new in 2.3');
    assert.deepEqual([...early.notes], [...t.RELEASE_HIGHLIGHTS['2.3'].slice(0, 3)]);
    assert.equal(early.art, 'img/UPDATE_2_3.webp');
    assert.equal(early.releaseArt, true);

    const live = featuresSlide(app({ ...t, ...platform, APP_VERSION: '2.4', _latestAppVersion: '2.4' }));
    assert.equal(live.version, '2.4');
    assert.equal(live.title, 'What’s new in 2.4');
    assert.deepEqual([...live.notes], [...t.RELEASE_HIGHLIGHTS['2.4'].slice(0, 3)]);
    assert.equal(live.art, 'img/UPDATE_2_4.webp');

    for (const unknown of ['', undefined]) {
      const none = featuresSlide(app({ ...t, ...platform, APP_VERSION: '2.4', _latestAppVersion: unknown }));
      assert.equal(none.version, '2.3', 'nothing known yet falls back to the newest release below this build');
      assert.equal(none.art, 'img/UPDATE_2_3.webp');
    }
  }
});

test('on the web the 2.4 slide waits until the server says the web is on 2.4', () => {
  const t = releaseTables();
  for (const platform of [{}, { isIosApp: () => false, isAndroidApp: () => false }]) {
    const early = featuresSlide(app({ ...t, ...platform, APP_VERSION: '2.4', _latestAppVersion: '2.3' }));
    assert.ok(early, 'a features slide still shows');
    assert.equal(early.version, '2.3');
    assert.equal(early.title, 'What’s new in 2.3');
    assert.deepEqual([...early.notes], [...t.RELEASE_HIGHLIGHTS['2.3'].slice(0, 3)]);
    assert.equal(early.art, 'img/UPDATE_2_3.webp');

    const live = featuresSlide(app({ ...t, ...platform, APP_VERSION: '2.4', _latestAppVersion: '2.4' }));
    assert.equal(live.version, '2.4');
    assert.equal(live.title, 'What’s new in 2.4');
    assert.equal(live.art, 'img/UPDATE_2_4.webp');

    for (const unknown of ['', undefined]) {
      const none = featuresSlide(app({ ...t, ...platform, APP_VERSION: '2.4', _latestAppVersion: unknown }));
      assert.equal(none.version, '2.3', 'web with no answer falls back to the newest release below this build');
      assert.equal(none.art, 'img/UPDATE_2_3.webp');
    }
  }
});

test('a build behind the store still gets the update slide, native or web', () => {
  const t = releaseTables();
  for (const platform of [{ isIosApp: () => true }, { isAndroidApp: () => true }, {}]) {
    const a = app({ ...t, ...platform, APP_VERSION: '2.4', _latestAppVersion: '2.5', updateNotesFor: () => ['New in 2.5'] });
    const up = a.api.slides().find((s) => s.kind === 'update');
    assert.ok(up, 'update slide');
    assert.equal(up.version, '2.5');
    assert.equal(up.title, 'SphereDex 2.5 is here');
    assert.equal(featuresSlide(a), undefined);
  }
});

test('the 2.4 release banner is a real 1600x900 file in the built output', () => {
  const t = releaseTables();
  const rel = t.RELEASE_ART['2.4'];
  assert.equal(rel, 'img/UPDATE_2_4.webp');
  const copies = ['docs/app/', 'app/src/main/assets/', 'ios/SphereDex/SphereDex/Resources/'].map((dir) => {
    const file = path.join(REPO, dir + rel);
    assert.equal(fs.existsSync(file), true, dir + rel + ' is in the built output');
    return fs.readFileSync(file);
  });
  const web = copies[0];
  assert.ok(web.length > 1000 && web.length < 250 * 1024, 'banner is an optimised file under 250KB');
  assert.equal(web.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(web.subarray(8, 12).toString('ascii'), 'WEBP');
  assert.equal(web.subarray(23, 26).toString('hex'), '9d012a');
  assert.equal(web.readUInt16LE(26) & 0x3fff, 1600);
  assert.equal(web.readUInt16LE(28) & 0x3fff, 900);
  for (const copy of copies.slice(1)) assert.equal(copy.equals(web), true, 'native bundles mirror the web banner');
  assert.equal(fs.existsSync(path.join(REPO, 'tools', 'make_release_banner.py')), true, 'the banner can be regenerated');
});

test('bind is idempotent: re-render never stacks a second set of listeners', () => {
  const a = app({ visibleNews: () => [news({ title: 'Official update' })] });
  a.api.render();
  a.api.render();
  a.api.bind();
  assert.equal(a.host._listeners.click.length, 1, 'exactly one delegated click listener');
  assert.equal(a.host._listeners.keydown.length, 1, 'exactly one keydown listener');
});

// The only thing that moves on the card of the day is the background burst. The scan sweep and the
// card foil shimmer were both removed by request, and "just a subtle shimmer" is exactly the kind of
// thing that creeps back in later, so the rule is a test rather than a comment.
test('card of the day: the burst turns and nothing else moves', () => {
  const css = readSection(FILES.src, 'style');
  const zone = css.slice(css.indexOf('.cotdaura {'));
  assert.ok(zone.length > 200, 'found the card of the day styles');

  const keyframes = [...css.matchAll(/@keyframes\s+(cotd\w*)/g)].map((m) => m[1]);
  assert.deepEqual(keyframes, ['cotdspin'], 'exactly one card of the day animation exists: the burst');

  // Every animation declaration in the zone is either the spin itself or an off switch.
  const decls = [...zone.matchAll(/animation\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
  assert.ok(decls.length > 0, 'the burst animation is declared');
  for (const d of decls) {
    assert.ok(/^cotdspin\b/.test(d) || d === 'none', `unexpected animation on the slide: ${d}`);
  }

  // And the only element that animates is the burst layer.
  const animated = [...zone.matchAll(/([^{}]+)\{[^{}]*animation\s*:\s*cotdspin/g)].map((m) => m[1].trim());
  assert.ok(animated.length > 0, 'found the rule that animates the burst');
  for (const sel of animated) {
    assert.match(sel, /\.cotdhud::before/, `only the burst layer animates, not ${sel}`);
  }

  // Scoped to the zone on purpose: the carousel has its own long standing reduced motion block
  // further up the section, and searching the whole of it finds that one instead.
  const idx = zone.indexOf('prefers-reduced-motion:reduce');
  assert.ok(idx > 0, 'the card of the day styles carry their own reduced motion block');
  const tail = zone.slice(idx, idx + 220);
  assert.match(tail, /\.cotdhud::before/, 'the reduced motion block names the burst layer');
  assert.match(tail, /animation:\s*none/, 'the burst stops under prefers-reduced-motion');
});

// The whole point of the burst is that it is the CARD's colour, not a fixed brand colour. If someone
// swaps the tint for a hardcoded hex, every one of the 277 cards silently gets the same slide again.
test('card of the day: the burst is drawn in the card tint, with a fallback', () => {
  const css = readSection(FILES.src, 'style');
  const rule = css.match(/\.cotdhud::before\s*\{([\s\S]*?)\}/);
  assert.ok(rule, '.cotdhud::before exists');
  assert.match(rule[1], /var\(--cotd-t\)/, 'the rays use the per-card tint');
  assert.match(css, /@supports not \(background-image:repeating-conic-gradient/,
    'a conic-gradient fallback is declared for old WebViews');
  // The tint itself has to reach the element, or the fallback colour is all anyone ever sees.
  const logic = readSection(FILES.src, 'logic');
  assert.match(logic, /--cotd-tint:/, 'the renderer puts the tint on the slide');
  assert.match(logic, /function featCotdTint/, 'the tint is derived from the card');
});

// Collector mode (Settings > Track value off) hides every price surface app wide through one rule,
// `.collector .priceui`. The card of the day has to opt into it rather than quote a market at someone
// who asked not to see one. The slide itself stays: a featured card is still worth showing.
test('card of the day: the price surfaces follow collector mode', () => {
  const logic = readSection(FILES.src, 'logic');
  const css = fs.readFileSync(FILES.src, 'utf8');
  assert.match(logic, /class="cotdfig priceui"/, 'the percentage figure carries .priceui');
  assert.match(logic, /class="cotdsub priceui"/, 'the price line carries .priceui');
  // And the mechanism it is opting into still exists.
  assert.match(css, /\.collector \.priceui\{ display:none !important; \}/,
    'the app wide collector-mode price hide is still in place');
});
