// 发送前评审（surfcore 自己的 reviewer，2026-11-01 用户要求）。
//
// 为什么必须放在「发送前」：
//   QQ 的回复是**回合内**用 qq_send_message / qq_send_burst 工具发出去的；
//   DSH 的 turn-stopping 评审发生在回合结束——那时消息已经到群里了。
//   低于阈值只能再补一条「更正版」，实测一回合发出 1+2 条意思差不多的（用户明确要求别这样）。
//   所以评审搬进桥接：发之前先审，不过就**不发**，把理由作为工具错误返回给模型改写后再发；
//   QQ 上只会出现最终通过的那一条。
//
// 上下文（用户要求：情景 + 高度抽象记忆卡，并做 token 权衡）：
//   · 场合/状态：群聊还是私聊、群名、角色名、时间；近 10 分钟群友发言量/钓鱼号数量、
//     收尾冷却、群聊参与度提示；最近几条对话（谁说了什么）。
//   · 记忆卡：把现有的记忆卡注入块（memory-card-prompt-qq.md）压成一段**高度抽象摘要**
//     （她是谁/关系/经历/雷区/说话风格），落盘缓存——只有源文件变了或超过
//     memoryRefreshMs（默认 12h）才重新压缩，避免每次发送都烧一遍大 prompt。
//   · 说话习惯：style-notes 注入块截断。
//   · 预算：sceneMaxChars 420 + memoryMaxChars 620 + styleMaxChars 140 ≈ 1200 字
//     （用户选的中档），全部可在 config.json 的 socialV2.review 里调。
//
// 安全阀：
//   · 评审调用失败/解析失败/超时 → 默认 failOpen=true，直接放行（宁可漏审也不堵住消息）。
//   · 同一个 key 通过一次后 skipAfterPassMs（默认 2 分钟）内的后续发送不再审（避免一回合多条反复烧钱）。
//   · 同一 key 在 reviewWindowMs（默认 10 分钟）内被退回 maxRejects 次后放行，防止模型死循环。
//   · 合计短于 minChars（默认 8 字）的消息不审（"嗯""好"这种不值得花钱）。
//
// 本文件保持无桥接依赖（只依赖 node 内置模块），便于离线单测。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PRESEND_REVIEW_VERSION = 1;

/** 默认配置；config.json 的 socialV2.review 覆盖。 */
export const DEFAULT_PRESEND_REVIEW_CONFIG = Object.freeze({
  enabled: false,
  threshold: 80,
  model: '',
  maxTokens: 400,
  timeoutMs: 12000,
  sceneMaxChars: 420,
  memoryMaxChars: 620,
  styleMaxChars: 140,
  minChars: 8,
  skipAfterPassMs: 120000,
  reviewWindowMs: 600000,
  maxReviews: 8,
  maxRejects: 3,
  failOpen: true,
  parseRetries: 1,
  // 兜底：被退回后 rejectFallbackMs 内没有「重新发送成功」，就把最后一版被退回的稿子补发出去。
  // 0 = 关闭。取舍：宁可晚 90 秒发一版不够好的，也别让 QQ 上永远没回复（2026-11-01 用户拍板）。
  rejectFallbackMs: 90000,
  memoryRefreshMs: 12 * 60 * 60 * 1000,
  memorySourceMaxChars: 24000,
});

