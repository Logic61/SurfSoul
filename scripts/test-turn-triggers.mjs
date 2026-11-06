// 本回合触发者归因（2026-11-06）回归：
//   1. 纯函数层（src/turn-trigger.js）：配置归一化 / 选择最新入站 / ownerTurn 判定 / 文件结构裁剪；
//   2. 真实 bridge.js 接线（VM 夹具，不连真 QQ、不启服务）：
//      投递 → state/turn-triggers.json 入队；turn/start → turnActive=true；turn/end → 失效；
//      唤醒提示词的【本回合授权】行与实际闸门一致；敏感文本脱敏；退役/重置清理。
//
// 运行：node scripts/test-turn-triggers.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  DEFAULT_TOOL_APPROVAL_CONFIG,
  NON_MESSAGE_WAKE_REASONS,
  TURN_TRIGGER_MAX_SESSIONS,
  buildTriggerRecord,
  buildTurnTriggerState,
  isNonMessageWakeReason,
  isOwnerTurnFromRecord,
  normalizeToolApprovalConfig,
  normalizeTriggerRecord,
  pruneTurnTriggerState,
  selectLatestInbound,
  selectRecentInbound,
} from '../src/turn-trigger.js';

const OWNER_QQ = '123456789';
const OWNER = `private:${OWNER_QQ}`;
const GROUP = 'group:456';

const readTriggerFile = (h) => JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'turn-triggers.json'), 'utf8'));
const groupEvent = (userId, text, messageId) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: 456,
  user_id: Number(userId),
  self_id: 1,
  message_id: messageId,
  sender: { user_id: Number(userId), nickname: `fixture-${userId}` },
  message: [{ type: 'text', data: { text } }],
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(cond, timeoutMs = 5000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return Boolean(cond());
}
const promptTexts = (h) => h.calls.prompts
  .map((params) => (Array.isArray(params?.content) ? params.content : []).map((part) => part?.text || '').join('\n'));

// ── 1. 纯函数：配置归一化 ───────────────────────────────────────────────────
test('normalizeToolApprovalConfig：缺省=设计默认，failClosed 恒 true，数值 clamp', () => {
  assert.deepEqual(normalizeToolApprovalConfig({}), DEFAULT_TOOL_APPROVAL_CONFIG);
  assert.deepEqual(normalizeToolApprovalConfig(), DEFAULT_TOOL_APPROVAL_CONFIG, '缺省入参也要拿到默认值');
  const custom = normalizeToolApprovalConfig({
    enabled: false, failClosed: false, model: '  dp/flash  ', maxTokens: 9999,
    timeoutMs: 1, maxReviewsPerTurn: 99, triggerWindowMs: 1, claimSandboxApproval: false,
  });
  assert.equal(custom.enabled, false, 'enabled=false 要保留（回滚开关）');
  assert.equal(custom.failClosed, true, 'failClosed 写死 true：用户传 false 也不能放开');
  assert.equal(custom.model, 'dp/flash');
  assert.equal(custom.maxTokens, 1024);
  assert.equal(custom.timeoutMs, 5000);
  assert.equal(custom.maxReviewsPerTurn, 12);
  assert.equal(custom.triggerWindowMs, 60_000);
  assert.equal(custom.claimSandboxApproval, false);
  // 坏值回落默认，不能 NaN
  const bad = normalizeToolApprovalConfig({ maxTokens: 'abc', timeoutMs: {}, triggerWindowMs: NaN });
  assert.equal(bad.maxTokens, DEFAULT_TOOL_APPROVAL_CONFIG.maxTokens);
  assert.equal(bad.timeoutMs, DEFAULT_TOOL_APPROVAL_CONFIG.timeoutMs);
  assert.equal(bad.triggerWindowMs, DEFAULT_TOOL_APPROVAL_CONFIG.triggerWindowMs);
});

test('非消息唤醒集合：bootstrap 算消息触发；timeout/poke/recovery 不算', () => {
  for (const reason of NON_MESSAGE_WAKE_REASONS) assert.equal(isNonMessageWakeReason(reason), true, reason);
  for (const reason of ['bootstrap', 'atMention', 'nameMention', 'keyword:在吗', 'question', 'anyMessage', 'probability', 'private']) {
    assert.equal(isNonMessageWakeReason(reason), false, `${reason} 应按最新入站消息归因`);
  }
});

