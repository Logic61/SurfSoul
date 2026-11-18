// QQ 消息撤回（qq_recall_message）真实 bridge 接线回归（2026-11-08 用户要求
// 「给 surfcore 的 qq 部分接上群撤回的接口，权限放开，不需要主人点头，自己判断」）。
//
// 用户拍板口径（RECALL-MESSAGE-DESIGN.md §0/§2/§6）：
//   · 这是**普通工具**，不走 owner 回合授权、不走 qq-owner-approval 模型审批：
//     群友触发的回合里也能撤自己刚发的消息，模型自己判断什么时候该撤；
//   · 撤自己：reserved2 的群聊/私聊都可以；撤别人：仅群聊，且机器人自己必须是本群
//     admin/owner（取不到角色 fail-closed），目标是群主 → 403；
//   · 私聊永远不能撤对方消息；
//   · 硬边界不因「放开」取消：仅 reserved2 / agent token + 会话白名单 / 工具开关 / AI 暂停 /
//     get_msg 校验消息归属当前会话 / 约 2 分钟窗口 / 每小时上限 / 一次一条。
//
// 覆盖 RECALL-MESSAGE-DESIGN.md §6 的 14 类用例 + §1 配置归一化：
//   真实 src/bridge.js + scripts/audit-bridge-harness.mjs 的 VM 夹具（不连真 QQ、
//   不写真实 state/）。夹具覆盖 h.bot.raw 模拟 get_login_info / get_msg / delete_msg /
//   get_group_member_info，并记录 delete_msg 调用（断言 403 时**没有**发出去）。
//
// 运行：node scripts/test-recall-message.mjs
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
const OTHER_GROUP = 'group:789';
const BOT_QQ = '10002';

/**
 * 桥接跑在 vm context 里：它创建的对象（例如传给 bot.raw 的 params、cfg.socialV2.messageRecall）
 * 原型来自另一个 realm，assert.deepStrictEqual 会因 [[Prototype]] 不同而误报。
 * 断言这些跨 realm 值前先 JSON 归一成本 realm 的普通对象。
 */
const plain = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

/** 夹具普通群友 / 群主 / 其他管理员。 */
const MEMBER_QQ = '111';
const GROUP_OWNER_QQ = '444';

// ── HTTP 夹具 ───────────────────────────────────────────────────────────────
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
const post = (port, route, body, opts) => request(port, `/api/socialV2/${route}`, { ...opts, method: 'POST', body });
/** 撤回端点调用：messageId 走 design §2 的 body 字段。 */
const recall = (port, body, token) => post(port, 'recall-message', body, { token });

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

const baseConfig = (socialV2 = {}, extra = {}) => ({
  ownerQQ: Number(OWNER_QQ),
  allow: { private: [OWNER_QQ], groups: ['456'] },
  socialV2: { tokenGuard: { enabled: false }, ...socialV2 },
  ...extra,
});

// ── 夹具网关消息（get_msg 返回体，OneBot 形态）──────────────────────────────
const nowSec = () => Math.floor(Date.now() / 1000);

/** 群消息：sender 是真实发送者；time 是秒级时间戳。 */
function groupMessage(messageId, { sender = MEMBER_QQ, groupId = '456', ageSeconds = 0 } = {}) {
  const senderNum = Number(sender);
  return {
    message_id: Number(messageId),
    group_id: Number(groupId),
    user_id: senderNum,
    sender: { user_id: senderNum, nickname: `fixture-${sender}` },
    time: nowSec() - ageSeconds,
    message: [{ type: 'text', data: { text: 'fixture-secret-text' } }],
  };
}

/** 私聊消息：user_id 是会话对象（对方），sender.user_id 才是真实发送者。 */
function privateMessage(messageId, { peer = OWNER_QQ, sender = BOT_QQ, ageSeconds = 0 } = {}) {
  return {
    message_id: Number(messageId),
    user_id: Number(peer),
    sender: { user_id: Number(sender), nickname: `fixture-${sender}` },
    time: nowSec() - ageSeconds,
    message: [{ type: 'text', data: { text: 'fixture-secret-text' } }],
  };
}

/**
 * 真实 SnowLuma 的「自发私聊副本」形状（读运行时 index.mjs 的 finalizeSend/cacheSelfSentMessage 确认）：
 * user_id = 自己（bot）、target_id = 对方、sender.user_id = 自己；收到的私聊才是 user_id = 对方、无 target_id。
 * 两种形状都必须能撤自己刚发的私聊消息。
 */
function selfSentPrivateMessage(messageId, { target = OWNER_QQ, self = BOT_QQ, ageSeconds = 0 } = {}) {
  return {
    message_id: Number(messageId),
    message_type: 'private',
    user_id: Number(self),
    target_id: Number(target),
    sender: { user_id: Number(self), nickname: `fixture-${self}` },
    time: nowSec() - ageSeconds,
    message: [{ type: 'text', data: { text: 'fixture-secret-text' } }],
  };
}

/**
 * 夹具网关：覆盖 h.bot.raw 与 h.bot.getGroupMemberInfo，模拟
 * get_login_info / get_msg / delete_msg / get_group_member_info，并记录 delete_msg 调用
 * （403 用例断言「网关根本没被触达」）。
 *
 * @param {object} opts
 * @param {Record<string,string>} opts.roles     userId → 'member'|'admin'|'owner'（机器人自己用 roles[BOT_QQ]）
 * @param {Record<string,object>} opts.messages 真实 message id (String) → get_msg 返回对象；缺省=找不到
 * @param {string|null} opts.getMsgThrow        get_msg 抛错文案（模拟网络/retcode 异常）
 * @param {string|null} opts.deleteThrow        delete_msg 抛错文案
 * @param {string|null} opts.loginThrow         get_login_info 抛错文案
 */