const SCENE_DIALOGUE_MAX_LINES = 4;
const SCENE_DIALOGUE_LINE_CHARS = 64;
const SCENE_STATUS_MAX_LINES = 3;
const SCENE_STATUS_LINE_CHARS = 58;
const VERDICT_REASON_MAX = 200;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 按 Unicode 字符截断并加省略号（不要按 UTF-16 切坏 emoji）。 */
export function truncateChars(value, max) {
  const text = String(value ?? '');
  const chars = [...text];
  if (max <= 0) return '';
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** 归一化 config.json 里的 socialV2.review；非法值回落默认，不做静默放宽。 */
export function normalizePresendReviewConfig(raw = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const model = typeof cfg.model === 'string' ? cfg.model.trim() : '';
  return Object.freeze({
    enabled: cfg.enabled === true,
    threshold: clampInt(cfg.threshold, DEFAULT_PRESEND_REVIEW_CONFIG.threshold, 1, 100),
    model: model.slice(0, 120),
    maxTokens: clampInt(cfg.maxTokens, DEFAULT_PRESEND_REVIEW_CONFIG.maxTokens, 200, 1200),
    timeoutMs: clampInt(cfg.timeoutMs, DEFAULT_PRESEND_REVIEW_CONFIG.timeoutMs, 3000, 30000),
    sceneMaxChars: clampInt(cfg.sceneMaxChars, DEFAULT_PRESEND_REVIEW_CONFIG.sceneMaxChars, 120, 2000),
    memoryMaxChars: clampInt(cfg.memoryMaxChars, DEFAULT_PRESEND_REVIEW_CONFIG.memoryMaxChars, 120, 2000),
    styleMaxChars: clampInt(cfg.styleMaxChars, DEFAULT_PRESEND_REVIEW_CONFIG.styleMaxChars, 0, 600),
    minChars: clampInt(cfg.minChars, DEFAULT_PRESEND_REVIEW_CONFIG.minChars, 0, 200),
    skipAfterPassMs: clampInt(cfg.skipAfterPassMs, DEFAULT_PRESEND_REVIEW_CONFIG.skipAfterPassMs, 0, 10 * 60 * 1000),
    reviewWindowMs: clampInt(cfg.reviewWindowMs, DEFAULT_PRESEND_REVIEW_CONFIG.reviewWindowMs, 60 * 1000, 60 * 60 * 1000),
    maxReviews: clampInt(cfg.maxReviews, DEFAULT_PRESEND_REVIEW_CONFIG.maxReviews, 1, 30),
    maxRejects: clampInt(cfg.maxRejects, DEFAULT_PRESEND_REVIEW_CONFIG.maxRejects, 1, 10),
    failOpen: cfg.failOpen !== false,
    parseRetries: clampInt(cfg.parseRetries, DEFAULT_PRESEND_REVIEW_CONFIG.parseRetries, 0, 2),
    rejectFallbackMs: clampInt(cfg.rejectFallbackMs, DEFAULT_PRESEND_REVIEW_CONFIG.rejectFallbackMs, 0, 10 * 60 * 1000),
    memoryRefreshMs: clampInt(cfg.memoryRefreshMs, DEFAULT_PRESEND_REVIEW_CONFIG.memoryRefreshMs, 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000),
    memorySourceMaxChars: clampInt(cfg.memorySourceMaxChars, DEFAULT_PRESEND_REVIEW_CONFIG.memorySourceMaxChars, 1000, 48000),
  });
}

// ── 情景 ─────────────────────────────────────────────────────────────────────

/** 一条对话消息压成一行（不发原文里的换行，避免把 prompt 顶乱）。 */
function formatDialogueLine(message, personaName, maxChars) {
  const m = message && typeof message === 'object' ? message : {};
  const speaker = m.isSelf ? `${personaName || '她'}（我）` : String(m.sender || '群友').trim() || '群友';
  const raw = String(m.plain ?? m.text ?? '').replace(/\s+/gu, ' ').trim();
  if (!raw) return '';
  return `- ${speaker}：${truncateChars(raw, maxChars)}`;
}

/**
 * 拼【场合与状态】块（严格受 maxChars 预算限制）。
 * 优先保留：场合头 > 状态行 > 最近对话（对话从最新往前塞，塞不下就丢最旧的）。
 * @param {object} input
 * @param {string} [input.key]
 * @param {string} [input.kind] group / private
 * @param {string} [input.groupName]
 * @param {string} [input.personaName]
 * @param {string[]} [input.statusLines]
 * @param {Array<object>} [input.recent] 按时间正序的最近消息
 * @param {number} [input.now]
 * @param {number} [input.maxChars]
 * @returns {{ text: string, usedChars: number, dialogueLines: number, statusLines: number }}
 */
export function buildReviewScene({
  key = '', kind = '', groupName = '', personaName = '', statusLines = [],
  recent = [], now = Date.now(), maxChars = DEFAULT_PRESEND_REVIEW_CONFIG.sceneMaxChars,
} = {}) {
  const budget = Math.max(80, Number(maxChars) || DEFAULT_PRESEND_REVIEW_CONFIG.sceneMaxChars);
  const where = kind === 'private'
    ? 'QQ 私聊（和主人一对一）'
    : `QQ 群聊${groupName ? `「${truncateChars(groupName, 24)}」` : ''}`;
  const clock = new Date(Number(now) || Date.now());
  const hhmm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`;
  const header = `【场合】${where}（${key}）· 角色：${personaName || '她'} · ${hhmm}`;

  const pickedStatus = [];
  for (const line of Array.isArray(statusLines) ? statusLines : []) {
    const text = String(line ?? '').replace(/\s+/gu, ' ').trim();
    if (!text) continue;
    pickedStatus.push(truncateChars(text, SCENE_STATUS_LINE_CHARS));
    if (pickedStatus.length >= SCENE_STATUS_MAX_LINES) break;
  }

  const recentList = Array.isArray(recent) ? recent.slice(-SCENE_DIALOGUE_MAX_LINES * 2) : [];
  const dialogueCandidates = [];
  for (const message of recentList) {
    const line = formatDialogueLine(message, personaName, SCENE_DIALOGUE_LINE_CHARS);
    if (line) dialogueCandidates.push(line);
  }

  // 从最新往前塞对话，保证「刚才发生了什么」优先于更早的。
  const chosen = [];
  let used = header.length + (pickedStatus.length ? 1 + pickedStatus.join('；').length : 0);
  const dialogueHeader = '【最近对话】';
  for (let i = dialogueCandidates.length - 1; i >= 0; i -= 1) {
    if (chosen.length >= SCENE_DIALOGUE_MAX_LINES) break;
    const line = dialogueCandidates[i];
    const extra = line.length + 1 + (chosen.length === 0 ? dialogueHeader.length : 0);
    if (used + extra > budget) break;
    chosen.unshift(line);
    used += extra;
  }
  const parts = [header];
  if (pickedStatus.length) parts.push(pickedStatus.join('；'));
  if (chosen.length) parts.push(`${dialogueHeader}\n${chosen.join('\n')}`);
  let text = parts.join('\n');
  if (text.length > budget) text = truncateChars(text, budget);
  return { text, usedChars: text.length, dialogueLines: chosen.length, statusLines: pickedStatus.length };
}

// ── 评审 prompt ──────────────────────────────────────────────────────────────

/** system prompt：角色、评分档位、「证据不足就从宽」的倾向、严格 JSON 输出契约。 */
export function buildReviewSystemPrompt({ personaName = '她', threshold = 80 } = {}) {
  const name = personaName || '她';
  return [
    `你是一个独立的中文对话评审员。你在评审 QQ 人格号「${name}」准备发出的一条（或几条）消息。`,
    '你只能看到有限上下文：场合/状态、最近几条对话、她的抽象记忆卡、她的说话习惯；记忆卡是高度压缩的摘要，不要求逐条对应。',
    '判断标准：这条消息是否接住了对方的话（答到点上）、是否符合她的人设与说话习惯、是否符合这个场合（私聊/群聊/群规矩）、有没有重复啰嗦或自相矛盾、有没有说出不该在群里说的隐私或敏感暗示。',
    `评分 1-100（阈值 ${threshold}）：90-100 很合适；80-89 可用、小瑕疵；60-79 有明确问题（答非所问/重复/语气不对/说了不该说的）；1-59 不该发（失礼、泄密、破坏人设或群规、明显暴露模型身份）。`,
    '如果上下文不足以判断，给 80-85 的从宽分，不要因为「没看到完整证据」就压低分；只有能明确指出问题时才低于阈值。',
    '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释：',
    '{"score": 1-100 的整数, "reason": "不超过 60 字的中文理由（指出具体问题）", "fix": "低于阈值时给一句具体改写建议；否则空字符串"}',
  ].join('\n');
}

/**
 * 拼评审请求：system + user（带预算的分段上下文）。
 * 返回 { system, user, stats }；stats 用来在日志里核对 token 预算。
 */
export function buildReviewPrompt({
  scene = '', memory = '', style = '', messages = [],
  personaName = '', threshold = DEFAULT_PRESEND_REVIEW_CONFIG.threshold,
  memoryMaxChars = DEFAULT_PRESEND_REVIEW_CONFIG.memoryMaxChars,
  styleMaxChars = DEFAULT_PRESEND_REVIEW_CONFIG.styleMaxChars,
  messageMaxChars = 160,
} = {}) {
  const sections = [];
  const safeScene = String(scene ?? '').trim();
  if (safeScene) sections.push(`<场合与状态>\n${safeScene}`);
  const safeMemory = truncateChars(String(memory ?? '').replace(/\s+/gu, ' ').trim(), memoryMaxChars);
  if (safeMemory) sections.push(`<她的抽象记忆卡>\n${safeMemory}`);
  const safeStyle = truncateChars(String(style ?? '').replace(/\s+/gu, ' ').trim(), styleMaxChars);
  if (safeStyle) sections.push(`<她的说话习惯>\n${safeStyle}`);
  const list = (Array.isArray(messages) ? messages : [])
    .map((m) => String(m ?? '').trim())
    .filter(Boolean)
    .map((m, i) => `${i + 1}. ${truncateChars(m.replace(/\s+/gu, ' '), messageMaxChars)}`);
  sections.push(`<她准备发送的消息（共 ${list.length} 条，数组=同一个回合连发的多条）>\n${list.join('\n')}`);
  sections.push('请按 system 的要求只输出 JSON。');
  const user = sections.join('\n\n');
  return {
    system: buildReviewSystemPrompt({ personaName, threshold }),
    user,
    stats: {
      sceneChars: safeScene.length,
      memoryChars: safeMemory.length,
      styleChars: safeStyle.length,
      messageChars: list.join('').length,
      totalChars: user.length,
    },
  };
}

/**
 * 解析评审模型的回复。宽容代码块/前后缀，但分数必须是 1-100 的整数、理由必须非空；
 * 其余一律当解析失败（不能「返回垃圾就当好话」）。
 * @returns {{score:number, reason:string, fix:string}|null}
 */
export function parseReviewVerdict(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let candidate = text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fenced) candidate = fenced[1].trim();
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    candidate = candidate.slice(start, end + 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const score = parsed.score;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 100) return null;
  const reason = typeof parsed.reason === 'string' ? parsed.reason.replace(/\s+/gu, ' ').trim() : '';
  if (!reason) return null;
  const fix = typeof parsed.fix === 'string' ? parsed.fix.replace(/\s+/gu, ' ').trim() : '';
  return { score, reason: truncateChars(reason, VERDICT_REASON_MAX), fix: truncateChars(fix, VERDICT_REASON_MAX) };
}

/** 退回给模型的工具错误文案：说清「没发出去」+ 理由 + 改写要求，不要解释评审机制。 */
export function formatReviewRejection({ verdict, threshold, personaName = '她' } = {}) {
  const score = Number(verdict?.score) || 0;
  const reason = String(verdict?.reason ?? '').trim() || '内容不符合当前场合';
  const fix = String(verdict?.fix ?? '').trim();
  return [
    `消息未发送：发送前独立评审 ${score}/100，低于 ${threshold} 分门槛（${personaName} 的这条回复不够合适）。`,
    `理由：${reason}`,
    fix ? `建议：${fix}` : '',
    '请按这个意见直接改写后再调用发送工具（只发改写后的版本，不要向对方解释评审过程）。',
  ].filter(Boolean).join('\n');
}

// ── 节流（按 key 计）──────────────────────────────────────────────────────────

/**
 * 每个会话 key 的评审节流状态。
 * decide() 返回 {action:'review'|'allow'|'skip', reason}：
 *   skip  = 不值得审（太短/刚通过过/达到评审次数上限）
 *   allow = 直接放行且不审（退回次数 cap，防止死循环）
 */
export function createReviewThrottle({ now = Date.now } = {}) {
  const states = new Map();
  const get = (key) => {
    const k = String(key ?? '');
    let st = states.get(k);
    if (!st) {
      st = { lastPassAt: 0, reviews: [], rejects: [] };
      states.set(k, st);
    }
    return st;
  };
  const prune = (st, windowMs, at) => {
    st.reviews = st.reviews.filter((t) => at - Number(t) < windowMs);
    st.rejects = st.rejects.filter((t) => at - Number(t) < windowMs);
  };
  return {
    decide(key, { config, totalChars = 0, at = now() } = {}) {
      const cfg = config ?? DEFAULT_PRESEND_REVIEW_CONFIG;
      const st = get(key);
      prune(st, cfg.reviewWindowMs, at);
      if (Number(totalChars) < Number(cfg.minChars ?? 0)) return { action: 'skip', reason: 'too-short' };
      if (st.lastPassAt && at - st.lastPassAt < Number(cfg.skipAfterPassMs ?? 0)) return { action: 'skip', reason: 'after-pass' };
      if (st.reviews.length >= cfg.maxReviews) return { action: 'allow', reason: 'review-cap' };
      if (st.rejects.length >= cfg.maxRejects) return { action: 'allow', reason: 'reject-cap' };
      return { action: 'review', reason: '' };
    },
    recordPass(key, { at = now() } = {}) {
      const st = get(key);
      st.lastPassAt = at;
      st.reviews.push(at);
    },
    recordReject(key, { at = now() } = {}) {
      const st = get(key);
      st.reviews.push(at);
      st.rejects.push(at);
    },
    rejectCount(key, { at = now(), windowMs = DEFAULT_PRESEND_REVIEW_CONFIG.reviewWindowMs } = {}) {
      const st = get(key);
      prune(st, windowMs, at);
      return st.rejects.length;
    },
    reset(key) {
      if (key === undefined) states.clear();
      else states.delete(String(key));
    },
  };
}

// ── 退回兜底（宁缺勿错的例外）───────────────────────────────────────────────
/**
 * 退回兜底：评审退回后 delayMs 内没有「重新发送成功」，就把最后一版被退回的稿子补发出去。
 * 纯逻辑（定时器/发送函数注入），可离线单测。
 *
 * 契约：
 *   · 同一 key 第一次退回时启动计时；后续退回只**更新要补发的稿子**，不延长截止时间
 *     （否则模型一直重试失败就会一直不发）。
 *   · 「有成功发送」时必须 cancel(key)，取消兜底。
 *   · 触发时把 key/messages 交给 send；send 自己再做静默/鱼群/token 等闸门（兜底是真实发送）。
 * @param {object} deps
 * @param {number} [deps.delayMs]
 * @param {(key:string, messages:string[]) => Promise<unknown>} deps.send
 * @param {(tag:string, detail?:unknown) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {Function} [deps.setTimeoutFn]
 * @param {Function} [deps.clearTimeoutFn]
 */
export function createRejectFallback({
  delayMs = DEFAULT_PRESEND_REVIEW_CONFIG.rejectFallbackMs,
  send, log = () => {}, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
} = {}) {
  const pending = new Map();
  const normalize = (messages) => (Array.isArray(messages) ? messages : [messages])
    .map((m) => String(m ?? '').trim())
    .filter(Boolean);
  const clearEntry = (key) => {
    const entry = pending.get(key);
    if (entry?.timer !== undefined) clearTimeoutFn(entry.timer);
    pending.delete(key);
  };
  return {
    schedule(key, messages, { delay = delayMs } = {}) {
      const k = String(key ?? '');
      const list = normalize(messages);
      const wait = Number(delay);
      if (!k || !list.length) return { scheduled: false, reason: 'empty' };
      if (!(wait > 0)) return { scheduled: false, reason: 'disabled' };
      const existing = pending.get(k);
      if (existing) {
        existing.messages = list;
        existing.updatedAt = now();
        return { scheduled: true, updated: true, deadline: existing.deadline };
      }
      const entry = { messages: list, at: now(), deadline: now() + wait, timer: undefined };
      entry.timer = setTimeoutFn(() => {
        const current = pending.get(k);
        if (!current) return;
        pending.delete(k);
        try {
          void Promise.resolve(send(k, current.messages)).catch((error) => {
            log(`[预发送评审] 兜底补发失败 ${k}:`, error?.message ?? error);
          });
        } catch (error) {
          log(`[预发送评审] 兜底补发异常 ${k}:`, error?.message ?? error);
        }
      }, wait);
      entry.timer?.unref?.();
      pending.set(k, entry);
      return { scheduled: true, updated: false, delay: wait, deadline: entry.deadline };
    },
    cancel(key) {
      const k = String(key ?? '');
      const had = pending.has(k);
      clearEntry(k);
      return had;
    },
    /** 当前待补发的稿子（排障/测试用）。 */
    pendingMessages(key) {
      return pending.get(String(key ?? ''))?.messages ?? null;
    },
    size() { return pending.size; },
    dispose() { for (const k of [...pending.keys()]) clearEntry(k); },
  };
}

// ── 记忆抽象卡（压缩 + 缓存）─────────────────────────────────────────────────

/** 源文本 hash（用于判断记忆卡是否变了）。 */
export function memorySourceHash(sourceText) {
  const hash = crypto.createHash('sha1');
  hash.update(String(sourceText ?? ''));
  return hash.digest('hex');
}

/** 压缩记忆卡的 system prompt（一次性、可缓存，不追求每次实时）。 */
export function buildMemoryCompressSystemPrompt({ maxChars = DEFAULT_PRESEND_REVIEW_CONFIG.memoryMaxChars } = {}) {
  return [
    '你是记忆压缩器。把下面这个 QQ 人格号的长期记忆卡压缩成一段「高度抽象摘要」，供另一个评审模型快速理解她。',
    `摘要不超过 ${maxChars} 字，用中文，可以分句但不能分小节标题。必须保留：`,
    '① 她是谁（名字/身份/性格基调）；② 和主人（管理员）的关系与相处方式；',
    '③ 她在群里的处境与和群友的关系；④ 3~5 件最重要的共同经历或梗；',
    '⑤ 她的雷区/不该在群里说的东西；⑥ 她的说话风格特征。',
    '删掉：聊天流水、时间戳、重复内容、具体消息原文、与判断无关的细节。',
    '只输出摘要正文，不要标题、不要解释、不要引号。',
  ].join('\n');
}

/**
 * 记忆卡压缩 + 落盘缓存。
 * 只有「源 hash 变了」或「超过 memoryRefreshMs」才重新请求压缩；失败时回退旧缓存（没有就给空串）。
 */
export function createMemoryAbstractProvider({
  cachePath, readSource, completeText, getConfig, now = Date.now, log = () => {},
} = {}) {
  let inflight = null;
  const configOf = () => normalizePresendReviewConfig((getConfig?.() ?? {}));
  const readCache = () => {
    try {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (!data || typeof data.text !== 'string' || typeof data.hash !== 'string') return null;
      return data;
    } catch {
      return null;
    }
  };
  const writeCache = (data) => {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    } catch (error) {
      log('[预发送评审] 记忆摘要缓存写入失败:', error?.message ?? error);
    }
  };
  const compress = async ({ source, cfg }) => {
    // 记忆压缩是一次性的大输入任务（记忆卡注入块 ~14KB）；deepseek-flash 会先出一段
    // thinking，max_tokens 给小了会出现「200 但只有 thinking、没正文」——llm-text.js 里
    // 踩过同样的坑。给足 3k~4k 输出预算 + 更宽的等待，失败另有 10 分钟冷却（见 get()）。
    const result = await completeText({
      system: buildMemoryCompressSystemPrompt({ maxChars: cfg.memoryMaxChars }),
      user: truncateChars(source, cfg.memorySourceMaxChars),
      maxTokens: Math.max(1200, Math.min(4000, cfg.memoryMaxChars * 6)),
      timeoutMs: Math.max(30000, cfg.timeoutMs * 3),
      model: cfg.model || undefined,
    });
    const text = truncateChars(String(result?.text ?? '').replace(/\s+/gu, ' ').trim(), cfg.memoryMaxChars);
    return text;
  };
  let lastFailureAt = 0;
  const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
  return {
    /** @returns {Promise<string>} 抽象记忆卡；没有可用来源时返回 ''。 */
    async get() {
      if (inflight) return inflight;
      inflight = (async () => {
        const cfg = configOf();
        const source = String(readSource?.() ?? '');
        const cache = readCache();
        if (!source.trim()) return cache?.text ?? '';
        const hash = memorySourceHash(source);
        const fresh = cache && cache.hash === hash
          && Number(now()) - Number(cache.generatedAt || 0) < cfg.memoryRefreshMs;
        if (fresh) return cache.text;
        // 压缩失败后 10 分钟内不再重试：否则每条消息都白烧一次大 prompt。
        if (lastFailureAt && now() - lastFailureAt < FAILURE_BACKOFF_MS) return cache?.text ?? '';
        try {
          const text = await compress({ source, cfg });
          if (text) {
            writeCache({ version: PRESEND_REVIEW_VERSION, hash, generatedAt: now(), sourceChars: source.length, model: cfg.model || '', text });
            return text;
          }
          lastFailureAt = now();
        } catch (error) {
          lastFailureAt = now();
          log('[预发送评审] 记忆卡压缩失败，沿用旧摘要（10 分钟内不重试）:', error?.message ?? error);
        }
        return cache?.text ?? '';
      })().finally(() => { inflight = null; });
      return inflight;
    },
    readCache,
    resetFailureBackoff() { lastFailureAt = 0; },
  };
}

// ── reviewer ─────────────────────────────────────────────────────────────────

/**
 * 组装发送前评审器。
 * 依赖注入（桥接侧传真实实现，测试传 fake）：
 *   getConfig() -> socialV2.review 原始配置
 *   completeText({system,user,model,maxTokens,timeoutMs}) -> {text, usage?}
 *   memory -> createMemoryAbstractProvider()
 *   styleFor(key) -> string
 *   log(...)
 */
export function createPresendReviewer({
  getConfig, completeText, memory, styleFor, log = () => {}, now = Date.now, onUsage = () => {},
} = {}) {
  const throttle = createReviewThrottle({ now });
  const enabled = () => normalizePresendReviewConfig(getConfig?.() ?? {}).enabled;

  return {
    enabled,
    throttle,
    /** 启动预热：提前把（可能要重新压缩的）记忆卡摘要算好，别让第一条消息等 20 秒。 */
    async warmup() {
      if (!enabled()) return;
      try { await memory?.get?.(); } catch (error) { log('[预发送评审] 预热失败:', error?.message ?? error); }
    },
    /**
     * 评审一轮发送。
     * @returns {Promise<{allow:true, skipped?:string, score?:number, context?:object}
     *   | {allow:false, score:number, threshold:number, reason:string, fix:string, attempt:number, error:string, context:object}>}
     */
    async review({ key = '', kind = '', messages = [], groupName = '', personaName = '', statusLines = [], recent = [] } = {}) {
      const cfg = normalizePresendReviewConfig(getConfig?.() ?? {});
      if (!cfg.enabled) return { allow: true, skipped: 'disabled' };
      const list = (Array.isArray(messages) ? messages : [])
        .map((m) => String(m ?? '').trim())
        .filter(Boolean);
      if (!list.length) return { allow: true, skipped: 'empty' };
      const totalChars = list.reduce((sum, m) => sum + m.length, 0);
      const at = now();
      const decision = throttle.decide(key, { config: cfg, totalChars, at });
      if (decision.action !== 'review') return { allow: true, skipped: decision.reason };

      let memoryText = '';
      try { memoryText = String((await memory?.get?.()) ?? ''); } catch (error) { log('[预发送评审] 记忆摘要不可用:', error?.message ?? error); }
      let style = '';
      try { style = String(styleFor?.(key) ?? ''); } catch { /* 说话习惯拿不到就不带 */ }
      const scene = buildReviewScene({
        key, kind, groupName, personaName, statusLines, recent, now: at, maxChars: cfg.sceneMaxChars,
      });
      const prompt = buildReviewPrompt({
        scene: scene.text, memory: memoryText, style, messages: list,
        personaName, threshold: cfg.threshold,
        memoryMaxChars: cfg.memoryMaxChars, styleMaxChars: cfg.styleMaxChars,
      });

      // 一次评审最多尝试 1 + parseRetries 次：模型偶尔会输出非 JSON（不是结论错误，是格式翻车），
      // 重试一次通常就能拿到合法 JSON，比直接 fail-open 放行更稳。
      const maxAttempts = 1 + (Number(cfg.parseRetries) || 0);
      let reply = null;
      let verdict = null;
      let lastError = null;
      for (let attemptNo = 0; attemptNo < maxAttempts; attemptNo += 1) {
        try {
          reply = await completeText({
            system: prompt.system, user: prompt.user,
            model: cfg.model || undefined,
            maxTokens: cfg.maxTokens,
            timeoutMs: cfg.timeoutMs,
          });
          onUsage?.(reply?.usage ?? null);
        } catch (error) {
          lastError = error;
          break;
        }
        verdict = parseReviewVerdict(reply?.text ?? '');
        if (verdict) break;
        if (attemptNo + 1 < maxAttempts) {
          log(`[预发送评审] ${key} 评审回复不是合法 JSON，重试一次: ${truncateChars(String(reply?.text ?? ''), 120)}`);
        }
      }
      if (!verdict && lastError) {
        log(`[预发送评审] ${key} 评审调用失败（${cfg.failOpen ? '放行' : '拦截'}）:`, lastError?.message ?? lastError);
        if (cfg.failOpen) return { allow: true, skipped: 'error', context: prompt.stats };
        return {
          allow: false, score: 0, threshold: cfg.threshold,
          reason: '评审服务暂时不可用', fix: '', attempt: 0, context: prompt.stats,
          error: '消息未发送：发送前评审暂时不可用，请稍后重试。',
        };
      }
      if (!verdict) {
        log(`[预发送评审] ${key} 评审回复不是合法 JSON（${cfg.failOpen ? '放行' : '拦截'}）: ${truncateChars(String(reply?.text ?? ''), 160)}`);
        if (cfg.failOpen) return { allow: true, skipped: 'parse-fail', raw: truncateChars(String(reply?.text ?? ''), 200), context: prompt.stats };
        return {
          allow: false, score: 0, threshold: cfg.threshold,
          reason: '评审结果无法解析', fix: '', attempt: 0, context: prompt.stats,
          error: '消息未发送：发送前评审返回异常，请稍后重试。',
        };
      }
      if (verdict.score >= cfg.threshold) {
        throttle.recordPass(key, { at });
        log(`[预发送评审] ${key} 通过 ${verdict.score}/${cfg.threshold}（场景${prompt.stats.sceneChars}+记忆${prompt.stats.memoryChars}+习惯${prompt.stats.styleChars}字）`);
        return { allow: true, score: verdict.score, threshold: cfg.threshold, reason: verdict.reason, context: prompt.stats };
      }

      const attempt = throttle.rejectCount(key, { at, windowMs: cfg.reviewWindowMs }) + 1;
      if (attempt > cfg.maxRejects) {
        // 连续被退回太多次：多半是评审标准过严或模型卡住了，放行以免消息永远发不出去。
        throttle.recordPass(key, { at });
        log(`[预发送评审] ${key} 退回达上限（${attempt - 1}/${cfg.maxRejects}），本轮放行 ${verdict.score}/${cfg.threshold}`);
        return { allow: true, skipped: 'reject-cap', score: verdict.score, context: prompt.stats };
      }
      throttle.recordReject(key, { at });
      log(`[预发送评审] ${key} 退回 ${verdict.score}/${cfg.threshold}（第 ${attempt}/${cfg.maxRejects} 次）: ${verdict.reason}`);
      return {
        allow: false,
        score: verdict.score,
        threshold: cfg.threshold,
        reason: verdict.reason,
        fix: verdict.fix,
        attempt,
        maxRejects: cfg.maxRejects,
        context: prompt.stats,
        error: formatReviewRejection({ verdict, threshold: cfg.threshold, personaName }),
      };
    },
  };
}
