#!/usr/bin/env node
// build-plugin-package.mjs — 把 SurfCore fork 仓库打成「自包含、可分发的 DSH 插件包」（Layout B）
//
// 思路：整仓库 = 一个 npm 包（包名 surfcore）。包根 package.json 补上 DSH 需要的字段：
//   main            → ./plugins/surfcore/lib/index.js
//   exports         → . / ./client / ./qq-mode / ./locale/*.json / ./icon / ./package.json
//                     / ./qq-tool-restrict.mjs / ./qq-owner-approval.mjs
//   dsh.bundle.patch→ ./plugins/surfcore/cordis.patch.yml + 两个 preset patch
//   dsh.client      → { platform: "web", inject: [] }
//   files           → npm pack 白名单
// 这样 DSH 的 0.2.x 装载器（bundlePatchPaths = join(packageDir, file)；patch 里的相对 name
// 以 patch 文件为锚）天然成立，插件代码里 `../../../src/*`、`./lib/qq-mode.js` 全部不用改。
//
// 仓库根 package.json 若还没合并这些字段，就回退用 package-root-patch.json 里的建议值，
// 保证「先构建、后合并」也能出正确产物。
//
// 用法：
//   node scripts/build-plugin-package.mjs [--source <repo>] [--out <dir>] [--version <ver>]
//        [--no-pack] [--force] [--with-root-docs] [--json]
//
// 默认值：
//   --source  脚本上一级（仓库 scripts/ 布局）
//   --out     脚本上一级/dist/plugin（仓库 scripts/ 布局 = <仓库根>/dist/plugin）
//
// 产物：
//   <out>/surfcore/                          完整包目录（可直接作为 plugin_manager 的 target）
//   <out>/surfcore-<ver>-fork-plugin.tgz     npm pack 后重命名的分发 tarball（--no-pack 可跳过）
//   <out>/surfcore-<ver>-fork-plugin.tgz.sha256
//   <out>/build-manifest.json                机器可读构建清单 + 自检结果
//
// 只读源仓库；只写 <out>。幂等：重复运行会重建 <out>/surfcore（带 marker 保护，--force 可越过）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT_FILE = fs.realpathSync(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const BUILD_MARKER = '.surfcore-plugin-build.json';
const DEFAULT_SOURCE = '';

