'use strict';

// Run with: node tools/test_launch_sold_backfill.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const backfill = require('./launch_sold_backfill.cjs');

const html = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'paldeck.html'), 'utf8');

function product(partial) {
  return Object.assign({
    item_id: '100',
    title: 'Chillet EBP01-025SSP',
    price: 20,
    currency: 'GBP',
    url: 'https://www.ebay.co.uk/itm/100',
    caption: 'Sold 30 Jul 2026'
  }, partial);
}

test('catalogue covers every baked printing and sealed product', () => {
  const catalogue = backfill.loadCatalogueFromHtml(html);
  assert.equal(catalogue.cards.length, 277);
  assert.equal(catalogue.sealed.length, 14);
  assert.ok(catalogue.cards.some((c) => c.id === 'EBP01-001'));
  assert.ok(catalogue.cards.some((c) => c.id === 'ETD01-001TSP'));
  assert.ok(catalogue.cards.some((c) => c.id === 'EPR-002S'));
  assert.ok(catalogue.sealed.some((p) => p.id === 'box-ebp01' && !p.pre));
  assert.ok(catalogue.sealed.some((p) => p.id === 'box-bp03' && p.pre));
  const est = backfill.estimateCalls(catalogue);
  assert.equal(est.floor, 582);
  assert.equal(est.expected, 798);
  assert.equal(est.cap, 4656);
  assert.equal(est.safeDailyCalls, 70);
  assert.equal(est.perRegion['co.uk'], est.perRegion['com']);
  assert.match(backfill.planText(est), /798/);
  assert.match(backfill.planText(est), /28 Oct 2026/);
});

test('search keywords match the live OpenWebNinja query', () => {
  assert.equal(backfill.keywordFor('Jormuntide Ignis – Savage Lava Dragon', 'EBP01-001'), 'EBP01-001 Jormuntide');
  assert.equal(backfill.keywordFor('Lamball – My First Pal', 'EPR-001'), 'EPR-001 Lamball promo');
  assert.equal(backfill.keywordFor('Palworld Dawn of Palpagos Booster Box', ''), 'Palworld Dawn of Palpagos Booster Box');
  assert.equal(backfill.appKind('Booster Box'), 'box');
  assert.equal(backfill.appKind('PR Card Pack Vol. 1'), 'pack');
  assert.equal(backfill.appKind('Trial Deck, Red · Blue'), 'deck');
  assert.equal(backfill.appKind(''), 'card');
});

test('sold captions parse the same way as the worker', () => {
  assert.equal(backfill.parseSoldCaption('Sold 30 Jul 2026'), '2026-07-30');
  assert.equal(backfill.parseSoldCaption('Sold Jul 30, 2026'), '2026-07-30');
  assert.equal(backfill.parseSoldCaption('Sold 5 October 2026'), '2026-10-05');
  // The worker strips a leading "Sold" and then searches for a date anywhere, so an
  // "Ended" caption that still contains a date is dated. A caption with no date is not.
  assert.equal(backfill.parseSoldCaption('Ended 30 Jul 2026'), '2026-07-30');
  assert.equal(backfill.parseSoldCaption('Best offer accepted'), '');
  assert.equal(backfill.parseSoldCaption(''), '');
});

test('matching drops lots, graded copies, the wrong printing, and foreign editions', () => {
  const target = { region: 'co.uk', id: 'EBP01-001', num: 'EBP01-001', kind: 'card' };
  const sales = backfill.matchSales([
    product({ item_id: '1', title: 'Jormuntide EBP01-001', price: 12, caption: 'Sold 30 Jul 2026' }),
    product({ item_id: '2', title: 'Jormuntide EBP01-001OSR', price: 80, caption: 'Sold 1 Aug 2026' }),
    product({ item_id: '3', title: 'Lot of 4 Jormuntide EBP01-001', price: 40, caption: 'Sold 2 Aug 2026' }),
    product({ item_id: '4', title: 'Jormuntide EBP01-001 PSA 10', price: 200, caption: 'Sold 3 Aug 2026' }),
    product({ item_id: '5', title: 'Japanese Jormuntide BP01-001', price: 9, caption: 'Sold 4 Aug 2026' }),
    product({ item_id: '6', title: 'Jormuntide EBP01-001', price: 11, currency: 'USD', caption: 'Sold 5 Aug 2026' }),
    product({ item_id: '7', title: 'Jormuntide EBP01-001', price: 500, caption: 'Sold 6 Aug 2026' }),
    product({ item_id: '8', title: 'Jormuntide EBP01-001', price: 13, caption: 'Sold 24 Sep 2026' }),
    product({ item_id: '9', title: 'Jormuntide EBP01-001', price: 14, caption: 'Sold 29 Jul 2026' })
  ], target, 10);
  assert.deepEqual(sales.map((s) => s.itemId), ['1']);
});

