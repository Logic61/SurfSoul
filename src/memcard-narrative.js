// 记忆卡叙事层：把散碎的「某天某人说了什么」记录，压缩成「我们一起经历过什么」。
//
// 为什么要有这一层：记忆卡原来是把聊天记录逐条搬进去（`羽说 X → 我回：Y`），
// 3593 字里大半是任务和解释，读起来像工单，语气也就跟着变成客服。真正该留下的
// 是「发生过什么、当时什么感觉、约定了什么」，这层负责把原料压成回忆。
//
// 分工（谁写哪份文件，绝不交叉）：
//   · 插件（DSH 宿主）是唯一写记忆卡的人：memory-card.json / memory-card-prompt-*.md
//   · 本模块由桥接进程调用，只写 memory-card-narrative.json（纯增量，可随时删）
//   · 插件渲染 prompt 时读叙事文件；桥接只读现成的 md
// 所以叙事文件丢了也不会伤到记忆本体，重新压一遍就行。
//
// 边界：
//   · 只压「有一定时间沉淀」的记录（默认 90 分钟前），刚说完的话保持原样；
//   · 被压进某条回忆的记录 id 会记在 covers 里，渲染时从原始列表里摘掉——
//     于是卡片会随着时间慢慢从「聊天记录」变成「经历」；
//   · 锚点/置顶/高重要度记录不参与压缩（它们本来就该原样留着）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const NARRATIVE_VERSION = 1;
export const NARRATIVE_FILE = 'memory-card-narrative.json';

export const DEFAULT_NARRATIVE_CONFIG = Object.freeze({
  enabled: true,
  /** 只压这么久以前的记录（分钟）：刚聊完的话保持原样，别把当下也压成回忆。 */
  minAgeMinutes: 90,
  /** 够这么多条才值得压一段（太少就攒着）。 */
  minRecords: 6,
  /** 一次最多喂多少条给模型（多了容易写成流水账，也容易被 max_tokens 截断）。 */
  batchRecords: 24,
  /** 一轮（一个定时 tick）最多连着压几批：积压多的时候一次清完，不用每 45 分钟挤一点。 */
  maxBatchesPerTick: 6,
  /** 长期保留多少条回忆。 */
  maxEpisodes: 120,
  /** 注入提示词时最多带几条「完整回忆」（新的在前）。 */
  maxEpisodesInPrompt: 16,
  /** 比完整回忆更早的那些只留一行标题（别让旧事在卡上彻底消失）。 */
  maxEpisodeTitles: 40,
  /** 每条回忆注入时的字数上限。 */
  episodeMaxChars: 220,
  /** 模型太短/太长的输出都按这个范围收。 */
  episodeMinChars: 24,
  model: '',
  // deepseek-flash 会先输出一段 thinking，这些 token 也算在 max_tokens 里；
  // 2400 实测会把 JSON 尾巴截断，4000 才稳。
  maxTokens: 4000,
  timeoutMs: 120000
});

function hash(value, len = 12) {
  return crypto.createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, len);
}

function dateKey(ms) {
  const d = new Date(Number(ms) || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeOf(value, fallback = 0) {
  const t = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? t : fallback;
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function resolveNarrativePath(memoryDir) {
  return path.join(String(memoryDir ?? ''), NARRATIVE_FILE);
}

/** 读叙事文件；不存在/坏了都当空，绝不让它拖垮记忆卡渲染。 */
export function loadNarrative(memoryDir) {
  const raw = readJson(resolveNarrativePath(memoryDir));
  const episodes = Array.isArray(raw?.episodes) ? raw.episodes : [];
  return {
    version: NARRATIVE_VERSION,
    updatedAt: raw?.updatedAt ?? null,
    episodes: episodes
      .filter((ep) => ep && typeof ep.text === 'string' && ep.text.trim())
      .map((ep) => ({
        id: String(ep.id || `ep_${hash(`${ep.date}|${ep.title}|${ep.text}`)}`),
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(ep.date ?? '')) ? String(ep.date) : dateKey(Date.now()),
        conv: ['私聊', '群里'].includes(String(ep.conv ?? '')) ? String(ep.conv) : '',
        title: String(ep.title ?? '').trim().slice(0, 30),
        text: String(ep.text).trim().slice(0, 600),
        covers: Array.isArray(ep.covers) ? ep.covers.map((id) => String(id ?? '')).filter(Boolean) : [],
        at: Number(ep.at) || 0
      }))
  };
}

export function saveNarrative(memoryDir, narrative) {
  writeJsonAtomic(resolveNarrativePath(memoryDir), {
    version: NARRATIVE_VERSION,
    updatedAt: new Date().toISOString(),
    episodes: narrative.episodes
  });
}

/** 已经被回忆覆盖的记录 id。 */
export function coveredRecordIds(narrative) {
  const set = new Set();
  for (const ep of narrative?.episodes ?? []) for (const id of ep.covers ?? []) set.add(String(id));
  return set;
}

/** 注入提示词时显示哪些回忆（新→旧，最多 max 条）。 */
export function selectEpisodesForPrompt(narrative, { max = DEFAULT_NARRATIVE_CONFIG.maxEpisodesInPrompt } = {}) {
  return [...(narrative?.episodes ?? [])]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.at || 0) - (a.at || 0))
    .slice(0, Math.max(1, Number(max) || DEFAULT_NARRATIVE_CONFIG.maxEpisodesInPrompt));
}

