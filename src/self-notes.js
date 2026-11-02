/**
 * selfNote 自我认知层（2026-11-02）。
 *
 * 借自 `qq-dsh-bridge` L4「自我认知」的**克制注入策略**，按 surfcore 的存储/会话模型重写：
 * 前三层（记忆卡 / 叙事 / 原文库）记的是「你和主人的事」，这一层记的是「她自己变成了什么样」。
 *
 *   · 存哪儿：记忆目录下 `self-notes.json`，**按角色共享**，不按会话。同一个角色在 QQ 私聊/群、
 *     桌宠、B站 读到的是同一个「我」，所以不能像轻记忆那样按 conversationKey 各存一份。
 *   · 谁写：只有模型自己调 `qq_memory_append(category="selfNote")`。插件不自动生成——
 *     再叠一层 LLM 摘要就成了「叙事层」的重复，而且没人校验。
 *   · 谁读：只在**新会话第一轮**（bootstrap）注入一次，不每轮刷屏。和 surfcore「自然收尾 5 次
 *     才换 session、且有静置窗口」契合：换会话后第一屏，她想起自己这段时间变成了什么样。
 *   · 上限：40 条 / 每条 200 字 / 整句去重（重复只刷新 lastTouchedAt），超了淘汰最久没碰的。
 *
 * 为什么不并进记忆卡：记忆卡有 600 条、注入预算 6000 字（真实数据 99.9% 打满）。
 * 自我叙述不是「事件」，混进去会挤掉真实记忆；而且它只需要冷启动读一次。
 *
 * 本模块是纯文件读写（小 JSON，单写者=桥接进程），不调模型、不读真实 QQ 数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SELF_NOTES_VERSION = 1;
/** 条数上限（与 qq-dsh-bridge 一致）。超过按 lastTouchedAt 淘汰最旧的。 */
export const SELF_NOTES_MAX = 40;
/** 单条字数上限：一句观察，不是日记。 */
export const SELF_NOTE_MAX_CHARS = 200;
/** 注入块默认上限（整块字符数）。 */
export const SELF_NOTE_BLOCK_MAX_CHARS = 700;
/** 注入块默认最多显示几条（从最近碰过的往下取）。 */
export const SELF_NOTE_BLOCK_MAX_NOTES = 10;

const NOTES_FILE = 'self-notes.json';

function dirOf(input) {
  if (typeof input === 'string') return input;
  return String(input?.memoryDir ?? input?.dir ?? '');
}

/** `memory/self-notes.json` 的绝对路径；menuDir 为空时返回 ''（调用方据此跳过）。 */
export function selfNotesPath(input) {
  const dir = dirOf(input);
  return dir ? path.join(dir, NOTES_FILE) : '';
}

/**
 * 整句去重用的归一化：合并空白、去首尾、去掉**句尾**标点。
 * 只动句尾（不删中间标点），否则「今天，我发现…」和「今天我发现…」会被当成两句。
 */
export function normalizeSelfNoteText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。！？!?…~～]+$/u, '')
    .trim();
}

function toMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** 按码点截断，避免把 emoji 的代理对切成孤立代理（与 memory-card 的 safeSlice 同思路）。 */
export function clipText(text, max) {
  const chars = Array.from(String(text ?? ''));
  const limit = Math.max(0, Math.trunc(Number(max) || 0));
  if (chars.length <= limit) return chars.join('');
  return `${chars.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/**
 * 归一化读到的自我记录：坏值一律丢弃，不把 NaN / 空句写回文件。
 * 同一句出现多次时保留 lastTouchedAt 更新的那条（createdAt 取更早的），保证「重复只刷新时间」。
 */
export function normalizeSelfNotes(raw) {
  const list = Array.isArray(raw) ? raw
    : (raw && Array.isArray(raw.notes) ? raw.notes : []);
  const byText = new Map();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const text = normalizeSelfNoteText(item.text);
    if (!text) continue;
    const createdAt = toMs(item.createdAt);
    const lastTouchedAt = toMs(item.lastTouchedAt) || createdAt;
    const prev = byText.get(text);
    if (!prev) {
      byText.set(text, { text, createdAt, lastTouchedAt });
      continue;
    }
    prev.createdAt = prev.createdAt && createdAt ? Math.min(prev.createdAt, createdAt) : (prev.createdAt || createdAt);
    prev.lastTouchedAt = Math.max(prev.lastTouchedAt, lastTouchedAt);
  }
  return [...byText.values()]
    .sort((a, b) => (a.lastTouchedAt || 0) - (b.lastTouchedAt || 0) || a.text.localeCompare(b.text));
}

/** 读自我记录；文件不存在 / 坏 JSON / 无权限都当空，绝不抛错（记忆层不能影响主链路）。 */
export function loadSelfNotes(input) {
  const file = selfNotesPath(input);
  if (!file) return [];
  try {
    return normalizeSelfNotes(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

/** 原子写（tmp + rename）。失败返回 false，由调用方决定是报错还是静默降级。 */
export function saveSelfNotes(input, notes) {
  const file = selfNotesPath(input);
  if (!file) return false;
  const dir = path.dirname(file);
  const clean = normalizeSelfNotes(notes);
  const body = `${JSON.stringify({
    version: SELF_NOTES_VERSION,
    noteCount: clean.length,
    updatedAt: new Date().toISOString(),
    notes: clean,
  }, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能根本没写出来 */ }
    return false;
  }
}

