/**
 * Runtime reader/proof channel. Import has no I/O or model/network side effect.
 * Producer evidence is not an LLM self-report and is never synthesized by manager.apply().
 *
 * 本地化增强（IMPL-SPEC §3 runtime 行）：
 *   · applyManagedSettings / settingsRevision / readRuntimeEvidence 内部按 `${mtime,size}` 缓存，
 *     避免 B站每 tick、QQ 每 5s 反复同步解析同一份 JSON。
 *   · fail-safe：sidecar 坏 / 读失败时**不向消费者抛错**，返回最后一次成功读取的 overrides /
 *     revision，并记一条 warn（同一处失败只提示一次，避免 refresh 刷屏）。消费者（插件 config()、
 *     whale-night CLI）不再被一个坏 state 拖垮；同时也不会把「没读到」伪装成「采用成功」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PARAMETERS, getPath, setPath, validateValue } from './catalog.js';
import { scopePaths, readState, readJson, atomicWrite } from './file-store.js';
import { budgetSnapshot } from './budget.js';

const instanceId = randomUUID();
const stateCache = new Map(); // state file -> { stamp, revision, overrides }
const evidenceCache = new Map(); // evidence file -> { stamp, value }
const warned = new Map(); // file -> 上次失败信息（去重）

const statStamp = (file) => {
  try {
    const stat = fs.statSync(file);
    return stat.mtimeMs + ':' + stat.size;
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    return 'stat-error:' + (error.code || 'unknown');
  }
};

function warnOnce(options, key, message) {
  if (warned.get(key) === message) return;
  warned.set(key, message);
  if (typeof options?.warn === 'function') options.warn(message);
  else console.warn(message);
}

/**
 * fail-safe 读取受管 state：成功则更新缓存；失败则回退缓存并 warn（永不抛错）。
 * 返回 { revision, overrides, stamp, failed?, error? }。overrides 只读（已冻结）。
 */
export function readManagedState(options = {}) {
  const paths = scopePaths(options);
  const stamp = statStamp(paths.state);
  const cached = stateCache.get(paths.state);
  if (cached && cached.stamp === stamp) return cached;
  try {
    const state = readState(paths);
    const next = { stamp, revision: state.revision, overrides: Object.freeze({ ...state.overrides }) };
    stateCache.set(paths.state, next);
    warned.delete(paths.state);
    return next;
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 180);
    warnOnce(options, paths.state, '[life-settings] ' + path.basename(paths.state) + ' 读取失败（' + detail + '），沿用上次成功读取的 managed overrides' + (cached ? '（revision ' + cached.revision + '）' : '（无历史缓存，按无覆盖处理）'));
    return { ...(cached || { stamp: 'failed', revision: 0, overrides: Object.freeze({}) }), failed: true, error: detail };
  }
}

