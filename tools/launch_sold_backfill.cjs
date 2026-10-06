'use strict';

// One-off eBay sold backfill for SphereDex price history.
//
// The nightly worker already prices cards through OpenWebNinja
// (real-time-ebay-data/search, show_only=sold_items,completed_items) and stores one
// aggregate row per lookup in price_observations. Those rows start on 24 Sep 2026.
// eBay's sold search only keeps about 90 days, so launch-day sales (30 Jul 2026)
// fall out around 28 Oct 2026. This tool pages that search for every card printing
// and sealed product, on eBay UK and eBay US, and writes only the missing history.
//
// It does not update prices, prices_live, the OpenWebNinja daily counter, or any
// price_daily day that already exists. The daily series is rebuilt with the same
// rules as backfillFromObservations in the worker (src/history.ts). The admin route
// that calls that function also runs snapshotDaily, which rewrites today, so this
// tool does that rebuild itself and leaves today's snapshot alone.
//
// Run from this repo, with the key in the environment and wrangler logged in to the
// backend checkout (the database and the key already live there):
//
//   node tools/launch_sold_backfill.cjs plan
//   node tools/launch_sold_backfill.cjs pull --yes --max-calls 70 --wrangler-cwd /path/to/spheredex-backend
//   node tools/launch_sold_backfill.cjs apply --yes --wrangler-cwd /path/to/spheredex-backend
//
// pull is resumable. apply refuses to rebuild history until every target has finished
// paging. Re-running either command is safe: sales are keyed by listing id.

const fs = require('node:fs');
const path = require('node:path');

const SOURCE = 'openwebninja-launch-backfill';
const LAUNCH = '2026-07-30';
const HISTORY_START = '2026-09-24';
const REGIONS = ['co.uk', 'com'];
const CURRENCY = { 'co.uk': 'GBP', 'com': 'USD' };
const MAX_PAGES_DEFAULT = 8;
const INTERVAL_MS_DEFAULT = 1100;
const SANE_RATIO = 20;
const APP_DAILY_BUDGET = 300;
const APP_NIGHTLY_SOLD_CAP = 150;
const APP_RESERVE = 80;
// Leave the nightly sold pass and the card-open reserve inside the app's 300/day
// budget, in case that figure is also the provider's daily cap.
const SAFE_DAILY_CALLS = APP_DAILY_BUDGET - APP_NIGHTLY_SOLD_CAP - APP_RESERVE;

const PAGES_BY_RARE = {
  SSS: 3, RR: 3, OSR: 2, SP: 2, SSP: 2, SR: 2, TSP: 2,
  R: 1, U: 1, C: 1, TD: 1, TSR: 1, PR: 1
};

const BULK_RE = /(pick|choose|complete)\s+your|you\s+(pick|choose)|cards?\s+you|job\s*lot|\bbundle\b|\blot of\b|playset|\bset of\b|\bx\s?\d|\b\d+\s?x\b/i;
const NOT_CARD_RE = /\bno\s+cards?\b|\bcards?\s+not\s+included\b|\bempty\s+case\b|\bcase\s+only\b|\b(?:sleeve|holder|toploader|top\s?loader|display)s?\s+only\b|\b(?:proxy|proxies|custom|orica|fan\s*made|repro(?:duction)?|bootleg)\b|\binsert\b/i;
const JP_RE = /\bjapanese\b|\bjapan\b|\bjpn\b|\bjp\s*(?:ed(?:ition)?|ver(?:sion)?)\b|[぀-ヿ㐀-鿿ｦ-ﾟ]/i;
const JP_CODE_RE = /(?:^|[^A-Za-z])(?:BP|TD|SD)\d{2}-? ?\d{2,3}/i;
const CARD_NUM_RE = /\b[A-Z]{2,5}\d{0,2}-\d{2,3}[A-Z]{0,3}\b/i;
const GRADED_RE = /\b(psa|bgs|cgc|sgc|ace|gma|tag)\b|\bgem\s*mint\b|\bgraded\b|\bslab/i;
const VARIANTS = ['OSR', 'SSP', 'TSR', 'TSP', 'SP', 'SR'];
const SEAL_FILTER = {
  box: (t) => /\b(box|display|case)\b/i.test(t) && !/\b(single|singles)\b/i.test(t),
  pack: (t) => /\bpacks?\b/i.test(t) && !/\b(box|display|case|deck|single|singles)\b/i.test(t),
  deck: (t) => /\b(deck|starter)\b/i.test(t) && !/\b(box|pack|booster|single|singles)\b/i.test(t)
};
const OWN_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const SOLD_RANK = { sold: 3, derived: 2, modelled: 1 };

function round2(n) {
  return Math.round(n * 100) / 100;
}

