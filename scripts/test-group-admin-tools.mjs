// 群管理动作（2026-11-02 用户要求）真实 bridge 接线回归：夹具网关 + 临时 DSH_HOME，绝不连真 QQ。
//
// 用户原话：「允许 surfcore 的 qqbot 在群聊中接受管理员除了访问电脑之外的所有工具，
// 包括但不限于禁言群成员」。落地口径（人工决策点已确认；2026-11-06 场景放宽后更新）：
//   · 管理员 = ownerQQ 本人，不是「QQ 群管理员/群主」；
//   · 电脑/本机类工具只在「主人本人触发的回合」可用（由 DSH 插件侧守卫/审批，本文件不测）；
//   · 群管理动作（禁言/解禁、改别人名片）在「主人本人触发的回合」或旧 ownerAt 时间窗内可用；
//     私聊发起禁言必须显式带 allow.groups 白名单里的 groupId；
//   · 第一批群管理动作 = 禁言 + 解禁（qq_set_group_ban）。
//
// 覆盖：
//   1. 禁言 happy path（管理员刚在群里说过话 → 放行，OneBot 参数正确）；
//   2. 解禁（durationSeconds=0 → action=unmute）；
//   3. 授权窗口：没有管理员发言 / 窗口过期 → 403；
//   4. 私聊通道：必须显式 groupId 且在白名单内（2026-11-06 放宽，不再是一律 403）；
//   4.1 群聊新路径：主人本人触发的回合（无 ownerAt）也放行；
//   5. 目标校验：非本群成员 / 自己 / 管理员本人 / 群主 / 其他群管理员 → 拒绝；
//   6. 时长校验：负数、小数、超过 30 天 → 400；
//   7. 工具开关关闭 → 403；每小时频率上限 → 429；
//   8. 改别人群名片：群里有管理员授权窗口时放行（旧行为是群里一律 403）；
//   9. 唤醒提示：窗口有效时注入【管理员在群里】，过期/私聊不注入。
//
// 运行：node scripts/test-group-admin-tools.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE_TOKEN = 'fixture-console-token';
const OWNER_QQ = '123456789';
const OWNER = `private:${OWNER_QQ}`;
const GROUP = 'group:456';
const BOT_QQ = '2756294428';

function post(port, route, body, { token } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/socialV2/${route}`,
      method: 'POST',
      headers: {
        'x-console-token': CONSOLE_TOKEN,
        ...(token ? { 'x-agent-token': token } : {}),
        'content-type': 'application/json'
      }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`fixture request timed out: ${route}`)));
    req.end(JSON.stringify(body));
  });
}

async function withServer(h) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  ACTIVE_SERVERS.add(server);
  return server.address().port;
}

/** GET 夹具控制台（只读端点用）。 */
function get(port, route, { token } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/socialV2/${route}`,
      method: 'GET',
      headers: {
        'x-console-token': CONSOLE_TOKEN,
        ...(token ? { 'x-agent-token': token } : {})
      }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`fixture request timed out: ${route}`)));
    req.end();
  });
}

const ACTIVE_SERVERS = new Set();
async function closeServers() {
  await Promise.all([...ACTIVE_SERVERS].map((server) => new Promise((resolve) => server.close(resolve))));
  ACTIVE_SERVERS.clear();
}

const baseConfig = (socialV2 = {}) => ({
  ownerQQ: Number(OWNER_QQ),
  allow: { private: [OWNER_QQ], groups: ['456'] },
  socialV2
});

/** 夹具网关里的群成员：111/222 普通，333 管理员，444 群主。 */
function fixtureMembers(h) {
  h.bot.getGroupMemberList = async () => ([
    { user_id: 111, role: 'member' },
    { user_id: 222, role: 'member' },
    { user_id: 333, role: 'admin' },
    { user_id: 444, role: 'owner' }
  ]);
  h.bot.getGroupMemberInfo = async (groupId, userId) => {
    const role = userId === 444 ? 'owner' : (userId === 333 ? 'admin' : 'member');
    return { user_id: userId, role };
  };
  // 禁言前会查一次登录信息（判断「不能禁言自己」）；夹具默认没有 user_id，这里补上。
  const raw = h.bot.raw.bind(h.bot);
  h.bot.raw = async (action, params = {}) => {
    if (action === 'get_login_info') return { user_id: Number(BOT_QQ), nickname: 'fixture-bot' };
    return raw(action, params);
  };
}

