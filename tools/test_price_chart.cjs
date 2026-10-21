'use strict';

// Run with: node tools/test_price_chart.cjs
// The card sheet's price history: the thumbnail, and the full chart it opens.
//
// What this replaced is worth recording. The thumbnail used to sit above two rows labelled "7 days" and
// "30 days", and all three measured different things: the graph drew the last 30 READINGS spaced evenly by
// count, while the rows were bounded by date. The app only holds 14 days of history, so "30 days" implied a
// month of data that does not exist, and the graph had no label at all so it read as the week named beneath
// it. The rows are gone, the thumbnail names the date its data really starts, and the full chart positions
// every reading by date.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'paldeck.html'), 'utf8');

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

const sandbox = {
  esc: (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])),
  money: (v) => '$' + Number(v).toFixed(2),
  MONTHS: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  priceMode: () => 'live',
  _sparkSeq: 0,
  // The chart names where a card's prices came from, so the sandbox needs the same lookups the app has.
  PRICESRC: { 'EBP01-002': 'ebay-active' },
  PRICESRC_SOLD: { 'EBP01-002': 'openwebninja' },
  isConverted: () => false,
  // Viewer market for a fallback row. Tests that care switch this.
  ebayReg: () => 'de',
};
vm.createContext(sandbox);
function appConstant(name) {
  const match = new RegExp('\\bvar\\s+' + name + '\\s*=[^;]+;').exec(source);
  assert.ok(match, 'App constant exists: ' + name);
  return match[0];
}
vm.runInContext(appConstant('PX_SRC_NAME'), sandbox);
vm.runInContext(appConstant('REGION_CUR'), sandbox);
vm.runInContext(
  ['isFallbackSrc', 'srcKind', 'pxFallbackSite', 'pxFallbackFx', 'fmtFull', 'pxDayNum', 'pxTickLabel',
    'pxSeriesPath', 'pxSinceLabel', 'pxSourceLine', 'trendSparkHtml', 'priceTrendHtml', 'fullPriceChartHtml']
    .map(appFunction).join('\n'),
  sandbox
);

const pts = (rows) => rows.map(([d, v]) => ({ d, v }));

// ---- the thumbnail --------------------------------------------------------------------------------------

test('the two range rows are gone, because they named windows the data did not cover', () => {
  const html = sandbox.priceTrendHtml({
    dir: 'down', change: '$0.07', rows: [{ label: '7 days', value: 'x' }],
    pts: pts([['2026-09-24', 2], ['2026-09-25', 3], ['2026-10-07', 2.5]]),
  });
  assert.ok(!/pxrow/.test(html), 'no range rows are rendered');
  assert.ok(!/7 days|30 days/.test(html), 'no window labels are rendered');
  // Even if a caller still passes rows, which priceTrend still computes, they must not reach the page.
});

test('the thumbnail names the date the history really starts', () => {
  const html = sandbox.priceTrendHtml({
    dir: 'flat', change: '', rows: [],
    pts: pts([['2026-09-24', 2], ['2026-10-07', 2]]),
  });
  assert.match(html, /Since Sep 24, 2026/);
});

test('that caption follows the data, so a launch backfill relabels it with no copy change', () => {
  assert.equal(sandbox.pxSinceLabel(pts([['2026-07-30', 1]])), 'Since Jul 30, 2026');
  assert.equal(sandbox.pxSinceLabel([]), '');
});

test('the thumbnail is a button that opens the full chart', () => {
  const html = sandbox.priceTrendHtml({
    dir: 'up', change: '$1.00', rows: [],
    pts: pts([['2026-09-24', 2], ['2026-10-07', 3]]),
  });
  assert.match(html, /id="pxOpenFull"/);
  assert.match(html, /See full history/);
  assert.match(source, /open\.onclick=function\(\)\{ openPriceChart\(c\); \}/);
});

test('with too little history to draw a line there is no button to a chart that cannot be drawn', () => {
  const html = sandbox.priceTrendHtml({ dir: 'flat', change: '', rows: [], pts: pts([['2026-10-07', 2]]) });
  assert.ok(!/pxOpenFull/.test(html));
});

// ---- the full chart -------------------------------------------------------------------------------------

