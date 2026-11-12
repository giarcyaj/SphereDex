'use strict';

// Run with: node tools/test_scan_pixels.cjs
// The photo-scan index draws bundled card art and calls getImageData. On a file:// document
// (the Android asset shell) that image taints the canvas. These tests run the real loadImg /
// describeElement / buildIndex from src/paldeck.html against that decision, and, when Chrome is
// installed, repeat it in a browser: the old img.src path throws the reported SecurityError, and
// the blob path returns the real pixel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vm = require('node:vm');
const { test } = require('node:test');

const REPO = path.join(__dirname, '..');
const FILES = {
  src: path.join(REPO, 'src', 'paldeck.html'),
  web: path.join(REPO, 'docs', 'app', 'index.html'),
  android: path.join(REPO, 'app', 'src', 'main', 'assets', 'spheredex.html'),
  ios: path.join(REPO, 'ios', 'SphereDex', 'SphereDex', 'Resources', 'spheredex.html'),
};
const KOTLIN = path.join(REPO, 'app', 'src', 'main', 'java', 'app', 'spheredex', 'MainActivity.kt');
// 8x4 solid PNG, RGB 12,34,56. Generated in the browser repro; kept here so the pixel is exact.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEUlEQVR4nGPgUbLAihioJwEAeIIMwQ1YvqoAAAAASUVORK5CYII=';
const PIXEL = [12, 34, 56, 255];

function sourceOf(file) {
  return fs.readFileSync(file, 'utf8');
}

function extractFunction(source, name) {
  const token = 'function ' + name + '(';
  const start = source.indexOf(token);
  assert.ok(start >= 0, name + ' is defined');
  assert.equal(source.indexOf(token, start + token.length), -1, name + ' is defined once');
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let esc = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced ' + name);
}

function bundledImageAsset(p) {
  // Mirrors MainActivity.bundledImageAsset. The Kotlin source test below locks the same rules.
  const clean = String(p == null ? '' : p).trim();
  if (!clean.startsWith('img/')) return '';
  const file = clean.slice(4);
  if (!file || file.includes('/') || file.includes('\\') || file.includes('..')) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(file)) return '';
  const ext = file.split('.').pop().toLowerCase();
  if (ext !== 'jpg' && ext !== 'jpeg' && ext !== 'png' && ext !== 'webp' && ext !== 'gif') return '';
  return 'img/' + file;
}

