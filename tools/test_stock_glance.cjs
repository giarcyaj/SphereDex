'use strict';

// Run with: node tools/test_stock_glance.cjs
// The at a glance stock line on a sealed product page.
//
// Amber is the point of this feature, and it covers two different unknowns: a product no shop in that
// market lists, and a reading too old to trust because the checker stopped running. Calling either of them
// "out of stock" would be a guess presented as a fact, so both say go and look.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'paldeck.html'), 'utf8');

function appFunction(name) {
  const m = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(m, 'App function exists: ' + name);
  for (let e = source.indexOf('}', m.index); e >= 0; e = source.indexOf('}', e + 1)) {
    const d = source.slice(m.index, e + 1);
    try { new vm.Script('(' + d + ')'); return d; } catch (_) { /* keep looking */ }
  }
  throw new Error('Could not extract ' + name);
}

const HOUR = 3600000;
function sandbox(asOf, state, shops) {
  const sb = {
    STOCK: { region: 'co.uk', asOf, state, shops: shops || null, at: Date.now() },
    STOCK_STALE_MS: 2 * HOUR,
    esc: (s) => String(s),
    ebayReg: () => 'co.uk',
    // stockGlanceHtml now draws the named shops too, so its helpers come along even when a test only
    // cares about the single line.
    REGION_CUR: { 'co.uk': 'GBP' },
    moneyIn: (n) => '£' + Number(n).toFixed(2),
    Date, Math, isNaN, String, Number,
  };
  vm.createContext(sb);
  vm.runInContext(['stockGlance', 'stockSeen', 'stockShops', 'stockAgo', 'stockShopRow', 'stockGlanceHtml']
    .map(appFunction).join('\n'), sb);
  return sb;
}
const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');

test('a product in stock reads green', () => {
  const sb = sandbox(stamp(5 * 60000), { 'box-ebp01': 'in' });
  assert.equal(sb.stockGlance('box-ebp01').cls, 'in');
  assert.match(sb.stockGlanceHtml('box-ebp01'), /class="sdstock in"/);
});

test('a product out of stock reads red', () => {
  const sb = sandbox(stamp(5 * 60000), { 'pack-ebp01': 'out' });
  assert.equal(sb.stockGlance('pack-ebp01').cls, 'out');
  assert.match(sb.stockGlanceHtml('pack-ebp01'), /class="sdstock out"/);
});

test('a product no shop lists reads amber, never red', () => {
  // 5 of the 14 sealed products are not in the checker's list at all. Showing those as out of stock would
  // be a claim nothing supports.
  const sb = sandbox(stamp(5 * 60000), { 'box-ebp01': 'in' });
  const g = sb.stockGlance('demo-deck');
  assert.equal(g.cls, 'unk');
  assert.match(g.note, /do not track/);
});

test('a reading older than two hours goes amber even when it says in stock', () => {
  // The checker runs every 30 minutes, so two hours means four missed runs. A green light off that is a
  // guess, and the worse failure, because it sends someone to a shop for nothing.
  const sb = sandbox(stamp(3 * HOUR), { 'box-ebp01': 'in' });
  assert.equal(sb.stockGlance('box-ebp01').cls, 'unk');
  assert.match(sb.stockGlance('box-ebp01').text, /unconfirmed/);
});

test('a reading just inside the window is still trusted', () => {
  const sb = sandbox(stamp(1.5 * HOUR), { 'box-ebp01': 'in' });
  assert.equal(sb.stockGlance('box-ebp01').cls, 'in');
});

test('a market that has never been polled says nothing at all rather than red', () => {
  const sb = sandbox(null, null);
  assert.equal(sb.stockGlance('box-ebp01'), null, 'no data yet renders no line');
  assert.equal(sb.stockGlanceHtml('box-ebp01'), '');
});

test('an unparseable timestamp is treated as current rather than silently amber forever', () => {
  // Date.parse returning NaN must not quietly disable the feature; the readings are still real.
  const sb = sandbox('not a date', { 'box-ebp01': 'in' });
  assert.equal(sb.stockGlance('box-ebp01').cls, 'in');
});

test('the colour is never the only signal', () => {
  // Red and green alone would fail the people most likely to need this line.
  const sb = sandbox(stamp(60000), { 'box-ebp01': 'in', 'pack-ebp01': 'out' });
  assert.match(sb.stockGlanceHtml('box-ebp01'), /In stock/);
  assert.match(sb.stockGlanceHtml('pack-ebp01'), /Out of stock/);
});

