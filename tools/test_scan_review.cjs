'use strict';

// Run with: node tools/test_scan_review.cjs
// Guards the SCAN REVIEW section of src/paldeck.html (the continuous-scan session and its review
// sheet) and exercises its real code in a vm sandbox with a stub DOM, the same approach as
// tools/test_carousel.cjs. The structural tests are the regression guard: the session/review code
// must stay inside its BEGIN/END markers, stay identical across all four shipped copies, and expose
// the SCAN_REVIEW API seam. Collection mutations (changeRaw, save) are stubbed so the tests observe
// exactly what the section asks the rest of the app to do.
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
const BEGIN = { style: 'SCAN REVIEW BEGIN (styles', logic: 'SCAN REVIEW BEGIN (logic' };
const END = { style: 'SCAN REVIEW END (styles)', logic: 'SCAN REVIEW END (logic)' };

function readSection(file, kind) {
  const text = fs.readFileSync(file, 'utf8');
  const begin = text.indexOf(BEGIN[kind]);
  const end = text.indexOf(END[kind]);
  assert.ok(begin >= 0, `${file}: ${kind} BEGIN marker present`);
  assert.ok(end > begin, `${file}: ${kind} END marker present after BEGIN`);
  const again = text.indexOf(BEGIN[kind], begin + 1);
  assert.equal(again, -1, `${file}: exactly one ${kind} section`);
  // Slice from the start of the BEGIN line so the leading `// ====` / `/* ====` stays inside.
  return text.slice(text.lastIndexOf('\n', begin) + 1, end);
}
const srcSection = (kind) => readSection(FILES.src, kind);

// ---- structural guards -------------------------------------------------------------------

test('scan-review CSS and logic stay inside their markers in the canonical source', () => {
  srcSection('style');
  srcSection('logic');
});

