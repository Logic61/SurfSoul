import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BY_ID, validateValue } from './catalog.js';

export const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function scopePaths(options = {}) {
  const root = path.resolve(options.root || process.env.SURFCORE_ROOT || process.env.SURFCORE_QQBOT_ROOT || repo);
  const dshHome = path.resolve(options.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const dir = path.join(dshHome, 'surfcore');
  const canonical = (s) => process.platform === 'win32' ? s.toLowerCase() : s;
  return {
    root, dshHome, dir, scopeId: hash([canonical(root), canonical(dshHome)]),
    state: path.join(dir, 'life-settings.json'),
    lock: path.join(dir, 'life-settings.lock'),
    backups: path.join(dir, 'life-settings-backups'),
    runtime: path.join(dir, 'life-runtime'),
    qq: path.join(root, 'config.json'),
    bili: process.env.SURFCORE_BILI_CONFIG || path.join(dir, 'bili.config.json'),
    unified: path.join(dir, 'config.json'),
  };
}
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw new Error('CORRUPT_FILE: ' + path.basename(file), { cause: error });
  }
}
export function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    // Only this exact, newly-created temporary file is eligible for cleanup.
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
export function emptyState(paths) {
  return { schema: 1, scopeId: paths.scopeId, revision: 0, overrides: {}, history: [], plans: [], observations: [] };
}
export function readState(paths) {
  const state = readJson(paths.state, emptyState(paths));
  if (state?.schema !== 1 || state.scopeId !== paths.scopeId || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    !state.overrides || Array.isArray(state.overrides) || typeof state.overrides !== 'object' ||
    !['history','plans','observations'].every((k) => Array.isArray(state[k]))) throw new Error('INVALID_STATE_OR_SCOPE: 保留现场，禁止自动覆盖');
  for (const [id, value] of Object.entries(state.overrides)) {
    const p = BY_ID.get(id);
    if (!p) throw new Error('UNKNOWN_OVERRIDE: ' + id);
    validateValue(p, value);
  }
  return state;
}
export function withStateLock(paths, action) {
  fs.mkdirSync(paths.dir, { recursive: true });
  try { fs.mkdirSync(paths.lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('CONFIG_BUSY: 另一写入者或未恢复的锁存在；重试或让维护者检查锁');
    throw error;
  }
  const owner = path.join(paths.lock, 'owner.json');
  try {
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    return action(readState(paths));
  } finally {
    // Never recursively delete a computed path or someone else's lock.
    if (fs.existsSync(owner)) fs.unlinkSync(owner);
    fs.rmdirSync(paths.lock);
  }
}
/**
 * 本地化增强（IMPL-SPEC §3 file-store 行）：崩溃遗留锁的**受控**恢复。
 *
 * 参考实现只有人工 CLI 才能隔离遗留锁；桥接/插件崩溃极可能留下锁，之后所有写工具都会
 * CONFIG_BUSY。这里把「判断 + 隔离」收成一个函数，供 bridge 启动自检与 CLI `recover-lock` 共用：
 *   · 只有 owner.json 里 pid 明确且该进程已死，才 rename 锁目录到 `.abandoned-<ts>` 隔离；
 *   · owner 不明 / 进程还活着 → 一律不碰（保留现场，人工检查）。
 * rename 到隔离目录而不是删除，必要时可人工还原。
 */
export function recoverStaleLock(paths) {
  const lock = paths.lock;
  if (!fs.existsSync(lock)) return { recovered: false, reason: 'no-lock' };
  let owner = null;
  try { owner = readJson(path.join(lock, 'owner.json'), null); } catch { owner = null; }
  if (!owner || !Number.isInteger(owner.pid) || owner.pid < 1) return { recovered: false, reason: 'owner-unknown' };
  let alive = false;
  try { process.kill(owner.pid, 0); alive = true; } catch {}
  if (alive) return { recovered: false, reason: 'owner-alive', owner };
  const quarantine = lock + '.abandoned-' + Date.now();
  fs.renameSync(lock, quarantine);
  return { recovered: true, quarantine, owner };
}
export function saveState(paths, state) {
  if (fs.existsSync(paths.state)) {
    fs.mkdirSync(paths.backups, { recursive: true });
    fs.copyFileSync(paths.state, path.join(paths.backups, 'r' + state.revision + '-' + randomUUID() + '.json'), fs.constants.COPYFILE_EXCL);
  }
  atomicWrite(paths.state, state);
}
export function sourceFingerprint(paths) {
  // Hash only; never return whole base configurations, credentials or private prompts.
  return hash([paths.qq, paths.bili, paths.unified].map((file) => {
    try { return hash(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
  }));
}
