// 目的机制接线：真实 bridge.js 的配置/预览/投递/发送回执/回合回执（VM 夹具，不连真 QQ）。
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
    await h.close();
  }
}

function seedOwner(h) {
  h.appendSocialV2Message('private:123', '主人', '明天面试有点紧张', '明天面试有点紧张', false, true, 'm1');
  h.appendSocialV2Message('private:123', '主人', '你最近在忙什么', '你最近在忙什么', false, true, 'm2');
}

await test('配置默认开、owner 回退到 config.ownerQQ', async (h) => {
  assert.equal(h.cfg.purpose.enabled, true);
  assert.equal(h.cfg.purpose.ownerUin, '123');
  assert.ok(h.cfg.purpose.quietStart);
  assert.ok(h.cfg.purpose.quietEnd);
});

await test('只读预览：会读素材/拼提示词，但不建会话、不投递、不改状态', async (h) => {
  seedOwner(h);
  const before = JSON.stringify(h.purposeState);
  const r = await h.runPurpose({ preview: true });
  assert.equal(r.ok, true);
  assert.equal(r.preview, true);
  assert.ok(r.materials.length >= 2);
  assert.ok(r.prompt.includes('【主动找主人 · 目的回合】'));
  assert.ok(r.prompt.includes('qq_send_private_message'));
  assert.ok(r.prompt.includes('明天面试有点紧张'));
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(h.calls.created.length, 0);
  assert.equal(JSON.stringify(h.purposeState), before);
});

await test('强制投递：落到 private:owner，状态先记 pending', async (h) => {
  seedOwner(h);
  const r = await h.runPurpose({ force: true });
  assert.equal(r.ok, true);
  assert.equal(r.delivered, true);
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(h.calls.prompts[0].sessionId, h.state.sessions['private:123']);
  assert.equal(h.purposeState.countToday, 1);
  assert.equal(h.purposeState.lastOutcome, 'pending');
  assert.equal(h.purposeState.nextFireAt, 0);
  assert.ok(r.selected?.text);
});

await test('回合回执：真发了 = sent；内部备忘的「待续」进 pending', async (h) => {
  seedOwner(h);
  const r = await h.runPurpose({ force: true });
  assert.equal(r.ok, true);
  const sid = h.state.sessions['private:123'];
  h.notePurposeOutbound('private:123', ['主人，明天面试的事……']);
  h.notePurposeTurnEnded(sid, {
    reason: { kind: 'completed' },
    text: '【目的】关心一下面试\n【类型】关心\n【状态】待续\n【待续】面试结果出来再问一次',
  }, true);
  assert.equal(h.purposeState.lastOutcome, 'sent');
  assert.equal(h.purposeState.attempts, 0);
  assert.ok(h.purposeState.lastSentAt > 0);
  assert.ok(h.purposeState.nextFireAt > Date.now());
  assert.equal(h.purposeState.history.at(-1).outcome, 'sent');
  assert.equal(h.purposeState.pending.length, 1);
  assert.equal(h.purposeState.pending[0].text, '面试结果出来再问一次');
});

await test('回合回执：没发消息且正常结束 = silent，不重试', async (h) => {
  seedOwner(h);
  const r = await h.runPurpose({ force: true });
  const sid = h.state.sessions['private:123'];
  h.notePurposeTurnEnded(sid, { reason: { kind: 'completed' }, text: '【目的】无【状态】跳过' }, false);
  assert.equal(r.ok, true);
  assert.equal(h.purposeState.lastOutcome, 'silent');
  assert.equal(h.purposeState.attempts, 0);
  assert.ok(h.purposeState.nextFireAt > Date.now());
});

const pad2 = (n) => String(n).padStart(2, '0');
const clockOf = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
await test('安静时段：非强制不投递；force 仍可手动试一次', async (h) => {
  seedOwner(h);
  h.purposeState.nextFireAt = 0;
  const quiet = await h.runPurpose({});
  assert.equal(quiet.ok, false);
  assert.equal(quiet.reason, 'quiet');
  assert.equal(h.calls.prompts.length, 0);
  const r = await h.runPurpose({ force: true });
  assert.equal(r.ok, true);
  assert.equal(h.calls.prompts.length, 1);
}, {
  config: {
    purpose: {
      quietStart: clockOf(Date.now() - 60 * 60 * 1000),
      quietEnd: clockOf(Date.now() + 60 * 60 * 1000),
    },
  },
});