test('the full chart positions readings by DATE, so a gap looks like a gap', () => {
  // This is the whole point of the rewrite. Three readings, the first two a day apart and the third three
  // weeks later: the third point must sit far to the right, not one even step along.
  const path2 = sandbox.pxSeriesPath(
    pts([['2026-09-01', 1], ['2026-09-02', 1], ['2026-09-23', 1]]),
    (d) => d, (v) => v
  );
  const xs = path2.split(/[ML]/).filter(Boolean).map((seg) => parseFloat(seg.trim().split(' ')[0]));
  assert.equal(xs.length, 3);
  const firstGap = xs[1] - xs[0];
  const secondGap = xs[2] - xs[1];
  assert.equal(firstGap, 1, 'one day apart is one unit');
  assert.equal(secondGap, 21, 'three weeks apart is twenty one units, not one step');
});

test('a day number is a real calendar day, so month ends do not collapse', () => {
  assert.equal(sandbox.pxDayNum('2026-10-01') - sandbox.pxDayNum('2026-09-30'), 1);
  assert.equal(sandbox.pxDayNum('2026-03-01') - sandbox.pxDayNum('2026-02-28'), 1);
});

test('the chart draws both series with a key naming each one', () => {
  sandbox.cardPricePoints = (id, mode) => (mode === 'live'
    ? pts([['2026-09-24', 2], ['2026-10-01', 3], ['2026-10-07', 2.5]])
    : pts([['2026-09-24', 1.5], ['2026-10-07', 1.2]]));
  const html = sandbox.fullPriceChartHtml('EBP01-002');
  assert.match(html, /Live listings/);
  assert.match(html, /Last sold/);
  assert.match(html, /Lowest/);
  assert.match(html, /Highest/);
  assert.match(html, /Readings/);
  assert.equal((html.match(/<path /g) || []).length, 2, 'one line per series');
});

test('a card with almost no history says so instead of drawing an empty box', () => {
  sandbox.cardPricePoints = () => [];
  assert.match(sandbox.fullPriceChartHtml('X'), /not enough price history/);
  sandbox.cardPricePoints = (id, mode) => (mode === 'live' ? pts([['2026-10-07', 2]]) : []);
  assert.match(sandbox.fullPriceChartHtml('X'), /not enough price history/);
});

test('a single reading in one series is marked rather than silently dropped', () => {
  sandbox.cardPricePoints = (id, mode) => (mode === 'live'
    ? pts([['2026-09-24', 2], ['2026-10-07', 3]])
    : pts([['2026-10-01', 1.5]]));
  const html = sandbox.fullPriceChartHtml('X');
  assert.match(html, /<circle /, 'the lone sold reading gets a dot');
});

test('a perfectly flat price still draws inside the box rather than along its floor', () => {
  sandbox.cardPricePoints = (id, mode) => (mode === 'live'
    ? pts([['2026-09-24', 5], ['2026-10-07', 5]]) : []);
  const html = sandbox.fullPriceChartHtml('X');
  const ys = (html.match(/[ML][\d.]+ ([\d.]+)/g) || []).map((m) => parseFloat(m.split(' ')[1]));
  assert.ok(ys.length >= 2);
  assert.ok(ys.every((y) => y > 20 && y < 240), 'the flat line sits in the middle, got ' + ys.join(','));
});

// ---- the overlay ----------------------------------------------------------------------------------------

test('dates run across the bottom, not just at the two ends', () => {
  sandbox.cardPricePoints = (id, mode) => (mode === 'live'
    ? pts([['2026-07-30', 2], ['2026-08-20', 3], ['2026-09-15', 2.4], ['2026-10-07', 2.5]]) : []);
  const html = sandbox.fullPriceChartHtml('EBP01-002');
  const labels = html.match(/<text[^>]*y="250"[^>]*>([^<]+)<\/text>/g) || [];
  assert.ok(labels.length >= 4, 'a 70 day span gets at least four date ticks, got ' + labels.length);
});

test('the number of date ticks comes down with the span, so a short history does not repeat a day', () => {
  const span = (from, to) => {
    sandbox.cardPricePoints = (id, mode) => (mode === 'live' ? pts([[from, 2], [to, 3]]) : []);
    const html = sandbox.fullPriceChartHtml('EBP01-002');
    return (html.match(/<text[^>]*y="250"/g) || []).length;
  };
  const fortnight = span('2026-09-24', '2026-10-07');
  const halfYear = span('2026-04-07', '2026-10-07');
  assert.ok(halfYear > fortnight, 'a longer span gets more ticks: ' + fortnight + ' vs ' + halfYear);
  assert.ok(fortnight >= 2, 'even a fortnight is labelled at both ends');
});

