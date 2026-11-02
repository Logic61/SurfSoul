// 对话收尾判断：纯逻辑（不连 QQ、不建会话、不写状态）。
// 覆盖用户给的原始场景（「扯平啦」→「嗯嗯」→ 结束）与几条硬边界。
import assert from 'node:assert/strict';
import {
  DEFAULT_CLOSURE_CONFIG,
  normalizeClosureConfig,
  classifyMessage,
  assessConversationClosure,
  closurePromptBlock,
  closureSuppressesWake,
  closeGate,
  makeClosureRecord,
  normalizeClosureRecord,
  formatClosureRecord,
  closureStatus,
  reopenClosure,
  shouldRotateSessionAfterClosure,
} from '../src/conversation-closure.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('PASS', name);
  } catch (error) {
    console.error('FAIL', name, '\n ', error.message);
    process.exitCode = 1;
  }
}

const now = Date.now();
const msg = (text, { self = false, minutesAgo = 0, atSelf = false, quoteSelf = false } = {}) => ({
  isSelf: self,
  sender: self ? '弥' : '小咪',
  plain: text,
  text,
  time: now - minutesAgo * 60 * 1000,
  atSelf,
  quoteSelf,
  seq: Math.floor(Math.random() * 1e6),
});

test('配置归一化：默认开、冷却 20 分钟、坏值收敛', () => {
  const c = normalizeClosureConfig({});
  assert.equal(c.enabled, true);
  assert.equal(c.cooldownMs, DEFAULT_CLOSURE_CONFIG.cooldownMs);
  assert.equal(c.requireNoOpenQuestion, true);
  const c2 = normalizeClosureConfig({ enabled: false, cooldownMs: -1, maxSummaryChars: 9999 });
  assert.equal(c2.enabled, false);
  assert.equal(c2.cooldownMs, 60_000);
  assert.equal(c2.maxSummaryChars, 500);
});

test('消息分类：道别 / 提问 / 请求 / 附和 / 实质内容', () => {
  assert.equal(classifyMessage('晚安').kind, 'ending');
  assert.equal(classifyMessage('先这样，我下了').kind, 'ending');
  assert.equal(classifyMessage('你最近在忙什么').kind, 'question');
  assert.equal(classifyMessage('真的吗？').kind, 'question');
  assert.equal(classifyMessage('帮我查一下天气').kind, 'request');
  assert.equal(classifyMessage('嗯嗯').kind, 'ack');
  assert.equal(classifyMessage('好呀').kind, 'ack');
  assert.equal(classifyMessage('好的').kind, 'ack');
  assert.equal(classifyMessage('好嘞').kind, 'ack');
  assert.equal(classifyMessage('行行行').kind, 'ack');
  assert.equal(classifyMessage('谢谢').kind, 'ack');
  assert.equal(classifyMessage('那咱们扯平啦，谁都不许先低头').kind, 'substantive');
  assert.equal(classifyMessage('那咱们扯平啦，谁都不许先低头').settled, true);
});

test('用户原场景：对方收束 + 我回「嗯嗯」→ 可以收尾', () => {
  const a = assessConversationClosure({
    kind: 'private',
    messages: [
      msg('诶～原来主人也会脸红的呀', { minutesAgo: 3 }),
      msg('那咱们扯平啦，谁都不许先低头', { minutesAgo: 2 }),
      msg('嗯嗯', { self: true, minutesAgo: 1 }),
    ],
    now,
  });
  assert.equal(a.verdict, 'close');
  assert.equal(a.signals.lastSelfKind, 'ack');
  assert.equal(a.signals.openLoops, 0);
  assert.ok(a.score >= 0.62);
});

test('对方明确在提问、我还没答 → 不收尾，且 closeGate 硬拦', () => {
  const a = assessConversationClosure({
    kind: 'private',
    messages: [
      msg('在吗', { minutesAgo: 2 }),
      msg('你最近在忙什么', { minutesAgo: 1 }),
    ],
    now,
  });
  assert.equal(a.verdict, 'continue');
  assert.equal(a.signals.awaitingTheirAnswer, true);
  assert.equal(a.signals.openLoops, 1);
  const gate = closeGate(a, {});
  assert.equal(gate.blocked, true);
  assert.equal(gate.reason, 'open-question');
});

