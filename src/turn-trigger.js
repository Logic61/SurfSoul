// 本回合触发者归因（bridge 侧纯函数）。
//
// 背景：工具场景放宽后，「这一轮是不是主人本人触发的」必须由桥接**用真实 sender QQ 算出来**，
// 再落成只读状态文件 state/turn-triggers.json 给 DSH 插件消费（见 _recon/design.md §2）。
// 群友无法伪造 event.user_id，所以这条归因是 prompt injection 挡不住的那道硬边界；
// 模型审批只是启发式安全层。
//
// ⚠️ 字段契约（design.md §2.1）以本文件为准。`plugins/surfcore/lib/turn-trigger.js` 是插件侧
// 的**另一份实现**（桥接和 DSH 插件是两个进程、两个包，运行时不能共享模块），字段名/语义
// 必须保持一致：改这里的字段必须同步改那边，否则审批层会把归因读成空 → 全部 fail-closed。
//
// 约定：
//   · 本文件只做纯计算，不读文件、不打日志、不碰全局状态（方便测试与复用）。
//   · trigger.text / recent[].text 由调用方传入 sanitizeText 脱敏（桥接侧传 redactSensitiveText），
//     本文件只做长度截断与控制字符清理；不写 media/forward/token 等敏感字段。
//   · 所有判定默认 fail-closed：缺字段、类型不对、时间戳可疑 → 不视为主人回合。

export const TURN_TRIGGER_VERSION = 1;
/** sessions 上限（按 updatedAt 保留最新）。 */
export const TURN_TRIGGER_MAX_SESSIONS = 50;
/** 文件条目 TTL：启动加载/重写时丢弃更久以前的条目。 */
export const TURN_TRIGGER_TTL_MS = 24 * 60 * 60 * 1000;
/** trigger.text 上限（纯文本、已脱敏）。 */
export const TRIGGER_TEXT_MAX = 200;
/** recent 最多几条、每条多少字。 */
export const RECENT_MAX = 4;
export const RECENT_TEXT_MAX = 120;
/** groupName 只是给人看的诊断字段，截短即可。 */
export const GROUP_NAME_MAX = 60;

/**
 * 非消息触发的唤醒原因：这类唤醒即使「最近一条入站消息」是主人说的，也**不算主人触发回合**。
 *
 * 用户/Lead 拍板（design.md §2.2）：`bootstrap` 是「第一条入站消息」触发的，算消息触发；
 * `poke` 虽然是真实用户事件，但它不是「明确要求」，fail-closed 归到这里；
 * `recovery`（重启恢复）同理。
 * 注意：不要复用 bridge.js 的 TIMER_WAKE_REASONS（它含 bootstrap，语义不同）。
 */
export const NON_MESSAGE_WAKE_REASONS = Object.freeze([
  'timeout',
  'replyCheck',
  'proactiveCheck',
  'admin',
  'history',
  'friendRequest',
  'recovery',
  'poke',
]);

/** 本回合授权的默认窗口（design.md §4：config.socialV2.toolApproval.triggerWindowMs）。 */
export const DEFAULT_TRIGGER_WINDOW_MS = 10 * 60 * 1000;

/** 工具模型审批配置默认值（bridge 侧只负责归一/展示；真正的审批在 DSH 插件里）。 */
export const DEFAULT_TOOL_APPROVAL_CONFIG = Object.freeze({
  enabled: true,
  failClosed: true,
  model: '',
  maxTokens: 320,
  timeoutMs: 20000,
  maxReviewsPerTurn: 6,
  triggerWindowMs: DEFAULT_TRIGGER_WINDOW_MS,
  claimSandboxApproval: true,
});

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 归一化 `socialV2.toolApproval`（design.md §4）。
 *
 * 缺省 = 设计默认（enabled=true）；`failClosed` 只接受 true —— 传 false 会被忽略并保持 true，
 * 调用方负责在发现用户显式写了 false 时打一条日志（本函数是纯函数，不打日志）。
 * 数值一律 clamp，坏值回落默认，避免 NaN 让审批窗口/预算失效。
 */