test('a long span drops the day from the tick and shows the month, so labels do not collide', () => {
  const short = sandbox.pxTickLabel(sandbox.pxDayNum('2026-10-07'), 30);
  const long = sandbox.pxTickLabel(sandbox.pxDayNum('2026-10-07'), 400);
  assert.match(short, /^Oct \d+$/);
  assert.match(long, /^Oct \d{2}$/, 'over a year it reads as month and year');
});

test('axis text uses the theme ink, so it is readable in dark and light alike', () => {
  sandbox.cardPricePoints = (id, mode) => (mode === 'live' ? pts([['2026-09-24', 2], ['2026-10-07', 3]]) : []);
  const html = sandbox.fullPriceChartHtml('EBP01-002');
  assert.ok(!/<text[^>]*fill="var\(--muted\)"/.test(html), 'no axis label is left in the muted grey');
  assert.match(html, /<text[^>]*fill="var\(--ink\)"/);
});

test('the chart names where these particular prices came from', () => {
  // The footer credits every source in general. A chart is where a figure is actually on display, which is
  // what the licences that ask for visible attribution are really about.
  // Both series come from eBay here, so it says that once rather than naming eBay twice.
  assert.equal(sandbox.pxSourceLine('EBP01-002'), 'Live listings and last sold from eBay.');
  sandbox.PRICESRC['EBP01-003'] = 'tcgplayer';
  sandbox.PRICESRC_SOLD['EBP01-003'] = 'openwebninja';
  assert.equal(sandbox.pxSourceLine('EBP01-003'),
    'Live listings from TCGplayer. Last sold from eBay.', 'two different sources are both named');
  assert.equal(sandbox.pxSourceLine('NOT-A-CARD'), '', 'a card with no known source claims nothing');
  sandbox.cardPricePoints = (id, mode) => (mode === 'live' ? pts([['2026-09-24', 2], ['2026-10-07', 3]]) : []);
  assert.match(sandbox.fullPriceChartHtml('EBP01-002'), /class="pxsrc"/);
});

test('a converted Palworld or TCGplayer figure still says it came from US dollars', () => {
  sandbox.PRICESRC['EBP01-004'] = 'palworld';
  sandbox.PRICESRC_SOLD['EBP01-004'] = 'openwebninja';
  sandbox.isConverted = (id, mode) => mode === 'live';
  assert.equal(sandbox.pxSourceLine('EBP01-004'),
    'Live listings from Palworld Prices. Last sold from eBay. Some figures are converted from US dollars, rates by Exchange Rate API.');
  sandbox.isConverted = () => false;
});