test('sealed filters keep a box and drop a single', () => {
  const target = { region: 'com', id: 'box-ebp01', num: '', kind: 'box' };
  const sales = backfill.matchSales([
    product({
      item_id: 'b1', title: 'Palworld Dawn of Palpagos Booster Box', price: 140, currency: 'USD',
      url: 'https://www.ebay.com/itm/b1', caption: 'Sold Aug 1, 2026'
    }),
    product({
      item_id: 'b2', title: 'Palworld single EBP01-025SSP', price: 40, currency: 'USD',
      url: 'https://www.ebay.com/itm/b2', caption: 'Sold Aug 2, 2026'
    })
  ], target, 0);
  assert.deepEqual(sales.map((s) => s.itemId), ['b1']);
});

test('a day stores each sale and a later aggregate the history walk will keep', () => {
  const target = { region: 'co.uk', id: 'EBP01-018', num: 'EBP01-018', kind: 'card' };
  const rows = backfill.observationsFor(target, [
    product({ item_id: 'a', title: 'Alarm Bell EBP01-018', price: 2, caption: 'Sold 3 Aug 2026' }),
    product({ item_id: 'b', title: 'Alarm Bell EBP01-018', price: 4, caption: 'Sold 3 Aug 2026', url: 'https://www.ebay.co.uk/itm/b' })
  ], 0);
  assert.equal(rows.length, 3);
  const agg = rows.find((r) => r.aggregate);
  assert.equal(agg.market, 4);
  assert.equal(agg.sample_size, 2);
  assert.equal(agg.calculated_at, '2026-08-03 23:59:59');
  assert.equal(agg.source, backfill.SOURCE);
  assert.equal(agg.confidence, 'medium');
  const again = backfill.observationsFor(target, [
    product({ item_id: 'a', title: 'Alarm Bell EBP01-018', price: 2, caption: 'Sold 3 Aug 2026' }),
    product({ item_id: 'b', title: 'Alarm Bell EBP01-018', price: 4, caption: 'Sold 3 Aug 2026', url: 'https://www.ebay.co.uk/itm/b' })
  ], 0);
  assert.deepEqual(again.map((r) => r.sale_key), rows.map((r) => r.sale_key));
  const merged = backfill.mergeObservations(rows, again);
  assert.equal(merged.length, 3);
});

test('history rebuild skips days SphereDex already has and does not write today', () => {
  const rows = [
    {
      card_id: 'EBP01-001', region: 'co.uk', price_type: 'sold', source: backfill.SOURCE,
      market: 10, last: 10, avg: 10, converted: 0, calculated_at: '2026-08-01 12:00:00', sale_key: 'raw'
    },
    {
      card_id: 'EBP01-001', region: 'co.uk', price_type: 'sold', source: backfill.SOURCE,
      market: 12, last: 12, avg: 12, converted: 0, calculated_at: '2026-08-01 23:59:59', sale_key: 'day'
    },
    {
      card_id: 'EBP01-002', region: 'co.uk', price_type: 'sold', source: backfill.SOURCE,
      market: 5, last: 5, avg: 5, converted: 0, calculated_at: '2026-08-03 23:59:59', sale_key: 'b'
    },
    {
      card_id: 'EBP01-001', region: 'co.uk', price_type: 'sold', source: 'openwebninja',
      market: 99, last: 99, avg: 99, converted: 0, calculated_at: '2026-09-24 01:00:00', sale_key: null
    },
    {
      card_id: 'EBP01-001', region: 'com', price_type: 'sold', source: backfill.SOURCE,
      market: 8, last: 8, avg: 8, converted: 0, calculated_at: '2026-08-02 23:59:59', sale_key: 'us'
    }
  ];
  const have = ['co.uk|2026-09-24'];
  const days = backfill.rebuildFromObservations(rows, have, '2026-10-06');
  const keys = days.map((d) => d.region + '|' + d.day);
  assert.deepEqual(keys, ['co.uk|2026-08-01', 'co.uk|2026-08-03', 'com|2026-08-02']);
  const aug1 = days[0].data['EBP01-001'];
  assert.equal(aug1[4], 12);
  assert.equal(aug1[7], backfill.SOURCE);
  assert.equal(aug1[0], null);
  const aug3 = days[1].data['EBP01-001'];
  assert.equal(aug3[4], 12, 'a card with no new sale keeps the price it already had');
  assert.equal(days[1].data['EBP01-002'][4], 5);
  assert.equal(days[0].src, 'observations');
  assert.equal(days.every((d) => d.day < '2026-09-24'), true);
});

