/** 每日生活参数心跳（2026-11-08，用户要求「就在早安一个心跳，改完顺便跟我说一声」）。
 *
 * 覆盖两层：
 *   1) 纯函数：配置归一 / 准点·补跑·重试·明天排程 / 提示词文案 / 与早安合并判定；
 *   2) 真实 bridge（夹具网关）：手动试跑真的投递、同一天只一次、关闭时不投、与早安合并只叫一次。
 *
 * 全离线：不连 QQ / DSH / 网络；状态文件在系统临时目录。
 * 运行：node scripts/test-life-review.mjs
 */
import assert from 'node:assert/strict';
import {
  LIFE_REVIEW_DEFAULTS, LIFE_REVIEW_GRACE_MS, LIFE_REVIEW_RETRY_MS,
  buildLifeReviewBlock, buildLifeReviewPrompt, describeLifeReviewPlan,
  normalizeLifeReviewConfig, planLifeReviewFire, shouldPiggybackGreeting,
} from '../src/life-review.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
function test(name, run) {
  try { run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, error.message); }
}
async function testAsync(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, error.message); }
}

const at = (h, m = 0, day = 23) => new Date(2026, 9, day, h, m, 0, 0).getTime();
const J = (v) => JSON.stringify(v);

test('配置归一：默认 08:00/最多 2 项/汇报开；非法值安全 clamp', () => {
  assert.deepEqual(normalizeLifeReviewConfig(undefined), { ...LIFE_REVIEW_DEFAULTS });
  assert.deepEqual(normalizeLifeReviewConfig(null), { ...LIFE_REVIEW_DEFAULTS });
  assert.equal(normalizeLifeReviewConfig({ enabled: false }).enabled, false);
  assert.equal(normalizeLifeReviewConfig({ time: '7:05' }).time, '07:05');
  assert.equal(normalizeLifeReviewConfig({ time: 'nope' }).time, '08:00');
  assert.equal(normalizeLifeReviewConfig({ maxChanges: 0 }).maxChanges, 1);
  assert.equal(normalizeLifeReviewConfig({ maxChanges: 99 }).maxChanges, 5);
  assert.equal(normalizeLifeReviewConfig({ maxChanges: 2.6 }).maxChanges, 3);
  assert.equal(normalizeLifeReviewConfig({ graceHours: -1 }).graceHours, 0);
  assert.equal(normalizeLifeReviewConfig({ graceHours: 99 }).graceHours, 12);
  assert.equal(normalizeLifeReviewConfig({ notifyOwner: false }).notifyOwner, false);
});

test('排程：准点 / 到点补跑 / 窗口外排明天 / 跑过就明天', () => {
  const early = planLifeReviewFire({ now: at(7, 0), time: '08:00' });
  assert.equal(early.mode, 'scheduled');
  assert.equal(early.fireAt, at(8, 0));

  const exact = planLifeReviewFire({ now: at(8, 0), time: '08:00' });
  assert.equal(exact.mode, 'catchup', '08:00 整（frequent 重启点）要补跑，不能丢整天');
  assert.ok(exact.fireAt - at(8, 0) <= 10_000);

  const late = planLifeReviewFire({ now: at(10, 30), time: '08:00' });
  assert.equal(late.mode, 'catchup');

  const missed = planLifeReviewFire({ now: at(8, 0) + LIFE_REVIEW_GRACE_MS + 1000, time: '08:00' });
  assert.equal(missed.mode, 'tomorrow');
  assert.equal(missed.fireAt, at(8, 0, 24));

  const done = planLifeReviewFire({ now: at(9, 0), time: '08:00', doneToday: true });
  assert.equal(done.mode, 'tomorrow', '同一天绝不反复叫醒');
});

test('重试：只在补跑窗口内 10 分钟重试，出窗口排明天', () => {
  const retry = planLifeReviewFire({ now: at(8, 5), time: '08:00', retryDelayMs: LIFE_REVIEW_RETRY_MS });
  assert.equal(retry.mode, 'retry');
  assert.equal(retry.fireAt, at(8, 5) + LIFE_REVIEW_RETRY_MS);
  const capped = planLifeReviewFire({ now: at(10, 55), time: '08:00', retryDelayMs: LIFE_REVIEW_RETRY_MS });
  assert.equal(capped.mode, 'retry');
  assert.ok(capped.fireAt <= at(8, 0) + LIFE_REVIEW_GRACE_MS);
});