test('对方道别：即使我最后一句是普通内容，也判收尾', () => {
  const a = assessConversationClosure({
    kind: 'group',
    messages: [
      msg('今天先到这吧', { minutesAgo: 2 }),
      msg('明天继续', { self: true, minutesAgo: 1 }),
      msg('晚安', { minutesAgo: 0.5 }),
    ],
    now,
  });
  assert.equal(a.verdict, 'close');
  assert.equal(a.signals.explicitEnd, true);
});

test('我自己还有想说没说的：不判结束，最多先等一等', () => {
  const a = assessConversationClosure({
    kind: 'private',
    messages: [
      msg('那咱们扯平啦', { minutesAgo: 2 }),
      msg('嗯嗯', { self: true, minutesAgo: 1 }),
    ],
    pendingThoughts: [
      { text: '其实我还想问她周末去不去看展', expiresAt: now + 3600_000 },
      { text: '想说我今天遇到一只很像她的猫', expiresAt: now + 3600_000 },
    ],
    now,
  });
  assert.notEqual(a.verdict, 'close');
  assert.ok(a.signals.ownIntent >= 0.6);
});

test('对方明显还想继续（问句/请求/@）：不判结束', () => {
  const a = assessConversationClosure({
    kind: 'group',
    messages: [
      msg('弥，帮我看看这个链接', { atSelf: true, minutesAgo: 1 }),
    ],
    now,
  });
  assert.equal(a.verdict, 'continue');
  assert.ok(a.signals.theirIntent >= 0.9);
});

test('群聊话题翻篇、没人接：可以安静收尾', () => {
  const a = assessConversationClosure({
    kind: 'group',
    messages: [
      msg('有人玩那个新游戏吗', { minutesAgo: 40 }),
      msg('没玩', { minutesAgo: 39 }),
      msg('我也没', { minutesAgo: 38 }),
    ],
    now,
  });
  assert.equal(a.verdict, 'close');
});

test('收尾冷却：只压普通概率/回复检查/主动机会，不压直接叫到', () => {
  const record = { at: now, cooldownUntil: now + 20 * 60 * 1000 };
  for (const reason of ['probability', 'replyCheck', 'proactiveCheck']) {
    assert.equal(closureSuppressesWake(record, reason, now), true, reason);
  }
  for (const reason of ['atMention', 'nameMention', 'question', 'poke', 'private', 'speaker:小咪', 'keyword:猫']) {
    assert.equal(closureSuppressesWake(record, reason, now), false, reason);
  }
  assert.equal(closureSuppressesWake(record, 'probability', now + 21 * 60 * 1000), false);
});

test('收尾记录：落盘/归一化/格式化/状态摘要', () => {
  const a = assessConversationClosure({
    kind: 'private',
    messages: [msg('那咱们扯平啦', { minutesAgo: 2 }), msg('嗯嗯', { self: true, minutesAgo: 1 })],
    now,
  });
  const rec = makeClosureRecord({
    key: 'private:123', kind: 'private', assessment: a, now,
    body: { reason: 'natural', summary: '聊到扯平这件事', nextOpening: '问问她周末去不去看展' },
  });
  assert.equal(rec.key, 'private:123');
  assert.equal(rec.reason, 'natural');
  assert.equal(rec.cooldownUntil, now + DEFAULT_CLOSURE_CONFIG.cooldownMs);
  const back = normalizeClosureRecord(JSON.parse(JSON.stringify(rec)), {});
  assert.equal(back.summary, '聊到扯平这件事');
  assert.match(formatClosureRecord(back, now + 5 * 60 * 1000), /上次这段/);
  assert.match(formatClosureRecord(back, now + 5 * 60 * 1000), /下次可以这样接/);
  const st = closureStatus(back, now + 60 * 1000);
  assert.equal(st.cooldownActive, true);
  const reopened = reopenClosure(back, { now: now + 60 * 1000 });
  assert.equal(reopened.reopenedAt, now + 60 * 1000);
});

test('提示词块：含判断参数与收尾/潜水边界；没有对话时不注入', () => {
  const a = assessConversationClosure({
    kind: 'private',
    messages: [msg('那咱们扯平啦', { minutesAgo: 2 }), msg('嗯嗯', { self: true, minutesAgo: 1 })],
    now,
  });
  const block = closurePromptBlock(a, { now, config: {} });
  assert.match(block, /【对话收尾判断】/);
  assert.match(block, /qq_close_conversation/);
  assert.match(block, /不用沉睡前观察/);
  assert.match(block, /不要用收尾逃避提问/);
  const empty = assessConversationClosure({ kind: 'private', messages: [], now });
  assert.equal(closurePromptBlock(empty, { now, config: {} }), '');
});

