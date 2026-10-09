'use strict';

// Run with: node tools/test_sealed_images.cjs
// Live sealed product images: docs/sealed/images.json, the files it names, and the
// launch loader next to fetchReleases() in src/paldeck.html.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const sourcePath = path.join(root, 'src', 'paldeck.html');
const feedPath = path.join(root, 'docs', 'sealed', 'images.json');
const imgDir = path.join(root, 'docs', 'sealed', 'img');
const readmePath = path.join(root, 'docs', 'sealed', 'README.md');
const source = fs.readFileSync(sourcePath, 'utf8');

const IMG_PREFIX = 'https://spheredex.app/sealed/img/';
const URL_RE = /^https:\/\/spheredex\.app\/sealed\/img\/[A-Z0-9_]+\.webp$/;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PACKSHOT_MAX = 700;
const BANNER_MAX_W = 840;
const BANNER_MAX_H = 1050;
const MAX_BYTES = 512 * 1024;
const FIELDS = ['banner', 'box', 'edition', 'id', 'official', 'replace', 'source_url'];

function extractBlock() {
  const begin = '/* SEALED IMAGES BEGIN */';
  const end = '/* SEALED IMAGES END */';
  const starts = [];
  let at = 0;
  while ((at = source.indexOf(begin, at)) !== -1) { starts.push(at); at += begin.length; }
  const ends = [];
  at = 0;
  while ((at = source.indexOf(end, at)) !== -1) { ends.push(at); at += end.length; }
  assert.equal(starts.length, 1, 'SEALED IMAGES BEGIN marker once');
  assert.equal(ends.length, 1, 'SEALED IMAGES END marker once');
  assert.ok(starts[0] < ends[0]);
  return source.slice(starts[0] + begin.length, ends[0]);
}

function sealedIds() {
  const start = source.indexOf('var SEALED = [');
  assert.ok(start > 0, 'SEALED list is present');
  const end = source.indexOf('];', start);
  const block = source.slice(start, end);
  return [...block.matchAll(/id:"([^"]+)"/g)].map((m) => m[1]);
}

function webpSize(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WEBP');
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  assert.fail('unknown WebP chunk ' + chunk);
}

function published() {
  return JSON.parse(fs.readFileSync(feedPath, 'utf8'));
}

const block = extractBlock();

function appFunction(name) {
  const m = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(m, 'App function exists: ' + name);
  for (let e = source.indexOf('}', m.index); e >= 0; e = source.indexOf('}', e + 1)) {
    const d = source.slice(m.index, e + 1);
    try { new vm.Script('(' + d + ')'); return d; } catch (_) { /* keep looking */ }
  }
  throw new Error('Could not extract ' + name);
}

function loadApp(opts) {
  opts = opts || {};
  const store = opts.store || {};
  const sandbox = {
    SEALED: JSON.parse(JSON.stringify(opts.sealed || [])),
    window: { CARD_IMG: Object.assign({}, opts.cardImg || {}) },
    lsGet: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    lsSet: function(k, v) { store[k] = String(v); },
    fetch: opts.fetch || function() { return Promise.reject(new Error('offline')); },
    _curPage: opts.page || 'home',
    renderSealed: function() { sandbox.painted.push('sealed'); },
    renderReleases: function() { sandbox.painted.push('releases'); },
    Date: Date
  };
  sandbox.painted = [];
  sandbox.store = store;
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  return sandbox;
}

function flush() {
  return Promise.resolve().then(function() { return Promise.resolve(); }).then(function() { return Promise.resolve(); }).then(function() { return Promise.resolve(); });
}

function baseSealed() {
  return [
    { id: 'box-bp02', box: '', banner: 'BOX_BANNER_BP02' },
    { id: 'box-bp03', box: '', banner: '' },
    { id: 'box-ebp01', box: 'BOX_EBP01', banner: 'BOX_BANNER_EBP01' },
    { id: 'box-ebp01-2e', box: '', banner: 'BOX_BANNER_EBP01' },
    { id: 'pack-bp02', box: '' },
    { id: 'pack-bp03', box: '' },
    { id: 'ss-vol1', box: 'BOX_SS01', banner: 'BOX_BANNER_SS01' },
    { id: 'td-ea-bp', box: '' },
    { id: 'td-ea-rg', box: '', banner: 'BOX_BANNER_TD03' }
  ];
}

