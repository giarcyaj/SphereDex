'use strict';

// Run with: node tools/test_rewards_statue.cjs
// The Rewards page: the effigies blurb describes SphereDex rather than the video game, and the Statue of
// Power is earned by sharing the app. The share trigger is the point of this suite: an unlock offered in
// return for a store review breaks App Store guideline 1.1.7 and Google Play's ratings policy, so the
// guards below are what stop a later edit from quietly pointing it at the store.
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

// The blurb under the effigies heading, whatever it currently says.
function effigyIntro() {
  const head = source.indexOf('>Pal Effigies');   // the heading, not the stylesheet comment above the tiles
  assert.ok(head > 0, 'the effigies heading is on the Rewards page');
  const open = source.indexOf('<p class="rwintro">', head);
  const close = source.indexOf('</p>', open);
  assert.ok(open > head && close > open, 'the heading is followed by its own intro paragraph');
  return source.slice(open + '<p class="rwintro">'.length, close);
}

test('the effigies blurb describes the app, not the video game', () => {
  const intro = effigyIntro();
  // What Craig flagged: every one of these is a Palworld game mechanic, none of them happen in SphereDex.
  for (const lore of ['in the wild', 'glowing in the wild', 'capture power', 'level 9', 'Statue of Power ·', 'feed a different stat']) {
    assert.doesNotMatch(intro, new RegExp(lore.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), 'no game lore: ' + lore);
  }
  // What it has to say instead: what an effigy is here, and that earning one is permanent.
  assert.match(intro, /milestone/i, 'it says what lights an effigy up');
  assert.match(intro, /stays lit|once earned|stays earned/i, 'and that it stays earned');
  assert.match(intro, /statue/i, 'and it mentions the statue, so the odd tile out is explained');
  // Craig's copy rule: no hyphens or dashes in anything a user reads.
  assert.doesNotMatch(intro, /[-‐-―]/, 'no hyphens or dashes');
});