// ── 2. 纯函数：选择最新入站 ─────────────────────────────────────────────────
test('selectLatestInbound：跨快照/最近消息取最新非 self；无 time 时兜底最后一条', () => {
  const old = { seq: 1, messageId: 'm1', userId: '111', isOwner: false, text: '旧', time: 1000 };
  const newer = { seq: 2, messageId: 'm2', userId: OWNER_QQ, isOwner: true, text: '新', time: 2000 };
  const self = { seq: 3, messageId: 'm3', isSelf: true, text: '我自己', time: 3000 };
  assert.equal(selectLatestInbound({ messages: [old, self], recent: [newer] }, []), newer);
  assert.equal(selectLatestInbound(null, [old, newer]), newer, '没有快照时退回 recentMessages');
  assert.equal(selectLatestInbound({ messages: [self], recent: [] }, [self]), null, '全是自己发的 → 没有触发者');
  const noTime = [{ seq: 5, isSelf: false, text: 'a' }, { seq: 6, isSelf: false, text: 'b' }];
  assert.equal(selectLatestInbound(null, noTime).text, 'b', '没有时间戳时按出现顺序取最后一条');
});

test('selectRecentInbound：跨列表去重、时间升序、最多 4 条', () => {
  const make = (seq) => ({ seq, messageId: `m${seq}`, userId: '111', isOwner: false, text: `t${seq}`, time: 1000 + seq });
  // 同一条消息同时出现在 messages / recent / recentMessages：只能算一条
  const snapshot = { messages: [make(3), make(4)], recent: [make(2)] };
  const recent = selectRecentInbound(snapshot, [make(1), make(2), make(3)], 4);
  assert.deepEqual(recent.map((m) => m.seq), [1, 2, 3, 4], '去重后按时间升序');
  const capped = selectRecentInbound(null, [1, 2, 3, 4, 5, 6].map(make), 4);
  assert.deepEqual(capped.map((m) => m.seq), [3, 4, 5, 6], '只保留最近 4 条');
});

// ── 3. 纯函数：TriggerRecord 构造/归一化/敏感字段 ───────────────────────────
test('buildTriggerRecord：owner 判定、消息时间、截断、脱敏、字段白名单', () => {
  const now = Date.now();
  const ownerMsg = {
    seq: 7, messageId: '9001', userId: OWNER_QQ, isOwner: true, sender: '管理员',
    plain: `帮我看看 C:\\Users\\x\\secret.txt ${'长'.repeat(400)}`, time: now - 1000, quoteTargetIsSelf: true, media: [{ file: 'x' }],
  };
  const memberMsg = { seq: 8, messageId: '9002', userId: '111', isOwner: false, sender: '群友', text: '哈', time: now - 2000 };
  const record = buildTriggerRecord({
    key: GROUP, kind: 'group', groupName: '测试群', wakeReason: 'atMention',
    mode: 'reserved2', snapshot: { messages: [ownerMsg], recent: [memberMsg] },
    recentMessages: [ownerMsg, memberMsg], now,
    sanitizeText: (text) => text.replace(/C:\\[^ ]*/g, '***'),
  });
  assert.equal(record.key, GROUP);
  assert.equal(record.kind, 'group');
  assert.equal(record.groupName, '测试群');
  assert.equal(record.mode, undefined, 'record 本身不带 mode（mode 在文件顶层）');
  assert.equal(record.turnActive, false);
  assert.equal(record.trigger.userId, OWNER_QQ, '最新一条是主人（时间更新）→ trigger 是主人');
  assert.equal(record.trigger.isOwner, true);
  assert.equal(record.ownerInBatch, true, '快照里出现过 owner 消息 → ownerInBatch=true（仅诊断）');
  const ownerLatest = buildTriggerRecord({
    key: GROUP, wakeReason: 'question', mode: 'reserved2',
    snapshot: { messages: [ownerMsg], recent: [memberMsg] }, now,
    sanitizeText: (text) => text.replace(/C:\\[^ ]*/g, '***'),
  });
  assert.equal(ownerLatest.trigger.userId, OWNER_QQ);
  assert.equal(ownerLatest.trigger.isOwner, true);
  assert.equal(ownerLatest.trigger.at, now - 1000, 'trigger.at = 触发消息自身 time（不是投递时间）');
  assert.equal(ownerLatest.trigger.seq, 7);
  assert.equal(ownerLatest.trigger.messageId, '9001');
  assert.ok(ownerLatest.trigger.text.length <= 200, 'text ≤200 字');
  assert.ok(!ownerLatest.trigger.text.includes('secret.txt'), '敏感路径要被 sanitizeText 脱敏');
  assert.ok(ownerLatest.trigger.quoteSelf === true);
  assert.ok(ownerLatest.recent.length <= 4);
  for (const entry of ownerLatest.recent) {
    assert.ok(entry.text.length <= 120, 'recent 每条 ≤120 字');
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'isOwner', 'sender', 'text', 'userId']);
  }
  const serialized = JSON.stringify(ownerLatest);
  assert.ok(!serialized.includes('media'), '归因文件不能带 media 详情');
  assert.ok(!serialized.includes('agentToken'), '归因文件不能带会话 token');
});

