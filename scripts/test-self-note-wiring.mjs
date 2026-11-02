// selfNote 自我认知层（2026-11-02）「接线」回归：真实 bridge.js + 夹具网关 + 临时 DSH_HOME，绝不连真 QQ。
//
// 覆盖：
//   1. 源码接线：桥接/工具描述都认得 selfNote 这一类；注入被 reason==='bootstrap' 门控；
//   2. 端到端：写入 → 重复只刷新 → bootstrap 注入一次（私聊/群聊共享）→ 非 bootstrap 不注入；
//   3. 查询（分类/全部）、清空全部不碰 selfNote、删除单条、显式清空 selfNote、关闭开关后不注入。
//
// 运行：node scripts/test-self-note-wiring.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE_TOKEN = 'fixture-console-token';
const OWNER = 'private:123';
const GROUP = 'group:456';
const NOTE_A = '我最近好像更能接受「不知道」了，不会硬答。';
const NOTE_A_NORMALIZED = '我最近好像更能接受「不知道」了，不会硬答';
const NOTE_B = '我发现自己在群里更愿意主动接话了。';
const BLOCK_HEADER = '【你对自己的记录（你自己写下的，不是别人给你的设定）】';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function post(port, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/socialV2/${route}`,
      method: 'POST',
      headers: { 'x-console-token': CONSOLE_TOKEN, 'content-type': 'application/json' }
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
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

const selfNotesFile = (h) => path.join(h.temp, 'dsh', 'surfcore', 'memory', 'self-notes.json');
const memoryRoute = (category) => `memory?key=${encodeURIComponent(OWNER)}${category ? `&category=${category}` : ''}`;

test('源码接线：selfNote 有独立模块、写入端点、bootstrap 门控、工具描述可发现', () => {
  const bridge = read('src/bridge.js');
  const mcp = read('src/mcp-snowluma-safe.js');
  assert.match(bridge, /from '\.\/self-notes\.js'/, '桥接没有引入 selfNote 模块');
  assert.match(bridge, /if \(category === 'selfNote'\)/, '写入/删除端点没有 selfNote 分支');
  assert.match(bridge, /reason === 'bootstrap' && cfg\.socialV2\?\.selfNotes\?\.enabled !== false/, '注入没有按 bootstrap 门控');
  assert.match(bridge, /qq_memory_append\(category="selfNote"/, 'bootstrap 提示没有告诉她怎么写');
  assert.match(mcp, /'rule', 'selfNote'\]/, 'qq_memory_* 工具的参数枚举缺 selfNote');
  assert.match(mcp, /selfNote=/, '工具描述里没有 selfNote 的说明');
  // 清空「全部」不能顺手动按角色共享的自我记录（见 bridge 里的注释与端点实现）。
  assert.match(bridge, /if \(category === 'selfNote'\) clearSelfNotes\(/, '清空端点没有单独的 selfNote 分支');
});

test('端到端：写入 → bootstrap 注入一次 → 查询/清空/删除', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } } });
  const server = await withServer(h);
  try {
    // 0) 空状态：bootstrap 只给「怎么写」的引导，不注入空块
    const emptyBoot = h.buildWakePromptV2(OWNER, 'bootstrap');
    assert.ok(emptyBoot.includes('qq_memory_append(category="selfNote"'), 'bootstrap 应告诉她怎么记自己');
    assert.equal(emptyBoot.includes(BLOCK_HEADER), false, '没有记录时不应注入空块');

    // 1) 写入（走真实 HTTP 端点，和 qq_memory_append 工具同一条路）
    const appended = await post(server.port, 'memory-append', { key: OWNER, category: 'selfNote', content: NOTE_A });
    assert.equal(appended.status, 200);
    assert.equal(appended.data.ok, true);
    assert.equal(appended.data.added, true);
    assert.equal(appended.data.total, 1);
    assert.ok(fs.existsSync(selfNotesFile(h)), 'self-notes.json 应落在记忆目录');

    // 2) 同一句再写：只刷新时间，不占条数
    const again = await post(server.port, 'memory-append', { key: OWNER, category: 'selfNote', content: NOTE_A.replace(/。$/, '') });
    assert.equal(again.status, 200);
    assert.equal(again.data.added, false);
    assert.equal(again.data.touched, true);
    assert.equal(again.data.total, 1, '整句去重后不应变成 2 条');

    // 2b) 脱敏：内容里带上真实会话令牌，落盘前应被抹掉（和 appendMemoryV2 同一条闸门）
    const token = h.getSocialV2State(OWNER).agentToken;
    const secretNote = `我记住了一个令牌 ${token}`;
    assert.equal((await post(server.port, 'memory-append', { key: OWNER, category: 'selfNote', content: secretNote })).data.ok, true);
    assert.equal(fs.readFileSync(selfNotesFile(h), 'utf8').includes(token), false, '自我记录落盘前必须脱敏');
    assert.equal((await post(server.port, 'memory-remove', {
      key: OWNER, category: 'selfNote', content: secretNote.replace(token, '***')
    })).data.ok, true);

    // 3) 只在 bootstrap 注入一次（换新会话才读），平时不刷屏
    const boot = h.buildWakePromptV2(OWNER, 'bootstrap');
    assert.ok(boot.includes(BLOCK_HEADER), 'bootstrap 必须带自我记录块');
    assert.ok(boot.includes(NOTE_A_NORMALIZED), '块里要有她写过的那句');
    for (const reason of ['question', 'replyCheck', 'timeout', 'proactiveCheck', 'atMention']) {
      assert.equal(h.buildWakePromptV2(OWNER, reason).includes(BLOCK_HEADER), false, `${reason} 不该每轮注入自我记录`);
    }
    // 按角色共享：群聊换新会话也读得到同一个「我」
    assert.ok(h.buildWakePromptV2(GROUP, 'bootstrap').includes(BLOCK_HEADER), '群聊 bootstrap 也应读到同一份自我记录');

    // 4) 查询：分类查 / 全部查
    const byCategory = await get(server.port, memoryRoute('selfNote'));
    assert.equal(byCategory.status, 200);
    assert.ok(byCategory.data.formatted.includes(BLOCK_HEADER));
    assert.equal(byCategory.data.raw.selfNotes.length, 1);
    const all = await get(server.port, memoryRoute(''));
    assert.ok(all.data.formatted.includes(BLOCK_HEADER), '不传 category 时也应带上自我记录');
    assert.equal(all.data.raw.selfNotes.length, 1);

    // 5) 清空「全部轻记忆」不能顺手抹掉按角色共享的自我记录
    const clearedAll = await post(server.port, 'memory-clear', { key: OWNER });
    assert.equal(clearedAll.status, 200);
    assert.ok(fs.existsSync(selfNotesFile(h)), '清空全部不应删除 self-notes.json');
    assert.equal((await get(server.port, memoryRoute('selfNote'))).data.raw.selfNotes.length, 1);

    // 6) 删除单条（归一化匹配）
    const removed = await post(server.port, 'memory-remove', { key: OWNER, category: 'selfNote', content: NOTE_A });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.ok, true);
    assert.equal((await get(server.port, memoryRoute('selfNote'))).data.raw.selfNotes.length, 0);
    assert.equal(h.buildWakePromptV2(OWNER, 'bootstrap').includes(BLOCK_HEADER), false, '删空后 bootstrap 不再注入块');

    // 7) 显式清空 selfNote
    assert.equal((await post(server.port, 'memory-append', { key: OWNER, category: 'selfNote', content: NOTE_B })).data.ok, true);
    assert.equal((await post(server.port, 'memory-clear', { key: OWNER, category: 'selfNote' })).status, 200);
    assert.equal((await get(server.port, memoryRoute('selfNote'))).data.raw.selfNotes.length, 0);
  } finally {
    await server.close();
    await h.close();
  }
});

test('开关关闭：文件里存着记录也不注入（可回滚）', async () => {
  const h = await bridgeHarness({ config: { socialV2: { selfNotes: { enabled: false } } } });
  try {
    const file = selfNotesFile(h);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      notes: [{ text: NOTE_A, createdAt: Date.now(), lastTouchedAt: Date.now() }]
    }), 'utf8');
    const boot = h.buildWakePromptV2(OWNER, 'bootstrap');
    assert.equal(boot.includes(BLOCK_HEADER), false, 'enabled=false 时不应注入');
  } finally {
    await h.close();
  }
});

test('坏文件不炸唤醒：self-notes.json 内容坏了，bootstrap 照常生成', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } } });
  try {
    const file = selfNotesFile(h);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{{ 坏 JSON', 'utf8');
    const boot = h.buildWakePromptV2(OWNER, 'bootstrap');
    assert.ok(boot.includes('【引导唤醒】'), '坏文件不应影响唤醒提示生成');
    assert.equal(boot.includes(BLOCK_HEADER), false);
  } finally {
    await h.close();
  }
});