// ---- preorder wording --------------------------------------------------------------------------------
// A product that has not come out cannot be in stock. Five of the ten polled products are unreleased on
// 8 Oct 2026, two of them until 18 December, so this is the common case and not an edge one.
test('an open preorder says so, and never says in stock', () => {
  const sb = sandbox(stamp(5 * 60000), { 'box-bp02': 'in' });
  const g = sb.stockGlance('box-bp02', true);
  assert.equal(g.cls, 'in');
  assert.equal(g.text, 'Pre order open');
  assert.doesNotMatch(sb.stockGlanceHtml('box-bp02', true), /In stock/);
});

test('no shop taking preorders reads red, worded as preorders', () => {
  const sb = sandbox(stamp(5 * 60000), { 'box-ebp01-2e': 'out' });
  const g = sb.stockGlance('box-ebp01-2e', true);
  assert.equal(g.cls, 'out');
  assert.equal(g.text, 'No pre orders open');
  assert.doesNotMatch(g.text, /Out of stock/);
});

test('the same reading reads differently on a released and an unreleased product', () => {
  const sb = sandbox(stamp(60000), { 'box-ebp01': 'in', 'box-bp02': 'in' });
  assert.equal(sb.stockGlance('box-ebp01', false).text, 'In stock');
  assert.equal(sb.stockGlance('box-bp02', true).text, 'Pre order open');
});

test('a stale reading is amber for a preorder too', () => {
  const sb = sandbox(stamp(3 * HOUR), { 'box-bp02': 'in' });
  assert.equal(sb.stockGlance('box-bp02', true).cls, 'unk');
});

test('an untracked preorder product says go and look, not sold out', () => {
  const sb = sandbox(stamp(60000), { 'box-bp02': 'in' });
  const g = sb.stockGlance('box-bp03', true);
  assert.equal(g.cls, 'unk');
  assert.match(g.note, /do not track/);
});

test('no user facing string in the glance carries a dash', () => {
  // Craig's style rule, and "Pre-order" is exactly where it would slip in.
  const sb = sandbox(stamp(60000), { a: 'in', b: 'out' });
  for (const pre of [true, false]) {
    for (const id of ['a', 'b', 'missing']) {
      const g = sb.stockGlance(id, pre);
      assert.doesNotMatch(g.text + ' ' + g.note, /[-\u2010-\u2015]/, JSON.stringify(g));
    }
  }
});

// ---- late answers -------------------------------------------------------------------------------------
// The fetch lands seconds after the sheet opens. By then the person may have closed that product, opened
// another, or changed market, and the answer must not land on whatever happens to be on screen.

function liveSandbox() {
  const calls = [];
  const els = {};
  const sb = {
    STOCK: { region: '', asOf: null, state: null, shops: null, at: 0 },
    _stockReq: 0,
    STOCK_STALE_MS: 2 * HOUR,
    region: 'co.uk',
    esc: (s) => String(s),
    apiBase: () => 'https://api.invalid',
    encodeURIComponent,
    REGION_CUR: { 'co.uk': 'GBP' },
    moneyIn: (n) => '£' + Number(n).toFixed(2),
    wireStockShops: () => {},                 // no real DOM here; the expander has its own tests
    Date, Math, isNaN, String, Number,
    Promise,
    calls,
    els,
    fetch: (url) => new Promise((resolve) => { calls.push({ url, resolve }); }),
    $: (id) => els[id] || null,
  };
  sb.ebayReg = () => sb.region;
  vm.createContext(sb);
  vm.runInContext(['fetchStock', 'stockGlance', 'stockSeen', 'stockShops', 'stockAgo', 'stockShopRow',
    'stockGlanceHtml', 'stockPaint'].map(appFunction).join('\n'), sb);
  return sb;
}
function stockLine(pid) {
  const attrs = { 'data-pid': pid };
  return { innerHTML: '', getAttribute: (k) => (k in attrs ? attrs[k] : null) };
}
const answer = (state) => ({ ok: true, json: () => Promise.resolve({ asOf: stamp(60000), state }) });
const settle = () => new Promise((r) => setImmediate(r));

test('a late answer for a closed product never paints the product open now', async () => {
  const sb = liveSandbox();
  sb.els.sdStock = stockLine('box-a');
  const a = sb.fetchStock().then(() => sb.stockPaint('box-a', true));
  // A is closed and B opened before A's answer lands.
  sb.els.sdStock = stockLine('box-b');
  sb.calls[0].resolve(answer({ 'box-a': 'in', 'box-b': 'out' }));
  assert.equal(await a, false, 'A does not paint');
  assert.equal(sb.els.sdStock.innerHTML, '', 'B still shows nothing from A');
  assert.equal(sb.stockPaint('box-b', false), true);
  assert.match(sb.els.sdStock.innerHTML, /Out of stock/, 'B paints its own reading');
});