export function normalizeToolApprovalConfig(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    enabled: src.enabled !== false,
    failClosed: true,
    model: typeof src.model === 'string' ? src.model.trim().slice(0, 200) : '',
    maxTokens: clampInt(src.maxTokens, DEFAULT_TOOL_APPROVAL_CONFIG.maxTokens, 128, 1024),
    timeoutMs: clampInt(src.timeoutMs, DEFAULT_TOOL_APPROVAL_CONFIG.timeoutMs, 5000, 30000),
    maxReviewsPerTurn: clampInt(src.maxReviewsPerTurn, DEFAULT_TOOL_APPROVAL_CONFIG.maxReviewsPerTurn, 1, 12),
    triggerWindowMs: clampInt(src.triggerWindowMs, DEFAULT_TOOL_APPROVAL_CONFIG.triggerWindowMs, 60 * 1000, 30 * 60 * 1000),
    claimSandboxApproval: src.claimSandboxApproval !== false,
  };
}

/** 该 wakeReason 是否属于「非消息触发」（见 NON_MESSAGE_WAKE_REASONS）。 */
export function isNonMessageWakeReason(reason) {
  return NON_MESSAGE_WAKE_REASONS.includes(String(reason ?? ''));
}

/**
 * 纯文本清洗 + 截断：去掉控制字符、折叠空白；按**码点**截断，避免把 emoji 劈成半个。
 * 注意这里不是脱敏（脱敏由调用方的 sanitizeText 完成）。
 */
export function truncatePlainText(value, max) {
  const raw = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  const chars = Array.from(raw);
  return chars.length > max ? chars.slice(0, max).join('') : raw;
}

function isInboundMessage(message) {
  return Boolean(message) && typeof message === 'object' && message.isSelf !== true;
}

