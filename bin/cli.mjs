#!/usr/bin/env node
// xhs-minitool-check —— 小红书小工具离线包合规校验器
// 用法：xhs-minitool-check <dist 目录 | tool.zip> [--json] [--runtime] [--quiet]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip, isZip } from '../src/zip.mjs';
import { checkPackage, formatReport } from '../src/check.mjs';

const VERSION = '0.1.0';

function usage() {
  return [
    `xhs-minitool-check ${VERSION} —— 小红书小工具离线包合规校验器`,
    '',
    '用法：',
    '  xhs-minitool-check <dist 目录 | tool.zip> [选项]',
    '',
    '选项：',
    '  --json       输出机器可读 JSON（给 CI / agent 用）',
    '  --runtime    额外做一次运行时检查：起本地 http 服务用无头浏览器打开，',
    '               读资源表证明零外链、抓控制台报错（需要 playwright-core，可选）',
    '  --quiet      只输出结论行',
    '  -h, --help   显示帮助',
    '',
    '退出码：0 = 可以上传，1 = 有必须修的问题，2 = 用法/读取错误',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { target: null, json: false, runtime: false, quiet: false };
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a === '--runtime') out.runtime = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('-')) throw new Error('未知选项：' + a);
    else if (!out.target) out.target = a;
    else throw new Error('多余参数：' + a);
  }
  return out;
}

function readDir(root) {
  const files = [];
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const relPath = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        files.push({ path: relPath + '/', size: 0, dir: true, content: null });
        walk(abs, relPath);
      } else if (ent.isFile()) {
        const buf = fs.readFileSync(abs);
        files.push({ path: relPath, size: buf.length, content: buf });
      }
    }
  };
  walk(root, '');
  return files;
}

function readZipAsFiles(zipPath) {
  const buf = fs.readFileSync(zipPath);
  if (!isZip(buf)) throw new Error('不是 zip 文件：' + zipPath);
  const entries = readZip(buf);
  return entries.map((e) => ({
    path: e.name,
    size: e.size || (e.data ? e.data.length : 0),
    dir: e.name.endsWith('/'),
    content: e.data,
  }));
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(e.message + '\n\n' + usage());
    process.exit(2);
  }
  if (args.help || !args.target) {
    console.log(usage());
    process.exit(args.target ? 0 : 2);
  }

  const target = path.resolve(args.target);
  if (!fs.existsSync(target)) {
    console.error('路径不存在：' + target);
    process.exit(2);
  }
  const st = fs.statSync(target);
  let files;
  let kind;
  try {
    if (st.isDirectory()) { files = readDir(target); kind = 'dir'; }
    else if (st.isFile() && /\.zip$/i.test(target)) { files = readZipAsFiles(target); kind = 'zip'; }
    else throw new Error('只支持目录或 .zip 文件');
  } catch (e) {
    console.error('读取失败：' + e.message);
    process.exit(2);
  }

  // zip 里可能有中文名条目，按 utf8 读回来
  for (const f of files) if (f.content && f.content.length > 8 * 1024 * 1024) f.content = null;

  const result = checkPackage({ files, kind, target });

  let runtime = null;
  if (args.runtime) {
    try {
      const { probeRuntime } = await import('../src/runtime.mjs');
      runtime = await probeRuntime({ target, kind, files });
    } catch (e) {
      runtime = { available: false, error: e.message };
    }
    if (runtime && runtime.available === false) {
      result.warns.push({
        level: 'warn', code: 'RUNTIME_SKIPPED',
        msg: '运行时检查跳过：' + runtime.error,
        where: '--runtime',
      });
    } else if (runtime) {
      for (const f of runtime.findings) result.findings.push(f);
      result.errors = result.findings.filter((x) => x.level === 'error');
      result.warns = result.findings.filter((x) => x.level === 'warn');
      result.ok = result.errors.length === 0;
    }
  }

  if (args.json) {
    console.log(JSON.stringify({
      tool: 'xhs-minitool-check', version: VERSION,
      ok: result.ok, target: result.target, kind: result.kind,
      fileCount: result.fileCount, totalBytes: result.totalBytes,
      errors: result.errors, warns: result.warns,
      runtime: runtime ? (runtime.available === false ? { skipped: runtime.error } : runtime.summary) : undefined,
    }, null, 2));
  } else if (args.quiet) {
    console.log(result.ok ? 'OK' : `FAIL (${result.errors.length})`);
  } else {
    console.log(formatReport(result));
    if (runtime && runtime.available !== false && runtime.summary) {
      console.log('\n运行时检查：');
      for (const line of runtime.summary) console.log('  ' + line);
    }
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('意外错误：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
