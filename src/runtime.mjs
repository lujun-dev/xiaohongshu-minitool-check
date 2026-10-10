// 可选的运行时检查：起本地 http 服务，用无头浏览器真的把包打开一次。
// 为什么需要它：静态 grep 查不出「运行时才拼出来的外链」——AI 生成的页面常把字体/贴图 URL 在运行期塞进 head。
// playwright-core 是可选依赖：装了就做，没装就跳过并说明原因，不报错。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', woff: 'font/woff', woff2: 'font/woff2',
};

function resolvePlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  if (process.env.XHS_CHECK_PLAYWRIGHT) candidates.push(process.env.XHS_CHECK_PLAYWRIGHT);
  candidates.push('playwright-core', 'playwright');
  try {
    const { execSync } = require('node:child_process');
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(path.join(root, '@playwright/mcp/node_modules/playwright-core'));
    candidates.push(path.join(root, 'playwright-core'));
  } catch { /* npm 不在 PATH 就跳过 */ }
  for (const c of candidates) {
    try { return require(c); } catch { /* 下一个 */ }
  }
  return null;
}

function extractToTemp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-check-'));
  for (const f of files) {
    const rel = f.path.replace(/^[/\\]+/, '').split('/').filter((s) => s && s !== '.' && s !== '..').join(path.sep);
    if (!rel) continue;
    const abs = path.join(dir, rel);
    if (!abs.startsWith(dir)) continue; // 防 zip-slip
    if (f.dir) { fs.mkdirSync(abs, { recursive: true }); continue; }
    if (!f.content) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
  }
  return dir;
}

export async function probeRuntime({ target, kind, files }) {
  const pw = resolvePlaywright();
  if (!pw) {
    return {
      available: false,
      error: '没找到 playwright-core。装一个再试：npm i -D playwright-core（或全局 npm i -g playwright），也可以用 XHS_CHECK_PLAYWRIGHT 指向已有的 playwright-core 目录',
    };
  }

  let root = target;
  let tmp = null;
  if (kind === 'zip') { tmp = extractToTemp(files); root = tmp; }

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const abs = path.join(root, rel);
    if (!abs.startsWith(root) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const ext = path.extname(abs).slice(1).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(abs));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const findings = [];
  const summary = [];
  let browser = null;
  try {
    const launchOpts = [{ channel: 'chrome' }, {}];
    let lastErr = null;
    for (const opt of launchOpts) {
      try { browser = await pw.chromium.launch({ ...opt, headless: true }); lastErr = null; break; }
      catch (e) { lastErr = e; }
    }
    if (!browser) throw lastErr || new Error('无法启动浏览器');

    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const consoleErrors = [];
    const pageErrors = [];
    const externalRequests = [];
    const badResponses = [];
    let favicon404 = 0;
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
    page.on('response', (r) => {
      const u = r.url();
      if (r.status() < 400) return;
      if (/\/favicon\.ico(\?|$)/.test(u)) { favicon404++; return; } // 每个包都会有的噪声，不算问题
      badResponses.push(`${r.status()} ${u}`);
    });
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) externalRequests.push(u);
    });

    await page.goto(`${origin}/index.html`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(1200);

    const probe = await page.evaluate(async () => {
      const ext = performance.getEntriesByType('resource').map((e) => e.name)
        .filter((n) => !n.startsWith(location.origin));
      let frames = 0;
      await new Promise((resolve) => {
        const t0 = performance.now();
        const tick = () => { frames++; (performance.now() - t0 < 500) ? requestAnimationFrame(tick) : resolve(); };
        requestAnimationFrame(tick);
      });
      const c = document.createElement('canvas');
      return {
        hidden: document.hidden,
        resources: ext,
        resourceCount: performance.getEntriesByType('resource').length,
        frames,
        bodyText: (document.body ? document.body.innerText : '').slice(0, 200),
        hasCanvas: !!document.querySelector('canvas'),
        webgl: !!(c.getContext('webgl2') || c.getContext('webgl')),
      };
    });

    const meaningfulConsole = consoleErrors.filter((t) => !/Failed to load resource/i.test(t));
    summary.push(`页面加载：${pageErrors.length ? '有 JS 异常' : '无 JS 异常'}；控制台报错 ${meaningfulConsole.length} 条${favicon404 ? `（另有 ${favicon404} 条 favicon 404，已忽略）` : ''}`);
    summary.push(`资源表：${probe.resourceCount} 个请求，其中外部地址 ${probe.resources.length} 个`);
    summary.push(`渲染：500ms 内 rAF 跑了 ${probe.frames} 帧${probe.frames === 0 ? '（0 帧：页面不可见时 rAF 不跑，这是假阴性，不是渲染失败）' : ''}`);
    if (probe.hasCanvas) summary.push(`Canvas：存在；WebGL 可用 = ${probe.webgl ? '是' : '否'}`);

    for (const b of badResponses.slice(0, 5)) {
      findings.push({ level: 'warn', code: 'RUNTIME_HTTP_ERROR', msg: `本地请求返回错误：${b}（说明有文件引用了不存在的路径）`, where: '运行时' });
    }
    if (externalRequests.length) {
      findings.push({
        level: 'error', code: 'RUNTIME_EXTERNAL_REQUEST',
        msg: `运行时真的发出了 ${externalRequests.length} 个外部请求（静态扫描看不出来的那种）：${externalRequests.slice(0, 3).join(' , ')}`,
        where: '运行时',
      });
    }
    if (probe.resources.length) {
      findings.push({
        level: 'error', code: 'RUNTIME_EXTERNAL_RESOURCE',
        msg: `运行时资源表里有 ${probe.resources.length} 个非本地资源：${probe.resources.slice(0, 3).join(' , ')}`,
        where: '运行时',
      });
    }
    for (const e of pageErrors.slice(0, 5)) {
      findings.push({ level: 'warn', code: 'RUNTIME_PAGE_ERROR', msg: `页面抛异常：${e}`, where: '运行时' });
    }
    for (const e of consoleErrors.filter((t) => !/Failed to load resource/i.test(t)).slice(0, 5)) {
      findings.push({ level: 'warn', code: 'RUNTIME_CONSOLE_ERROR', msg: `控制台报错：${e}`, where: '运行时' });
    }
    if (probe.hidden) {
      findings.push({
        level: 'warn', code: 'RUNTIME_PAGE_HIDDEN',
        msg: '页面处于后台隐藏状态（document.hidden = true），rAF 不跑、截图必然全空。这是验证环境的问题，不是包的问题',
        where: '运行时',
      });
    }
    if (findings.length === 0) summary.push('外部请求 0 个 ✓');

    return { available: true, findings, summary };
  } finally {
    try { if (browser) await browser.close(); } catch { /* 忽略 */ }
    await new Promise((r) => server.close(r));
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  }
}