function fixtureGateway(h, { roles = {}, messages = {}, getMsgThrow = null, deleteThrow = null, loginThrow = null } = {}) {
  const calls = { deleteMsg: [], getMsg: [], loginInfo: 0, memberInfo: [] };
  h.bot.getGroupMemberInfo = async (groupId, userId) => {
    calls.memberInfo.push({ via: 'sdk', groupId: String(groupId), userId: String(userId) });
    const role = roles[String(userId)];
    return role ? { user_id: Number(userId), role } : null;
  };
  const raw = h.bot.raw.bind(h.bot);
  h.bot.raw = async (action, params = {}) => {
    if (action === 'get_login_info') {
      calls.loginInfo += 1;
      if (loginThrow) throw new Error(loginThrow);
      return { user_id: Number(BOT_QQ), nickname: 'fixture-bot' };
    }
    if (action === 'get_msg') {
      calls.getMsg.push(params);
      if (getMsgThrow) throw new Error(getMsgThrow);
      const hit = messages[String(params?.message_id)];
      return hit ?? null;
    }
    if (action === 'delete_msg') {
      calls.deleteMsg.push(params);
      if (deleteThrow) throw new Error(deleteThrow);
      return {};
    }
    if (action === 'get_group_member_info') {
      calls.memberInfo.push({ via: 'raw', groupId: String(params?.group_id), userId: String(params?.user_id) });
      const role = roles[String(params?.user_id)];
      return role ? { user_id: Number(params.user_id), role } : null;
    }
    return raw(action, params);
  };
  return calls;
}

/**
 * 造一个「非主人 / 主人触发的回合」：入站消息 → 投递（写归因）→ turn/start 对齐。
 * 与真实链路用同一批函数（handleIncoming 只是多 8 秒批量窗，本测试不需要等）。
 * 权限口径回归用：撤回**不**依赖 owner 回合，群友触发的回合里撤自己的也必须成功。
 */