test('a cross-market live copy names that marketplace, and credits a rate only when the currency changed', () => {
  // France and Germany are both euro, so this copy is not an exchange-rate conversion.
  sandbox.ebayReg = () => 'fr';
  sandbox.PRICESRC['EBP01-005'] = 'fallback-fx:de';
  sandbox.PRICESRC_SOLD['EBP01-005'] = 'openwebninja';
  sandbox.isConverted = (id, mode) => mode === 'live';
  const same = sandbox.pxSourceLine('EBP01-005');
  assert.equal(same, 'Last sold from eBay. Some figures are an estimate from eBay.de.');
  assert.equal(same.includes('US dollars'), false);
  assert.equal(same.includes('Exchange Rate API'), false);
  assert.equal(/[-–—]/.test(same), false, same);

  // Sterling against a euro listing did go through Exchange Rate API.
  sandbox.ebayReg = () => 'co.uk';
  const cross = sandbox.pxSourceLine('EBP01-005');
  assert.equal(cross, 'Last sold from eBay. Some figures are an estimate from eBay.de, rates by Exchange Rate API.');
  assert.equal(cross.includes('US dollars'), false);

  sandbox.ebayReg = () => 'de';
  sandbox.PRICESRC['EBP01-006'] = 'fallback-fx:com';
  sandbox.PRICESRC_SOLD['EBP01-006'] = '';
  assert.equal(sandbox.pxSourceLine('EBP01-006'),
    'Some figures are an estimate from eBay.com, rates by Exchange Rate API.');
  // Australia filled from Australia is the same dollar, so the rate provider stays off the line.
  sandbox.ebayReg = () => 'com.au';
  sandbox.PRICESRC['EBP01-007'] = 'fallback-fx:com.au';
  sandbox.PRICESRC_SOLD['EBP01-007'] = 'fallback-fx:com.au';
  assert.equal(sandbox.pxSourceLine('EBP01-007'),
    'Some figures are an estimate from eBay.com.au.');
  sandbox.ebayReg = () => 'de';
  sandbox.PRICESRC['EBP01-008'] = 'fallback-fx:co.uk';
  sandbox.PRICESRC_SOLD['EBP01-008'] = 'fallback-fx:fr';
  assert.equal(sandbox.pxSourceLine('EBP01-008'),
    'Some figures are an estimate from eBay.co.uk and eBay.fr, rates by Exchange Rate API.');
  sandbox.ebayReg = () => 'com';
  for (const [reg, host] of [['ca', 'eBay.ca'], ['it', 'eBay.it'], ['es', 'eBay.es']]) {
    sandbox.PRICESRC['EBP01-009'] = 'fallback-fx:' + reg;
    sandbox.PRICESRC_SOLD['EBP01-009'] = '';
    assert.equal(sandbox.pxSourceLine('EBP01-009'),
      'Some figures are an estimate from ' + host + ', rates by Exchange Rate API.');
  }
  sandbox.PRICESRC['EBP01-010'] = 'fallback-fx:zz';
  sandbox.PRICESRC_SOLD['EBP01-010'] = '';
  const unknown = sandbox.pxSourceLine('EBP01-010');
  assert.equal(unknown, 'Some figures are an estimate from another eBay market.');
  assert.equal(unknown.includes('US dollars'), false);
  assert.equal(unknown.includes('Exchange Rate API'), false);
  sandbox.isConverted = () => false;
  sandbox.ebayReg = () => 'de';
});

test('source kinds name a live estimate explicitly and do not call an unknown source sold', () => {
  assert.equal(sandbox.srcKind('ebay-active'), 'list');
  assert.equal(sandbox.srcKind('tcgplayer'), 'tcgplayer');
  assert.equal(sandbox.srcKind('palworld'), 'palworld');
  assert.equal(sandbox.srcKind('ebay'), 'sold');
  assert.equal(sandbox.srcKind('openwebninja'), 'sold');
  assert.equal(sandbox.srcKind(''), '');
  assert.equal(sandbox.srcKind('fallback-fx:de'), 'estimate');
  assert.equal(sandbox.srcKind('fallback-fx:co.uk'), 'estimate');
  assert.equal(sandbox.srcKind('future-feed'), '', 'an unknown source is not sold');
});

test('Your cards counts a cross-market copy as estimated live, and leaves today unchanged without one', () => {
  const sb = vm.createContext({
    ebayReg: () => 'de',
    priceMode: () => 'live',
    CUR: { code: 'EUR' },
    SETTINGS: { fallbackUS: false },
    document: { querySelector: () => ({ textContent: 'Germany (ebay.de)' }) },
    esc: (v) => String(v == null ? '' : v),
    CARDS: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
    own: { A: { qty: 1 }, B: { qty: 1 }, C: { qty: 1 }, D: { qty: 1 }, E: { qty: 0 } },
    PRICEBOOK: { A: 2, B: 3, C: 4, D: 5, E: 6 },
    PRICESRC: { A: 'ebay-active', B: 'openwebninja', C: 'ebay-active', D: 'future-feed', E: 'fallback-fx:de' },
    PRICEBOOK_SOLD: {},
    PRICESRC_SOLD: {},
  });
  vm.runInContext(['isFallbackSrc', 'srcKind', 'unitOfEntry', 'priceSourcesHtml'].map(appFunction).join('\n'), sb);
  const before = sb.priceSourcesHtml();
  const yours = /Your cards: ([^<]+)/.exec(before);
  assert.ok(yours, before);
  assert.equal(yours[1], '1 eBay sold · 2 eBay listings.');
  assert.equal(yours[1].includes('estimated'), false, 'no fallback row, so the line is unchanged');

  sb.PRICESRC.C = 'fallback-fx:fr';
  const after = /Your cards: ([^<]+)/.exec(sb.priceSourcesHtml());
  assert.equal(after[1], '1 eBay sold · 1 eBay listings · 1 estimated live.');
  assert.equal(/[-–—]/.test(after[1]), false, after[1]);
  assert.equal(after[1].includes('future'), false);
});