/**
 * 把回忆分成两档：最近的一批写全文，更早的只留一行标题。
 * 这样卡片不会因为回忆越来越多就把早期的全丢掉（丢掉的话那些原始记录又会冒出来），
 * 也不会让旧事重新变成逐条聊天记录。
 */
export function splitEpisodesForPrompt(narrative, { max = DEFAULT_NARRATIVE_CONFIG.maxEpisodesInPrompt, maxTitles = DEFAULT_NARRATIVE_CONFIG.maxEpisodeTitles } = {}) {
  const sorted = [...(narrative?.episodes ?? [])]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.at || 0) - (a.at || 0));
  const fullCount = Math.max(1, Number(max) || DEFAULT_NARRATIVE_CONFIG.maxEpisodesInPrompt);
  const titleCount = Math.max(0, Number(maxTitles) || 0);
  return {
    full: sorted.slice(0, fullCount),
    compact: sorted.slice(fullCount, fullCount + titleCount),
    hidden: Math.max(0, sorted.length - fullCount - titleCount)
  };
}

/** 回忆发生在哪段对话，渲染成 `[私聊]` / `[群里]`（老数据没有就空着）。 */
function convTag(ep) {
  return ep?.conv === '私聊' ? ' [私聊]' : ep?.conv === '群里' ? ' [群里]' : '';
}

/** 只留标题的一行（更早的回忆）。 */
export function formatEpisodeTitleLine(ep) {
  const thisYear = String(new Date().getFullYear());
  const day = String(ep.date).startsWith(thisYear) ? String(ep.date).slice(5) : String(ep.date);
  return `- ${day}${convTag(ep)} ${ep.title || ep.text.slice(0, 14)}`;
}

/** 一条回忆渲染成一行（日期只留月日；今年以前的带年份）。 */
export function formatEpisodeLine(ep, { maxChars = DEFAULT_NARRATIVE_CONFIG.episodeMaxChars } = {}) {
  const thisYear = String(new Date().getFullYear());
  const day = String(ep.date).startsWith(thisYear) ? String(ep.date).slice(5) : String(ep.date);
  const text = ep.text.length > maxChars ? `${ep.text.slice(0, maxChars)}…` : ep.text;
  return ep.title ? `- ${day}${convTag(ep)} ${ep.title}：${text}` : `- ${day}${convTag(ep)} ${text}`;
}

/** 渲染成提示词里的「我们一起经历过的」段（新→旧）。 */
export function renderEpisodeLines(narrative, opts = {}) {
  return selectEpisodesForPrompt(narrative, opts).map((ep) => formatEpisodeLine(ep, opts));
}

const FILLER_RE = /^(?:哈+|嘿+|呵+|嗯+|哦+|噢+|好+|行+|在吗|在不在|收到|谢谢|晚安|早安|拜拜|再见|[\p{P}\p{S}\s]+)$/u;