await test('启动预热：不投递，但把人格/记忆/群聊素材变成 goals 写进状态', async (h) => {
  seedOwner(h);
  h.appendSocialV2Message('group:456', '群友', '那个养鱼游戏怎么玩啊', '那个养鱼游戏怎么玩啊', false, false, 'm3');
  await h.warmPurposeState();
  assert.ok(h.purposeState.goals.length >= 1, '预热后应有目标假设');
  assert.ok(h.purposeState.drives.connect >= 0, '预热后驱动应落盘');
  assert.ok(h.purposeState.observations.length >= 1, '预热后观察账本应有条目');
  assert.ok(h.purposeState.lastCandidateCount >= 1, '预热后应能算出候选');
  assert.equal(h.calls.prompts.length, 0, '预热不能投递');
});

await test('关掉总开关：非强制不投递；模式不对也不投递', async (h) => {
  seedOwner(h);
  h.cfg.purpose.enabled = false;
  const r = await h.runPurpose({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
  h.cfg.purpose.enabled = true;
  h.setMode('chat');
  const r2 = await h.runPurpose({});
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'mode');
});

// ── 看屏幕闸门（2026-11-07）：QQ 载体出发前通过 pet-api 问插件；拒绝就不投递，调不通 fail-open ──
// 为什么要有这几条：闸门挂在 bridge.js 的目的出发链路里，插件侧看屏幕/抽签再稳，桥接这一跳
// 断线（host.json 没写、pet-api 没起来、返回格式变了）都会让「QQ 载体不看屏幕」悄悄回退。
const PET_SCREEN_HOST = JSON.stringify({
  version: 1,
  baseUrl: 'http://127.0.0.1:5999',
  token: 'f'.repeat(48),
  api: '/dsh-surfcore/pet-api',
  pluginVersion: 'test',
  updatedAt: '2026-11-07T00:00:00.000Z',
});
const screenGateOptions = (fetchImpl, screen = { enabled: true, retryMin: 10 }) => ({
  config: {
    purpose: {
      enabled: true,
      // 不落安静时段、不等主人空闲：让「自动轮次」在任意运行时刻都能走到闸门。
      quietStart: '00:00', quietEnd: '00:00', idleThresholdMs: 0, dailyMax: 4,
      screen,
    },
  },
  files: { 'dsh/surfcore/pet/host.json': PET_SCREEN_HOST },
  globals: { fetch: fetchImpl },
});

const gateUrls = [];
await test('看屏幕闸门：插件拒绝 → 不建会话/不投递，lastSkip 记 screen-lottery', async (h) => {
  seedOwner(h);
  h.purposeState.nextFireAt = 0;
  h.purposeState.countToday = 0;
  gateUrls.length = 0;
  const r = await h.runPurpose({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'screen-lottery');
  assert.equal(gateUrls.length, 1, '出发前应向 pet-api 要一次决定');
  assert.ok(gateUrls[0].endsWith('/dsh-surfcore/pet-api/purpose/screen/decide'), `闸门应走 pet-api：${gateUrls[0]}`);
  assert.equal(h.calls.created.length, 0, '被闸门拦下时不应创建会话');
  assert.equal(h.calls.prompts.length, 0, '被闸门拦下时不应投递提示词');
  assert.equal(h.purposeState.lastSkip?.reason, 'screen-lottery', '拒绝原因要落进状态，便于排障');
}, screenGateOptions(async (url) => {
  gateUrls.push(String(url));
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, allow: false, reason: 'screen-lottery', kind: 'deny', retryMs: 900000, at: Date.now(), p: 0.85, u: 0.93, x: 0.75, degraded: false }),
  };
}));

await test('看屏幕闸门：插件放行 → 返回决定对象（allow=true）', async (h) => {
  const decision = await h.purposeScreenGateDecision();
  assert.equal(decision?.allow, true);
  assert.equal(decision?.reason, 'screen-ok');
}, screenGateOptions(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, allow: true, reason: 'screen-ok', kind: 'ok', retryMs: 0, at: Date.now() }),
})));

await test('看屏幕闸门：pet-api 调不通 → null（fail-open，不阻断排程）', async (h) => {
  const decision = await h.purposeScreenGateDecision();
  assert.equal(decision, null);
}, screenGateOptions(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5999'); }));

let disabledFetchCalls = 0;
await test('看屏幕闸门：screen 关闭时根本不发请求（返回 null）', async (h) => {
  disabledFetchCalls = 0;
  const decision = await h.purposeScreenGateDecision();
  assert.equal(decision, null);
  assert.equal(disabledFetchCalls, 0);
}, screenGateOptions(async () => {
  disabledFetchCalls += 1;
  throw new Error('should not fetch');
}, { enabled: false }));

console.log(`\n${failures ? 'FAILED' : 'OK'}（purpose wiring）`);
process.exitCode = failures ? 1 : 0;


