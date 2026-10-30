// 生物钟 ensureSession 回归（完全离线：无网络、无真实 DSH 会话、不写 ~/.dsh）：
//   2026-10-30（审计 tools-bili F1 / P1-8）—— 旧实现里 create 抛错被 catch 吞掉后
//   无条件 sessionReady=true，一次瞬时抖动就让生物钟/监听/私信/直播间整晚静默失效。
//
// 覆盖：
//   1) inspect + create 都抛错：连调两次，create 必须被调用 2 次（失败不能被缓存）；
//   2) create 成功后：再调用只 inspect、不再 create（避免空壳会话），ready=true 时直接短路；
//   3) inspect 成功后的权限补丁顺序（inspect → inspect-retry）与 create 后的
//      ensureSession → ensureSession-retry 重试行为保持。
import assert from 'node:assert/strict';
import { ensureSchedulerSession } from '../lib/scheduler.js';

const SESSION_ID = 'bili-whale';
const CWD = 'C:/surfcore';

// ── 1. create 连续失败：不缓存 ready，第二次调用仍会重试 create ──────────────────
{
  const logs = [];
  let inspectCalls = 0;
  let createCalls = 0;
  const controller = {
    inspect: async () => { inspectCalls += 1; throw new Error('会话还没挂上') },
    create: async () => { createCalls += 1; throw new Error('宿主会话服务忙') },
  };
  const baseArgs = {
    sessionId: SESSION_ID,
    cwd: CWD,
    getSessionController: () => controller,
    ensurePermission: () => ({ ok: true }),
    log: (message) => logs.push(String(message)),
  };
  let sessionReady = false;
  const first = await ensureSchedulerSession({ ...baseArgs, sessionReady });
  sessionReady = first.sessionReady;
  assert.equal(first.sessionReady, false, 'create 失败后不得置 ready');
  assert.equal(first.created, false);
  assert.equal(first.inspected, false);
  assert.equal(createCalls, 1, '第一次要尝试 create');
  assert.ok(logs.some((line) => line.includes('创建会话失败，下个 tick 重试')), 'create 失败必须写日志（旧实现静默吞掉）');

  const second = await ensureSchedulerSession({ ...baseArgs, sessionReady });
  sessionReady = second.sessionReady;
  assert.equal(second.sessionReady, false, '第二次仍然未就绪');
  assert.equal(createCalls, 2, '第二次（下一 tick）必须重新 create —— 失败不能被缓存成 ready');
  assert.equal(inspectCalls, 2, '每次先 inspect 再决定是否 create');
  console.log('✅ create 失败不缓存：连续两次调用都会重试，sessionReady 保持 false');
}

// ── 2. create 成功后：第二次只 inspect，不再 create（避免空壳会话）──────────────
{
  const state = { exists: false, inspectCalls: 0, createCalls: 0 };
  const permissionCalls = [];
  const controller = {
    inspect: async () => {
      state.inspectCalls += 1;
      if (!state.exists) throw new Error('还没创建');
      return { id: SESSION_ID };
    },
    create: async (args) => {
      state.createCalls += 1;
      state.exists = true;
      return { id: args.sessionId };
    },
  };
  const args = {
    sessionId: SESSION_ID,
    cwd: CWD,
    getSessionController: () => controller,
    ensurePermission: (where) => { permissionCalls.push(where); return { ok: true } },
  };

  const first = await ensureSchedulerSession({ ...args, sessionReady: false });
  assert.equal(first.sessionReady, true, 'create 成功后置 ready');
  assert.equal(first.created, true);
  assert.equal(state.createCalls, 1);
  assert.deepEqual(permissionCalls, ['ensureSession'], 'create 成功后补一次权限（顺序不变）');

  // 第二次传 sessionReady=false（例如 ready 状态没同步/换了调用方）→ 应靠 inspect 确认，绝不 create
  const second = await ensureSchedulerSession({ ...args, sessionReady: false });
  assert.equal(second.sessionReady, true);
  assert.equal(second.inspected, true, '第二次是 inspect 成功');
  assert.equal(state.createCalls, 1, '会话已存在时不得再 create（否则侧栏多一个空壳会话）');
  assert.deepEqual(permissionCalls, ['ensureSession', 'inspect']);

  // 第三次 sessionReady=true → 直接短路，不碰 sessionController
  const inspectBefore = state.inspectCalls;
  const createBefore = state.createCalls;
  const third = await ensureSchedulerSession({ ...args, sessionReady: true });
  assert.equal(third.sessionReady, true);
  assert.equal(third.inspected, false);
  assert.equal(state.inspectCalls, inspectBefore, 'ready 后不再 inspect');
  assert.equal(state.createCalls, createBefore, 'ready 后不再 create');
  console.log('✅ create 成功后只 inspect 不再 create；ready 后直接短路');
}

// ── 3. 权限补丁顺序：inspect 后 session-not-active → 80ms 后 inspect-retry ──────
{
  const permissionCalls = [];
  const controller = {
    inspect: async () => ({ id: SESSION_ID }),
    create: async () => { throw new Error('不应走到 create'); },
  };
  const result = await ensureSchedulerSession({
    sessionId: SESSION_ID,
    cwd: CWD,
    getSessionController: () => controller,
    ensurePermission: (where) => {
      permissionCalls.push(where);
      return where === 'inspect' ? { ok: false, reason: 'session-not-active' } : { ok: true };
    },
    settleRetryMs: 0, // 测试里不等 80ms，只验顺序
  });
  assert.equal(result.sessionReady, true);
  assert.deepEqual(permissionCalls, ['inspect', 'inspect-retry'], 'inspect 的权限补丁顺序保持');
  console.log('✅ inspect 成功 → 权限补丁 inspect / inspect-retry 顺序不变');
}

// ── 4. create 成功后权限补丁：ensureSession → ensureSession-retry ───────────────
{
  const permissionCalls = [];
  const controller = {
    inspect: async () => { throw new Error('还没创建') },
    create: async () => ({ id: SESSION_ID }),
  };
  const result = await ensureSchedulerSession({
    sessionId: SESSION_ID,
    cwd: CWD,
    getSessionController: () => controller,
    ensurePermission: (where) => {
      permissionCalls.push(where);
      return where === 'ensureSession' ? { ok: false, reason: 'session-not-active' } : { ok: true };
    },
    settleRetryMs: 0,
  });
  assert.equal(result.sessionReady, true);
  assert.deepEqual(permissionCalls, ['ensureSession', 'ensureSession-retry'], 'create 的权限补丁顺序保持');
  console.log('✅ create 成功 → 权限补丁 ensureSession / ensureSession-retry 顺序不变');
}

// ── 5. sessionController 不存在：不崩、不缓存 ready、下个 tick 重试 ──────────────
{
  const logs = [];
  const result = await ensureSchedulerSession({
    sessionId: SESSION_ID,
    cwd: CWD,
    getSessionController: () => undefined,
    ensurePermission: () => ({ ok: true }),
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.sessionReady, false);
  assert.ok(logs.some((line) => line.includes('创建会话失败，下个 tick 重试')));
  console.log('✅ sessionController 不可用：不置 ready，留待下一 tick');
}

console.log('\n✅ scheduler ensureSession 回归通过');
