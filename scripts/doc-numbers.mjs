// 当前规模数字（自动生成）——给文档去手写数字用（2026-11-03）
//
// 背景：文档里写死过「三个 MCP server」「约 15,000 行」「47 个工具」这类数字，
// 代码一长就漂。这里把可数的东西从代码/配置里算出来，生成
// docs/guides/CURRENT-NUMBERS.md；test-doc-numbers.mjs 校验生成物没落后。
//
// 用法：
//   node scripts/doc-numbers.mjs          # 重新生成
//   node scripts/doc-numbers.mjs --check  # 只校验，过期 exit 1
//   node scripts/doc-numbers.mjs --print  # 只打印
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const NUMBERS_FILE = path.join('docs', 'guides', 'CURRENT-NUMBERS.md');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

function countBridgeLines(root) {
  return fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8').split('\n').length - 1;
}

function countQqTools(root) {
  const src = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  return new Set([...src.matchAll(/'qq_[a-z0-9_]+'/g)].map((m) => m[0].slice(1, -1))).size;
}

function listMcpServers(root) {
  return fs.readdirSync(path.join(root, 'src'))
    .filter((name) => /^mcp-.*\.js$/.test(name))
    .sort()
    .map((name) => name.replace(/^mcp-/, '').replace(/\.js$/, ''));
}

async function guardCounts(root) {
  const mod = await import(pathToFileURL(path.join(root, 'plugins', 'surfcore', 'qq-tool-restrict.mjs')).href);
  return {
    restricted: Array.isArray(mod.RESTRICTED_TOOL_NAMES) ? mod.RESTRICTED_TOOL_NAMES.length : 0,
    ownerPrivate: Array.isArray(mod.OWNER_PRIVATE_TOOL_NAMES) ? mod.OWNER_PRIVATE_TOOL_NAMES.length : 0,
  };
}

function countConsolePages(root) {
  const html = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');
  const start = html.indexOf('const consolePages = {');
  if (start < 0) return 0;
  const end = html.indexOf('};', start);
  const block = html.slice(start, end);
  return (block.match(/^\s*(?:'[a-z0-9-]+'|[a-z0-9-]+)\s*:/gm) ?? []).length;
}

function countAuditScripts(root) {
  const src = fs.readFileSync(path.join(root, 'scripts', 'test-audit.mjs'), 'utf8');
  const start = src.indexOf('const tests = [');
  const end = src.indexOf('];', start);
  const block = src.slice(start, end);
  return (block.match(/'test-[^']+\.mjs'/g) ?? []).length;
}

/** 生成 CURRENT-NUMBERS.md 的完整正文（无时间戳，保证可重复比较）。 */
export async function buildNumbersDoc(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  const pluginPkg = readJson(path.join(root, 'plugins', 'surfcore', 'package.json'));
  const guard = await guardCounts(root);
  const servers = listMcpServers(root);
  const rows = [
    ['版本（根/插件）', `${pkg.version} / ${pluginPkg.version}`, 'package.json × 2'],
    ['bridge.js 行数', String(countBridgeLines(root)), 'src/bridge.js'],
    ['qq_* MCP 工具数', String(countQqTools(root)), 'src/mcp-snowluma-safe.js'],
    ['MCP server 数', String(servers.length), servers.join(' / ')],
    ['restrict 名单条数', String(guard.restricted), 'plugins/surfcore/qq-tool-restrict.mjs'],
    ['「仅主人私聊」工具数', String(guard.ownerPrivate), '同上（OWNER_PRIVATE_TOOL_NAMES）'],
    ['控制台页面数', String(countConsolePages(root)), 'public/console.html（consolePages）'],
    ['test:audit 脚本数', String(countAuditScripts(root)), 'scripts/test-audit.mjs（tests[]）'],
  ];
  const lines = [
    '# 当前规模数字（自动生成）',
    '',
    '> **不要手改**：本文件由 `npm run docs:numbers` 生成；`npm run test:doc-numbers` 会校验它与代码一致。',
    '> 手写文档需要提到这些数字时，引用本文件而不是再抄一份（旧文档里已经漂过：3 个 MCP server / 15,000 行 / 47 个工具）。',
    '',
    '| 指标 | 值 | 来源 |',
    '| --- | --- | --- |',
    ...rows.map(([name, value, source]) => `| ${name} | ${value} | \`${source}\` |`),
    '',
    '重新生成：`node scripts/doc-numbers.mjs`；只校验：`node scripts/doc-numbers.mjs --check`。',
    '',
  ];
  return lines.join('\n');
}

const argv = process.argv.slice(2);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const target = path.join(ROOT, NUMBERS_FILE);
  const doc = await buildNumbersDoc(ROOT);
  if (argv.includes('--print')) {
    console.log(doc);
  } else if (argv.includes('--check')) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (current !== doc) {
      console.error('❌ docs/guides/CURRENT-NUMBERS.md 已落后于代码；运行 npm run docs:numbers 重新生成');
      process.exitCode = 1;
    } else {
      console.log('✅ CURRENT-NUMBERS.md 与代码一致');
    }
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, doc, 'utf8');
    console.log(`✅ 已生成 ${path.relative(ROOT, target)}`);
  }
}
