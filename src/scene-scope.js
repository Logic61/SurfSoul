// ── 场合作用域（scene scope）────────────────────────────────────────────────
//
// 2026-10-31 主人拍板「路线 A」：记忆要共同（长期卡 + 摘要跨场合共享），
// 但「场合」必须是一个**结构化维度**，而不是只靠一段提示词自律。
//
// 本模块只放纯函数（不做 IO、不读全局配置），因为：
//   · src/ 的纯引擎约定是三方可复用、可离线单测（bridge / 插件 / CLI）；
//   · 记忆卡的「场合」渲染在插件进程里跑，桥接进程也在读同一份文件，
//     规则必须只有一份实现，不能两边各写一套（PITFALLS #68 的同类坑）。
//
// 三个概念：
//
//   1. 规矩（rule）—— 轻记忆的一类（social-v2.json 的 conversations.<key>.rules）。
//      scope:
//        global        所有场合都认（私聊里定下的规矩，群里也认）
//        private       只私聊生效
//        group         任何群聊生效
//        group:<id>    只在指定群生效
//      「记忆共同」在这里落地：任何场合写下的 global 规矩，注入时从**所有**会话合并；
//      private / group:<id> 规矩只在本场合出现，不跨场合泄漏。
//
//   2. 说话习惯（style-notes.md）—— 一行一条，可选作用域前缀：
//        - 2026-10-29 [全局] 说话短一点
//        - 2026-10-29 [私聊] 私聊里可以放开一点
//        - 2026-10-29 [群] 群里别发路径/命令
//        - 2026-10-29 [群:123456] 这个群要更正经
//      旧行没有前缀 = 全局（向后兼容；历史文件不用改）。
//
//   3. 场合档位（scene profile）—— 每个场景一个标签 / 语气提示 / 是否守住「私聊边界」：
//        config.socialV2.scenes.defaultPrivate / defaultGroup / overrides.<key>
//      唤醒提示词顶部注入【场合】块，让模型明确「我现在在哪种场合」。
//
// 边界：本模块**不做**记忆卡的可见性过滤（那是记忆卡记录级 audience 的事），
// 只提供「按当前场景过滤渲染好的提示词块」这一个纯函数，避免桥接里再手写正则。

export const RULE_SCOPES = Object.freeze(['global', 'private', 'group']);
export const RULE_MAX_CHARS = 200;
export const RULE_MAX_COUNT = 50;
export const STYLE_NOTE_MAX_LINES = 30;

const SCOPE_ALIASES = Object.freeze({
  global: 'global',
  all: 'global',
  全局: 'global',
  所有: 'global',
  private: 'private',
  'private-only': 'private',
  私聊: 'private',
  私信: 'private',
  group: 'group',
  groups: 'group',
  群: 'group',
  群聊: 'group',
  here: 'here',
  本场合: 'here'
});

/** 场景类型：private（私聊）/ group（群聊）。非规范 key 一律当群聊处理（保守：群守卫更严）。 */
export function sceneKindOf(key) {
  return String(key ?? '').startsWith('private:') ? 'private' : 'group';
}

/** 从 `group:123` / `private:456` 里取数字 id；非法返回 ''。 */
export function sceneIdOf(key) {
  const m = /^(?:group|private):(\d+)$/.exec(String(key ?? '').trim());
  return m ? m[1] : '';
}

/** 当前场景默认的「本场合」作用域：私聊 → private；群 → group:<本群号>。 */
export function scopeOfScene(key) {
  const kind = sceneKindOf(key);
  if (kind === 'private') return 'private';
  const id = sceneIdOf(key);
  return id ? `group:${id}` : 'group';
}

/**
 * 规范化一个作用域输入。
 * @param {unknown} raw  'global'|'private'|'group'|'group:123'|'here'|中文别名
 * @param {{key?: string}} [options]  传 key 时把 'here' 解析成当前场合
 * @returns {string|null} 规范值；无法识别返回 null（调用方应回 400，不要 silent fallback）
 */
export function normalizeRuleScope(raw, { key = '' } = {}) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return 'global'; // 不写 scope = 全局（与历史行为一致）
  if (value === 'here' || value === '本场合') return scopeOfScene(key);
  const alias = SCOPE_ALIASES[value];
  if (alias && alias !== 'here') return alias;
  // group:<id> / 群:<id>（允许冒号两侧空白已被 trim 掉；中文写法给手改 style-notes 用）
  const m = /^(?:group|群|群聊)\s*[:：]\s*(\d+)$/.exec(value);
  if (m) {
    const id = Number(m[1]);
    return Number.isSafeInteger(id) && id > 0 ? `group:${id}` : null;
  }
  return null;
}