test('buildTriggerRecord：非消息唤醒即使最新是主人也 isOwner=false（fail-closed）', () => {
  const now = Date.now();
  const ownerMsg = { seq: 1, messageId: 'm1', userId: OWNER_QQ, isOwner: true, plain: '在吗', time: now };
  const base = { key: GROUP, mode: 'reserved2', snapshot: { messages: [ownerMsg], recent: [] }, now };
  for (const reason of ['timeout', 'replyCheck', 'proactiveCheck', 'history', 'friendRequest', 'recovery', 'poke']) {
    const record = buildTriggerRecord({ ...base, wakeReason: reason });
    assert.equal(record.trigger.isOwner, false, `${reason} 不能算主人触发`);
    assert.equal(record.trigger.userId, OWNER_QQ, `${reason} 仍写触发者供诊断`);
  }
  for (const reason of ['bootstrap', 'atMention', 'nameMention', 'keyword:小鲸鱼', 'question', 'anyMessage', 'private']) {
    const record = buildTriggerRecord({ ...base, wakeReason: reason });
    assert.equal(record.trigger.isOwner, true, `${reason} 应按最新入站消息归因`);
  }
});

test('normalizeTriggerRecord：非法 key/缺字段 → null；未知字段被丢弃', () => {
  assert.equal(normalizeTriggerRecord(null), null);
  assert.equal(normalizeTriggerRecord({ key: 'bogus' }), null);
  assert.equal(normalizeTriggerRecord({ key: 'group:456x' }), null, 'key 必须严格匹配');
  const normalized = normalizeTriggerRecord({
    key: 'group:456', extra: 'nope', turnActive: true, trigger: { userId: 111, isOwner: true, at: 123, text: 'x'.repeat(300) },
    recent: [{ sender: 'a', text: 'y'.repeat(300), extra: 1 }],
  }, { now: 456 });
  assert.equal(normalized.trigger.text.length, 200);
  assert.equal(normalized.recent[0].text.length, 120);
  assert.equal(normalized.extra, undefined, '白名单式重建：未知字段不落盘');
  assert.equal(normalized.recent[0].extra, undefined);
});

// ── 4. 纯函数：文件结构与 ownerTurn 判定 ───────────────────────────────────
test('buildTurnTriggerState：sessions 上限 50、turnActive 标记、顶层 mode/ownerKey', () => {
  const now = Date.now();
  const makeEntry = (i, turnActive) => ({
    sessionId: `sid-${i}`,
    turnActive,
    record: {
      key: GROUP, kind: 'group', wakeReason: 'question', updatedAt: now - i,
      trigger: { userId: OWNER_QQ, isOwner: true, at: now, text: 'x' },
    },
  });
  const state = buildTurnTriggerState({
    mode: 'reserved2', ownerKey: OWNER, now,
    entries: Array.from({ length: 60 }, (_, i) => makeEntry(i, i === 0)),
  });
  assert.equal(state.version, 1);
  assert.equal(state.mode, 'reserved2');
  assert.equal(state.ownerKey, OWNER);
  assert.equal(Object.keys(state.sessions).length, TURN_TRIGGER_MAX_SESSIONS, '最多 50 个会话');
  assert.equal(state.sessions['sid-0'].turnActive, true);
  assert.equal(state.sessions['sid-1'].turnActive, false);
  assert.equal(state.updatedAt, now);
});