// ── 参数 ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    source: '',
    out: '',
    version: '',
    pack: true,
    force: false,
    withRootDocs: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fatal(`${arg} 需要一个值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--source': options.source = next(); break;
      case '--out': options.out = next(); break;
      case '--version': options.version = next(); break;
      case '--no-pack': options.pack = false; break;
      case '--force': options.force = true; break;
      case '--with-root-docs': options.withRootDocs = true; break;
      case '--json': options.json = true; break;
      case '-h':
      case '--help': options.help = true; break;
      default: fatal(`未知参数：${arg}（--help 查看用法）`);
    }
  }
  return options;
}

function fatal(message) {
  console.error(`[build-plugin-package] ERROR: ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[build-plugin-package] ${message}`);
}

// ── 基础工具 ─────────────────────────────────────────────────────────────────

const posix = (p) => p.split(path.sep).join('/');

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// js-yaml 只从源仓库 node_modules 借（不额外装包）；仓库没装依赖时给出人话错误。
async function loadYaml(sourceRoot) {
  const candidates = [];
  try { candidates.push((await import('js-yaml')).default); } catch { /* 脚本不在仓库内时走下面 */ }
  if (candidates.length === 0) {
    try {
      const require = (await import('node:module')).createRequire(path.join(sourceRoot, 'package.json'));
      const resolved = require.resolve('js-yaml');
      const mod = await import(pathToFileURL(resolved).href);
      candidates.push(mod.default ?? mod);
    } catch { /* ignore */ }
  }
  const yaml = candidates.find((candidate) => candidate && typeof candidate.load === 'function');
  if (!yaml) {
    fatal(`找不到 js-yaml（相对脚本与 ${sourceRoot}/node_modules 都没有）。请先在源仓库执行 npm install，或确认源路径正确。`);
  }
  return yaml;
}

// ── 参数解析 ─────────────────────────────────────────────────────────────────

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(`用法: node scripts/build-plugin-package.mjs [--source <repo>] [--out <dir>] [--version <ver>]
       [--no-pack] [--force] [--with-root-docs] [--json]`);
  process.exit(0);
}

const startedAt = Date.now();

function resolveSourceRoot() {
  const candidates = [
    options.source,
    process.env.SURFCORE_SOURCE,
    path.resolve(SCRIPT_DIR, '..'),
    DEFAULT_SOURCE,
  ].filter((candidate) => typeof candidate === 'string' && candidate.trim() !== '');
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (isFile(path.join(root, 'src', 'bridge.js')) && isFile(path.join(root, 'package.json'))) return root;
  }
  fatal(`找不到源仓库。用 --source <仓库根> 指定（需要 src/bridge.js 与 package.json）。尝试过：\n  ${candidates.map((c) => path.resolve(c)).join('\n  ')}`);
}

const SOURCE = resolveSourceRoot();
const OUT_ROOT = path.resolve(options.out || path.join(SCRIPT_DIR, '..', 'dist', 'plugin'));
const PACKAGE_DIR = path.join(OUT_ROOT, 'surfcore');

log(`源仓库: ${SOURCE}`);
log(`输出目录: ${OUT_ROOT}`);

// ── 决定包根 package.json（仓库已合并字段则用仓库值，否则回退 patch 文件）────────

function loadRootPatch() {
  const candidates = [
    path.join(SCRIPT_DIR, '..', 'package-root-patch.json'),
    path.join(SOURCE, 'package-root-patch.json'),
    path.join(SCRIPT_DIR, 'package-root-patch.json'),
  ];
  for (const file of candidates) {
    if (!isFile(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const fields = parsed?.fields ?? parsed?.suggestedFields ?? parsed?.patch;
      if (fields && typeof fields === 'object') {
        log(`包根字段建议: ${file}`);
        return { file, fields, parsed };
      }
      fatal(`${file} 里没有 fields / suggestedFields 对象`);
    } catch (error) {
      fatal(`解析 ${file} 失败：${error.message}`);
    }
  }
  return { file: null, fields: null, parsed: null };
}

const ROOT_PATCH = loadRootPatch();
const sourcePackageText = fs.readFileSync(path.join(SOURCE, 'package.json'), 'utf8');
let sourcePackage;
try {
  sourcePackage = JSON.parse(sourcePackageText);
} catch (error) {
  fatal(`源仓库 package.json 不是合法 JSON：${error.message}`);
}

const PACKAGE_NAME = 'surfcore';
if (sourcePackage.name !== PACKAGE_NAME) {
  fatal(`源仓库 package.json 的 name 必须是 "${PACKAGE_NAME}"（DSH 主行 id 与包名一致），实际是 ${JSON.stringify(sourcePackage.name)}`);
}

const DESIRED_FIELDS = ROOT_PATCH.fields ?? {
  main: './plugins/surfcore/lib/index.js',
  exports: {
    '.': './plugins/surfcore/lib/index.js',
    './client': './plugins/surfcore/lib/client.js',
    './qq-mode': './plugins/surfcore/lib/qq-mode.js',
    './lib/*': './plugins/surfcore/lib/*',
    './locale/*.json': './plugins/surfcore/locale/*.json',
    './icon': './plugins/surfcore/icon.svg',
    './qq-tool-restrict.mjs': './plugins/surfcore/qq-tool-restrict.mjs',
    './qq-owner-approval.mjs': './plugins/surfcore/qq-owner-approval.mjs',
    './package.json': './package.json',
  },
  dsh: {
    bundle: {
      patch: [
        './plugins/surfcore/cordis.patch.yml',
        './plugins/surfcore/presets/qq-chat.patch.yml',
        './plugins/surfcore/presets/qq-chat-v2.patch.yml',
      ],
    },
    client: { platform: 'web', inject: [] },
  },
  files: [
    'src',
    'plugins',
    'dsh',
    'scripts',
    'roles',
    'examples',
    'public',
    'assets',
    'config.example.json',
    '_snowluma-catalog.json',
    'package-lock.json',
    'AGENTS.md',
    'CHANGELOG.md',
    'INSTALL.md',
    'README.fork.md',
  ],
};

function buildPackageJson() {
  const pkg = structuredClone(sourcePackage);
  const fieldSource = {};
  for (const key of ['main', 'exports', 'dsh', 'files']) {
    const desired = DESIRED_FIELDS[key];
    if (desired === undefined) continue;
    if (pkg[key] === undefined) {
      pkg[key] = structuredClone(desired);
      fieldSource[key] = 'fallback:package-root-patch.json';
      log(`仓库 package.json 缺 ${key}，使用 package-root-patch.json 的兜底值`);
    } else if (JSON.stringify(pkg[key]) !== JSON.stringify(desired)) {
      fieldSource[key] = 'repo';
      log(`⚠️ 仓库 package.json 的 ${key} 与建议值不同；以仓库为准（如非有意，请核对 package-root-patch.json）`);
    } else {
      fieldSource[key] = 'repo';
    }
  }
  pkg.name = PACKAGE_NAME;
  pkg.version = options.version ? String(options.version) : String(pkg.version || sourcePackage.version);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version)) fatal(`版本号不像 semver：${pkg.version}`);
  pkg.type = pkg.type || 'module';
  pkg.engines = { ...pkg.engines, node: pkg.engines?.node || '>=22.13.0' };
  delete pkg.devDependencies;
  return { pkg, fieldSource };
}

// ── 复制白名单 ───────────────────────────────────────────────────────────────

const COPY_DIRS = ['src', 'plugins', 'dsh', 'scripts', 'roles', 'examples', 'public', 'assets'];
const COPY_ROOT_FILES = [
  'config.example.json',
  '_snowluma-catalog.json',
  'LICENSE',
  'README.md',
  'README.en.md',
  'README.fork.md',
  'AGENTS.md',
  'CHANGELOG.md',
  '.npmrc',
  'package-lock.json',
];
const EXCLUDED_DIR_NAMES = new Set([
  'node_modules', '.git', 'state', 'logs', '_backups', '_quarantine',
  'audio', 'video', 'release', '__pycache__', '.cache', '.npm-cache',
]);
const EXCLUDED_FILE_PATTERNS = [
  /\.log$/i,
  /\.bak(?:-|$)/i,
  /\.tmp$/i,
  /^\.env(?:\.|$)/i,
  /^config\.json$/i,
  /^Thumbs\.db$/i,
  /^\.DS_Store$/i,
];

function isExcludedFile(name) {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

const copyStats = { files: 0, bytes: 0, skipped: [], dirs: {} };

function ensureDirForFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function copyTree(sourceDir, targetDir, topName) {
  let files = 0;
  let bytes = 0;
  const visit = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      const rel = posix(path.relative(SOURCE, fromPath));
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) {
          copyStats.skipped.push(`${rel}/ （排除目录）`);
          continue;
        }
        fs.mkdirSync(toPath, { recursive: true });
        visit(fromPath, toPath);
      } else if (entry.isFile()) {
        if (isExcludedFile(entry.name)) {
          copyStats.skipped.push(`${rel} （排除文件）`);
          continue;
        }
        ensureDirForFile(toPath);
        fs.copyFileSync(fromPath, toPath);
        files += 1;
        bytes += sizeOf(fromPath);
      } else {
        copyStats.skipped.push(`${rel} （符号链接/特殊文件，跳过）`);
      }
    }
  };
  fs.mkdirSync(targetDir, { recursive: true });
  visit(sourceDir, targetDir);
  copyStats.dirs[topName] = { files, bytes };
  copyStats.files += files;
  copyStats.bytes += bytes;
}

// 交付脚本/文档（仓库还没合并时也能让产物自包含）
const INJECT_FILES = [
  { target: 'scripts/setup-plugin.mjs', source: path.join(SCRIPT_DIR, 'setup-plugin.mjs') },
  { target: 'scripts/build-plugin-package.mjs', source: path.join(SCRIPT_DIR, 'build-plugin-package.mjs') },
  { target: 'scripts/test-plugin-package.mjs', source: path.join(SCRIPT_DIR, 'test-plugin-package.mjs') },
  { target: 'INSTALL.md', source: path.join(SCRIPT_DIR, '..', 'docs', 'guides', 'PLUGIN_INSTALL.md') },
  { target: 'package-root-patch.json', source: path.join(SCRIPT_DIR, '..', 'package-root-patch.json') },
];
const injected = [];
function injectDeliverables() {
  for (const { target, source } of INJECT_FILES) {
    const targetPath = path.join(PACKAGE_DIR, target);
    if (!isFile(source)) continue;
    if (isFile(targetPath)) continue; // 仓库里已有同名文件：以仓库为准
    ensureDirForFile(targetPath);
    fs.copyFileSync(source, targetPath);
    copyStats.files += 1;
    copyStats.bytes += sizeOf(source);
    injected.push(target);
  }
}

function prepareOutDir() {
  if (fs.existsSync(PACKAGE_DIR)) {
    const markerPath = path.join(PACKAGE_DIR, BUILD_MARKER);
    if (!isFile(markerPath) && !options.force) {
      fatal(`${PACKAGE_DIR} 已存在且不是本脚本的产物（缺 ${BUILD_MARKER}）。确认后加 --force 删除重建，或换 --out。`);
    }
    log(`清理旧产物: ${PACKAGE_DIR}`);
    fs.rmSync(PACKAGE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(PACKAGE_DIR, { recursive: true });
}

// ── 自检 ─────────────────────────────────────────────────────────────────────

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: ok === true, detail: String(detail || '') });
  log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok === true;
}

function exportsTargetFor(exportsField, subpath) {
  if (exportsField === undefined) return undefined;
  if (typeof exportsField === 'string') return subpath === '.' ? exportsField : undefined;
  if (exportsField === null || typeof exportsField !== 'object') return undefined;
  const direct = exportsField[subpath];
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object') {
    for (const conditionValue of Object.values(direct)) {
      if (typeof conditionValue === 'string') return conditionValue;
    }
  }
  for (const [key, value] of Object.entries(exportsField)) {
    if (!key.includes('*')) continue;
    const starIndex = key.indexOf('*');
    const prefix = key.slice(0, starIndex);
    const suffix = key.slice(starIndex + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
    if (typeof value === 'string') return value.split('*').join(middle);
  }
  return undefined;
}

// 在包内按 exports 规则解析一个裸子路径；target 里若含 * 则做目录 glob 检查。
function packageTargetExists(pkgDir, target) {
  if (typeof target !== 'string' || target === '') return false;
  if (!target.includes('*')) return isFile(path.join(pkgDir, target));
  // 形如 ./plugins/surfcore/locale/*.json：检查目录里至少有匹配文件
  const firstStar = target.indexOf('*');
  const lastSlash = target.lastIndexOf('/', firstStar);
  const dirPart = target.slice(0, lastSlash);
  const filePattern = target.slice(lastSlash + 1);
  const dir = path.join(pkgDir, dirPart);
  if (!isDirectory(dir)) return false;
  const suffix = filePattern.replace('*', '');
  return fs.readdirSync(dir).some((name) => name.endsWith(suffix));
}

const IMPORT_STATIC_RE = /(?:^|[\s;{(])import\s*(?:\(\s*)?['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /(?:^|[\s;])export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g;
const IMPORT_FROM_RE = /(?:^|[\s;])import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g;

function collectSpecifiers(text) {
  const found = new Set();
  for (const re of [IMPORT_STATIC_RE, EXPORT_FROM_RE, IMPORT_FROM_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) found.add(match[1]);
  }
  return [...found];
}

function resolveRelativeImport(fromFile, spec) {
  const clean = spec.split('?')[0].split('#')[0];
  const base = path.resolve(path.dirname(fromFile), clean);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`,
    path.join(base, 'index.js'), path.join(base, 'index.mjs'), path.join(base, 'index.cjs')];
  return candidates.find((candidate) => isFile(candidate)) ?? null;
}