test('the live refresh line adds N estimated the way last sold does', () => {
  const el = { textContent: '' };
  const sb = vm.createContext({
    $: (id) => (id === 'lastRefreshLbl' ? el : null),
    priceMode: () => 'live',
    relTime: () => '3h ago',
    LIVE_ASOF: 1,
    SOLD_ASOF: 0,
    PRICEASOF: 0,
    LIVE_COV: null,
    SOLD_COV: null,
    PRICESRC: {},
  });
  vm.runInContext(['isFallbackSrc', 'srcKind', 'liveEstimateCount', 'updateRefreshLabel'].map(appFunction).join('\n'), sb);
  sb.updateRefreshLabel();
  assert.equal(el.textContent, 'Live listings updated 3h ago');

  sb.LIVE_COV = { stale: 2 };
  sb.updateRefreshLabel();
  assert.equal(el.textContent, 'Live listings updated 3h ago · 2 cards older than 2 days');

  sb.LIVE_COV = { stale: 2, filled: 4 };
  sb.updateRefreshLabel();
  assert.equal(el.textContent, 'Live listings updated 3h ago · 2 cards older than 2 days · 4 estimated');

  sb.LIVE_COV = { stale: 1, filled: 1 };
  sb.updateRefreshLabel();
  assert.equal(el.textContent, 'Live listings updated 3h ago · 1 card older than 2 days · 1 estimated');
  assert.equal(/[-–—]/.test(el.textContent), false);

  // An older reply has no filled field. The fallback rows in the book are the same count.
  sb.LIVE_COV = { stale: 0 };
  sb.PRICESRC = { a: 'ebay-active', b: 'fallback-fx:de', c: 'fallback-fx:com', d: 'palworld' };
  sb.updateRefreshLabel();
  assert.equal(el.textContent, 'Live listings updated 3h ago · 2 estimated');

  // A server that says zero wins, so a filled field of 0 does not invent a count.
  sb.LIVE_COV = { stale: 0, filled: 0 };
  sb.updateRefreshLabel();
  assert.equal(el.textContent, 'Live listings updated 3h ago');

  // No live timestamp yet: the generic line stays as it is, even when a count exists.
  sb.LIVE_ASOF = 0;
  sb.PRICEASOF = 1;
  sb.LIVE_COV = { stale: 2, filled: 4 };
  sb.updateRefreshLabel();
  assert.equal(el.textContent, 'Prices updated 3h ago · 2 cards older than 2 days');

  sb.priceMode = () => 'sold';
  sb.SOLD_ASOF = 1;
  sb.SOLD_COV = { real: 10, filled: 3, stale: 0 };
  sb.LIVE_COV = { filled: 9 };
  sb.updateRefreshLabel();
  assert.equal(el.textContent, 'Last sold updated 3h ago · 3 estimated');
});

// ---- where the credits live -----------------------------------------------------------------------------
// The footer carries only the disclaimer and the rights holders. Every source credit moved to the licences
// page, which the footer links from every screen. That is a deliberate choice and it only holds while the
// page actually carries them, so these fail if a credit is dropped rather than moved.

test('the footer is the disclaimer and the rights holders, and nothing else', () => {
  const foot = /\$\("foot"\)\.innerHTML = '([^]*?)<div class="footlinks"/.exec(source);
  assert.ok(foot, 'the footer is built in one place');
  const prose = foot[1].replace(/<[^>]+>/g, '');
  assert.match(prose, /not affiliated with or endorsed by Pocketpair \/ Bushiroad/);
  assert.match(prose, /Card data and artwork . Pocketpair \/ Bushiroad/);
  for (const gone of ['palworldtcg', 'Palworld Wiki', 'Palworld Prices', 'Exchange Rate API', 'TCGplayer']) {
    assert.ok(!prose.includes(gone), gone + ' belongs on the licences page now, not in the footer');
  }
});

test('the footer still points at the licences page, and says what is on it', () => {
  assert.match(source, /href="https:\/\/spheredex\.app\/app\/licenses\/"[^>]*>Data sources and licences</,
    'a link called just "Licences" would not tell anyone the credits are there');
});

