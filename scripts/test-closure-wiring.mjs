// 对话收尾判断接线：真实 bridge.js 的状态/提示词/收尾接口（VM 夹具，不连真 QQ）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run, options) {
  const h = await bridgeHarness(options);
  try {
    h.setMode('reserved2');
    await run(h);
    console.log('PASS', name);
  } catch (error) {
    failures += 1;
    console.error('FAIL', name, error.message);
  } finally {
    // 收尾后换会话是 5s 定时器：用例结束时必须清掉，否则会在后续用例/关闭后误触发。
    for (const timer of h.sessionRotateTimers.values()) clearTimeout(timer);
    h.sessionRotateTimers.clear();
    await h.close();
  }
}

const now = Date.now();
function seedChat(h, key = 'private:123') {
  h.appendSocialV2Message(key, '主人', '诶～原来主人也会脸红的呀', '诶～原来主人也会脸红的呀', false, true, 'm1');
  h.appendSocialV2Message(key, '主人', '那咱们扯平啦，谁都不许先低头', '那咱们扯平啦，谁都不许先低头', false, true, 'm2');
  const st = h.getSocialV2State(key);
  // 模拟她刚发完「嗯嗯」：reserved2 的工具发送会记进 sentTexts / recentMessages，
  // 这里直接补一条 isSelf 的最近消息，等价于「我最后一句是收尾」。
  st.recentMessages.push({
    seq: 0, messageId: null, sender: '弥', userId: null,
    text: '嗯嗯', plain: '嗯嗯', tail: '嗯嗯', isSelf: true,
    isOwner: false, media: [], hasMedia: false, time: now - 30 * 1000,
  });
  st.lastAiReplyAt = now - 30 * 1000;
  // 模拟「这些消息已经通过唤醒快照展示给模型」；close 只确认展示过的水位。
  st.modelSeenSeqs = new Set(st.unread.map((m) => m.seq));
  return st;
}

/** 连收 n 次尾（模拟「自然收尾 n 次」），返回最后一次的返回值。 */
function closeNTimes(h, key = 'private:123', n = 1) {
  let result = null;
  for (let i = 1; i <= n; i += 1) {
    result = h.closeConversationV2(key, { summary: `第${i}次收尾` });
  }
  return result;
}

await test('收尾接口：写结束点、保持唤醒配置、返回冷却，不发消息', async (h) => {
  const st = seedChat(h);
  const beforeWc = JSON.stringify(st.wakeConfig);
  const beforeUnread = st.unread.length;
  const r = h.closeConversationV2('private:123', {
    reason: 'natural',
    summary: '聊到扯平这件事',
    nextOpening: '问问她周末去不去看展',
  });
  assert.equal(r.ok, true);
  assert.equal(r.wakeKept, true);
  assert.equal(r.markedCount, beforeUnread);
  assert.equal(r.unreadCount, 0);
  assert.ok(r.cooldownUntil > now);
  assert.equal(st.closure.summary, '聊到扯平这件事');
  assert.equal(st.closure.nextOpening, '问问她周末去不去看展');
  assert.equal(st.closure.reason, 'natural');
  assert.equal(JSON.stringify(st.wakeConfig), beforeWc, '收尾不是潜水：wakeConfig 不能变');
  assert.equal(h.calls.sent.length, 0, '收尾不能发 QQ 消息');
  assert.ok(st.lastActionAt >= now);
});

await test('对方还在提问：收尾接口硬拒绝，状态不变', async (h) => {
  h.appendSocialV2Message('private:123', '主人', '你最近在忙什么', '你最近在忙什么', false, true, 'm3');
  const st = h.getSocialV2State('private:123');
  const before = JSON.stringify({ closure: st.closure, unread: st.unread.length });
  assert.throws(
    () => h.closeConversationV2('private:123', {}),
    (error) => error.statusCode === 409 && error.code === 'open-question' && /先.*回/.test(error.message),
  );
  assert.equal(JSON.stringify({ closure: st.closure, unread: st.unread.length }), before);
});

await test('收尾不走沉睡前观察；唤醒提示带「上次收在哪」（私聊不给评分表）', async (h) => {
  seedChat(h);
  // 关键：当前是潜水配置、刚刚还有新消息 —— mark_read 会被 preSleepWaitBlockedV2 拦，
  // 但 close 不是潜水，必须直接成功（否则「发完嗯嗯想结束」永远要等 5 分钟）。
  const st = h.getSocialV2State('private:123');
  st.wakeConfig.mode = 'diving';
  st.wakeConfig.infinite = true;
  st.wakeConfig.confirmedAt = 0;
  st.preSleepWaitSatisfiedAt = 0;
  st.preSleepWaitObservedAt = 0;
  const r = h.closeConversationV2('private:123', { summary: '收在这里' });
  assert.equal(r.ok, true);
  const prompt = h.buildWakePromptV2('private:123', 'replyCheck');
  // 2026-10-29 起私聊不再注入评分表（避免每轮评估「对面值不值得再聊」），只留连续性提示。
  assert.match(prompt, /【上次收在哪】/);
  assert.match(prompt, /qq_close_conversation/);
  assert.match(prompt, /不用每轮都判断要不要收/);
  assert.match(prompt, /收在这里/);

  // 群聊仍保留完整判断块。
  seedChat(h, 'group:456');
  h.state.sessions['group:456'] = h.state.sessions['group:456'] || 'fixture-session-group';
  h.closeConversationV2('group:456', { summary: '群里聊完了' });
  const groupPrompt = h.buildWakePromptV2('group:456', 'replyCheck');
  assert.match(groupPrompt, /【对话收尾判断】先判断这段是否已经自然走到终点/);
  assert.match(groupPrompt, /qq_close_conversation/);
  assert.match(groupPrompt, /群里聊完了/);
});