function runImportClosureCheck(pkgDir) {
  const runtimeGlobs = ['src', 'plugins'];
  const scanRoots = ['src', 'plugins', 'scripts'].map((dir) => path.join(pkgDir, dir)).filter(isDirectory);
  const unresolvedRuntime = [];
  const unresolvedOther = [];
  let scanned = 0;
  for (const root of scanRoots) {
    for (const file of walkFiles(root)) {
      if (!/\.(?:js|mjs|cjs)$/i.test(file)) continue;
      if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
      scanned += 1;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const spec of collectSpecifiers(text)) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        // 兼容 `?rev=` 之类的 query（memory-card.js?rev=... 是插件真实用法）
        if (resolveRelativeImport(file, spec) === null) {
          const relFile = posix(path.relative(pkgDir, file));
          const entry = `${relFile} → ${spec}`;
          if (runtimeGlobs.some((prefix) => relFile === prefix || relFile.startsWith(`${prefix}/`))) unresolvedRuntime.push(entry);
          else unresolvedOther.push(entry);
        }
      }
    }
  }
  const ok = check('相对 import 闭包（src/ + plugins/ 运行时文件全部可解析）',
    unresolvedRuntime.length === 0,
    unresolvedRuntime.length === 0 ? `扫描 ${scanned} 个文件` : `缺失 ${unresolvedRuntime.length} 处：${unresolvedRuntime.slice(0, 12).join('; ')}`);
  if (unresolvedOther.length > 0) {
    log(`⚠️ 非运行时脚本里有 ${unresolvedOther.length} 处无法解析的相对 import（不阻塞构建）：${unresolvedOther.slice(0, 8).join('; ')}`);
  }
  return ok;
}

