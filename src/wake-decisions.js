// 唤醒决策流水（2026-11-03）
//
// 解决的问题：桥接以前只把「为什么醒 / 为什么没醒」写成 bridge.log 里的中文自由文本，
// 排查「她今天怎么又不搭话」只能肉眼翻日志（HANDOFF 里至少两次）。这里把每个决策点
// 落成一行 JSONL，控制台可以按原因/闸门聚合，既省排查时间，也能拿来调参与度。
//
// 设计约束：
//   · **写失败绝不影响唤醒主流程**：所有 fs 异常都吞掉（返回 false），桥接继续跑。
//   · 只 append 一行；文件超过 maxBytes 才滚动一次（保留最近 maxLines 条），避免写放大。
//   · 读取端容错：坏行跳过；limit/时间过滤在读取时做，不改变文件。
//   · 纯逻辑 + 注入路径，可离线单测（不 import 桥接的全局状态）。
import fs from 'node:fs';
import path from 'node:path';

/** 默认文件名（放在桥接的 state/ 下）。 */
export const WAKE_DECISION_FILE = 'wake-decisions.jsonl';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_KEEP_LINES = 5000;

/** 事件类型：一次唤醒在流水里的角色。 */
export const WAKE_DECISION_EVENTS = Object.freeze([
  'delivered',   // 真正投递给 DSH（session.prompt 被接受）
  'queued',      // DSH 不在线，已入内存补投队列
  'failed',      // 投递被拒/抛错
  'skip',        // 某个闸门直接放弃（gate 字段说明是哪道）
  'deferred',    // 暂时压住、稍后补（busy / 限频）；不是放弃
  'turn',        // 回合结束时的行动/静置统计（event=turn, action=acted|none）
]);

/** 已知闸门名（gate 字段）；新增时同步控制台文案。 */
export const WAKE_DECISION_GATES = Object.freeze([
  'disabled',      // socialV2.enabled=false
  'paused',        // 管理员暂停
  'mode',          // 当前不是 reserved2
  'session',       // 会话不在白名单/模式允许范围
  'fish',          // 鱼群保护
  'tokenGuard',    // 唤醒次数/每日花费闸
  'busy',          // 上一回合还没结束
  'rateLimit',     // 每分钟/每小时唤醒上限
  'merged',        // 批处理窗口内已有一条待唤醒
  'dshOffline',    // DSH 不在线（入队）
]);

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 创建流水写入器。
 *
 * @param {string} filePath 目标 JSONL 文件（父目录不存在会 mkdir -p）
 * @param {{maxBytes?: number, keepLines?: number, now?: () => number, fsImpl?: object}} [options]
 * @returns {{filePath: string, record: (entry: object) => boolean, read: (opts?: object) => object[]}}
 */
export function createWakeDecisionLog(filePath, options = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, keepLines = DEFAULT_KEEP_LINES, now = Date.now, fsImpl = fs } = options;
  let failedOnce = false;

  function trimIfNeeded() {
    let size = 0;
    try { size = fsImpl.statSync(filePath).size; } catch { return; }
    if (size <= maxBytes) return;
    try {
      const lines = fsImpl.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      const kept = lines.slice(-keepLines).join('\n') + '\n';
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      fsImpl.writeFileSync(tmp, kept, { mode: 0o600 });
      fsImpl.renameSync(tmp, filePath);
    } catch { /* 滚动失败不致命：下次再试 */ }
  }

  function record(entry = {}) {
    try {
      if (!failedOnce) fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload = {
        t: now(),
        ...entry,
      };
      // 去掉 undefined，保持每行紧凑（JSON.stringify 会丢弃 undefined 值，这里只是显式）。
      for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
      fsImpl.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      trimIfNeeded();
      return true;
    } catch {
      failedOnce = true; // 第一次失败后不再反复 mkdir/写，避免每条消息都抛一次
      return false;
    }
  }

  /**
   * 读取最近 entries（旧 → 新）。
   * @param {{limit?: number, key?: string, since?: number, event?: string}} [opts]
   */
  function read(opts = {}) {
    const { limit = 200, key, since = 0, event } = opts;
    let text = '';
    try { text = fsImpl.readFileSync(filePath, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== 'object') continue;
      if (key && entry.key !== key) continue;
      if (event && entry.event !== event) continue;
      if (since > 0 && safeNumber(entry.t) < since) continue;
      out.push(entry);
    }
    const n = Math.max(1, Math.min(2000, safeNumber(limit, 200)));
    return out.slice(-n);
  }

  return { filePath, record, read };
}

/** 中文标题：给控制台/摘要用（gate 的 key 是稳定的英文，展示时映射）。 */
export const WAKE_GATE_LABELS = Object.freeze({
  disabled: '二代总开关关闭',
  paused: '管理员暂停',
  mode: '当前不是 reserved2',
  session: '会话不在白名单/模式范围',
  fish: '鱼群保护',
  tokenGuard: '唤醒次数/花费闸',
  busy: '上一回合未结束',
  rateLimit: '唤醒频率超限',
  merged: '批处理窗口内合并',
  dshOffline: 'DSH 离线（入队）',
});

export const WAKE_EVENT_LABELS = Object.freeze({
  delivered: '已投递',
  queued: '已入队',
  failed: '投递失败',
  skip: '跳过',
  deferred: '压后重试',
  turn: '回合结束',
});

/** 按事件/闸门/唤醒原因聚合；默认只看最近 windowMs。 */
export function summarizeWakeDecisions(entries, { now = Date.now(), windowMs = 24 * 3600 * 1000 } = {}) {
  const since = now - Math.max(0, safeNumber(windowMs, 24 * 3600 * 1000));
  const scoped = (entries ?? []).filter((e) => safeNumber(e?.t) >= since);
  const byEvent = {};
  const byGate = {};
  const byReason = {};
  let lastAt = 0;
  for (const entry of scoped) {
    const event = String(entry.event ?? '');
    byEvent[event] = (byEvent[event] ?? 0) + 1;
    if (entry.gate) byGate[entry.gate] = (byGate[entry.gate] ?? 0) + 1;
    const baseReason = String(entry.reason ?? '').split(':')[0];
    if (baseReason) byReason[baseReason] = (byReason[baseReason] ?? 0) + 1;
    lastAt = Math.max(lastAt, safeNumber(entry.t));
  }
  const top = (obj, n = 5) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    windowMs,
    total: scoped.length,
    byEvent,
    byGate: top(byGate, 10),
    byReason: top(byReason, 10),
    turns: scoped.filter((e) => e.event === 'turn').length,
    silentTurns: scoped.filter((e) => e.event === 'turn' && e.action === 'none').length,
    silentWithoutWait: scoped.filter((e) => e.event === 'turn' && e.action === 'none' && !e.waitSatisfied).length,
    lastAt,
  };
}