await test('冷却只压普通概率唤醒；被叫到/私聊照常醒', async (h) => {
  seedChat(h);
  h.closeConversationV2('private:123', {});
  const st = h.getSocialV2State('private:123');
  assert.equal(h.closureSuppressesWake(st.closure, 'probability'), true);
  assert.equal(h.closureSuppressesWake(st.closure, 'replyCheck'), true);
  assert.equal(h.closureSuppressesWake(st.closure, 'proactiveCheck'), true);
  assert.equal(h.closureSuppressesWake(st.closure, 'atMention'), false);
  assert.equal(h.closureSuppressesWake(st.closure, 'question'), false);
  assert.equal(h.closureSuppressesWake(st.closure, 'private'), false);
});

await test('对方再开口：私聊重开；群聊普通消息不重开、叫到才重开', async (h) => {
  seedChat(h);
  h.closeConversationV2('private:123', {});
  const st = h.getSocialV2State('private:123');
  const reopened = h.noteClosureReopenV2('private:123', st, { plain: '嗯嗯', text: '嗯嗯' });
  assert.equal(reopened, true);
  assert.ok(st.closure.reopenedAt > 0);

  h.appendSocialV2Message('group:456', '群友', '今天吃啥', '今天吃啥', false, false, 'g1');
  h.closeConversationV2('group:456', {});
  const gst = h.getSocialV2State('group:456');
  assert.equal(h.noteClosureReopenV2('group:456', gst, { plain: '今天吃啥', text: '今天吃啥' }), false);
  assert.equal(h.noteClosureReopenV2('group:456', gst, { plain: '弥在吗', text: '弥在吗', directAddress: true }), true);
});

await test('关掉开关：收尾接口 403，提示词不注入判断块', async (h) => {
  seedChat(h);
  h.cfg.socialV2.closure = { enabled: false };
  assert.throws(() => h.closeConversationV2('private:123', {}), (error) => error.statusCode === 403);
  const prompt = h.buildWakePromptV2('private:123', 'replyCheck');
  assert.doesNotMatch(prompt, /先判断这段是否已经自然走到终点/);
}, { config: { socialV2: { closure: { enabled: false } } } });

await test('收尾记录进状态接口所需的持久化字段', async (h) => {
  seedChat(h);
  h.closeConversationV2('private:123', { summary: '话题聊完', nextOpening: '下次问问看展' });
  const st = h.getSocialV2State('private:123');
  const saved = JSON.parse(JSON.stringify(st.closure));
  assert.equal(saved.summary, '话题聊完');
  assert.equal(saved.kind, 'private');
  assert.ok(saved.at > 0);
});

// ── 2026-11-01 主人定的新规则：自然收尾 5 次后换 session ───────────────────────
await test('自然收尾不足 5 次：不换会话', async (h) => {
  seedChat(h);
  h.state.sessions['private:123'] = 'fixture-session-count';
  closeNTimes(h, 'private:123', 4);
  assert.equal(h.sessionRotateTimers.size, 0, '第 4 次收尾还不该换会话');
});

await test('第 5 次自然收尾：挂起换会话，但收尾回合内不立刻退役', async (h) => {
  seedChat(h);
  h.state.sessions['private:123'] = 'fixture-session-five';
  closeNTimes(h, 'private:123', 4);
  assert.equal(h.sessionRotateTimers.size, 0, '第 4 次收尾不该挂');
  const r = closeNTimes(h, 'private:123', 1);
  const st = h.getSocialV2State('private:123');
  assert.equal(r.ok, true);
  assert.equal(st.sessionClosures, 5, `收尾计数应为 5，实际 ${st.sessionClosures}`);
  assert.equal(h.calls.archived.length, 0, '收尾当回合不能退役（会打断正在跑的回合）');
  assert.equal(h.sessionRotateTimers.size, 1, '第 5 次收尾应挂起换会话');

  // 对方又开口 → 取消挂起的换会话，新对话不能被拆走（计数保留，下次收尾再触发）
  const reopened = h.noteClosureReopenV2('private:123', st, { plain: '在吗', text: '在吗' });
  assert.equal(reopened, true);
  assert.equal(h.sessionRotateTimers.size, 0, '重开后应取消换会话');
  closeNTimes(h, 'private:123', 1);
  assert.equal(h.sessionRotateTimers.size, 1, '计数已 ≥5，下一次自然收尾应重新挂起');
});

await test('阈值可配：rotateAfterClosures=2 时第 2 次收尾就换', async (h) => {
  seedChat(h);
  h.state.sessions['private:123'] = 'fixture-session-config';
  closeNTimes(h, 'private:123', 1);
  assert.equal(h.sessionRotateTimers.size, 0, '第 1 次收尾不换');
  closeNTimes(h, 'private:123', 1);
  assert.equal(h.sessionRotateTimers.size, 1, '配置为 2 次时第 2 次收尾应挂起');
}, { config: { socialV2: { closure: { rotateAfterClosures: 2 } } } });

await test('换会话后计数归零：新会话从 0 重新数', async (h) => {
  seedChat(h);
  const st = h.getSocialV2State('private:123');
  h.state.sessions['private:123'] = 'fixture-session-old';
  st.sessionClosures = 5;
  h.retireSession('private:123');
  assert.equal(st.sessionClosures, 0, '退役/换会话应清零计数');
  h.state.sessions['private:123'] = 'fixture-session-new';
  closeNTimes(h, 'private:123', 1);
  assert.equal(h.sessionRotateTimers.size, 0, '新会话第 1 次收尾不换');
});

console.log(`\n${failures ? 'FAILED' : 'OK'}（closure wiring）`);
process.exitCode = failures ? 1 : 0;