function patchRelativeNameExists(patchFile, name) {
  const clean = name.split('?')[0].split('#')[0];
  if (clean.startsWith('file://')) {
    try { return isFile(fileURLToPath(clean)) || isDirectory(fileURLToPath(clean)); } catch { return false; }
  }
  const base = path.isAbsolute(clean) ? clean : path.resolve(path.dirname(patchFile), clean);
  return isFile(base) || isDirectory(base);
}

function collectPatchInsertedNames(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectPatchInsertedNames(item, found);
    return found;
  }
  if (node === null || typeof node !== 'object') return found;
  if (typeof node.name === 'string') found.push(node.name);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'name') continue;
    if (key === 'config' || key === 'insert' || key === 'plugins' || node.group === true) {
      if (Array.isArray(value) || (value && typeof value === 'object')) collectPatchInsertedNames(value, found);
    }
  }
  return found;
}

function runChecks(pkg, pkgDir, yaml) {
  // 1) 包根 JSON 可解析（写盘后从磁盘再读一次）
  let diskPkg = null;
  try {
    diskPkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    check('package.json 可解析', true);
  } catch (error) {
    check('package.json 可解析', false, error.message);
  }
  const effectivePkg = diskPkg ?? pkg;

  // 2) main / exports
  check('main 存在', typeof effectivePkg.main === 'string' && isFile(path.join(pkgDir, effectivePkg.main)), effectivePkg.main);
  const exportChecks = [];
  for (const subpath of ['.', './client', './qq-mode', './qq-tool-restrict.mjs', './qq-owner-approval.mjs', './icon', './package.json'])
 {
    const target = exportsTargetFor(effectivePkg.exports, subpath);
    exportChecks.push({ subpath, target, ok: packageTargetExists(pkgDir, target) });
  }
  const localePattern = exportsTargetFor(effectivePkg.exports, './locale/zh.json');
  exportChecks.push({ subpath: './locale/*.json', target: localePattern, ok: packageTargetExists(pkgDir, localePattern) });
  check('exports 子路径目标全部存在', exportChecks.every((item) => item.ok),
    exportChecks.filter((item) => !item.ok).map((item) => item.subpath).join(', ') || `${exportChecks.length} 项`);

  // 3) dsh.bundle.patch + YAML 解析 + patch 内相对 name 存在 + preset 子行被 exports 覆盖
  const patchList = effectivePkg?.dsh?.bundle?.patch;
  const patches = Array.isArray(patchList) ? patchList : (typeof patchList === 'string' ? [patchList] : []);
  check('dsh.bundle.patch 为非空字符串数组', patches.length > 0 && patches.every((item) => typeof item === 'string'), JSON.stringify(patches));
  let patchDocs = [];
  let patchYamlOk = true;
  let patchNameOk = true;
  let patchExportsOk = true;
  const patchProblems = [];
  for (const patchRel of patches) {
    const patchFile = path.join(pkgDir, patchRel);
    if (!isFile(patchFile)) {
      patchYamlOk = false;
      patchProblems.push(`缺文件 ${patchRel}`);
      continue;
    }
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(patchFile, 'utf8'));
    } catch (error) {
      patchYamlOk = false;
      patchProblems.push(`${patchRel} YAML 解析失败：${error.message}`);
      continue;
    }
    if (!Array.isArray(doc)) {
      patchYamlOk = false;
      patchProblems.push(`${patchRel} 顶层不是数组`);
      continue;
    }
    patchDocs.push({ patchRel, doc });
    for (const name of collectPatchInsertedNames(doc)) {
      if (name === PACKAGE_NAME) {
        if (!packageTargetExists(pkgDir, exportsTargetFor(effectivePkg.exports, '.'))) { patchExportsOk = false; patchProblems.push(`${patchRel}: 裸名 surfcore 无对应 exports "."`); }
        continue;
      }
      if (name.startsWith(`${PACKAGE_NAME}/`)) {
        const subpath = `./${name.slice(PACKAGE_NAME.length + 1)}`;
        const target = exportsTargetFor(effectivePkg.exports, subpath);
        if (!packageTargetExists(pkgDir, target)) { patchExportsOk = false; patchProblems.push(`${patchRel}: ${name} 未被 exports 覆盖`); }
        continue;
      }
      if (name.startsWith('./') || name.startsWith('../') || path.isAbsolute(name) || name.startsWith('file://')) {
        if (!patchRelativeNameExists(patchFile, name)) { patchNameOk = false; patchProblems.push(`${patchRel}: 相对 name 不存在 ${name}`); }
        continue;
      }
      // cordis:group / node: / @deepseek-ai/* / 其它裸名：由 DSH/宿主解析，静态检查阶段跳过
    }
  }
  check('dsh.bundle.patch 文件全部存在且 YAML 顶层数组', patchYamlOk && patchDocs.length === patches.length, patchProblems.join('; ') || `${patches.length} 个 patch`);
  check('patch 内相对 name（./ 命名空间文件）存在', patchNameOk);
  check('patch 内 surfcore/* 子行被包根 exports 覆盖', patchExportsOk);

  // 4) 关键入口 node --check
  const keyEntries = [
    'plugins/surfcore/lib/index.js',
    'plugins/surfcore/lib/client.js',
    'plugins/surfcore/lib/qq-mode.js',
    'plugins/surfcore/lib/paths.js',
    'plugins/surfcore/qq-tool-restrict.mjs',
    'plugins/surfcore/qq-owner-approval.mjs',
    'src/bridge.js',
    'src/mcp-snowluma-safe.js',
    'src/mcp-host-server.js',
    'src/mcp-web-search-safe.js',
    'src/mcp-stock-safe.js',
    'scripts/setup-plugin.mjs',
  ];
  const syntaxProblems = [];
  for (const rel of keyEntries) {
    const file = path.join(pkgDir, rel);
    if (!isFile(file)) { syntaxProblems.push(`${rel} 不存在`); continue; }
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) syntaxProblems.push(`${rel}: ${(result.stderr || '').trim().split('\n').slice(0, 2).join(' ')}`);
  }
  check('关键入口 node --check 通过', syntaxProblems.length === 0, syntaxProblems.join('; ') || `${keyEntries.length} 个入口`);

  // 5) 相对 import 闭包
  runImportClosureCheck(pkgDir);

  // 6) JSON 数据文件可解析（只查 plugins/ 下的 manifest/locale，避免误伤大文件）
  const jsonProblems = [];
  let jsonCount = 0;
  for (const sub of ['plugins']) {
    const root = path.join(pkgDir, sub);
    if (!isDirectory(root)) continue;
    for (const file of walkFiles(root)) {
      if (!file.endsWith('.json')) continue;
      jsonCount += 1;
      try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { jsonProblems.push(`${posix(path.relative(pkgDir, file))}: ${error.message}`); }
    }
  }
  check(`${jsonCount} 个 JSON 文件可解析`, jsonProblems.length === 0, jsonProblems.slice(0, 5).join('; '));

  // 7) dsh.client 声明
  const clientDecl = effectivePkg?.dsh?.client;
  check('dsh.client 声明存在且 platform=web',
    clientDecl && clientDecl.platform === 'web' && Array.isArray(clientDecl.inject),
    JSON.stringify(clientDecl));
  check('dsh.client 对应 exports["./client"] 存在', packageTargetExists(pkgDir, exportsTargetFor(effectivePkg.exports, './client')));

  // 8) 包根 config.example.json / src/bridge.js（paths.js 的 QQBOT_ROOT 探针依赖这两者）
  check('包根有 config.example.json 与 src/bridge.js（QQBOT_ROOT 探针）',
    isFile(path.join(pkgDir, 'config.example.json')) && isFile(path.join(pkgDir, 'src', 'bridge.js')));

  // 9) 真实 import paths.js，验证 PLUGIN_ROOT/QQBOT_ROOT 都落在包内
  const probeScript = `
    const m = await import(${JSON.stringify(pathToFileURL(path.join(pkgDir, 'plugins', 'surfcore', 'lib', 'paths.js')).href)});
    console.log(JSON.stringify({ PLUGIN_ROOT: m.PLUGIN_ROOT, QQBOT_ROOT: m.QQBOT_ROOT }));
  `;
  // cwd 用临时目录：paths.js 的 QQBOT_ROOT 候选里有 process.cwd()，在仓库根跑会被误命中。
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript], {
    encoding: 'utf8',
    windowsHide: true,
    cwd: os.tmpdir(),
  });
  let probeOk = false;
  let probeDetail = (probe.stderr || '').trim().split('\n').slice(0, 3).join(' ');
  if (probe.status === 0) {
    try {
      const parsedProbe = JSON.parse(probe.stdout.trim().split('\n').pop());
      const expectedPluginRoot = path.join(pkgDir, 'plugins', 'surfcore');
      const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
      probeOk = same(parsedProbe.PLUGIN_ROOT, expectedPluginRoot) && same(parsedProbe.QQBOT_ROOT, pkgDir);
      probeDetail = `PLUGIN_ROOT=${parsedProbe.PLUGIN_ROOT}; QQBOT_ROOT=${parsedProbe.QQBOT_ROOT}`;
    } catch (error) {
      probeDetail = `probe 输出无法解析：${error.message}`;
    }
  }
  check('paths.js 运行时解析：PLUGIN_ROOT/QQBOT_ROOT 都在包内', probeOk, probeDetail);

  // 10) 版本一致性（插件内部用 ../../../package.json 读版本）
  const subPkgPath = path.join(pkgDir, 'plugins', 'surfcore', 'package.json');
  let versionOk = true;
  if (isFile(subPkgPath)) {
    try {
      const subPkg = JSON.parse(fs.readFileSync(subPkgPath, 'utf8'));
      versionOk = String(subPkg.version) === String(effectivePkg.version);
    } catch { versionOk = false; }
  }
  check('包根与 plugins/surfcore/package.json 版本一致', versionOk, effectivePkg.version);

  return { checksOk: checks.every((item) => item.ok), patchDocs, exportChecks };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