/** 模拟「管理员刚在群里说了一句话」——真实路径是 handleIncoming 调 appendSocialV2Message。 */
function ownerSpoke(h, text = '禁言一下 111') {
  h.appendSocialV2Message(GROUP, '管理员', text, text, false, true, null, [], OWNER_QQ, []);
}

/**
 * 造一个「主人本人触发的回合」（2026-11-06 场景放宽）：入站消息 → 投递（写归因）→ turn/start。
 * 与真实链路同一批函数（handleIncoming 只是多 8 秒批量窗，本测试不需要等）。
 */
async function startTurn(h, key, { owner = true, text = '禁言一下 111' } = {}) {
  const userId = owner ? OWNER_QQ : '111';
  h.appendSocialV2Message(key, owner ? '管理员' : '群友', text, text, false, owner, `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, [], userId, []);
  await h.deliverPrompt(key, 'x', { wakeReason: 'question' });
  const sessionId = h.state.sessions[key];
  assert.ok(sessionId, `投递后应有会话映射：${key}`);
  h.alignTurnTriggerStart(sessionId, key);
  return sessionId;
}

/** 夹具网关卡收到的 OneBot 动作。 */
function onebotBodies(h, action) {
  return h.calls.http
    .filter((entry) => String(entry.url).endsWith(`/${action}`))
    .map((entry) => entry.body);
}

// ── 1. 禁言 happy path ───────────────────────────────────────────────────────
test('禁言：管理员刚在群里说过话 → 放行，且 OneBot 参数正确', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    ownerSpoke(h);
    assert.ok(st.ownerAt > 0, 'appendSocialV2Message(isOwner=true) 必须记下管理员发言时间');

    const res = await post(port, 'set-group-ban', {
      key: GROUP, userId: '111', durationSeconds: 600
    }, { token: st.agentToken });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.action, 'mute');
    assert.equal(res.data.groupId, '456');
    assert.equal(res.data.userId, '111');
    const bodies = onebotBodies(h, 'set_group_ban');
    assert.equal(bodies.length, 1, '必须真的调用一次 set_group_ban');
    assert.deepEqual(bodies[0], { group_id: 456, user_id: 111, duration: 600 });

    // 频率上限计数已落盘
    assert.equal(st.adminActionTimes.length, 1);
  } finally {
    await closeServers();
    await h.close();
  }
});

// ── 2. 解禁 ────────────────────────────────────────────────────────────────
test('解禁：durationSeconds=0 → action=unmute，OneBot duration=0', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    ownerSpoke(h);
    const res = await post(port, 'set-group-ban', {
      key: GROUP, userId: '111', durationSeconds: 0
    }, { token: st.agentToken });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.data.action, 'unmute');
    assert.deepEqual(onebotBodies(h, 'set_group_ban')[0], { group_id: 456, user_id: 111, duration: 0 });
  } finally {
    await closeServers();
    await h.close();
  }
});

// ── 3. 授权窗口 ─────────────────────────────────────────────────────────────
test('授权窗口：没有管理员发言 → 403（群友不能指挥群管理动作）', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    // 群友先说话：不算授权
    h.appendSocialV2Message(GROUP, '群友', '禁言 111', '禁言 111', false, false, null, [], '111', []);
    assert.equal(st.ownerAt || 0, 0, '群友发言不能写 ownerAt');
    const res = await post(port, 'set-group-ban', {
      key: GROUP, userId: '111', durationSeconds: 600
    }, { token: st.agentToken });
    assert.equal(res.status, 403, res.raw);
    assert.match(res.data.error, /管理员/);
    assert.equal(onebotBodies(h, 'set_group_ban').length, 0, '未授权时不得调用 OneBot');
  } finally {
    await closeServers();
    await h.close();
  }
});

test('授权窗口：管理员发言超过窗口（默认 10 分钟）→ 403', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    ownerSpoke(h);
    st.ownerAt = Date.now() - 11 * 60 * 1000; // 11 分钟前
    const res = await post(port, 'set-group-ban', {
      key: GROUP, userId: '111', durationSeconds: 600
    }, { token: st.agentToken });
    assert.equal(res.status, 403, res.raw);
    assert.match(res.data.error, /超过|失效/);
    assert.equal(onebotBodies(h, 'set_group_ban').length, 0);
  } finally {
    await closeServers();
    await h.close();
  }
});

test('授权窗口：可配置（windowMs 调大后同一时间点放行）', async () => {
  const h = await bridgeHarness({ config: baseConfig({ adminActions: { windowMs: 60 * 60 * 1000 } }) });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    ownerSpoke(h);
    st.ownerAt = Date.now() - 30 * 60 * 1000; // 30 分钟前，但窗口是 1 小时
    const res = await post(port, 'set-group-ban', {
      key: GROUP, userId: '111', durationSeconds: 60
    }, { token: st.agentToken });
    assert.equal(res.status, 200, res.raw);
  } finally {
    await closeServers();
    await h.close();
  }
});

// ── 4. 私聊通道（2026-11-06 放宽：私聊 + 显式 groupId 可以禁言）────────────────
test('私聊禁言：必须显式 groupId 且在白名单内；合规时走网关', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const st = h.getSocialV2State(OWNER);
    // 没有 groupId → 403（不提供「猜一个群」的通道）
    const noGroup = await post(port, 'set-group-ban', { key: OWNER, userId: '111', durationSeconds: 600 }, { token: st.agentToken });
    assert.equal(noGroup.status, 403, noGroup.raw);
    assert.match(noGroup.data.error, /groupId/);
    assert.equal(onebotBodies(h, 'set_group_ban').length, 0);
    // 白名单外的群 → 403
    const notAllowed = await post(port, 'set-group-ban', { key: OWNER, userId: '111', durationSeconds: 600, groupId: '999' }, { token: st.agentToken });
    assert.equal(notAllowed.status, 403, notAllowed.raw);
    assert.match(notAllowed.data.error, /白名单/);
    assert.equal(onebotBodies(h, 'set_group_ban').length, 0);
    // 主人私聊 + 显式白名单 groupId → 放行（数字/字符串都接受）
    const ok = await post(port, 'set-group-ban', { key: OWNER, userId: '111', durationSeconds: 600, groupId: '456' }, { token: st.agentToken });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.data.groupId, '456');
    assert.deepEqual(onebotBodies(h, 'set_group_ban'), [{ group_id: 456, user_id: 111, duration: 600 }]);
  } finally {
    await closeServers();
    await h.close();
  }
});

// ── 4.1 群聊通道（2026-11-06 新增）：主人触发回合即使没有 ownerAt 也放行 ────
test('群聊禁言：主人本人触发的回合（无 ownerAt）→ 放行；非主人回合 → 403', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    const call = () => post(port, 'set-group-ban', { key: GROUP, userId: '111', durationSeconds: 60 }, { token: st.agentToken });

    await startTurn(h, GROUP, { owner: false });
    const memberTurn = await call();
    assert.equal(memberTurn.status, 403, '群友触发的回合不能禁言');
    assert.equal(onebotBodies(h, 'set_group_ban').length, 0);
    h.alignTurnTriggerEnd(h.state.sessions[GROUP], GROUP);

    await startTurn(h, GROUP, { owner: true });
    st.ownerAt = 0; // 清掉 appendSocialV2Message 顺手写的 ownerAt：证明新路径不依赖旧时间窗
    const ownerTurn = await call();
    assert.equal(ownerTurn.status, 200, ownerTurn.raw);
    assert.equal(onebotBodies(h, 'set_group_ban').length, 1);
    // 目标校验照旧（私聊/群聊两条通道共用）
    const forbidden = await post(port, 'set-group-ban', { key: GROUP, userId: '444', durationSeconds: 60 }, { token: st.agentToken });
    assert.equal(forbidden.status, 403, forbidden.raw);
    assert.match(forbidden.data.error, /群主/);
  } finally {
    await closeServers();
    await h.close();
  }
});

// ── 5. 目标校验 ─────────────────────────────────────────────────────────────
test('目标校验：非本群成员 / 自己 / 管理员本人 / 群主 / 其他管理员一律拒绝', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    ownerSpoke(h);
    const call = (userId) => post(port, 'set-group-ban', { key: GROUP, userId, durationSeconds: 600 }, { token: st.agentToken });

    const outsider = await call('999');
    assert.equal(outsider.status, 403, outsider.raw);
    assert.match(outsider.data.error, /不是群 456 的成员/);

    const self = await call(BOT_QQ);
    assert.equal(self.status, 400, self.raw);
    assert.match(self.data.error, /自己/);

    const owner = await call(OWNER_QQ);
    assert.equal(owner.status, 403, owner.raw);
    assert.match(owner.data.error, /管理员本人/);

    const groupOwner = await call('444');
    assert.equal(groupOwner.status, 403, groupOwner.raw);
    assert.match(groupOwner.data.error, /群主/);

    const otherAdmin = await call('333');
    assert.equal(otherAdmin.status, 403, otherAdmin.raw);
    assert.match(otherAdmin.data.error, /管理员/);

    assert.equal(onebotBodies(h, 'set_group_ban').length, 0, '所有被拒的目标都不得触达 OneBot');
  } finally {
    await closeServers();
    await h.close();
  }
});

// ── 6. 时长校验 ─────────────────────────────────────────────────────────────
test('时长校验：负数 / 小数 / 超过 30 天 → 400', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    ownerSpoke(h);
    const call = (durationSeconds) => post(port, 'set-group-ban', { key: GROUP, userId: '111', durationSeconds }, { token: st.agentToken });
    for (const bad of [-1, 1.5, 30 * 24 * 3600 + 1]) {
      const res = await call(bad);
      assert.equal(res.status, 400, `duration=${bad} 应 400：${res.raw}`);
    }
    assert.equal(onebotBodies(h, 'set_group_ban').length, 0);
  } finally {
    await closeServers();
    await h.close();
  }
});

// ── 7. 工具开关 / 频率上限 ──────────────────────────────────────────────────
test('工具开关关闭 → 403（控制台「工具开关」能整条关掉）', async () => {
  const h = await bridgeHarness({ config: baseConfig({ tools: { setGroupBan: false } }) });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    ownerSpoke(h);
    const res = await post(port, 'set-group-ban', { key: GROUP, userId: '111', durationSeconds: 600 }, { token: st.agentToken });
    assert.equal(res.status, 403, res.raw);
    assert.match(res.data.error, /工具未启用/);
    assert.equal(onebotBodies(h, 'set_group_ban').length, 0);
  } finally {
    await closeServers();
    await h.close();
  }
});

test('每小时频率上限 → 429（管理员在也不能刷屏）', async () => {
  const h = await bridgeHarness({ config: baseConfig({ adminActions: { windowMs: 600000, maxPerHour: 20 } }) });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    ownerSpoke(h);
    st.adminActionTimes = Array.from({ length: 20 }, (_, i) => Date.now() - i * 1000);
    const res = await post(port, 'set-group-ban', { key: GROUP, userId: '111', durationSeconds: 60 }, { token: st.agentToken });
    assert.equal(res.status, 429, res.raw);
    assert.match(res.data.error, /上限/);
    assert.equal(onebotBodies(h, 'set_group_ban').length, 0);
  } finally {
    await closeServers();
    await h.close();
  }
});

// ── 8. 改别人群名片：群里有管理员授权后放行 ─────────────────────────────────
test('群名片：管理员在群里开口后可以改别人名片（旧行为是群里一律 403）', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);

    // 没有管理员发言 → 仍拒绝（群友不能借这条通道改别人名片）
    const denied = await post(port, 'set-group-card', { key: GROUP, card: '新名字', userId: '111' }, { token: st.agentToken });
    assert.equal(denied.status, 403, denied.raw);
    assert.match(denied.data.error, /管理员/);

    ownerSpoke(h, '把 111 的名片改成新名字');
    const allowed = await post(port, 'set-group-card', { key: GROUP, card: '新名字', userId: '111' }, { token: st.agentToken });
    assert.equal(allowed.status, 200, allowed.raw);
    assert.equal(onebotBodies(h, 'set_group_card').length, 1);
    assert.equal(st.adminActionTimes.length, 1, '群名片管理动作也要计入每小时上限');
  } finally {
    await closeServers();
    await h.close();
  }
});

test('群名片：管理员私聊里改别人名片保持原行为（不受群授权窗口限制）', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const st = h.getSocialV2State(OWNER);
    const res = await post(port, 'set-group-card', { key: OWNER, card: '私聊改的', userId: '111', groupId: '456' }, { token: st.agentToken });
    assert.equal(res.status, 200, res.raw);
  } finally {
    await closeServers();
    await h.close();
  }
});

// ── 9. 唤醒提示 ─────────────────────────────────────────────────────────────
test('唤醒提示：窗口有效时注入【管理员在群里】，过期/私聊不注入', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(GROUP);
    assert.ok(!h.buildWakePromptV2(GROUP, 'question').includes('【管理员在群里】'), '没有管理员发言时不该注入');
    ownerSpoke(h);
    const prompt = h.buildWakePromptV2(GROUP, 'question');
    assert.ok(prompt.includes('【管理员在群里】'), '管理员刚发言 → 唤醒提示要告诉她群管理动作有效');
    assert.ok(prompt.includes('qq_set_group_ban'), '要告诉她用哪个工具');
    assert.ok(h.buildWakePromptV2(OWNER, 'question').indexOf('【管理员在群里】') < 0, '私聊不需要群管理授权块');

    st.ownerAt = Date.now() - 11 * 60 * 1000;
    assert.ok(!h.buildWakePromptV2(GROUP, 'question').includes('【管理员在群里】'), '窗口过期后不再注入');
  } finally {
    await h.close();
  }
});

// ── 10. 群成员名单（按昵称/群名片找 QQ 号）──────────────────────────────────
test('群成员名单：reserved2 带令牌可查本群（含 role），私聊/越界按规则拒绝', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const groupSt = h.getSocialV2State(GROUP);
    const ownerSt = h.getSocialV2State(OWNER);

    const own = await get(port, `group-members?key=${encodeURIComponent(GROUP)}`, { token: groupSt.agentToken });
    assert.equal(own.status, 200, own.raw);
    assert.equal(own.data.count, 4);
    assert.ok(own.data.members.every((m) => /^\d+$/.test(m.user_id)), '只返回真实 QQ 号');
    assert.equal(own.data.members.find((m) => m.user_id === '333').role, 'admin', '要带 role，方便避开管理员');
    assert.equal(own.data.members.find((m) => m.user_id === '444').role, 'owner');

    const otherGroup = await get(port, `group-members?key=${encodeURIComponent(GROUP)}&groupId=999`, { token: groupSt.agentToken });
    assert.equal(otherGroup.status, 400, '群会话只能查本群');
    assert.match(otherGroup.data.error, /本群/);

    const privateNoGroup = await get(port, `group-members?key=${encodeURIComponent(OWNER)}`, { token: ownerSt.agentToken });
    assert.equal(privateNoGroup.status, 400, '私聊必须指定 groupId');

    const privateAllowed = await get(port, `group-members?key=${encodeURIComponent(OWNER)}&groupId=456`, { token: ownerSt.agentToken });
    assert.equal(privateAllowed.status, 200, '主人私聊可查白名单群');

    const notWhitelisted = await get(port, `group-members?key=${encodeURIComponent(OWNER)}&groupId=999`, { token: ownerSt.agentToken });
    assert.equal(notWhitelisted.status, 403, '白名单外的群不能查');
  } finally {
    await closeServers();
    await h.close();
  }
});

// ── 11. 静态接线（防「只改了桥接、忘了 MCP / 控制台 / 预设」）────────────────
test('静态接线：MCP 工具、桥接端点、控制台开关、示例配置、预设规则都在', async () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  const mcp = read('src/mcp-snowluma-safe.js');
  assert.match(mcp, /qq_set_group_ban: 'setGroupBan'/, 'MCP 注册期开关必须登记（否则控制台关了仍可见）');
  assert.match(mcp, /'qq_set_group_ban'/, 'MCP 工具必须注册');
  assert.match(mcp, /\/api\/socialV2\/set-group-ban/, 'MCP 工具必须转发到桥接端点');
  assert.match(mcp, /\/api\/socialV2\/group-members/, '群成员名单的 v2 读通道必须接线（按昵称找人用）');

  const bridge = read('src/bridge.js');
  assert.match(bridge, /url\.pathname === '\/api\/socialV2\/set-group-ban'/, '桥接端点必须存在');
  assert.match(bridge, /url\.pathname === '\/api\/socialV2\/group-members'/, '群成员名单端点必须存在');
  assert.match(bridge, /setGroupBan: true/, '桥接默认工具开关必须开');
  assert.match(bridge, /adminActions:/, '授权窗口配置必须存在');
  assert.match(bridge, /groupAdminAuthority/, '授权窗口必须有硬闸实现');

  assert.match(read('public/console.html'), /data-v2-tool="setGroupBan"/, '控制台「工具开关」必须能开关它');

  const example = JSON.parse(read('config.example.json'));
  assert.equal(example.socialV2.tools.setGroupBan, true, '示例配置要含 setGroupBan');
  assert.ok(example.socialV2.adminActions?.windowMs > 0, '示例配置要含 adminActions');

  const preset = read('dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
  assert.match(preset, /qq_set_group_ban/, '仿真预设要告诉模型有这个工具');
  assert.match(preset, /qq_get_group_members\(key, token\)/, '仿真预设要教模型按昵称找 QQ 号');
  assert.match(preset, /群管理：禁言\/解禁（主人本人触发的回合/, '仿真预设要写明放宽后的群管理授权口径');
  // 安全不变量不能被这次改动顺手删掉（preset-prompt 硬校验也依赖它们）
  for (const needle of ['主人本人触发的回合', '群友没有管理权限', '角色由桥接注入']) {
    assert.ok(preset.includes(needle), `安全不变量丢了：${needle}`);
  }
});
