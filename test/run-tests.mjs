// 自测：构造若干「该过 / 该挂」的包，断言校验器的判定。
// 跑法：node test/run-tests.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { checkPackage } from '../src/check.mjs';
import { readZip } from '../src/zip.mjs';

/* ---------- 最小 zip 写入器（只为测试用，零依赖） ---------- */
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data || '');
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x800, 6); lfh.writeUInt16LE(8, 8); // UTF-8 flag, deflate
    lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(comp.length, 18); lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26); lfh.writeUInt16LE(0, 28);
    locals.push(lfh, name, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x800, 8); cdh.writeUInt16LE(8, 10);
    cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(comp.length, 20); cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(name.length, 28); cdh.writeUInt16LE(0, 30); cdh.writeUInt16LE(0, 32);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);
    offset += lfh.length + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/* ---------- fixtures ---------- */
const GOOD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>测试小工具</title>
  <link rel="stylesheet" href="./assets/style.css" />
</head>
<body>
  <canvas id="c"></canvas>
  <script src="./assets/app.js"></script>
</body>
</html>`;

const GOOD_JS = `const c = document.getElementById('c');
document.addEventListener('pointerdown', () => { c.style.opacity = '0.8'; });
const audio = new (window.AudioContext || window.webkitAudioContext)();
function beep() { const o = audio.createOscillator(); o.connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.1); }
beep();`;

const GOOD_CSS = `*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; height: 100vh; display: flex; }
.bottom { padding-bottom: env(safe-area-inset-bottom, 0px); width: 100%; }`;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

function baseFiles() {
  return [
    { path: 'index.html', size: GOOD_HTML.length, content: Buffer.from(GOOD_HTML) },
    { path: 'assets/', size: 0, dir: true, content: null },
    { path: 'assets/style.css', size: GOOD_CSS.length, content: Buffer.from(GOOD_CSS) },
    { path: 'assets/app.js', size: GOOD_JS.length, content: Buffer.from(GOOD_JS) },
    { path: 'assets/logo.png', size: PNG.length, content: PNG },
  ];
}

const withFile = (p, content, size) => [...baseFiles(), { path: p, size: size ?? Buffer.byteLength(content), content: Buffer.from(content) }];
const replace = (p, content) => baseFiles().map((f) => (f.path === p ? { ...f, size: Buffer.byteLength(content), content: Buffer.from(content) } : f));

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
const codes = (r, level) => r.findings.filter((f) => f.level === level).map((f) => f.code);

function expect(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

const run = (files, kind = 'dir') => checkPackage({ files, kind, target: 'fixture' });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-check-test-'));

console.log('\n[1] 合规包应当通过');
{
  const r = run(baseFiles());
  expect('全通过、无 error', r.ok && r.errors.length === 0, JSON.stringify(codes(r, 'error')));
}

console.log('\n[2] 结构类问题');
{
  const r = run([...baseFiles().map((f) => ({ ...f, path: 'dist/' + f.path })), { path: 'dist/', size: 0, dir: true, content: null }]);
  expect('多套一层 → ENTRY_NOT_AT_ROOT', codes(r, 'error').includes('ENTRY_NOT_AT_ROOT'));
  expect('并给出 cd 修复提示', /cd dist/.test(r.errors.map((e) => e.msg).join(' ')));
}
{
  const r = run(baseFiles().filter((f) => f.path !== 'index.html'));
  expect('缺入口 → ENTRY_MISSING', codes(r, 'error').includes('ENTRY_MISSING'));
}
{
  const r = run(withFile('other.html', '<html></html>'));
  expect('多余 html → MULTI_HTML', codes(r, 'error').includes('MULTI_HTML'));
}
{
  const r = run(withFile('node_modules/x/y.js', 'x', 10));
  expect('node_modules → JUNK_FILE', codes(r, 'error').includes('JUNK_FILE'));
}
{
  const r = run(withFile('assets/app.js.map', '{}'));
  expect('.map → JUNK_FILE', codes(r, 'error').includes('JUNK_FILE'));
}
{
  const r = run(withFile('data.txt', 'hello'));
  expect('txt → FILE_TYPE', codes(r, 'error').includes('FILE_TYPE'));
}
{
  const r = run(withFile('assets/bgm.mp3', 'ID3xxxx'));
  expect('mp3 → AUDIO_TYPE（且提示 Web Audio）', codes(r, 'error').includes('AUDIO_TYPE'));
  expect('  └ 提示里有 Web Audio 合成建议', /Web Audio/.test(r.errors.map((e) => e.msg).join(' ')));
}

console.log('\n[3] HTML 规则');
{
  const r = run(replace('index.html', GOOD_HTML.replace('<script src="./assets/app.js"></script>', '<script>console.log(1)</script>')));
  expect('内联 script → 报错', codes(r, 'error').includes('HTML_RULE'));
}
{
  const r = run(replace('index.html', GOOD_HTML.replace('<canvas id="c">', '<button onclick="go()">go</button><canvas id="c">')));
  expect('行内 onclick → 报错', codes(r, 'error').includes('HTML_RULE'));
}
{
  const bad = GOOD_HTML.replace('href="./assets/style.css"', 'href="https://cdn.example.com/x.css"');
  const r = run(replace('index.html', bad));
  expect('外部样式表 → EXTERNAL_REF', codes(r, 'error').includes('EXTERNAL_REF'));
}
{
  const bad = GOOD_HTML.replace('src="./assets/app.js"', 'src="/assets/app.js"');
  const r = run(replace('index.html', bad));
  expect('绝对路径 → ABSOLUTE_PATH', codes(r, 'error').includes('ABSOLUTE_PATH'));
}
{
  const bad = GOOD_HTML.replace('<title>测试小工具</title>', '<title>t</title><base href="/x/">');
  const r = run(replace('index.html', bad));
  expect('<base> → 报错', codes(r, 'error').includes('HTML_RULE'));
}
{
  const r = run(replace('index.html', GOOD_HTML.replace('./assets/app.js', './assets/nothere.js')));
  expect('引用不存在的文件 → MISSING_ASSET', codes(r, 'error').includes('MISSING_ASSET'));
}

console.log('\n[4] JS / CSS 规则');
{
  const r = run(replace('assets/app.js', "fetch('/api/x').then(r => r.json());"));
  expect('fetch → 报错', codes(r, 'error').includes('JS_API'));
}
{
  const r = run(replace('assets/app.js', 'const t = new TextEncoder();\nconst w = new Worker("w.js");'));
  expect('new Worker → 报错', codes(r, 'error').includes('JS_API'));
}
{
  const r = run(replace('assets/style.css', 'body { background: url("https://cdn.example.com/a.png"); }'));
  expect('CSS 外链 → 报错', codes(r, 'error').includes('CSS_RULE'));
}
{
  const r = run(replace('assets/style.css', '.a { width: 375px; }'));
  expect('写死像素宽 → 只报 warn', codes(r, 'warn').includes('CSS_RULE') && !codes(r, 'error').includes('CSS_RULE'));
}

console.log('\n[5] 精度：不该误报的不能误报');
{
  const r = run(replace('assets/app.js', '// 注意：不要用 fetch()，容器不联网\n/* new Worker( 也不行 */\nconst a = 1;'));
  expect('注释里的 fetch/Worker 不报错', !codes(r, 'error').includes('JS_API'), JSON.stringify(codes(r, 'error')));
}
{
  const r = run(replace('assets/app.js', 'const hint = "别用 fetch()"; console.log(hint);'));
  expect('字符串文案里的 fetch 不报错', !codes(r, 'error').includes('JS_API'));
}
{
  const r = run(replace('assets/app.js', 'const url = "https://example.com/doc"; console.log(url);'));
  expect('字符串里的外部地址 → 只提示（warn）', codes(r, 'warn').includes('JS_URL') && !codes(r, 'error').includes('EXTERNAL_REF'));
}
{
  const r = run(baseFiles().map((f) => (f.path === 'assets/logo.png' ? { ...f, size: 900 * 1024 } : f)));
  expect('大图 → 只提示体积', codes(r, 'warn').includes('IMAGE_SIZE'));
}

console.log('\n[6] zip 模式（真的读 zip，不是读目录）');
{
  const zipPath = path.join(tmpDir, 'ok.zip');
  fs.writeFileSync(zipPath, makeZip([
    { name: 'index.html', data: GOOD_HTML },
    { name: 'assets/style.css', data: GOOD_CSS },
    { name: 'assets/app.js', data: GOOD_JS },
    { name: 'assets/logo.png', data: PNG },
  ]));
  const entries = readZip(fs.readFileSync(zipPath));
  const files = entries.map((e) => ({ path: e.name, size: e.size, dir: e.name.endsWith('/'), content: e.data }));
  expect('zip 条目读出来了（4 条）', entries.length === 4, String(entries.length));
  const r = run(files, 'zip');
  expect('合规 zip → 通过', r.ok, JSON.stringify(codes(r, 'error')));
}
{
  const zipPath = path.join(tmpDir, 'layered.zip');
  fs.writeFileSync(zipPath, makeZip([
    { name: 'dist/index.html', data: GOOD_HTML },
    { name: 'dist/assets/app.js', data: GOOD_JS },
  ]));
  const entries = readZip(fs.readFileSync(zipPath));
  const files = entries.map((e) => ({ path: e.name, size: e.size, dir: e.name.endsWith('/'), content: e.data }));
  const r = run(files, 'zip');
  expect('多套一层 zip → ENTENTRY_NOT_AT_ROOT', codes(r, 'error').includes('ENTRY_NOT_AT_ROOT'));
  expect('  └ 提示 cd dist && zip', /cd dist/.test(r.errors.map((e) => e.msg).join(' ')));
}

console.log('\n[7] 精度：打包产物与命名空间地址');
{
  const minified = 'function a(){return "' + 'x'.repeat(3000) + '"}fetch("/api")';
  const r = run(replace('assets/app.js', minified));
  expect('打包产物里的 fetch → 只提示（warn）不拦上传', codes(r, 'warn').includes('JS_API') && !codes(r, 'error').includes('JS_API'), JSON.stringify(codes(r, 'error')));
  expect('  └ 提示里带「打包产物／第三方库」说明', /打包产物/.test(r.warns.map((w) => w.msg).join(' ')));
}
{
  const r = run(replace('assets/app.js', 'const ns = "http://www.w3.org/1999/xhtml"; console.log(ns);'));
  expect('w3.org 命名空间 → 不报外部地址', !codes(r, 'warn').includes('JS_URL'), JSON.stringify(codes(r, 'warn')));
}
{
  const r = run(replace('assets/style.css', '.a { min-width: 116px; }'));
  expect('min-width 不算写死像素宽误报', !codes(r, 'warn').includes('CSS_RULE'));
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