const { pkg: generatedPkg, fieldSource } = buildPackageJson();
prepareOutDir();

log('复制白名单目录/文件…');
for (const dir of COPY_DIRS) {
  const from = path.join(SOURCE, dir);
  if (!isDirectory(from)) { log(`跳过不存在的目录: ${dir}`); continue; }
  copyTree(from, path.join(PACKAGE_DIR, dir), dir);
}
if (options.withRootDocs) {
  const docsDir = path.join(SOURCE, 'docs');
  if (isDirectory(docsDir)) copyTree(docsDir, path.join(PACKAGE_DIR, 'docs'), 'docs');
}
for (const file of COPY_ROOT_FILES) {
  const from = path.join(SOURCE, file);
  if (!isFile(from)) continue;
  ensureDirForFile(path.join(PACKAGE_DIR, file));
  fs.copyFileSync(from, path.join(PACKAGE_DIR, file));
  copyStats.files += 1;
  copyStats.bytes += sizeOf(from);
}
injectDeliverables();

// 生成包根 package.json（复制阶段不会覆盖它：源 package.json 不在 COPY_ROOT_FILES 里）
fs.writeFileSync(path.join(PACKAGE_DIR, 'package.json'), `${JSON.stringify(generatedPkg, null, 2)}\n`, 'utf8');