function baseImg() {
  return {
    BOX_EBP01: 'img/BOX_EBP01.webp',
    BOX_SS01: 'img/BOX_SS01.webp',
    BOX_BANNER_BP02: 'img/BOX_BANNER_BP02.webp',
    BOX_BANNER_EBP01: 'img/BOX_BANNER_EBP01.jpg',
    BOX_BANNER_SS01: 'img/BOX_BANNER_SS01.webp',
    BOX_BANNER_TD03: 'img/BOX_BANNER_TD03.webp'
  };
}

test('the published file matches the schema, and every image is a sized WebP', function() {
  const feed = published();
  assert.deepEqual(Object.keys(feed).sort(), ['products', 'updated_at']);
  assert.match(feed.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(Number.isNaN(Date.parse(feed.updated_at)), false);
  assert.ok(Array.isArray(feed.products));
  assert.ok(feed.products.length > 0);
  const ids = feed.products.map(function(row) { return row.id; });
  assert.deepEqual(ids, ids.slice().sort(), 'products are sorted by id');
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  const known = new Set(sealedIds());
  const referenced = new Set();
  feed.products.forEach(function(row) {
    assert.deepEqual(Object.keys(row).filter(function(k) { return FIELDS.indexOf(k) === -1; }), []);
    assert.match(row.id, ID_RE);
    assert.equal(known.has(row.id), true, 'unknown product ' + row.id);
    assert.ok(row.edition === 'en' || row.edition === 'jp');
    assert.equal(row.official, true);
    assert.match(row.source_url, /^https:\/\/\S+$/);
    assert.ok(row.box || row.banner, row.id + ' needs a box or a banner');
    if (Object.prototype.hasOwnProperty.call(row, 'replace')) assert.equal(typeof row.replace, 'boolean');
    ['box', 'banner'].forEach(function(field) {
      if (!row[field]) return;
      assert.match(row[field], URL_RE);
      assert.equal(row[field].indexOf(IMG_PREFIX), 0);
      const file = row[field].slice(IMG_PREFIX.length);
      const full = path.join(imgDir, file);
      assert.equal(fs.existsSync(full), true, file);
      referenced.add(file);
      const buf = fs.readFileSync(full);
      assert.ok(buf.length > 0 && buf.length <= MAX_BYTES, file + ' is ' + buf.length + ' bytes');
      const size = webpSize(buf);
      assert.ok(size.w >= 1 && size.h >= 1);
      if (file.indexOf('BOX_BANNER_') === 0) {
        assert.ok(size.w <= BANNER_MAX_W && size.h <= BANNER_MAX_H, file + ' ' + size.w + 'x' + size.h);
      } else {
        assert.ok(size.w <= PACKSHOT_MAX && size.h <= PACKSHOT_MAX, file + ' ' + size.w + 'x' + size.h);
      }
    });
  });
  const onDisk = fs.readdirSync(imgDir).filter(function(name) { return name.endsWith('.webp'); });
  assert.deepEqual(onDisk.slice().sort(), [...referenced].sort(), 'every WebP in docs/sealed/img is referenced');
});

test('the schema readme names every field, the limits, and the live URL', function() {
  const readme = fs.readFileSync(readmePath, 'utf8');
  [
    'updated_at', 'products', 'id', 'edition', 'box', 'banner', 'source_url', 'official', 'replace',
    'https://spheredex.app/sealed/images.json',
    'docs/sealed/images.json',
    'https://spheredex.app/sealed/img/',
    '700', '840', '1050', '512'
  ].forEach(function(field) {
    assert.ok(readme.includes(field), 'README mentions ' + field);
  });
});

test('the bundled fallback only names images the published file still serves', function() {
  const ctx = loadApp();
  const fallback = ctx.SEALED_IMAGES_FALLBACK;
  const live = published();
  assert.equal(ctx.SEALED_IMAGES_URL, 'https://spheredex.app/sealed/images.json');
  assert.ok(fallback && Array.isArray(fallback.products) && fallback.products.length > 0);
  const urls = new Set();
  live.products.forEach(function(row) {
    if (row.box) urls.add(row.box);
    if (row.banner) urls.add(row.banner);
  });
  fallback.products.forEach(function(row) {
    if (row.box) assert.equal(urls.has(row.box), true, row.box);
    if (row.banner) assert.equal(urls.has(row.banner), true, row.banner);
  });
  const call = source.indexOf('fetchSealedImages();');
  const stored = source.indexOf('applyReleases(storedReleases());');
  assert.ok(stored > 0 && call > stored, 'cached releases apply before the image feed fills the gaps');
});

test('empty tiles gain feed art, and an existing picture stays unless replace is set', function() {
  const ctx = loadApp({ sealed: baseSealed(), cardImg: baseImg() });
  ctx.fetchSealedImages();
  const row = function(id) { return ctx.SEALED.filter(function(p) { return p.id === id; })[0]; };
  assert.equal(row('box-bp02').box, 'BOX_EBP02');
  assert.equal(ctx.window.CARD_IMG.BOX_EBP02, IMG_PREFIX + 'BOX_EBP02.webp');
  assert.equal(row('box-bp02').banner, 'BOX_BANNER_BP02');
  assert.equal(ctx.window.CARD_IMG.BOX_BANNER_BP02, 'img/BOX_BANNER_BP02.webp');
  assert.equal(row('pack-bp02').box, 'PACK_EBP02');
  assert.equal(row('box-ebp01-2e').box, 'BOX_BANNER_EBP01_2E');
  assert.equal(row('box-ebp01-2e').banner, 'BOX_BANNER_EBP01');
  // replace:true over a bundled picture waits for the new one to load; this sandbox cannot load any.
  assert.equal(ctx.window.CARD_IMG.BOX_SS01, 'img/BOX_SS01.webp');
  assert.equal(row('ss-vol1').box, 'BOX_SS01');
  assert.equal(row('ss-vol1').banner, 'BOX_BANNER_SS01');
  assert.equal(ctx.window.CARD_IMG.BOX_BANNER_SS01, 'img/BOX_BANNER_SS01.webp');
  assert.equal(row('td-ea-bp').banner, 'BOX_BANNER_TD04');
  assert.equal(row('box-bp03').banner, 'BOX_BANNER_BP03');
  assert.equal(row('pack-bp03').banner, 'BOX_BANNER_BP03');
  assert.equal(row('td-ea-rg').banner, 'BOX_BANNER_TD03');
  assert.equal(ctx.window.CARD_IMG.BOX_BANNER_TD03, 'img/BOX_BANNER_TD03.webp');
  assert.equal(row('box-ebp01').box, 'BOX_EBP01');
  assert.equal(ctx.window.CARD_IMG.BOX_EBP01, 'img/BOX_EBP01.webp');
  assert.equal(ctx.painted.length, 0);
});

test('a URL outside the sealed image folder is ignored, including when replace is set', function() {
  const ctx = loadApp({ sealed: baseSealed(), cardImg: baseImg() });
  const changed = ctx.applySealedImages({ products: [
    { id: 'box-ebp01', replace: true, box: 'https://evil.example/sealed/img/BOX_EBP01.webp' },
    { id: 'box-ebp01', replace: true, box: 'http://spheredex.app/sealed/img/BOX_EBP01.webp' },
    { id: 'box-ebp01', replace: true, box: 'https://spheredex.app.evil/sealed/img/BOX_EBP01.webp' },
    { id: 'box-ebp01', replace: true, box: 'https://spheredex.app/sealed/images.json' },
    { id: 'box-ebp01', replace: true, box: 'https://spheredex.app/sealed/img/../app/img/BOX.webp' },
    { id: 'pr-pack-v1-5', box: IMG_PREFIX + 'PACK_EBP02.webp' },
    { id: 'box-bp02', banner: IMG_PREFIX + 'BOX_BANNER_BP03.webp' }
  ]});
  const box = ctx.SEALED.filter(function(p) { return p.id === 'box-ebp01'; })[0];
  assert.equal(box.box, 'BOX_EBP01');
  assert.equal(ctx.window.CARD_IMG.BOX_EBP01, 'img/BOX_EBP01.webp');
  assert.equal(ctx.SEALED.some(function(p) { return p.id === 'pr-pack-v1-5'; }), false);
  const legends = ctx.SEALED.filter(function(p) { return p.id === 'box-bp02'; })[0];
  assert.equal(legends.banner, 'BOX_BANNER_BP02');
  assert.equal(ctx.window.CARD_IMG.BOX_BANNER_BP03, IMG_PREFIX + 'BOX_BANNER_BP03.webp');
  assert.equal(changed, true);
});

test('offline load keeps the bundled copy, a live file repaints, and a bad payload does not', async function() {
  const offline = loadApp({ sealed: baseSealed(), cardImg: baseImg() });
  offline.fetchSealedImages();
  await flush();
  assert.equal(offline.SEALED.filter(function(p) { return p.id === 'pack-bp02'; })[0].box, 'PACK_EBP02');
  assert.equal(offline.store['palvault-sealed-images'], undefined);

  const live = published();
  live.products = live.products.concat([{
    id: 'td-ea-rg',
    edition: 'en',
    box: IMG_PREFIX + 'BOX_EBP02.webp',
    source_url: 'https://en.palworld-official-cardgame.com/products/td03',
    official: true
  }]);
  let requested = null;
  const ctx = loadApp({
    sealed: baseSealed(),
    cardImg: baseImg(),
    page: 'sealed',
    fetch: function(url, init) {
      requested = { url: url, init: init };
      return Promise.resolve({ ok: true, json: function() { return Promise.resolve(live); } });
    }
  });
  ctx._curPage = 'sealed';
  ctx.fetchSealedImages();
  await flush();
  assert.equal(requested.url, 'https://spheredex.app/sealed/images.json');
  assert.equal(requested.init.cache, 'no-store');
  assert.equal(ctx.SEALED.filter(function(p) { return p.id === 'td-ea-rg'; })[0].box, 'BOX_EBP02');
  assert.deepEqual(ctx.painted, ['sealed']);
  const saved = JSON.parse(ctx.store['palvault-sealed-images']);
  assert.equal(saved.feed.products.length, live.products.length);

  const again = loadApp({
    sealed: baseSealed(),
    cardImg: baseImg(),
    store: ctx.store,
    page: 'releases',
    fetch: function() { return Promise.reject(new Error('offline')); }
  });
  again._curPage = 'releases';
  again.fetchSealedImages();
  await flush();
  assert.equal(again.SEALED.filter(function(p) { return p.id === 'td-ea-rg'; })[0].box, 'BOX_EBP02');
  assert.equal(again.painted.length, 0);

  const bad = loadApp({
    sealed: baseSealed(),
    cardImg: baseImg(),
    fetch: function() {
      return Promise.resolve({ ok: true, json: function() { return Promise.resolve({ products: 'nope' }); } });
    }
  });
  bad.fetchSealedImages();
  await flush();
  assert.equal(bad.store['palvault-sealed-images'], undefined);
  assert.equal(bad.SEALED.filter(function(p) { return p.id === 'pack-bp02'; })[0].box, 'PACK_EBP02');
});

// A browser Image that never loads (offline) or loads when told to.
function fakeImage(ctx) {
  ctx.images = [];
  ctx.Image = function() { ctx.images.push(this); };
}

test('offline first launch keeps the bundled sleeve picture the replace row would cover', async function() {
  // A fresh install with no internet: no saved feed, the network fails, and the replacement never loads.
  const ctx = loadApp({ sealed: baseSealed(), cardImg: baseImg(), page: 'sealed' });
  fakeImage(ctx);
  ctx.fetchSealedImages();
  await flush();
  const ss = ctx.SEALED.filter(function(p) { return p.id === 'ss-vol1'; })[0];
  assert.equal(ss.box, 'BOX_SS01');
  assert.equal(ctx.window.CARD_IMG.BOX_SS01, 'img/BOX_SS01.webp', 'the bundled file still backs the tile');
  assert.equal(ctx.images.length, 1, 'the replacement was only tried in the background');
  assert.equal(ctx.images[0].src, IMG_PREFIX + 'BOX_SS01.webp');
  if (ctx.images[0].onerror) ctx.images[0].onerror();
  assert.equal(ctx.window.CARD_IMG.BOX_SS01, 'img/BOX_SS01.webp', 'a failed load changes nothing');
  assert.deepEqual(ctx.painted, []);
  // Empty tiles still gain feed art straight away: there is no working picture to protect there.
  assert.equal(ctx.SEALED.filter(function(p) { return p.id === 'pack-bp02'; })[0].box, 'PACK_EBP02');
});

test('the replacement takes over once it has actually loaded, and the page repaints', function() {
  const ctx = loadApp({ sealed: baseSealed(), cardImg: baseImg(), page: 'sealed' });
  fakeImage(ctx);
  ctx.applySealedImages(ctx.SEALED_IMAGES_FALLBACK);
  assert.equal(ctx.window.CARD_IMG.BOX_SS01, 'img/BOX_SS01.webp');
  ctx.images[0].onload();
  assert.equal(ctx.window.CARD_IMG.BOX_SS01, IMG_PREFIX + 'BOX_SS01.webp');
  assert.deepEqual(ctx.painted, ['sealed']);
  // Once loaded, a later apply swaps at once rather than loading it again.
  const again = ctx.images.length;
  ctx.window.CARD_IMG.BOX_SS01 = 'img/BOX_SS01.webp';
  assert.equal(ctx.applySealedImages(ctx.SEALED_IMAGES_FALLBACK), true);
  assert.equal(ctx.window.CARD_IMG.BOX_SS01, IMG_PREFIX + 'BOX_SS01.webp');
  assert.equal(ctx.images.length, again);
});

test('a product /api/releases adds after the image feed landed still gets its picture', async function() {
  // A device with no saved release data: the feed names box-bp04, which SEALED does not have yet.
  const feed = { products: [{ id: 'box-bp04', box: IMG_PREFIX + 'BOX_EBP02.webp' }] };
  const ctx = loadApp({
    sealed: baseSealed(),
    cardImg: baseImg(),
    page: 'sealed',
    fetch: function(url) {
      if (url === 'https://spheredex.app/sealed/images.json') {
        return Promise.resolve({ ok: true, json: function() { return Promise.resolve(feed); } });
      }
      return Promise.resolve({ ok: true, json: function() { return Promise.resolve({ version: 2, products: [] }); } });
    }
  });
  ctx.fetchSealedImages();
  await flush();
  assert.equal(ctx.SEALED.some(function(p) { return p.id === 'box-bp04'; }), false);
  // Now the real fetchReleases, with applyReleases adding the new product.
  Object.assign(ctx, {
    apiBase: function() { return 'https://api.invalid'; },
    storedReleases: function() { return null; },
    REL_KEY: 'palvault-releases',
    applyReleases: function() { ctx.SEALED.push({ id: 'box-bp04', box: '' }); return true; },
    renderSetBrowse: function() {},
    renderHome: function() {}
  });
  vm.runInContext(appFunction('fetchReleases'), ctx);
  ctx.painted.length = 0;
  ctx.fetchReleases();
  await flush();
  await flush();
  const added = ctx.SEALED.filter(function(p) { return p.id === 'box-bp04'; })[0];
  assert.ok(added, 'the release was added');
  assert.equal(added.box, 'BOX_EBP02', 'and the kept image feed was applied to it');
  assert.equal(ctx.window.CARD_IMG.BOX_EBP02, IMG_PREFIX + 'BOX_EBP02.webp');
  assert.ok(ctx.painted.indexOf('sealed') !== -1, 'the sealed page repainted');
});

test('a stale saved copy is skipped, and a fresh one is used before the network answers', function() {
  const stale = loadApp({
    sealed: baseSealed(),
    cardImg: baseImg(),
    store: {
      'palvault-sealed-images': JSON.stringify({
        at: 0,
        feed: { products: [{ id: 'td-ea-rg', box: IMG_PREFIX + 'BOX_EBP02.webp' }] }
      })
    }
  });
  stale.fetchSealedImages();
  assert.equal(stale.SEALED.filter(function(p) { return p.id === 'td-ea-rg'; })[0].box, '');

  const fresh = loadApp({
    sealed: baseSealed(),
    cardImg: baseImg(),
    store: {
      'palvault-sealed-images': JSON.stringify({
        at: Date.now(),
        feed: { products: [{ id: 'td-ea-rg', box: IMG_PREFIX + 'PACK_EBP02.webp' }] }
      })
    },
    fetch: function() { return Promise.reject(new Error('offline')); }
  });
  fresh.fetchSealedImages();
  assert.equal(fresh.SEALED.filter(function(p) { return p.id === 'td-ea-rg'; })[0].box, 'PACK_EBP02');
});
