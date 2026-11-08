#!/usr/bin/env node
// setup-plugin.mjs — SurfCore DSH 插件包（Layout B）安装后接线脚本
//
// 这个脚本只做「装完包之后 DSH 侧还差的那一步」，不安装包本身：
//   1. MCP 接线：在目标 profile 的 cordis.patch.yml 里维护 4 个 MCP server 行，
//      脚本路径指向本包内的 src/mcp-*.js（不再指向 fork 仓库）。
//   2. 首次数据引导：包根缺 config.json 时从 config.example.json 复制；
//      确保包根 state/、roles/ 存在；state/mode.json 缺省写 reserved2。
//
// 特性：幂等、写前备份（cordis.patch.yml.bak-<时间戳>，保留最近 5 份）、
//      --check 只报告不写、失败不动文件、绝不启动/重启 DSH、绝不碰其它 profile。
//
// 用法：
//   node "<包根>/scripts/setup-plugin.mjs" [--profile <name>] [--check]
//        [--link] [--create] [--no-mcp] [--no-bootstrap] [--json]
//
//   --profile <name>  目标 profile（缺省：DSH_PROFILE 环境变量 → 自动探测 → web）
//   --check           只报告（0=已就绪，2=还有待配置项，1=错误）
//   --link            把 profile 依赖写成 link:<本包根>（手工/开发安装用；正常安装不需要）
//   --create          profile 不存在时创建最小 profile（package.json/cordis.patch.yml/pnpm-workspace.yaml）
//   --no-mcp          跳过 MCP 接线
//   --no-bootstrap    跳过首次数据引导
//
// 本脚本只依赖 Node 内置模块 + 它所在包声明的 js-yaml（npm/pnpm 装依赖后即有）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_FILE = fs.realpathSync(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const PKG_ROOT = path.resolve(SCRIPT_DIR, '..'); // <包根>/scripts → <包根>
const HOME = process.env.USERPROFILE || os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const PACKAGE_NAME = 'surfcore';

const MANAGED_MCP_IDS = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe', 'mcp-stock-safe'];
const MCP_BLOCK_BEGIN = '# === surfcore plugin MCP BEGIN ===';
const MCP_BLOCK_END = '# === surfcore plugin MCP END ===';

function log(message) {
  console.log(`[setup-plugin] ${message}`);
}

