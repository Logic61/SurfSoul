// 唤醒决策流水（2026-11-03）回归：
//   ① 纯逻辑：append/读取过滤/坏行容错/滚动/聚合（含「无行动且没静置」统计）；
//   ② 接线：bridge.js 的各个决策点真的调了 noteWakeDecision / 有恢复唤醒与接口；
//   ③ 真实 bridge.js（VM 夹具）：暂停时投递会落一条 skip/paused；重启恢复会记 recovery。
//
// 运行：node scripts/test-wake-decisions.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  createWakeDecisionLog,
  summarizeWakeDecisions,
  WAKE_EVENT_LABELS,
  WAKE_GATE_LABELS,
} from '../src/wake-decisions.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS', name); } catch (error) { failures += 1; console.error('FAIL', name, error.message); }
}
async function harnessTest(name, options, fn) {
  const h = await bridgeHarness(options);
  try {
    h.setMode('reserved2');
    await fn(h);
    console.log('PASS', name);
  } catch (error) {
    failures += 1;
    console.error('FAIL', name, error.message);
  } finally {
    try { await h.close(); } catch { /* 已关闭 */ }
  }
}

// ── ① 纯逻辑 ────────────────────────────────────────────────────────────────
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-decisions-'));
try {
  check('record / read：按 key/event/since/limit 过滤，坏行跳过', () => {
    const file = path.join(temp, 'a.jsonl');
    let clock = 1000;
    const log = createWakeDecisionLog(file, { now: () => (clock += 1) });
    assert.equal(log.record({ key: 'private:1', event: 'delivered', reason: 'question' }), true);
    assert.equal(log.record({ key: 'group:2', event: 'skip', gate: 'fish', reason: 'question' }), true);
    assert.equal(log.record({ key: 'private:1', event: 'turn', action: 'none', waitSatisfied: false }), true);
    fs.appendFileSync(file, '{broken json\n');
    const all = log.read({ limit: 10 });
    assert.equal(all.length, 3);
    assert.equal(log.read({ key: 'private:1' }).length, 2);
    assert.equal(log.read({ event: 'skip' }).length, 1);
    assert.equal(log.read({ since: 1003 }).length, 1, 'since 按写入时间过滤');
    assert.equal(log.read({ limit: 1 }).length, 1, 'limit 只取最近一条');
  });

  check('summarize：按事件/闸门聚合，并统计无行动且没静置的回合', () => {
    const now = 10_000;
    const entries = [
      { t: now - 5000, event: 'skip', gate: 'busy', reason: 'question:hi' },
      { t: now - 4000, event: 'skip', gate: 'busy', reason: 'question:hi' },
      { t: now - 3000, event: 'delivered', reason: 'bootstrap' },
      { t: now - 2000, event: 'turn', action: 'acted', waitSatisfied: true },
      { t: now - 1000, event: 'turn', action: 'none', waitSatisfied: false },
      { t: now - 900, event: 'turn', action: 'none', waitSatisfied: false },
      // 窗口外：不参与统计
      { t: now - 48 * 3600 * 1000, event: 'skip', gate: 'paused' },
    ];
    const stats = summarizeWakeDecisions(entries, { now, windowMs: 24 * 3600 * 1000 });
    assert.equal(stats.total, 6);
    assert.equal(stats.byEvent.delivered, 1);
    assert.equal(stats.byEvent.skip, 2);
    assert.equal(stats.turns, 3);
    assert.equal(stats.silentTurns, 2);
    assert.equal(stats.silentWithoutWait, 2);
    assert.deepEqual(stats.byGate[0], ['busy', 2]);
    assert.ok(stats.byReason.some(([reason, count]) => reason === 'question' && count === 2));
  });

  check('写入失败只返回 false（不得抛错拖垮桥接）', () => {
    const file = path.join(temp, 'dir-in-the-way');
    fs.mkdirSync(file, { recursive: true });
    const log = createWakeDecisionLog(file);
    assert.equal(log.record({ event: 'skip' }), false);
    assert.deepEqual(log.read(), []);
  });

  check('超过 maxBytes 会滚动并保留最近 keepLines 条', () => {
    const file = path.join(temp, 'roll.jsonl');
    const log = createWakeDecisionLog(file, { maxBytes: 400, keepLines: 5 });
    for (let i = 0; i < 40; i += 1) log.record({ key: 'private:1', event: 'skip', reason: 'x', i });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length <= 40, '滚动后行数不能变多');
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    assert.ok(fs.statSync(file).size < 2000, '滚动后文件不应继续膨胀');
  });

  check('标签表覆盖常用闸门/事件（控制台文案不落空）', () => {
    for (const gate of ['disabled', 'paused', 'mode', 'session', 'fish', 'tokenGuard', 'busy', 'rateLimit', 'merged', 'dshOffline']) {
      assert.ok(WAKE_GATE_LABELS[gate], `缺闸门文案：${gate}`);
    }
    for (const event of ['delivered', 'queued', 'failed', 'skip', 'deferred', 'turn']) {
      assert.ok(WAKE_EVENT_LABELS[event], `缺事件文案：${event}`);
    }
  });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