function messageTime(message) {
  const candidates = [message?.time, message?.at, message?.receivedAt];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function messageSeq(message) {
  const n = Number(message?.seq);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function messageUserId(message) {
  const value = message?.userId ?? message?.user_id ?? '';
  return value == null ? '' : String(value);
}

function messageText(message) {
  const value = message?.plain ?? message?.text ?? message?.tail ?? '';
  return value == null ? '' : String(value);
}

/** 同一条消息在「快照/未读/recentMessages」里的身份键（用于跨列表去重）。 */
function messageIdentityKey(message) {
  const messageId = message?.messageId;
  if (messageId != null && String(messageId) !== '') return `mid:${String(messageId)}`;
  const seq = messageSeq(message);
  if (seq > 0) return `seq:${seq}`;
  const time = messageTime(message);
  if (time > 0) return `t:${time}|u:${messageUserId(message)}`;
  return '';
}

function collectInboundLists(snapshot, recentMessages) {
  const lists = [];
  if (snapshot && typeof snapshot === 'object') {
    if (Array.isArray(snapshot.messages)) lists.push(snapshot.messages);
    if (Array.isArray(snapshot.recent)) lists.push(snapshot.recent);
  }
  if (Array.isArray(recentMessages)) lists.push(recentMessages);
  return lists;
}

/**
 * 选出「本回合最新一条入站消息」（不含自己发的）。
 *
 * 数据源优先级：唤醒快照（messages = 未读、recent = 读过的上下文）→ 会话 recentMessages。
 * 跨列表按消息自身 time 取最新；没有 time 的旧数据按出现顺序取最后一条（fail-safe 的兜底）。
 * 返回 null 表示没有可归因的入站消息（→ 调用方必须 fail-closed）。
 */
export function selectLatestInbound(snapshot, recentMessages) {
  let best = null;
  let bestTime = -1;
  let fallback = null;
  for (const list of collectInboundLists(snapshot, recentMessages)) {
    for (const message of list) {
      if (!isInboundMessage(message)) continue;
      const time = messageTime(message);
      if (time > 0) {
        if (time >= bestTime) {
          best = message;
          bestTime = time;
        }
      } else {
        fallback = message;
      }
    }
  }
  return best ?? fallback;
}

/**
 * 选出「本回合快照里最近几条入站消息」（含非 owner；给审批层判断主人是否真的在要求）。
 * 按 time 升序，取最后 max 条；时间戳缺失的按出现顺序稳定排序。
 * 同一批消息可能同时出现在快照 messages / recent / recentMessages 里，按身份键去重。
 */
export function selectRecentInbound(snapshot, recentMessages, max = RECENT_MAX) {
  const limit = clampInt(max, RECENT_MAX, 0, 20);
  if (limit <= 0) return [];
  const items = [];
  const seen = new Set();
  for (const list of collectInboundLists(snapshot, recentMessages)) {
    for (const message of list) {
      if (!isInboundMessage(message)) continue;
      const dedupeKey = messageIdentityKey(message);
      if (dedupeKey) {
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
      }
      items.push({ message, time: messageTime(message), order: items.length });
    }
  }
  items.sort((a, b) => (a.time - b.time) || (a.order - b.order));
  return items.slice(-limit).map((item) => item.message);
}

function safeTimestamp(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/**
 * 规范化一条 TriggerRecord（design.md §2.1）。
 *
 * **白名单式重建**：只保留契约里的字段，绝不透传 media / forward / token 等敏感内容。
 * 返回 null 表示不是合法记录（key 非法等），调用方必须丢弃而不是放行。
 */
export function normalizeTriggerRecord(record, { now = Date.now() } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const key = String(record.key ?? '').trim();
  if (!/^(group|private):\d+$/.test(key)) return null;
  const kind = key.startsWith('group:') ? 'group' : 'private';
  const updatedAt = safeTimestamp(record.updatedAt, now);
  let trigger = null;
  if (record.trigger && typeof record.trigger === 'object' && !Array.isArray(record.trigger)) {
    const raw = record.trigger;
    trigger = {
      userId: messageUserId(raw),
      isOwner: raw.isOwner === true,
      at: safeTimestamp(raw.at, updatedAt),
      seq: messageSeq(raw),
      messageId: raw.messageId == null ? '' : String(raw.messageId).slice(0, 64),
      text: truncatePlainText(raw.text, TRIGGER_TEXT_MAX),
      direct: raw.direct === true,
      quoteSelf: raw.quoteSelf === true,
    };
  }
  const recent = [];
  if (Array.isArray(record.recent)) {
    for (const item of record.recent.slice(-RECENT_MAX)) {
      if (!item || typeof item !== 'object') continue;
      recent.push({
        sender: truncatePlainText(item.sender, 80),
        userId: messageUserId(item),
        isOwner: item.isOwner === true,
        text: truncatePlainText(item.text, RECENT_TEXT_MAX),
        at: safeTimestamp(item.at, updatedAt),
      });
    }
  }
  return {
    key,
    kind,
    groupName: truncatePlainText(record.groupName, GROUP_NAME_MAX),
    turnActive: record.turnActive === true,
    wakeReason: truncatePlainText(record.wakeReason, 40),
    trigger,
    ownerInBatch: record.ownerInBatch === true,
    recent,
    updatedAt,
  };
}

/**
 * 构造一条 TriggerRecord（bridge 在投递 prompt 时调用）。
 *
 * @param {object} options
 * @param {string} options.key         会话 key（group:xxx / private:xxx）
 * @param {string} [options.kind]      group / private（缺省从 key 推导）
 * @param {string} [options.groupName] 群名（仅诊断，可空）
 * @param {string} [options.wakeReason] 本次唤醒原因（'' = 非唤醒投递）
 * @param {string} [options.mode]      当前桥接模式（写进记录，插件侧按它判断 reserved2）
 * @param {object|null} [options.snapshot] buildWakeSnapshotV2 的产物
 * @param {Array} [options.recentMessages] socialV2 会话的 recentMessages
 * @param {number} [options.now]
 * @param {(text:string)=>string} [options.sanitizeText] 脱敏函数（桥接传 redactSensitiveText）
 */
export function buildTriggerRecord({
  key,
  kind = '',
  groupName = '',
  wakeReason = '',
  mode = '',
  snapshot = null,
  recentMessages = [],
  now = Date.now(),
  sanitizeText = (value) => value,
} = {}) {
  const safeKey = String(key ?? '').trim();
  if (!/^(group|private):\d+$/.test(safeKey)) return null;
  const safeKind = kind === 'group' || kind === 'private'
    ? kind
    : (safeKey.startsWith('group:') ? 'group' : 'private');
  const sanitize = (value) => {
    const text = String(value ?? '');
    try {
      return String(sanitizeText(text) ?? text);
    } catch {
      return text;
    }
  };
  const reason = String(wakeReason ?? '').slice(0, 40);
  const nonMessageWake = isNonMessageWakeReason(reason);
  const latest = selectLatestInbound(snapshot, recentMessages);
  const inbound = [];
  for (const list of collectInboundLists(snapshot, recentMessages)) {
    for (const message of list) if (isInboundMessage(message)) inbound.push(message);
  }
  const ownerInBatch = inbound.some((message) => message.isOwner === true);
  const quoteSelf = latest?.quoteTargetIsSelf === true;
  const reasonText = String(reason);
  const direct = quoteSelf
    || reasonText.startsWith('keyword')
    || ['atMention', 'nameMention', 'question', 'poke', 'private', 'admin'].includes(reasonText);
  const trigger = latest ? {
    userId: messageUserId(latest),
    // 定时/系统类唤醒即使最近一条是主人说的也不算「主人触发」（design.md §2.2）。
    isOwner: latest.isOwner === true && !nonMessageWake,
    at: messageTime(latest) || now,
    seq: messageSeq(latest),
    messageId: latest.messageId == null ? '' : String(latest.messageId),
    text: truncatePlainText(sanitize(messageText(latest)), TRIGGER_TEXT_MAX),
    direct,
    quoteSelf,
  } : null;
  const recent = selectRecentInbound(snapshot, recentMessages, RECENT_MAX).map((message) => ({
    sender: truncatePlainText(message.sender, 80),
    userId: messageUserId(message),
    isOwner: message.isOwner === true,
    text: truncatePlainText(sanitize(messageText(message)), RECENT_TEXT_MAX),
    at: messageTime(message) || now,
  }));
  return normalizeTriggerRecord({
    key: safeKey,
    kind: safeKind,
    groupName,
    turnActive: false,
    wakeReason: reason,
    trigger,
    ownerInBatch,
    recent,
    updatedAt: now,
  }, { now });
}

/**
 * 组装 state/turn-triggers.json 的完整对象（bridge 是唯一写者）。
 *
 * @param {object} options
 * @param {string} options.mode      当前桥接模式
 * @param {string} options.ownerKey  `private:<ownerQQ>`（未配置 ownerQQ 时为空串）
 * @param {Array<{sessionId:string, turnActive:boolean, record:object}>} options.entries
 * @param {number} [options.now]
 * @param {number} [options.maxSessions]
 * @param {number} [options.ttlMs]
 */
export function buildTurnTriggerState({
  mode = '',
  ownerKey = '',
  entries = [],
  now = Date.now(),
  maxSessions = TURN_TRIGGER_MAX_SESSIONS,
  ttlMs = TURN_TRIGGER_TTL_MS,
} = {}) {
  const limit = clampInt(maxSessions, TURN_TRIGGER_MAX_SESSIONS, 1, 500);
  const fresh = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const sessionId = String(entry.sessionId ?? '').trim();
    if (!sessionId) continue;
    // 排序用「记录产生时间」，落盘 updatedAt 统一刷新成写文件时刻（文件是快照，不是历史）。
    const producedAt = safeTimestamp(entry.record?.updatedAt, now);
    const record = normalizeTriggerRecord(
      { ...(entry.record ?? {}), turnActive: entry.turnActive === true, updatedAt: now },
      { now },
    );
    if (!record) continue;
    if (ttlMs > 0 && producedAt > 0 && now - producedAt > ttlMs) continue;
    fresh.push({ sessionId, record, producedAt });
  }
  // 按最近更新排，保留最新 maxSessions 个（设计 §2.1：sessions 最多 50 条）。
  fresh.sort((a, b) => (a.producedAt - b.producedAt));
  const kept = fresh.slice(-limit);
  const sessions = {};
  for (const item of kept) sessions[item.sessionId] = item.record;
  return {
    version: TURN_TRIGGER_VERSION,
    updatedAt: now,
    mode: String(mode ?? ''),
    ownerKey: String(ownerKey ?? ''),
    sessions,
  };
}

/**
 * 启动加载时的清理：丢弃 24h 未更新的条目、只保留最新 maxSessions 个，
 * 并且把 turnActive 强制归零 —— 桥接刚启动时内存里不存在任何在途回合，
 * 磁盘上残留的 turnActive=true 绝不能沿用来授权（fail-closed）。
 */
export function pruneTurnTriggerState(state, {
  now = Date.now(),
  ttlMs = TURN_TRIGGER_TTL_MS,
  maxSessions = TURN_TRIGGER_MAX_SESSIONS,
  forceInactive = true,
} = {}) {
  const limit = clampInt(maxSessions, TURN_TRIGGER_MAX_SESSIONS, 1, 500);
  const source = (state && typeof state === 'object' && state.sessions
    && typeof state.sessions === 'object' && !Array.isArray(state.sessions)) ? state.sessions : {};
  const entries = [];
  for (const [sessionId, record] of Object.entries(source)) {
    const normalized = normalizeTriggerRecord(record, { now });
    if (!normalized) continue;
    if (ttlMs > 0 && now - normalized.updatedAt > ttlMs) continue;
    entries.push({
      sessionId,
      record: { ...normalized, turnActive: forceInactive ? false : normalized.turnActive },
    });
  }
  entries.sort((a, b) => a.record.updatedAt - b.record.updatedAt);
  const sessions = {};
  for (const item of entries.slice(-limit)) sessions[item.sessionId] = item.record;
  return {
    version: TURN_TRIGGER_VERSION,
    updatedAt: now,
    mode: String(state?.mode ?? ''),
    ownerKey: String(state?.ownerKey ?? ''),
    sessions,
  };
}

/**
 * 「有效主人回合」判定（design.md §1.4 / Lead 补充要求）。
 *
 * 规则：
 *   · `key === ownerKey`（主人私聊）→ true：沿用旧语义，不依赖归因文件；
 *   · 别人私聊 → false（永远）；
 *   · 其它（群聊）→ 必须：mode === reserved2、turnActive === true、trigger.isOwner === true、
 *     且 trigger.at 在 windowMs 内（未来时间只容忍一分钟时钟偏差）。
 *
 * 缺任何字段 → false（fail-closed）。
 */
export function isOwnerTurnFromRecord(record, {
  ownerKey = '',
  mode = '',
  now = Date.now(),
  windowMs = DEFAULT_TRIGGER_WINDOW_MS,
  expectedKey = '',
} = {}) {
  const owner = String(ownerKey ?? '');
  const wanted = String(expectedKey ?? '');
  // 主人私聊：沿用旧语义，不依赖归因文件（record 可以为 null）。
  if (wanted && owner && wanted === owner) return true;
  const key = String(record?.key ?? '');
  if (!key) return false;
  if (wanted && key !== wanted) return false;
  if (owner && key === owner) return true;
  if (String(mode) !== 'reserved2') return false;
  if (!owner) return false;
  if (key.startsWith('private:')) return false;
  if (record.turnActive !== true) return false;
  const trigger = record.trigger;
  if (!trigger || typeof trigger !== 'object' || trigger.isOwner !== true) return false;
  const at = Number(trigger.at);
  if (!Number.isFinite(at) || at <= 0) return false;
  const age = now - at;
  if (age < -60 * 1000) return false;
  const window = clampInt(windowMs, DEFAULT_TRIGGER_WINDOW_MS, 60 * 1000, 30 * 60 * 1000);
  return age <= window;
}