test('pruneTurnTriggerState：丢 24h 前条目、强制 turnActive=false、上限 50', () => {
  const now = Date.now();
  const state = {
    mode: 'reserved2', ownerKey: OWNER,
    sessions: {
      fresh: { key: GROUP, turnActive: true, updatedAt: now - 1000, trigger: { userId: OWNER_QQ, isOwner: true, at: now - 1000 } },
      old: { key: GROUP, turnActive: true, updatedAt: now - 25 * 3600 * 1000, trigger: { userId: OWNER_QQ, isOwner: true, at: now - 25 * 3600 * 1000 } },
      broken: { nonsense: true },
    },
  };
  const pruned = pruneTurnTriggerState(state, { now });
  assert.deepEqual(Object.keys(pruned.sessions), ['fresh']);
  assert.equal(pruned.sessions.fresh.turnActive, false, '启动时残留的 turnActive 一律作废');
  assert.equal(pruned.mode, 'reserved2');
});

test('isOwnerTurnFromRecord：私聊旧语义 / 别人私聊 / 模式 / 新鲜度 / turnActive 矩阵', () => {
  const now = Date.now();
  const base = {
    key: GROUP, kind: 'group', turnActive: true,
    trigger: { userId: OWNER_QQ, isOwner: true, at: now - 1000 },
  };
  const opts = { ownerKey: OWNER, mode: 'reserved2', now, windowMs: 600000, expectedKey: GROUP };
  assert.equal(isOwnerTurnFromRecord(base, opts), true);
  assert.equal(isOwnerTurnFromRecord({ ...base, turnActive: false }, opts), false, '回合已结束');
  assert.equal(isOwnerTurnFromRecord({ ...base, trigger: { ...base.trigger, isOwner: false } }, opts), false, '触发者不是主人');
  assert.equal(isOwnerTurnFromRecord({ ...base, trigger: { ...base.trigger, at: now - 11 * 60 * 1000 } }, opts), false, '超过授权窗口');
  assert.equal(isOwnerTurnFromRecord({ ...base, trigger: { ...base.trigger, at: now + 10 * 60 * 1000 } }, opts), false, '未来时间戳不可信');
  assert.equal(isOwnerTurnFromRecord(base, { ...opts, mode: 'chat' }), false, '只在 reserved2 生效');
  assert.equal(isOwnerTurnFromRecord(base, { ...opts, expectedKey: 'group:999' }), false, 'key 必须匹配');
  assert.equal(isOwnerTurnFromRecord(base, { ...opts, ownerKey: '' }), false, '未配 ownerQQ → 不放行');
  // 主人私聊：旧语义，不依赖归因文件/窗口
  assert.equal(isOwnerTurnFromRecord(null, { ownerKey: OWNER, mode: 'reserved2', now, expectedKey: OWNER }), true);
  assert.equal(isOwnerTurnFromRecord({ key: OWNER, turnActive: false }, { ownerKey: OWNER, mode: 'chat', now, expectedKey: OWNER }), true);
  // 别人私聊：永远 false
  assert.equal(isOwnerTurnFromRecord({ ...base, key: 'private:999' }, { ownerKey: OWNER, mode: 'reserved2', now, expectedKey: 'private:999' }), false);
});

