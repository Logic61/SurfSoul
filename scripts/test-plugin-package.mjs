#!/usr/bin/env node
// test-plugin-package.mjs — 可复跑的「插件包构建 + 静态安装」回归测试（离线，不碰 desktop profile，不启动 DSH）
//
// 流程：
//   1. 在 os.tmpdir() 的临时目录里跑 scripts/build-plugin-package.mjs（--no-pack），要求退出码 0；
//   2. 独立校验产物：package.json 的 main / exports / dsh.bundle.patch / dsh.client / files 指向存在文件；
//   3. 用 js-yaml（从本仓库 node_modules 借）解析全部 bundle patch；
//   4. 校验 src/ + plugins/ 运行时文件的相对 import 闭包完整；
//   5. 伪造 DSH_HOME + profile（link: 依赖 + node_modules junction），跑 setup-plugin.mjs 真实接线，
//      再要求 --check 退出 0（幂等/已就绪）；
//   6. 用 import.meta.resolve 校验 7 个 exports 子路径在 profile 里都能解析到包内真实文件；
//   7. 清理临时目录，红/绿退出码。
//
// 用法：node scripts/test-plugin-package.mjs [--keep]
//   全绿 exit 0；任一断言失败 exit 1（失败明细逐条打印）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const BUILD_SCRIPT = path.join(SCRIPT_DIR, 'build-plugin-package.mjs');
const SETUP_SCRIPT = path.join(SCRIPT_DIR, 'setup-plugin.mjs');
const KEEP = process.argv.includes('--keep');

const failures = [];
let passed = 0;
function assert(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}${detail ? ` -- ${detail}` : ''}`);
  } else {
    failures.push({ name, detail });
    console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
}

function loadYaml() {
  const candidates = [
    () => createRequire(path.join(REPO_ROOT, 'package.json'))('js-yaml'),
    () => createRequire(path.join(SCRIPT_DIR, 'build-plugin-package.mjs'))('js-yaml'),
  ];
  for (const candidate of candidates) {
    try {
      const loaded = candidate();
      if (loaded && typeof loaded.load === 'function') return loaded;
    } catch { /* try next */ }
  }
  return null;
}

const IMPORT_RES = [
  /(?:^|[\s;{(])import\s*(?:\(\s*)?['"]([^'"]+)['"]/g,
  /(?:^|[\s;])export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g,
  /(?:^|[\s;])import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
];
function collectSpecifiers(text) {
  const found = new Set();
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) found.add(match[1]);
  }
  return [...found];
}
function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
function resolveRelative(fromFile, spec) {
  const clean = spec.split('?')[0].split('#')[0];
  const base = path.resolve(path.dirname(fromFile), clean);
  return [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`,
    path.join(base, 'index.js'), path.join(base, 'index.mjs')].find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) ?? null;
}
function exportsTargetFor(exportsField, subpath) {
  if (!exportsField) return undefined;
  if (typeof exportsField === 'string') return subpath === '.' ? exportsField : undefined;
  const direct = exportsField[subpath];
  if (typeof direct === 'string') return direct;
  for (const [key, value] of Object.entries(exportsField)) {
    if (!key.includes('*') || typeof value !== 'string') continue;
    const star = key.indexOf('*');
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    return value.split('*').join(subpath.slice(prefix.length, subpath.length - suffix.length));
  }
  return undefined;
}
function targetExists(pkgDir, target) {
  if (typeof target !== 'string' || target === '') return false;
  if (!target.includes('*')) {
    try { return fs.statSync(path.join(pkgDir, target)).isFile(); } catch { return false; }
  }
  const star = target.indexOf('*');
  const lastSlash = target.lastIndexOf('/', star);
  const dir = path.join(pkgDir, target.slice(0, lastSlash));
  const suffix = target.slice(lastSlash + 1).replace('*', '');
  try { return fs.readdirSync(dir).some((name) => name.endsWith(suffix)); } catch { return false; }
}

