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
};
vm.createContext(sandbox);
vm.runInContext(
  ['fmtFull', 'pxDayNum', 'pxSeriesPath', 'pxSinceLabel', 'trendSparkHtml', 'priceTrendHtml', 'fullPriceChartHtml']
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

test('the chart closes with the back button, Escape and the card sheet that owns it', () => {
  assert.match(source, /"upScrim","globalSearchScrim","pxScrim","paScrim"/, 'Escape reaches it');
  assert.match(source, /var px=\$\("pxScrim"\); if\(px && !px\.hidden\)\{ px\.hidden=true;/, 'the back button reaches it');
  assert.match(source, /function closeModal\(\)[^]*?var px=\$\("pxScrim"\); if\(px\) px\.hidden=true;/,
    'closing the card sheet closes it too');
});
