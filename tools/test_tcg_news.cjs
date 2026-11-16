'use strict';

// Run with: node tools/test_tcg_news.cjs
// The Palworld TCG list on the News screen, plus the repo JSON that feeds it.
// Sample rows live only in this file. docs/news/palworld-tcg.json stays free of invented items.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const sourcePath = path.join(root, 'src', 'paldeck.html');
const feedPath = path.join(root, 'docs', 'news', 'palworld-tcg.json');
const readmePath = path.join(root, 'docs', 'news', 'README.md');
const source = fs.readFileSync(sourcePath, 'utf8');

function extractBlock() {
  const begin = '/* TCG NEWS BEGIN */';
  const end = '/* TCG NEWS END */';
  const starts = [];
  let at = 0;
  while ((at = source.indexOf(begin, at)) !== -1) { starts.push(at); at += begin.length; }
  const ends = [];
  at = 0;
  while ((at = source.indexOf(end, at)) !== -1) { ends.push(at); at += end.length; }
  assert.equal(starts.length, 1, 'TCG NEWS BEGIN marker once');
  assert.equal(ends.length, 1, 'TCG NEWS END marker once');
  assert.ok(starts[0] < ends[0]);
  return source.slice(starts[0] + begin.length, ends[0]);
}

const block = extractBlock();