test('心跳正文：限制次数、要求 verify、禁止乱改；汇报开关生效', () => {
  const on = buildLifeReviewBlock({ maxChanges: 2, notifyOwner: true });
  for (const needle of ['life_state', 'life_preview', 'life_apply', 'life_verify', 'life_rollback', '最多改 2 项', '保持不动']) {
    assert.ok(on.includes(needle), `心跳正文缺 ${needle}`);
  }
  assert.ok(on.includes('qq_send_private_message'), '默认要汇报给主人');
  assert.ok(on.includes('只读'), '要提醒只读/审批项不要碰');
  const off = buildLifeReviewBlock({ maxChanges: 1, notifyOwner: false });
  assert.ok(!off.includes('qq_send_private_message'), 'notifyOwner=false 不应要求主动发消息');
  assert.ok(off.includes('最多改 1 项'));
});

test('独立提示词：早安语义 + 补跑说明 + 会话令牌 + reserved2 发送提醒', () => {
  const prompt = buildLifeReviewPrompt({ who: '主人', time: '08:00', mode: 'reserved2', token: 'tk_fixture', maxChanges: 2 });
  assert.ok(prompt.includes('每日生活参数心跳'));
  assert.ok(prompt.includes('早安'));
  assert.ok(prompt.includes('【会话令牌】tk_fixture'));
  assert.ok(prompt.includes('reserved2'), '要说明纯文本不会自动发');
  assert.ok(!prompt.includes('补跑'));
  const catchUp = buildLifeReviewPrompt({ mode: 'reserved2', token: 't', catchUp: true });
  assert.ok(catchUp.includes('补跑'));
  const manual = buildLifeReviewPrompt({ mode: 'reserved2', token: 't', manual: true });
  assert.ok(manual.includes('手动试跑'), '手动试跑要说明不是真的早上');
  assert.ok(manual.includes('不用道早安'));
  assert.ok(!manual.split('\n')[0].includes('现在是早上'), '手动试跑不能假装现在是早上');
  assert.ok(!manual.includes('现在是早上 08:00'));
  const chat = buildLifeReviewPrompt({ mode: 'chat' });
  assert.ok(chat.includes('直接输出'));
});

test('与早安合并判定：只认「早安开 + 对象是主人 + 时间相同」', () => {
  const base = { greetingEnabled: true, greetingTarget: '123', ownerUin: '123', greetingTime: '08:00', reviewTime: '08:00' };
  assert.equal(shouldPiggybackGreeting(base), true);
  assert.equal(shouldPiggybackGreeting({ ...base, greetingEnabled: false }), false);
  assert.equal(shouldPiggybackGreeting({ ...base, greetingTarget: '456' }), false, '问候对象不是主人时不能合并（写权限在主人私聊）');
  assert.equal(shouldPiggybackGreeting({ ...base, ownerUin: '' }), false);
  assert.equal(shouldPiggybackGreeting({ ...base, reviewTime: '09:00' }), false);
  assert.equal(shouldPiggybackGreeting({ ...base, greetingTime: '8:00' }), true, '8:00 与 08:00 应视为同一时间');
  assert.ok(describeLifeReviewPlan({ plan: { fireAt: at(8, 0), mode: 'scheduled' }, config: normalizeLifeReviewConfig({}) }).includes('准点'));
});

// ── 真实 bridge（夹具） ─────────────────────────────────────────────────────

const baseConfig = () => ({
  ownerQQ: 123,
  allow: { private: ['123'], groups: ['456'] },
  lifeSettings: { enabled: true, maxWritesPerHour: 12, dailyReview: { enabled: true, time: '08:00', maxChanges: 2 } },
});

function promptTexts(h) {
  return h.calls.prompts
    .map((p) => (Array.isArray(p?.content) ? p.content.filter((c) => c?.type === 'text').map((c) => String(c.text ?? '')).join('\n') : ''))
    .join('\n---\n');
}

await testAsync('手动试跑：真实投递到主人私聊，包含心跳正文与令牌，不占当天名额', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    const result = await h.fireLifeReview({ manual: true });
    assert.equal(result.ok, true, J(result));
    const text = promptTexts(h);
    assert.ok(text.includes('每日生活参数心跳'), 'prompt 应带心跳标题');
    assert.ok(text.includes('手动试跑'), '手动试跑不能假扮早上 08:00');
    assert.ok(!text.includes('现在是早上 08:00'), '手动试跑不应声称现在是早上');
    assert.ok(text.includes('life_state'));
    assert.ok(text.includes('【会话令牌】'));
    assert.ok(h.lifeReviewState().lastDate === undefined, '手动试跑不占当天名额');
    assert.equal(h.lifeReviewState().lastManualOk, true);
  } finally { await h.close(); }
});

await testAsync('每天只一次：非手动成功写 lastDate，第二次直接跳过', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    const first = await h.fireLifeReview();
    assert.equal(first.ok, true, J(first));
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    assert.equal(h.lifeReviewState().lastDate, key);
    const countAfterFirst = h.calls.prompts.length;
    const second = await h.fireLifeReview();
    assert.equal(second.ok, true);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'already-today');
    assert.equal(h.calls.prompts.length, countAfterFirst, '同一天不应再投递');
  } finally { await h.close(); }
});

