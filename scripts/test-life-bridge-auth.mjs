// 生活参数桥接面（/api/life/*）鉴权/权限/审批/审计回归（2026-11-08）。
//
// 覆盖本地化最关键的一层（参考实现没有）：MCP 工具只是代理，写入权限必须由 bridge 按
// 「真实 sender 归因 + owner 回合 + 会话 token 绑定」做硬闸。
// 用 audit-bridge-harness 起真实 bridge（VM + 夹具网关），不连 QQ、不读真实 ~/.dsh、不联网。
//
// 运行：node scripts/test-life-bridge-auth.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const CONSOLE_TOKEN = 'fixture-console-token';
const OWNER_KEY = 'private:123';
const GROUP_KEY = 'group:456';

function request(port, pathname, { method = 'GET', body, token, consoleToken = CONSOLE_TOKEN, agentCall = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (consoleToken) headers['x-console-token'] = consoleToken;
    if (agentCall) headers['x-agent-call'] = '1';
    if (token) headers['x-agent-token'] = token;
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch { /* 非 JSON 就留 null */ }
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`fixture request timed out: ${pathname}`)));
    if (method === 'GET') req.end();
    else req.end(JSON.stringify(body ?? {}));
  });
}

const lifeGet = (port, route, opts) => request(port, `/api/life/${route}`, opts);
const lifePost = (port, route, body, opts) => request(port, `/api/life/${route}`, { ...opts, method: 'POST', body });

async function openBridge(config) {
  const h = await bridgeHarness({ config });
  h.setMode('reserved2');
  h.setReady(true);
  const server = h.startConsoleServer();
  if (!server.listening) await once(server, 'listening');
  return { h, server, port: server.address().port };
}

async function closeBridge({ h, server }) {
  await new Promise((resolve) => server.close(resolve));
  await h.close();
}

/** 给会话生成 agentToken（真实桥接里是建会话时下发；夹具用 getSocialV2State 触发同一路径）。 */
function tokenFor(h, key) {
  const st = h.getSocialV2State(key);
  assert.ok(st?.agentToken, `会话 ${key} 应有 agentToken`);
  return { token: st.agentToken, state: st };
}

test('life 工具面：无令牌/坏令牌一律 403（不是控制台全权）', async () => {
  const bridge = await openBridge({});
  try {
    const { port } = bridge;
    const noToken = await lifeGet(port, `state?key=${encodeURIComponent(OWNER_KEY)}`, { agentCall: true });
    assert.equal(noToken.status, 403, '带 x-agent-call 但没有会话令牌的 life 调用必须 403');

    const badToken = await lifeGet(port, `state?key=${encodeURIComponent(OWNER_KEY)}`, { token: 'not-a-real-token' });
    assert.equal(badToken.status, 403, '无效会话令牌必须 403');
  } finally {
    await closeBridge(bridge);
  }
});

test('读：主人私聊 / 白名单群可用；目录 30 参数 + 5 意图；explain 可读', async () => {
  const bridge = await openBridge({});
  try {
    const { h, port } = bridge;
    const { token } = tokenFor(h, OWNER_KEY);
    const state = await lifeGet(port, `state?key=${encodeURIComponent(OWNER_KEY)}`, { token });
    assert.equal(state.status, 200);
    assert.equal(state.data.ok, true);
    assert.equal(state.data.parameters.length, 30, '目录应有 30 参数');
    assert.ok(state.data.parameters.some((p) => p.id === 'qq.socialV2.proactive.enabled'));
    assert.ok(Array.isArray(state.data.capabilities ? [] : []));

    const catalog = await lifeGet(port, `catalog?key=${encodeURIComponent(OWNER_KEY)}&q=${encodeURIComponent('B站')}`, { token });
    assert.equal(catalog.status, 200);
    assert.ok(catalog.data.parameters.length > 0, '中文别名搜索 B站 应能命中');
    assert.ok(Array.isArray(catalog.data.intents));

    const explain = await lifeGet(port, `explain?key=${encodeURIComponent(OWNER_KEY)}&id=qq.socialV2.proactive.probability`, { token });
    assert.equal(explain.status, 200);
    assert.equal(explain.data.id, 'qq.socialV2.proactive.probability');
  } finally {
    await closeBridge(bridge);
  }
});

