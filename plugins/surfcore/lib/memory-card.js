/**
 * 记忆卡（插件宿主侧）—— 唯一维护者。
 *
 * 分工：
 *   · QQ 桥接（独立进程）只做两件事：把「主人消息 / 直接对她说的话 / 有情绪的公开发言」
 *     追加到 `memory-inbox.jsonl`；把 `memory-card-prompt-qq.md` 注入 QQ 提示词。
 *   · 本插件（DSH 宿主进程）定时摄取 inbox + `state/bili-memory.json`，跑每日遗忘整理、
 *     容量压缩，写 memory-card.json / .md / 两份 prompt 文件，并在 80/90/100% 时告警。
 *   · B站调度器每次醒来读 `memory-card-prompt-bili.md`。
 *
 * 只有本模块写记忆卡（单进程内用 promise 链串行化）；桥接只 append 不写卡，避免并发覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, QQ_STATE_DIR, maskPath } from './paths.js';
import {
  activeMemoryPaths, activePlatformStateDir, readCurrentCharacter,
} from '../../../src/character-persona.js';
import { backupFile, listBackups, readUnified, writeJsonAtomic, writeTextAtomic } from './store.js';
import {
  DEFAULT_MEMORY_CARD_CONFIG, addManualMemory, archiveDecayedToFull, clearFirstMeeting,
  compactMemoryCard, createEmptyCard, designateFirstMeeting, fullMemoryCardStatus, loadMemoryCard,
  maintainMemoryCard, markOwnerNotified, memoryCardStatus, mergeMemories, normalizeMemoryCardConfig,
  readAllFullRecords, readInboxSince, readMemoryNarrative, recallFullMemory, renderFullMemoryCard, renderMemoryCard,
  saveFullMemoryCard, saveMemoryCardOutputs, shouldNotifyOwner,
} from '../../../src/memory-card.js?rev=20261030-memfix-b';

const EMPTY_CONFIG = normalizeMemoryCardConfig({});
const TICK_MS = 10 * 60 * 1000;

/** 当前角色的记忆路径；没有角色系统时回退旧布局。每次调用都重新解析（切换角色后立即生效）。 */
function pathsNow() {
  return activeMemoryPaths();
}

/** 当前角色的 B站 行为目录；旧布局回退到仓库 state/。 */
function biliStateDir() {
  return activePlatformStateDir(QQ_STATE_DIR);
}

function biliMemoryFile() {
  return path.join(biliStateDir(), 'bili-memory.json');
}

/**
 * 备份名里的角色 id（P1-10，2026-10-30）。
 * 旧备份名不含角色 → 多角色用户点错「恢复」会用别的角色的卡覆盖当前角色（隔离实验 ok:true）。
 * 新备份统一带 `-<charId>`；旧格式（memory-card-<iso>）仍可识别/恢复，因为它们是角色系统之前的同一份数据。
 */