/** 作用域是否对某个会话生效。key 为空时（例如控制台预览）一律 true。 */
export function ruleScopeAppliesTo(scope, key) {
  const canonical = String(scope ?? 'global');
  if (!key) return true;
  if (canonical === 'global') return true;
  if (canonical === 'private') return sceneKindOf(key) === 'private';
  if (canonical === 'group') return sceneKindOf(key) === 'group';
  const m = /^group:(\d+)$/.exec(canonical);
  if (m) return String(key) === `group:${m[1]}`;
  return true;
}

/** 注入时给规矩加的场合后缀（让模型知道这条规矩从哪来、管到哪）。 */
export function ruleScopeLabel(scope, key = '') {
  const canonical = String(scope ?? 'global');
  if (canonical === 'global') return '（全局）';
  if (canonical === 'private') return '（仅私聊）';
  if (canonical === 'group') return '（仅群聊）';
  const m = /^group:(\d+)$/.exec(canonical);
  if (m) return String(key) === `group:${m[1]}` ? '（仅本群）' : `（仅群:${m[1]}）`;
  return '';
}

/** 把一条规矩文本压成一行（写入前用）。 */
export function normalizeRuleText(text) {
  return String(text ?? '').replace(/\s*\n\s*/g, ' ').trim().slice(0, RULE_MAX_CHARS);
}

/**
 * 当前会话要注入的规矩（含跨会话的全局规矩）。
 *
 * @param {Array} currentRules  当前会话自己存的规矩
 * @param {Array<{key:string, rules:Array}>} otherRuleSets  其它会话的规矩集合
 * @param {string} key          当前会话 key
 * @param {{max?: number}} [options]
 * @returns {{lines: string[], sharedLines: string[], texts: Set<string>}}
 *   lines       本场合生效的规矩（当前会话 + 跨会话全局），按「本会话优先、全局靠后」排
 *   sharedLines 只有「来自别的场合的全局规矩」——桥接把它注入【跨场合记忆】块
 *   texts       已渲染过的规矩原文集合，供去重
 */
export function collectRulesForScene(currentRules, otherRuleSets, key, { max = 20 } = {}) {
  const texts = new Set();
  const lines = [];
  const sharedLines = [];
  const push = (rule) => {
    const text = String(rule?.text ?? '').trim();
    if (!text || texts.has(text)) return false;
    if (!ruleScopeAppliesTo(rule?.scope, key)) return false;
    texts.add(text);
    return true;
  };
  for (const rule of Array.isArray(currentRules) ? currentRules : []) {
    if (!push(rule)) continue;
    lines.push(`- ${String(rule.text).trim().slice(0, RULE_MAX_CHARS)}${ruleScopeLabel(rule?.scope, key)}`);
  }
  for (const set of Array.isArray(otherRuleSets) ? otherRuleSets : []) {
    for (const rule of Array.isArray(set?.rules) ? set.rules : []) {
      // 只跨会话共享 global：private / group:<id> 规矩换了场合就不该出现（分清场合的硬要求）。
      if (String(rule?.scope ?? 'global') !== 'global') continue;
      const before = texts.size;
      if (!push(rule)) continue;
      if (texts.size === before) continue;
      sharedLines.push(`- ${String(rule.text).trim().slice(0, RULE_MAX_CHARS)}（全局规矩，另一个场合定下的）`);
    }
  }
  return { lines: lines.slice(0, Math.max(0, max)), sharedLines: sharedLines.slice(0, Math.max(0, max)), texts };
}

/** 渲染【规矩】块；没有则返回 ''。 */
export function formatRulesBlock(currentRules, otherRuleSets, key, { max = 20 } = {}) {
  const { lines } = collectRulesForScene(currentRules, otherRuleSets, key, { max });
  return lines.length ? `【记下的规矩（按场合生效）】\n${lines.join('\n')}` : '';
}

// ── style-notes（说话习惯）────────────────────────────────────────────────

const STYLE_SCOPE_TAG_RE = /^\[([^\]]{1,24})\]\s*/;
const STYLE_DATE_RE = /^(\d{4}-\d{2}-\d{2})\s*/;

/**
 * 解析一行 style-notes。
 * 兼容三种写法：
 *   `- 2026-10-29 文本`                → 全局（旧格式）
 *   `- 2026-10-29 [私聊] 文本`
 *   `- [群:123] 文本`                 → 无日期（memctl 旧输出被手工补 scope）
 * @returns {{text:string, scope:string, date:string, raw:string}|null} 不是 `- ` 行返回 null
 */