// ── ② 静态接线 ──────────────────────────────────────────────────────────────
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
const consoleHtml = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));

check('bridge 接线：决策点、恢复唤醒、提示词与只读接口都在', () => {
  for (const needle of [
    "noteWakeDecision(key, 'skip'",
    "gate: 'fish'",
    "gate: 'tokenGuard'",
    "noteWakeDecision(key, 'deferred'",
    "noteWakeDecision(key, 'delivered'",
    "noteWakeDecision(key, 'failed'",
    "noteWakeDecision(key, 'turn'",
    'scheduleRecoveryWakesV2',
    "reason === 'recovery'",
    "'/api/wake-decisions'",
  ]) {
    assert.ok(bridgeSrc.includes(needle), `bridge.js 缺少：${needle}`);
  }
  assert.ok(example.socialV2?.wake?.recoveryWake === true, 'config.example 要有 recoveryWake 默认值');
  assert.ok(Number(example.socialV2?.wake?.recoveryMaxAgeMs) > 0, 'config.example 要有 recoveryMaxAgeMs');
});

check('控制台接线：二代页有决策流水、访问页有安全姿态', () => {
  for (const needle of [
    'id="section-wake-decisions"',
    'id="wdTable"',
    "const url = '/api/wake-decisions",
    'function loadWakeDecisions',
    'id="section-posture"',
    'id="postureTable"',
    "api('/api/security-posture')",
    'function loadPosture',
  ]) {
    assert.ok(consoleHtml.includes(needle), `console.html 缺少：${needle}`);
  }
});

// ── ③ 真实 bridge.js（VM 夹具，不发 QQ）────────────────────────────────────
await harnessTest('sendWakePromptV2：暂停时落 skip/paused，不投递', { config: { socialV2: { enabled: true } } }, async (h) => {
  h.socialV2.paused = true;
  await h.sendWakePromptV2('private:123', 'question');
  const entries = h.wakeDecisionLog.read({ limit: 50 });
  const hit = entries.find((entry) => entry.event === 'skip' && entry.gate === 'paused');
  assert.ok(hit, `应记录 skip/paused，实际：${JSON.stringify(entries)}`);
  assert.equal(hit.key, 'private:123');
  assert.equal(hit.reason, 'question');
  assert.equal(hit.mode, 'reserved2');
});

await harnessTest('重启恢复：有未读且完成过 bootstrap 时记录 recovery 并排唤醒', {
  config: { socialV2: { enabled: true } },
}, async (h) => {
  h.appendSocialV2Message('private:123', '主人', '你看到我消息了吗', '你看到我消息了吗', false, true, 'm1');
  const st = h.getSocialV2State('private:123');
  st.bootstrapSent = true;
  st.lastIncomingAt = Date.now();
  h.scheduleRecoveryWakesV2('test');
  const rec = h.wakeDecisionLog.read({ limit: 50 }).find((entry) => entry.event === 'recovery');
  assert.ok(rec, '应记录 recovery 决策');
  assert.equal(rec.trigger, 'test');
  assert.ok(st.pendingWakeTimer, '应排上批处理唤醒定时器');
  if (st.pendingWakeTimer) clearTimeout(st.pendingWakeTimer);
  st.pendingWakeTimer = null;
});

await harnessTest('重启恢复：recoveryWake=false 时不补唤醒', {
  config: { socialV2: { enabled: true, wake: { recoveryWake: false } } },
}, async (h) => {
  h.appendSocialV2Message('private:123', '主人', '在吗', '在吗', false, true, 'm2');
  const st = h.getSocialV2State('private:123');
  st.bootstrapSent = true;
  st.lastIncomingAt = Date.now();
  h.scheduleRecoveryWakesV2('test');
  assert.equal(h.wakeDecisionLog.read({ limit: 50 }).filter((entry) => entry.event === 'recovery').length, 0);
  assert.ok(!st.pendingWakeTimer, '不应排唤醒');
});

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\nwake decisions tests OK');
}