test('关掉开关：不注入、不收尾、不冷却', () => {
  const a = assessConversationClosure({
    kind: 'private',
    messages: [msg('那咱们扯平啦', { minutesAgo: 2 }), msg('嗯嗯', { self: true, minutesAgo: 1 })],
    now,
    config: { enabled: false },
  });
  assert.equal(closurePromptBlock(a, { now, config: { enabled: false } }), '');
  assert.equal(closeGate(a, { enabled: false }).blocked, true);
  const rec = makeClosureRecord({ key: 'private:1', kind: 'private', assessment: a, now, config: { enabled: false } });
  assert.equal(closureSuppressesWake(rec, 'probability', now), true, '显式关闭不会自动取消已写入的冷却；由 bridge 决定是否写记录');
});

// 2026-11-01 主人定的会话轮换规则：不按 token，数「自然收尾次数」——收尾 5 次后换 session。
test('会话轮换阈值：默认自然收尾 5 次后换；0 = 关闭；可配', () => {
  assert.equal(DEFAULT_CLOSURE_CONFIG.rotateAfterClosures, 5);
  assert.equal(normalizeClosureConfig({}).rotateAfterClosures, 5);
  assert.equal(normalizeClosureConfig({ rotateAfterClosures: 0 }).rotateAfterClosures, 0);
  assert.equal(normalizeClosureConfig({ rotateAfterClosures: 2 }).rotateAfterClosures, 2);
  // 坏值收敛到 0..100
  assert.equal(normalizeClosureConfig({ rotateAfterClosures: -3 }).rotateAfterClosures, 0);
  assert.equal(normalizeClosureConfig({ rotateAfterClosures: 999 }).rotateAfterClosures, 100);

  // 计数是「本会话内成功收尾的次数」：第 5 次收尾才换，4 次不换。
  assert.equal(shouldRotateSessionAfterClosure(5, {}), true);
  assert.equal(shouldRotateSessionAfterClosure(6, {}), true);
  assert.equal(shouldRotateSessionAfterClosure(4, {}), false);
  assert.equal(shouldRotateSessionAfterClosure(0, {}), false);
  assert.equal(shouldRotateSessionAfterClosure(5, { rotateAfterClosures: 0 }), false);
  assert.equal(shouldRotateSessionAfterClosure(2, { rotateAfterClosures: 2 }), true);
  assert.equal(shouldRotateSessionAfterClosure(6, { rotateAfterClosures: 8 }), false);
  // 计数缺失/坏值 → 不换，绝不因为读不到计数就把会话拆了。
  assert.equal(shouldRotateSessionAfterClosure(undefined, {}), false);
  assert.equal(shouldRotateSessionAfterClosure(null, {}), false);
  assert.equal(shouldRotateSessionAfterClosure('x', {}), false);
});

// 2026-11-02 修 PITFALLS #90：收尾后要「静置 5 分钟无新消息」才换会话，避免活跃聊天时
// 几分钟就换一次 session、每次都要重发很长的 bootstrap（≈37–38k tokens）。
test('会话轮换静置窗口：默认 5 分钟；0=不等；坏值收敛', () => {
  assert.equal(DEFAULT_CLOSURE_CONFIG.rotateIdleMs, 5 * 60 * 1000);
  assert.equal(normalizeClosureConfig({}).rotateIdleMs, 5 * 60 * 1000);
  assert.equal(normalizeClosureConfig({ rotateIdleMs: 0 }).rotateIdleMs, 0, '0=回合结束即换（旧行为）');
  assert.equal(normalizeClosureConfig({ rotateIdleMs: 600000 }).rotateIdleMs, 600000);
  assert.equal(normalizeClosureConfig({ rotateIdleMs: -5 }).rotateIdleMs, 0);
  assert.equal(normalizeClosureConfig({ rotateIdleMs: 99 * 60 * 60 * 1000 }).rotateIdleMs, 60 * 60 * 1000, '上限 1 小时');
  // 静置窗口不影响「是否该轮换」的纯判断（bridge 里在 tick 时再按 lastIncomingAt 顺延）
  assert.equal(shouldRotateSessionAfterClosure(5, { rotateIdleMs: 300000 }), true);
  assert.equal(shouldRotateSessionAfterClosure(4, { rotateIdleMs: 300000 }), false);
});

console.log(`\n${process.exitCode ? 'FAILED' : 'OK'}（conversation-closure ${passed} 组）`);