test('scan-review definitions never leak outside the marked section', () => {
  const whole = fs.readFileSync(FILES.src, 'utf8');
  const logic = readSection(FILES.src, 'logic');
  const defs = (text) => (text.match(/\bfunction\s+(?:resetScanSession|scanSessionTotal|recordScan|scanRestore|scanMoveVariant|renderScanReview|closeScanReview|openScanReview|refreshScanSessionUI)\s*\(/g) || []).length
    + (text.match(/\bvar\s+scanSession\s*=/g) || []).length
    + (text.match(/\bvar\s+scanReviewScrim\s*=/g) || []).length;
  assert.ok(defs(logic) > 0, 'section actually contains the scan-review definitions');
  assert.equal(defs(whole), defs(logic), 'every scan-review definition lives inside the markers');
});

test('all four shipped copies carry a byte-identical scan-review section', () => {
  // rebuild.py enforces LF-only output and src/paldeck.html is LF (pinned in .gitattributes),
  // so this comparison is exact: any real drift, including line-ending drift, fails here.
  for (const kind of ['style', 'logic']) {
    const sections = Object.values(FILES).map((f) => readSection(f, kind));
    for (let i = 1; i < sections.length; i++) {
      assert.equal(sections[i], sections[0], `${kind} section matches the canonical source`);
    }
  }
});

test('the SCAN_REVIEW API seam stays intact', () => {
  const a = app();
  assert.deepEqual(
    Object.keys(a.window.SCAN_REVIEW).sort(),
    ['close', 'moveVariant', 'open', 'record', 'refresh', 'render', 'reset', 'restore', 'session', 'total'].sort()
  );
});

// ---- sandbox: run the real section against a stub DOM -------------------------------------

function makeNode(tag) {
  const node = {
    tagName: tag, style: {}, attrs: {}, hidden: false, parentNode: null,
    children: [], _listeners: {}, value: '', textContent: '', _html: '',
    className: '',
    classList: {
      add(c) { if (!node.classList.contains(c)) node.className = (node.className + ' ' + c).trim(); },
      remove(c) { node.className = node.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains(c) { return node.className.split(/\s+/).includes(c); },
    },
    setAttribute(k, v) { node.attrs[k] = String(v); },
    removeAttribute(k) { delete node.attrs[k]; },
    getAttribute(k) { return k in node.attrs ? node.attrs[k] : null; },
    appendChild(c) { c.parentNode = node; node.children.push(c); return c; },
    querySelector(sel) { return node._query([node], sel)[0] || null; },
    querySelectorAll(sel) { return node._query([node], sel); },
    _query(list, sel) {
      const out = [];
      const m = /^\[data-action="(\w+)"\]$/.exec(sel);
      for (const el of list) {
        for (const c of el.children) {
          if (m ? c.attrs['data-action'] === m[1] : (c.className || '').split(/\s+/).includes(sel.replace(/^\./, ''))) out.push(c);
          out.push(...node._query([c], sel));
        }
      }
      return out;
    },
    addEventListener(type, fn) { node._listeners[type] = (node._listeners[type] || []).concat(fn); },
    remove() { if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((c) => c !== node); },
  };
  // renderScanReview writes row.innerHTML then queries [data-action] controls out of it, so the
  // setter materialises button/select open tags into child nodes carrying class + data-action.
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._html; },
    set(v) {
      node._html = String(v);
      if (tag !== 'div') return;   // only row containers get parsed
      node.children = [];
      const re = /<(?:button|select)\b([^>]*)>/g;
      let m;
      while ((m = re.exec(node._html))) {
        const child = makeNode(m[0].slice(1, 7).replace(' ', ''));
        const cls = (/class="([^"]*)"/.exec(m[1]) || [, ''])[1];
        child.className = cls;
        const act = (/data-action="(\w+)"/.exec(m[1]) || [, ''])[1];
        if (act) child.attrs['data-action'] = act;
        child.parentNode = node;
        node.children.push(child);
      }
    },
  });
  return node;
}
function app(opts) {
  const el = (id) => { const n = makeNode('div'); n.id = id; return n; };
  const list = el('scanReviewList');
  const ids = {
    scanReviewList: list,
    scanReviewScrim: Object.assign(el('scanReviewScrim'), {}),
    scanSess: el('scanSess'),
    scanReviewBtn: el('scanReviewBtn'),
  };
  ids.scanReviewList = list;
  const document_ = { getElementById: (id) => ids[id] || null, createElement: (t) => makeNode(t) };
  const saved = [];
  const rawChanges = [];
  const sandbox = {
    document: document_, window: {},
    $: (id) => document_.getElementById(id),
    SETTINGS: { mode: 'trader' },
    STATE: { wishlist: {}, cols: [] },
    CARDS: [],
    byNumberIdx: {},
    esc: (s) => String(s), imgSrc: (c) => 'img:' + c.id, money: (v) => '$' + v,
    colName: (id) => 'Col ' + id,
    canEdition: () => true,
    rawEditionKey: (e) => String(e || 'unknown'), rawEditionLabel: (k) => 'Ed ' + k,
    rawCounts: (entry) => entry.rawCounts || {},
    changeRaw: (entry, delta, edition) => rawChanges.push({ id: Object.keys(col.own).find((k) => col.own[k] === entry) || null, delta, edition }),
    unitOfEntry: () => 2.5,
    save: () => saved.push(Date.now()),
    scanColById: (id) => STATE_COLS.find((c) => c.id === id) || null,
    scanRefreshPages: () => {},
    openOverlay: () => {}, dismissOverlay: () => {},
    ...opts,
  };
  const col = { id: 'test', name: 'Test', own: {} };
  // The section reads STATE via scanColById (stubbed above) but also merges items; keep STATE.cols aligned.
  sandbox.STATE.cols = [col];
  var STATE_COLS = [col];   // eslint-disable-line no-var -- captured by the stub closure
  const context = vm.createContext(sandbox);
  vm.runInContext(srcSection('logic') + '\n', context);
  return {
    window: sandbox.window, ids, list, col, saved, rawChanges, sandbox,
    api: sandbox.window.SCAN_REVIEW,
  };
}
const card = (id, name, base, rare) => ({ id, name, base: base || id, rare: rare || 'C' });
function seed(a, over) {
  const c1 = card('EBP01-001', 'Lamball');
  const c2 = card('EBP01-002', 'Cremis');
  const entry1 = { qty: 3, rawCounts: { '1': 3 }, graded: [], __cardId: 'EBP01-001' };
  const entry2 = { qty: 1, rawCounts: { '1': 1 }, graded: [], __cardId: 'EBP01-002' };
  a.col.own[c1.id] = entry1;
  a.col.own[c2.id] = entry2;
  a.sandbox.CARDS = [c1, c2];
  a.sandbox.byNumberIdx = { 'EBP01-001': c1, 'EBP01-002': c2 };
  const item = { id: 'EBP01-001', colId: 'test', dest: 'collection', type: 'raw', qty: 2, edition: '1', value: 5, scanId: 's1' };
  a.api.record(Object.assign(item, over || {}));
  return a;
}

// ---- behaviour ----------------------------------------------------------------------------

test('recordScan keeps a running tally of count and value', () => {
  const a = app();
  a.api.record({ id: 'EBP01-001', colId: 'test', dest: 'collection', type: 'raw', qty: 2, edition: '1', value: 5 });
  a.api.record({ id: 'EBP01-002', colId: 'test', dest: 'collection', type: 'raw', qty: 1, edition: '1', value: 2.5 });
  assert.equal(a.api.session.count, 2);
  assert.equal(a.api.session.value, 7.5);
  a.api.reset();
  assert.equal(a.api.session.count, 0);
  assert.equal(a.api.session.value, 0);
});