function isNarratable(record, covered, cfg, now) {
  if (!record || !record.id) return false;
  if (covered.has(String(record.id))) return false;
  if (record.sensitive) return false;
  if (record.pinned) return false;
  // 锚点/高重要度：本来就该原样留着，别压成二手转述。
  if (Number(record.importance) >= 70) return false;
  const scope = record.scope ?? record.platform;
  if (!['qq', 'pet', 'shared'].includes(String(scope))) return false;
  const ageMs = now - timeOf(record.createdAt, now);
  if (ageMs < Math.max(0, Number(cfg.minAgeMinutes) || 0) * 60 * 1000) return false;
  const text = String(record.text ?? record.title ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 6) return false;
  if (FILLER_RE.test(text)) return false;
  return true;
}

/** 挑出这次要压的记录（最老的先）。 */
export function pickNarratableRecords(card, narrative, config = {}, now = Date.now()) {
  const cfg = { ...DEFAULT_NARRATIVE_CONFIG, ...(config || {}) };
  const covered = coveredRecordIds(narrative);
  const records = Array.isArray(card?.records) ? card.records : [];
  return records
    .filter((record) => isNarratable(record, covered, cfg, now))
    .sort((a, b) => timeOf(a.createdAt, 0) - timeOf(b.createdAt, 0))
    .slice(0, Math.max(1, Number(cfg.batchRecords) || DEFAULT_NARRATIVE_CONFIG.batchRecords));
}

/** 记录发生在哪段对话：私聊 / 群里（拿不到就空着）。 */
export function conversationOf(record) {
  if (!record) return '';
  if (record.private === true) return '私聊';
  if (record.private === false) return '群里';
  const key = String(record.conversationKey ?? '');
  if (key.startsWith('private:')) return '私聊';
  if (key.startsWith('group:') || record.groupId) return '群里';
  return '';
}

/**
 * 模型没写 conv 时的兜底（P2-5，2026-10-30）。
 * 旧实现取「占比多的那边」，但一条回忆同时覆盖私聊和群里时，标错那一侧会把私事带进群里。
 * 现在混合来源一律**降级为无标签**：不标总比标错安全。
 */
export function resolveConvFallback(covers, convById) {
  const tally = { 私聊: 0, 群里: 0 };
  for (const id of covers ?? []) {
    const conv = convById instanceof Map ? convById.get(String(id)) : convById?.[String(id)];
    if (conv === '私聊' || conv === '群里') tally[conv] += 1;
  }
  if (tally['私聊'] > 0 && tally['群里'] > 0) return '';
  if (tally['群里'] > 0) return '群里';
  if (tally['私聊'] > 0) return '私聊';
  return '';
}

function recordForPrompt(record) {
  return {
    id: String(record.id),
    date: dateKey(timeOf(record.createdAt, Date.now())),
    conv: conversationOf(record) || undefined,
    who: String(record.speaker || (Array.isArray(record.tags) && record.tags.includes('owner') ? '羽' : '群里')).slice(0, 20),
    text: String(record.text ?? record.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 220),
    ...(record.botReply ? { reply: String(record.botReply).replace(/\s+/g, ' ').trim().slice(0, 220) } : {})
  };
}

