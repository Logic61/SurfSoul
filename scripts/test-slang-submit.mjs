// 黑话提交限制移除（2026-10-31 用户要求「把黑话提交的限制去掉」）的静态回归：
// 1) 桥接侧不再对 AI 提交做每会话限频（不再有 429「黑话提交过于频繁」）；
// 2) 提交接口的鉴权/开关/长度/同词合并/管理员拒绝守卫仍然在；
// 3) preset 与 MCP 工具描述都鼓励「遇到没把握的词就直接提」，旧前置条件不再回来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, ROOT), 'utf8');

test('桥接不再对黑话提交做每会话限频', () => {
  const bridge = read('src/bridge.js');
  for (const gone of ['allowSlangSubmit', 'slangSubmitTimes', '黑话提交过于频繁', 'AI 提交黑话候选的限频']) {
    assert.ok(!bridge.includes(gone), `应已移除：${gone}`);
  }
});

test('提交接口的鉴权/开关/长度/同词合并/拒绝守卫仍在', () => {
  const bridge = read('src/bridge.js');
  for (const keep of [
    "url.pathname === '/api/socialV2/slang/submit'",
    "v2ToolEnabled('slangSubmit')",
    'agentTokenOk(key, req.headers[\'x-agent-token\'])',
    'cfg.slang?.enabled === false',
    '黑话词条过长（最多 50 字）',
    'duplicate: true',
    '该词已被管理员拒绝',
    'createSlangEntry({',
  ]) assert.ok(bridge.includes(keep), `应保留：${keep}`);
});

test('preset 与 MCP 描述鼓励直接提交，旧限制不再出现', () => {
  const preset = read('dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
  const mcp = read('src/mcp-snowluma-safe.js');
  assert.ok(preset.includes('直接 qq_slang_submit 提交候选词'), 'preset 应鼓励直接提交');
  assert.ok(preset.includes('不用等它出现多次'), 'preset 应明确不用等多次出现');
  assert.ok(!preset.includes('多次出现才'), 'preset 不应再要求「多次出现才提交」');
  assert.ok(!preset.includes('不重复提交'), 'preset 不应再要求「不重复提交」');
  assert.ok(mcp.includes('不用等它反复出现'), 'MCP 描述应鼓励直接提交');
  assert.ok(!mcp.includes('经常看到但不确定含义'), 'MCP 描述不应再要求「经常看到」');
});