function loadApp(opts) {
  opts = opts || {};
  const elements = {};
  const store = opts.store || {};
  function el(id) {
    if (!elements[id]) elements[id] = { id: id, innerHTML: '', textContent: '' };
    return elements[id];
  }
  const sandbox = {
    esc: function(s) {
      return String(s).replace(/[&<>"']/g, function(m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
      });
    },
    $: function(id) { return el(id); },
    lsGet: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    lsSet: function(k, v) { store[k] = String(v); },
    fetch: opts.fetch || function() { return Promise.reject(new Error('offline')); },
    // The Wishlist helpers live outside the block. These rows name no catalog card, so the plain link is all
    // newsRowHtml would draw, and there is no button to wire.
    newsCardFor: function() { return null; },
    newsRowHtml: function(href, inner) {
      return '<a class="newsitem" href="' + sandbox.esc(href) + '" target="_blank" rel="noopener">' + inner + '</a>';
    },
    wireNewsWish: function() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  sandbox.elements = elements;
  sandbox.store = store;
  return sandbox;
}

function flush() {
  return Promise.resolve().then(function() { return Promise.resolve(); }).then(function() { return Promise.resolve(); });
}

// Clearly fake. example.invalid is not a real host, and these rows are not written to the feed file.
function sampleFeed() {
  return {
    updated_at: '2026-09-27T12:00:00Z',
    items: [
      {
        id: 'example-older-reveal',
        title: 'Older reveal <example>',
        url: 'https://example.invalid/older',
        source: 'x',
        source_name: '@PalworldOCG_EN',
        published_at: '2026-09-25T10:00:00Z',
        category: 'reveal',
        summary: 'An older made-up example.',
        unconfirmed: false
      },
      {
        id: 'example-shop-price',
        title: 'Shop price example',
        url: 'https://example.invalid/price',
        source: 'news',
        source_name: 'Example Journal',
        published_at: '2026-09-26T08:00:00Z',
        category: 'pricing',
        summary: 'A made-up pricing example.',
        unconfirmed: false
      },
      {
        id: 'example-newer-leak',
        title: 'Newer rumour',
        url: 'https://example.invalid/newer',
        source: 'reddit',
        source_name: 'PalworldTCG',
        published_at: '2026-09-26T18:30:00Z',
        category: 'leak',
        summary: 'A made-up leak example.',
        unconfirmed: true
      }
    ]
  };
}

test('the published feed matches the schema', function() {
  const ctx = loadApp();
  const feed = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
  assert.equal(typeof feed.updated_at, 'string');
  assert.equal(Number.isNaN(ctx.tcgNewsIso(feed.updated_at)), false);
  assert.ok(Array.isArray(feed.items));
  const norm = ctx.tcgNewsNormalise(feed);
  assert.ok(norm);
  assert.equal(norm.items.length, feed.items.length, 'every item must match docs/news/README.md');
  const ids = new Set();
  for (let i = 0; i < feed.items.length; i++) {
    const item = feed.items[i];
    assert.equal(ids.has(item.id), false, 'duplicate id ' + item.id);
    ids.add(item.id);
    assert.equal(typeof item.unconfirmed, 'boolean');
    assert.equal(String(item.title).includes('\n'), false);
    assert.equal(String(item.summary).includes('\n'), false);
    if (i > 0) {
      assert.ok(ctx.tcgNewsIso(feed.items[i - 1].published_at) >= ctx.tcgNewsIso(item.published_at), 'newest first');
    }
  }
  assert.equal(ctx.TCG_NEWS_FALLBACK.items.length, 0);
  assert.equal(ctx.TCG_NEWS_URL, 'https://spheredex.app/news/palworld-tcg.json');
});

test('the schema readme names every field and the live URL', function() {
  const readme = fs.readFileSync(readmePath, 'utf8');
  [
    'updated_at', 'items', 'id', 'title', 'url', 'source', 'source_name',
    'published_at', 'category', 'summary', 'unconfirmed',
    'reddit', 'official', 'release', 'reveal', 'preorder', 'pricing', 'tournament', 'community', 'leak',
    'https://spheredex.app/news/palworld-tcg.json',
    'docs/news/palworld-tcg.json'
  ].forEach(function(field) {
    assert.ok(readme.includes(field), 'README mentions ' + field);
  });
});

test('the News screen has a Palworld TCG section', function() {
  assert.match(source, /id="tcgNewsList"/);
  assert.match(source, /id="tcgNewsNote"/);
  assert.match(source, /class="sech tcgnewshead">Palworld TCG</);
});

test('empty feed renders the empty state', function() {
  const ctx = loadApp();
  const html = ctx.tcgNewsListHtml(ctx.TCG_NEWS_FALLBACK);
  assert.match(html, /No Palworld TCG news yet/);
  assert.match(html, /Headlines, releases and reveals will show up here/);
  assert.equal(html.includes('newsitem'), false);
  assert.equal(ctx.tcgNewsListHtml(null).includes('newsitem'), false);
  assert.equal(ctx.tcgNewsNormalise({ updated_at: '2026-09-27T00:00:00Z', items: 'nope' }), null);
});

test('sample rows render newest first with source, date, category and Unconfirmed', function() {
  const ctx = loadApp();
  const html = ctx.tcgNewsListHtml(sampleFeed());
  const parts = html.split('<a class="newsitem"').slice(1);
  assert.equal(parts.length, 3);
  assert.match(parts[0], /Newer rumour/);
  assert.match(parts[0], /26 Sep 2026/);
  assert.match(parts[0], /class="ncat">Leak</);
  assert.match(parts[0], /class="nunconfirmed">Unconfirmed</);
  assert.match(parts[0], /Reddit · r\/PalworldTCG/);
  assert.match(parts[0], /href="https:\/\/example\.invalid\/newer"/);
  assert.match(parts[0], /target="_blank"/);
  assert.match(parts[1], /Shop price example/);
  assert.match(parts[1], /class="ncat">Pricing</);
  assert.match(parts[1], /News · Example Journal/);
  assert.equal(parts[1].includes('Unconfirmed'), false);
  assert.match(parts[2], /Older reveal &lt;example&gt;/);
  assert.match(parts[2], /25 Sep 2026/);
  assert.match(parts[2], /class="ncat">Reveal</);
  assert.match(parts[2], /X · @PalworldOCG_EN/);
  assert.equal(parts[2].includes('Unconfirmed'), false);
});

test('rows that break the schema are dropped', function() {
  const ctx = loadApp();
  const feed = sampleFeed();
  feed.items.push({
    id: 'example-bad-url',
    title: 'Skipped',
    url: 'javascript:alert(1)',
    source: 'news',
    source_name: 'Example',
    published_at: '2026-09-27T00:00:00Z',
    category: 'leak',
    summary: 'Must not render.',
    unconfirmed: true
  });
  feed.items.push(Object.assign({}, feed.items[2], { id: 'example-newer-leak', title: 'Duplicate id' }));
  const norm = ctx.tcgNewsNormalise(feed);
  assert.deepEqual(JSON.parse(JSON.stringify(norm.items.map(function(item) { return item.id; }))), [
    'example-newer-leak', 'example-shop-price', 'example-older-reveal'
  ]);
  assert.equal(norm.items[0].title, 'Newer rumour');
});

test('render shows the empty state when the network fails', async function() {
  let requested = null;
  const ctx = loadApp({
    fetch: function(url, init) {
      requested = { url: url, init: init };
      return Promise.reject(new Error('offline'));
    }
  });
  ctx.renderTcgNews();
  await flush();
  const list = ctx.elements.tcgNewsList;
  assert.match(list.innerHTML, /No Palworld TCG news yet/);
  assert.equal(list.innerHTML.includes('newsitem'), false);
  assert.equal(ctx.elements.tcgNewsNote.textContent, 'Announcements, releases, reveals and community threads.');
  assert.equal(requested.url, 'https://spheredex.app/news/palworld-tcg.json');
  assert.equal(requested.init.cache, 'no-store');
});

test('render shows sample rows from the network and keeps them for offline', async function() {
  const sample = sampleFeed();
  const ctx = loadApp({
    fetch: function() {
      return Promise.resolve({
        ok: true,
        json: function() { return Promise.resolve(sample); }
      });
    }
  });
  ctx.renderTcgNews();
  await flush();
  const list = ctx.elements.tcgNewsList;
  assert.match(list.innerHTML, /Newer rumour/);
  assert.match(list.innerHTML, /class="nunconfirmed">Unconfirmed</);
  assert.equal(list.innerHTML.indexOf('Newer rumour') < list.innerHTML.indexOf('Older reveal'), true);
  assert.equal(ctx.elements.tcgNewsNote.textContent, 'Announcements, releases, reveals and community threads.');
  const saved = JSON.parse(ctx.store['palvault-tcg-news']);
  assert.equal(saved.feed.items.length, 3);

  const offline = loadApp({
    store: ctx.store,
    fetch: function() { return Promise.reject(new Error('offline')); }
  });
  offline.renderTcgNews();
  await flush();
  assert.match(offline.elements.tcgNewsList.innerHTML, /Shop price example/);
  assert.equal(offline.elements.tcgNewsNote.textContent, 'Showing the last update saved on this device.');
});

test('a successful refresh keeps the live note after a saved copy', async function() {
  const sample = sampleFeed();
  const ctx = loadApp({
    store: { 'palvault-tcg-news': JSON.stringify({ at: Date.now(), feed: sample }) },
    fetch: function() {
      return Promise.resolve({
        ok: true,
        json: function() { return Promise.resolve(sample); }
      });
    }
  });
  ctx.renderTcgNews();
  await flush();
  assert.match(ctx.elements.tcgNewsList.innerHTML, /Newer rumour/);
  assert.equal(ctx.elements.tcgNewsNote.textContent, 'Announcements, releases, reveals and community threads.');
});
