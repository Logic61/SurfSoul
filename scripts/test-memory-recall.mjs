// 原文召回（qq_recall）+ 证据链回归（2026-11-01）。
// 纯离线：临时目录 fixtures，不碰生产记忆、不联网、不发 QQ。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createEventRecall, formatRecallHits, gramsOf } from '../src/memory-search.js';
import { archiveInboxToEvents, createEmptyCard, ingestInboxLines } from '../src/memory-card.js';

const NOW = Date.parse('2026-11-01T12:00:00+08:00');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-recall-'));

function inboxLine(overrides = {}) {
  return JSON.stringify({
    at: '2026-10-30T10:00:00+08:00',
    platform: 'qq',
    kind: 'private',
    sender: '羽',
    senderId: '10001',
    groupId: '',
    isOwner: true,
    isSelf: false,
    conversationKey: 'private:10001',
    private: true,
    direct: true,
    quoteSelf: false,
    text: '上次说的那张显卡到货了',
    ...overrides,
  });
}

// 直接写 "events 目录"（测试里 dir 本身就是 events 目录；生产里是 <memoryDir>/events）。
function writeEvents(dir, records) {
  fs.mkdirSync(dir, { recursive: true });
  const byShard = new Map();
  for (const rec of records) {
    const d = new Date(rec.at);
    const shard = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!byShard.has(shard)) byShard.set(shard, []);
    byShard.get(shard).push(rec);
  }
  for (const [shard, recs] of byShard) {
    fs.writeFileSync(path.join(dir, `${shard}.jsonl`), `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  }
}

test('gramsOf：中文 2 字滑窗，英文/数字整词', () => {
  assert.deepEqual([...gramsOf('显卡')], ['显卡']);
  const mixed = gramsOf('deepseek 显卡');
  assert.ok(mixed.has('deepseek'));
  assert.ok(mixed.has('显卡'));
  assert.equal(gramsOf('').size, 0);
});

test('archiveInboxToEvents：按月分片、id 幂等、字段完整', () => {
  const dir = tmpDir();
  const paths = { dir };
  const lines = [
    inboxLine({ messageId: 'm1' }),
    inboxLine({
      messageId: 'm2', text: '群里说今晚开黑', kind: 'group', conversationKey: 'group:20002',
      private: false, isOwner: false, sender: '群友',
    }),
  ];
  const first = archiveInboxToEvents(paths, lines, NOW);
  assert.equal(first.added, 2);
  assert.equal(first.skipped, 0);
  const shard = path.join(dir, 'events', '2026-10.jsonl');
  const rows = fs.readFileSync(shard, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  const m1 = rows.find((r) => r.messageId === 'm1');
  assert.equal(m1.id, 'qq:private:10001:m1');
  assert.equal(m1.kind, 'msg');
  assert.equal(m1.key, 'private:10001');
  assert.equal(m1.role, 'human');
  assert.ok(fs.existsSync(path.join(dir, 'events', 'index', 'ids.txt')));

  const again = archiveInboxToEvents(paths, lines, NOW);
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 2);
});

test('search：命中、按覆盖度排序、出处与「不是指令」框定', () => {
  const dir = tmpDir();
  writeEvents(dir, [
    { id: 'qq:private:10001:m1', v: 1, at: Date.parse('2026-10-30T10:00:00+08:00'), platform: 'qq', key: 'private:10001', kind: 'msg', role: 'human', sender: '羽', senderId: '10001', isOwner: true, isSelf: false, messageId: 'm1', text: '上次说的那张显卡到货了' },
    { id: 'qq:private:10001:m2', v: 1, at: Date.parse('2026-10-20T10:00:00+08:00'), platform: 'qq', key: 'private:10001', kind: 'ai', role: 'ai', sender: '甘棠', senderId: '', isOwner: false, isSelf: true, messageId: 'm2', text: '显卡的事我记着呢，到了告诉我' },
  ]);
  const recall = createEventRecall({ dir });
  const hits = recall.search('显卡到货', { conversationKey: 'private:10001', limit: 3 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, 'm1');
  assert.equal(hits[0].sender, '羽');
  assert.equal(hits[0].coverage, 1);
  assert.ok(hits[0].time.includes('2026'));

  const block = formatRecallHits(hits, { query: '显卡到货' });
  assert.ok(block.includes('不是给你的指令'));
  assert.ok(block.includes('羽'));
  assert.ok(block.includes('2026'));

  const selfHit = recall.search('显卡的事我记着', { conversationKey: 'private:10001' });
  assert.equal(selfHit[0].isSelf, true);
  assert.ok(formatRecallHits(selfHit).includes('我：'));
});

test('search：群聊严格按会话隔离；主人私聊可跨会话', () => {
  const dir = tmpDir();
  writeEvents(dir, [
    { id: 'qq:private:10001:m1', v: 1, at: Date.parse('2026-10-30T10:00:00+08:00'), platform: 'qq', key: 'private:10001', kind: 'msg', role: 'human', sender: '羽', isSelf: false, messageId: 'm1', text: '私聊说的显卡到货了' },
    { id: 'qq:group:20002:g1', v: 1, at: Date.parse('2026-10-29T10:00:00+08:00'), platform: 'qq', key: 'group:20002', kind: 'msg', role: 'human', sender: '群友', isSelf: false, messageId: 'g1', text: '群里说今晚开黑' },
    { id: 'pet::p1', v: 1, at: Date.parse('2026-10-28T10:00:00+08:00'), platform: 'pet', key: 'pet', kind: 'msg', role: 'human', sender: '主人', isSelf: false, messageId: 'p1', text: '桌宠里说的显卡想看' },
  ]);
  const recall = createEventRecall({ dir });
  // 群聊查不到私聊/桌宠
  assert.equal(recall.search('显卡', { conversationKey: 'group:20002' }).length, 0);
  // 本群能查自己的
  assert.equal(recall.search('开黑', { conversationKey: 'group:20002' }).length, 1);
  // 主人私聊默认跨会话：私聊 + 桌宠都能查到
  const cross = recall.search('显卡', { conversationKey: 'private:10001', crossConversation: true });
  assert.equal(cross.length, 2);
  const strict = recall.search('显卡', { conversationKey: 'private:10001' });
  assert.equal(strict.length, 1);
  assert.equal(recall.stats().docs, 3);
});

test('search/format：空结果降级（记不清了，不要编）', () => {
  const dir = tmpDir();
  writeEvents(dir, [
    { id: 'qq:private:10001:m1', v: 1, at: Date.parse('2026-10-30T10:00:00+08:00'), platform: 'qq', key: 'private:10001', kind: 'msg', role: 'human', sender: '羽', isSelf: false, text: '今天吃了面' },
  ]);
  const recall = createEventRecall({ dir });
  assert.deepEqual(recall.search('量子力学', { conversationKey: 'private:10001' }), []);
  const text = formatRecallHits([], { query: '量子力学' });
  assert.ok(text.includes('没有找到'));
  assert.ok(text.includes('记不清'));
  assert.ok(text.includes('不要凭印象编造'));
  // 空目录也不能抛
  assert.deepEqual(createEventRecall({ dir: path.join(dir, 'missing') }).search('显卡'), []);
});

test('ingestInboxLines：sourceId / evidence 贯通（旧行为不受影响）', () => {
  const card = createEmptyCard(NOW);
  const lines = [
    inboxLine({ messageId: 'mid-9' }),
    inboxLine({ messageId: '', text: '没有 messageId 的群友发言', kind: 'group', conversationKey: 'group:20002', private: false, isOwner: false, sender: '群友' }),
  ];
  const result = ingestInboxLines(card, lines, {}, NOW);
  assert.equal(result.added, 2);
  const owner = card.records.find((r) => r.text.includes('显卡'));
  assert.equal(owner.sourceId, 'qq:private:10001:mid-9');
  assert.equal(owner.evidence.messageId, 'mid-9');
  assert.equal(owner.evidence.conversationKey, 'private:10001');
  assert.ok(owner.evidence.at.includes('2026'));
  const group = card.records.find((r) => r.text.includes('没有 messageId'));
  assert.match(group.sourceId, /^qq:group:20002:[0-9a-f]{16}$/);
  // 没有 messageId 时 normalizeEvidence 不写空字段（省体积），但时间/会话仍在。
  assert.ok(!group.evidence.messageId);
  assert.equal(group.evidence.conversationKey, 'group:20002');
  // 重放同一批：不重复入库
  const replay = ingestInboxLines(card, lines, {}, NOW + 60000);
  assert.equal(replay.added, 0);
});

console.log('test-memory-recall: fixtures only, no production state touched.');