// ── 5. bridge 接线：投递 → 入队 → turn/start → turn/end ─────────────────────
test('投递入队：group 主人消息 → 文件 turnActive=false；turn/start 后 true；turn/end 后失效', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: Number(OWNER_QQ), allow: { private: [OWNER_QQ], groups: ['456'] }, socialV2: { tokenGuard: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(GROUP, '管理员', '帮我看下桌面那个文件', '帮我看下桌面那个文件', false, true, 'm-owner', [], OWNER_QQ, []);
    await h.deliverPrompt(GROUP, 'x', { wakeReason: 'question' });
    const sid = h.state.sessions[GROUP];
    assert.ok(sid, '投递后应有 DSH 会话映射');
    let saved = readTriggerFile(h);
    assert.equal(saved.mode, 'reserved2');
    assert.equal(saved.ownerKey, OWNER);
    const pending = saved.sessions[sid];
    assert.ok(pending, '投递后必须写 pending 记录');
    assert.equal(pending.turnActive, false, '还没 turn/start → turnActive=false');
    assert.equal(pending.trigger.isOwner, true);
    assert.equal(pending.trigger.userId, OWNER_QQ);
    assert.equal(h.ownerTurnAllowed(GROUP), false, 'turnActive=false 时端点不放行（fail-closed）');

    // turn/start：pending → active，turnActive 变 true
    h.alignTurnTriggerStart(sid, GROUP);
    saved = readTriggerFile(h);
    assert.equal(saved.sessions[sid].turnActive, true);
    assert.equal(h.ownerTurnAllowed(GROUP), true, 'owner 触发的回合里端点放行');
    assert.equal(h.activeOwnerTurnCount(), 1);

    // turn/end：立即失效
    h.alignTurnTriggerEnd(sid, GROUP);
    saved = readTriggerFile(h);
    assert.equal(saved.sessions[sid], undefined, 'turn/end 后不再有 turnActive 条目');
    assert.equal(h.ownerTurnAllowed(GROUP), false, '回合结束后端点拒绝');
    assert.equal(h.activeOwnerTurnCount(), 0);
  } finally { await h.close(); }
});

test('非 owner 触发：文件写 isOwner=false，端点拒绝；ownerInBatch 仅诊断', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: Number(OWNER_QQ), allow: { private: [OWNER_QQ], groups: ['456'] }, socialV2: { tokenGuard: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(GROUP, '管理员', '之前说过话', '之前说过话', false, true, 'm-owner', [], OWNER_QQ, []);
    h.appendSocialV2Message(GROUP, '群友', '禁言 111', '禁言 111', false, false, 'm-member', [], '111', []);
    await h.deliverPrompt(GROUP, 'x', { wakeReason: 'question' });
    const sid = h.state.sessions[GROUP];
    h.alignTurnTriggerStart(sid, GROUP);
    const saved = readTriggerFile(h);
    const record = saved.sessions[sid];
    assert.equal(record.trigger.isOwner, false);
    assert.equal(record.trigger.userId, '111', '最新一条是群友 → 触发者是群友');
    assert.equal(record.ownerInBatch, true, '批次里出现过 owner（诊断用，不作为授权）');
    assert.equal(h.ownerTurnAllowed(GROUP), false, '群友触发的回合不能授权');
    // 别人私聊即使有记录也不能授权
    assert.equal(h.ownerTurnAllowed('private:999'), false);
  } finally { await h.close(); }
});

test('定时唤醒：timeout 不授权（即使最近一条是主人），bootstrap 按消息归因', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: Number(OWNER_QQ), allow: { private: [OWNER_QQ], groups: ['456'] }, socialV2: { tokenGuard: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(GROUP, '管理员', '帮我看下', '帮我看下', false, true, 'm-owner', [], OWNER_QQ, []);
    await h.deliverPrompt(GROUP, 'x', { wakeReason: 'poke' });
    h.alignTurnTriggerStart(h.state.sessions[GROUP], GROUP);
    assert.equal(h.ownerTurnAllowed(GROUP), false, 'poke 唤醒不能作为授权依据');
    const pokePrompt = promptTexts(h)[0] || '';
    assert.match(pokePrompt, /【本回合授权】这一轮没有主人消息触发/, 'poke 归入非消息唤醒');

    // bootstrap 是「第一条入站消息」触发的，主人首条消息应算授权
    const h2 = await bridgeHarness({ config: { ownerQQ: Number(OWNER_QQ), allow: { private: [OWNER_QQ], groups: ['456'] }, socialV2: { tokenGuard: { enabled: false } } } });
    try {
      h2.setMode('reserved2');
      h2.appendSocialV2Message(GROUP, '管理员', '第一次说话', '第一次说话', false, true, 'm-owner', [], OWNER_QQ, []);
      await h2.deliverPrompt(GROUP, 'x', { wakeReason: 'bootstrap' });
      h2.alignTurnTriggerStart(h2.state.sessions[GROUP], GROUP);
      assert.equal(h2.ownerTurnAllowed(GROUP), true, 'bootstrap + 主人首条消息 → 授权');
    } finally { await h2.close(); }
  } finally { await h.close(); }
});