async function startTurn(h, key, { owner = true, text = '这句说错了，撤回一下' } = {}) {
  const userId = owner ? OWNER_QQ : MEMBER_QQ;
  h.appendSocialV2Message(key, owner ? '管理员' : '群友', text, text, false, owner, `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, [], userId, []);
  await h.deliverPrompt(key, 'x', { wakeReason: 'question' });
  const sessionId = h.state.sessions[key];
  assert.ok(sessionId, `投递后应有会话映射：${key}`);
  h.alignTurnTriggerStart(sessionId, key);
  return sessionId;
}

// ── 1. happy path：群聊撤自己的消息 ─────────────────────────────────────────
test('1. 群聊撤自己的消息：self=true、delete_msg 用真实 id、recent 标 recalled、recallTimes 变长', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const calls = fixtureGateway(h, {
      roles: { [BOT_QQ]: 'admin', [MEMBER_QQ]: 'member' },
      messages: { '-123': groupMessage(-123, { sender: BOT_QQ }) },
    });
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    st.recentMessages.push({ seq: 7, messageId: '-123', sender: '我', text: '说错了', isSelf: true, time: Date.now() });

    const res = await recall(port, { key: GROUP, messageId: '-123' }, st.agentToken);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.key, GROUP);
    assert.equal(String(res.data.messageId), '-123');
    assert.equal(res.data.self, true);
    assert.equal(String(res.data.senderId), BOT_QQ);
    assert.equal(res.data.windowMs, 0, '群聊默认由网关决定撤回窗口');
    assert.equal(res.data.messageType, 'group');
    assert.ok(!JSON.stringify(res.data).includes('fixture-secret-text'), '成功响应不得回显被撤消息原文');
    assert.deepEqual(plain(calls.deleteMsg), [{ message_id: -123 }], 'OneBot 参数必须是 { message_id: Number(realId) }');
    assert.equal(calls.getMsg.length, 1, '必须先 get_msg 校验归属');
    assert.deepEqual(plain(calls.getMsg[0]), { message_id: -123 });
    const marked = st.recentMessages.find((m) => String(m.messageId) === '-123');
    assert.equal(marked?.recalled, true, 'recentMessages 对应条目要标 recalled:true');
    assert.equal(Array.isArray(st.recallTimes) ? st.recallTimes.length : 0, 1, '成功后才记一次频率时间');
    assert.ok(st.lastActionAt > 0, '成功后要更新 lastActionAt');
  } finally { await closeServers(); await h.close(); }
});

// ── 2. 群聊撤别人的：机器人不是管理员 → 403 且无 delete_msg ─────────────────
test('2. 群聊撤别人的 + 机器人不是管理员 → 403，且没有发出 delete_msg', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const calls = fixtureGateway(h, {
      roles: { [BOT_QQ]: 'member', [MEMBER_QQ]: 'member' },
      messages: { '-200': groupMessage(-200, { sender: MEMBER_QQ }) },
    });
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    const res = await recall(port, { key: GROUP, messageId: '-200' }, st.agentToken);
    assert.equal(res.status, 403, res.raw);
    assert.match(res.data.error, /管理员/, '要给出可读的「需要机器人是本群管理员」');
    assert.deepEqual(plain(calls.deleteMsg), [], '被拒时不得触达 delete_msg');
    assert.equal(Array.isArray(st.recallTimes) ? st.recallTimes.length : 0, 0, '失败不计频率');
  } finally { await closeServers(); await h.close(); }
});

test('2.1 取不到机器人角色时 fail-closed（管理员身份无法确认 → 403）', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    // roles 为空：getGroupMemberInfo 与 raw 回退都取不到角色。
    const calls = fixtureGateway(h, {
      roles: {},
      messages: { '-201': groupMessage(-201, { sender: MEMBER_QQ }) },
    });
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    const res = await recall(port, { key: GROUP, messageId: '-201' }, st.agentToken);
    assert.equal(res.status, 403, res.raw);
    assert.match(res.data.error, /管理员/);
    assert.deepEqual(plain(calls.deleteMsg), []);
  } finally { await closeServers(); await h.close(); }
});

// ── 3. 群聊撤别人的：机器人是 admin → 放行 ─────────────────────────────────
test('3. 群聊撤别人的 + 机器人是 admin → 200，self=false，delete_msg 参数正确', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const calls = fixtureGateway(h, {
      roles: { [BOT_QQ]: 'admin', [MEMBER_QQ]: 'member' },
      messages: { '-300': groupMessage(-300, { sender: MEMBER_QQ }) },
    });
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    const res = await recall(port, { key: GROUP, messageId: '-300' }, st.agentToken);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.data.self, false);
    assert.equal(String(res.data.senderId), MEMBER_QQ);
    assert.deepEqual(plain(calls.deleteMsg), [{ message_id: -300 }]);
  } finally { await closeServers(); await h.close(); }
});

// ── 4. 目标是群主 → 403 ────────────────────────────────────────────────────
test('4. 群聊撤群主的消息 → 403（QQ 不允许管理员撤回群主发言），无 delete_msg', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const calls = fixtureGateway(h, {
      roles: { [BOT_QQ]: 'admin', [GROUP_OWNER_QQ]: 'owner' },
      messages: { '-400': groupMessage(-400, { sender: GROUP_OWNER_QQ }) },
    });
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    const res = await recall(port, { key: GROUP, messageId: '-400' }, st.agentToken);
    assert.equal(res.status, 403, res.raw);
    assert.match(res.data.error, /群主/);
    assert.deepEqual(plain(calls.deleteMsg), []);
  } finally { await closeServers(); await h.close(); }
});

// ── 5. 私聊：撤对方 403、撤自己 200 ────────────────────────────────────────
test('5. 私聊撤对方 → 403；私聊撤自己 → 200', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const calls = fixtureGateway(h, {
      messages: {
        '-500': privateMessage(-500, { sender: OWNER_QQ }), // 主人发的
        '-501': privateMessage(-501, { sender: BOT_QQ }),   // 机器人自己发的
      },
    });
    const port = await withServer(h);
    const st = h.getSocialV2State(OWNER);

    const other = await recall(port, { key: OWNER, messageId: '-500' }, st.agentToken);
    assert.equal(other.status, 403, other.raw);
    assert.match(other.data.error, /私聊里只能撤回你自己/);
    assert.deepEqual(plain(calls.deleteMsg), []);

    const self = await recall(port, { key: OWNER, messageId: '-501' }, st.agentToken);
    assert.equal(self.status, 200, self.raw);
    assert.equal(self.data.self, true);
    assert.equal(self.data.messageType, 'private');
    assert.deepEqual(plain(calls.deleteMsg), [{ message_id: -501 }]);
  } finally { await closeServers(); await h.close(); }
});

// ── 5.1 私聊撤自己（SnowLuma 真实自发副本形状：user_id=bot、target_id=对方）──
// 现实链路里对外发送的私聊消息被 SnowLuma 缓存成 self-sent 副本时是
// user_id = 自己(bot)、target_id = 对方、sender.user_id = 自己（读运行时 finalizeSend/
// cacheSelfSentMessage 确认）；收到的私聊才是 user_id = 对方、无 target_id。
// 归属校验只认 user_id === convId 的后果是「撤自己刚发的私聊消息」永远 403。
test('5.1 私聊撤自己（真实形状 user_id=bot/target_id=对方）→ 200，self=true，真走 delete_msg', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const calls = fixtureGateway(h, { messages: { '-510': selfSentPrivateMessage(-510) } });
    const port = await withServer(h);
    const st = h.getSocialV2State(OWNER);
    const res = await recall(port, { key: OWNER, messageId: '-510' }, st.agentToken);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.data.self, true);
    assert.equal(res.data.messageType, 'private');
    assert.equal(String(res.data.senderId), BOT_QQ);
    assert.deepEqual(plain(calls.deleteMsg), [{ message_id: -510 }], '撤自己刚发的私聊消息必须真的走到 delete_msg');
  } finally { await closeServers(); await h.close(); }
});

// ── 5.2 跨私聊撤自己的消息：target_id 不是当前会话 → 403（防 target_id 校验成通行证）──
test('5.2 跨私聊撤自己的消息（target_id=别的 QQ）→ 403，零 delete_msg', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const calls = fixtureGateway(h, { messages: { '-511': selfSentPrivateMessage(-511, { target: '999999' }) } });
    const port = await withServer(h);
    const st = h.getSocialV2State(OWNER);
    const res = await recall(port, { key: OWNER, messageId: '-511' }, st.agentToken);
    assert.equal(res.status, 403, res.raw);
    assert.match(res.data.error, /不在当前私聊/);
    assert.deepEqual(plain(calls.deleteMsg), [], 'target_id 不匹配时不得撤销别的私聊消息');
  } finally { await closeServers(); await h.close(); }
});

// ── 6. 跨会话 / get_msg 找不到 ─────────────────────────────────────────────
test('6. 跨会话 messageId → 403；get_msg 找不到 → 404；两者都不触达 delete_msg', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const calls = fixtureGateway(h, {
      messages: {
        '-600': groupMessage(-600, { sender: BOT_QQ, groupId: '789' }), // 属于别的群
        '-601': { message_id: -601, user_id: Number(OWNER_QQ), group_id: 456, sender: { user_id: Number(BOT_QQ) } }, // 私聊 key 下带群归属
      },
    });
    const port = await withServer(h);
    const groupSt = h.getSocialV2State(GROUP);
    const ownerSt = h.getSocialV2State(OWNER);

    const wrongGroup = await recall(port, { key: GROUP, messageId: '-600' }, groupSt.agentToken);
    assert.equal(wrongGroup.status, 403, wrongGroup.raw);
    assert.match(wrongGroup.data.error, /不在当前群/);

    const wrongPrivate = await recall(port, { key: OWNER, messageId: '-601' }, ownerSt.agentToken);
    assert.equal(wrongPrivate.status, 403, wrongPrivate.raw);
    assert.match(wrongPrivate.data.error, /不在当前私聊/);

    const notFound = await recall(port, { key: GROUP, messageId: '-999999' }, groupSt.agentToken);
    assert.equal(notFound.status, 404, notFound.raw);
    assert.match(notFound.data.error, /找不到/);

    assert.deepEqual(plain(calls.deleteMsg), [], '归属/存在性校验失败时不得触达 delete_msg');
  } finally { await closeServers(); await h.close(); }
});

// ── 7. 2 分钟窗口 / time 缺失不拦 ──────────────────────────────────────────
test('7. 私聊超 2 分钟窗口 → 400 且 windowExpired:true；time 缺失 → 不拦（交给网关）', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const noTime = privateMessage(-701);
    delete noTime.time;
    const calls = fixtureGateway(h, {
      roles: { [BOT_QQ]: 'admin' },
      messages: {
        '-700': privateMessage(-700, { ageSeconds: 180 }), // 3 分钟前
        '-701': noTime,
      },
    });
    const port = await withServer(h);
    const st = h.getSocialV2State(OWNER);

    const expired = await recall(port, { key: OWNER, messageId: '-700' }, st.agentToken);
    assert.equal(expired.status, 400, expired.raw);
    assert.equal(expired.data.windowExpired, true);
    assert.ok(expired.data.ageMs >= 120000, `ageMs 应 >= windowMs，实际 ${expired.data.ageMs}`);
    assert.equal(expired.data.windowMs, 120000);
    assert.deepEqual(plain(calls.deleteMsg), []);

    const missingTime = await recall(port, { key: OWNER, messageId: '-701' }, st.agentToken);
    assert.equal(missingTime.status, 200, 'time 缺失时不拦，交给网关判定');
    assert.deepEqual(plain(calls.deleteMsg), [{ message_id: -701 }]);
  } finally { await closeServers(); await h.close(); }
});

// ── 8. 本地 seq → 真实 messageId 映射 ──────────────────────────────────────
test('8. 本地 seq 映射到真实 id（delete_msg 用 -123）；seq 条目没有真实 id → 400', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const calls = fixtureGateway(h, {
      messages: { '-123': groupMessage(-123, { sender: BOT_QQ }) },
    });
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    // recentMessages 里：seq 7 → 真实 messageId -123；seq 8 没有真实 id（如拍一拍/网关切不到 id 的消息）。
    st.recentMessages.push({ seq: 7, messageId: '-123', sender: '我', text: '说错了', isSelf: true, time: Date.now() });
    st.recentMessages.push({ seq: 8, sender: '我', text: '没有回执 id', isSelf: true, time: Date.now() });

    const mapped = await recall(port, { key: GROUP, messageId: 7 }, st.agentToken);
    assert.equal(mapped.status, 200, mapped.raw);
    assert.equal(String(mapped.data.messageId), '-123');
    assert.deepEqual(plain(calls.deleteMsg), [{ message_id: -123 }], '本地 seq 必须映射成真实 id 再调网关');

    // design §2 错误约定：本地 seq 条目没有真实 messageId → 400（不得把 seq 当真实 id 发给网关）。
    const noRealId = await recall(port, { key: GROUP, messageId: 8 }, st.agentToken);
    assert.equal(noRealId.status, 400, `seq 无真实 id 应 400，实际 ${noRealId.status} ${noRealId.raw}`);
    assert.deepEqual(plain(calls.deleteMsg), [{ message_id: -123 }], 'seq 无真实 id 时不得再发 delete_msg');
  } finally { await closeServers(); await h.close(); }
});

// ── 9. 硬闸：工具开关 / 模式 / token / 暂停 / 白名单 ───────────────────────
test('9. 闸门：recallMessage=false、enabled=false、非 reserved2、无 token、坏 token、paused、跨白名单 → 403', async () => {
  // 工具开关关闭
  {
    const h = await bridgeHarness({ config: baseConfig({ tools: { recallMessage: false } }) });
    try {
      h.setMode('reserved2');
      const calls = fixtureGateway(h, { messages: { '-900': groupMessage(-900, { sender: BOT_QQ }) } });
      const port = await withServer(h);
      const st = h.getSocialV2State(GROUP);
      const res = await recall(port, { key: GROUP, messageId: '-900' }, st.agentToken);
      assert.equal(res.status, 403, res.raw);
      assert.match(res.data.error, /工具未启用/);
      assert.deepEqual(plain(calls.deleteMsg), []);
    } finally { await closeServers(); await h.close(); }
  }
  // 配置层 enabled=false
  {
    const h = await bridgeHarness({ config: baseConfig({ messageRecall: { enabled: false } }) });
    try {
      h.setMode('reserved2');
      const calls = fixtureGateway(h, { messages: { '-901': groupMessage(-901, { sender: BOT_QQ }) } });
      const port = await withServer(h);
      const st = h.getSocialV2State(GROUP);
      const res = await recall(port, { key: GROUP, messageId: '-901' }, st.agentToken);
      assert.equal(res.status, 403, res.raw);
      assert.match(res.data.error, /未开启|enabled/);
      assert.deepEqual(plain(calls.deleteMsg), []);
    } finally { await closeServers(); await h.close(); }
  }
  // 非 reserved2
  {
    const h = await bridgeHarness({ config: baseConfig() });
    try {
      h.setMode('chat');
      fixtureGateway(h, {});
      const port = await withServer(h);
      const st = h.getSocialV2State(GROUP);
      const res = await recall(port, { key: GROUP, messageId: '-902' }, st.agentToken);
      assert.equal(res.status, 403, res.raw);
      assert.match(res.data.error, /reserved2/);
    } finally { await closeServers(); await h.close(); }
  }
  // 无 token（reserved2 下强制）/ 坏 token
  {
    const h = await bridgeHarness({ config: baseConfig() });
    try {
      h.setMode('reserved2');
      fixtureGateway(h, {});
      const port = await withServer(h);
      const st = h.getSocialV2State(GROUP);
      const noToken = await recall(port, { key: GROUP, messageId: '-903' });
      assert.equal(noToken.status, 403, noToken.raw);
      assert.match(noToken.data.error, /agent token/);
      const badToken = await recall(port, { key: GROUP, messageId: '-903' }, 'deadbeef');
      assert.equal(badToken.status, 403, badToken.raw);
      assert.match(badToken.data.error, /token 无效/);
    } finally { await closeServers(); await h.close(); }
  }
  // AI 暂停
  {
    const h = await bridgeHarness({ config: baseConfig() });
    try {
      h.setMode('reserved2');
      const calls = fixtureGateway(h, { messages: { '-904': groupMessage(-904, { sender: BOT_QQ }) } });
      const port = await withServer(h);
      const st = h.getSocialV2State(GROUP);
      h.socialV2.paused = true;
      const res = await recall(port, { key: GROUP, messageId: '-904' }, st.agentToken);
      assert.equal(res.status, 403, res.raw);
      assert.match(res.data.error, /暂停/);
      assert.deepEqual(plain(calls.deleteMsg), []);
    } finally { await closeServers(); await h.close(); }
  }
  // 跨白名单会话（有合法 token，但会话不在 allow 白名单）
  {
    const h = await bridgeHarness({ config: baseConfig() });
    try {
      h.setMode('reserved2');
      const calls = fixtureGateway(h, { messages: {} });
      const port = await withServer(h);
      const otherSt = h.getSocialV2State(OTHER_GROUP);
      const res = await recall(port, { key: OTHER_GROUP, messageId: '-905' }, otherSt.agentToken);
      assert.equal(res.status, 403, res.raw);
      assert.match(res.data.error, /不在当前模式允许范围|白名单/);
      assert.deepEqual(plain(calls.deleteMsg), []);
    } finally { await closeServers(); await h.close(); }
  }
});

// ── 10. 每小时频率上限 429 ─────────────────────────────────────────────────
test('10. 每小时频率上限 → 429（成功才记账，失败不占额度）', async () => {
  const h = await bridgeHarness({ config: baseConfig({ messageRecall: { maxPerHour: 2 } }) });
  try {
    h.setMode('reserved2');
    const calls = fixtureGateway(h, {
      messages: { '-1000': groupMessage(-1000, { sender: BOT_QQ }) },
    });
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    st.recallTimes = [Date.now() - 1000, Date.now() - 2000];
    const limited = await recall(port, { key: GROUP, messageId: '-1000' }, st.agentToken);
    assert.equal(limited.status, 429, limited.raw);
    assert.match(limited.data.error, /上限/);
    assert.deepEqual(plain(calls.deleteMsg), [], '429 时不得触达 delete_msg');

    // 失败不记账：窗口过期/找不到消息不增加 recallTimes
    const st2h = await bridgeHarness({ config: baseConfig() });
    try {
      st2h.setMode('reserved2');
      fixtureGateway(st2h, { messages: {} });
      const port2 = await withServer(st2h);
      const st2 = st2h.getSocialV2State(GROUP);
      const failed = await recall(port2, { key: GROUP, messageId: '-404404' }, st2.agentToken);
      assert.equal(failed.status, 404, failed.raw);
      assert.equal(Array.isArray(st2.recallTimes) ? st2.recallTimes.length : 0, 0, '失败不得占用每小时额度');
    } finally { await closeServers(); await st2h.close(); }
  } finally { await closeServers(); await h.close(); }
});

// ── 11. 网关失败：delete_msg / get_msg 抛错 → 可读错误，不误记账 ────────────
test('11. delete_msg 抛错 → 500 可读；get_msg 抛错 → 404/500 可读；都不得误标 recalled', async () => {
  // delete_msg 失败
  {
    const h = await bridgeHarness({ config: baseConfig() });
    try {
      h.setMode('reserved2');
      const calls = fixtureGateway(h, {
        messages: { '-1100': groupMessage(-1100, { sender: BOT_QQ }) },
        deleteThrow: 'fixture-gateway-down',
      });
      const port = await withServer(h);
      const st = h.getSocialV2State(GROUP);
      st.recentMessages.push({ seq: 3, messageId: '-1100', sender: '我', isSelf: true });
      const res = await recall(port, { key: GROUP, messageId: '-1100' }, st.agentToken);
      assert.equal(res.status, 500, res.raw);
      assert.match(res.data.error, /撤回失败/);
      assert.match(res.data.error, /fixture-gateway-down/, '错误里要带网关 wording（便于排查）');
      assert.equal(calls.deleteMsg.length, 1, 'delete_msg 确实尝试过');
      assert.equal(Array.isArray(st.recallTimes) ? st.recallTimes.length : 0, 0, '失败不计频率');
      assert.notEqual(st.recentMessages.find((m) => String(m.messageId) === '-1100')?.recalled, true, '失败不得标 recalled');
    } finally { await closeServers(); await h.close(); }
  }
  // get_msg 失败：design §6.11 允许 404/500，但必须可读、且不触达 delete_msg
  {
    const h = await bridgeHarness({ config: baseConfig() });
    try {
      h.setMode('reserved2');
      const calls = fixtureGateway(h, { getMsgThrow: 'fixture-get-msg-timeout' });
      const port = await withServer(h);
      const st = h.getSocialV2State(GROUP);
      const res = await recall(port, { key: GROUP, messageId: '-1101' }, st.agentToken);
      assert.ok([404, 500].includes(res.status), `get_msg 抛错应 404/500，实际 ${res.status} ${res.raw}`);
      assert.match(String(res.data?.error ?? ''), /找不到|失败|get_msg/);
      assert.deepEqual(plain(calls.deleteMsg), [], 'get_msg 失败时绝不能继续 delete_msg');
    } finally { await closeServers(); await h.close(); }
  }
  // 取不到机器人自己的 QQ 号 → 500
  {
    const h = await bridgeHarness({ config: baseConfig() });
    try {
      h.setMode('reserved2');
      fixtureGateway(h, {
        messages: { '-1102': groupMessage(-1102, { sender: BOT_QQ }) },
        loginThrow: 'fixture-login-down',
      });
      const port = await withServer(h);
      const st = h.getSocialV2State(GROUP);
      const res = await recall(port, { key: GROUP, messageId: '-1102' }, st.agentToken);
      assert.equal(res.status, 500, res.raw);
      assert.match(res.data.error, /取不到机器人自己的 QQ 号/);
    } finally { await closeServers(); await h.close(); }
  }
});

// ── 12. 权限口径回归：非 owner 回合撤自己的消息必须成功 ─────────────────────
test('12. 群友触发的回合（非 owner）撤自己的消息 → 200（不要求 owner 回合/模型审批）', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const calls = fixtureGateway(h, {
      roles: { [BOT_QQ]: 'member' }, // 撤自己不需要管理员身份
      messages: {
        '-1200': groupMessage(-1200, { sender: BOT_QQ }),
        '-1201': groupMessage(-1201, { sender: MEMBER_QQ }),
      },
    });
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);
    // 群友发的消息触发了本回合：owner 归因为 false。
    await startTurn(h, GROUP, { owner: false });
    const res = await recall(port, { key: GROUP, messageId: '-1200' }, st.agentToken);
    assert.equal(res.status, 200, `非 owner 回合撤自己必须成功：${res.raw}`);
    assert.equal(res.data.self, true);
    assert.deepEqual(plain(calls.deleteMsg), [{ message_id: -1200 }]);
    // 放开的是审批，不是管理权限：非 owner 回合里撤别人，机器人不是管理员仍然 403。
    const others = await recall(port, { key: GROUP, messageId: '-1201' }, st.agentToken);
    assert.equal(others.status, 403, others.raw);
    assert.match(others.data.error, /管理员/);
    assert.deepEqual(plain(calls.deleteMsg), [{ message_id: -1200 }], '撤别人的被拒后不得触达 delete_msg');
  } finally { await closeServers(); await h.close(); }
});

// ── 13. 自己的消息 messageId 落库（前置能力）───────────────────────────────
test('13. send-message / send-burst 响应带 messageIds；recentMessages 的「我」带 messageId；recordSentMessagesV2 兼容字符串数组', async () => {
  // 分条发送的条间间隔默认是 1~3s（20% 抽到 5~10s）：固定成 100ms，避免随机长间隔把 5s 的
  // 夹具请求超时打穿（曾观察到 ~1/6 概率 flaky，不只是让测试慢）。
  const h = await bridgeHarness({
    config: baseConfig({ send: { burstIntervalMinMs: 100, burstIntervalMaxMs: 100, longGapProbability: 0 } }),
  });
  try {
    h.setMode('reserved2');
    const port = await withServer(h);
    const st = h.getSocialV2State(GROUP);

    // 13.1 统一发送：响应带 messageIds；recentMessages 的「我」条目带 messageId
    const one = await post(port, 'send-message', { key: GROUP, messages: ['第一条'] }, { token: st.agentToken });
    assert.equal(one.status, 200, one.raw);
    assert.deepEqual(one.data.messageIds, ['9001'], 'send-message 响应必须带 messageIds（本次发出的真实 id）');
    const selfEntries = () => st.recentMessages.filter((m) => m && m.isSelf === true);
    assert.equal(selfEntries().at(-1)?.messageId, '9001', 'recentMessages 里「我」的条目必须落 messageId');
    assert.equal(selfEntries().at(-1)?.text, '第一条');

    // 13.2 分条发送：同样落库
    const burst = await post(port, 'send-burst', { key: GROUP, messages: ['a', 'b'] }, { token: st.agentToken });
    assert.equal(burst.status, 200, burst.raw);
    assert.equal(burst.data.messageIds.length, 2, 'send-burst 响应必须带 messageIds');
    assert.ok(burst.data.messageIds.every((id) => String(id) === '9001'));
    assert.equal(selfEntries().filter((m) => String(m.messageId) === '9001').length >= 2, true);

    // 13.3 老调用方：recordSentMessagesV2 传字符串数组仍工作；没有回执 id 时不写 messageId 占位
    h.recordSentMessagesV2(GROUP, ['老接口-a', '老接口-b']);
    const tail = selfEntries().slice(-2);
    assert.deepEqual(plain(tail.map((m) => m.text)), ['老接口-a', '老接口-b']);
    for (const entry of tail) {
      assert.ok(!Object.prototype.hasOwnProperty.call(entry, 'messageId'), '没有回执 id 时不要写 null 占位');
    }
  } finally { await closeServers(); await h.close(); }
});

// ── 14. 静态接线（防「只改了桥接、忘了 MCP / 配置 / 预设 / 权限名单」）──────
test('14. 静态接线：bridge 两处 tools 默认表、messageRecall 段、MCP 工具、config.example、预设第 23 条、特权名单不含撤回', async () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  const bridge = read('src/bridge.js');
  assert.match(bridge, /url\.pathname === '\/api\/socialV2\/recall-message'/, '桥接撤回端点必须存在');
  assert.ok((bridge.match(/recallMessage: true/g) || []).length >= 2, 'bridge main() 两处 socialV2.tools 默认表都要开 recallMessage');
  assert.match(bridge, /messageRecall:\s*\{[\s\S]{0,300}?enabled:\s*true/, 'socialV2.messageRecall 默认段必须存在');
  assert.match(bridge, /windowMs:\s*2 \* 60 \* 1000|windowMs:\s*120000/, '默认窗口 2 分钟');
  assert.match(bridge, /maxPerHour:\s*30/, '默认每小时上限 30');
  assert.match(bridge, /const toolFlags = \[[^\]]*'recallMessage'/, '控制台保存的 toolFlags 必须含 recallMessage');
  assert.match(bridge, /for \(const sub of \[[^\]]*'messageRecall'/, '控制台保存的 sub 归一化列表必须含 messageRecall');
  assert.match(bridge, /onebotRawOrThrow/, '网关动作要经过带超时的 helper');
  assert.match(bridge, /groupMemberRoleForRecall/, '撤别人前必须查机器人/目标群身份');
  assert.match(bridge, /delete_msg/, '必须真的调用 OneBot delete_msg');

  const mcp = read('src/mcp-snowluma-safe.js');
  assert.match(mcp, /qq_recall_message:\s*'recallMessage'/, 'MCP 注册期开关必须登记（否则控制台关了仍可见）');
  assert.match(mcp, /server\.tool\(\s*'qq_recall_message'/, 'MCP 工具必须注册');
  assert.match(mcp, /\/api\/socialV2\/recall-message/, 'MCP 工具必须转发到桥接端点');
  // 模型可见的权限口径（design §4）：普通能力/不需要主人审批、qq_recall 区分、私聊只能撤自己、约 2 分钟、一次一条。
  assert.match(mcp, /不需要主人/, '工具描述必须写明不需要主人授权/审批');
  assert.match(mcp, /qq_recall/, '工具描述必须与 qq_recall（查记忆）区分');
  assert.match(mcp, /2\s*分钟|两分钟/, '工具描述必须写清约 2 分钟窗口');
  assert.match(mcp, /私聊/, '工具描述必须写清私聊只能撤自己');
  assert.match(mcp, /一次一条/, '工具描述必须写清一次一条');

  const example = JSON.parse(read('config.example.json'));
  assert.equal(example.socialV2.tools.recallMessage, true, 'config.example tools 要含 recallMessage:true');
  assert.equal(example.socialV2.messageRecall?.enabled, true, 'config.example 要含 messageRecall 段');
  assert.equal(example.socialV2.messageRecall?.windowMs, 120000);
  assert.equal(example.socialV2.messageRecall?.maxPerHour, 30);

  // 撤回是普通能力：不得进三个特权审批名单，也不得被 qq-owner-approval 引用。
  const turnTrigger = read('plugins/surfcore/lib/turn-trigger.js');
  const blocks = [...turnTrigger.matchAll(/export const (LOCAL_EXECUTION_TOOL_NAMES|ACCOUNT_LEVEL_TOOL_NAMES|GROUP_ADMIN_TOOL_NAMES) = Object\.freeze\(\[([\s\S]*?)\]\)/g)];
  assert.equal(blocks.length, 3, '三个特权工具名单必须都能找到');
  for (const [, name, body] of blocks) {
    assert.ok(!/recall/i.test(body), `${name} 不得包含撤回工具（撤回是普通能力，不进特权审批）`);
  }
  const approval = read('plugins/surfcore/qq-owner-approval.mjs');
  assert.ok(!/qq_recall_message|recallMessage|recall-message/i.test(approval), 'qq-owner-approval 不得引用撤回（不走模型审批）');

  const preset = read('dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
  assert.match(preset, /认错人了可以撤掉/);
  assert.match(mcp, /'qq_recall_message'/);
  assert.match(mcp, /qq_recall 是查记忆原文/);
  assert.match(mcp, /撤回是普通能力，不需要主人授权/);

  const audit = read('scripts/test-audit.mjs');
  assert.match(audit, /test-recall-message\.mjs/, '新测试必须登记进 test-audit');
});

// ── 15. 配置默认值与 clamp（design §1）────────────────────────────────────
test('15. 配置归一化：默认 {enabled:true,windowMs:120000,maxPerHour:30}；窗口 30s~5min、频率 1~200 clamp', async () => {
  {
    const h = await bridgeHarness({ config: baseConfig() });
    try {
      assert.equal(h.cfg.socialV2.tools.recallMessage, true);
      assert.deepEqual(plain(h.cfg.socialV2.messageRecall), { enabled: true, windowMs: 120000, maxPerHour: 30 });
    } finally { await h.close(); }
  }
  {
    const h = await bridgeHarness({ config: baseConfig({ messageRecall: { windowMs: 1, maxPerHour: 0 } }) });
    try {
      assert.deepEqual(plain(h.cfg.socialV2.messageRecall), { enabled: true, windowMs: 30000, maxPerHour: 1 });
    } finally { await h.close(); }
  }
  {
    const h = await bridgeHarness({ config: baseConfig({ messageRecall: { windowMs: 9999999, maxPerHour: 999, enabled: false } }) });
    try {
      assert.deepEqual(plain(h.cfg.socialV2.messageRecall), { enabled: false, windowMs: 300000, maxPerHour: 200 });
    } finally { await h.close(); }
  }
});

// ── 16. recallTimes 跨保存/加载持久化（重启不能刷撤回额度）────────────────
test('16. recallTimes 落盘并在重新加载后保留：save 后有数组，restore 后频率上限仍生效（429）', async () => {
  // 16.1 保存：成功撤回两次 → state/social-v2.json 里 recallTimes 必须落盘
  const h1 = await bridgeHarness({ config: baseConfig() });
  let savedRaw = '';
  try {
    h1.setMode('reserved2');
    const calls = fixtureGateway(h1, {
      messages: {
        '-1300': groupMessage(-1300, { sender: BOT_QQ }),
        '-1301': groupMessage(-1301, { sender: BOT_QQ }),
      },
    });
    const port = await withServer(h1);
    const st = h1.getSocialV2State(GROUP);
    for (const id of ['-1300', '-1301']) {
      const res = await recall(port, { key: GROUP, messageId: id }, st.agentToken);
      assert.equal(res.status, 200, res.raw);
    }
    assert.equal(plain(st.recallTimes).length, 2);
    // h.temp 是本次 VM 夹具的临时根目录；saveSocialV2State 写的正是 <temp>/state/social-v2.json。
    savedRaw = fs.readFileSync(path.join(h1.temp, 'state/social-v2.json'), 'utf8');
    const saved = JSON.parse(savedRaw);
    const savedTimes = saved?.conversations?.[GROUP]?.recallTimes;
    assert.ok(Array.isArray(savedTimes), 'saveSocialV2State 必须把 recallTimes 写进 social-v2.json（否则重启可刷额度）');
    assert.equal(savedTimes.length, 2, '成功的两次撤回都要落盘');
    assert.deepEqual(plain(calls.deleteMsg).length, 2);
  } finally { await closeServers(); await h1.close(); }

  // 16.2 加载：把刚写出的状态文件喂给新桥接（模拟重启）→ recallTimes 恢复，第 3 次被 429
  const h2 = await bridgeHarness({
    config: baseConfig({ messageRecall: { maxPerHour: 2 } }),
    files: { 'state/social-v2.json': savedRaw },
  });
  try {
    h2.setMode('reserved2');
    const calls = fixtureGateway(h2, { messages: { '-1302': groupMessage(-1302, { sender: BOT_QQ }) } });
    const port = await withServer(h2);
    const st2 = h2.getSocialV2State(GROUP);
    assert.equal(plain(st2.recallTimes).length, 2, '重新加载后必须恢复 recallTimes（模拟重启后仍保留）');
    const limited = await recall(port, { key: GROUP, messageId: '-1302' }, st2.agentToken);
    assert.equal(limited.status, 429, `restore 后频率上限仍应生效：${limited.raw}`);
    assert.match(limited.data.error, /上限/);
    assert.deepEqual(plain(calls.deleteMsg), [], '429 时不得触达 delete_msg');
  } finally { await closeServers(); await h2.close(); }
});