function r2(n) {
  const v = Number(n);
  return n != null && isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

function normNum(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isForeignEdition(title) {
  return JP_RE.test(title) || JP_CODE_RE.test(title);
}

function keywordFor(name, num, grade = '') {
  const tidy = (s) => s.replace(/–/g, '-').replace(/\s+/g, ' ').trim();
  let base;
  if (num) {
    const palWord = tidy(name).split(/[ -]/)[0] || '';
    base = `${num} ${palWord}`;
    if (/^EPR/i.test(num)) base += ' promo';
  } else {
    base = tidy(name);
  }
  return tidy(grade ? `${base} ${grade}` : base);
}

function numVariantOk(title, num) {
  const target = normNum(num);
  if (!target) return true;
  const suffix = VARIANTS.find((v) => target.endsWith(v)) || '';
  const baseNorm = suffix ? target.slice(0, -suffix.length) : target;
  const t = title || '';
  if (!normNum(t).includes(baseNorm)) return false;
  const indicates = (v) => normNum(t).includes(baseNorm + v) || new RegExp(`\\b${v}\\b`, 'i').test(t);
  const present = VARIANTS.filter(indicates);
  return suffix ? present.includes(suffix) : present.length === 0;
}

function cleanSales(sales, num = '', grade = '', kind = 'card') {
  let s = sales.filter((x) => x.p > 0 && !BULK_RE.test(x.title || ''));
  if (kind === 'card') s = s.filter((x) => !NOT_CARD_RE.test(x.title || ''));
  if (!num || /^E[A-Z]/i.test(num)) s = s.filter((x) => !isForeignEdition(x.title || ''));
  const sf = SEAL_FILTER[kind];
  if (sf) s = s.filter((x) => sf(x.title || '') && !CARD_NUM_RE.test(x.title || ''));
  if (normNum(num)) s = s.filter((x) => numVariantOk(x.title || '', num));
  if (grade) {
    const [grader, gv] = grade.trim().toLowerCase().split(/\s+/);
    const num2 = (gv || '').replace(/[^0-9.]/g, '');
    const gradeRe = num2 ? new RegExp('(?:^|[^\\d.])' + num2.replace('.', '\\.') + (num2.includes('.') ? '(?![\\d])' : '(?![\\d.])')) : null;
    s = s.filter((x) => {
      const t = (x.title || '').toLowerCase();
      return (!grader || t.includes(grader)) && (!gradeRe || gradeRe.test(t));
    });
  } else {
    s = s.filter((x) => !GRADED_RE.test(x.title || ''));
  }
  if (!s.length) return [];
  const ps = s.map((x) => x.p).slice().sort((a, b) => a - b);
  const med = ps[Math.floor(ps.length / 2)];
  if (med > 0 && s.length >= 3) {
    const trimmed = s.filter((x) => x.p >= med * 0.25 && x.p <= med * 4);
    if (trimmed.length >= 2) s = trimmed;
  }
  return s;
}

function parseSoldCaption(caption) {
  const s = String(caption || '').replace(/^\s*sold\s+/i, '').trim();
  if (!s) return '';
  let day = 0, mon = -1, yr = 0;
  let m = s.match(/(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})/);
  if (m) {
    day = +m[1];
    mon = OWN_MONTHS[m[2].slice(0, 3).toLowerCase()] ?? -1;
    yr = +m[3];
  } else {
    m = s.match(/([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (m) {
      mon = OWN_MONTHS[m[1].slice(0, 3).toLowerCase()] ?? -1;
      day = +m[2];
      yr = +m[3];
    }
  }
  if (mon < 0 || !yr || !day) return '';
  return `${yr}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function appKind(name) {
  const n = String(name || '');
  if (/box/i.test(n)) return 'box';
  if (/pack/i.test(n)) return 'pack';
  if (/deck/i.test(n)) return 'deck';
  return 'card';
}

function pagesForRare(rare) {
  return PAGES_BY_RARE[rare] || 1;
}

function pagesForSealed(name) {
  const kind = appKind(name);
  if (kind === 'box') return 3;
  if (kind === 'pack' || kind === 'deck') return 2;
  return 1;
}

function confidenceOf(sample) {
  const n = Number(sample) || 0;
  return n >= 5 ? 'high' : n >= 2 ? 'medium' : 'low';
}

function extractJsArray(html, name) {
  const token = 'var ' + name + ' = ';
  const start = html.indexOf(token);
  if (start < 0) throw new Error('missing ' + name);
  let i = start + token.length;
  let depth = 0;
  let inStr = false;
  let q = '';
  let esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    const n = html[i + 1];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === q) inStr = false;
      continue;
    }
    if (c === '/' && n === '/') {
      const nl = html.indexOf('\n', i);
      i = nl < 0 ? html.length : nl;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = html.indexOf('*/', i + 2);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; q = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return Function('return ' + html.slice(start + token.length, i))();
}

function loadCatalogueFromHtml(html) {
  const raw = extractJsArray(html, 'RAW').concat(extractJsArray(html, 'RAW2'));
  const cards = raw.map((a) => ({ id: a[0], name: a[1], rare: a[4] || '' }));
  const sealedSrc = extractJsArray(html, 'SEALED');
  const sealed = sealedSrc.map((p) => ({
    id: p.id,
    name: p.name || '',
    q: p.q || '',
    pre: !!p.pre
  }));
  return { cards, sealed };
}

function loadCatalogue(file) {
  return loadCatalogueFromHtml(fs.readFileSync(file, 'utf8'));
}

function targetKey(region, id) {
  return region + '|' + id;
}

function targetsOf(catalogue) {
  const out = [];
  for (const region of REGIONS) {
    for (const card of catalogue.cards) {
      out.push({
        region,
        id: card.id,
        name: card.name,
        rare: card.rare,
        kind: 'card',
        num: card.id,
        query: keywordFor(card.name, card.id, ''),
        pagesGuess: pagesForRare(card.rare)
      });
    }
    for (const product of catalogue.sealed) {
      out.push({
        region,
        id: product.id,
        name: product.name,
        rare: '',
        kind: appKind(product.name),
        num: '',
        query: keywordFor(product.q || product.name, '', ''),
        pre: !!product.pre,
        pagesGuess: pagesForSealed(product.name)
      });
    }
  }
  return out;
}

function estimateCalls(catalogue, maxPages = MAX_PAGES_DEFAULT) {
  const targets = targetsOf(catalogue);
  const perRegion = {};
  for (const region of REGIONS) perRegion[region] = 0;
  for (const t of targets) perRegion[t.region] += t.pagesGuess;
  const expected = Object.values(perRegion).reduce((a, b) => a + b, 0);
  return {
    cards: catalogue.cards.length,
    sealed: catalogue.sealed.length,
    targets: targets.length / REGIONS.length,
    regions: REGIONS.slice(),
    floor: (catalogue.cards.length + catalogue.sealed.length) * REGIONS.length,
    expected,
    cap: (catalogue.cards.length + catalogue.sealed.length) * REGIONS.length * maxPages,
    maxPages,
    perRegion,
    safeDailyCalls: SAFE_DAILY_CALLS,
    appDailyBudget: APP_DAILY_BUDGET
  };
}

function productsToSales(products, currencyFallback) {
  return (products || []).map((p) => ({
    p: parseFloat(p.price),
    currency: p.currency || currencyFallback,
    url: p.url || '',
    date: parseSoldCaption(p.caption),
    title: p.title || '',
    itemId: String(p.item_id || p.itemId || '')
  })).filter((x) => !isNaN(x.p) && x.p > 0);
}

function matchSales(products, target, saneRef = 0) {
  const currency = CURRENCY[target.region] || 'USD';
  let sales = cleanSales(productsToSales(products, currency), target.num, '', target.kind);
  sales = sales.filter((s) => s.currency === currency && !(saneRef > 0 && s.p > saneRef * SANE_RATIO));
  return sales.filter((s) => s.date && s.date >= LAUNCH && s.date < HISTORY_START);
}

function hashTitle(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function saleKey(region, cardId, sale) {
  if (sale.itemId) return `launch:${region}:${cardId}:item:${sale.itemId}`.slice(0, 300);
  if (sale.url) return `launch:${region}:${cardId}:url:${sale.url}`.slice(0, 300);
  return `launch:${region}:${cardId}:t:${sale.date}:${sale.p}:${hashTitle(sale.title || '')}`;
}

function daySaleKey(region, cardId, day) {
  return `launch-day:${region}:${cardId}:${day}`;
}

function quoteStats(sales) {
  const sorted = sales.slice().sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  const prices = sales.map((s) => s.p).slice().sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const last5 = sorted.slice(0, 5).map((s) => s.p);
  const avg = last5.reduce((a, b) => a + b, 0) / last5.length;
  return {
    market: round2(median),
    last: round2(sorted[0].p),
    avg: round2(avg),
    sample: sales.length,
    lastSaleAt: sorted[0].date
  };
}

function observationsFor(target, products, saneRef = 0) {
  const sales = matchSales(products, target, saneRef);
  const currency = CURRENCY[target.region] || 'USD';
  const rows = [];
  const byDay = new Map();
  for (const sale of sales) {
    if (!byDay.has(sale.date)) byDay.set(sale.date, []);
    byDay.get(sale.date).push(sale);
    rows.push({
      card_id: target.id,
      region: target.region,
      price_type: 'sold',
      source: SOURCE,
      confidence: confidenceOf(1),
      sample_size: 1,
      currency,
      market: round2(sale.p),
      last: round2(sale.p),
      avg: round2(sale.p),
      last_sale_at: sale.date,
      converted: 0,
      tier: 2,
      calculated_at: sale.date + ' 12:00:00',
      sale_key: saleKey(target.region, target.id, sale),
      aggregate: false
    });
  }
  for (const [day, daySales] of byDay) {
    const stats = quoteStats(daySales);
    rows.push({
      card_id: target.id,
      region: target.region,
      price_type: 'sold',
      source: SOURCE,
      confidence: confidenceOf(stats.sample),
      sample_size: stats.sample,
      currency,
      market: stats.market,
      last: stats.last,
      avg: stats.avg,
      last_sale_at: stats.lastSaleAt,
      converted: 0,
      tier: 2,
      calculated_at: day + ' 23:59:59',
      sale_key: daySaleKey(target.region, target.id, day),
      aggregate: true
    });
  }
  return rows;
}

function entry(l, s) {
  return [
    r2(l?.market),
    r2(l?.last),
    r2(l?.avg),
    l?.source ?? null,
    r2(s?.market),
    r2(s?.last),
    r2(s?.avg),
    s?.source ?? null,
    s?.converted ? 1 : 0,
    s?.as_of ? String(s.as_of).slice(0, 10) : null
  ];
}

function haveKey(region, day) {
  return region + '|' + day;
}

// Same walk as backfillFromObservations. Days already stored, and today, are not returned.
function rebuildFromObservations(rows, haveDays, today) {
  const have = new Set(haveDays || []);
  const byRegion = new Map();
  for (const r of rows) {
    if (!byRegion.has(r.region)) byRegion.set(r.region, []);
    byRegion.get(r.region).push(r);
  }
  const out = [];
  for (const [region, list] of byRegion) {
    list.sort((a, b) => String(a.calculated_at) < String(b.calculated_at) ? -1 : String(a.calculated_at) > String(b.calculated_at) ? 1 : 0);
    const live = {};
    const sold = {};
    let day = '';
    const flush = () => {
      if (!day || day >= today || have.has(haveKey(region, day))) return;
      const data = {};
      const ids = new Set([...Object.keys(live), ...Object.keys(sold)]);
      for (const id of ids) data[id] = entry(live[id], sold[id]);
      if (Object.keys(data).length) {
        out.push({
          region,
          day,
          currency: CURRENCY[region] || null,
          src: 'observations',
          data
        });
      }
    };
    for (const r of list) {
      const d = String(r.calculated_at).slice(0, 10);
      if (d !== day) {
        flush();
        day = d;
      }
      if (!(Number(r.market) > 0)) continue;
      const row = {
        market: r.market,
        last: r.last,
        avg: r.avg,
        source: r.source,
        converted: r.converted,
        as_of: r.calculated_at
      };
      if (r.price_type === 'listing') {
        live[r.card_id] = row;
        continue;
      }
      const rank = SOLD_RANK[r.price_type] || 0;
      const cur = sold[r.card_id];
      if (!cur || cur.day !== d || rank >= cur.rank) sold[r.card_id] = Object.assign({}, row, { rank, day: d });
    }
    flush();
  }
  return out;
}

function mergeObservations(existing, fresh) {
  const freshKeys = new Set(fresh.map((r) => r.sale_key).filter(Boolean));
  const kept = (existing || []).filter((r) => !r.sale_key || !freshKeys.has(r.sale_key));
  return kept.concat(fresh);
}

function sqlString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function sqlNumber(value) {
  const n = Number(value);
  if (!isFinite(n)) return 'NULL';
  return String(n);
}

function observationSql(row) {
  const cols = '(card_id, region, price_type, source, confidence, sample_size, currency, market, last, avg, last_sale_at, converted, tier, calculated_at, sale_key)';
  const vals = [
    sqlString(row.card_id),
    sqlString(row.region),
    sqlString(row.price_type),
    sqlString(row.source),
    sqlString(row.confidence),
    sqlNumber(row.sample_size),
    sqlString(row.currency),
    sqlNumber(row.market),
    sqlNumber(row.last),
    sqlNumber(row.avg),
    sqlString(row.last_sale_at),
    sqlNumber(row.converted ? 1 : 0),
    sqlNumber(row.tier),
    sqlString(row.calculated_at),
    sqlString(row.sale_key)
  ].join(', ');
  if (row.aggregate) {
    return 'INSERT INTO price_observations ' + cols + ' VALUES (' + vals + ')\n' +
      'ON CONFLICT(sale_key) DO UPDATE SET market=excluded.market, last=excluded.last, avg=excluded.avg, ' +
      'sample_size=excluded.sample_size, confidence=excluded.confidence, last_sale_at=excluded.last_sale_at, ' +
      'calculated_at=excluded.calculated_at\n' +
      "WHERE price_observations.source = '" + SOURCE + "';";
  }
  return 'INSERT OR IGNORE INTO price_observations ' + cols + ' VALUES (' + vals + ');';
}

function dailySql(row) {
  return 'INSERT INTO price_daily (region, day, currency, src, data, updated_at)\n' +
    'SELECT ' + [
      sqlString(row.region),
      sqlString(row.day),
      row.currency ? sqlString(row.currency) : 'NULL',
      sqlString(row.src),
      sqlString(JSON.stringify(row.data)),
      'CURRENT_TIMESTAMP'
    ].join(', ') + '\n' +
    'WHERE NOT EXISTS (SELECT 1 FROM price_daily WHERE region = ' + sqlString(row.region) +
    ' AND day = ' + sqlString(row.day) + ');';
}

function migrationSql() {
  return [
    'ALTER TABLE price_observations ADD COLUMN sale_key TEXT;',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_price_observations_sale_key ON price_observations(sale_key);'
  ];
}

function slimProduct(p) {
  return {
    item_id: String(p.item_id || p.itemId || ''),
    title: String(p.title || '').slice(0, 500),
    price: p.price,
    currency: p.currency || '',
    url: String(p.url || '').slice(0, 400),
    caption: String(p.caption || '').slice(0, 80)
  };
}

function freshState() {
  return { version: 1, calls: 0, targets: {} };
}

function pageDone(res, page, perPage) {
  const got = (res.products || []).length;
  const per = Number(res.resultsPerPage) || perPage || 60;
  const total = Number(res.totalResults);
  const covered = Number.isFinite(total) && total > 0 && page * per >= total;
  return got < per || covered;
}

// Pulls one target from the next unfinished page. Saved pages are not requested again.
async function pullTarget(target, entry, opts) {
  const state = entry || { products: [], nextPage: 1, calls: 0 };
  const products = (state.products || []).slice();
  let page = state.nextPage || 1;
  let calls = 0;
  let totalResults = state.totalResults ?? null;
  while (page <= opts.maxPages) {
    if (opts.callsUsed + calls >= opts.maxCalls) {
      return {
        paused: true,
        products,
        nextPage: page,
        calls,
        totalResults,
        done: false,
        truncated: false
      };
    }
    const prior = (opts.priorCalls || 0) + calls;
    if (opts.sleep && prior > 0 && opts.intervalMs) await opts.sleep(opts.intervalMs);
    const res = await opts.fetchPage({ query: target.query, domain: target.region, page });
    calls++;
    if (res.totalResults != null) totalResults = res.totalResults;
    for (const p of res.products || []) products.push(slimProduct(p));
    const finished = pageDone(res, page, opts.resultsPerPage || 60);
    page++;
    if (opts.onPage) {
      await opts.onPage({
        products,
        nextPage: page,
        calls,
        totalResults,
        done: finished,
        truncated: !finished && page > opts.maxPages
      });
    }
    if (finished) {
      return { paused: false, done: true, truncated: false, products, nextPage: page, calls, totalResults, pages: page - 1 };
    }
  }
  return {
    paused: false,
    done: false,
    truncated: true,
    products,
    nextPage: page,
    calls,
    totalResults,
    pages: opts.maxPages
  };
}

function observationsFromState(catalogue, state, saneByRegion) {
  const saneByRegionMap = saneByRegion || {};
  const rows = [];
  for (const target of targetsOf(catalogue)) {
    const saved = state.targets[targetKey(target.region, target.id)];
    if (!saved || !(saved.products || []).length) continue;
    const sane = target.kind === 'card' ? Number(saneByRegionMap[target.region]?.[target.id]) || 0 : 0;
    rows.push(...observationsFor(target, saved.products || [], sane));
  }
  return rows;
}

function pendingTargets(catalogue, state, maxPages) {
  const pending = [];
  for (const target of targetsOf(catalogue)) {
    const saved = state.targets[targetKey(target.region, target.id)];
    if (!saved || !saved.done) pending.push(target);
    else if (saved.truncated && (saved.nextPage || 1) <= maxPages) pending.push(target);
  }
  return pending;
}

function planText(est) {
  const lines = [];
  lines.push('Launch sold backfill');
  lines.push('Window: ' + LAUNCH + ' inclusive, up to ' + HISTORY_START + ' exclusive (SphereDex history starts that day).');
  lines.push('Cards: ' + est.cards + '. Sealed products: ' + est.sealed + '. Regions: ' + est.regions.join(', ') + '.');
  lines.push('Targets: ' + est.targets + ' per region, ' + (est.targets * est.regions.length) + ' searches.');
  lines.push('OpenWebNinja calls if every search is one page: ' + est.floor + '.');
  lines.push('Expected calls from sold volume by rarity (UK counted the same as US): ' + est.expected + '.');
  lines.push('Hard cap at ' + est.maxPages + ' pages per search: ' + est.cap + '. Paging stops early when a page is short.');
  lines.push('The app budgets ' + est.appDailyBudget + ' OpenWebNinja calls a day (' + APP_NIGHTLY_SOLD_CAP + ' for the nightly sold pass, ' + APP_RESERVE + ' kept for card opens).');
  lines.push('If that 300 is also the provider cap, pass --max-calls ' + est.safeDailyCalls + ' and resume on later days. That leaves the nightly job its calls.');
  lines.push('This tool does not increment that counter, and it does not write prices or prices_live.');
  lines.push('Deadline: finish before about 28 Oct 2026, when 30 Jul sales leave eBay sold search.');
  return lines.join('\n');
}

function defaultStatePath() {
  return path.join(__dirname, '..', 'tmp', 'launch-sold-backfill', 'state.json');
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== 1 || !parsed.targets) return freshState();
    parsed.calls = Number(parsed.calls) || 0;
    return parsed;
  } catch (e) {
    return freshState();
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

function cataloguePath() {
  return path.join(__dirname, '..', 'src', 'paldeck.html');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function fatalHttp(status) {
  return status === 401 || status === 402 || status === 403;
}

async function fetchOpenWebNinja(apiKey, spec) {
  const qs = new URLSearchParams({
    query: spec.query,
    show_only: 'sold_items,completed_items',
    domain: spec.domain,
    page: String(spec.page)
  });
  const res = await fetch('https://api.openwebninja.com/real-time-ebay-data/search?' + qs.toString(), {
    headers: { 'x-api-key': apiKey }
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('openwebninja HTTP ' + res.status + ': ' + text.slice(0, 140));
    err.status = res.status;
    throw err;
  }
  let body;
  try { body = JSON.parse(text); } catch (e) {
    throw new Error('openwebninja returned non-JSON');
  }
  const data = body && body.data || {};
  const total = Number(data.total_results);
  return {
    products: data.products || [],
    totalResults: Number.isFinite(total) ? total : null,
    resultsPerPage: Number(data.results_per_page) || 60
  };
}

async function withRetries(fn, sleep, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (fatalHttp(e.status)) throw e;
      const retry = e.status === 429 || (e.status >= 500 && e.status <= 599) || !e.status;
      if (!retry || i === attempts - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

function spawnWrangler(cwd, args) {
  const { spawnSync } = require('node:child_process');
  const res = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error('wrangler d1 exited ' + res.status + ': ' + String(res.stderr || res.stdout || '').slice(0, 400));
  }
  const out = String(res.stdout || '').trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function d1Query(cwd, sql, remote) {
  const flag = remote ? '--remote' : '--local';
  const blocks = spawnWrangler(cwd, [flag, '--json', '--command', sql]);
  const results = [];
  for (const block of blocks) {
    for (const row of block.results || []) results.push(row);
  }
  return results;
}

function d1File(cwd, file, remote) {
  const flag = remote ? '--remote' : '--local';
  spawnWrangler(cwd, [flag, '--file', file]);
}

function columnNames(cwd, remote) {
  const rows = d1Query(cwd, 'PRAGMA table_info(price_observations)', remote);
  return new Set(rows.map((r) => r.name));
}

function writeSqlFile(file, statements) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, statements.join('\n') + '\n');
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function cmdPull(args, io) {
  if (!args.yes) {
    io.log('Refusing to call OpenWebNinja without --yes. Run plan first and check the call estimate against the quota.');
    return 1;
  }
  const maxCalls = Number(args['max-calls']);
  if (!Number.isFinite(maxCalls) || maxCalls <= 0) {
    io.log('Pass --max-calls. Use ' + SAFE_DAILY_CALLS + ' if the provider daily cap is the app budget of ' + APP_DAILY_BUDGET + '.');
    return 1;
  }
  const apiKey = process.env.OPENWEBNINJA_KEY || '';
  if (!apiKey) {
    io.log('OPENWEBNINJA_KEY is not set. This environment cannot call OpenWebNinja. Export the key where the backend already keeps it, and do not print it.');
    return 1;
  }
  const catalogue = loadCatalogue(args.catalogue || cataloguePath());
  const stateFile = args.state || defaultStatePath();
  const state = readState(stateFile);
  const maxPages = Math.max(1, Math.min(100, Number(args['max-pages']) || MAX_PAGES_DEFAULT));
  const intervalMs = Math.max(0, Number(args['interval-ms']) || INTERVAL_MS_DEFAULT);
  const remote = args.local ? false : true;
  let saneByRegion = {};
  if (args['wrangler-cwd']) {
    saneByRegion = loadSaneRefs(args['wrangler-cwd'], remote);
    io.log('Loaded live eBay prices for the 20x screen.');
  } else {
    io.log('No --wrangler-cwd, so the 20x live-listing screen is off for this pull. Other filters still apply.');
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let used = 0;
  const targets = targetsOf(catalogue);
  for (const target of targets) {
    const key = targetKey(target.region, target.id);
    const saved = state.targets[key];
    if (saved && saved.done && !(saved.truncated && (saved.nextPage || 1) <= maxPages)) continue;
    if (saved && saved.truncated && (saved.nextPage || 1) > maxPages && maxPages <= (saved.maxPages || 0)) continue;
    const entry = saved ? Object.assign({}, saved, { truncated: false, done: false }) : { products: [], nextPage: 1, calls: 0 };
    if (used >= maxCalls) {
      io.log('Paused at --max-calls ' + maxCalls + '. Resume with the same command. Calls this run: ' + used + '. Calls so far: ' + state.calls + '.');
      writeState(stateFile, state);
      return 0;
    }
    const sane = target.kind === 'card' ? Number(saneByRegion[target.region]?.[target.id]) || 0 : 0;
    const callsBefore = state.calls;
    let result;
    try {
      result = await pullTarget(target, entry, {
        maxPages,
        maxCalls: maxCalls - used,
        callsUsed: 0,
        priorCalls: used,
        intervalMs,
        sleep,
        fetchPage: (spec) => withRetries(() => fetchOpenWebNinja(apiKey, spec), sleep),
        onPage: async (progress) => {
          state.calls = callsBefore + progress.calls;
          state.targets[key] = {
            done: !!progress.done && !progress.truncated,
            truncated: !!progress.truncated,
            products: progress.products,
            nextPage: progress.nextPage,
            calls: (entry.calls || 0) + progress.calls,
            totalResults: progress.totalResults,
            pages: progress.nextPage - 1,
            kept: matchSales(progress.products, target, sane).length,
            maxPages
          };
          writeState(stateFile, state);
        }
      });
    } catch (e) {
      writeState(stateFile, state);
      if (fatalHttp(e.status)) {
        io.log(e.message);
        io.log('Stopped without marking ' + key + ' done. Fix the key or quota, then resume.');
        return 1;
      }
      io.log(key + ' failed: ' + e.message);
      io.log('Progress is saved. Resume with the same command.');
      return 1;
    }
    used += result.calls;
    state.calls = callsBefore + result.calls;
    const kept = matchSales(result.products, target, sane).length;
    state.targets[key] = {
      done: !!result.done,
      truncated: !!result.truncated,
      products: result.products,
      nextPage: result.nextPage,
      calls: (entry.calls || 0) + result.calls,
      totalResults: result.totalResults,
      pages: result.pages || (result.nextPage - 1),
      kept,
      maxPages
    };
    writeState(stateFile, state);
    const label = result.done ? 'done' : (result.paused ? 'paused' : 'truncated');
    io.log(key + ' ' + label + ' pages=' + (state.targets[key].pages || 0) + ' kept=' + kept + ' calls=' + result.calls);
    if (result.paused) {
      io.log('Paused at --max-calls ' + maxCalls + '. Resume with the same command. Calls this run: ' + used + '.');
      return 0;
    }
  }
  io.log('Pull finished. Calls this run: ' + used + '. Calls so far: ' + state.calls + '.');
  return 0;
}

function loadSaneRefs(cwd, remote) {
  const rows = d1Query(cwd, "SELECT card_id, region, market, source FROM prices_live WHERE region IN ('co.uk', 'com') AND source = 'ebay-active'", remote);
  const out = { 'co.uk': {}, 'com': {} };
  for (const row of rows) {
    if (!out[row.region]) out[row.region] = {};
    const market = Number(row.market);
    if (market > 0) out[row.region][row.card_id] = market;
  }
  return out;
}

function collectFresh(catalogue, state, saneByRegion) {
  return observationsFromState(catalogue, state, saneByRegion);
}

function cmdApply(args, io) {
  if (!args.yes) {
    io.log('Refusing to write history without --yes.');
    return 1;
  }
  const catalogue = loadCatalogue(args.catalogue || cataloguePath());
  const state = readState(args.state || defaultStatePath());
  const maxPages = Math.max(1, Math.min(100, Number(args['max-pages']) || MAX_PAGES_DEFAULT));
  const pending = pendingTargets(catalogue, state, maxPages);
  if (pending.length && !args['allow-partial']) {
    io.log(pending.length + ' searches are still unfinished. Finish pull, or pass --allow-partial to rebuild from what is saved.');
    return 1;
  }
  const remote = args.local ? false : true;
  const cwd = args['wrangler-cwd'];
  let saneByRegion = {};
  if (cwd) saneByRegion = loadSaneRefs(cwd, remote);
  const fresh = collectFresh(catalogue, state, saneByRegion);
  const obsSql = fresh.map(observationSql);
  const dir = path.dirname(args.state || defaultStatePath());
  if (!cwd) {
    const file = path.join(dir, 'observations.sql');
    writeSqlFile(file, migrationSql().concat(obsSql));
    io.log('Wrote ' + obsSql.length + ' observation statements to ' + file + '.');
    io.log('History days are not in that file. Re-run apply with --wrangler-cwd so existing price_daily days are left as they are.');
    return 0;
  }
  const names = columnNames(cwd, remote);
  if (!names.has('sale_key')) {
    for (const stmt of migrationSql()) d1File(cwd, writeTempSql(dir, [stmt]), remote);
    io.log('Added price_observations.sale_key. Nightly rows leave it empty.');
  } else {
    d1File(cwd, writeTempSql(dir, [migrationSql()[1]]), remote);
  }
  let n = 0;
  for (const part of chunk(obsSql, 40)) {
    d1File(cwd, writeTempSql(dir, part), remote);
    n += part.length;
  }
  io.log('Inserted observation statements: ' + n + '.');
  if (args['allow-partial']) {
    io.log('Partial apply stored observations only. Run apply again without --allow-partial once pull has finished, so each history day is inserted once.');
    return 0;
  }
  const haveRows = d1Query(cwd, "SELECT region, day FROM price_daily WHERE region IN ('co.uk', 'com')", remote);
  const have = haveRows.map((r) => haveKey(r.region, r.day));
  const existing = d1Query(cwd,
    "SELECT card_id, region, price_type, source, market, last, avg, converted, calculated_at, sale_key FROM price_observations WHERE region IN ('co.uk', 'com')",
    remote);
  const today = (args.today || new Date().toISOString().slice(0, 10));
  const days = rebuildFromObservations(mergeObservations(existing, fresh), have, today);
  const daySql = days.map(dailySql);
  for (const part of chunk(daySql, 20)) d1File(cwd, writeTempSql(dir, part), remote);
  io.log('Price_daily days inserted (existing days skipped): ' + days.length + '.');
  return 0;
}

function writeTempSql(dir, statements) {
  const file = path.join(dir, 'batch-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.sql');
  writeSqlFile(file, statements);
  return file;
}

function cmdPlan(args, io) {
  const catalogue = loadCatalogue(args.catalogue || cataloguePath());
  io.log(planText(estimateCalls(catalogue, Number(args['max-pages']) || MAX_PAGES_DEFAULT)));
  return 0;
}

async function main(argv, io) {
  const args = parseArgs(argv);
  const cmd = args._[0] || 'plan';
  if (cmd === 'plan') return cmdPlan(args, io);
  if (cmd === 'pull') return cmdPull(args, io);
  if (cmd === 'apply') return cmdApply(args, io);
  if (cmd === 'run') {
    const pulled = await cmdPull(args, io);
    if (pulled !== 0) return pulled;
    const catalogue = loadCatalogue(args.catalogue || cataloguePath());
    const state = readState(args.state || defaultStatePath());
    const maxPages = Math.max(1, Math.min(100, Number(args['max-pages']) || MAX_PAGES_DEFAULT));
    if (pendingTargets(catalogue, state, maxPages).length) {
      io.log('Pull is not finished, so history was not rebuilt. Resume pull, then apply.');
      return 0;
    }
    return cmdApply(args, io);
  }
  io.log('Commands: plan, pull, apply, run');
  return 1;
}

module.exports = {
  SOURCE, LAUNCH, HISTORY_START, REGIONS, CURRENCY, SAFE_DAILY_CALLS, MAX_PAGES_DEFAULT,
  keywordFor, cleanSales, parseSoldCaption, numVariantOk, appKind,
  loadCatalogueFromHtml, loadCatalogue, targetsOf, estimateCalls,
  matchSales, observationsFor, rebuildFromObservations, mergeObservations,
  observationSql, dailySql, migrationSql, pullTarget, pageDone, slimProduct,
  pendingTargets, observationsFromState, planText, freshState, targetKey,
  main
};

if (require.main === module) {
  main(process.argv.slice(2), { log: console.log }).then((code) => {
    process.exit(code || 0);
  }).catch((e) => {
    console.error(String(e && e.message || e));
    process.exit(1);
  });
}