function fatal(message) {
  console.error(`[setup-plugin] ERROR: ${message}`);
  process.exit(1);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 备份一个即将被覆盖的文件（时间戳快照，只保留最近 keep 份）。
 * 与 scripts/setup-dsh.mjs 的 backupBeforeOverwrite 保持一致：
 * 每次都备份，避免「有备份但救不回来」。
 */
function backupBeforeOverwrite(file, keep = 5) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak-${stamp}`;
  try {
    fs.copyFileSync(file, dest);
  } catch (error) {
    log(`⚠️ 备份失败（${file}）：${error?.message ?? error}；继续但请自行确认原内容`);
    return null;
  }
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.bak-`;
    const snaps = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
    for (const name of snaps.slice(0, Math.max(0, snaps.length - keep))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch { /* 清理旧备份失败不影响主流程 */ }
  return dest;
}

/** 原子写：先写临时文件再 rename；失败时不动目标文件。 */
function writeFileAtomic(file, text) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// ── 参数 ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    profile: '',
    check: false,
    link: false,
    create: false,
    mcp: true,
    bootstrap: true,
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
      case '--profile': options.profile = next(); break;
      case '--check': options.check = true; break;
      case '--link': options.link = true; break;
      case '--create': options.create = true; break;
      case '--no-mcp': options.mcp = false; break;
      case '--no-bootstrap': options.bootstrap = false; break;
      case '--json': options.json = true; break;
      case '-h':
      case '--help': options.help = true; break;
      default: fatal(`未知参数：${arg}（--help 查看用法）`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(`用法: node "<包根>/scripts/setup-plugin.mjs" [--profile <name>] [--check] [--link] [--create]
       [--no-mcp] [--no-bootstrap] [--json]

  --profile <name>  目标 profile（缺省：DSH_PROFILE → 自动探测 → web）
  --check           只报告不写文件；退出码 0=已就绪 / 2=还有待配置项 / 1=错误
  --link            profile 依赖写成 link:<本包根>（手工安装用）
  --create          profile 不存在时创建最小 profile
  --no-mcp          跳过 MCP 接线
  --no-bootstrap    跳过首次数据引导（config.json/state/roles/mode.json）`);
  process.exit(0);
}

// ── 包根自检 ─────────────────────────────────────────────────────────────────

function validatePackageRoot() {
  const pkgFile = path.join(PKG_ROOT, 'package.json');
  if (!fs.existsSync(pkgFile)) fatal(`包根缺少 package.json（解析到：${PKG_ROOT}）。请把本脚本放回包内 scripts/ 目录再运行。`);
  let pkg;
  try {
    pkg = readJson(pkgFile);
  } catch (error) {
    fatal(`包根 package.json 无法解析：${error.message}`);
  }
  if (pkg.name !== PACKAGE_NAME) fatal(`包根 package.json 的 name 应为 "${PACKAGE_NAME}"，实际是 ${JSON.stringify(pkg.name)}（${PKG_ROOT}）`);
  const bundlePatch = pkg?.dsh?.bundle?.patch;
  const patches = Array.isArray(bundlePatch) ? bundlePatch : (typeof bundlePatch === 'string' ? [bundlePatch] : []);
  if (patches.length === 0) {
    fatal(`包根 package.json 缺 dsh.bundle.patch —— 这个包不是 Layout B 产物（或根 package.json 还没合并 dsh 字段）。请确认安装的是 out/surfcore 目录或 fork-plugin.tgz。`);
  }
  for (const rel of patches) {
    const file = path.join(PKG_ROOT, rel);
    if (!fs.existsSync(file)) fatal(`dsh.bundle.patch 指向的文件不存在：${rel}`);
  }
  if (!fs.existsSync(path.join(PKG_ROOT, 'plugins', 'surfcore', 'lib', 'index.js'))) {
    fatal('包根缺少 plugins/surfcore/lib/index.js，包不完整。');
  }
  return pkg;
}

// ── profile 解析 ─────────────────────────────────────────────────────────────

function validateProfileName(profile) {
  if (!profile || profile === '.' || profile === '..' || profile === 'node_modules'
    || /[\\/\x00-\x1f<>:"|?*]/.test(profile) || /[. ]$/.test(profile)) {
    fatal(`非法的 profile 名：${JSON.stringify(profile)}（只能是 ~/.dsh/profiles 下的目录名，不含路径分隔符）`);
  }
  return profile;
}

async function resolveProfileName() {
  if (options.profile) return validateProfileName(options.profile);
  const fromEnv = String(process.env.DSH_PROFILE ?? '').trim();
  if (fromEnv) return validateProfileName(fromEnv);
  // 与 Setup A 一致：能探测到正在运行的 DSH 就用它，探测不到兜底 web。
  try {
    const modulePath = path.join(SCRIPT_DIR, 'detect-profile.mjs');
    if (fs.existsSync(modulePath)) {
      const { detectProfile } = await import(pathToFileURL(modulePath).href);
      const detected = await detectProfile();
      if (detected) {
        log(`自动探测到 profile: ${detected}（可用 --profile 覆盖）`);
        return validateProfileName(detected);
      }
    }
  } catch { /* 探测失败不致命 */ }
  return 'web';
}

const PROFILE = await resolveProfileName();
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const CORDIS_PATCH = path.join(PROFILE_DIR, 'cordis.patch.yml');
const PROFILE_PKG = path.join(PROFILE_DIR, 'package.json');

if (!fs.existsSync(PROFILE_DIR) || !fs.existsSync(PROFILE_PKG)) {
  if (!options.create) {
    fatal(`profile "${PROFILE}" 不存在（${PROFILE_DIR}）。\n`
      + `  先在 DSH 插件管理里把本包装进该 profile，或用命令：\n`
      + `    dsh.cmd plugin --profile ${PROFILE} add link:${PKG_ROOT}\n`
      + `  确实要从零建一个空 profile 时加 --create。`);
  }
  log(`profile "${PROFILE}" 不存在，--create：创建最小 profile`);
}

// ── js-yaml（缺依赖时给人话错误）────────────────────────────────────────────

async function loadYaml() {
  const attempts = [];
  try { return (await import('js-yaml')).default; } catch (error) { attempts.push(`js-yaml: ${error.code ?? error.message}`); }
  try {
    const require = (await import('node:module')).createRequire(path.join(PKG_ROOT, 'package.json'));
    const resolved = require.resolve('js-yaml');
    const mod = await import(pathToFileURL(resolved).href);
    const candidate = mod.default ?? mod;
    if (candidate && typeof candidate.load === 'function') return candidate;
  } catch (error) { attempts.push(`resolved js-yaml: ${error.message}`); }
  fatal(`找不到 js-yaml（本包依赖未安装）。先执行：\n`
    + `  cd /d "${PKG_ROOT}" && npm install\n`
    + `若用 pnpm 装的包且构建脚本被拦截，请在 DSH 插件管理页允许 surfcore 的构建后重装。\n`
    + `详情：${attempts.join(' | ')}`);
}

// ── MCP 接线 ─────────────────────────────────────────────────────────────────

function yamlSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function mcpEntries() {
  const node = process.execPath;
  const servers = {
    'mcp-snowluma': { serverName: 'snowluma', script: path.join(PKG_ROOT, 'src', 'mcp-snowluma-safe.js'), toolCallTimeoutMs: 725000 },
    'mcp-snowluma-host': { serverName: 'snowluma-host', script: path.join(PKG_ROOT, 'src', 'mcp-host-server.js') },
    'mcp-web-search-safe': { serverName: 'web-search-safe', script: path.join(PKG_ROOT, 'src', 'mcp-web-search-safe.js') },
    'mcp-stock-safe': { serverName: 'stock', script: path.join(PKG_ROOT, 'src', 'mcp-stock-safe.js'), toolCallTimeoutMs: 60000 },
  };
  let out = `${MCP_BLOCK_BEGIN}\n`;
  out += `# 由 ${path.join('scripts', 'setup-plugin.mjs')} 维护；这段区块会被整体替换，请勿手工编辑内部条目。\n`;
  for (const [id, server] of Object.entries(servers)) {
    out += `- insert:\n`;
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${server.serverName}\n`;
    out += `        transport: stdio\n`;
    out += `        command: ${yamlSingleQuote(node)}\n`;
    out += `        args:\n`;
    out += `          - ${yamlSingleQuote(server.script)}\n`;
    // qq_wait_for_messages 最长可等 10 分钟；DSH 默认 60s 会提前掐断工具调用。
    if (server.toolCallTimeoutMs) out += `        toolCallTimeoutMs: ${server.toolCallTimeoutMs}\n`;
  }
  out += `${MCP_BLOCK_END}\n`;
  return out;
}

/** 解析并清理 profile cordis.patch.yml 里脚本托管的 MCP 条目，返回新文本（不写盘）。 */
function prepareCordisPatch(yaml) {
  const original = fs.existsSync(CORDIS_PATCH) ? fs.readFileSync(CORDIS_PATCH, 'utf8') : '';
  const lines = original.replace(/^\uFEFF/, '').split(/\r?\n/);
  // 修复历史上「根 [] 后面又跟块操作」的非法写法（setup-dsh 同款处理）。
  const first = lines.findIndex((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (first >= 0 && lines[first].trim() === '[]' && lines.slice(first + 1).some((line) => /^-\s/.test(line))) {
    lines.splice(first, 1);
  }
  let doc;
  try {
    doc = yaml.load(lines.join('\n')) ?? [];
  } catch (error) {
    fatal(`解析 ${CORDIS_PATCH} 失败（文件未改动）：${error.message}`);
  }
  if (!Array.isArray(doc)) fatal(`${CORDIS_PATCH} 必须是顶层 YAML 数组（文件未改动）`);
  let removed = 0;
  const kept = [];
  for (const operation of doc) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      fatal(`${CORDIS_PATCH} 里有非法的 patch 条目（文件未改动）`);
    }
    if (!Object.hasOwn(operation, 'insert')) { kept.push(operation); continue; }
    if (!Array.isArray(operation.insert)) fatal(`${CORDIS_PATCH} 里的 insert 必须是数组（文件未改动）`);
    const entries = operation.insert.filter((entry) => {
      if (MANAGED_MCP_IDS.includes(entry?.id)) { removed += 1; return false; }
      return true;
    });
    if (entries.length > 0 || Object.keys(operation).length > 1) kept.push({ ...operation, insert: entries });
  }
  const text = (kept.length ? `${yaml.dump(kept, { lineWidth: -1, noRefs: true })}\n` : '') + mcpEntries();
  return { original, text, removed, changed: original !== text };
}

// ── profile package.json：依赖 + bundles ─────────────────────────────────────

const DEFAULT_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

const DEFAULT_PROFILE_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;

function prepareProfileManifest() {
  let pkg = null;
  let created = false;
  if (fs.existsSync(PROFILE_PKG)) {
    try {
      pkg = readJson(PROFILE_PKG);
    } catch (error) {
      fatal(`${PROFILE_PKG} 不是合法 JSON（文件未改动）：${error.message}`);
    }
  } else {
    pkg = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
    created = true;
  }
  const before = JSON.stringify(pkg);
  pkg.name = pkg.name || `dsh-profile-${PROFILE}`;
  pkg.private = pkg.private !== false;
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) pkg.dependencies = {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];

  const linkSpec = `link:${PKG_ROOT.replace(/\\/g, '/')}`;
  const issues = [];
  if (options.link) {
    if (pkg.dependencies[PACKAGE_NAME] !== linkSpec) pkg.dependencies[PACKAGE_NAME] = linkSpec;
  } else if (!Object.hasOwn(pkg.dependencies, PACKAGE_NAME)) {
    issues.push(`profile 的 package.json 依赖里没有 ${PACKAGE_NAME}（本包不是通过插件管理装的？）。`
      + `请在 DSH 插件管理里安装本包，或重跑本脚本加 --link（会写入 ${linkSpec}）。`);
  }
  if (!pkg.dsh.profile.bundles.includes(PACKAGE_NAME)) pkg.dsh.profile.bundles.push(PACKAGE_NAME);
  const changed = before !== JSON.stringify(pkg) || created;
  return { pkg, changed, created, issues, linkSpec };
}

/** 让 <profile>/node_modules/surfcore 指向本包根（仅当依赖是 link:/file: 且缺链接时补建）。 */
function ensureProfileModuleLink(dependencySpec) {
  const modulesDir = path.join(PROFILE_DIR, 'node_modules');
  const linkPath = path.join(modulesDir, PACKAGE_NAME);
  const spec = String(dependencySpec ?? '');
  const looksLocal = spec.startsWith('link:') || (spec.startsWith('file:') && !spec.endsWith('.tgz'));
  const issues = [];
  if (!looksLocal) return { issues, created: false, skipped: `依赖 spec 不是本地目录（${spec || '未注册'}），不补链接` };
  const target = spec.replace(/^link:/, '').replace(/^file:/, '');
  const targetDir = path.resolve(target);
  let existing = null;
  try { existing = fs.lstatSync(linkPath); } catch { /* 不存在 */ }
  if (existing) {
    let same = false;
    try {
      same = path.resolve(fs.realpathSync(linkPath)).toLowerCase() === path.resolve(fs.realpathSync(targetDir)).toLowerCase();
    } catch { /* 悬空链接 */ }
    if (same) return { issues, created: false, skipped: '链接已存在且指向本包' };
    issues.push(`${linkPath} 已存在但不指向本包（可能指向旧安装）。本脚本不覆盖它；请用插件管理重装，或手动删除后重跑。`);
    return { issues, created: false, skipped: '链接指向别处' };
  }
  if (!fs.existsSync(targetDir)) {
    issues.push(`link 目标目录不存在：${targetDir}`);
    return { issues, created: false, skipped: '目标目录不存在' };
  }
  if (options.check) return { issues, created: false, pending: `将创建链接 ${linkPath} → ${targetDir}` };
  ensureDir(modulesDir);
  try {
    if (process.platform === 'win32') fs.symlinkSync(targetDir, linkPath, 'junction');
    else fs.symlinkSync(targetDir, linkPath, 'dir');
    log(`已创建 profile node_modules 链接：${linkPath} → ${targetDir}`);
    return { issues, created: true };
  } catch (error) {
    issues.push(`创建链接失败（${linkPath}）：${error.message}。可手动执行 mklink /J。`);
    return { issues, created: false };
  }
}

// ── 首次数据引导 ─────────────────────────────────────────────────────────────

function planBootstrap() {
  const actions = [];
  const configFile = path.join(PKG_ROOT, 'config.json');
  const exampleFile = path.join(PKG_ROOT, 'config.example.json');
  if (!fs.existsSync(configFile)) {
    if (!fs.existsSync(exampleFile)) {
      actions.push({ kind: 'error', message: `包根缺 config.example.json，无法生成 config.json（${exampleFile}）` });
    } else {
      actions.push({ kind: 'copy-config', message: '复制 config.example.json → config.json', run: () => fs.copyFileSync(exampleFile, configFile) });
    }
  } else {
    actions.push({ kind: 'ok', message: 'config.json 已存在（不覆盖）' });
  }
  for (const dir of ['state', 'roles']) {
    const full = path.join(PKG_ROOT, dir);
    if (!fs.existsSync(full)) actions.push({ kind: 'mkdir', message: `创建目录 ${dir}/`, run: () => ensureDir(full) });
    else actions.push({ kind: 'ok', message: `${dir}/ 已存在` });
  }
  const modeFile = path.join(PKG_ROOT, 'state', 'mode.json');
  if (!fs.existsSync(modeFile)) {
    actions.push({
      kind: 'write-mode',
      message: '写入 state/mode.json（mode=reserved2）',
      run: () => writeFileAtomic(modeFile, `${JSON.stringify({ mode: 'reserved2', closedAgentPreset: '' }, null, 2)}\n`),
    });
  } else {
    actions.push({ kind: 'ok', message: 'state/mode.json 已存在（不覆盖用户配置）' });
  }
  return actions;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

const pkg = validatePackageRoot();
const yaml = await loadYaml();
const result = {
  ok: true,
  check: options.check,
  profile: PROFILE,
  profileDir: PROFILE_DIR,
  packageRoot: PKG_ROOT,
  packageVersion: pkg.version,
  pending: [],
  applied: [],
  warnings: [],
};

// --create：先把 profile 骨架写出来（之后流程照常）
if (options.create && !fs.existsSync(PROFILE_PKG)) {
  if (options.check) {
    result.pending.push(`将创建最小 profile：${PROFILE_DIR}`);
  } else {
    ensureDir(PROFILE_DIR);
    if (!fs.existsSync(CORDIS_PATCH)) fs.writeFileSync(CORDIS_PATCH, DEFAULT_PROFILE_PATCH, 'utf8');
    const workspaceFile = path.join(PROFILE_DIR, 'pnpm-workspace.yaml');
    if (!fs.existsSync(workspaceFile)) fs.writeFileSync(workspaceFile, DEFAULT_PNPM_WORKSPACE, 'utf8');
    result.applied.push(`创建 profile 骨架：${PROFILE_DIR}`);
    log(`已创建 profile 骨架：${PROFILE_DIR}`);
  }
}

// 1) profile package.json（依赖 + bundles）
const manifest = prepareProfileManifest();
for (const issue of manifest.issues) result.warnings.push(issue);
if (manifest.changed) {
  const pendingText = `更新 ${PROFILE_PKG}（dependencies.${PACKAGE_NAME} / dsh.profile.bundles）`;
  result.pending.push(pendingText);
  if (!options.check) {
    backupBeforeOverwrite(PROFILE_PKG);
    writeFileAtomic(PROFILE_PKG, `${JSON.stringify(manifest.pkg, null, 2)}\n`);
    result.applied.push(pendingText);
    log(`已更新 profile 清单：${PROFILE_PKG}`);
  }
}

// 2) node_modules 链接（link:/file: 本地目录依赖时补建）
const linkResult = ensureProfileModuleLink(manifest.pkg.dependencies?.[PACKAGE_NAME] ?? (options.link ? manifest.linkSpec : ''));
for (const issue of linkResult.issues) result.warnings.push(issue);
if (linkResult.pending) result.pending.push(linkResult.pending);
if (linkResult.created) result.applied.push(`创建 node_modules 链接 ${PACKAGE_NAME}`);

// 3) MCP 接线
if (options.mcp) {
  const prepared = prepareCordisPatch(yaml);
  if (prepared.changed) {
    const pendingText = `更新 ${CORDIS_PATCH} 的 MCP 行（清理旧条目 ${prepared.removed} 条，写入 ${MANAGED_MCP_IDS.length} 条）`;
    result.pending.push(pendingText);
    if (!options.check) {
      backupBeforeOverwrite(CORDIS_PATCH);
      writeFileAtomic(CORDIS_PATCH, prepared.text);
      result.applied.push(pendingText);
      log(`已更新 cordis.patch.yml：MCP 条目 ${MANAGED_MCP_IDS.length} 条（旧条目清理 ${prepared.removed} 条）`);
    }
  } else {
    log('cordis.patch.yml 的 MCP 行已是最新（幂等）');
  }
} else {
  log('--no-mcp：跳过 MCP 接线');
}

// 4) 首次数据引导
if (options.bootstrap) {
  const actions = planBootstrap();
  for (const action of actions) {
    if (action.kind === 'error') { result.warnings.push(action.message); result.ok = false; continue; }
    if (action.kind === 'ok') continue;
    result.pending.push(action.message);
    if (options.check) continue;
    try {
      action.run();
      result.applied.push(action.message);
      log(action.message);
    } catch (error) {
      result.warnings.push(`${action.message} 失败：${error.message}`);
      result.ok = false;
    }
  }
} else {
  log('--no-bootstrap：跳过首次数据引导');
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────

const changedSomething = result.applied.length > 0;
const pendingLeft = result.pending.length > 0 && options.check;

if (options.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  log(`—— 汇总（profile=${PROFILE}，包根=${PKG_ROOT}，版本=${pkg.version}）——`);
  if (result.applied.length > 0) {
    log('本次已写入：');
    for (const item of result.applied) log(`  ✅ ${item}`);
  }
  if (options.check && result.pending.length > 0) {
    log('--check 发现还有待配置项（未写文件）：');
    for (const item of result.pending) log(`  ⏳ ${item}`);
  } else if (options.check) {
    log('--check：已就绪，无需改动。');
  }
  if (result.warnings.length > 0) {
    log('注意：');
    for (const item of result.warnings) log(`  ⚠️ ${item}`);
  }
  if (changedSomething && !options.check) {
    log('下一步：重启 DSH（或重载 profile）使 MCP 行生效；QQ 用户记得先启动 SnowLuma。');
  }
}

if (!result.ok) process.exit(1);
if (pendingLeft) process.exit(2);
process.exit(0);