export function buildNarrationPrompt(records, existingEpisodes = [], { selfNames = [] } = {}) {
  const titles = [...existingEpisodes].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 12).map((ep) => `${ep.date} ${ep.title || ep.text.slice(0, 12)}`);
  // 她自己的 QQ 昵称/群名片会作为 speaker 出现在记录里。不告诉她这件事，
  // 模型就会把「甘棠说……」当成另一个人，写出「我把甘棠叫成了鹦鹉」这种第三人称的怪句子。
  const names = [...new Set((Array.isArray(selfNames) ? selfNames : []).map((n) => String(n ?? '').trim()).filter(Boolean))];
  const system = [
    '你在替一个住在 QQ 里的 AI 整理记忆。',
    '把零散的聊天记录压缩成「我们一起经历过什么」——像日记，不像聊天记录。',
    names.length ? `这个 AI 自己的名字/昵称是：${names.join('、')}。记录里 who 是这些名字的，都是「我」说的话，不是另一个人。` : '',
    '只输出 JSON 数组，不要解释、不要代码块标记。'
  ].filter(Boolean).join('\n');
  const user = [
    titles.length ? `已经写过的回忆（别重复，接着写新的）：\n${titles.map((t) => `- ${t}`).join('\n')}` : '这是第一次整理。',
    '',
    '下面是还没整理的记录（JSON 数组，一行一条；id 是记录编号，who 是说话的人，reply 是 AI 当时的回应）：',
    records.map((record) => JSON.stringify(recordForPrompt(record))).join('\n'),
    '',
    '要求：',
    '1. 每条回忆 2~5 句、40~200 字，写清楚发生了什么、当时的情绪/态度、有没有约定或改主意的地方；',
    '2. 第一人称：用「我」指自己，主人写成「羽」（不要写「主人」「管理员」，除非他自称）；不要「他说/她说/然后我」这种转述腔；',
    '3. 同一件事的多条记录合成一条回忆；一次输出 3~8 条，尽量把给的记录都用上；',
    '4. 保留具体细节（时间、人名、梗、视频、改过什么），不要写空泛评价（「我们聊得很开心」这种不要）；',
    '5. 输出严格 JSON 数组，元素形如 {"date":"YYYY-MM-DD","conv":"私聊|群里","title":"不超过14字的小标题","text":"回忆正文","covers":["id1","id2"]}；',
    '6. covers 只能填上面出现过的 id，且每条 id 最多用一次；分不出归属的记录可以不放进任何一条；',
    '7. 指代自己一律用「我」，不要用角色名自称（「甘棠怎么怎么样」这种写法不对）；群友用当时的昵称，不重要的人概括成「群里有人」；',
    '8. 不写真名、手机号、地址、账号这些身份信息：遇到别人报名字，写成「他告诉我一个名字」或者略过，别把原名落在回忆里；',
    '9. **私聊和群里的事要分开写**：一条回忆只讲一边（记录里的 conv 写着这条话发生在哪）；两边都涉及就拆成两条，conv 按占比多的那边填。'
  ].join('\n');
  return { system, user };
}

/** 从模型输出里抠出 JSON 数组（容忍前后的解释文字、``` 围栏、以及被截断的尾巴）。 */
export function parseEpisodes(text, allowedIds, dateById = null) {
  const raw = String(text ?? '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  let parsed = null;
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      parsed = null;
    }
  }
  // 常见失败：max_tokens 把 JSON 尾巴截断了。这时逐个大括号捞完整的对象，
  // 能救回来几条算几条（丢掉最后那条半截的）——总比整批重压一遍强。
  if (!Array.isArray(parsed)) {
    const salvaged = [];
    let depth = 0;
    let from = -1;
    for (let i = start >= 0 ? start : 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === '{') {
        if (depth === 0) from = i;
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0 && from >= 0) {
          try {
            const obj = JSON.parse(raw.slice(from, i + 1));
            if (obj && typeof obj === 'object') salvaged.push(obj);
          } catch {}
          from = -1;
        }
        if (depth < 0) depth = 0;
      }
    }
    parsed = salvaged;
  }
  if (!Array.isArray(parsed) || !parsed.length) return [];
  const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds ?? []);
  const used = new Set();
  const episodes = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const text = String(item.text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < DEFAULT_NARRATIVE_CONFIG.episodeMinChars) continue;
    const covers = [...new Set((Array.isArray(item.covers) ? item.covers : []).map(String))]
      .filter((id) => allowed.has(id) && !used.has(id));
    if (!covers.length) continue;
    for (const id of covers) used.add(id);
    const title = String(item.title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 20);
    // 日期：模型给的优先；否则用这批记录里最早的那天（别写成「今天」，那会把旧事说成刚发生的）。
    const fallbackDate = covers
      .map((id) => (dateById instanceof Map ? dateById.get(id) : null))
      .filter(Boolean)
      .sort()[0] ?? dateKey(Date.now());
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(item.date ?? '')) ? String(item.date) : fallbackDate;
    const trimmed = text.slice(0, 600);
    // 哪段对话：模型给的优先，否则按覆盖记录里占比多的那边算。
    const declared = String(item.conv ?? '').trim();
    const conv = ['私聊', '群里'].includes(declared) ? declared : '';
    episodes.push({
      id: `ep_${hash(covers.sort().join('|'))}`,
      date,
      conv,
      title,
      text: trimmed,
      covers,
      at: Date.now()
    });
  }
  return episodes;
}