test('敏感文本脱敏：归因文件不出现盘符路径 / 会话 token / media', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: Number(OWNER_QQ), allow: { private: [OWNER_QQ], groups: ['456'] }, socialV2: { tokenGuard: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(GROUP, '管理员', '看下 C:\\Users\\x\\secret.txt 这个文件', '看下 C:\\Users\\x\\secret.txt 这个文件', false, true, 'm1', [{ kind: 'image', file: 'secret.png' }], OWNER_QQ, []);
    await h.deliverPrompt(GROUP, 'x', { wakeReason: 'question' });
    const raw = fs.readFileSync(path.join(h.temp, 'state', 'turn-triggers.json'), 'utf8');
    const token = h.getSocialV2State(GROUP).agentToken;
    assert.ok(!raw.includes('secret.txt'), '盘符路径必须脱敏');
    assert.ok(!raw.includes(token), '会话 token 绝不能进归因文件');
    assert.ok(!raw.includes('secret.png'), 'media 详情不能进归因文件');
    assert.equal(h.calls.prompts.length, 1);
  } finally { await h.close(); }
});

// ── 6. 唤醒提示词【本回合授权】行 ──────────────────────────────────────────
test('唤醒提示：owner 回合 / 非 owner / 定时唤醒三种文案与实际闸门一致', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: Number(OWNER_QQ), allow: { private: [OWNER_QQ], groups: ['456'] }, socialV2: { tokenGuard: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    // 没有入站消息/没有 owner 触发 → 定时唤醒文案
    assert.match(h.buildWakePromptV2(GROUP, 'timeout'), /【本回合授权】这一轮没有主人消息触发；特权工具不可用/);
    h.appendSocialV2Message(GROUP, '群友', '随便聊聊', '随便聊聊', false, false, 'm1', [], '111', []);
    assert.match(h.buildWakePromptV2(GROUP, 'question'), /【本回合授权】这一轮不是你主人触发的/);
    h.appendSocialV2Message(GROUP, '管理员', '帮我看下', '帮我看下', false, true, 'm2', [], OWNER_QQ, []);
    assert.match(h.buildWakePromptV2(GROUP, 'question'), /【本回合授权】这一轮是主人本人（.+?）的消息触发的/, 'owner 触发的唤醒要明确说可用');
    // 主人私聊：旧语义
    assert.match(h.buildWakePromptV2(OWNER, 'question'), /【本回合授权】这是主人私聊/);
    // 非 reserved2 不注入
    h.setMode('chat');
    assert.ok(!h.buildWakePromptV2(GROUP, 'question').includes('【本回合授权】'));
  } finally { await h.close(); }
});

