// 核心校验逻辑：吃一个「文件集合」，吐一堆 findings。
// 目录和 zip 走同一套检查——差别只在前端怎么把文件读出来。

import path from 'node:path';
import {
  ALLOWED_EXT, AUDIO_EXT, IMAGE_EXT, JUNK_PATTERNS,
  BANNED_IN_JS, BANNED_HTML, CSS_CHECKS, LIMITS, URL_IGNORE,
} from './rules.mjs';

const ext = (p) => {
  const b = p.split('/').pop();
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
};
const isDirPath = (p) => p.endsWith('/');
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

/* ---------- 剥注释 / 打码 ---------- */
// 目的只有一个：别把注释和字符串里的字样当成真调用（"别用 fetch()" 不是调用 fetch）。
// 所以这些函数都必须「引号感知」——否则 url("https://x") 里的 // 会被误当行注释，整行被吃掉。

function stripComments(src, pairs) {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    let hit = null;
    for (const [open, close] of pairs) if (src.startsWith(open, i)) { hit = [open, close]; break; }
    if (hit) {
      const end = src.indexOf(hit[1], i + hit[0].length);
      const stop = end < 0 ? src.length : end + hit[1].length;
      for (let k = i; k < stop; k++) if (out[k] !== '\n') out[k] = ' ';
      i = stop;
      continue;
    }
    i++;
  }
  return out.join('');
}

export const stripHtmlComments = (s) => stripComments(s, [['<!--', '-->']]);
export const stripCssComments = (s) => stripComments(s, [['/*', '*/']]);

// JS：单遍扫描。注释打码、字符串内容打码（保留引号位置）、正则字面量打码；
// 字符串字面量收集出来，单独用来查「外部地址」这种只能在字符串里出现的东西。
export function maskJs(src) {
  const out = src.split('');
  const strings = [];
  let i = 0;
  let lastMeaning = '';
  const maskRange = (from, to) => { for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let buf = '';
      while (j < src.length) {
        if (src[j] === '\\') { buf += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === quote) break;
        buf += src[j];
        j++;
      }
      strings.push({ value: buf, at: i });
      maskRange(i + 1, j);
      i = j + 1;
      lastMeaning = quote;
      continue;
    }

    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      maskRange(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      maskRange(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && !/[\w$)\]]/.test(lastMeaning)) {
      // 正则字面量：上一个有效字符不是标识符/数字/右括号时才可能是正则
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) { maskRange(i, j + 1); i = j + 1; continue; }
    }

    if (!/\s/.test(ch)) lastMeaning = ch;
    i++;
  }
  return { masked: out.join(''), strings };
}

/* ---------- 引用提取 ---------- */

const ATTR_RE = /\b(src|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const URL_FN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi;

export function collectRefs(files) {
  const refs = [];
  for (const f of files) {
    if (!f.content) continue;
    const e = ext(f.path);
    if (e === 'html') {
      const html = stripHtmlComments(f.content.toString('utf8'));
      for (const m of html.matchAll(ATTR_RE)) {
        const raw = (m[3] ?? m[4] ?? m[5] ?? '').trim();
        if (raw) refs.push({ from: f.path, attr: m[1].toLowerCase(), raw });
      }
      for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
        const css = stripCssComments(m[1]);
        for (const u of css.matchAll(URL_FN)) {
          const raw = (u[1] ?? u[2] ?? u[3] ?? '').trim();
          if (raw) refs.push({ from: f.path + ' 的内联 <style>', attr: 'url', raw });
        }
      }
    } else if (e === 'css') {
      const css = stripCssComments(f.content.toString('utf8'));
      for (const u of css.matchAll(URL_FN)) {
        const raw = (u[1] ?? u[2] ?? u[3] ?? '').trim();
        if (raw) refs.push({ from: f.path, attr: 'url', raw });
      }
    }
  }
  return refs;
}

const isExternal = (u) => /^(https?:)?\/\//i.test(u);
const isMemory = (u) => /^(data|blob):/i.test(u);
const isAnchor = (u) => u.startsWith('#');

/* ---------- 主校验 ---------- */

