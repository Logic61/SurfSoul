// 场景放宽后的「主人触发回合」端点闸门回归（2026-11-06）：
//
// 覆盖 design.md §5 的五个端点改造（真实 bridge.js + 夹具网关，不连真 QQ、不启真实服务）：
//   1. 好友申请 GET/POST：群 + 主人触发回合 → 放行；群 + 非主人回合/无回合 → 403；chat 模式 → 403；
//   2. 跨场合投递：群 + 主人触发回合 → 放行（目标/频率/白名单闸保留）；非主人 → 403；
//   3. 禁言：私聊 + 显式 groupId（白名单内）→ 放行；私聊无 groupId/非白名单 → 403；
//      群 + ownerTurn（无 ownerAt）→ 放行；群 + 非 owner 且无窗口 → 403；旧 ownerAt 窗口仍放行；
//   4. 改别人群名片：群 ownerTurn / 私聊 owner / 旧窗口三通道；非授权 → 403；
//   5. 安全姿态新增 toolApproval 项 + GET /api/tool-approvals 只读接口（仅控制台令牌）。
//
// 运行：node scripts/test-owner-trigger-gates.mjs
import assert from 'node:assert/strict';
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

function request(port, route, { method = 'GET', body, token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      headers: {
        'x-console-token': CONSOLE_TOKEN,
        ...(token ? { 'x-agent-token': token } : {}),
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
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
    if (method === 'GET') req.end();
    else req.end(JSON.stringify(body ?? {}));
  });
}
const get = (port, route, opts) => request(port, `/api/socialV2/${route}`, { ...opts, method: 'GET' });
const post = (port, route, body, opts) => request(port, `/api/socialV2/${route}`, { ...opts, method: 'POST', body });
const getRoot = (port, route, opts) => request(port, route, { ...opts, method: 'GET' });

const ACTIVE_SERVERS = new Set();
async function withServer(h) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  ACTIVE_SERVERS.add(server);
  return server.address().port;
}
async function closeServers() {
  await Promise.all([...ACTIVE_SERVERS].map((server) => new Promise((resolve) => server.close(resolve))));
  ACTIVE_SERVERS.clear();
}

const baseConfig = (socialV2 = {}) => ({
  ownerQQ: Number(OWNER_QQ),
  allow: { private: [OWNER_QQ], groups: ['456'] },
  socialV2: { tokenGuard: { enabled: false }, ...socialV2 },
});

/** 夹具网关群成员：111/222 普通，333 管理员，444 群主。 */
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
  const raw = h.bot.raw.bind(h.bot);
  h.bot.raw = async (action, params = {}) => {
    if (action === 'get_login_info') return { user_id: Number(BOT_QQ), nickname: 'fixture-bot' };
    return raw(action, params);
  };
}

/** 模拟「主人刚在群里说过话」→ 旧 ownerAt 授权窗口（真实路径是 handleIncoming）。 */
function ownerSpoke(h, text = '禁言一下 111') {
  h.appendSocialV2Message(GROUP, '管理员', text, text, false, true, null, [], OWNER_QQ, []);
}

/**
 * 造一个「主人本人触发的回合」：入站消息 → 投递 prompt（写归因记录）→ turn/start 对齐。
 * 与真实链路用同一批函数（handleIncoming 只是多了批量窗口，本测试不需要等 8 秒）。
 */