test('the statue has its own drawn art, so there is no image file to bake or mirror', () => {
  assert.match(source, /\n\s{4}statue:'/, 'ICONS.statue exists');
  // effigyImg falls back to effigySVG when EFFIGY_FILE has no entry, and effigySVG falls back to
  // ICONS.effigy when the name is unknown: a missing ICONS.statue would silently draw the generic one.
  assert.doesNotMatch(source, /EFFIGY_FILE=\{[^}]*\bstatue\b/, 'and it is not expecting an image file');
});

test('the statue is earned by sharing the app and never by reviewing it', () => {
  const share = appFunction('shareSphereDex');
  assert.match(share, /navigator\.share/, 'it opens the device share sheet where there is one');
  assert.match(share, /copyPlainText/, 'and copies the link where there is not');
  assert.match(share, /spheredex\.app/, 'and the link is the app itself');
  // The guard that matters. Reviews cannot be the trigger.
  assert.doesNotMatch(share, /storeUrl|apps\.apple\.com|play\.google\.com/, 'the unlock never touches a store link');
  const badges = source.slice(source.indexOf('var badges=['), source.indexOf('host.innerHTML=badges'));
  const statue = badges.split('\n').filter((l) => /Statue of Power/.test(l)).join(' ');
  assert.ok(statue, 'the statue is one of the badges');
  assert.doesNotMatch(statue, /review|rating|rate/i, 'and its own wording asks for a share, not a review');
  assert.doesNotMatch(statue, /[-‐-―]/, 'no hyphens or dashes in the tile copy');
});

// ---- The grid itself, built from the real renderAchievements ------------------------------------
function renderGrid(opts) {
  opts = opts || {};
  const stored = {};
  if (opts.shared) stored['palvault-shared'] = '1';
  const grid = { innerHTML: '', querySelector: (sel) => (grid.innerHTML.indexOf(sel.slice(1, -1)) >= 0 ? { onclick: null } : null) };
  const cap = { innerHTML: '' };
  const box = {
    CARDS: [{ id: 'A1' }, { id: 'A2' }],
    TOTAL: 2,
    SEALED: [],
    SET_SPHERE_TRACKS: [{ id: 'S1' }],
    has: (e) => !!e && e.qty > 0,
    o: () => ({}),
    sealItem: () => ({}),
    decks: () => [],
    activeCol: () => ({ setSpheres: {}, own: {} }),
    wishCount: () => 0,
    lsGet: (k) => (Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : null),
    lsSet: (k, v) => { stored[k] = String(v); },
    effigyImg: (n) => '<i data-art="' + n + '"></i>',
    icon: () => '<svg class="tick"></svg>',
    esc: (t) => String(t),
    storeUrl: () => opts.store || '',
    isIosApp: () => opts.ios === true,
    toast: (m) => { box._toast = m; },
    copyPlainText: (text, msg) => { box._copied = text; box._toast = msg; },
    navigator: opts.canShare ? { share: () => ({ then: () => {} }) } : {},
    $: (id) => (id === 'achievementGrid' ? grid : id === 'rateCap' ? cap : null),
    Math,
    Object,
  };
  vm.createContext(box);
  vm.runInContext(['statueShared', 'shareSphereDex', 'renderAchievements'].map(appFunction).join('\n'), box);
  box.renderAchievements();
  return { grid, cap, box, stored };
}

test('the statue tile is a button, is unearned until the app is shared, and stays earned after', () => {
  const cold = renderGrid();
  // Fourteen tiles: the statue first, because it is the only one a brand new collection can earn today.
  assert.equal((cold.grid.innerHTML.match(/class="achievement/g) || []).length, 14);
  assert.ok(cold.grid.innerHTML.indexOf('Statue of Power') < cold.grid.innerHTML.indexOf('Lifmunk'), 'statue first');
  // Only the statue is actionable, so only the statue is a button.
  assert.equal((cold.grid.innerHTML.match(/<button/g) || []).length, 1);
  assert.equal((cold.grid.innerHTML.match(/<\/button>/g) || []).length, 1, 'and it is closed as a button');
  assert.equal((cold.grid.innerHTML.match(/data-act="share"/g) || []).length, 1);
  assert.match(cold.grid.innerHTML, /achaction/, 'it carries the class that makes it look like a tile');
  assert.match(cold.grid.innerHTML, /Share SphereDex with someone/, 'and it says what to do');
  assert.doesNotMatch(cold.grid.innerHTML, /Statue of Power[\s\S]{0,180}earned"/, 'not earned yet');

  const warm = renderGrid({ shared: true });
  assert.match(warm.grid.innerHTML, /<button type="button" class="achievement achaction earned"/, 'earned once shared');
  assert.match(warm.grid.innerHTML, /Thank you for sharing SphereDex/);
  // Still fourteen: earning it does not add or remove a tile.
  assert.equal((warm.grid.innerHTML.match(/class="achievement/g) || []).length, 14);
});

test('sharing earns the statue on both paths, and earns it only once', () => {
  const sheet = renderGrid({ canShare: true });
  sheet.box.shareSphereDex();
  assert.equal(sheet.stored['palvault-shared'], '1', 'the share sheet path earns it');
  assert.match(sheet.box._toast, /Statue of Power earned/);
  sheet.box._toast = '';
  sheet.box.shareSphereDex();
  assert.doesNotMatch(sheet.box._toast || '', /earned/, 'and a second share does not announce it again');

  const copy = renderGrid();
  copy.box.shareSphereDex();
  assert.equal(copy.stored['palvault-shared'], '1', 'the clipboard path earns it too');
  assert.match(copy.box._copied, /spheredex\.app/, 'and it copies the app link');
});

test('the rating ask lives apart from the statue, and only where there is a store to rate in', () => {
  assert.equal(renderGrid().cap.innerHTML, '', 'the web app has no store, so it says nothing');
  const ios = renderGrid({ store: 'https://apps.apple.com/app/id6804377686', ios: true }).cap.innerHTML;
  assert.match(ios, /App Store/);
  assert.match(ios, /apps\.apple\.com/);
  assert.match(renderGrid({ store: 'https://play.google.com/store/apps/details?id=app.spheredex' }).cap.innerHTML, /Play Store/);
  // It must not read as a trade. No reward, no unlock, no statue in the same breath.
  assert.doesNotMatch(ios, /statue|unlock|reward|earn/i, 'the ask offers nothing in return');
  assert.doesNotMatch(ios.replace(/<[^>]*>/g, ''), /[-‐-―]/, 'no hyphens or dashes');
});
