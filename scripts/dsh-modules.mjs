// 定位「DSH 安装目录下的 node_modules」—— 供仓库脚本加载 DSH 自身的模块做校验。
//
// 解析顺序：
//   1. 环境变量 DSH_INSTALL_MODULES / DSH_MODULES（应指向 <DSH>/node_modules）
//   2. 从 $DSH_HOME/profiles/<profile>/package.json 用 Node 模块解析反查真实安装位置
//      （profile 依次尝试 DSH_PROFILE、web、default，再兜底扫 profiles 下的其它目录）
// 全部失败时抛出带指引的错误，不做任何写死路径的回退 —— 宁可显式报错，也不要静默用错版本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 这些脚本需要加载的包，任意一个能解析成功即可反推出 node_modules 位置。
const PROBE_SPECIFIERS = ['@deepseek-ai/dsh-persona', 'js-yaml'];

function findNodeModules(resolvedFile) {
  let dir = path.dirname(resolvedFile);
  for (;;) {
    if (path.basename(dir) === 'node_modules') return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function candidateProfiles(home) {
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  add(process.env.DSH_PROFILE);
  add('web');
  add('default');
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) add(e.name);
    }
  } catch { /* profiles 目录不存在时忽略 */ }
  return names;
}

export function dshModulesDir() {
  const override = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (override) return override;

  const home = dshHome();
  for (const profile of candidateProfiles(home)) {
    const anchor = path.join(home, 'profiles', profile, 'package.json');
    if (!fs.existsSync(anchor)) continue;
    const req = createRequire(anchor);
    for (const spec of PROBE_SPECIFIERS) {
      try {
        const dir = findNodeModules(req.resolve(spec));
        if (dir) return dir;
      } catch { /* 换下一个 specifier，再换下一个 profile */ }
    }
  }

  throw new Error(
    '无法定位 DSH 安装目录下的 node_modules。\n'
    + '  请设置 DSH_INSTALL_MODULES=<DSH 安装目录>/node_modules 后重试；\n'
    + `  或设置 DSH_HOME 指向 DSH 根目录（当前解析为 ${home}）。`
  );
}

/**
 * 读取 asar 头部。返回 `{ json, dataStart }`，`dataStart` 是文件内容的起始字节。
 *
 * 格式与 `scripts/patch-dsh-session-guard.mjs` 同一套：前 16 字节含头部长度，
 * 紧随其后的 headerSize 字节是一棵 JSON 文件树；条目的 `offset` 相对 dataStart。
 * ⚠️ `offset` 超过 2^53 时会被序列化成字符串，调用方必须 `Number()` 一次。
 */
export function readAsarHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const first = Buffer.alloc(16);
    fs.readSync(fd, first, 0, 16, 0);
    const headerSize = first.readUInt32LE(12);
    const head = Buffer.alloc(headerSize);
    fs.readSync(fd, head, 0, headerSize, 16);
    return { json: JSON.parse(head.toString('utf8')), dataStart: 16 + headerSize };
  } finally {
    fs.closeSync(fd);
  }
}

function looksLikeDshAsar(filePath) {
  try {
    const { json } = readAsarHeader(filePath);
    return Boolean(json?.files?.dsh?.files?.node_modules?.files?.['@deepseek-ai']);
  } catch {
    return false;
  }
}

let asarPathCache;
let asarPathResolved = false;

/**
 * 运行中 DSH（Electron 桌面版）的 app.asar 路径；找不到返回 null。
 *
 * 为什么需要它：0.2.x 桌面版的工具包（`@deepseek-ai/dsh-tool-*`）只打包在
 * `resources/app.asar` 里，磁盘上没有对应的 node_modules 目录；`dshModulesDir()`
 * 只能反查到 npm 装的旧版本（本机实测 0.1.0-rc.6）。拿旧版本做工具名对账，会把
 * 0.2.1 里真实存在的工具误判成「拼错的假名」，测试因此常年红着（见 PITFALLS #97）。
 *
 * 解析顺序：环境变量 `DSH_ASAR` → `%LOCALAPPDATA%\Programs\*\resources\app.asar`。
 * 只读探测；找不到/读不了返回 null，调用方回退到旧逻辑，不抛错。
 */
export function dshAsarPath() {
  if (asarPathResolved) return asarPathCache;
  asarPathResolved = true;
  const override = process.env.DSH_ASAR;
  if (override) {
    asarPathCache = looksLikeDshAsar(override) ? override : null;
    return asarPathCache;
  }
  const localAppData = process.env.LOCALAPPDATA
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  if (!localAppData) return null;
  const candidates = [];
  const programs = path.join(localAppData, 'Programs');
  try {
    for (const e of fs.readdirSync(programs, { withFileTypes: true })) {
      if (e.isDirectory()) candidates.push(path.join(programs, e.name, 'resources', 'app.asar'));
    }
  } catch { /* 没有 Programs 目录就放弃 */ }
  for (const candidate of candidates) {
    if (looksLikeDshAsar(candidate)) {
      asarPathCache = candidate;
      return asarPathCache;
    }
  }
  asarPathCache = null;
  return null;
}