async function startTurn(h, key, { owner = true, text = '帮我看下' } = {}) {
  const userId = owner ? OWNER_QQ : '111';
  h.appendSocialV2Message(key, owner ? '管理员' : '群友', text, text, false, owner, `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, [], userId, []);
  await h.deliverPrompt(key, 'x', { wakeReason: 'question' });
  const sessionId = h.state.sessions[key];
  assert.ok(sessionId, `投递后应有会话映射：${key}`);
  h.alignTurnTriggerStart(sessionId, key);
  return sessionId;
}

function onebotBodies(h, action) {
  return h.calls.http
    .filter((entry) => String(entry.url).endsWith(`/${action}`))
    .map((entry) => entry.body);
}
const sentGroupBodies = (h) => onebotBodies(h, 'send_group_msg');

const FRIEND_EVENT = {
  post_type: 'request',
  request_type: 'friend',
  user_id: 1234567,
  flag: 'u_abc123',
  comment: '你好，我是群里的',
  time: Math.floor(Date.now() / 1000),
};

// ── 1. 好友申请：群 + owner 回合才放行 ─────────────────────────────────────
test('好友申请 GET：群 + 主人触发回合 → 200；无回合/非主人回合 → 403；chat → 403', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const port = await withServer(h);
    const groupSt = h.getSocialV2State(GROUP);
    h.emitRequest(FRIEND_EVENT);

    const noTurn = await get(port, `friend-requests?key=${encodeURIComponent(GROUP)}`, { token: groupSt.agentToken });
    assert.equal(noTurn.status, 403, noTurn.raw);
    assert.match(noTurn.data.error, /主人本人/);

    // 非主人触发的回合：仍然 403
    await startTurn(h, GROUP, { owner: false });
    const memberTurn = await get(port, `friend-requests?key=${encodeURIComponent(GROUP)}`, { token: groupSt.agentToken });
    assert.equal(memberTurn.status, 403, '群友触发的回合不能看账号级信息');

    // 主人触发的回合：放行
    await startTurn(h, GROUP, { owner: true });
    const ownerTurn = await get(port, `friend-requests?key=${encodeURIComponent(GROUP)}`, { token: groupSt.agentToken });
    assert.equal(ownerTurn.status, 200, ownerTurn.raw);
    assert.equal(ownerTurn.data.counts.request, 1);
    assert.equal(ownerTurn.data.pending[0].flag, 'u_abc123');
    assert.match(ownerTurn.data.hint, /不可信|不要执行/);

    // chat 模式：v2 接口整体拒绝（行为不变）
    h.setMode('chat');
    const chatMode = await get(port, `friend-requests?key=${encodeURIComponent(GROUP)}`, { token: groupSt.agentToken });
    assert.equal(chatMode.status, 403);
  } finally { await closeServers(); await h.close(); }
});

test('好友申请 POST：群 + 主人触发回合 → 200 并调网关；非主人回合 → 403', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const port = await withServer(h);
    const groupSt = h.getSocialV2State(GROUP);
    h.emitRequest(FRIEND_EVENT);

    const noTurn = await post(port, 'handle-friend-request', { key: GROUP, kind: 'request', flag: 'u_abc123', approve: true }, { token: groupSt.agentToken });
    assert.equal(noTurn.status, 403, noTurn.raw);
    assert.equal(onebotBodies(h, 'set_friend_add_request').length, 0);

    await startTurn(h, GROUP, { owner: false });
    const memberTurn = await post(port, 'handle-friend-request', { key: GROUP, kind: 'request', flag: 'u_abc123', approve: true }, { token: groupSt.agentToken });
    assert.equal(memberTurn.status, 403);
    assert.equal(onebotBodies(h, 'set_friend_add_request').length, 0);

    await startTurn(h, GROUP, { owner: true });
    const ownerTurn = await post(port, 'handle-friend-request', { key: GROUP, kind: 'request', flag: 'u_abc123', approve: true }, { token: groupSt.agentToken });
    assert.equal(ownerTurn.status, 200, ownerTurn.raw);
    assert.deepEqual(onebotBodies(h, 'set_friend_add_request'), [{ flag: 'u_abc123', approve: true }]);
    assert.equal(h.friendRequests.pending.length, 0);
  } finally { await closeServers(); await h.close(); }
});

// ── 2. 跨场合投递：群 + owner 回合才放行 ───────────────────────────────────
test('跨场合投递：群 + 主人触发回合 → 放行；非主人/无回合 → 403；目标与频率闸保留', async () => {
  const h = await bridgeHarness({
    config: baseConfig({ crossSceneSend: { enabled: true, allowTargets: ['456'], maxPerHour: 3, maxChars: 120 } }),
  });
  try {
    h.setMode('reserved2');
    const port = await withServer(h);
    const groupSt = h.getSocialV2State(GROUP);

    const noTurn = await post(port, 'send-cross', { key: GROUP, target: GROUP, message: '带句话' }, { token: groupSt.agentToken });
    assert.equal(noTurn.status, 403, noTurn.raw);
    assert.match(noTurn.data.error, /主人本人/);
    assert.equal(sentGroupBodies(h).length, 0);

    await startTurn(h, GROUP, { owner: false });
    const memberTurn = await post(port, 'send-cross', { key: GROUP, target: GROUP, message: '带句话' }, { token: groupSt.agentToken });
    assert.equal(memberTurn.status, 403);
    assert.equal(sentGroupBodies(h).length, 0);

    await startTurn(h, GROUP, { owner: true });
    const ownerTurn = await post(port, 'send-cross', { key: GROUP, target: GROUP, message: '今晚八点开黑' }, { token: groupSt.agentToken });
    assert.equal(ownerTurn.status, 200, ownerTurn.raw);
    assert.equal(ownerTurn.data.target, GROUP);
    assert.equal(sentGroupBodies(h).length, 1);
    assert.equal(sentGroupBodies(h)[0].group_id, 456);

    // 目标白名单 / 长度闸照旧（新路径不能绕过）
    const badTarget = await post(port, 'send-cross', { key: GROUP, target: 'group:999', message: 'x' }, { token: groupSt.agentToken });
    assert.equal(badTarget.status, 403, '不在 allowTargets 的目标仍拒绝');
    const tooLong = await post(port, 'send-cross', { key: GROUP, target: GROUP, message: '长'.repeat(200) }, { token: groupSt.agentToken });
    assert.equal(tooLong.status, 400, '超长仍拒绝');
  } finally { await closeServers(); await h.close(); }
});

// ── 3. 禁言：私聊显式 groupId / 群 owner 回合 / 旧窗口 ────────────────────
test('禁言：私聊 + 显式 groupId → 放行；缺 groupId / 非白名单 → 403', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const ownerSt = h.getSocialV2State(OWNER);

    const missing = await post(port, 'set-group-ban', { key: OWNER, userId: '111', durationSeconds: 60 }, { token: ownerSt.agentToken });
    assert.equal(missing.status, 403, missing.raw);
    assert.match(missing.data.error, /groupId/);
    assert.equal(onebotBodies(h, 'set_group_ban').length, 0);

    const notAllowed = await post(port, 'set-group-ban', { key: OWNER, userId: '111', durationSeconds: 60, groupId: '999' }, { token: ownerSt.agentToken });
    assert.equal(notAllowed.status, 403);
    assert.match(notAllowed.data.error, /白名单/);
    assert.equal(onebotBodies(h, 'set_group_ban').length, 0);

    const ok = await post(port, 'set-group-ban', { key: OWNER, userId: '111', durationSeconds: 60, groupId: 456 }, { token: ownerSt.agentToken });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.data.groupId, '456');
    assert.deepEqual(onebotBodies(h, 'set_group_ban')[0], { group_id: 456, user_id: 111, duration: 60 });

    // 目标校验在私聊路径同样生效（不能禁言群主/管理员本人/自己）
    for (const [target, status, pattern] of [['444', 403, /群主/], [OWNER_QQ, 403, /管理员本人/], [BOT_QQ, 400, /自己/]]) {
      const res = await post(port, 'set-group-ban', { key: OWNER, userId: target, durationSeconds: 60, groupId: '456' }, { token: ownerSt.agentToken });
      assert.equal(res.status, status, `${target}: ${res.raw}`);
      assert.match(res.data.error, pattern);
    }
  } finally { await closeServers(); await h.close(); }
});

test('禁言：群 + owner 触发回合（无 ownerAt）→ 放行；群 + 非 owner 且无窗口 → 403；旧窗口仍放行', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const groupSt = h.getSocialV2State(GROUP);

    const noTurn = await post(port, 'set-group-ban', { key: GROUP, userId: '111', durationSeconds: 60 }, { token: groupSt.agentToken });
    assert.equal(noTurn.status, 403, noTurn.raw);
    assert.equal(onebotBodies(h, 'set_group_ban').length, 0);

    await startTurn(h, GROUP, { owner: false });
    const memberTurn = await post(port, 'set-group-ban', { key: GROUP, userId: '111', durationSeconds: 60 }, { token: groupSt.agentToken });
    assert.equal(memberTurn.status, 403, '群友触发的回合不能禁言');
    assert.equal(onebotBodies(h, 'set_group_ban').length, 0);

    await startTurn(h, GROUP, { owner: true });
    // 真实链路里 owner 消息会顺手写 ownerAt；这里清掉，证明新路径**不依赖**旧时间窗。
    groupSt.ownerAt = 0;
    const ownerTurn = await post(port, 'set-group-ban', { key: GROUP, userId: '111', durationSeconds: 60 }, { token: groupSt.agentToken });
    assert.equal(ownerTurn.status, 200, ownerTurn.raw);
    assert.equal(onebotBodies(h, 'set_group_ban').length, 1);
    assert.equal(groupSt.ownerAt || 0, 0, '新路径不依赖 ownerAt（已手动清空仍放行）');

    // 旧路径：ownerAt 时间窗（handleIncoming 之外的显式记录）仍然可用（群名片/禁言旧接口兼容）
    const h2 = await bridgeHarness({ config: baseConfig() });
    try {
      h2.setMode('reserved2');
      fixtureMembers(h2);
      const port2 = await withServer(h2);
      const st2 = h2.getSocialV2State(GROUP);
      ownerSpoke(h2);
      const oldWindow = await post(port2, 'set-group-ban', { key: GROUP, userId: '111', durationSeconds: 60 }, { token: st2.agentToken });
      assert.equal(oldWindow.status, 200, oldWindow.raw);
    } finally { await closeServers(); await h2.close(); }
  } finally { await closeServers(); await h.close(); }
});

test('禁言：每小时上限在新路径同样生效 → 429', async () => {
  const h = await bridgeHarness({ config: baseConfig({ adminActions: { windowMs: 600000, maxPerHour: 2 } }) });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const groupSt = h.getSocialV2State(GROUP);
    await startTurn(h, GROUP, { owner: true });
    groupSt.adminActionTimes = [Date.now() - 1000, Date.now() - 2000];
    const res = await post(port, 'set-group-ban', { key: GROUP, userId: '111', durationSeconds: 60 }, { token: groupSt.agentToken });
    assert.equal(res.status, 429, res.raw);
    assert.match(res.data.error, /上限/);
    assert.equal(onebotBodies(h, 'set_group_ban').length, 0);
  } finally { await closeServers(); await h.close(); }
});

// ── 4. 改别人群名片：三通道 ────────────────────────────────────────────────
test('改别人群名片：群 owner 回合 / 私聊 owner / 旧窗口三通道，非授权 403', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    fixtureMembers(h);
    const port = await withServer(h);
    const groupSt = h.getSocialV2State(GROUP);
    const ownerSt = h.getSocialV2State(OWNER);

    const noTurn = await post(port, 'set-group-card', { key: GROUP, card: '新名字', userId: '111' }, { token: groupSt.agentToken });
    assert.equal(noTurn.status, 403, noTurn.raw);
    assert.equal(onebotBodies(h, 'set_group_card').length, 0);

    await startTurn(h, GROUP, { owner: false });
    const memberTurn = await post(port, 'set-group-card', { key: GROUP, card: '新名字', userId: '111' }, { token: groupSt.agentToken });
    assert.equal(memberTurn.status, 403);
    assert.equal(onebotBodies(h, 'set_group_card').length, 0);

    await startTurn(h, GROUP, { owner: true });
    const ownerTurn = await post(port, 'set-group-card', { key: GROUP, card: '新名字', userId: '111' }, { token: groupSt.agentToken });
    assert.equal(ownerTurn.status, 200, ownerTurn.raw);
    assert.equal(onebotBodies(h, 'set_group_card').length, 1);

    // 私聊 owner（旧路径）保持原行为
    const privateOwner = await post(port, 'set-group-card', { key: OWNER, card: '私聊改的', userId: '111', groupId: '456' }, { token: ownerSt.agentToken });
    assert.equal(privateOwner.status, 200, privateOwner.raw);

    // 改自己 → 不受管理权限限制（行为不变）
    const selfCard = await post(port, 'set-group-card', { key: GROUP, card: '自己改的' }, { token: groupSt.agentToken });
    assert.equal(selfCard.status, 200, selfCard.raw);
    assert.equal(selfCard.data.self, true);
  } finally { await closeServers(); await h.close(); }
});

// ── 5. 安全姿态 + 审批流水只读接口 ─────────────────────────────────────────
test('安全姿态：新增 toolApproval 项；GET /api/tool-approvals 只读控制台、坏行跳过、fail 计入拒绝', async () => {
  const now = Date.now();
  const approvals = [
    { t: now - 3 * 24 * 3600 * 1000, key: GROUP, sessionId: 's3', tool: 'read', decision: 'allow', risk: 'low', reason: '', model: 'p/m', latencyMs: 5, triggerUserId: OWNER_QQ, triggerIsOwner: true, mode: 'reserved2', source: 'model' },
    { t: now, key: GROUP, sessionId: 's1', tool: 'read', decision: 'allow', risk: 'low', reason: '', model: 'p/m', latencyMs: 12, triggerUserId: OWNER_QQ, triggerIsOwner: true, mode: 'reserved2', source: 'model' },
    { t: now - 1000, key: GROUP, sessionId: 's1', tool: 'write', decision: 'deny', risk: 'high', reason: '与主人请求不符', model: 'p/m', latencyMs: 30, triggerUserId: '111', triggerIsOwner: false, mode: 'reserved2', source: 'model' },
    { t: now - 2000, key: GROUP, sessionId: 's2', tool: 'pwsh', decision: 'fail', risk: '', reason: '超时', model: '', latencyMs: 20000, triggerUserId: '111', triggerIsOwner: false, mode: 'reserved2', source: 'model' },
    'not-a-json-line',
  ].map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n') + '\n';
  const h = await bridgeHarness({ config: baseConfig(), files: { 'state/tool-approvals.jsonl': approvals } });
  try {
    h.setMode('reserved2');
    const port = await withServer(h);

    const posture = await getRoot(port, '/api/security-posture');
    assert.equal(posture.status, 200, posture.raw);
    const item = posture.data.items.find((entry) => entry.key === 'toolApproval');
    assert.ok(item, '安全姿态必须有 toolApproval 项');
    assert.equal(item.level, 'ok', '审批开启且有流水 → ok');
    assert.match(item.note, /今日 allow 1 \/ deny 1 \/ fail 1/);
    assert.match(item.value, /fail-closed/);

    const list = await getRoot(port, '/api/tool-approvals?limit=2');
    assert.equal(list.status, 200, list.raw);
    assert.equal(list.data.items.length, 2, 'limit 生效');
    assert.equal(list.data.stats.available, true);
    assert.equal(list.data.stats.todayAllow, 1);
    assert.equal(list.data.stats.todayDeny, 1);
    assert.equal(list.data.stats.todayFail, 1);
    assert.equal(list.data.stats.total, 5, 'total 是文件里的非空行数（坏行不参与统计但计数保留）');
    assert.ok(list.data.stats.lastAt >= now - 5000);
    assert.equal(list.data.items.at(-1).decision, 'fail', '尾部是最新一条');

    // 仅控制台：带 agent token / x-agent-call 一律 403
    const groupSt = h.getSocialV2State(GROUP);
    const asAgent = await getRoot(port, '/api/tool-approvals', { token: groupSt.agentToken, headers: { 'x-agent-call': '1' } });
    assert.equal(asAgent.status, 403, asAgent.raw);

    // 关闭审批 → warn（明确提示回到旧行为）
    h.cfg.socialV2.toolApproval = { ...h.cfg.socialV2.toolApproval, enabled: false };
    const postureOff = await getRoot(port, '/api/security-posture');
    const itemOff = postureOff.data.items.find((entry) => entry.key === 'toolApproval');
    assert.equal(itemOff.level, 'warn');
    assert.match(itemOff.note, /旧行为/);
  } finally { await closeServers(); await h.close(); }
});