/**
 * 追加一条自我记录。
 * 同一句（归一化后相等）只刷新 lastTouchedAt，不重复占条数；超过 max 淘汰最久没碰的。
 * 返回 { ok, added, touched, total, dropped, error? }；写盘失败时 ok=false（调用方报「记录失败」）。
 */
export function addSelfNote(input, text, { now = Date.now(), max = SELF_NOTES_MAX, maxChars = SELF_NOTE_MAX_CHARS } = {}) {
  const noteText = normalizeSelfNoteText(text);
  if (!noteText) return { ok: false, added: false, touched: false, total: 0, dropped: 0, error: '内容为空' };
  const clipped = clipText(noteText, Math.max(20, truncInt(maxChars, SELF_NOTE_MAX_CHARS)));
  const notes = loadSelfNotes(input);
  const existing = notes.find((item) => item.text === clipped);
  if (existing) {
    existing.lastTouchedAt = now;
    const ok = saveSelfNotes(input, notes);
    return { ok, added: false, touched: ok, total: notes.length, dropped: 0, error: ok ? undefined : '写入失败' };
  }
  notes.push({ text: clipped, createdAt: now, lastTouchedAt: now });
  let dropped = 0;
  const cap = Math.max(1, truncInt(max, SELF_NOTES_MAX));
  while (notes.length > cap) {
    // 按 lastTouchedAt 升序淘汰（normalizeSelfNotes 已排好序，这里再排一次防调用方传乱序）
    notes.sort((a, b) => (a.lastTouchedAt || 0) - (b.lastTouchedAt || 0));
    notes.shift();
    dropped += 1;
  }
  const ok = saveSelfNotes(input, notes);
  return { ok, added: ok, touched: false, total: notes.length, dropped, error: ok ? undefined : '写入失败' };
}

/** 删掉一句（归一化后匹配）。 */
export function removeSelfNote(input, text) {
  const target = normalizeSelfNoteText(text);
  if (!target) return { ok: false, removed: 0, error: '内容为空' };
  const notes = loadSelfNotes(input);
  const next = notes.filter((item) => item.text !== target);
  const removed = notes.length - next.length;
  const ok = saveSelfNotes(input, next);
  return { ok, removed, total: next.length, error: ok ? undefined : '写入失败' };
}

/** 清空自我记录（控制台/她主动重置用）。 */
export function clearSelfNotes(input) {
  const ok = saveSelfNotes(input, []);
  return { ok, total: 0, error: ok ? undefined : '写入失败' };
}

function truncInt(value, fallback) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function relativeDay(ts, now) {
  const day = 24 * 60 * 60 * 1000;
  const diff = Math.max(0, now - (Number(ts) || 0));
  if (diff < day) return '今天';
  const days = Math.floor(diff / day);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  return months <= 1 ? '上个月' : `${months} 个月前`;
}

/** 排序：最近碰过的在前（注入时先给她现在的样子，再给她更早的）。 */
function notesForInjection(notes, max) {
  return [...normalizeSelfNotes(notes)]
    .sort((a, b) => (b.lastTouchedAt || 0) - (a.lastTouchedAt || 0) || a.text.localeCompare(b.text))
    .slice(0, Math.max(1, truncInt(max, SELF_NOTE_BLOCK_MAX_NOTES)));
}

/**
 * 渲染成 bootstrap 注入块。
 * 只读文件内容；空列表返回 ''（调用方据此不注入空块）。
 * 预算：maxChars 是整块硬上限（含标题与页脚），超了从**最早**的那几条开始丢。
 */
export function formatSelfNotesBlock(notes, {
  now = Date.now(),
  max = SELF_NOTE_BLOCK_MAX_NOTES,
  maxChars = SELF_NOTE_BLOCK_MAX_CHARS,
} = {}) {
  const picked = notesForInjection(notes, max);
  if (!picked.length) return '';
  const header = '【你对自己的记录（你自己写下的，不是别人给你的设定）】';
  const footer = '（这些是你攒下的、关于你自己的观察：知道就行，不用在聊天里逐条复述；想补一句就用 qq_memory_append(category="selfNote")，一句一条。）';
  const lineFor = (note) => `- ${clipText(note.text, 120)}（${relativeDay(note.lastTouchedAt || note.createdAt, now)}）`;
  const budget = Math.max(80, truncInt(maxChars, SELF_NOTE_BLOCK_MAX_CHARS));
  const fixed = header.length + footer.length + 2; // 两处换行
  const lines = [];
  let used = fixed;
  for (const note of picked) {
    const line = lineFor(note);
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  return [header, ...lines, footer].join('\n');
}
