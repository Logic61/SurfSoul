// 场合作用域（2026-10-31 路线 A）真实 bridge 接线回归：夹具网关 + 临时 DSH_HOME，绝不连真 QQ。
//
// 覆盖：
//   1. 场合卡注入唤醒提示词（默认私聊/群聊 + overrides 档位）；
//   2. style-notes 写入带作用域 + 按场合过滤（旧格式无前缀=全局）；
//   3. 轻记忆 rule 类别：scope 校验、写入、按场合注入、跨场合只共享 global；
//   4. 记忆卡 audience 标记按场合过滤（含 groupExcludePrivate 硬开关）；
//   5. 受控跨场景投递（私聊 → 白名单群）：happy path + 全部闸门（来源/开关/白名单/长度/敏感/身份/频率/令牌）。
//
// 运行：node scripts/test-scene-wiring.mjs
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

function get(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/socialV2/${route}`,
      method: 'GET',
      headers: { 'x-console-token': CONSOLE_TOKEN }
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

async function withServer(h) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  ACTIVE_SERVERS.add(server);
  return server.address().port;
}

/** 夹具控制台是真实 http.Server：不关掉它进程不会退出（node:test 会挂住）。 */
const ACTIVE_SERVERS = new Set();
async function closeServers() {
  await Promise.all([...ACTIVE_SERVERS].map((server) => new Promise((resolve) => server.close(resolve))));
  ACTIVE_SERVERS.clear();
}

const baseConfig = () => ({
  ownerQQ: Number(OWNER_QQ),
  allow: { private: [OWNER_QQ], groups: ['456'] },
  socialV2: {
    scenes: {
      defaultGroup: { label: '测试群聊档', toneHint: '别太正式' }
    },
    crossSceneSend: { enabled: true, allowTargets: ['456'], maxPerHour: 3, maxChars: 120 }
  }
});

const sentGroupBodies = (h) => h.calls.http
  .filter((entry) => String(entry.url).endsWith('/send_group_msg'))
  .map((entry) => entry.body);

// ── 1. 场合卡 ───────────────────────────────────────────────────────────────
test('场合卡：唤醒提示词里明确「在哪种场合」+ 配置档位覆盖', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const groupPrompt = h.buildWakePromptV2(GROUP, 'question');
    assert.ok(groupPrompt.includes('【场合】'), '群聊唤醒必须带场合卡');
    assert.ok(groupPrompt.includes('测试群聊档'), 'config.socialV2.scenes.defaultGroup.label 必须生效');
    assert.ok(groupPrompt.includes('别太正式'), 'toneHint 必须注入');
    assert.ok(groupPrompt.includes(GROUP), '场合卡要带场景 key');
    assert.ok(groupPrompt.includes('群里不要主动提'), '群聊档位默认带私聊边界守卫');

    const privatePrompt = h.buildWakePromptV2(OWNER, 'question');
    assert.ok(privatePrompt.includes('【场合】'));
    assert.ok(privatePrompt.includes('私聊'), '私聊场合卡');
    assert.ok(!privatePrompt.includes('测试群聊档'), '私聊不该出现群聊档位');
  } finally { await h.close(); }
});

// ── 2. style-notes 作用域 ───────────────────────────────────────────────────
test('style-notes：写入带作用域前缀，注入按当前场合过滤（旧格式=全局）', async () => {
  const h = await bridgeHarness({
    config: baseConfig(),
    files: { 'dsh/surfcore/style-notes.md': '- 2026-10-28 老习惯（无前缀）\n' }
  });
  try {
    h.setMode('reserved2');
    const port = await withServer(h);
    const st = h.getSocialV2State(OWNER);

    assert.equal((await post(port, 'style-notes', { text: '全局习惯' })).status, 200);
    assert.equal((await post(port, 'style-notes', { text: '私聊习惯', scope: 'private' })).status, 200);
    assert.equal((await post(port, 'style-notes', { text: '群习惯', scope: 'group' })).status, 200);
    assert.equal((await post(port, 'style-notes', { text: '本群习惯', scope: 'group:456' })).status, 200);
    assert.equal((await post(port, 'style-notes', { text: '坏作用域', scope: 'bogus' })).status, 400, '非法 scope 必须 400');
    assert.equal((await post(port, 'style-notes', { text: 'here 没有场景上下文', scope: 'here' })).status, 400, '控制台写 here 必须拒绝');

    const groupView = await get(port, 'style-notes?key=group:456');
    assert.equal(groupView.status, 200);
    assert.ok(groupView.data.block.includes('老习惯（无前缀）'), '旧行按全局注入群');
    assert.ok(groupView.data.block.includes('全局习惯'));
    assert.ok(groupView.data.block.includes('群习惯'));
    assert.ok(groupView.data.block.includes('本群习惯'));
    assert.ok(!groupView.data.block.includes('私聊习惯'), '私聊条不得进群注入块');

    const privateView = await get(port, `style-notes?key=${encodeURIComponent(OWNER)}`);
    assert.ok(privateView.data.block.includes('私聊习惯'));
    assert.ok(privateView.data.block.includes('全局习惯'));
    assert.ok(!privateView.data.block.includes('群习惯'), '群条不得进私聊注入块');

    // 唤醒提示词（真实注入路径）同样过滤
    assert.ok(h.buildWakePromptV2(GROUP, 'question').includes('本群习惯'));
    assert.ok(!h.buildWakePromptV2(GROUP, 'question').includes('私聊习惯'));
    assert.ok(h.buildWakePromptV2(OWNER, 'question').includes('私聊习惯'));
    assert.ok(!h.buildWakePromptV2(OWNER, 'question').includes('本群习惯'));
    assert.ok(st, '会话状态存在');
  } finally { await closeServers(); await h.close(); }
});

// ── 3. 轻记忆 rule 类别 ─────────────────────────────────────────────────────
test('规矩 rule：scope 校验 / 按场合注入 / 跨场合只共享 global', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const port = await withServer(h);
    const ownerSt = h.getSocialV2State(OWNER);
    const groupSt = h.getSocialV2State(GROUP);

    const append = (key, token, content, scope) => post(port, 'memory-append', { key, category: 'rule', content, extra: scope === undefined ? {} : { scope } }, { token });
    assert.equal((await append(OWNER, ownerSt.agentToken, '别叫管理员', 'global')).status, 200);
    assert.equal((await append(OWNER, ownerSt.agentToken, '私聊里放开一点', 'private')).status, 200);
    assert.equal((await append(GROUP, groupSt.agentToken, '群里别发路径', 'group')).status, 200);
    assert.equal((await append(GROUP, groupSt.agentToken, '本群正经点', 'here')).status, 200);
    assert.equal((await append(GROUP, groupSt.agentToken, '坏规矩', 'bogus')).status, 400, '非法 scope 必须 400');

    // VM 里创建的对象原型与主 realm 不同，deepStrictEqual 会因原型不同而失败——统一过 JSON。
    const plain = (value) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(ownerSt.rules.map((r) => [r.text, r.scope])), [['别叫管理员', 'global'], ['私聊里放开一点', 'private']]);
    assert.deepEqual(plain(groupSt.rules.map((r) => [r.text, r.scope])), [['群里别发路径', 'group'], ['本群正经点', 'group:456']], 'here 必须落成具体群号');

    const groupMem = await get(port, `memory?key=${encodeURIComponent(GROUP)}&category=rule`);
    assert.equal(groupMem.status, 200);
    assert.ok(groupMem.data.formatted.includes('别叫管理员'), '跨场合 global 规矩要进群');
    assert.ok(groupMem.data.formatted.includes('群里别发路径'));
    assert.ok(groupMem.data.formatted.includes('本群正经点'));
    assert.ok(!groupMem.data.formatted.includes('私聊里放开一点'), 'private 规矩不得进群');

    const shared = await get(port, `memory-shared?key=${encodeURIComponent(GROUP)}`);
    assert.equal(shared.status, 200);
    assert.ok(shared.data.block.includes('别叫管理员'), '别的会话的 global 规矩要合并进跨会话块');
    assert.ok(shared.data.block.includes('全局规矩，另一个场合定下的'));
    assert.ok(!shared.data.block.includes('私聊里放开一点'), 'private 规矩不跨场合');

    const groupPrompt = h.buildWakePromptV2(GROUP, 'question');
    assert.ok(groupPrompt.includes('【记下的规矩（按场合生效）】'));
    assert.ok(groupPrompt.includes('别叫管理员'));
    assert.ok(!groupPrompt.includes('私聊里放开一点'));
    const privatePrompt = h.buildWakePromptV2(OWNER, 'question');
    assert.ok(privatePrompt.includes('私聊里放开一点'));
    assert.ok(!privatePrompt.includes('群里别发路径'), '群规矩不得进私聊');

    // 删除 + 清空同样走分类白名单
    assert.equal((await post(port, 'memory-remove', { key: GROUP, category: 'rule', content: '本群正经点' }, { token: groupSt.agentToken })).status, 200);
    assert.ok(!groupSt.rules.some((r) => r.text === '本群正经点'));
    assert.equal((await post(port, 'memory-clear', { key: GROUP, category: 'rule' }, { token: groupSt.agentToken })).status, 200);
    assert.deepEqual(plain(groupSt.rules), []);
  } finally { await closeServers(); await h.close(); }
});

// ── 4. 记忆卡 audience 按场合过滤 ──────────────────────────────────────────
test('记忆卡：audience 标记按场合过滤（默认共享；groupExcludePrivate 硬开关）', async () => {
  const cardBlock = [
    '## 最近记得的',
    '- 10-31 [清楚] [私聊] 私聊里说过的事',
    '- 10-31 [清楚] [私聊] 只在私聊可见的事 [仅私聊可见]',
    '- 10-31 [清楚] [群里] 群里发生的事',
    '- 10-31 [清楚] [群里] 只在群里可见的事 [仅群可见]',
  ].join('\n');
  const h = await bridgeHarness({
    config: baseConfig(),
    files: { 'dsh/surfcore/memory/memory-card-prompt-qq.md': cardBlock }
  });
  try {
    h.setMode('reserved2');
    // 2026-11-02：记忆卡改成只在 bootstrap 注入（每轮重发 = 重复烧 5.9k 字）；这里断言的
    // 是「注入时按场合过滤」的规则，所以用 bootstrap 这一份来验。
    const groupPrompt = h.buildWakePromptV2(GROUP, 'bootstrap');
    assert.ok(groupPrompt.includes('私聊里说过的事'), '默认记忆共同：[私聊] 普通记录进群');
    assert.ok(groupPrompt.includes('群里发生的事'));
    assert.ok(!groupPrompt.includes('只在私聊可见的事'), 'private-only 记录不得进群');
    assert.ok(groupPrompt.includes('只在群里可见的事'));
    const privatePrompt = h.buildWakePromptV2(OWNER, 'bootstrap');
    assert.ok(privatePrompt.includes('只在私聊可见的事'));
    assert.ok(!privatePrompt.includes('只在群里可见的事'), 'group-only 记录不得进私聊');
  } finally { await h.close(); }

  const h2 = await bridgeHarness({
    config: { ...baseConfig(), socialV2: { ...baseConfig().socialV2, memoryScene: { groupExcludePrivate: true } } },
    files: { 'dsh/surfcore/memory/memory-card-prompt-qq.md': cardBlock }
  });
  try {
    h2.setMode('reserved2');
    const groupPrompt = h2.buildWakePromptV2(GROUP, 'bootstrap');
    assert.ok(!groupPrompt.includes('私聊里说过的事'), 'groupExcludePrivate=true 时群聊连 [私聊] 记录也过滤');
    assert.ok(groupPrompt.includes('群里发生的事'));
  } finally { await h2.close(); }
});

// ── 5. 受控跨场景投递 ──────────────────────────────────────────────────────
test('跨场合投递：happy path（私聊 → 白名单群）并记进目标会话', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const port = await withServer(h);
    const ownerSt = h.getSocialV2State(OWNER);
    const res = await post(port, 'send-cross', { key: OWNER, target: GROUP, message: '帮我带一句：今晚八点开黑' }, { token: ownerSt.agentToken });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.ok, true);
    assert.equal(res.data.target, GROUP);
    assert.equal(res.data.sent, 1);
    const bodies = sentGroupBodies(h);
    assert.equal(bodies.length, 1, '必须真的发出一条 QQ 群消息');
    assert.equal(bodies[0].group_id, 456);
    assert.deepEqual(bodies[0].message, [{ type: 'text', data: { text: '帮我带一句：今晚八点开黑' } }]);
    const targetSt = h.getSocialV2State(GROUP);
    assert.ok(targetSt.recentMessages.some((m) => m && m.isSelf && String(m.text).includes('今晚八点开黑')), '目标会话状态要记下这条发言');
    assert.equal(ownerSt.crossSendTimes.length, 1, '来源会话记一次投递次数');
  } finally { await closeServers(); await h.close(); }
});

test('跨场合投递：闸门（来源/令牌/开关/白名单/长度/敏感/身份/频率）', async () => {
  const h = await bridgeHarness({ config: baseConfig() });
  try {
    h.setMode('reserved2');
    const port = await withServer(h);
    const ownerSt = h.getSocialV2State(OWNER);
    const groupSt = h.getSocialV2State(GROUP);
    const call = (body, opts = {}) => post(port, 'send-cross', body, { token: ownerSt.agentToken, ...opts });
    const noSend = () => assert.equal(sentGroupBodies(h).length, 0, '被拒绝时不得发出任何群消息');

    assert.equal((await call({ key: GROUP, target: GROUP, message: 'x' }, { token: groupSt.agentToken })).status, 403, '来源必须是主人私聊');
    noSend();
    assert.equal((await call({ key: OWNER, target: GROUP, message: 'x' }, { token: 'bad-token' })).status, 403, '坏令牌');
    noSend();
    assert.equal((await call({ key: OWNER, target: 'group:999', message: 'x' })).status, 403, '不在 allowTargets 的目标');
    noSend();
    assert.equal((await call({ key: OWNER, target: 'private:999', message: 'x' })).status, 400, '只开放私聊→群（目标格式非法直接 400）');
    noSend();
    assert.equal((await call({ key: OWNER, target: GROUP, message: '这是一条超过一百二十个字的超长消息'.repeat(20) })).status, 400, '超过 maxChars');
    noSend();
    assert.equal((await call({ key: OWNER, target: GROUP, message: '我的路径是 C:\\Users\\x\\secret.txt' })).status, 403, '敏感信息');
    noSend();
    assert.equal((await call({ key: OWNER, target: GROUP, message: `他的QQ是 ${OWNER_QQ}` })).status, 403, '身份泄露（账号号码进公开面）');
    noSend();
    assert.equal((await call({ key: OWNER, target: GROUP, message: '' })).status, 400, '空消息');
    noSend();

    // 频率：baseConfig maxPerHour=3；前三次成功，第四次 429
    assert.equal((await call({ key: OWNER, target: GROUP, message: '第1条' })).status, 200);
    assert.equal((await call({ key: OWNER, target: GROUP, message: '第2条' })).status, 200);
    assert.equal((await call({ key: OWNER, target: GROUP, message: '第3条' })).status, 200);
    assert.equal((await call({ key: OWNER, target: GROUP, message: '第4条' })).status, 429, '每小时上限');
    assert.equal(sentGroupBodies(h).length, 3, '只该发出前三条');
  } finally { await closeServers(); await h.close(); }

  const h2 = await bridgeHarness({ config: { ...baseConfig(), socialV2: { ...baseConfig().socialV2, crossSceneSend: { enabled: false, allowTargets: ['456'] } } } });
  try {
    h2.setMode('reserved2');
    const port = await withServer(h2);
    const ownerSt = h2.getSocialV2State(OWNER);
    const res = await post(port, 'send-cross', { key: OWNER, target: GROUP, message: 'x' }, { token: ownerSt.agentToken });
    assert.equal(res.status, 403, '总开关关闭时一律拒绝');
    assert.equal(sentGroupBodies(h2).length, 0);
  } finally { await closeServers(); await h2.close(); }
});

// ── 6. 静态接线 ────────────────────────────────────────────────────────────
test('静态接线：端点/工具/示例配置/审计链', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
  for (const needle of [
    "url.pathname === '/api/socialV2/send-cross'",
    "normalizeCrossSceneTarget(body.target)",
    "跨场合投递只允许从主人私聊发起",
    "isCrossSceneTargetAllowed(csCfg, target)",
    "跨场合投递未开启",
    "crossSceneRateBlocked(st.crossSendTimes",
    "crossSceneSend: 'qq_send_cross_scene'",
    "crossSceneSend: true",
  ]) assert.ok(bridge.includes(needle), `bridge 应包含：${needle}`);

  const mcp = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
  assert.ok(mcp.includes("'qq_send_cross_scene'"), 'MCP 应注册 qq_send_cross_scene');
  assert.ok(mcp.includes("qq_send_cross_scene: 'crossSceneSend'"), '工具开关登记');
  assert.ok(mcp.includes("'/api/socialV2/send-cross'"), 'MCP 调桥接端点');

  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.ok(example.socialV2?.crossSceneSend, 'config.example.json 要有 crossSceneSend');
  assert.equal(example.socialV2.crossSceneSend.enabled, false, '示例默认关闭（受控通道）');
  assert.ok(example.socialV2?.scenes, 'config.example.json 要有 scenes');
  assert.ok(example.socialV2?.memoryScene, 'config.example.json 要有 memoryScene');

  const audit = fs.readFileSync(path.join(ROOT, 'scripts/test-audit.mjs'), 'utf8');
  assert.ok(audit.includes("test-scene-scope.mjs"), '纯函数测试要进 test:audit');
  assert.ok(audit.includes("test-scene-wiring.mjs"), '接线测试要进 test:audit');
});