// 版本覆盖时同步子包 package.json（只改 version 字段，其余保持仓库原样）
const subPkgPath = path.join(PACKAGE_DIR, 'plugins', 'surfcore', 'package.json');
if (options.version && isFile(subPkgPath)) {
  try {
    const subPkg = JSON.parse(fs.readFileSync(subPkgPath, 'utf8'));
    if (String(subPkg.version) !== String(generatedPkg.version)) {
      subPkg.version = generatedPkg.version;
      fs.writeFileSync(subPkgPath, `${JSON.stringify(subPkg, null, 2)}\n`, 'utf8');
      log(`plugins/surfcore/package.json 版本同步为 ${generatedPkg.version}`);
    }
  } catch (error) {
    log(`⚠️ 无法同步子包版本：${error.message}`);
  }
}

// 构建 marker
const marker = {
  tool: 'build-plugin-package.mjs',
  schema: 1,
  packageName: PACKAGE_NAME,
  version: generatedPkg.version,
  source: SOURCE,
  builtAt: new Date().toISOString(),
  fieldSource,
};
fs.writeFileSync(path.join(PACKAGE_DIR, BUILD_MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

let sourceHead = '';
try {
  const git = spawnSync('git', ['-C', SOURCE, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  if (git.status === 0) sourceHead = git.stdout.trim();
} catch { /* 没装 git 也能构建 */ }

log('运行自检…');
const yaml = await loadYaml(SOURCE);
const checkResult = runChecks(generatedPkg, PACKAGE_DIR, yaml);

// 体积/清单
const outFiles = walkFiles(PACKAGE_DIR);
const outBytes = outFiles.reduce((sum, file) => sum + sizeOf(file), 0);
const perTop = {};
for (const file of outFiles) {
  const rel = posix(path.relative(PACKAGE_DIR, file));
  const top = rel.includes('/') ? rel.split('/')[0] : '(root)';
  perTop[top] = perTop[top] ?? { files: 0, bytes: 0 };
  perTop[top].files += 1;
  perTop[top].bytes += sizeOf(file);
}
const largest = outFiles
  .map((file) => ({ file: posix(path.relative(PACKAGE_DIR, file)), bytes: sizeOf(file) }))
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 10);

// npm pack
let tarball = null;
let packLog = '';
if (options.pack) {
  log('npm pack…');
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const packArgs = ['pack', '--pack-destination', OUT_ROOT];
  let result;
  if (isFile(npmCli)) {
    result = spawnSync(process.execPath, [npmCli, ...packArgs], { cwd: PACKAGE_DIR, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  } else if (process.platform === 'win32') {
    const cmd = `npm pack --pack-destination "${OUT_ROOT.replace(/"/g, '""')}"`;
    result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', cmd], { cwd: PACKAGE_DIR, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  } else {
    result = spawnSync('npm', packArgs, { cwd: PACKAGE_DIR, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  }
  packLog = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    check('npm pack', false, packLog.split('\n').slice(-4).join(' | '));
  } else {
    const packedName = (packLog.match(/([^\s/\\]+\.tgz)/g) ?? []).map((name) => name.trim()).pop();
    const packedPath = packedName ? path.join(OUT_ROOT, packedName) : '';
    if (packedPath && isFile(packedPath)) {
      const finalName = `${PACKAGE_NAME}-${generatedPkg.version}-fork-plugin.tgz`;
      const finalPath = path.join(OUT_ROOT, finalName);
      if (path.resolve(packedPath) !== path.resolve(finalPath)) {
        fs.rmSync(finalPath, { force: true });
        fs.renameSync(packedPath, finalPath);
      }
      const digest = sha256File(finalPath);
      fs.writeFileSync(`${finalPath}.sha256`, `${digest}  ${finalName}\n`, 'utf8');
      tarball = { path: finalPath, name: finalName, bytes: sizeOf(finalPath), sha256: digest };
      check('npm pack 产物生成', true, `${finalName}（${formatBytes(tarball.bytes)}）`);
    } else {
      check('npm pack 产物生成', false, `没找到 .tgz；输出：${packLog.split('\n').slice(-3).join(' | ')}`);
    }
  }
}

const manifest = {
  schema: 1,
  tool: 'build-plugin-package.mjs',
  builtAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  source: SOURCE,
  sourceHead,
  sourcePackageVersion: sourcePackage.version,
  outRoot: OUT_ROOT,
  packageDir: PACKAGE_DIR,
  version: generatedPkg.version,
  fieldSource,
  packageJson: generatedPkg,
  files: {
    copied: copyStats.files,
    bytes: copyStats.bytes,
    packageTotalFiles: outFiles.length,
    packageTotalBytes: outBytes,
    perTop,
    largest,
    injected,
    skipped: copyStats.skipped.slice(0, 50),
  },
  checks,
  patches: checkResult.patchDocs.map(({ patchRel, doc }) => ({ patchRel, entries: doc.length })),
  exports: checkResult.exportChecks,
  tarball,
  packLog: packLog.split('\n').slice(-8),
};
fs.writeFileSync(path.join(OUT_ROOT, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

// ── 人读汇总 ─────────────────────────────────────────────────────────────────

if (options.json) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  log('—— 构建汇总 ——');
  log(`版本 ${generatedPkg.version}（源仓库 HEAD ${sourceHead || 'n/a'}）`);
  for (const [top, value] of Object.entries(perTop).sort((a, b) => b[1].bytes - a[1].bytes)) {
    log(`  ${top.padEnd(28)} ${String(value.files).padStart(5)} 个文件  ${formatBytes(value.bytes)}`);
  }
  log(`包内容合计：${outFiles.length} 个文件，${formatBytes(outBytes)}`);
  log(`自检：${checks.filter((item) => item.ok).length}/${checks.length} 通过`);
  const failed = checks.filter((item) => !item.ok);
  if (failed.length > 0) {
    log('失败项：');
    for (const item of failed) log(`  ❌ ${item.name} — ${item.detail}`);
  }
  if (tarball) log(`tarball：${tarball.path}（${formatBytes(tarball.bytes)}，sha256 ${tarball.sha256.slice(0, 16)}…）`);
  log(`清单：${path.join(OUT_ROOT, 'build-manifest.json')}`);
  log(`耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

if (!checkResult.checksOk) {
  console.error('[build-plugin-package] 自检失败，产物保留在输出目录供排查。');
  process.exit(1);
}
log('OK：产物已生成，自检全部通过。');