export function parseStyleNoteLine(line) {
  const raw = String(line ?? '').trim();
  if (!raw.startsWith('- ') || raw.length <= 2) return null;
  let rest = raw.slice(2).trim();
  let date = '';
  const dateMatch = STYLE_DATE_RE.exec(rest);
  if (dateMatch) {
    date = dateMatch[1];
    rest = rest.slice(dateMatch[0].length).trim();
  }
  let scope = 'global';
  const tagMatch = STYLE_SCOPE_TAG_RE.exec(rest);
  if (tagMatch) {
    const normalized = normalizeRuleScope(tagMatch[1]);
    if (normalized) {
      scope = normalized;
      rest = rest.slice(tagMatch[0].length).trim();
    }
    // 不是已知作用域（例如文本本身以 [图片] 开头）→ 保留原文，按全局处理。
  }
  const text = rest.trim();
  if (!text) return null;
  return { text, scope, date, raw };
}

/** 说话习惯是否对某个会话生效（key 为空 = 不过滤）。 */
export function styleNoteAppliesTo(scope, key) {
  return ruleScopeAppliesTo(scope, key);
}

/** 按场合过滤 style-notes 行（保留原始行，注入时原样带上作用域标签）。 */
export function filterStyleNotesForScene(lines, key = '', { max = STYLE_NOTE_MAX_LINES } = {}) {
  const kept = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const parsed = parseStyleNoteLine(line);
    if (!parsed) continue;
    if (!styleNoteAppliesTo(parsed.scope, key)) continue;
    kept.push(parsed.raw);
  }
  return kept.slice(-Math.max(0, max));
}

/** 写一行 style-notes（scope 用中文标签，便于主人直接看文件）。 */
export function formatStyleNoteLine({ scope = 'global', date = '', text = '' } = {}) {
  const canonical = normalizeRuleScope(scope) ?? 'global';
  const tag = canonical === 'global' ? '全局'
    : canonical === 'private' ? '私聊'
      : canonical === 'group' ? '群'
        : `群:${canonical.slice('group:'.length)}`;
  const body = String(text ?? '').replace(/\s*\n\s*/g, ' ').trim();
  if (!body) return '';
  const day = String(date ?? '').trim();
  return `- ${day ? `${day} ` : ''}[${tag}] ${body}`;
}

// ── 场合档位（scene profile）──────────────────────────────────────────────

export const SCENE_PROFILE_DEFAULT = Object.freeze({
  private: Object.freeze({ label: '私聊', toneHint: '', memoryGuard: false }),
  group: Object.freeze({ label: '群聊', toneHint: '', memoryGuard: true })
});

function cleanProfile(raw, fallback) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const label = String(source.label ?? fallback.label ?? '').trim().slice(0, 24) || fallback.label;
  const toneHint = String(source.toneHint ?? fallback.toneHint ?? '').replace(/\s*\n\s*/g, ' ').trim().slice(0, 160);
  const memoryGuard = typeof source.memoryGuard === 'boolean' ? source.memoryGuard : fallback.memoryGuard;
  return { label, toneHint, memoryGuard };
}

/**
 * 解析当前会话的场合档位。
 * @param {string} key
 * @param {object} [scenesConfig] config.socialV2.scenes
 *   { defaultPrivate:{label,toneHint}, defaultGroup:{label,toneHint,memoryGuard},
 *     overrides: { "group:123":{label,toneHint,memoryGuard}, ... } }
 */
export function resolveSceneProfile(key, scenesConfig = {}) {
  const kind = sceneKindOf(key);
  const cfg = scenesConfig && typeof scenesConfig === 'object' ? scenesConfig : {};
  const defaults = SCENE_PROFILE_DEFAULT[kind];
  const override = cfg.overrides && typeof cfg.overrides === 'object' ? cfg.overrides[String(key)] : null;
  const base = cleanProfile(kind === 'private' ? cfg.defaultPrivate : cfg.defaultGroup, defaults);
  const merged = cleanProfile(override, base);
  return {
    key: String(key ?? ''),
    kind,
    label: merged.label,
    toneHint: merged.toneHint,
    memoryGuard: kind === 'group' ? merged.memoryGuard : false
  };
}

/**
 * 渲染【场合】块。
 * @param {{key:string,kind:string,label:string,toneHint:string,memoryGuard:boolean}} profile
 * @param {{groupName?: string}} [extra]
 */
export function formatSceneCard(profile, { groupName = '' } = {}) {
  if (!profile || !profile.key) return '';
  const isPrivate = profile.kind === 'private';
  const where = isPrivate
    ? '私聊（和主人一对一）'
    : `群聊${groupName ? `「${groupName}」` : ''}`;
  let line = `【场合】${where}（${profile.key}）；场合档位：${profile.label}。`;
  if (profile.toneHint) line += `\n语气提示：${profile.toneHint}`;
  line += isPrivate
    ? '\n记忆是私聊和群聊共用的：群里发生的事可以提，但先说一句「群里刚才…」，别让两边混成一锅。'
    : '\n记忆是私聊和群聊共用的：涉及主人的私事、情绪、身体、学习、家里的事，多半是私聊里说的——群里不要主动提，确实要说先问一句「你介意我说吗」。';
  return line;
}