await testAsync('关闭开关 / 暂停 / 非 reserved2：不投递且不阻塞', async () => {
  const off = await bridgeHarness({ config: { ...baseConfig(), lifeSettings: { enabled: true, maxWritesPerHour: 12, dailyReview: { enabled: false } } } });
  try {
    off.setMode('reserved2'); off.setReady(true);
    const disabled = await off.fireLifeReview({ manual: true });
    assert.equal(disabled.ok, false);
    assert.equal(disabled.reason, 'disabled');
    assert.equal(off.calls.prompts.length, 0);
  } finally { await off.close(); }

  const paused = await bridgeHarness({ config: baseConfig() });
  try {
    paused.setMode('reserved2'); paused.setReady(true);
    paused.socialV2.paused = true;
    const result = await paused.fireLifeReview();
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'paused');
    assert.equal(paused.calls.prompts.length, 0, '暂停时不应叫醒');
    assert.equal(paused.lifeReviewState().lastSkip, 'paused');
  } finally { await paused.close(); }

  const chat = await bridgeHarness({ config: baseConfig() });
  try {
    chat.setMode('chat'); chat.setReady(true);
    const result = await chat.fireLifeReview();
    assert.equal(result.skipped, true);
    assert.match(String(result.reason), /mode:chat/);
    assert.equal(chat.calls.prompts.length, 0);
  } finally { await chat.close(); }
});

await testAsync('与早安合并：同一次唤醒既有早安也有心跳；独立心跳不再重复投', async () => {
  const h = await bridgeHarness({
    config: {
      ...baseConfig(),
      greetings: { enabled: true, morning: { time: '08:00', uin: 123, name: '主人' } },
    },
  });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    assert.equal(h.lifeReviewPiggybackGreeting(), true, '条件应满足');
    const greeting = await h.fireMorningGreeting({ manual: true });
    assert.equal(greeting.ok, true, J(greeting));
    const text = promptTexts(h);
    assert.ok(text.includes('定时早安'), '应包含早安正文');
    assert.ok(text.includes('每日生活参数复查'), '应包含合并进来的心跳正文');
    assert.ok(text.includes('life_state'));
    // 非手动独立心跳：已合并 → 跳过，不再产生第二次投递
    const standalone = await h.fireLifeReview();
    assert.equal(standalone.skipped, true);
    assert.equal(standalone.reason, 'piggyback');
  } finally { await h.close(); }
});

await testAsync('早安对象不是主人：不合并，心跳单独投到主人私聊', async () => {
  const h = await bridgeHarness({
    config: {
      ...baseConfig(),
      greetings: { enabled: true, morning: { time: '08:00', uin: 456, name: '朋友' } },
    },
  });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    assert.equal(h.lifeReviewPiggybackGreeting(), false);
    const result = await h.fireLifeReview();
    assert.equal(result.ok, true, J(result));
    assert.ok(promptTexts(h).includes('每日生活参数心跳'));
    assert.equal(h.lifeReviewState().lastDate !== undefined, true);
  } finally { await h.close(); }
});

await testAsync('控制台接口：GET /api/life/review 看状态；POST /api/life/review/run 手动试跑；agent 令牌 403', async () => {
  const http = await import('node:http');
  const { once } = await import('node:events');
  const h = await bridgeHarness({ config: baseConfig() });
  let server;
  try {
    h.setMode('reserved2');
    h.setReady(true);
    server = h.startConsoleServer();
    if (!server.listening) await once(server, 'listening');
    const port = server.address().port;
    const call = (path, { method = 'GET', token, body } = {}) => new Promise((resolve, reject) => {
      const headers = { 'x-console-token': 'fixture-console-token' };
      if (token) { headers['x-agent-token'] = token; headers['x-agent-call'] = '1'; }
      if (method !== 'GET') headers['content-type'] = 'application/json';
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => { let data = null; try { data = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, data }); });
      });
      req.on('error', reject);
      req.end(method === 'GET' ? undefined : JSON.stringify(body ?? {}));
    });

    const view = await call('/api/life/review');
    assert.equal(view.status, 200);
    assert.equal(view.data.ok, true);
    assert.equal(view.data.enabled, true);
    assert.equal(view.data.config.time, '08:00');
    assert.ok(view.data.next && view.data.next.mode, '应给出下一次排程');

    const run = await call('/api/life/review/run', { method: 'POST', body: {} });
    assert.equal(run.status, 200, JSON.stringify(run.data));
    assert.equal(run.data.ok, true);
    assert.ok(promptTexts(h).includes('每日生活参数心跳'));

    const asAgent = await call('/api/life/review', { token: 'whatever-token' });
    assert.equal(asAgent.status, 403);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n每日生活参数心跳测试全部通过');
}
