// 叙事层「可见 / 可操作」的插件侧回归（B4，2026-10-30）。
//
// 旧实现：记忆页看不到叙事层、命令行/API 都没有删除入口、叙事不能关；
// 用户无法审计「她记成了什么」，也无法修正一条被压错的回忆。
// 本测试 hermetic：临时 DSH_HOME，不读真实角色/配置；不会调模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const temps = [];
function tempDir(prefix = 'memory-narrative-api-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

process.env.DSH_HOME = tempDir('dsh-');
const engine = await import('../src/memory-card.js');
const memoryLib = await import('../plugins/surfcore/lib/memory-card.js');

const ISO = '2026-10-30T00:00:00.000Z';

function record(id, text) {
  return {
    id,
    source: 'qq-group',
    sourceId: '',
    platform: 'qq',
    scope: 'qq',
    kind: 'event',
    title: `原始 ${id}`,
    text,
    tags: [],
    importance: 40,
    importanceReasons: [],
    clarity: 'clear',
    pinned: false,
    createdAt: ISO,
    lastSeenAt: ISO,
    private: false,
    conversationKey: 'group:10001',
  };
}

function writeFixture() {
  const paths = memoryLib.memoryCardPaths();
  fs.mkdirSync(paths.dir, { recursive: true });
  const card = {
    version: 1,
    createdAt: ISO,
    updatedAt: ISO,
    lastMaintenanceAt: '',
    lastDecayDate: '2026-10-30',
    meta: {
      inboxSeen: [], sourceSeen: [], firstOwnerRecordId: '', firstOwnerAt: '', firstMetSource: '', firstMetAt: '',
      firstMetRecordIds: [], firstMetEventId: '', lastBackupDate: '2026-10-30',
    },
    alerts: { level: 0, at: null, acknowledgedLevel: 0, acknowledgedAt: null, lastNotified: {} },
    stats: { ingested: 3, fromBili: 0, fromQq: 3, decayed: 0, compacted: 0, forgotten: 0 },
    records: [
      record('mem_r1', '原始记录 r1：这是不该再逐条出现的旧聊天内容。'),
      record('mem_r2', '原始记录 r2：这也是被回忆覆盖的旧聊天内容。'),
      record('mem_r3', '原始记录 r3：这条没有被任何回忆覆盖。'),
    ],
  };
  fs.writeFileSync(paths.json, `${JSON.stringify(card, null, 2)}\n`);
  engine.saveMemoryNarrative(paths.dir, {
    episodes: [
      { id: 'ep_a', date: '2026-10-20', conv: '私聊', title: '旧事 A', text: '回忆正文 A：这两条旧聊天被压成了一段经历。', covers: ['mem_r1', 'mem_r2'], at: 1 },
      { id: 'ep_b', date: '2026-10-21', conv: '群里', title: '旧事 B', text: '回忆正文 B：群里聊过的事。', covers: ['mem_r3'], at: 2 },
    ],
    lastRun: { at: '2026-10-30T09:00:00.000Z', added: 2, picked: 3, usage: { total_tokens: 1234 } },
  });
  return paths;
}

test('记忆卡快照包含叙事层摘要：条数 / hidden / 上次用量 / 开关状态', () => {
  const paths = writeFixture();
  const snapshot = memoryLib.memoryCardSnapshot();
  assert.equal(snapshot.narrative.total, 2);
  assert.equal(snapshot.narrative.hidden, 0);
  assert.equal(snapshot.narrative.enabled, true);
  assert.equal(snapshot.narrative.lastRun.usage.total_tokens, 1234);
  assert.equal(snapshot.narrative.episodes.length, 2);
  // 容量口径必须等于磁盘 md（含叙事），这是 P1-1 的插件侧接线检查。
  assert.equal(snapshot.status.chars, snapshot.markdown.length);
  assert.match(snapshot.markdown, /回忆正文 A/);
  assert.doesNotMatch(snapshot.markdown, /原始记录 r1/, '被回忆覆盖的原记录不应逐条出现');
  assert.equal(fs.existsSync(paths.dir), true);
});

test('删除一条回忆：覆盖关系释放，原记录重新出现（B4）', async () => {
  writeFixture();
  const before = memoryLib.memoryCardSnapshot();
  assert.doesNotMatch(before.markdown, /原始记录 r1/);
  const result = await memoryLib.forgetNarrativeEpisode('ep_a');
  assert.equal(result.ok, true, result.error ?? '');
  assert.equal(result.removed, 1);
  const after = memoryLib.memoryCardSnapshot();
  assert.equal(after.narrative.total, 1);
  assert.doesNotMatch(after.markdown, /回忆正文 A/);
  assert.match(after.markdown, /原始记录 r1/, '删除回忆后，原记录应重新出现在卡片里');
  assert.match(after.markdown, /原始记录 r2/);
});

test('叙事层开关写进 unified 配置，快照立即可见（B4）', () => {
  writeFixture();
  const off = memoryLib.setNarrativeEnabled(false);
  assert.equal(off.ok, true);
  assert.equal(off.enabled, false);
  assert.equal(memoryLib.memoryCardSnapshot().narrative.enabled, false);
  const on = memoryLib.setNarrativeEnabled(true);
  assert.equal(on.ok, true);
  assert.equal(memoryLib.memoryCardSnapshot().narrative.enabled, true);
});

test('桥接会读取 unified 的叙事开关覆盖仓库配置（B4 接线）', () => {
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /unifiedNarrativeConfig\(/, '桥接必须读 unified 配置的叙事开关');
  assert.match(bridge, /memoryNarrative/, '桥接要认 memoryNarrative 覆盖键');
  // 批次 C：用量记账 / 关闭记忆卡不写 inbox / 关闭同步不写 feed。
  assert.match(bridge, /unifiedMemoryFlags\(\)/, '桥接必须有 unified 全局开关缓存');
  assert.match(bridge, /recordMemoryInboxEvent[\s\S]{0,300}unifiedMemoryFlags\(\)\.memoryCardEnabled/, '关掉记忆卡后不应继续写 inbox');
  assert.match(bridge, /appendPublicFeed[\s\S]{0,300}unifiedMemoryFlags\(\)\.qqToBiliEnabled/, '关掉 QQ→B站 后不应继续写 feed');
  const client = fs.readFileSync(new URL('../plugins/surfcore/lib/client.js', import.meta.url), 'utf8');
  assert.match(client, /narrative-forget/, 'UI 必须有删除回忆入口');
  assert.match(client, /memoryNarrative/, 'UI 必须有叙事开关');
});

test('叙事用量写入 token 额度：同一段 lastRun 只记一次（P2-20）', async () => {
  const paths = writeFixture();
  const calls = [];
  const recordUsage = (payload) => { calls.push(payload); return true; };
  const first = await memoryLib.accountMemoryNarrativeUsage({ recordUsage });
  assert.equal(first.ok, true);
  assert.equal(first.recorded, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].category, 'other');
  assert.equal(calls[0].sessionId, 'memory-narrative');
  assert.equal(calls[0].usage.total_tokens, 1234);
  assert.equal(calls[0].label, '记忆叙事压缩');

  const second = await memoryLib.accountMemoryNarrativeUsage({ recordUsage });
  assert.equal(second.skipped, 'accounted');
  assert.equal(calls.length, 1, '同一段用量不能重复记账');

  const card = JSON.parse(fs.readFileSync(paths.json, 'utf8'));
  assert.equal(card.meta.narrativeUsageAccountedAt, '2026-10-30T09:00:00.000Z');

  // 没有 usage 的 lastRun 不记。
  const noUsage = await memoryLib.accountMemoryNarrativeUsage({ recordUsage });
  assert.equal(noUsage.skipped, 'accounted');
});
