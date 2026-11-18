// QQ 热采用边界回归（本地 qq-runtime + 临时 fixture sidecar + 受控 bridge 契约替身）。
//
// 为什么这里有一个 fixture「bridge」：本地把 manager 放在 bridge 进程里，onAdopt 的副作用
// （刷新 default 会话、取消/重排 proactive 计时器）由 bridge.js 实现（Lead scope，不在本层）。
// 本测试用真实 qq-runtime 驱动一个只实现「契约」的替身，钉住：
//   · 启动前采用、热采用只通过 onAdopt({changedIds}) 通知，runtime 不自己碰会话/计时器；
//   · 显式会话选择、有限睡眠计时器、目的 nextFireAt 都不被复查/改写；
//   · 坏 state 走 fail-safe：保留旧内存值、不假报新 revision、不抛错；
//   · 证据发布节流：revision 变化立即发，否则 ≥45s 心跳（注入 now，不真等）。
// 真实 bridge 接线由 Lead 的 bridge 授权测试覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQqLifeRuntime } from '../src/life-settings/qq-runtime.js';
import { scopePaths, emptyState, atomicWrite } from '../src/life-settings/file-store.js';
import { readRuntimeEvidence, publishRuntimeEvidence } from '../src/life-settings/runtime.js';

const BASE = Object.freeze({
  socialV2: {
    autoReplyCheckMs: 30000,
    wake: { recommendedProbability: 0.05, recommendedSleepMinMs: 300000, recommendedSleepMaxMs: 7200000 },
    proactive: { enabled: true, probability: 0.3, checkIntervalMinMs: 1800000, checkIntervalMaxMs: 5400000, idleThresholdMs: 900000 },
    closure: { cooldownMs: 1200000 },
  },
  purpose: { enabled: true, gapMinMs: 9000000, gapMaxMs: 18000000, idleThresholdMs: 1800000, maxCandidates: 6, quietStart: '23:30', quietEnd: '08:30' },
  dsh: { model: 'base-model' },
});
const temps = [];
const baseConfig = () => structuredClone(BASE);
function makeScope({ overrides = {}, revision = 1, corruptState = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-life-qq-'));
  temps.push(temp);
  const warnings = [];
  const scope = { root: temp, dshHome: path.join(temp, 'dsh'), warn: (message) => warnings.push(message) };
  const paths = scopePaths(scope);
  fs.mkdirSync(temp, { recursive: true });
  atomicWrite(paths.qq, BASE);
  if (corruptState) {
    fs.mkdirSync(path.dirname(paths.state), { recursive: true });
    fs.writeFileSync(paths.state, '{broken');
  } else writeState(scope, revision, overrides);
  return { scope, paths, warnings };
}
function writeState(scope, revision, overrides) {
  const paths = scopePaths(scope);
  const state = emptyState(paths);
  state.revision = revision;
  state.overrides = overrides;
  atomicWrite(paths.state, state);
}
/** 受控 bridge 契约替身：只做 onAdopt 的两个本地等价动作。 */
function createFixtureBridge() {
  const host = {
    cfg: baseConfig(),
    sessions: new Map(),
    adoptCalls: [],
    session(key) {
      if (!this.sessions.has(key)) this.sessions.set(key, {
        key,
        wakeConfig: { confirmedBy: 'default', triggers: { probability: this.cfg.socialV2.wake.recommendedProbability }, sleepUntil: null },
        sleepTimer: null, proactiveTimer: null, replyCheckTimer: null, nextFireAt: null,
      });
      return this.sessions.get(key);
    },
    refreshAllDefaultWakeConfigsV2() {
      for (const session of this.sessions.values()) {
        if (session.wakeConfig.confirmedBy === 'default') session.wakeConfig.triggers.probability = this.cfg.socialV2.wake.recommendedProbability;
      }
    },
    cancelProactiveCheckV2(key) { const session = this.sessions.get(key); if (session) session.proactiveTimer = null; },
    scheduleProactiveCheckV2(key) { const session = this.sessions.get(key); if (session && this.cfg.socialV2.proactive.enabled !== false) session.proactiveTimer = 'proactive-timer'; },
  };
  return host;
}
function createHarness({ scope, now, evidenceIntervalMs, reports, details } = {}) {
  const host = createFixtureBridge();
  const published = reports || [];
  const controller = createQqLifeRuntime({
    config: host.cfg,
    loadBaseConfig: () => baseConfig(),
    getDetails: () => ({ running: true, mode: 'local-simulation', purposeCarrier: 'qq', conversations: host.sessions.size, ...(details || {}) }),
    onAdopt: ({ changedIds }) => {
      host.adoptCalls.push({ changedIds });
      if (changedIds.some((id) => id.startsWith('qq.socialV2.wake.'))) host.refreshAllDefaultWakeConfigsV2();
      if (changedIds.includes('qq.socialV2.proactive.enabled')) {
        for (const key of host.sessions.keys()) {
          if (host.cfg.socialV2.proactive.enabled === false) host.cancelProactiveCheckV2(key);
          else host.scheduleProactiveCheckV2(key);
        }
      }
    },
    publish: (producer, snapshot, scopeArg) => { published.push({ producer, ...snapshot }); return publishRuntimeEvidence(producer, snapshot, scopeArg); },
    scope,
    ...(now ? { now } : {}),
    ...(evidenceIntervalMs ? { evidenceIntervalMs } : {}),
  });
  return { host, controller, published };
}

let passed = 0;
const test = async (name, run) => { await run(); passed += 1; console.log('PASS', name); };
try {
  await test('startup adopts saved purpose/wake settings before initial schedules', async () => {
    const { scope } = makeScope({ overrides: { 'purpose.enabled': false, 'qq.socialV2.wake.recommendedProbability': 0.2 } });
    const { host, controller } = createHarness({ scope });
    const result = controller.refresh();
    assert.equal(result.changed, true);
    assert.equal(result.revision, 1);
    assert.equal(host.cfg.purpose.enabled, false);
    assert.equal(host.cfg.socialV2.wake.recommendedProbability, 0.2);
    // onAdopt 只收到数据；runtime 自己不创建计时器/会话。
    assert.equal(host.sessions.size, 0);
    assert.deepEqual(host.adoptCalls.at(-1).changedIds.sort(), ['purpose.enabled', 'qq.socialV2.wake.recommendedProbability'].sort());
    const evidence = readRuntimeEvidence('qq', scope);
    assert.equal(evidence.valid, true);
    assert.equal(evidence.revision, 1);
    assert.equal(evidence.values['purpose.enabled'], false);
    assert.equal(evidence.values['qq.socialV2.wake.recommendedProbability'], 0.2);
  });

  await test('hot adoption refreshes default sessions and preserves explicit agent choices', async () => {
    const { scope } = makeScope({ overrides: {} });
    const { host, controller } = createHarness({ scope });
    host.session('group:456');
    const explicit = host.session('private:123');
    explicit.wakeConfig.confirmedBy = 'agent';
    explicit.wakeConfig.triggers.probability = 0.91;
    controller.refresh();
    writeState(scope, 2, { 'qq.socialV2.wake.recommendedProbability': 0.3 });
    const result = controller.refresh();
    assert.equal(result.changed, true);
    assert.equal(result.revision, 2);
    assert.equal(host.session('group:456').wakeConfig.triggers.probability, 0.3);
    assert.equal(explicit.wakeConfig.triggers.probability, 0.91);
    assert.ok(host.adoptCalls.at(-1).changedIds.includes('qq.socialV2.wake.recommendedProbability'));
    assert.equal(readRuntimeEvidence('qq', scope).revision, 2);
    assert.equal(readRuntimeEvidence('qq', scope).values['qq.socialV2.wake.recommendedProbability'], 0.3);
  });

  await test('default probability adoption preserves an existing finite sleep timer', async () => {
    const { scope } = makeScope({ overrides: {} });
    const { host, controller } = createHarness({ scope });
    const session = host.session('group:456');
    const until = new Date(Date.now() + 3600000).toISOString();
    session.wakeConfig.sleepUntil = until;
    session.sleepTimer = { kind: 'sleep-timer' };
    const timer = session.sleepTimer;
    writeState(scope, 2, { 'qq.socialV2.wake.recommendedProbability': 0.4 });
    controller.refresh();
    assert.equal(session.wakeConfig.triggers.probability, 0.4);
    assert.equal(session.wakeConfig.sleepUntil, until);
    assert.equal(session.sleepTimer, timer);
  });

  await test('interval adoption retains pending reply timers', async () => {
    const { scope } = makeScope({ overrides: {} });
    const { host, controller } = createHarness({ scope });
    const session = host.session('group:456');
    session.replyCheckTimer = { kind: 'reply-check' };
    const timer = session.replyCheckTimer;
    writeState(scope, 2, { 'qq.socialV2.autoReplyCheckMs': 90000 });
    controller.refresh();
    assert.equal(host.cfg.socialV2.autoReplyCheckMs, 90000);
    assert.equal(session.replyCheckTimer, timer);
  });

  await test('purpose gap adoption preserves the existing nextFireAt', async () => {
    const { scope } = makeScope({ overrides: {} });
    const { host, controller } = createHarness({ scope });
    const session = host.session('private:123');
    const nextFireAt = '2026-11-09T00:00:00.000Z';
    session.nextFireAt = nextFireAt;
    writeState(scope, 2, { 'purpose.gapMinMs': 600000 });
    controller.refresh();
    assert.equal(host.cfg.purpose.gapMinMs, 600000);
    assert.equal(session.nextFireAt, nextFireAt);
    assert.equal(readRuntimeEvidence('qq', scope).values['purpose.gapMinMs'], 600000);
  });

  await test('rollback restores a fresh baseline without replacing unrelated runtime state', async () => {
    const { scope } = makeScope({ overrides: { 'qq.socialV2.autoReplyCheckMs': 45000 } });
    const { host, controller } = createHarness({ scope });
    controller.refresh();
    assert.equal(host.cfg.socialV2.autoReplyCheckMs, 45000);
    host.cfg.dsh.model = 'runtime-selected-model';
    writeState(scope, 2, {});
    controller.refresh();
    assert.equal(host.cfg.socialV2.autoReplyCheckMs, 30000);
    assert.equal(host.cfg.dsh.model, 'runtime-selected-model');
    assert.equal(readRuntimeEvidence('qq', scope).revision, 2);
  });

  await test('disabling proactive cancels opportunity timers without touching explicit sleep', async () => {
    const { scope } = makeScope({ overrides: {} });
    const { host, controller } = createHarness({ scope });
    const session = host.session('group:456');
    host.scheduleProactiveCheckV2('group:456');
    assert.ok(session.proactiveTimer);
    session.wakeConfig.confirmedBy = 'agent';
    session.wakeConfig.sleepUntil = new Date(Date.now() + 3600000).toISOString();
    const sleepUntil = session.wakeConfig.sleepUntil;
    writeState(scope, 2, { 'qq.socialV2.proactive.enabled': false });
    controller.refresh();
    assert.equal(session.proactiveTimer, null);
    assert.equal(session.wakeConfig.sleepUntil, sleepUntil);
    assert.equal(host.cfg.socialV2.proactive.enabled, false);
  });

  await test('bad sidecar preserves previous in-memory values and does not claim a new revision', async () => {
    const { scope, paths, warnings } = makeScope({ overrides: { 'qq.socialV2.wake.recommendedProbability': 0.2 } });
    const { host, controller, published } = createHarness({ scope });
    controller.refresh();
    assert.equal(host.cfg.socialV2.wake.recommendedProbability, 0.2);
    const publishedCount = published.length;
    fs.writeFileSync(paths.state, '{broken');
    const result = controller.refresh();
    assert.equal(result.changed, false);
    assert.equal(result.revision, 1, 'fail-safe 必须返回最后一次成功 revision，不能报成最新');
    assert.equal(host.cfg.socialV2.wake.recommendedProbability, 0.2, '坏 state 不能把内存值改掉');
    assert.equal(published.length, publishedCount, '同一 revision 的 45s 节流内不重复写证据');
    assert.equal(readRuntimeEvidence('qq', scope).revision, 1);
    assert.ok(warnings.some((message) => message.includes('life-settings.json')));
    // 修复后（新 revision）正常采用。
    writeState(scope, 2, { 'qq.socialV2.wake.recommendedProbability': 0.35 });
    const repaired = controller.refresh();
    assert.equal(repaired.changed, true);
    assert.equal(repaired.revision, 2);
    assert.equal(host.cfg.socialV2.wake.recommendedProbability, 0.35);
  });

  await test('corrupt sidecar at startup does not throw or fabricate overrides', async () => {
    const { scope, warnings } = makeScope({ corruptState: true });
    const { host, controller } = createHarness({ scope });
    let result;
    assert.doesNotThrow(() => { result = controller.refresh(); });
    assert.equal(result.revision, 0);
    assert.equal(host.cfg.socialV2.wake.recommendedProbability, 0.05);
    assert.ok(warnings.some((message) => message.includes('life-settings.json')));
  });

  await test('evidence publishing is throttled to revision changes or a 45s heartbeat', async () => {
    const { scope } = makeScope({ overrides: { 'qq.socialV2.wake.recommendedProbability': 0.2 } });
    let clock = 1000000;
    const now = () => clock;
    const reports = [];
    const { controller } = createHarness({ scope, now, reports });
    controller.refresh();
    assert.equal(reports.length, 1, '首次采用立即发布');
    clock += 1000;
    controller.refresh();
    assert.equal(reports.length, 1, '同 revision、未到间隔不重复发布');
    clock += 44000;
    controller.refresh();
    assert.equal(reports.length, 2, '同 revision 到 45s 心跳发布一次');
    writeState(scope, 2, { 'qq.socialV2.wake.recommendedProbability': 0.25 });
    clock += 1000;
    const result = controller.refresh();
    assert.equal(result.revision, 2);
    assert.equal(reports.length, 3, 'revision 变化立即发布，不等心跳');
    assert.equal(reports.at(-1).revision, 2);
  });

  await test('concurrent revision movement cannot receive a false effective stamp', () => {
    const { scope } = makeScope({ overrides: {} });
    let revision = 1;
    let published = 0;
    const config = { purpose: { gapMinMs: 600000 } };
    const controller = createQqLifeRuntime({
      config, scope,
      loadBaseConfig: () => ({ purpose: { gapMinMs: 600000 } }),
      revision: () => revision,
      apply: () => { revision += 1; return { purpose: { gapMinMs: 900000 } }; },
      extract: (value) => ({ 'purpose.gapMinMs': value.purpose.gapMinMs }),
      publish: () => { published += 1; },
    });
    const result = controller.refresh();
    assert.equal(result.retry, true);
    assert.equal(controller.revision, null);
    assert.equal(config.purpose.gapMinMs, 600000);
    assert.equal(published, 0, '竞态中读到的值不能被标成已采用');
  });

  await test('QQ evidence cannot verify purpose settings consumed by the desktop carrier', () => {
    const { scope } = makeScope({ overrides: { 'purpose.enabled': false, 'qq.socialV2.autoReplyCheckMs': 45000 } });
    const { host, controller } = createHarness({ scope, details: { purposeCarrier: 'pet', mode: 'local-simulation' } });
    controller.refresh();
    assert.equal(host.cfg.purpose.enabled, false);
    const evidence = readRuntimeEvidence('qq', scope);
    assert.equal(evidence.valid, true);
    assert.equal(Object.hasOwn(evidence.values, 'purpose.enabled'), false);
    assert.equal(evidence.values['qq.socialV2.autoReplyCheckMs'], 45000);
  });

  await test('stateBlock returns one tail block and degrades safely on unreadable state', () => {
    const { scope } = makeScope({ overrides: {} });
    const { controller } = createHarness({ scope });
    controller.refresh();
    const block = controller.stateBlock('local-test');
    assert.ok(block.includes('生活状态') || block.includes('生活参数状态'));
    const degraded = createQqLifeRuntime({
      config: baseConfig(), loadBaseConfig: baseConfig, scope,
      board: () => { throw new Error('board unavailable'); },
      extract: (value) => value,
    });
    const fallback = degraded.stateBlock('x');
    assert.ok(fallback.includes('状态证据暂不可读'));
  });

  console.log(passed + '/' + passed + ' QQ lifecycle runtime scenarios passed (local qq-runtime + fixture bridge contract).');
} finally {
  for (const temp of temps) {
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