function boot(opts) {
  const images = [];
  const location = Object.assign({
    protocol: 'file:',
    href: 'file:///android_asset/spheredex.html',
    origin: 'file://',
  }, opts.location || {});
  function Image() {
    images.push(this);
    this.crossOrigin = null;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.width = 0;
    this.height = 0;
    this.tainted = false;
    this.color = PIXEL.slice();
  }
  Object.defineProperty(Image.prototype, 'src', {
    set(v) {
      this._src = String(v);
      if (this.crossOrigin === 'anonymous' && (location.protocol === 'file:' || this._src.startsWith('file:'))) {
        if (this.onerror) this.onerror();
        return;
      }
      if (this._src.startsWith('blob:') || this._src.startsWith('data:')) {
        this.naturalWidth = 8; this.naturalHeight = 4; this.width = 8; this.height = 4;
        this.tainted = false;
        if (this.onload) this.onload();
        return;
      }
      if (location.protocol === 'file:' || this._src.startsWith('file:')) {
        this.naturalWidth = 8; this.naturalHeight = 4; this.width = 8; this.height = 4;
        this.tainted = true;
        if (this.onload) this.onload();
        return;
      }
      if (String(this._src).indexOf('missing') >= 0) {
        if (this.onerror) this.onerror();
        return;
      }
      let origin = '';
      try { origin = new URL(this._src, location.href).origin; } catch (e) { origin = 'other'; }
      this.tainted = origin !== location.origin;
      this.naturalWidth = 8; this.naturalHeight = 4; this.width = 8; this.height = 4;
      if (this.onload) this.onload();
    },
    get() { return this._src; },
  });
  const reads = [];
  const bridge = opts.bridge === undefined ? function (p) {
    reads.push(p);
    return bundledImageAsset(p) === 'img/ok.jpg' ? PNG_B64 : '';
  } : opts.bridge;
  let blobs = 0;
  const URLImpl = function URLImpl(u, base) { return new URL(u, base); };
  URLImpl.createObjectURL = function () { blobs++; return 'blob:mock-' + blobs; };
  URLImpl.revokeObjectURL = function () {};
  const sandbox = {
    location: location,
    window: { AndroidAssets: bridge ? { read: bridge } : undefined },
    URL: URLImpl,
    atob: atob,
    Blob: Blob,
    Uint8Array: Uint8Array,
    Uint8ClampedArray: Uint8ClampedArray,
    Float32Array: Float32Array,
    Promise: Promise,
    Image: Image,
    document: {
      createElement: function () {
        const canvas = { width: 0, height: 0 };
        canvas.getContext = function () {
          const ctx = {
            drawImage: function (img) { ctx.img = img; },
            getImageData: function () {
              if (opts.forceTaint || (ctx.img && ctx.img.tainted)) {
                const e = new Error("Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.");
                e.name = 'SecurityError';
                throw e;
              }
              if (opts.explode) throw new TypeError('boom');
              const data = new Uint8ClampedArray(Math.max(1, canvas.width) * Math.max(1, canvas.height) * 4);
              const c = (ctx.img && ctx.img.color) || [0, 0, 0, 0];
              for (let i = 0; i < data.length; i += 4) {
                data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3];
              }
              return { data: data };
            },
          };
          return ctx;
        };
        return canvas;
      },
    },
    fetch: opts.fetch || function () { return Promise.reject(new TypeError('Failed to fetch')); },
    CARDS: opts.cards || [
      { id: 'OK', base: 'OK', pic: 'img/ok.jpg' },
      { id: 'MISS', base: 'MISS', pic: 'img/miss.jpg' },
      { id: 'REMOTE', base: 'REMOTE', pic: 'https://en.palworld-official-cardgame.com/wordpress/wp-content/images/cardlist/X.png' },
      { id: 'DATA', base: 'DATA', pic: 'data:image/png;base64,AAAA' },
    ],
    imgSrc: function (c) { return c.pic; },
    indexKey: function () { return 'test-key'; },
    yieldTick: function () { return Promise.resolve(); },
    MULTI_SCAN: {
      DESC: 3,
      describe: opts.describe || function (data) { return new Float32Array([data[0], data[1], data[2]]); },
    },
    console: console,
  };
  const src = sourceOf(FILES.src);
  const script = ['localArt', 'cardsForIndex', 'loadImg', 'describeElement', 'buildIndex']
    .map(function (name) { return extractFunction(src, name); })
    .join('\n');
  vm.runInContext(script + '\nthis.api={localArt:localArt,cardsForIndex:cardsForIndex,loadImg:loadImg,describeElement:describeElement,buildIndex:buildIndex};', vm.createContext(sandbox));
  sandbox.images = images;
  sandbox.reads = reads;
  return sandbox;
}

test('bundled art names stay inside the asset allowlist', () => {
  const kt = sourceOf(KOTLIN);
  assert.match(kt, /addJavascriptInterface\(AssetBridge\(\), "AndroidAssets"\)/);
  assert.match(kt, /fun bundledImageAsset/);
  assert.match(kt, /clean\.startsWith\("img\/"\)/);
  assert.match(kt, /contains\("\.\."\)/);
  assert.match(kt, /Regex\("\^\[A-Za-z0-9\._-\]\+\$"\)/);
  assert.match(kt, /bytes\.size > 2 \* 1024 \* 1024/);
  assert.doesNotMatch(kt, /allowFileAccessFromFileURLs\s*=\s*true/);
  assert.equal(bundledImageAsset('img/EBP01-001.jpg'), 'img/EBP01-001.jpg');
  assert.equal(bundledImageAsset('img/BOX_BANNER_BP02.webp'), 'img/BOX_BANNER_BP02.webp');
  assert.equal(bundledImageAsset(' img/ok.png '), 'img/ok.png');
  assert.equal(bundledImageAsset('../secret.jpg'), '');
  assert.equal(bundledImageAsset('img/../../etc/passwd'), '');
  assert.equal(bundledImageAsset('/android_asset/img/ok.jpg'), '');
  assert.equal(bundledImageAsset('https://spheredex.app/app/img/ok.jpg'), '');
  assert.equal(bundledImageAsset('img/ok.svg'), '');
  assert.equal(bundledImageAsset('img/a b.jpg'), '');
  const names = fs.readdirSync(path.join(REPO, 'docs', 'app', 'img'));
  names.forEach(function (n) { assert.equal(bundledImageAsset('img/' + n), 'img/' + n, n); });
});