export const parametersForDomain = (domain) => PARAMETERS.filter((p) => p.domain === domain);
export function settingsRevision(options = {}) {
  return readManagedState(options).revision;
}
export function applyManagedSettings(config, domain, options = {}) {
  const managed = readManagedState(options);
  const out = structuredClone(config);
  for (const p of parametersForDomain(domain)) {
    if (Object.hasOwn(managed.overrides, p.id)) setPath(out, p.path, managed.overrides[p.id]);
  }
  return out;
}
export function extractManagedValues(config, domain) {
  const out = {};
  for (const p of parametersForDomain(domain)) {
    const value = getPath(config, p.path);
    if (value !== undefined) out[p.id] = structuredClone(value);
  }
  return out;
}
export function publishRuntimeEvidence(producer, snapshot, options = {}) {
  if (!['qq','bili'].includes(producer)) throw new Error('UNKNOWN_PRODUCER');
  const paths = scopePaths(options);
  const revision = snapshot.revision ?? settingsRevision(options);
  const values = {};
  for (const p of PARAMETERS.filter((p) => p.evidenceProducer === producer)) {
    if (Object.hasOwn(snapshot.values || {}, p.id)) {
      // validateValue 仍会抛错：发布方自己给出非法值属于代码缺陷，不该静默。
      validateValue(p, snapshot.values[p.id]);
      values[p.id] = structuredClone(snapshot.values[p.id]);
    }
  }
  const evidence = {
    schema: 1, scopeId: paths.scopeId, producer, instanceId, pid: process.pid,
    revision, observedAt: new Date().toISOString(), values,
    details: snapshot.details || {},
  };
  const file = path.join(paths.runtime, producer + '.json');
  atomicWrite(file, evidence);
  evidenceCache.delete(file);
  return evidence;
}
function readEvidenceJson(file, options) {
  const stamp = statStamp(file);
  const cached = evidenceCache.get(file);
  if (cached && cached.stamp === stamp) return cached.value;
  try {
    const value = readJson(file, null);
    evidenceCache.set(file, { stamp, value });
    warned.delete(file);
    return value;
  } catch (error) {
    // 坏证据 = 不可用证据，不是“采用成功”；绝不把 JSON 解析异常抛给消费者。
    evidenceCache.delete(file);
    warnOnce(options, file, '[life-settings] ' + path.basename(file) + ' 证据不可读（' + String(error?.message || error).slice(0, 160) + '），按未观察到采用处理');
    return { __unreadable: true };
  }
}
export function readRuntimeEvidence(producer, options = {}) {
  const paths = scopePaths(options);
  const file = path.join(paths.runtime, producer + '.json');
  const value = readEvidenceJson(file, options);
  if (value && value.__unreadable) return { valid: false, status: 'unreadable', producer, source: file };
  if (!value) return { valid: false, status: 'not-observed', producer };
  const ageMs = Date.now() - Date.parse(value.observedAt);
  let alive = false;
  if (Number.isInteger(value.pid) && value.pid > 0) {
    try { process.kill(value.pid, 0); alive = true; } catch {}
  }
  const valid = value.schema === 1 && value.producer === producer && value.scopeId === paths.scopeId &&
    ageMs >= -2000 && ageMs <= (options.maxAgeMs ?? 90000) && alive && value.details?.running !== false;
  return {
    ...value, valid, ageMs,
    status: valid ? (value.details?.mode === 'local-simulation' ? 'local-simulation' : 'runtime-observed') : 'stale-or-inactive',
    source: file,
  };
}
export function compactLifeState({ platform, wakeReason } = {}, options = {}) {
  try {
    const paths = scopePaths(options);
    const state = readState(paths);
    const evidence = readRuntimeEvidence(platform === 'bili' ? 'bili' : 'qq', options);
    const pending = state.history.filter((h) => h.revision === state.revision).flatMap((h) => h.changes)
      .filter((c) => !evidence.valid || evidence.revision !== state.revision || JSON.stringify(evidence.values?.[c.id]) !== JSON.stringify(c.after));
    const recent = state.history.at(-1);
    const next = evidence.details?.nextWakeAt ?? evidence.details?.nextFireAt ?? null;
    const budget=budgetSnapshot(options);
    const platformBudget=budget.scopes[platform==='bili'?'bili':'qq'];
    return '\n【生活状态｜系统事实】' + new Date().toISOString() +
      '；时区=' + Intl.DateTimeFormat().resolvedOptions().timeZone +
      '；平台=' + String(platform || 'unknown') +
      '；醒来原因=' + String(wakeReason || '调用方未提供').replace(/[\r\n]/g, ' ').slice(0, 90) +
      '；设置=r' + state.revision + '；运行证据=' + evidence.status +
      '；下一次计划=' + (next ? String(next).slice(0, 40) : '未知/按各会话计划') +
      '；最近活动='+(evidence.details?.lastActivityAt || evidence.details?.lastWakeAt || '未知') +
      '；本地预算余量='+(budget.stale?'用量过期/未知':JSON.stringify(platformBudget.remaining))+
      '；最新修改=' + (recent ? recent.id : '无') + '；待验=' + pending.length +
      '。模型思考实际 wire、平台入账与缓存命中未知时不推定。按需调用 life_state / life_catalog；默认不代表你的偏好。';
  } catch {
    return '\n【生活状态｜系统事实】设置或运行证据暂不可读，未将保存值当作生效值；请调用 life_state 查看。';
  }
}