export function checkPackage({ files, kind, target }) {
  const findings = [];
  const add = (level, code, msg, where) => findings.push({ level, code, msg, where });
  const byPath = new Map(files.map((f) => [f.path, f]));
  const paths = files.map((f) => f.path);
  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);

  /* 1. 包结构 */
  const rootIndex = byPath.has('index.html');
  const nestedIndex = paths.filter((p) => p.endsWith('index.html') && p !== 'index.html');
  const htmlFiles = paths.filter((p) => ext(p) === 'html' && !isDirPath(p));

  if (!rootIndex) {
    if (nestedIndex.length) {
      const p = nestedIndex[0];
      const top = p.split('/')[0];
      const layerOnly = paths.every((x) => x === top + '/' || x.startsWith(top + '/'));
      add('error', 'ENTRY_NOT_AT_ROOT',
        `入口 index.html 不在包根目录（找到的是 ${p}）` +
        (layerOnly ? `：整包多套了一层「${top}/」。` : '。') +
        `压缩时要进入目录压「内容」而不是「目录本身」：cd ${top || 'dist'} && zip -r ../tool.zip .`,
        p);
    } else {
      add('error', 'ENTRY_MISSING', '包里没有 index.html，容器无法加载');
    }
  }

  const extraHtml = htmlFiles.filter((p) => p !== 'index.html');
  if (extraHtml.length) {
    add('error', 'MULTI_HTML',
      `包里除了 index.html 还有 ${extraHtml.length} 个 html 文件（${extraHtml.slice(0, 3).join(', ')}）：规范要求单页，视图用 JS 切换`,
      extraHtml[0]);
  }

  for (const p of paths) {
    if (isDirPath(p) || byPath.get(p)?.dir) continue; // 目录条目不当文件查
    const e = ext(p);
    if (AUDIO_EXT.has(e)) {
      add('error', 'AUDIO_TYPE',
        `音频文件 ${p}：规范的允许类型清单里没有任何音频格式（但另一节又写包内媒体可用，官方文档自相矛盾）。实测最稳的做法是音效走 Web Audio 程序化合成，零文件`,
        p);
      continue;
    }
    if (!ALLOWED_EXT.has(e)) {
      add('error', 'FILE_TYPE', `不允许的文件类型 .${e || '(无扩展名)'}：只允许 html/css/js/png/jpg/jpeg/gif/webp/svg/woff/woff2/json`, p);
    }
    for (const j of JUNK_PATTERNS) if (j.re.test(p)) add('error', 'JUNK_FILE', `包里混进了${j.msg}`, p);
  }

  /* 2. index.html */
  const indexFile = rootIndex ? byPath.get('index.html') : (nestedIndex.length ? byPath.get(nestedIndex[0]) : null);
  if (indexFile?.content) {
    const raw = indexFile.content.toString('utf8');
    const html = stripHtmlComments(raw);
    const at = indexFile.path;

    if (!/^\s*<!DOCTYPE\s+html/i.test(html)) add('error', 'DOCTYPE', 'index.html 开头缺 <!DOCTYPE html>', at);
    if (!/<html[^>]*\blang\s*=\s*["']zh-CN["']/i.test(html)) add('warn', 'LANG', '<html> 没写 lang="zh-CN"', at);
    if (!/<meta[^>]+charset\s*=\s*["']?utf-8/i.test(html)) add('error', 'CHARSET', '缺 <meta charset="UTF-8">', at);

    const vp = html.match(/<meta[^>]+name\s*=\s*["']viewport["'][^>]*>/i);
    if (!vp) add('error', 'VIEWPORT', '缺 viewport meta', at);
    else {
      const c = vp[0];
      if (!/width\s*=\s*device-width/i.test(c)) add('error', 'VIEWPORT_WIDTH', 'viewport 缺 width=device-width', at);
      if (!/initial-scale\s*=\s*1/i.test(c)) add('warn', 'VIEWPORT_SCALE', 'viewport 缺 initial-scale=1.0', at);
      if (!/viewport-fit\s*=\s*cover/i.test(c)) add('error', 'VIEWPORT_FIT', 'viewport 缺 viewport-fit=cover（真机安全区要用）', at);
    }

    if (/<script\b[^>]*type\s*=\s*["']module["']/i.test(html)) {
      add('warn', 'MODULE_SCRIPT', '<script type="module">：容器里的 ESM 加载行为未经验证，建议打成 IIFE 单文件', at);
    }
    if (/@font-face[\s\S]{0,400}?url\(\s*["']?\s*data:/i.test(html)) {
      add('error', 'FONT_DATA_URI', '@font-face 用了 data: 内嵌字体：字体只允许包内文件', at);
    }

    for (const rule of BANNED_HTML) {
      const m = html.match(rule.re);
      if (m) add(rule.soft ? 'warn' : 'error', 'HTML_RULE', rule.msg, `${at} 附近：${snippet(html, m.index)}`);
    }

    for (const ref of collectRefs([indexFile])) {
      if (isExternal(ref.raw)) {
        add('error', 'EXTERNAL_REF', `${ref.attr} 指向外部地址（${trunc(ref.raw)}）：容器不联网，须下载后打进包里改相对引用`, ref.from);
        continue;
      }
      if (isMemory(ref.raw) || isAnchor(ref.raw) || /^(mailto|tel):/i.test(ref.raw)) continue;
      if (ref.raw.startsWith('/')) {
        add('error', 'ABSOLUTE_PATH', `${ref.attr} 用了绝对路径（${trunc(ref.raw)}）：必须写成相对路径 ./assets/...`, ref.from);
        continue;
      }
      const clean = ref.raw.split('?')[0].split('#')[0];
      if (!clean) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(ref.from.split(' ')[0]), clean));
      if (!byPath.has(resolved)) {
        add('error', 'MISSING_ASSET', `${ref.attr} 引用的 ${ref.raw} 不在包里（解析为 ${resolved}）：容器加载不到就是白屏/丢样式`, ref.from);
      }
    }
  }

  /* 3. JS / CSS */
  for (const f of files) {
    if (isDirPath(f.path)) continue;
    const e = ext(f.path);
    if (!['js', 'css'].includes(e)) continue;
    if (!f.content) { add('warn', 'UNREADABLE', `${f.path} 无法解压读取，跳过内容扫描`, f.path); continue; }

    if (e === 'js') {
      const src = f.content.toString('utf8');
      const { masked, strings } = maskJs(src);
      // 打包产物 / 第三方库识别：命中多半来自永远执行不到的代码路径，降级成提示而不是拦你上传。
      // 手写文件里命中就是实打实的问题。
      const maxLine = src.split('\n').reduce((m, l) => (l.length > m ? l.length : m), 0);
      const isBundle = src.length > LIMITS.bundleIfBytes || maxLine > LIMITS.bundleIfLineLen;
      const vendorNote = isBundle
        ? '（该文件是打包产物／第三方库，命中可能来自不会执行到的代码路径，需人工确认）'
        : '';
      const seen = new Set();
      for (const rule of BANNED_IN_JS) {
        if (!rule.re.test(masked) || seen.has(rule.msg)) continue;
        seen.add(rule.msg);
        add(rule.soft || isBundle ? 'warn' : 'error', 'JS_API', rule.msg + vendorNote, f.path);
      }
      const urls = strings.map((s) => s.value.trim())
        .filter((v) => (/^(https?:)?\/\//i.test(v) || /https?:\/\/[\w.-]+\.[a-z]{2,}/i.test(v)) && !URL_IGNORE.test(v));
      if (urls.length) {
        add('warn', 'JS_URL', `JS 字符串里有 ${urls.length} 处外部地址（如 ${trunc(urls[0])}）：若用于加载资源则加载不到，只是文案可忽略`, f.path);
      }
    } else {
      const css = stripCssComments(f.content.toString('utf8'));
      for (const rule of CSS_CHECKS) {
        if (rule.re.test(css)) add(rule.soft ? 'warn' : 'error', 'CSS_RULE', rule.msg, f.path);
      }
    }
  }

  /* 4. 体积 */
  if (totalBytes > LIMITS.totalBytesWarn) {
    add('warn', 'TOTAL_SIZE', `总包 ${mb(totalBytes)}，规范推荐 < 2MB`, kind === 'zip' ? 'zip' : '目录');
  }
  for (const f of files) {
    if (IMAGE_EXT.has(ext(f.path)) && (f.size || 0) > LIMITS.imageBytesWarn) {
      add('warn', 'IMAGE_SIZE', `单图 ${kb(f.size)} 超过建议的 500KB（${f.path}），考虑压缩或换 WebP`, f.path);
    }
  }

  const errors = findings.filter((x) => x.level === 'error');
  const warns = findings.filter((x) => x.level === 'warn');
  return { ok: errors.length === 0, target, kind, fileCount: files.filter((f) => !isDirPath(f.path)).length, totalBytes, errors, warns, findings };
}

function snippet(text, index, span = 60) {
  const start = Math.max(0, index - 20);
  return trunc(text.slice(start, start + span).replace(/\s+/g, ' ').trim());
}
function trunc(s, n = 70) {
  const t = String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/* ---------- 报告 ---------- */

export function formatReport(r) {
  const L = [];
  L.push(`xiaohongshu-minitool-check — ${r.kind === 'zip' ? 'zip 包' : '目录'}：${r.target}`);
  L.push(`文件 ${r.fileCount} 个，共 ${r.totalBytes > 1024 * 1024 ? mb(r.totalBytes) : kb(r.totalBytes)}`);
  L.push('');
  if (r.errors.length) {
    L.push(`✗ 必须修（${r.errors.length}）`);
    r.errors.forEach((f, i) => {
      L.push(`  ${i + 1}. [${f.code}] ${f.msg}`);
      if (f.where) L.push(`     ${f.where}`);
    });
    L.push('');
  }
  if (r.warns.length) {
    L.push(`! 建议看（${r.warns.length}）`);
    r.warns.forEach((f, i) => {
      L.push(`  ${i + 1}. [${f.code}] ${f.msg}`);
      if (f.where) L.push(`     ${f.where}`);
    });
    L.push('');
  }
  if (!r.errors.length && !r.warns.length) L.push('✓ 全部检查通过');
  L.push(r.ok
    ? `结论：可以上传${r.warns.length ? `（${r.warns.length} 条建议项自己判断）` : ''}`
    : `结论：不能上传 —— 先修掉 ${r.errors.length} 项必须修的问题`);
  return L.join('\n');
}