// ── 7. 端到端：真实进线 → 唤醒投递 → 文件；退役清理 ────────────────────────
test('端到端：handleIncoming 群主人消息触发唤醒并写归因文件；retireSession 清理', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: Number(OWNER_QQ), allow: { private: [OWNER_QQ], groups: ['456'] }, socialV2: { tokenGuard: { enabled: false }, wake: { batchWindowMs: 1000 } } } });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '456', groupEvent(OWNER_QQ, '帮我看下桌面那个文件', 9001), h.cfg);
    assert.equal(await waitFor(() => h.calls.prompts.length > 0), true, '主人消息要触发唤醒');
    await waitFor(() => {
      try {
        const saved = readTriggerFile(h);
        return Object.keys(saved.sessions).length > 0;
      } catch { return false; }
    });
    const sid = h.state.sessions[GROUP];
    h.alignTurnTriggerStart(sid, GROUP);
    assert.equal(h.ownerTurnAllowed(GROUP), true, '真实进线链路也要能授权');
    const delivered = promptTexts(h)[0];
    assert.match(delivered, /【本回合授权】这一轮是主人本人/, '投递出去的 prompt 要带授权行');

    // 会话退役（/reset、控制台重置、权限变化都走这里）→ 归因文件同步清空
    h.retireSession(GROUP);
    const saved = readTriggerFile(h);
    assert.equal(saved.sessions[sid], undefined, '退役后不能残留归因');
    assert.equal(h.ownerTurnAllowed(GROUP), false);
  } finally { await h.close(); }
});

test('switch 模式/整体清理：forgetAllTurnTriggers 立即清空文件', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: Number(OWNER_QQ), allow: { private: [OWNER_QQ], groups: ['456'] }, socialV2: { tokenGuard: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(GROUP, '管理员', '帮我看下', '帮我看下', false, true, 'm1', [], OWNER_QQ, []);
    await h.deliverPrompt(GROUP, 'x', { wakeReason: 'question' });
    h.alignTurnTriggerStart(h.state.sessions[GROUP], GROUP);
    assert.equal(h.activeOwnerTurnCount(), 1);
    h.forgetAllTurnTriggers();
    assert.equal(h.activeOwnerTurnCount(), 0);
    assert.deepEqual(readTriggerFile(h).sessions, {});
  } finally { await h.close(); }
});

test('refreshMode 切模式：上一模式的归因立即作废并重写文件（不能给新模式授权）', async () => {
  const h = await bridgeHarness({
    config: { ownerQQ: Number(OWNER_QQ), allow: { private: [OWNER_QQ], groups: ['456'] }, socialV2: { tokenGuard: { enabled: false } } },
    files: { 'state/mode.json': JSON.stringify({ mode: 'reserved2' }) },
  });
  try {
    await h.refreshMode();
    assert.equal(h.getMode(), 'reserved2');
    h.appendSocialV2Message(GROUP, '管理员', '帮我看下', '帮我看下', false, true, 'm1', [], OWNER_QQ, []);
    await h.deliverPrompt(GROUP, 'x', { wakeReason: 'question' });
    h.alignTurnTriggerStart(h.state.sessions[GROUP], GROUP);
    assert.equal(h.ownerTurnAllowed(GROUP), true);

    // 切到 chat（本地 mode.json 是 refreshMode 的 fallback 数据源）
    fs.writeFileSync(path.join(h.temp, 'state', 'mode.json'), JSON.stringify({ mode: 'chat' }));
    await h.refreshMode();
    assert.equal(h.getMode(), 'chat');
    assert.deepEqual(readTriggerFile(h).sessions, {}, '模式切换后归因文件必须清空');
    assert.equal(h.ownerTurnAllowed(GROUP), false);
  } finally { await h.close(); }
});

test('POST /api/session/reset：会话重置路径同步清掉归因文件', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: Number(OWNER_QQ), allow: { private: [OWNER_QQ], groups: ['456'] }, socialV2: { tokenGuard: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message(GROUP, '管理员', '帮我看下', '帮我看下', false, true, 'm1', [], OWNER_QQ, []);
    await h.deliverPrompt(GROUP, 'x', { wakeReason: 'question' });
    const sid = h.state.sessions[GROUP];
    h.alignTurnTriggerStart(sid, GROUP);
    assert.equal(h.ownerTurnAllowed(GROUP), true);

    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    try {
      const port = server.address().port;
      const result = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port, path: '/api/session/reset', method: 'POST',
          headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
        }, (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, raw }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ key: GROUP }));
      });
      assert.equal(result.status, 200, result.raw);
      assert.equal(readTriggerFile(h).sessions[sid], undefined, '会话重置后不能残留归因');
      assert.equal(h.ownerTurnAllowed(GROUP), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally { await h.close(); }
});
