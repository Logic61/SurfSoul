/**
 * QQ's hot-adoption boundary. Only catalogued lifecycle fields are copied into
 * the long-lived bridge config; identity, credentials and account rights stay put.
 * Existing per-conversation choices and already scheduled timers are independent.
 *
 * 本地化增强（IMPL-SPEC §3 qq-runtime 行）：证据发布节流。
 * 参考实现每次 refresh（bridge 每 5 秒一次）都 atomicWrite 一份 qq.json —— 约 1.7 万次/天同步写盘。
 * 本地改为：仅在 revision 变化或距上次发布 ≥ evidenceIntervalMs（默认 45s）时发布；
 * 45s 仍在 verify 的 90s 证据 TTL 内，所以「运行时采用」的可见性不受影响。
 */
import {
  applyManagedSettings, extractManagedValues, settingsRevision,
  publishRuntimeEvidence, compactLifeState,
} from './runtime.js';

function configPath(id) {
  if (id.startsWith('qq.')) return id.slice(3).split('.');
  if (id.startsWith('purpose.')) return id.split('.');
  return null;
}

function assignField(config, keys, value) {
  let target = config;
  for (const key of keys.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[keys.at(-1)] = structuredClone(value);
}

export const DEFAULT_EVIDENCE_INTERVAL_MS = 45000;

export function createQqLifeRuntime({
  config, loadBaseConfig, getDetails = () => ({}), onAdopt = () => {},
  apply = applyManagedSettings, extract = extractManagedValues,
  revision = settingsRevision, publish = publishRuntimeEvidence,
  board = compactLifeState, scope = {},
  now = () => Date.now(), evidenceIntervalMs = DEFAULT_EVIDENCE_INTERVAL_MS,
} = {}) {
  let adoptedRevision = null;
  let lastError = null;
  let lastPublishedRevision = null;
  let lastPublishedAt = null;

  // 节流判定：revision 变化立即发；否则按心跳间隔。
  function evidenceDue() {
    if (lastPublishedAt === null) return true;
    if (lastPublishedRevision !== adoptedRevision) return true;
    return now() - lastPublishedAt >= evidenceIntervalMs;
  }

  function publishEvidence() {
    if (!evidenceDue()) return false;
    try {
      const details = getDetails();
      const values = extract(config, 'qq');
      // Desktop-purpose is a separate consumer. Merely adopting a value in
      // this bridge cannot prove that the desktop carrier has used it.
      if (details.purposeCarrier === 'pet' || details.configuredPurposeCarrier === 'pet') {
        for (const id of Object.keys(values)) if (id.startsWith('purpose.')) delete values[id];
      }
      publish('qq', {
        revision: adoptedRevision,
        values,
        details: { ...details, adoptionError: lastError },
      }, scope);
      lastPublishedRevision = adoptedRevision;
      lastPublishedAt = now();
      return true;
    } catch {
      // Missing telemetry is observable as missing/stale evidence, never as a
      // successful settings change. It must not break existing QQ operation.
      // 发布失败不更新时间戳：下一次 refresh 会重试。
      return false;
    }
  }

  function refresh({ publish: shouldPublish = true } = {}) {
    let changed = false;
    try {
      const before = revision(scope);
      {
        // Re-apply persisted overrides even at the same revision: a legacy
        // console endpoint may have changed the long-lived config in memory.
        // A new revision (including rollback) starts from a fresh base file.
        const next = apply(before !== adoptedRevision ? loadBaseConfig() : config, 'qq', scope);
        const values = extract(next, 'qq');
        if (revision(scope) !== before) {
          // Never label values read from another revision as adopted.
          return { changed: false, revision: adoptedRevision, retry: true };
        }
        const previousValues = extract(config, 'qq');
        const changedIds = Object.keys(values).filter((id) => JSON.stringify(values[id]) !== JSON.stringify(previousValues[id]));
        for (const [id, value] of Object.entries(values)) {
          const keys = configPath(id);
          if (keys && value !== undefined) assignField(config, keys, value);
        }
        changed = before !== adoptedRevision || changedIds.length > 0;
        const oldRevision = adoptedRevision;
        adoptedRevision = before;
        if (oldRevision !== before || changedIds.length > 0) onAdopt({ revision: adoptedRevision, values, previousValues, changedIds });
      }
      lastError = null;
    } catch (error) {
      // Preserve the last working in-memory settings. A corrupt/new revision is
      // not silently reported as adopted and cannot interrupt a queued reply.
      lastError = String(error?.code || 'life-settings-unavailable');
    }
    if (shouldPublish && adoptedRevision !== null) publishEvidence();
    return { changed, revision: adoptedRevision, error: lastError };
  }

  function stateBlock(wakeReason = 'conversation') {
    try { return String(board({ platform: 'qq', wakeReason }, scope) || ''); }
    catch { return '【生活参数状态】状态证据暂不可读；不要把已保存配置当成实际生效。'; }
  }

  return { refresh, stateBlock, get revision() { return adoptedRevision; } };
}