test('an answer for a market that is no longer selected is not stored', async () => {
  const sb = liveSandbox();
  const p = sb.fetchStock();
  sb.region = 'com';
  sb.calls[0].resolve(answer({ 'box-a': 'in' }));
  await p;
  assert.equal(sb.STOCK.state, null, 'the UK answer is not kept once the market is US');
});

test('an older request cannot overwrite the newer market reading', async () => {
  const sb = liveSandbox();
  const first = sb.fetchStock();                 // asked for co.uk
  sb.region = 'com';
  const second = sb.fetchStock();                // asked for com
  sb.calls[1].resolve(answer({ 'box-a': 'out' }));
  await second;
  sb.region = 'co.uk';                           // back again before the first answer lands
  sb.calls[0].resolve(answer({ 'box-a': 'in' }));
  await first;
  await settle();
  assert.equal(sb.STOCK.region, 'com', 'the overtaken request is dropped');
});

test('the glance never reads a stored reading from another market', () => {
  const sb = sandbox(stamp(60000), { 'box-ebp01': 'in' });   // stored for co.uk
  sb.ebayReg = () => 'com';
  assert.equal(sb.stockGlance('box-ebp01'), null);
  assert.equal(sb.stockGlanceHtml('box-ebp01'), '');
});

test('both sheets tag the stock line with their product and paint through the guard', () => {
  const open = source.indexOf('function openSealedDetail(');
  const body = source.slice(open, source.indexOf('// ---- Portfolio value-over-time chart', open));
  assert.equal((body.match(/id="sdStock" data-pid="'\+esc\(p\.id\)\+'"/g) || []).length, 2);
  assert.equal((body.match(/fetchStock\(\)\.then\(function\(\)\{ stockPaint\(p\.id, (stockPre\(p\)|false)\); \}\)/g) || []).length, 2);
  assert.doesNotMatch(body, /\$\("sdStock"\); if\(el\) el\.innerHTML/);
});

// ---- the two sheets stay in step ---------------------------------------------------------------------
test('the preorder sheet shows the line, and asks for preorder wording', () => {
  // The preorder branch of openSealedDetail returns early, so it needs its own copy of the line. It had
  // none: that is why a preorder showed no stock state at all.
  const open = source.indexOf('function openSealedDetail(');
  const pre = source.slice(open, source.indexOf('var s=sealItem(p.id)', open));
  // Not a literal true: the backend decides pre order or in stock from the ship date when it sends a
  // push, so the page has to decide it the same way or the two split on release day.
  assert.match(pre, /stockGlanceHtml\(p\.id,\s*stockPre\(p\)\)/, 'preorder sheet asks the date, not a baked in flag');
  assert.match(pre, /fetchStock\(\)\.then/, 'preorder sheet also fills the line in when the fetch lands');
  assert.match(pre, /notified when you can pre order this/, 'the bell toast matches what it will send');
});

test('the released sheet passes preorder false explicitly', () => {
  const rel = source.slice(source.indexOf('var s=sealItem(p.id)', source.indexOf('function openSealedDetail(')));
  assert.match(rel, /stockGlanceHtml\(p\.id,\s*false\)/);
});