test('loadImg source does not use crossOrigin, and remote art stays out of the index', () => {
  const src = sourceOf(FILES.src);
  const load = extractFunction(src, 'loadImg');
  const local = extractFunction(src, 'localArt');
  assert.equal(load.includes('crossOrigin'), false);
  assert.match(load, /AndroidAssets/);
  assert.match(load, /createObjectURL/);
  assert.match(local, /https\?:/);
  const ctx = boot({});
  assert.equal(ctx.api.localArt({ pic: 'img/ok.jpg' }), 'img/ok.jpg');
  assert.equal(ctx.api.localArt({ pic: 'https://en.palworld-official-cardgame.com/a.png' }), '');
  assert.equal(ctx.api.localArt({ pic: 'data:image/png;base64,AAAA' }), '');
  assert.equal(ctx.api.localArt({ pic: '' }), '');
});

test('file art is read as a blob and a missing asset does not taint or reject the index', async () => {
  const ctx = boot({});
  const img = await ctx.api.loadImg('img/ok.jpg');
  assert.ok(img);
  assert.equal(img._src.startsWith('blob:'), true);
  assert.equal(img.crossOrigin, null);
  assert.equal(img.tainted, false);
  assert.deepEqual(ctx.reads, ['img/ok.jpg']);
  const desc = ctx.api.describeElement(img);
  assert.deepEqual(Array.from(desc), PIXEL.slice(0, 3));
  const again = await ctx.api.loadImg('img/ok.jpg');
  assert.deepEqual(Array.from(ctx.api.describeElement(again)), PIXEL.slice(0, 3));
  const missed = await ctx.api.loadImg('img/miss.jpg');
  assert.equal(missed, null);
  const sneaky = await ctx.api.loadImg('../secret.jpg');
  assert.equal(sneaky, null);
  assert.ok(ctx.images.every(function (im) { return im._src.startsWith('blob:'); }));
  const idx = await ctx.api.buildIndex();
  assert.deepEqual(Array.from(idx.ids), ['OK']);
  assert.equal(idx.ids.includes('REMOTE'), false);
  assert.equal(idx.ids.includes('DATA'), false);
  assert.equal(idx.ids.includes('MISS'), false);
});

test('file page with no asset bridge skips the picture instead of drawing it', async () => {
  const ctx = boot({ bridge: null });
  const img = await ctx.api.loadImg('img/ok.jpg');
  assert.equal(img, null);
  assert.equal(ctx.images.length, 0);
});

test('a bridge that throws or returns junk does not reject the index build', async () => {
  const bad = boot({ bridge: function () { throw new Error('bridge'); } });
  assert.equal(await bad.api.loadImg('img/ok.jpg'), null);
  const junk = boot({ bridge: function () { return 'not base64 !!!'; } });
  assert.equal(await junk.api.loadImg('img/ok.jpg'), null);
  const idx = await junk.api.buildIndex();
  assert.deepEqual(Array.from(idx.ids), []);
});

test('https same-origin fetch becomes a blob; a CORS failure is not drawn', async () => {
  const png = Buffer.from(PNG_B64, 'base64');
  const ok = boot({
    location: { protocol: 'https:', href: 'https://spheredex.app/app/index.html', origin: 'https://spheredex.app' },
    fetch: function (url) {
      const u = String(url);
      if (u.indexOf('https://en.palworld-official-cardgame.com/') === 0) return Promise.reject(new TypeError('Failed to fetch'));
      if (u === 'img/offline.jpg') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({
        ok: true,
        blob: function () { return Promise.resolve(new Blob([png], { type: 'image/png' })); },
      });
    },
  });
  const img = await ok.api.loadImg('img/ok.jpg');
  assert.equal(img._src.startsWith('blob:'), true);
  assert.equal(img.crossOrigin, null);
  assert.deepEqual(Array.from(ok.api.describeElement(img)), PIXEL.slice(0, 3));
  const remote = await ok.api.loadImg('https://en.palworld-official-cardgame.com/wordpress/wp-content/images/cardlist/X.png');
  assert.equal(remote, null);
  assert.ok(ok.images.every(function (im) { return String(im._src).startsWith('blob:'); }));
  const fallback = await ok.api.loadImg('img/offline.jpg');
  assert.ok(fallback);
  assert.equal(fallback._src, 'img/offline.jpg');
  assert.equal(fallback.tainted, false);
  assert.equal(fallback.crossOrigin, null);
});

