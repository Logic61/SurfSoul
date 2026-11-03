// 模式矩阵（2026-11-03）：
//   一代模式（chat / reserved）已冻结，reserved2 是唯一在演进的模式。
//   本测试钉住四个模式的「准入范围 + preset 选择 + 严格 fail-closed」矩阵，
//   改桥接的模式/鉴权/会话创建逻辑时先看它——冻结不等于不管。
//
// 真实 bridge.js（VM 夹具，不连真 QQ / 不启服务）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
async function test(name, fn) {
  const h = await bridgeHarness({
    config: { ownerQQ: 123, allow: { private: ['123'], groups: ['456'] }, agentPreset: 'qq-chat',
      socialV2: { enabled: true, agentPreset: 'qq-chat-v2' } },
  });
  try {
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2', 'closed-fixture']);
    await fn(h);
    console.log('PASS', name);
  } catch (error) {
    failures += 1;
    console.error('FAIL', name, error.message);
  } finally {
    try { await h.close(); } catch { /* 已关闭 */ }
  }
}

const cfg = { ownerQQ: 123, allow: { private: ['123'], groups: ['456'] }, deny: { users: [] } };

await test('closed-agent：只放行主人私聊（白名单完全不参与）', (h) => {
  assert.equal(h.modeAllowed('private:123', 'private', 123, cfg, 'closed-agent'), true);
  assert.equal(h.modeAllowed('private:999', 'private', 999, cfg, 'closed-agent'), false);
  assert.equal(h.modeAllowed('group:456', 'group', 456, cfg, 'closed-agent'), false, '白名单群也不放行');
});

await test('chat / reserved / reserved2：按 allow/deny 白名单准入', (h) => {
  for (const mode of ['chat', 'reserved', 'reserved2']) {
    assert.equal(h.modeAllowed('private:123', 'private', 123, cfg, mode), true, `${mode} 主人私聊`);
    assert.equal(h.modeAllowed('group:456', 'group', 456, cfg, mode), true, `${mode} 白名单群`);
    assert.equal(h.modeAllowed('group:789', 'group', 789, cfg, mode), false, `${mode} 非白名单群`);
    assert.equal(h.modeAllowed('private:999', 'private', 999, cfg, mode), false, `${mode} 陌生人私聊`);
  }
});

await test('preset 矩阵：reserved2 用 qq-chat-v2，一代用 agentPreset，closed-agent 用默认', (h) => {
  assert.equal(h.modePreset('private:123', 'reserved2', { socialV2: { agentPreset: 'qq-chat-v2' }, agentPreset: 'qq-chat' }), 'qq-chat-v2');
  assert.equal(h.modePreset('group:456', 'reserved2', { socialV2: { agentPreset: 'qq-chat-v2' }, agentPreset: 'qq-chat' }), 'qq-chat-v2');
  assert.equal(h.modePreset('group:456', 'chat', { agentPreset: 'qq-chat' }), 'qq-chat');
  assert.equal(h.modePreset('group:456', 'reserved', { agentPreset: 'qq-chat' }), 'qq-chat');
});

await test('preset 严格模式：未知名字 fail-closed（绝不能回退到带本地工具的默认 preset）', (h) => {
  assert.equal(h.resolvePresetName('qq-chat', { strict: true }), 'qq-chat');
  assert.equal(h.resolvePresetName('missing-preset', { strict: true }), '', '群聊/仿真会话必须 fail-closed');
  assert.equal(h.resolvePresetName('missing-preset', { strict: false }), 'standard', 'closed-agent 可回退默认');
  assert.equal(h.resolvePresetName('', { strict: true }), '', '空名字在严格模式下也拒绝');
});

await test('reserved2 的唤醒提示词带【唤醒】而不是自动转发文本（一代语义不会漏进来）', (h) => {
  h.setMode('reserved2');
  h.appendSocialV2Message('private:123', '主人', '在吗', '在吗', false, true, 'm-mode');
  const wake = h.buildWakePromptV2('private:123', 'question');
  assert.match(wake, /【唤醒】/);
  const bootstrap = h.buildWakePromptV2('private:123', 'bootstrap');
  assert.match(bootstrap, /文本输出不会自动发送|一切发言必须通过工具/, '二代 bootstrap 必须说明文本不自动发送');
});

// 文档冻结声明：不是形式主义——它决定下一次改动该不该动一代分支。
const roadmap = fs.readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
if (!roadmap.includes('模式冻结')) {
  failures += 1;
  console.error('FAIL ROADMAP 缺少「模式冻结」声明（一代 chat/reserved 只修安全，不再加功能）');
} else {
  console.log('PASS ROADMAP 已声明一代模式冻结');
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\nmode matrix tests OK');
}