function currentCharacterTag() {
  try {
    return String(readCurrentCharacter()?.id ?? '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
  } catch {
    return '';
  }
}

function memoryBackupLabel(kind) {
  const tag = currentCharacterTag();
  return tag ? `${kind}-${tag}` : kind;
}

/** 这份备份名是否属于当前角色（空角色系统/旧格式一并放行）。 */
function backupBelongsToCurrentCharacter(name) {
  const base = String(name ?? '');
  if (!base.startsWith('memory-card-')) return false;
  const tag = currentCharacterTag();
  if (!tag) return true;
  if (base.startsWith(`memory-card-${tag}-`)) return true;
  // 旧格式：没有角色 tag，时间戳紧跟 memory-card-；以及旧的手动备份前缀。
  return /^memory-card-\d{4}-\d{2}-\d{2}T/.test(base) || /^memory-card-(before-|corrupt-)/.test(base);
}

let chain = Promise.resolve();
let promptCache = new Map();

function serialize(task) {
  const next = chain.then(task, task);
  chain = next.catch(() => {});
  return next;
}

/** 切换角色前等这里清空：保证没有半截维护/压缩正在写旧角色的卡。 */
export function memoryCardIdle() {
  return chain.catch(() => {});
}

export function memoryCardConfig(unified = readUnified().config) {
  return normalizeMemoryCardConfig(unified?.memoryCard ?? EMPTY_CONFIG);
}

export function memoryCardPaths() {
  return { ...pathsNow() };
}

function todayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readBiliEntries() {
  try {
    const raw = JSON.parse(fs.readFileSync(biliMemoryFile(), 'utf8'));
    return Array.isArray(raw?.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

/** 读 inbox 增量（P1-5）：按记忆卡里的字节水位读，不再「只取最后 4000 行」。 */
function readInboxSinceCursor(card) {
  return readInboxSince(pathsNow(), card?.meta?.inboxCursor ?? null);
}

function readCardSafe() {
  return loadMemoryCard(pathsNow()) || createEmptyCard();
}

function fullPathsSummary() {
  return {
    jsonl: maskPath(pathsNow().fullJsonl),
    stats: maskPath(pathsNow().fullStats),
    markdown: maskPath(pathsNow().fullMarkdown),
    legacyJson: maskPath(pathsNow().fullJson),
  };
}

/** 读盘 + 状态（只读，不写）。 */
export function memoryCardStatusNow(config = memoryCardConfig()) {
  const card = readCardSafe();
  // P1-1：状态必须含叙事（和磁盘 md / 注入块同一口径）；否则容量条/告警按幽灵尺寸报警。
  const narrative = readMemoryNarrative(pathsNow().dir);
  const status = memoryCardStatus(card, config, Date.now(), { narrative });
  // 全量卡状态按 JSONL 文件大小/统计计数算，不渲染整份档案（否则 10GB 档案会直接卡死）。
  const full = fullMemoryCardStatus(pathsNow(), config);
  return {
    ...status,
    enabled: config.enabled !== false,
    alertLevel: Math.max(status.level, Number(card.alerts?.level) || 0),
    acknowledgedLevel: Number(card.alerts?.acknowledgedLevel) || 0,
    // 明确告诉界面：日常加载的是衰减卡；全量卡只存档。
    loaded: 'decayed',
    loadedLabel: '衰减记忆卡（日常加载）',
    full,
    paths: {
      json: maskPath(pathsNow().json),
      markdown: maskPath(pathsNow().markdown),
      promptQq: maskPath(pathsNow().promptQq),
      promptBili: maskPath(pathsNow().promptBili),
      inbox: maskPath(pathsNow().inbox),
      ...fullPathsSummary(),
    },
  };
}

/** 给控制台：状态 + 全文 + 最近记录 + 备份。 */
export function memoryCardSnapshot(config = memoryCardConfig()) {
  const card = readCardSafe();
  const now = Date.now();
  const narrative = readMemoryNarrative(pathsNow().dir);
  const status = memoryCardStatus(card, config, now, { narrative });
  const records = [...card.records]
    // 初次相遇永远第一；其次置顶；同为置顶按最近活动/重要度排。
    .sort((a, b) => {
      const first = (b.firstMet ? 1 : 0) - (a.firstMet ? 1 : 0);
      if (first) return first;
      const pin = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      if (pin) return pin;
      if (a.pinned && b.pinned) {
        const seen = (Date.parse(b.lastSeenAt) || 0) - (Date.parse(a.lastSeenAt) || 0);
        if (seen) return seen;
      }
      return (b.importance - a.importance) || (Date.parse(b.createdAt) - Date.parse(a.createdAt));
    })
    .slice(0, 80)
    .map((record) => ({
      id: record.id,
      date: record.createdAt,
      platform: record.platform,
      scope: record.scope,
      kind: record.kind,
      title: record.title,
      text: record.text.slice(0, 240),
      importance: record.importance,
      clarity: record.clarity,
      pinned: record.pinned,
      tags: record.tags,
      speaker: record.speaker,
      botReply: record.botReply || '',
      isSelf: record.isSelf === true,
      conversationKey: record.conversationKey || '',
      isInitial: record.isInitial === true,
      initialTier: record.initialTier || '',
      initialProbability: record.initialProbability || 0,
      firstMet: record.firstMet === true,
    }));
  return {
    ok: true,
    enabled: config.enabled !== false,
    config,
    // 「现在提示词里加载的是哪张卡」——控制台顶部要一眼看到。
    loaded: 'decayed',
    loadedLabel: '衰减记忆卡（日常加载）',
    status: {
      ...status,
      enabled: config.enabled !== false,
      alertLevel: status.level > 0 ? Math.max(status.level, Number(card.alerts?.level) || 0) : 0,
      acknowledgedLevel: Number(card.alerts?.acknowledgedLevel) || 0,
      loaded: 'decayed',
      loadedLabel: '衰减记忆卡（日常加载）',
      paths: {
        json: maskPath(pathsNow().json),
        markdown: maskPath(pathsNow().markdown),
        promptQq: maskPath(pathsNow().promptQq),
        promptBili: maskPath(pathsNow().promptBili),
        inbox: maskPath(pathsNow().inbox),
        ...fullPathsSummary(),
      },
    },
    markdown: renderMemoryCard(card, { config, full: true, now, narrative }),
    promptQq: renderMemoryCard(card, { config, platform: 'qq', maxChars: config.injectMaxChars.qq, now, narrative }),
    promptBili: renderMemoryCard(card, { config, platform: 'bili', maxChars: config.injectMaxChars.bili, now, narrative }),
    firstMet: (() => {
      const record = card.records.find((item) => item.id === String(card.meta.firstMetEventId ?? ''))
        ?? card.records.find((item) => item.firstMet)
        ?? null;
      return {
        source: card.meta.firstMetSource || 'auto',
        at: card.meta.firstMetAt || card.meta.firstOwnerAt || null,
        recordIds: Array.isArray(card.meta.firstMetRecordIds) ? card.meta.firstMetRecordIds : [],
        eventId: card.meta.firstMetEventId || null,
        title: record?.title || '（自动：最早一条主人互动）',
        preview: record?.text?.slice(0, 200) || '',
        mergedCount: Array.isArray(card.meta.firstMetRecordIds) ? card.meta.firstMetRecordIds.length : 0,
      };
    })(),
    records,
    backups: listBackups(200).filter((item) => backupBelongsToCurrentCharacter(item.name)
      && !item.name.startsWith('memory-card-full')
      && !item.name.startsWith('memory-card-prompt')).slice(0, 80),
  };
}

/** 全量卡专用快照：状态 + md 预览（小档案）+ 关键词召回结果。 */
export function fullMemoryCardSnapshot({ q = '', limit = 40, config = memoryCardConfig(), now = Date.now() } = {}) {
  const status = fullMemoryCardStatus(pathsNow(), config, now);
  const recalled = recallFullMemory(pathsNow(), q, { limit });
  let markdown = '';
  let truncated = false;
  if (status.bytes <= config.fullMarkdownMaxBytes) {
    const records = readAllFullRecords(pathsNow(), { maxBytes: config.fullMarkdownMaxBytes }) ?? [];
    markdown = renderFullMemoryCard(records, { now });
  } else {
    markdown = [
      '# 记忆卡（全量存档）',
      '',
      `> 档案 ${(status.bytes / 1024 / 1024).toFixed(1)} MB，超过 md 预览阈值；完整内容见 memory-card-full.jsonl。`,
      '> 用关键词搜索或 recallFullMemory() 读取，不要一次加载整份档案。',
    ].join('\n');
    truncated = true;
  }
  return {
    ok: true,
    loaded: 'decayed',
    loadedLabel: '衰减记忆卡（日常加载）',
    fullLoaded: false,
    note: '全量记忆卡只存档，不参与 QQ / B站 的日常提示词；需要时可按关键词召回。',
    status,
    markdownPreview: markdown.length > 60_000 ? `${markdown.slice(0, 60_000)}\n\n（已截断）` : markdown,
    markdownChars: status.chars,
    markdownTruncated: truncated,
    query: String(q ?? ''),
    records: recalled.map((record) => ({
      id: record.id,
      date: record.createdAt,
      platform: record.platform,
      scope: record.scope,
      kind: record.kind,
      title: record.title,
      text: record.text,
      speaker: record.speaker,
      importance: record.importance,
      tags: record.tags,
      archivedAt: record.archivedAt,
      matchScore: record.matchScore,
      botReply: record.botReply || '',
      isSelf: record.isSelf === true,
      isInitial: record.isInitial === true,
      firstMet: record.firstMet === true,
    })),
    corrupt: false,
    paths: fullPathsSummary(),
  };
}

/** 真正跑一次维护；并发调用会排队，不会互相覆盖。 */
export function runMemoryCardMaintenance({ forceDecay = false, config = memoryCardConfig(), now = Date.now() } = {}) {
  return serialize(async () => {
    if (config.enabled === false) {
      // 关掉记忆卡时要清空注入块：桥接只认文件，留着旧文件等于「设置关了但提示词还在」。
      try { writeTextAtomic(pathsNow().promptQq, ''); } catch {}
      try { writeTextAtomic(pathsNow().promptBili, ''); } catch {}
      promptCache = new Map();
      return { ok: true, disabled: true, status: memoryCardStatusNow(config) };
    }
    fs.mkdirSync(pathsNow().dir, { recursive: true });
    const before = loadMemoryCard(pathsNow());
    // P1-5：inbox 按字节水位增量读；水位在成功维护并落盘后才推进（坏卡时从头读，靠去重兜底）。
    const inbox = readInboxSinceCursor(before);
    const warnings = [];
    // 坏卡不能静默覆盖：先留一份原始文件（load 失败时 before=null）。
    if (!before && fs.existsSync(pathsNow().json)) {
      const corruptBackup = backupFile(pathsNow().json, memoryBackupLabel('memory-card-corrupt'));
      if (corruptBackup.error) warnings.push(`坏卡备份失败：${corruptBackup.error}`);
    }
    // 每天最多备份一次（P2-7：旧实现拿 lastDecayDate 当闸门 → 00:00–04:00 每 10 分钟备份一份 350KB）。
    let dailyBackedUp = false;
    if (before && before.meta?.lastBackupDate !== todayKey(now)) {
      const backup = backupFile(pathsNow().json, memoryBackupLabel('memory-card'));
      if (backup.error) warnings.push(`记忆卡备份失败：${backup.error}`);
      else dailyBackedUp = true;
    }
    // 全量卡是 append-only JSONL，不做整份备份；每天备份很小的 stats 文件即可。
    try {
      const stat = fs.statSync(pathsNow().fullStats);
      if (new Date(stat.mtimeMs).toLocaleDateString('sv-SE') !== todayKey(now)) {
        const statsBackup = backupFile(pathsNow().fullStats, 'memory-card-full-stats');
        if (statsBackup.error) warnings.push(`全量 stats 备份失败：${statsBackup.error}`);
      }
    } catch {}
    const result = maintainMemoryCard({
      paths: pathsNow(),
      config,
      biliEntries: readBiliEntries(),
      inboxLines: inbox.lines,
      inboxCursor: inbox.nextCursor,
      now,
      forceDecay,
      fullPaths: pathsNow(),
      fullConfig: config,
    });
    promptCache = new Map();
    // 备份成功才把「今天已备份」写回卡里（失败下一轮重试并继续告警）。
    if (dailyBackedUp && result?.card) {
      try {
        result.card.meta.lastBackupDate = todayKey(now);
        writeJsonAtomic(pathsNow().json, result.card);
      } catch (error) {
        warnings.push(`回写备份日期失败：${String(error?.message ?? error)}`);
      }
    }
    return {
      ok: true,
      changed: result.changed,
      addedBili: result.bili,
      addedQq: result.qq,
      addedPet: result.pet ?? 0,
      addedFull: result.full?.added ?? 0,
      warnings,
      status: memoryCardStatusNow(config),
      fullStatus: result.full?.status ?? fullMemoryCardStatus(pathsNow(), config, now),
      card: result.card,
    };
  });
}

/** 手动压缩到目标比例（默认 80%）。 */
export function compactMemoryCardNow({ targetRatio = 0.8, config = memoryCardConfig(), now = Date.now() } = {}) {
  return serialize(async () => {
    const card = readCardSafe();
    try { backupFile(pathsNow().json, memoryBackupLabel('memory-card-before-compact')); } catch {}
    const archived = archiveDecayedToFull(pathsNow(), card, config, now);
    const steps = compactMemoryCard(card, config, { targetRatio, now });
    card.lastMaintenanceAt = new Date(now).toISOString();
    const saved = saveMemoryCardOutputs(pathsNow(), card, config, now);
    saveFullMemoryCard(pathsNow(), config, now);
    promptCache = new Map();
    return { ok: true, steps, archived, ...saved, status: memoryCardStatusNow(config) };
  });
}

/** 置顶 / 取关置顶 / 忘记 / 确认告警 / 手动加一条。 */
export function applyMemoryCardAction(action, payload = {}, { config = memoryCardConfig(), now = Date.now() } = {}) {
  return serialize(async () => {
    const card = readCardSafe();
    // 忘记前先归档：刚加进来还没被维护器扫到的记录，也不能因为「忘记」而丢失全量副本。
    let archived = archiveDecayedToFull(pathsNow(), card, config, now);
    let changed = false;
    let outcome = {};
    if (action === 'pin') {
      const record = card.records.find((item) => item.id === String(payload.id ?? ''));
      if (!record) return { ok: false, error: '记忆不存在' };
      record.pinned = payload.pinned !== false;
      record.anchor = record.pinned;
      changed = true;
    } else if (action === 'forget') {
      const id = String(payload.id ?? '');
      const before = card.records.length;
      card.records = card.records.filter((item) => item.id !== id || item.pinned);
      if (card.records.length === before) return { ok: false, error: '记忆不存在或已置顶（置顶记忆不会被忘记）' };
      card.stats.forgotten = (Number(card.stats.forgotten) || 0) + 1;
      changed = true;
    } else if (action === 'ack') {
      const level = Math.max(0, Math.min(3, Number(payload.level) || Number(card.alerts?.level) || 0));
      card.alerts.acknowledgedLevel = level;
      card.alerts.acknowledgedAt = new Date(now).toISOString();
      changed = true;
    } else if (action === 'add') {
      const result = addManualMemory(card, {
        text: String(payload.text ?? ''),
        title: String(payload.title ?? ''),
        importance: payload.importance,
        scope: payload.scope,
        tags: Array.isArray(payload.tags) ? payload.tags : [],
      }, config, now);
      if (!result.added) return { ok: false, error: '内容为空或重复' };
      changed = true;
    } else if (action === 'set-first-meet') {
      // 归档已在方法开头做过：多选合并时原记录可以从衰减卡安全移除。
      const result = designateFirstMeeting(card, payload.ids, { now });
      if (!result.ok) return result;
      outcome = { merged: result.merged, removed: result.removed, eventId: result.event?.id };
      changed = true;
    } else if (action === 'clear-first-meet') {
      const result = clearFirstMeeting(card);
      if (!result.ok) return result;
      changed = true;
    } else if (action === 'merge-memories') {
      // 归档已在方法开头做过：多选合并后原记录从衰减卡移除是安全的。
      const result = mergeMemories(card, payload.ids, {
        title: String(payload.title ?? ''),
        pinned: payload.pinned !== false,
        now,
      });
      if (!result.ok) return result;
      outcome = { merged: result.merged, removed: result.removed, eventId: result.event?.id };
      changed = true;
    } else {
      return { ok: false, error: `未知 action：${action}` };
    }
    if (changed) {
      archived += archiveDecayedToFull(pathsNow(), card, config, now);
      card.updatedAt = new Date(now).toISOString();
      saveMemoryCardOutputs(pathsNow(), card, config, now);
      saveFullMemoryCard(pathsNow(), config, now);
      promptCache = new Map();
    }
    return { ok: true, archived, status: memoryCardStatusNow(config), record: payload.id ?? null, ...outcome };
  });
}

/** 恢复某份备份，然后重渲染所有输出。 */
export function restoreMemoryCardBackup(name, { config = memoryCardConfig(), now = Date.now() } = {}) {
  return serialize(async () => {
    const base = path.basename(String(name ?? ''));
    if (!base.startsWith('memory-card-') || base !== String(name)) return { ok: false, error: '备份名非法' };
    if (base.startsWith('memory-card-full')) return { ok: false, error: '这是全量卡的备份，不能恢复到衰减卡' };
    // P1-10：不许把别的角色的备份恢复到当前角色（隔离实验里旧实现直接 ok:true 覆盖整卡）。
    if (!backupBelongsToCurrentCharacter(base)) return { ok: false, error: '这是别的角色的记忆备份，不能恢复到当前角色' };
    const source = path.join(BACKUP_DIR, base);
    const resolved = path.resolve(source);
    if (!fs.existsSync(resolved)) return { ok: false, error: '备份不存在' };
    // P1-10/P2-8：先 parse + 校验结构，坏备份不能把当前卡变成空卡（旧实现 copyFileSync 后 ok:true）。
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch {
      return { ok: false, error: '备份文件不是合法 JSON，已拒绝恢复（当前记忆卡未改动）' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.records)) {
      return { ok: false, error: '备份结构不对（缺少 records 数组），已拒绝恢复（当前记忆卡未改动）' };
    }
    const warnings = [];
    const preBackup = backupFile(pathsNow().json, memoryBackupLabel('memory-card-before-restore'));
    if (preBackup.error) warnings.push(`恢复前备份失败：${preBackup.error}`);
    // 原子写：tmp + rename，恢复中途崩溃不会留下半截 JSON。
    writeJsonAtomic(pathsNow().json, parsed);
    const card = readCardSafe();
    archiveDecayedToFull(pathsNow(), card, config, now);
    saveMemoryCardOutputs(pathsNow(), card, config, now);
    saveFullMemoryCard(pathsNow(), config, now);
    promptCache = new Map();
    return { ok: true, warnings, status: memoryCardStatusNow(config) };
  });
}

/** B站调度器 / 调试用：读现成的 B站 注入块（mtime 缓存，避免每次重复读盘）。 */
export function memoryCardPromptBlock(platform = 'bili') {
  const paths = pathsNow();
  const file = platform === 'bili' ? paths.promptBili : paths.promptQq;
  const cacheKey = `${platform}:${paths.dir}`;
  try {
    const stat = fs.statSync(file);
    const hit = promptCache.get(cacheKey);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text;
    const text = fs.readFileSync(file, 'utf8').trim();
    promptCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, text });
    return text;
  } catch {
    return '';
  }
}

/** 容量告警：同一档 12 小时只通知一次；只私聊管理员，不发群。 */
export function notifyOwnerIfNeeded({ callBridge, log = () => {}, config = memoryCardConfig(), now = Date.now() } = {}) {
  // 和写卡共用同一条串行链：通知成功后会写 alerts.lastNotified，
  // 不能拿「通知前读到的旧卡」覆盖掉期间维护新增的记忆。
  return serialize(async () => {
    if (config.notifyOwner === false) return { ok: true, skipped: 'disabled' };
    const card = readCardSafe();
    const status = memoryCardStatus(card, config, now, { narrative: readMemoryNarrative(pathsNow().dir) });
    const level = Math.max(status.level, Number(card.alerts?.level) || 0);
    if (!level) return { ok: true, skipped: 'no-alert' };
    if (!shouldNotifyOwner(card, level, now)) return { ok: true, skipped: 'cooldown' };
    if (typeof callBridge !== 'function') return { ok: false, error: '桥接控制不可用' };
    const result = await callBridge('/api/memory-card/notify', {
      method: 'POST',
      body: { level, chars: status.chars, maxChars: status.maxChars, percent: status.percent },
    });
    if (!result.ok) {
      log(`记忆卡告警通知失败：${result.data?.error ?? result.error ?? `HTTP ${result.status}`}`);
      return { ok: false, error: result.data?.error ?? result.error ?? `HTTP ${result.status}` };
    }
    markOwnerNotified(card, level, now);
    card.alerts.notifiedAt = new Date(now).toISOString();
    writeJsonAtomic(pathsNow().json, card);
    log(`记忆卡告警已私聊管理员：${level} 档，${status.percent}%`);
    return { ok: true, notified: true, level, result: result.data };
  });
}

/**
 * 插件启动时挂上：启动 8 秒后先整理一次，之后每 10 分钟一次。
 * 每日衰减由 maintainMemoryCard 自己按 dailyHour 判断，不需要单独定时器。
 */
export function startMemoryCardTimer({ log = () => {}, callBridge } = {}) {
  if (process.env.SURFCORE_DISABLE_MEMORY_TIMER === '1') {
    return { stop() {}, started: false };
  }
  let stopped = false;
  let interval = null;
  let initial = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runMemoryCardMaintenance();
      if (result.disabled) return;
      if (result.warnings?.length) log(`记忆卡整理提醒：${result.warnings.join('；')}`);
      if (result.changed) {
        log(`记忆卡已整理：新增 B站 ${result.addedBili ?? 0} 条 / QQ ${result.addedQq ?? 0} 条${result.addedPet ? ` / 桌宠 ${result.addedPet} 条` : ''}，当前 ${result.status.percent}%（${result.status.chars}/${result.status.maxChars} 字）`);
      }
      await notifyOwnerIfNeeded({ callBridge, log });
    } catch (error) {
      log('记忆卡整理失败：', error?.message ?? error);
    }
  };
  initial = setTimeout(() => { void tick(); }, 8_000);
  initial.unref?.();
  interval = setInterval(() => { void tick(); }, TICK_MS);
  interval.unref?.();
  return {
    started: true,
    stop() {
      stopped = true;
      if (initial) clearTimeout(initial);
      if (interval) clearInterval(interval);
    },
  };
}

export const MEMORY_CARD_DEFAULTS = DEFAULT_MEMORY_CARD_CONFIG;