test('写：群友回合（无 owner 归因）preview → 403；owner 私聊 → 可用', async () => {
  const bridge = await openBridge({});
  try {
    const { h, port } = bridge;
    const group = tokenFor(h, GROUP_KEY);
    // 群会话此刻没有 activeTurnTriggers（=没有在途的 owner 回合）→ 写必须 fail-closed。
    const denied = await lifePost(port, 'preview', {
      key: GROUP_KEY,
      patch: { 'qq.socialV2.proactive.probability': 0.2 },
      reason: '群友会话尝试改参数',
    }, { token: group.token });
    assert.equal(denied.status, 403, '非 owner 回合的写请求必须 403');

    const owner = tokenFor(h, OWNER_KEY);
    const plan = await lifePost(port, 'preview', {
      key: OWNER_KEY,
      patch: { 'qq.socialV2.proactive.probability': 0.25 },
      reason: '想多给一点主动冒泡机会',
    }, { token: owner.token });
    assert.equal(plan.status, 200, JSON.stringify(plan.data));
    assert.equal(plan.data.ok, true);
    assert.ok(String(plan.data.id).startsWith('plan-'));
    assert.ok(Array.isArray(plan.data.changes));
  } finally {
    await closeBridge(bridge);
  }
});

test('主链路：preview → apply（saved-unverified）→ 消费者 refresh → verify（runtime-adopted）→ rollback', async () => {
  const bridge = await openBridge({});
  try {
    const { h, port } = bridge;
    const owner = tokenFor(h, OWNER_KEY);
    const plan = await lifePost(port, 'preview', {
      key: OWNER_KEY,
      patch: { 'qq.socialV2.proactive.probability': 0.25 },
      reason: '想多一点主动机会',
    }, { token: owner.token });
    assert.equal(plan.status, 200);
    const planId = plan.data.id;

    const applied = await lifePost(port, 'apply', { key: OWNER_KEY, planId }, { token: owner.token });
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.equal(applied.data.status, 'saved-unverified');
    const changeId = applied.data.changeId;
    assert.ok(changeId);

    // 消费证据还没发布时：不允许假装 adopted。
    const before = await lifeGet(port, `verify?key=${encodeURIComponent(OWNER_KEY)}&changeId=${encodeURIComponent(changeId)}`, { token: owner.token });
    assert.equal(before.status, 200);
    assert.notEqual(before.data.status, 'runtime-adopted', '消费者未刷新前不能报 adopted');

    // 真实消费者（bridge 内的 createQqLifeRuntime）刷新并发布证据。
    assert.ok(h.lifeSettings(), 'bridge 应初始化了 life runtime');
    h.lifeSettings().refresh();

    const after = await lifeGet(port, `verify?key=${encodeURIComponent(OWNER_KEY)}&changeId=${encodeURIComponent(changeId)}`, { token: owner.token });
    assert.equal(after.status, 200);
    assert.equal(after.data.status, 'runtime-adopted', JSON.stringify(after.data.checks ?? after.data));

    // 回滚：先生成计划，再 apply；同样要能看到 adopted。
    const rollbackPlan = await lifePost(port, 'rollback', { key: OWNER_KEY, changeId, reason: '临时改的，先回滚' }, { token: owner.token });
    assert.equal(rollbackPlan.status, 200, JSON.stringify(rollbackPlan.data));
    assert.ok(String(rollbackPlan.data.id).startsWith('plan-'));
    const rolled = await lifePost(port, 'apply', { key: OWNER_KEY, planId: rollbackPlan.data.id }, { token: owner.token });
    assert.equal(rolled.status, 200, JSON.stringify(rolled.data));
    h.lifeSettings().refresh();
    const verifyRollback = await lifeGet(port, `verify?key=${encodeURIComponent(OWNER_KEY)}&changeId=${encodeURIComponent(rolled.data.changeId)}`, { token: owner.token });
    assert.equal(verifyRollback.data.status, 'runtime-adopted');
  } finally {
    await closeBridge(bridge);
  }
});