// ── 记忆卡按场合过滤（桥接侧）─────────────────────────────────────────────
// 记忆卡注入文件是**一份**（所有 QQ 会话共用，符合「记忆共同」）；
// 记录级 audience 由渲染侧写成标记，桥接读文件时按当前场合过滤。
// 标记约定（与 memory-card.js 的 conversationTag 同一份实现）：
//   [仅私聊可见] → 群聊注入时整行丢弃
//   [仅群可见]   → 私聊注入时整行丢弃
export const AUDIENCE_PRIVATE_ONLY_TAG = '[仅私聊可见]';
export const AUDIENCE_GROUP_ONLY_TAG = '[仅群可见]';

/**
 * 按当前场合过滤渲染好的记忆卡提示词块。
 * @param {string} text    memory-card-prompt-qq.md 内容
 * @param {string} key     当前会话 key
 * @param {{groupExcludePrivate?: boolean, honorAudience?: boolean}} [options]
 *   groupExcludePrivate=true 时，群聊里连 [私聊] 记录也一起过滤（硬开关，默认关=记忆共同）
 */
export function filterMemoryCardPromptForScene(text, key, options = {}) {
  const body = String(text ?? '');
  if (!body) return '';
  const isPrivate = sceneKindOf(key) === 'private';
  const honorAudience = options.honorAudience !== false;
  const groupExcludePrivate = options.groupExcludePrivate === true && !isPrivate;
  const kept = [];
  for (const line of body.split(/\r?\n/)) {
    const isItem = /^\s*-\s/.test(line);
    if (isItem && honorAudience) {
      if (!isPrivate && line.includes(AUDIENCE_PRIVATE_ONLY_TAG)) continue;
      if (isPrivate && line.includes(AUDIENCE_GROUP_ONLY_TAG)) continue;
    }
    if (isItem && groupExcludePrivate && line.includes('[私聊]')) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

// ── 受控跨场景发送（私聊 → 群）─────────────────────────────────────────────

export const CROSS_SCENE_DEFAULTS = Object.freeze({
  enabled: false,
  allowTargets: [],
  maxPerHour: 6,
  maxChars: 200
});

/** 规范化跨场景发送配置（旧 config 缺字段时补默认值，且深度合并 allowTargets）。 */
export function normalizeCrossSceneSendConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const maxPerHourRaw = Number(source.maxPerHour);
  const maxCharsRaw = Number(source.maxChars);
  const allowTargets = (Array.isArray(source.allowTargets) ? source.allowTargets : [])
    .map((item) => {
      const value = String(item ?? '').trim();
      if (!value) return '';
      const m = /^(?:group:)?(\d+)$/.exec(value);
      return m ? `group:${m[1]}` : '';
    })
    .filter(Boolean)
    .slice(0, 20);
  return {
    enabled: source.enabled === true,
    allowTargets,
    maxPerHour: Number.isFinite(maxPerHourRaw) ? Math.max(1, Math.min(60, Math.round(maxPerHourRaw))) : CROSS_SCENE_DEFAULTS.maxPerHour,
    maxChars: Number.isFinite(maxCharsRaw) ? Math.max(1, Math.min(500, Math.round(maxCharsRaw))) : CROSS_SCENE_DEFAULTS.maxChars
  };
}

/** 当前配置下，某个目标是否允许被跨场景投递。 */
export function isCrossSceneTargetAllowed(config, target) {
  const cfg = normalizeCrossSceneSendConfig(config);
  if (!cfg.enabled) return false;
  const canonical = normalizeCrossSceneTarget(target);
  if (!canonical) return false;
  return cfg.allowTargets.includes(canonical);
}

/** 规范跨场景目标：只接受 group:<id>（只开放私聊→群，群→别处一律不做）。 */
export function normalizeCrossSceneTarget(target) {
  const value = String(target ?? '').trim();
  const m = /^(?:group:)?(\d+)$/.exec(value);
  if (!m) return '';
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? `group:${id}` : '';
}

/** 跨场景发送频率（纯函数，便于测试同一套口径）。 */
export function crossSceneRateBlocked(times, now, maxPerHour) {
  const limit = Math.max(0, Number(maxPerHour) || 0);
  if (!limit) return false;
  const recent = (Array.isArray(times) ? times : []).filter((t) => now - Number(t) < 60 * 60 * 1000);
  return recent.length >= limit;
}