test('every source with a licence obligation is named on the licences page', () => {
  const page = fs.readFileSync(path.join(root, 'docs', 'app', 'licenses', 'index.html'), 'utf8');
  // Each of these asks for attribution in its own terms, verified against the provider directly.
  const required = [
    ['palworldtcg.gg', 'quote our content with attribution'],
    ['Palworld Prices', 'visible attribution and a link back'],
    ['Exchange Rate API', 'attribution on the pages using the rates'],
    ['Palworld Wiki', 'CC BY SA'],
    ['Chakra Petch', 'SIL Open Font License'],
    ['Baloo 2', 'SIL Open Font License'],
  ];
  for (const [name, why] of required) {
    assert.ok(page.includes(name), name + ' must be credited (' + why + ')');
  }
  assert.match(page, /OFL-chakrapetch\.txt/, 'the font licence text ships, not just the font name');
  assert.match(page, /OFL-baloo2\.txt/);
  assert.match(page, /exchangerate-api\.com/, 'Exchange Rate API is linked, not only named');
  assert.match(page, /palworldprices\.com/, 'Palworld Prices gets its required link back');
});

test('there is a close X as well as the Done button', () => {
  assert.match(source, /id="pxFullX"[^>]*aria-label="Close"/);
  assert.match(source, /var x=\$\("pxFullX"\); if\(x\) x\.onclick=shutPriceChart;/);
});

// ---- history ----------------------------------------------------------------------------------------------
// The chart pushes a history entry when it opens. Every way of closing it has to consume that entry, or each
// chart visit leaves one more Back press between the person and leaving the page.

function historyApp() {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, hidden: true, onclick: null, textContent: '', innerHTML: '',
    addEventListener(type, fn) { this['on_' + type] = fn; } });
  ['pxScrim', 'pxFullClose', 'pxFullX', 'pxFullTitle', 'pxFullSub', 'pxFullBody', 'paScrim'].forEach(el);
  const hist = { entries: [{}], index: 0, pending: 0 };
  const app = {
    els, hist,
    $: (id) => els[id] || null,
    _histReady: true, _navDepth: 0, _curPage: 'collection', _pxSkipPop: 0, detailGen: 0,
    sheetClosed: 0, pages: [],
    priceMode: () => 'live',
    fullPriceChartHtml: () => '<svg></svg>',
    resetKb: () => {},
    closeNavMenu: () => {},
    scrim: { classList: { remove: () => { app.sheetClosed++; } } },
    showPage: (p) => { app.pages.push(p); },
    history: {
      pushState(state) { hist.entries.splice(hist.index + 1); hist.entries.push(state); hist.index++; },
      back() {
        if (hist.index === 0) return;
        hist.index--; hist.pending++;
        const state = hist.entries[hist.index];
        setImmediate(() => { hist.pending--; app.onAppPopState({ state }); });
      },
    },
  };
  vm.createContext(app);
  vm.runInContext('var _ovStack=[];\n' + ['pushAppEntry', 'openOverlay', 'dismissOverlay', 'closeTopOverlay', 'goBack',
    'backAction', 'onAppPopState', 'hidePriceChart', 'shutPriceChart', 'dropPriceChart', 'wirePriceChart',
    'openPriceChart', 'closeModal'].map(appFunction).join('\n'), app);
  return app;
}
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

async function sheetWithChart() {
  const app = historyApp();
  app.openOverlay(app.closeModal);                 // the card sheet
  app.openPriceChart({ id: 'EBP01-002', name: 'Test' });
  assert.equal(app.els.pxScrim.hidden, false);
  assert.equal(app.hist.index, 2, 'sheet and chart each own one entry');
  return app;
}

async function assertOnlySheetLeft(app, how) {
  await settle();
  assert.equal(app.els.pxScrim.hidden, true, how + ' hides the chart');
  assert.equal(app.hist.index, 1, how + ' consumes the chart entry');
  assert.equal(app.sheetClosed, 0, how + ' leaves the card sheet open');
  // One Back now closes the sheet, and the page is left with no extra steps.
  app.backAction();
  await settle();
  assert.equal(app.sheetClosed, 1);
  assert.equal(app.hist.index, 0, 'no extra Back steps remain after ' + how);
  assert.equal(app._navDepth, 0);
}