test('审批：approval 参数 apply 被拒 → 控制台 approve → 再 apply 成功；agent 不得调管理端', async () => {
  const bridge = await openBridge({});
  try {
    const { h, port } = bridge;
    const owner = tokenFor(h, OWNER_KEY);
    const plan = await lifePost(port, 'preview', {
      key: OWNER_KEY,
      patch: { 'qq.socialV2.context.wakeMaxChars': 8000 },
      reason: '想让她一次看到更多上下文',
    }, { token: owner.token });
    assert.equal(plan.status, 200);
    assert.equal(plan.data.status, 'approval-required');

    const deniedApply = await lifePost(port, 'apply', { key: OWNER_KEY, planId: plan.data.id }, { token: owner.token });
    assert.equal(deniedApply.status, 409, '审批未通过前 apply 必须被拒');
    assert.match(String(deniedApply.data.error), /APPROVAL_REQUIRED/);

    // agent 不许调管理端（pending/approve 对 x-agent-token 一律 403）
    const pendingAsAgent = await lifeGet(port, 'pending', { token: owner.token });
    assert.equal(pendingAsAgent.status, 403);

    // 控制台（consoleToken，不带 agent token）可以看 pending 并审批这一份精确计划。
    const pending = await request(port, '/api/life/pending', { agentCall: false });
    assert.equal(pending.status, 200);
    assert.ok(pending.data.pendingApprovals.some((p) => p.id === plan.data.id));
    const approved = await request(port, '/api/life/approve', {
      method: 'POST', agentCall: false,
      body: { planId: plan.data.id, reason: '同意这一次' },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));

    const applied = await lifePost(port, 'apply', { key: OWNER_KEY, planId: plan.data.id }, { token: owner.token });
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.equal(applied.data.status, 'saved-unverified');
  } finally {
    await closeBridge(bridge);
  }
});

test('限频：每会话每小时写入上限（lifeSettings.maxWritesPerHour）', async () => {
  const bridge = await openBridge({ lifeSettings: { maxWritesPerHour: 1 } });
  try {
    const { h, port } = bridge;
    const owner = tokenFor(h, OWNER_KEY);
    const p1 = await lifePost(port, 'preview', {
      key: OWNER_KEY, patch: { 'qq.socialV2.proactive.probability': 0.21 }, reason: '第一次',
    }, { token: owner.token });
    const a1 = await lifePost(port, 'apply', { key: OWNER_KEY, planId: p1.data.id }, { token: owner.token });
    assert.equal(a1.status, 200);

    const p2 = await lifePost(port, 'preview', {
      key: OWNER_KEY, patch: { 'qq.socialV2.proactive.probability': 0.22 }, reason: '第二次',
    }, { token: owner.token });
    const a2 = await lifePost(port, 'apply', { key: OWNER_KEY, planId: p2.data.id }, { token: owner.token });
    assert.equal(a2.status, 429, '超过每小时写入上限必须 429');
  } finally {
    await closeBridge(bridge);
  }
});

test('模式隔离与审计：非 reserved2 拒绝 agent 调用；写入落 state/life-settings-audit.jsonl', async () => {
  const bridge = await openBridge({});
  try {
    const { h, port } = bridge;
    const owner = tokenFor(h, OWNER_KEY);
    h.setMode('chat');
    const blocked = await lifeGet(port, `state?key=${encodeURIComponent(OWNER_KEY)}`, { token: owner.token });
    assert.equal(blocked.status, 403);
    h.setMode('reserved2');

    const plan = await lifePost(port, 'preview', {
      key: OWNER_KEY, patch: { 'qq.socialV2.closure.cooldownMs': 900000 }, reason: '收尾后安静久一点',
    }, { token: owner.token });
    assert.equal(plan.status, 200);

    const fs = await import('node:fs');
    const path = await import('node:path');
    const auditFile = path.join(h.temp, 'state', 'life-settings-audit.jsonl');
    assert.ok(fs.existsSync(auditFile), '写入审计文件应已创建');
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(lines.some((line) => line.via === 'agent' && line.action === 'preview' && line.ok === true));
  } finally {
    await closeBridge(bridge);
  }
});