// date 兜底用：parseEpisodes 只需要一个合法日期，调用方通常会给对；这里保守返回今天。
function recordsDateHint() {
  return Date.now();
}

/** 合并新回忆：已有 id 不重复，按日期排，超出上限丢最旧的。 */
export function mergeEpisodes(narrative, episodes, { max = DEFAULT_NARRATIVE_CONFIG.maxEpisodes } = {}) {
  const byId = new Map();
  for (const ep of narrative?.episodes ?? []) byId.set(ep.id, ep);
  let added = 0;
  for (const ep of episodes) {
    if (byId.has(ep.id)) continue;
    byId.set(ep.id, ep);
    added += 1;
  }
  const list = [...byId.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.at || 0) - (b.at || 0));
  const kept = list.slice(-Math.max(1, Number(max) || DEFAULT_NARRATIVE_CONFIG.maxEpisodes));
  return { episodes: kept, added, dropped: list.length - kept.length };
}

/**
 * 跑一轮记忆压缩。返回结构化结果，调用方（桥接定时器 / CLI）自己决定怎么记日志。
 */
export async function runNarration({ memoryDir, config = {}, now = Date.now(), dryRun = false, log = () => {}, complete, root, selfNames = [] } = {}) {
  const cfg = { ...DEFAULT_NARRATIVE_CONFIG, ...(config || {}) };
  if (cfg.enabled === false) return { ok: true, skipped: 'disabled' };
  if (!memoryDir) return { ok: false, error: 'memoryDir 为空' };
  const card = readJson(path.join(String(memoryDir), 'memory-card.json'));
  if (!card) return { ok: true, skipped: 'no-card' };
  const narrative = loadNarrative(memoryDir);
  // P2-1（2026-10-30）：到上限就明确返回 full，不再「压一批 → 挤掉最旧 → 原记录又能压」空转。
  // 桥接看到 full 会立即停这一轮，避免每 tick 白烧最多 6 次 LLM 调用。
  if (narrative.episodes.length >= Math.max(1, Number(cfg.maxEpisodes) || DEFAULT_NARRATIVE_CONFIG.maxEpisodes)) {
    return { ok: true, skipped: 'full', total: narrative.episodes.length };
  }
  const records = pickNarratableRecords(card, narrative, cfg, now);
  if (records.length < Math.max(1, Number(cfg.minRecords) || 1)) {
    return { ok: true, skipped: 'not-enough', picked: records.length };
  }
  const { system, user } = buildNarrationPrompt(records, narrative.episodes, { selfNames });
  // 懒加载：memory-card.js 渲染时也会 import 本模块，但它用不到网络与凭据。
  const completeFn = complete || (await import('./llm-text.js')).completeText;
  const result = await completeFn({
    system,
    user,
    model: cfg.model || undefined,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    ...(complete ? {} : { root })
  });
  const allowedIds = new Set(records.map((record) => String(record.id)));
  const dateById = new Map(records.map((record) => [String(record.id), dateKey(timeOf(record.createdAt, Date.now()))]));
  const convById = new Map(records.map((record) => [String(record.id), conversationOf(record)]));
  const episodes = parseEpisodes(result?.text, allowedIds, dateById);
  // 模型没写 conv 的：按覆盖记录来源补上；私聊和群里混合的降级为无标签（P2-5）。
  for (const ep of episodes) {
    if (ep.conv) continue;
    ep.conv = resolveConvFallback(ep.covers, convById);
  }
  if (!episodes.length) {
    log('[叙事] 模型没给出可用的回忆（输出无法解析或 covers 全空）');
    return { ok: false, error: 'no-episodes', picked: records.length, raw: String(result?.text ?? '').slice(0, 300) };
  }
  const merged = mergeEpisodes(narrative, episodes, { max: cfg.maxEpisodes });
  if (!dryRun) saveNarrative(memoryDir, { episodes: merged.episodes });
  return {
    ok: true,
    picked: records.length,
    added: merged.added,
    dropped: merged.dropped,
    total: merged.episodes.length,
    episodes: merged.episodes.slice(-merged.added),
    usage: result?.usage ?? null,
    dryRun: Boolean(dryRun)
  };
}