const started = Date.now();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-plugin-pkg-test-'));
const outDir = path.join(tmpRoot, 'out');
const dshHome = path.join(tmpRoot, 'dsh-home');
const profileName = 'surfcore-plugin-test';
const profileDir = path.join(dshHome, 'profiles', profileName);
const pkgDir = path.join(outDir, 'surfcore');

try {
  // 1) build
  const build = run(process.execPath, [BUILD_SCRIPT, '--source', REPO_ROOT, '--out', outDir, '--no-pack'], {
    cwd: REPO_ROOT,
    timeout: 180000,
  });
  assert('build-plugin-package.mjs exits 0', build.status === 0,
    `exit=${build.status} ${(build.stderr || '').trim().split('\n').slice(-2).join(' | ')}`);
  assert('build output package dir exists', fs.existsSync(path.join(pkgDir, 'package.json')), path.relative(tmpRoot, pkgDir));
  if (build.status !== 0) throw new Error('build failed; further checks skipped');

  // 2) package.json fields
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')); } catch { /* asserted below */ }
  assert('package.json parses', pkg !== null);
  assert('package name is surfcore', pkg?.name === 'surfcore', pkg?.name);
  assert('main points at an existing file', targetExists(pkgDir, pkg?.main), pkg?.main);
  const patchList = Array.isArray(pkg?.dsh?.bundle?.patch) ? pkg.dsh.bundle.patch
    : (typeof pkg?.dsh?.bundle?.patch === 'string' ? [pkg.dsh.bundle.patch] : []);
  assert('dsh.bundle.patch lists 3 existing files',
    patchList.length === 3 && patchList.every((rel) => fs.existsSync(path.join(pkgDir, rel))),
    JSON.stringify(patchList));
  assert('dsh.client platform=web + inject array',
    pkg?.dsh?.client?.platform === 'web' && Array.isArray(pkg?.dsh?.client?.inject), JSON.stringify(pkg?.dsh?.client));
  assert('files whitelist includes runtime dirs',
    Array.isArray(pkg?.files) && ['src', 'plugins', 'dsh', 'scripts'].every((dir) => pkg.files.includes(dir)));
  const explicitExports = ['.', './client', './qq-mode', './qq-tool-restrict.mjs', './qq-owner-approval.mjs', './icon', './package.json'];
  const exportChecks = explicitExports.map((subpath) => ({ subpath, ok: targetExists(pkgDir, exportsTargetFor(pkg?.exports, subpath)) }));
  assert('exports explicit subpaths point at existing files', exportChecks.every((item) => item.ok),
    exportChecks.filter((item) => !item.ok).map((item) => item.subpath).join(',') || `${explicitExports.length} subpaths`);
  assert('exports ./locale/*.json resolves', targetExists(pkgDir, exportsTargetFor(pkg?.exports, './locale/zh.json')));

  // 3) YAML parse of all bundle patches (borrow js-yaml from this repo's node_modules)
  const yaml = loadYaml();
  assert('js-yaml available for patch parsing', yaml !== null);
  if (yaml) {
    const problems = [];
    for (const rel of patchList) {
      try {
        const doc = yaml.load(fs.readFileSync(path.join(pkgDir, rel), 'utf8'));
        if (!Array.isArray(doc)) problems.push(`${rel}: not a top-level array`);
      } catch (error) {
        problems.push(`${rel}: ${error.message}`);
      }
    }
    assert('all dsh.bundle.patch files parse as YAML arrays', problems.length === 0, problems.join('; ') || `${patchList.length} patches`);
  }

  // 4) relative import closure of runtime code
  const unresolved = [];
  let scanned = 0;
  for (const dir of ['src', 'plugins']) {
    const root = path.join(pkgDir, dir);
    if (!fs.existsSync(root)) continue;
    for (const file of walkFiles(root)) {
      if (!/\.(?:js|mjs|cjs)$/i.test(file)) continue;
      scanned += 1;
      for (const spec of collectSpecifiers(fs.readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        if (resolveRelative(file, spec) === null) unresolved.push(`${path.relative(pkgDir, file)} -> ${spec}`);
      }
    }
  }
  assert('runtime relative import closure complete', unresolved.length === 0,
    unresolved.slice(0, 10).join('; ') || `${scanned} files scanned`);

  // 5) fake DSH_HOME/profile: setup-plugin real run then --check = ready
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies: { surfcore: `link:${pkgDir.replace(/\\/g, '/')}` },
    dsh: { profile: { bundles: ['surfcore'] } },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  const linkPath = path.join(profileDir, 'node_modules', 'surfcore');
  if (process.platform === 'win32') fs.symlinkSync(pkgDir, linkPath, 'junction');
  else fs.symlinkSync(pkgDir, linkPath, 'dir');

  const setupEnv = { ...process.env, DSH_HOME: dshHome };
  // 跑产物包内的 setup-plugin.mjs（构建脚本会把交付脚本注入包内 scripts/）
  const packagedSetup = path.join(pkgDir, 'scripts', 'setup-plugin.mjs');
  assert('build output contains scripts/setup-plugin.mjs', fs.existsSync(packagedSetup), path.relative(pkgDir, packagedSetup));
  const setup = run(process.execPath, [packagedSetup, '--profile', profileName], { env: setupEnv, timeout: 60000 });
  assert('setup-plugin.mjs exits 0 on fake profile', setup.status === 0,
    `exit=${setup.status} ${(setup.stderr || '').trim().split('\n').slice(-2).join(' | ')}`);
  const setupCheck = run(process.execPath, [packagedSetup, '--profile', profileName, '--check'], { env: setupEnv, timeout: 60000 });
  assert('setup-plugin.mjs --check exits 0 (idempotent/ready)', setupCheck.status === 0, `exit=${setupCheck.status}`);
  assert('bootstrap created config.json/state/roles/mode.json',
    ['config.json', 'state', 'roles', path.join('state', 'mode.json')].every((rel) => fs.existsSync(path.join(pkgDir, rel))));
  const profilePatch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert('MCP block has 4 managed ids',
    ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe', 'mcp-stock-safe'].every((id) => profilePatch.includes(`id: ${id}`)));

  // 6) ESM exports resolution from inside the fake profile
  const specs = ['surfcore', 'surfcore/client', 'surfcore/qq-mode', 'surfcore/qq-tool-restrict.mjs',
    'surfcore/qq-owner-approval.mjs', 'surfcore/locale/zh.json', 'surfcore/icon', 'surfcore/package.json'];
  const probeFile = path.join(profileDir, '__resolve_probe.mjs');
  fs.writeFileSync(probeFile, `
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const specs = ${JSON.stringify(specs)};
const out = [];
for (const spec of specs) {
  try {
    const url = import.meta.resolve(spec);
    out.push({ spec, ok: true, inPackage: fs.existsSync(fileURLToPath(url)), file: fileURLToPath(url) });
  } catch (error) { out.push({ spec, ok: false, error: error.message }); }
}
console.log(JSON.stringify(out));
`);
  const probe = run(process.execPath, [probeFile], { cwd: profileDir, timeout: 60000 });
  fs.rmSync(probeFile, { force: true });
  let probeResults = [];
  try { probeResults = JSON.parse((probe.stdout || '').trim().split('\n').pop()); } catch { probeResults = []; }
  assert('ESM exports resolve inside fake profile',
    probeResults.length === specs.length && probeResults.every((item) => item.ok && item.inPackage),
    probeResults.filter((item) => !item.ok || !item.inPackage).map((item) => item.spec).join(',') || `${specs.length} specs`);
} catch (error) {
  assert('test harness completed without exception', false, error.message);
} finally {
  if (KEEP) {
    console.log(`\n[test-plugin-package] --keep: 临时目录保留在 ${tmpRoot}`);
  } else {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const duration = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n=== test-plugin-package: ${passed} passed, ${failures.length} failed (${duration}s) ===`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure.name}${failure.detail ? ` -- ${failure.detail}` : ''}`);
  process.exit(1);
}
process.exit(0);