test('a tainted canvas skips that card, and any other error still rejects the build', async () => {
  const tainted = boot({ forceTaint: true });
  const img = await tainted.api.loadImg('img/ok.jpg');
  assert.equal(tainted.api.describeElement(img), null);
  const idx = await tainted.api.buildIndex();
  assert.deepEqual(Array.from(idx.ids), []);
  const exploded = boot({
    describe: function () { throw new TypeError('boom'); },
  });
  await assert.rejects(exploded.api.buildIndex(), { name: 'TypeError', message: 'boom' });
});

test('iOS scheme still falls back to an image element when fetch fails', async () => {
  const ctx = boot({
    location: { protocol: 'spheredex:', href: 'spheredex://app/spheredex.html', origin: 'null' },
  });
  const img = await ctx.api.loadImg('img/ok.jpg');
  assert.ok(img);
  assert.equal(img._src, 'img/ok.jpg');
  assert.equal(img.crossOrigin, null);
  assert.equal(img.tainted, false);
});

test('the four shipped copies carry the same pixel-read functions', () => {
  const names = ['loadImg', 'describeElement'];
  const expected = names.map(function (n) { return extractFunction(sourceOf(FILES.src), n); });
  Object.entries(FILES).forEach(function (entry) {
    const text = sourceOf(entry[1]);
    names.forEach(function (n, i) {
      assert.equal(extractFunction(text, n), expected[i], entry[0] + ' ' + n);
    });
  });
  const src = sourceOf(FILES.src);
  assert.match(src, /function decodeViaImage\(file\)\{[\s\S]*?URL\.createObjectURL\(file\)/);
});

function findChrome() {
  // The /usr/local/bin wrapper pins one debugging port, so a second run never dumps.
  // Prefer the browser binary itself.
  const list = [
    process.env.SCAN_PIXEL_CHROME,
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return list.find(function (p) { return fs.existsSync(p); }) || '';
}

function readReport(stdout) {
  const m = String(stdout || '').match(/<pre id="out">([\s\S]*?)<\/pre>/);
  if (!m) return null;
  const text = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  try { return JSON.parse(text); }
  catch (e) { return null; }
}

function dumpDom(chrome, url) {
  // Async on purpose: a same-process HTTP server cannot answer while the event loop is blocked.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-px-chrome-'));
  const outFile = path.join(dir, 'dom.html');
  const fd = fs.openSync(outFile, 'w');
  return new Promise(function (resolve, reject) {
    const child = spawn(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--user-data-dir=' + path.join(dir, 'profile'),
      '--remote-debugging-port=0',
      '--virtual-time-budget=4000',
      '--dump-dom', url,
    ], { stdio: ['ignore', fd, 'pipe'] });
    let stderr = '';
    let done = false;
    const killer = setTimeout(function () { finish(new Error('browser timed out')); }, 20000);
    function finish(err, report) {
      if (done) return;
      done = true;
      clearTimeout(killer);
      clearInterval(timer);
      try { child.kill('SIGKILL'); } catch (e) {}
      try { fs.closeSync(fd); } catch (e) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
      if (err) reject(err);
      else resolve(report);
    }
    const timer = setInterval(function () {
      let stdout = '';
      try { stdout = fs.readFileSync(outFile, 'utf8'); } catch (e) { return; }
      const report = readReport(stdout);
      if (report) finish(null, report);
    }, 150);
    child.stderr.on('data', function (b) { stderr += b.toString(); });
    child.on('close', function () {
      let stdout = '';
      try { stdout = fs.readFileSync(outFile, 'utf8'); } catch (e) {}
      const report = readReport(stdout);
      if (report) { finish(null, report); return; }
      const err = stderr.split('\n').filter(function (ln) {
        return ln && ln.indexOf('dbus') < 0 && ln.indexOf('TensorFlow') < 0 && ln.indexOf('channel stable') < 0;
      }).slice(-12).join('\n');
      finish(new Error('browser page did not report\nSTDOUT:\n' + stdout.slice(0, 800) + '\nSTDERR:\n' + err));
    });
  });
}

function listen(handler) {
  return new Promise(function (resolve) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', function () { resolve(server); });
  });
}