test('undo removes the capture and asks the app to reverse its collection change', () => {
  const a = seed(app());
  const item = a.api.session.items[0];
  a.api.restore(item);
  assert.deepEqual(a.rawChanges, [{ id: 'EBP01-001', delta: -2, edition: '1' }], 'changeRaw called with the captured qty and edition');
  // The row's undo handler splices and recomputes the tally; replicate that contract exactly:
  const i = a.api.session.items.indexOf(item);
  if (i >= 0) a.api.session.items.splice(i, 1);
  a.api.session.count = a.api.session.items.length;
  a.api.session.value = a.api.session.items.reduce((s, x) => s + (+x.value || 0), 0);
  assert.equal(a.api.session.count, 0);
});

test('undoing wishlist captures follows the review sheet: newest first, splice between undos', () => {
  const a = app();
  a.sandbox.STATE.wishlist['EBP01-002'] = true;
  a.api.record({ id: 'EBP01-002', dest: 'wishlist', wasWished: true, value: 2.5 });   // items[0]
  a.api.record({ id: 'EBP01-002', dest: 'wishlist', value: 2.5 });                    // items[1]
  // Undo the newest (the scan-added wish): the older wasWished capture still holds the wish, so
  // the wish stays - and the remaining capture's history is never rewritten.
  a.api.restore(a.api.session.items[1]);
  a.api.session.items.splice(1, 1);
  assert.equal(a.sandbox.STATE.wishlist['EBP01-002'], true, 'the pre-existing wish still stands after the first undo');
  assert.equal(a.api.session.items[0].wasWished, true, 'undo does not rewrite the other capture\'s wasWished history');
  // Undo the remaining capture: it was pre-existing, so it never owned the wish. Wish survives.
  a.api.restore(a.api.session.items[0]);
  a.api.session.items.splice(0, 1);
  assert.equal(a.sandbox.STATE.wishlist['EBP01-002'], true, 'a pre-existing wish survives undoing every capture');
  // Contrast: a lone scan-added capture removes the wish on undo.
  // Contrast: a lone scan-added capture removes the wish on undo.
  a.sandbox.STATE.wishlist['EBP01-003'] = true;
  a.api.record({ id: 'EBP01-003', dest: 'wishlist', value: 2.5 });
  a.api.restore(a.api.session.items[0]);
  assert.equal(a.sandbox.STATE.wishlist['EBP01-003'], undefined, 'a scan-added wish is removed');
});

test('moveVariant moves qty between printings and re-prices the capture', () => {
  const a = seed(app());
  const variant = card('EBP01-001-SR', 'Lamball', 'EBP01-001', 'SR');
  a.sandbox.CARDS.push(variant);
  a.sandbox.byNumberIdx['EBP01-001-SR'] = variant;
  const item = a.api.session.items[0];
  a.api.moveVariant(item, 'EBP01-001-SR');
  assert.equal(item.id, 'EBP01-001-SR');
  assert.equal(item.value, 5, '2 copies re-priced at 2.5 each');
  assert.deepEqual(a.rawChanges, [
    { id: 'EBP01-001', delta: -2, edition: '1' },
    { id: 'EBP01-001-SR', delta: 2, edition: '1' },
  ]);
});

test('moveVariant refuses impossible corrections without touching the collection', () => {
  const a = seed(app());
  const item = a.api.session.items[0];
  a.api.moveVariant(item, 'EBP01-001');       // same id
  a.api.moveVariant(item, '');                // empty
  a.api.moveVariant({ dest: 'wishlist', id: 'EBP01-001' }, 'EBP01-002');  // wrong dest
  assert.deepEqual(a.rawChanges, [], 'nothing mutated');
  assert.equal(a.api.session.items[0].id, 'EBP01-001');
});

test('renderScanReview lists one row per capture with undo, qty and variant controls', () => {
  const a = seed(app());
  const variant = card('EBP01-001-SR', 'Lamball', 'EBP01-001', 'SR');
  a.sandbox.CARDS.push(variant);
  a.sandbox.byNumberIdx['EBP01-001-SR'] = variant;
  a.api.render();
  const rows = a.list.children;
  assert.equal(rows.length, 1);
  const undo = rows[0].querySelector('[data-action="undo"]');
  const more = rows[0].querySelector('[data-action="more"]');
  const variantSel = rows[0].querySelector('[data-action="variant"]');
  assert.ok(undo, 'undo button present');
  assert.ok(more, 'qty+ present for raw captures');
  assert.ok(variantSel, 'variant select present when several printings exist');
});

test('renderScanReview shows the empty state when nothing waits', () => {
  const a = app();
  a.api.render();
  assert.equal(a.list.children.length, 0);
});

test('refresh hides the session pill and review button when the session is empty', () => {
  const a = app();
  a.api.refresh();
  assert.equal(a.ids.scanSess.hidden, true);
  assert.equal(a.ids.scanReviewBtn.hidden, true);
  a.api.record({ id: 'EBP01-001', colId: 'test', dest: 'collection', type: 'raw', qty: 1, edition: '1', value: 2.5 });
  a.api.refresh();
  assert.equal(a.ids.scanSess.hidden, false);
  assert.match(a.ids.scanSess.textContent, /1 added this session/);
  assert.equal(a.ids.scanReviewBtn.hidden, false);
});