test('the 2nd Edition box is polled and its id matches the backend', () => {
  const m = /var STOCK_ALL_IDS=\[([^\]]+)\]/.exec(source);
  assert.ok(m, 'STOCK_ALL_IDS exists');
  const ids = m[1].split(',').map((s) => s.trim().replace(/"/g, ''));
  assert.ok(ids.includes('box-ebp01-2e'), 'the 2nd Edition box is in the polled list');
  assert.equal(ids.length, 10);
  // Every polled id must be a real sealed product, or the bell appears for nothing.
  for (const id of ids) assert.ok(source.includes('id:"' + id + '"'), 'sealed product exists: ' + id);
});

// ---- the named shops ---------------------------------------------------------------------------------
// The sheet now says WHICH shops have it. Everything below is drawn from data the server sends, so these
// guard both the wording and the one thing that would be dangerous to get wrong: an untrusted url.
function shopSandbox(asOf, state, shops, region) {
  const sb = {
    STOCK: { region: region || 'co.uk', asOf, state, shops, at: Date.now() },
    STOCK_STALE_MS: 2 * HOUR,
    ebayReg: () => 'co.uk',
    REGION_CUR: { 'co.uk': 'GBP', com: 'USD' },
    moneyIn: (n, code) => (code === 'GBP' ? '\u00a3' : '$') + Number(n).toFixed(2),
    esc: (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    Date, Math, isNaN, String, Number,
  };
  vm.createContext(sb);
  vm.runInContext(['stockGlance', 'stockSeen', 'stockShops', 'stockAgo', 'stockShopRow', 'stockGlanceHtml']
    .map(appFunction).join('\n'), sb);
  return sb;
}
const SHOPS = {
  'box-ebp01': [
    { shop: 'Collectors Edge', status: 'in', url: 'https://collectorsedge.co.uk/products/box', price: '94.95' },
    { shop: 'Total Cards', status: 'in', url: 'https://totalcards.net/products/box', price: '109.95' },
    { shop: 'Binderly', status: 'check', url: 'https://binderly.co.uk/products/box', price: '' },
    { shop: 'Eterna Cards', status: 'out', url: 'https://eternacards.com/products/box', price: '114.95' },
  ],
};

test('the headline counts the shops once they are known', () => {
  const sb = shopSandbox(stamp(60000), { 'box-ebp01': 'in' }, SHOPS);
  const html = sb.stockGlanceHtml('box-ebp01', false);
  assert.match(html, /In stock/);
  assert.match(html, /at 2 of 4 shops/, 'says how many of how many');
});

test('only the shops that have it are listed, the rest are hidden until asked for', () => {
  const sb = shopSandbox(stamp(60000), { 'box-ebp01': 'in' }, SHOPS);
  const html = sb.stockGlanceHtml('box-ebp01', false);
  const open = html.slice(0, html.indexOf('sdrest'));
  assert.match(open, /Collectors Edge/, 'an in stock shop is visible');
  assert.match(open, /Total Cards/);
  assert.doesNotMatch(open, /Eterna Cards/, 'an out of stock shop is not visible up front');
  assert.match(html, /<ul class="sdshops sdrest" hidden>/, 'the rest are rendered but hidden');
  assert.match(html, /Show the <b>other 2 shops<\/b>/);
});

test('each status gets its own colour class and a word for people who cannot use colour', () => {
  const sb = shopSandbox(stamp(60000), { 'box-ebp01': 'in' }, SHOPS);
  const html = sb.stockGlanceHtml('box-ebp01', false);
  assert.match(html, /<li class="in" title="Has it">/);
  assert.match(html, /<li class="chk" title="Go and look">/);
  assert.match(html, /<li class="out" title="Does not have it">/);
});

test('prices read in the shop market currency, and a missing one shows nothing', () => {
  const sb = shopSandbox(stamp(60000), { 'box-ebp01': 'in' }, SHOPS);
  const html = sb.stockGlanceHtml('box-ebp01', false);
  assert.match(html, /\u00a394\.95/, 'a UK shop reads in pounds');
  assert.match(html, /go and look/, 'a shop we could not read says so instead of a price');
});

test('a hostile url can never become a link', () => {
  // The rows come from the server. If a shop name or url were ever poisoned, this sheet sits in a WebView
  // holding the whole collection, so only http(s) is allowed to become an anchor.
  const sb = shopSandbox(stamp(60000), { x: 'in' }, {
    x: [
      { shop: 'Bad', status: 'in', url: 'javascript:alert(1)', price: '1.00' },
      { shop: 'Also bad', status: 'in', url: 'data:text/html,<script>', price: '1.00' },
      { shop: 'Fine', status: 'in', url: 'https://ok.example/p', price: '1.00' },
    ],
  });
  const html = sb.stockGlanceHtml('x', false);
  assert.doesNotMatch(html, /javascript:/, 'no javascript url survives');
  assert.doesNotMatch(html, /href="data:/, 'no data url survives');
  assert.match(html, /href="https:\/\/ok\.example\/p"/, 'a real url still links');
  assert.equal((html.match(/<a /g) || []).length, 1, 'only the safe row became a link');
});

test('a shop name is escaped, not injected', () => {
  const sb = shopSandbox(stamp(60000), { x: 'in' }, {
    x: [{ shop: '<img src=x onerror=alert(1)>', status: 'in', url: 'https://ok.example/p', price: '1.00' }],
  });
  const html = sb.stockGlanceHtml('x', false);
  assert.doesNotMatch(html, /<img/, 'the tag never reaches the page as markup');
  assert.match(html, /&lt;img/, 'it is shown as text instead');
});

test('no shop data at all still draws the old single line', () => {
  const sb = shopSandbox(stamp(60000), { 'box-ebp01': 'in' }, null);
  const html = sb.stockGlanceHtml('box-ebp01', false);
  assert.match(html, /at a shop in your market/, 'falls back to the wording that shipped in 2.4');
  assert.doesNotMatch(html, /sdshops/, 'and draws no list');
});

test('a reading for another market is ignored', () => {
  const sb = shopSandbox(stamp(60000), { 'box-ebp01': 'in' }, SHOPS, 'com');
  assert.equal(sb.stockShops('box-ebp01').length, 0);
});

test('last checked is coarse, because the checker only runs every half hour', () => {
  const sb = shopSandbox(stamp(60000), {}, null);
  assert.equal(sb.stockAgo(stamp(30 * 1000)), 'just now');
  assert.equal(sb.stockAgo(stamp(60 * 1000)), '1 minute ago');
  assert.equal(sb.stockAgo(stamp(12 * 60 * 1000)), '12 minutes ago');
  assert.equal(sb.stockAgo(stamp(60 * 60 * 1000)), '1 hour ago');
  assert.equal(sb.stockAgo(stamp(4 * 60 * 60 * 1000)), '4 hours ago');
  assert.equal(sb.stockAgo(null), '', 'no timestamp says nothing rather than guessing');
  assert.equal(sb.stockAgo('not a date'), '');
});

test('a stale reading keeps the amber line and does not claim a shop count', () => {
  const sb = shopSandbox(stamp(3 * HOUR), { 'box-ebp01': 'in' }, SHOPS);
  const html = sb.stockGlanceHtml('box-ebp01', false);
  assert.match(html, /Stock unconfirmed/);
  assert.doesNotMatch(html, /at 2 of 4/, 'an old reading does not get to count shops');
});

test('a stale reading does not let any shop still claim to have it', () => {
  // "Stock unconfirmed" above a list of shops marked green would contradict itself. Every row drops to
  // go and look, and no price is shown, because neither is known any more.
  const sb = shopSandbox(stamp(3 * HOUR), { 'box-ebp01': 'in' }, SHOPS);
  const html = sb.stockGlanceHtml('box-ebp01', false);
  assert.doesNotMatch(html, /<li class="in"/, 'no row still says it has it');
  assert.doesNotMatch(html, /<li class="out"/, 'and none claims the opposite either');
  assert.equal((html.match(/<li class="chk"/g) || []).length, 4, 'all four read as go and look');
  assert.doesNotMatch(html, /£94\.95/, 'a price nobody can vouch for is dropped');
  assert.match(html, /Collectors Edge/, 'the shop names stay, which is the useful part');
});

test('out of stock counts the shops in words that read properly', () => {
  const sb = shopSandbox(stamp(60000), { 'pack-ebp01': 'out' }, {
    'pack-ebp01': [
      { shop: 'Collectors Edge', status: 'out', url: 'https://a.example/p', price: '4.25' },
      { shop: 'Total Cards', status: 'out', url: 'https://b.example/p', price: '4.50' },
    ],
  });
  assert.match(sb.stockGlanceHtml('pack-ebp01', false), /at all 2 shops we check/);

  const one = shopSandbox(stamp(60000), { x: 'out' }, {
    x: [{ shop: 'Only Shop', status: 'out', url: 'https://a.example/p', price: '1.00' }],
  });
  assert.match(one.stockGlanceHtml('x', false), /at the 1 shop we check/, 'singular reads properly too');
});

test('the folded away list is actually folded away', () => {
  // On an old WebView [hidden] is not !important, so .sdshops display:grid outranks it and the
  // "other N shops" would sit open on the page with the button doing nothing visible.
  assert.match(source, /\.sdshops\[hidden\]\{[^}]*display:none/);
});

// ---- agreeing with the push ----------------------------------------------------------------------
// Everything below guards the places where the sealed page and the stock alert push could tell a
// watcher two different things. Each one failed before it was fixed.

function seenSandbox(seen, asOf, state, shops) {
  const sb = {
    STOCK: { region: 'co.uk', asOf, seen, state, shops, at: Date.now() },
    STOCK_STALE_MS: 2 * HOUR,
    ebayReg: () => 'co.uk',
    REGION_CUR: { 'co.uk': 'GBP' },
    moneyIn: (n) => '£' + Number(n).toFixed(2),
    esc: (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    Date, Math, isNaN, String, Number,
  };
  vm.createContext(sb);
  vm.runInContext(['stockGlance', 'stockSeen', 'stockShops', 'stockAgo', 'stockShopRow', 'stockGlanceHtml']
    .map(appFunction).join('\n'), sb);
  return sb;
}

test('freshness is judged per product, not across the whole market', () => {
  // The market clock keeps moving because other products are still being read. A product no shop lists
  // any more is never re read, so judging it by the market clock made a frozen reading look current.
  const sb = seenSandbox({ a: stamp(5 * HOUR), b: stamp(60000) }, stamp(60000), { a: 'in', b: 'in' }, null);
  assert.match(sb.stockGlanceHtml('a', false), /Stock unconfirmed/, 'the frozen product owns up');
  assert.match(sb.stockGlanceHtml('b', false), /In stock/, 'the one still being read is unaffected');
});

test('a backend with no per product times still works', () => {
  const sb = seenSandbox(null, stamp(60000), { a: 'in' }, null);
  assert.match(sb.stockGlanceHtml('a', false), /In stock/);
});

test('in stock is withdrawn when not one shop confirms it', () => {
  // The headline is only rewritten while some shop still lists the product; the rows are rebuilt every
  // run. So the rows are the fresher half and they win. Before this it read "In stock at all 2 shops we
  // check", which is out of stock wording glued under a green headline.
  const shops = { a: [
    { shop: 'Collectors Edge', status: 'check', url: 'https://ce.example/p', price: '' },
    { shop: 'Total Cards', status: 'out', url: 'https://tc.example/p', price: '9.99' },
  ] };
  const html = seenSandbox({ a: stamp(60000) }, stamp(60000), { a: 'in' }, shops).stockGlanceHtml('a', false);
  assert.match(html, /Stock unconfirmed/, 'the headline steps back');
  assert.match(html, /no shop confirmed it this check/);
  assert.doesNotMatch(html, /In stock/, 'and never claims in stock over an unconfirmed list');
  assert.doesNotMatch(html, /at all 2 shops we check/, 'the out of stock wording is gone too');
});

test('in stock stands when a shop does confirm it', () => {
  const shops = { a: [
    { shop: 'Collectors Edge', status: 'in', url: 'https://ce.example/p', price: '94.95' },
    { shop: 'Total Cards', status: 'out', url: 'https://tc.example/p', price: '109.95' },
  ] };
  const html = seenSandbox({ a: stamp(60000) }, stamp(60000), { a: 'in' }, shops).stockGlanceHtml('a', false);
  assert.match(html, /In stock/);
  assert.match(html, /at 1 of 2 shops/);
});

test('a product this market does not carry says nothing about when it was checked', () => {
  // "Last checked 5 minutes ago" under "we do not track this one" reads as though we looked and found
  // none. We never look for it here at all.
  const html = seenSandbox({ a: stamp(60000) }, stamp(60000), { a: 'in' }, null).stockGlanceHtml('zz', false);
  assert.match(html, /we do not track this one/);
  assert.doesNotMatch(html, /Last checked/);
});

test('a stale reading still says when it was last read', () => {
  const html = seenSandbox({ a: stamp(5 * HOUR) }, stamp(5 * HOUR), { a: 'in' }, null).stockGlanceHtml('a', false);
  assert.match(html, /Stock unconfirmed/);
  assert.match(html, /Last checked 5 hours ago/, 'the age shown is this product, not the market');
});

test('the pre order wording follows the release date, so it agrees with the push', () => {
  // The backend works out pre order versus in stock from the ship date at the moment it sends. p.pre is
  // baked into the app build, so on release day the push said "available now" and the page said
  // "Pre order open" until the next app update.
  const sb = { _MONIX: { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 },
    RELEASE_OVERRIDES: {}, Date, isNaN };
  vm.createContext(sb);
  vm.runInContext(['sealDate', 'sealShipped', 'stockPre'].map(appFunction).join('\n'), sb);

  assert.equal(sb.stockPre({ pre: true, date: 'Jan 29, 2027' }), true, 'a future date is still a pre order');
  assert.equal(sb.stockPre({ pre: true, date: 'Oct 16, 2024' }), false, 'a date that has passed is not');
  assert.equal(sb.stockPre({ pre: true, date: 'late Oct 2026' }), true, 'no day means no opinion, the flag stands');
  assert.equal(sb.stockPre({ pre: true }), true, 'no date at all, the flag stands');
  assert.equal(sb.stockPre({ pre: false, date: 'Jan 29, 2027' }), false, 'a released product never reads as a pre order');

  // sealDate is news aware, so a date the news pipeline corrects counts here too.
  sb.RELEASE_OVERRIDES = { x: 'Oct 16, 2024' };
  assert.equal(sb.stockPre({ id: 'x', pre: true, date: 'Jan 29, 2027' }), false, 'a corrected date wins');
});

// ---- a product stops being a pre order when it comes out ------------------------------------------
// "Pre order" is a fact about the date, not a boolean typed into the build months earlier. It used to
// be the boolean, which is why the backend (which reads the ship date when it sends) and the page
// would have disagreed from 16 Oct 2026, the day ss-vol1 ships.
function releaseSandbox(sealed, overrides) {
  const sb = {
    SEALED: sealed,
    RELEASE_OVERRIDES: overrides || {},
    _MONIX: { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 },
    Date, isNaN,
  };
  vm.createContext(sb);
  vm.runInContext(['sealDate', 'sealShipped', 'sealPreRaw', 'applyReleased', 'stockPre']
    .map(appFunction).join('\n'), sb);
  return sb;
}

test('a date that has passed turns a pre order into a released product', () => {
  const sealed = [{ id: 'old', pre: true, date: 'Oct 16, 2024' }, { id: 'soon', pre: true, date: 'Jan 29, 2027' }];
  const sb = releaseSandbox(sealed);
  assert.equal(sb.applyReleased(), true, 'it reports that something moved');
  assert.equal(sealed[0].pre, false, 'the one that has come out is no longer a pre order');
  assert.equal(sealed[1].pre, true, 'the one still to come is untouched');
});

test('a date with no day leaves the declared flag alone', () => {
  // "late Oct 2026" is not a date we can act on, so guessing from it would be worse than waiting.
  const sealed = [{ id: 'vague', pre: true, date: 'late Oct 2026' }];
  releaseSandbox(sealed).applyReleased();
  assert.equal(sealed[0].pre, true);
});

test('a released product that gets delayed becomes a pre order again', () => {
  // The news pipeline can move a date. Without remembering what the product was declared as, a product
  // we auto released could never go back, and its Preorder badge would be gone for good.
  const sealed = [{ id: 'x', pre: true, date: 'Oct 16, 2024' }];
  const sb = releaseSandbox(sealed);
  sb.applyReleased();
  assert.equal(sealed[0].pre, false);
  assert.equal(sealed[0].preRaw, true, 'what it was declared as is remembered');
  sb.RELEASE_OVERRIDES.x = 'Jan 29, 2027';          // a delay lands from the news
  assert.equal(sb.applyReleased(), true);
  assert.equal(sealed[0].pre, true, 'and it is a pre order once more');
});

test('a product that was never a pre order is never made one', () => {
  const sealed = [{ id: 'r', pre: false, date: 'Jan 29, 2027' }];
  releaseSandbox(sealed).applyReleased();
  assert.equal(sealed[0].pre, false);
});

test('running it twice changes nothing the second time', () => {
  const sealed = [{ id: 'old', pre: true, date: 'Oct 16, 2024' }];
  const sb = releaseSandbox(sealed);
  assert.equal(sb.applyReleased(), true);
  assert.equal(sb.applyReleased(), false, 'idempotent, so calling it on every render is free');
});

test('the structural guards read what the product was declared as', () => {
  // Which products keep chasing a news date, and whose overrides are remembered, must follow the
  // DECLARED flag. On the derived one, a product we auto released would drop out of both and a delay
  // announced afterwards could never reach it.
  const body = source.slice(source.indexOf('function loadReleaseOverrides('),
    source.indexOf('function sealMap('));
  assert.doesNotMatch(body, /if\(!p\.pre\)\s*return;/, 'no guard still reads the derived flag');
  assert.equal((body.match(/sealPreRaw\(p\)/g) || []).length >= 3, true, 'they read the declared one');
});

test('a sealed product carries a date we can act on, or says so plainly', () => {
  // applyReleased is only as good as the dates. Every tracked pre order should parse, or be openly
  // vague rather than quietly unparseable.
  const sb = releaseSandbox([]);
  const m = /var STOCK_ALL_IDS=\[([^\]]+)\]/.exec(source);
  const ids = m[1].split(',').map((s) => s.trim().replace(/"/g, ''));
  let checked = 0;
  for (const id of ids) {
    const row = new RegExp('\\{ id:"' + id.replace(/[-]/g, '\\-') + '",[^\\n]*').exec(source);
    if (!row) continue;
    const d = /date:"([^"]*)"/.exec(row[0]);
    if (!d || !d[1]) continue;
    checked++;
    const parses = /^\s*([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})/i.test(d[1]);
    const vague = !/\d{1,2}/.test(d[1].replace(/20\d{2}/, ''));
    assert.ok(parses || vague, id + ' has a date we can neither read nor call vague: ' + d[1]);
  }
  assert.ok(checked >= 8, 'the dates were actually inspected, not skipped (' + checked + ')');
});

test('the stock reading is not cached long enough to outlive a push', () => {
  // Ten minutes meant tapping a restock notification could show the answer from before the restock.
  assert.match(source, /Date\.now\(\)-STOCK\.at\)<120000/);
});

// ---- telling the server which market and which products -------------------------------------------
// The server filters stock alerts on this device's market and its own follow list, and it only knows
// what the phone last managed to tell it. Every one of these sends used to be fire and forget, so a
// change made with no signal left the server alerting on the market the user had just left, until the
// next cold start. These guard the three ways back.
const KOTLIN = fs.readFileSync(path.join(root, 'app', 'src', 'main', 'java', 'app', 'spheredex', 'Push.kt'), 'utf8');
const ACTIVITY = fs.readFileSync(path.join(root, 'app', 'src', 'main', 'java', 'app', 'spheredex', 'MainActivity.kt'), 'utf8');
const SWIFT = fs.readFileSync(path.join(root, 'ios', 'SphereDex', 'SphereDex', 'WebViewController.swift'), 'utf8');

test('coming back to the app re-sends what this device wants notified', () => {
  // onWake is the only path that reaches a user who uses stock alerts and nothing else: the periodic
  // sync in save() is gated on the categories whose payload tracks the collection.
  const wake = source.slice(source.indexOf('function onWake('), source.indexOf('document.addEventListener("visibilitychange"'));
  assert.match(wake, /syncPushPrefs\(\)/, 'a wake re-sends the prefs');
  assert.match(wake, /typeof syncPushPrefs==="function"/, 'guarded, because onWake runs before everything exists');
});

test('the prefs sent to the server always carry this device market', () => {
  // Without the market the server cannot tell a UK watcher from a US one.
  const fn = appFunction('syncPushPrefs');
  assert.match(fn, /region:ebayReg\(\)/, 'the market is stamped on every send');
});

test('Android checks that the registration was accepted, and retries', () => {
  assert.match(KOTLIN, /responseCode/, 'the status is read, so a rejection is not mistaken for success');
  assert.match(KOTLIN, /code in 200\.\.299/, 'and only a 2xx counts');
  assert.match(KOTLIN, /for \(attempt in 0 until 3\)/, 'a failure is retried rather than lost');
  assert.doesNotMatch(KOTLIN, /return@Thread/, 'no lambda label on a SAM constructor, which may not compile');
});

test('Android re-registers when the app comes back to the foreground', () => {
  assert.match(ACTIVITY, /override fun onResume\(\)/, 'there is a resume path at all');
  assert.match(ACTIVITY, /Push\.refreshOnResume\(this\)/);
  assert.match(KOTLIN, /fun refreshOnResume\(/);
  assert.match(KOTLIN, /lastResumeRegister/, 'and it is throttled, not fired on every resume');
});

test('iOS remembers its token so a change made before APNs answers is not lost', () => {
  // lastToken used to be in memory only, so a prefs change in a launch where APNs had not yet handed
  // over a token was silently dropped and the server kept the old market.
  assert.match(SWIFT, /tokenKey/, 'the token is keyed into UserDefaults');
  assert.match(SWIFT, /UserDefaults\.standard\.string\(forKey: tokenKey\)/);
  assert.doesNotMatch(SWIFT, /private static var lastToken: String\?$/m, 'not the in memory only version');
});

test('iOS reads the reply and retries', () => {
  assert.match(SWIFT, /dataTask\(with: req\) \{ _, response, error in/, 'there is a completion handler at all');
  assert.match(SWIFT, /\(200\.\.\.299\)\.contains\(code\)/);
  assert.match(SWIFT, /attempt < 2/, 'a failure is retried rather than lost');
  assert.doesNotMatch(SWIFT, /URLSession\.shared\.dataTask\(with: req\)\.resume\(\)/, 'the fire and forget call is gone');
});