test('observation SQL cannot rewrite the live price tables or an existing history day', () => {
  const target = { region: 'co.uk', id: 'EBP01-001', num: 'EBP01-001', kind: 'card' };
  const rows = backfill.observationsFor(target, [
    product({ item_id: "it's", title: 'Jormuntide EBP01-001', price: 12, caption: 'Sold 30 Jul 2026' })
  ], 0);
  const sql = rows.map(backfill.observationSql).join('\n') + '\n' + backfill.dailySql({
    region: 'co.uk', day: '2026-07-30', currency: 'GBP', src: 'observations', data: { 'EBP01-001': [null, null, null, null, 12, 12, 12, backfill.SOURCE, 0, '2026-07-30'] }
  });
  assert.match(sql, /INSERT OR IGNORE INTO price_observations/);
  assert.match(sql, /ON CONFLICT\(sale_key\) DO UPDATE SET/);
  assert.match(sql, /it''s/);
  assert.match(sql, /WHERE NOT EXISTS \(SELECT 1 FROM price_daily/);
  assert.equal(/INSERT INTO prices\b/.test(sql), false);
  assert.equal(/UPDATE price_daily/.test(sql), false);
  assert.equal(/prices_live/.test(sql), false);
  assert.equal(/own_used/.test(sql), false);
  assert.deepEqual(backfill.migrationSql().length, 2);
});

test('paging walks until a short page, resumes, and stops at the call cap', async () => {
  const target = { region: 'com', id: 'EBP01-025SSP', query: 'EBP01-025SSP Chillet', kind: 'card' };
  const seen = [];
  const sleeps = [];
  function page(n, count, total) {
    const products = [];
    for (let i = 0; i < count; i++) {
      products.push(product({
        item_id: n + '-' + i,
        title: 'Chillet EBP01-025SSP',
        price: 30,
        currency: 'USD',
        url: 'https://www.ebay.com/itm/' + n + '-' + i,
        caption: 'Sold Aug ' + (i % 20 + 1) + ', 2026'
      }));
    }
    return { products, totalResults: total, resultsPerPage: 60 };
  }
  const first = await backfill.pullTarget(target, null, {
    maxPages: 8,
    maxCalls: 1,
    callsUsed: 0,
    priorCalls: 0,
    intervalMs: 1100,
    sleep: async (ms) => { sleeps.push(ms); },
    fetchPage: async (spec) => {
      seen.push(spec.page);
      return page(spec.page, 60, 120);
    }
  });
  assert.equal(first.paused, true);
  assert.deepEqual(seen, [1]);
  assert.equal(first.products.length, 60);
  assert.deepEqual(sleeps, []);
  seen.length = 0;
  const second = await backfill.pullTarget(target, { products: first.products, nextPage: first.nextPage, calls: 1 }, {
    maxPages: 8,
    maxCalls: 5,
    callsUsed: 0,
    priorCalls: 1,
    intervalMs: 1100,
    sleep: async (ms) => { sleeps.push(ms); },
    fetchPage: async (spec) => {
      seen.push(spec.page);
      return page(spec.page, 10, 70);
    }
  });
  assert.equal(second.done, true);
  assert.deepEqual(seen, [2]);
  assert.equal(second.products.length, 70);
  assert.deepEqual(sleeps, [1100]);
  const kept = backfill.matchSales(second.products, Object.assign({ num: 'EBP01-025SSP' }, target), 0);
  assert.ok(kept.length > 0);
  assert.ok(kept.every((s) => s.date >= '2026-07-30' && s.date < '2026-09-24'));
});

test('commands refuse to spend quota or write rows unless asked', async () => {
  const logs = [];
  const io = { log: (line) => logs.push(line) };
  assert.equal(await backfill.main(['pull'], io), 1);
  assert.match(logs.join('\n'), /--yes/);
  logs.length = 0;
  assert.equal(await backfill.main(['pull', '--yes'], io), 1);
  assert.match(logs.join('\n'), /--max-calls/);
  logs.length = 0;
  const prev = process.env.OPENWEBNINJA_KEY;
  delete process.env.OPENWEBNINJA_KEY;
  assert.equal(await backfill.main(['pull', '--yes', '--max-calls', '70'], io), 1);
  assert.match(logs.join('\n'), /OPENWEBNINJA_KEY is not set/);
  if (prev) process.env.OPENWEBNINJA_KEY = prev;
  logs.length = 0;
  assert.equal(await backfill.main(['apply'], io), 1);
  assert.match(logs.join('\n'), /--yes/);
});