test('Done consumes the chart history entry', async () => {
  const app = await sheetWithChart();
  app.els.pxFullClose.onclick();
  await assertOnlySheetLeft(app, 'Done');
});

test('X consumes the chart history entry', async () => {
  const app = await sheetWithChart();
  app.els.pxFullX.onclick();
  await assertOnlySheetLeft(app, 'X');
});

test('tapping the scrim consumes the chart history entry', async () => {
  const app = await sheetWithChart();
  app.els.pxScrim.on_click({ target: app.els.pxScrim });
  await assertOnlySheetLeft(app, 'the scrim');
});

test('Escape and the Android Back button consume the chart history entry', async () => {
  // Escape and SDHardwareBack both go through backAction.
  const app = await sheetWithChart();
  assert.equal(app.backAction(), true);
  await assertOnlySheetLeft(app, 'Escape');
});

test('browser Back consumes the chart history entry instead of pushing another', async () => {
  const app = await sheetWithChart();
  app.history.back();
  await assertOnlySheetLeft(app, 'browser Back');
});

test('closing the card sheet under the chart consumes the chart entry too', async () => {
  const app = await sheetWithChart();
  app.closeModal();
  await settle();
  assert.equal(app.els.pxScrim.hidden, true);
  assert.equal(app.hist.index, 1, 'only the sheet entry is left, for whoever closed the sheet to consume');
  assert.equal(app.sheetClosed, 1, 'the skipped popstate closed nothing else');
  assert.equal(app._pxSkipPop, 0);
  assert.equal(app.pages.length, 0, 'no page change');
});

test('reopening a chart that is already open does not push a second entry', async () => {
  const app = await sheetWithChart();
  app.openPriceChart({ id: 'EBP01-002', name: 'Test' });
  assert.equal(app.hist.index, 2);
});

// ---- one colour per price type, everywhere ---------------------------------------------------------
// The app has one rule: live listings are --up (green) and last sold is --azure (blue). The combined
// price history chart had them swapped, so the same coloured line meant opposite things on screens a
// tap apart. These hold every place that colours a price type to the same pair.
const LIVE = 'var(--up)';
const SOLD = 'var(--azure)';

test('the combined price history chart draws live green and sold blue', () => {
  const fn = appFunction('fullPriceChartHtml');
  assert.match(fn, /pxSeriesPath\(live,X,Y\)\+'" fill="none" stroke="var\(--up\)"/, 'the live line is green');
  assert.match(fn, /pxSeriesPath\(sold,X,Y\)\+'" fill="none" stroke="var\(--azure\)"/, 'the sold line is blue');
  assert.match(fn, /live\[0\]\.v\)\.toFixed\(1\)\+'" r="3" fill="var\(--up\)"/, 'a lone live point is green');
  assert.match(fn, /sold\[0\]\.v\)\.toFixed\(1\)\+'" r="3" fill="var\(--azure\)"/, 'a lone sold point is blue');
  assert.match(fn, /background:var\(--up\)"><\/i>Live listings/, 'the legend agrees for live');
  assert.match(fn, /background:var\(--azure\)"><\/i>Last sold/, 'the legend agrees for sold');
});

test('the combined chart carries none of the old swapped colours', () => {
  const fn = appFunction('fullPriceChartHtml');
  assert.doesNotMatch(fn, /var\(--el-Grass\)/, 'green for sold is gone');
  assert.doesNotMatch(fn, /var\(--accent\)/, 'cyan for live is gone');
});

test('every other place that colours a price type uses the same pair', () => {
  // If any of these ever moves, the chart test above has to move with it, and the reverse.
  assert.match(source, /\.val \.pmdot \{[^}]*background:var\(--up\)/, 'the price mode dot is green for live');
  assert.match(source, /\.val \.pmdot\.sold \{ background:var\(--azure\)/, 'and blue for sold');
  assert.match(source, /\.pclegend \.lglive::before \{ background:var\(--up\)/, 'the legend class for live');
  assert.match(source, /\.pclegend \.lgsold::before \{ background:var\(--azure\)/, 'the legend class for sold');
  assert.match(source, /color:\(isSold\?"var\(--azure\)":"var\(--up\)"\)/, 'the day view');
  assert.ok(LIVE !== SOLD);
});