test('browser: file image taints, blob read returns the pixel, CORS failure is not drawn', { skip: !findChrome(), timeout: 90000 }, async () => {
  const chrome = findChrome();
  const src = sourceOf(FILES.src);
  const fns = ['loadImg', 'describeElement'].map(function (n) { return extractFunction(src, n); }).join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-px-'));
  fs.mkdirSync(path.join(dir, 'img'));
  fs.writeFileSync(path.join(dir, 'img', 'pixel.png'), Buffer.from(PNG_B64, 'base64'));
  const fileHtml = '<!doctype html><meta charset="utf-8"><pre id="out">pending</pre><script>\n'
    + 'const B64=' + JSON.stringify(PNG_B64) + ';\n'
    + 'window.AndroidAssets={read:function(p){return p==="img/pixel.png"?B64:"";}};\n'
    + 'var MULTI_SCAN={describe:function(data){return {r:data[0],g:data[1],b:data[2],a:data[3]};}};\n'
    + fns + '\n'
    + '(async function(){\n'
    + '  const out={};\n'
    + '  try {\n'
    + '  const raw=new Image();\n'
    + '  await new Promise(function(res){raw.onload=raw.onerror=res; raw.src="img/pixel.png";});\n'
    + '  try {\n'
    + '    const c=document.createElement("canvas"); c.width=raw.naturalWidth; c.height=raw.naturalHeight;\n'
    + '    const g=c.getContext("2d"); g.drawImage(raw,0,0); g.getImageData(0,0,1,1);\n'
    + '    out.baseline={ok:true, loaded:raw.complete&&raw.naturalWidth>0};\n'
    + '  } catch(e) { out.baseline={ok:false, loaded:raw.naturalWidth>0, name:e.name, message:String(e.message||e)}; }\n'
    + '  const cors=new Image();\n'
    + '  await new Promise(function(res){cors.onload=cors.onerror=res; cors.crossOrigin="anonymous"; cors.src="img/pixel.png";});\n'
    + '  out.crossOriginAnonymous={loaded:cors.naturalWidth>0};\n'
    + '  try { await fetch("img/pixel.png"); out.fileFetch={ok:true}; }\n'
    + '  catch(e){ out.fileFetch={ok:false, name:e.name}; }\n'
    + '  const img=await loadImg("img/pixel.png");\n'
    + '  out.fixed={src:(img&&img.src)||"", cross:img?img.crossOrigin:null, desc:img?describeElement(img):null};\n'
    + '  const again=await loadImg("img/pixel.png");\n'
    + '  out.again=again?describeElement(again):null;\n'
    + '  out.missing=await loadImg("img/nope.png");\n'
    + '  out.traversal=await loadImg("../secret.jpg");\n'
    + '  const bytes=Uint8Array.from(atob(B64), function(ch){return ch.charCodeAt(0)&255;});\n'
    + '  const shot=await loadImg(URL.createObjectURL(new File([bytes], "shot.png", {type:"image/png"})));\n'
    + '  out.camera=shot?describeElement(shot):null;\n'
    + '  document.getElementById("out").textContent=JSON.stringify(out);\n'
    + '  } catch(e) { document.getElementById("out").textContent=JSON.stringify({pageError:String(e && e.stack || e)}); }\n'
    + '})();\n</script>';
  fs.writeFileSync(path.join(dir, 'file.html'), fileHtml);
  const fileReport = await dumpDom(chrome, 'file://' + path.join(dir, 'file.html'));
  assert.equal(fileReport.baseline.loaded, true);
  assert.equal(fileReport.baseline.ok, false);
  assert.equal(fileReport.baseline.name, 'SecurityError');
  assert.match(fileReport.baseline.message, /The canvas has been tainted by cross-origin data/);
  assert.equal(fileReport.crossOriginAnonymous.loaded, false);
  assert.equal(fileReport.fileFetch.ok, false);
  assert.equal(fileReport.fixed.src.startsWith('blob:'), true);
  assert.equal(fileReport.fixed.cross, null);
  assert.deepEqual([fileReport.fixed.desc.r, fileReport.fixed.desc.g, fileReport.fixed.desc.b, fileReport.fixed.desc.a], PIXEL);
  assert.deepEqual([fileReport.again.r, fileReport.again.g, fileReport.again.b, fileReport.again.a], PIXEL);
  assert.equal(fileReport.missing, null);
  assert.equal(fileReport.traversal, null);
  assert.deepEqual([fileReport.camera.r, fileReport.camera.g, fileReport.camera.b, fileReport.camera.a], PIXEL);

  const png = Buffer.from(PNG_B64, 'base64');
  let port2 = 0;
  const handler = function (req, res) {
    const p = req.url.split('?')[0];
    if (p === '/pixel.png' || p === '/cors-pixel.png') {
      if (p === '/cors-pixel.png') res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.end(png);
      return;
    }
    if (p === '/redir-pixel.png') {
      res.writeHead(302, { Location: 'http://127.0.0.1:' + port2 + '/pixel.png' });
      res.end();
      return;
    }
    if (p === '/page.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(httpHtml);
      return;
    }
    res.writeHead(404); res.end('no');
  };
  const s1 = await listen(handler);
  const s2 = await listen(handler);
  const port1 = s1.address().port;
  port2 = s2.address().port;
  const httpHtml = '<!doctype html><meta charset="utf-8"><pre id="out">pending</pre><script>\n'
    + 'var MULTI_SCAN={describe:function(data){return {r:data[0],g:data[1],b:data[2],a:data[3]};}};\n'
    + fns + '\n'
    + '(async function(){\n'
    + '  const out={};\n'
    + '  try {\n'
    + '  const same=await loadImg(location.origin+"/pixel.png");\n'
    + '  out.same={src:(same&&same.src)||"", cross:same?same.crossOrigin:null, desc:same?describeElement(same):null};\n'
    + '  const same2=await loadImg(location.origin+"/pixel.png");\n'
    + '  out.sameAgain=same2?describeElement(same2):null;\n'
    + '  out.cross=await loadImg("http://127.0.0.1:' + port2 + '/pixel.png");\n'
    + '  const cors=await loadImg("http://127.0.0.1:' + port2 + '/cors-pixel.png");\n'
    + '  out.cors={src:(cors&&cors.src)||"", cross:cors?cors.crossOrigin:null, desc:cors?describeElement(cors):null};\n'
    + '  const redir=await loadImg(location.origin+"/redir-pixel.png");\n'
    + '  let redirDesc=null, redirThrew=false;\n'
    + '  try { redirDesc=redir?describeElement(redir):null; } catch(e) { redirThrew=true; }\n'
    + '  out.redir={hasImage:!!redir, desc:redirDesc, threw:redirThrew};\n'
    + '  document.getElementById("out").textContent=JSON.stringify(out);\n'
    + '  } catch(e) { document.getElementById("out").textContent=JSON.stringify({pageError:String(e && e.stack || e)}); }\n'
    + '})();\n</script>';
  try {
    const httpReport = await dumpDom(chrome, 'http://127.0.0.1:' + port1 + '/page.html');
    assert.equal(httpReport.same.src.startsWith('blob:'), true);
    assert.equal(httpReport.same.cross, null);
    assert.deepEqual([httpReport.same.desc.r, httpReport.same.desc.g, httpReport.same.desc.b, httpReport.same.desc.a], PIXEL);
    assert.deepEqual([httpReport.sameAgain.r, httpReport.sameAgain.g, httpReport.sameAgain.b, httpReport.sameAgain.a], PIXEL);
    assert.equal(httpReport.cross, null);
    assert.equal(httpReport.cors.src.startsWith('blob:'), true);
    assert.equal(httpReport.cors.cross, null);
    assert.deepEqual([httpReport.cors.desc.r, httpReport.cors.desc.g, httpReport.cors.desc.b, httpReport.cors.desc.a], PIXEL);
    assert.equal(httpReport.redir.threw, false);
    assert.equal(httpReport.redir.desc, null);
  } finally {
    if (s1.closeAllConnections) s1.closeAllConnections();
    if (s2.closeAllConnections) s2.closeAllConnections();
    s1.close();
    s2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
