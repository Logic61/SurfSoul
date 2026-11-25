// reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。
// 这些检查只能防止关键协议/能力被误删，不能证明聊天质量无损。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const preset = yaml.load(fs.readFileSync(
  new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8',
));
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

test('reserved2 YAML resolves to the expected persona and template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  assert.match(prefix, /\{\{model\}\}/);
  // DSH 0.2.1-rc.2 起 {{cwd}} 不再由 agent loop 注册；QQ 会话改用固定说明，
  // 否则模板变量会原样泄漏到提示词里。
  assert.equal(persona.config.suffix, 'This conversation happens on QQ, not in a local shell.');
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
});

test('local/admin tool restrictions and existing compaction budgets stay intact', () => {
  assert.deepEqual(preset.map((row) => row.id), [
    'qq-model-route', 'persona', 'tool-web', 'tool-ask-user', 'tool-todo',
    // 2026-10-29 加进来的本地工具行（执行期由 qq-tool-restrict 兜底，2026-11-06 起
    // 非私聊场景还要过 qq-owner-approval 的模型审批）
    'tool-pwsh', 'tool-fs', 'tool-fs-search',
    'qq-tool-restrict',
    // 2026-11-06 加进来的模型审批行：本地工具/账号级/群管理在主人触发的回合里逐次审批
    'qq-owner-approval',
    'compaction',
  ]);
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: false });
  assert.equal(preset.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
  assert.equal(preset.find((row) => row.id === 'qq-owner-approval').name, './qq-owner-approval.mjs');
  assert.deepEqual(preset.find((row) => row.id === 'qq-owner-approval').config, {});
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
  // 2026-11-06 用户拍板「工具场景放宽」之后，第 1 条从「只在主人私聊里可用」改成
  // 「只在主人本人触发的回合可用」；这里钉住新文案与新不变量短句。
  for (const text of ['**主人本人触发的回合**', '模型审批', '群友没有管理权限', '角色由桥接注入']) {
    assert.ok(prefix.includes(text), `missing safety rule: ${text}`);
  }
  assert.match(prefix, /群友也可以请你画图/);
  assert.match(prefix, /原消息.+目标与展示范围/);
  assert.ok(prefix.includes('不要反复重试'), '第 22 条应要求被拒后不要反复重试');
});

test('snapshots are optional, partial snapshots require reading, and watermarks are not message IDs', () => {
  assert.match(prefix, /可能附带【本次消息快照】/);
  assert.match(prefix, /partial=true[^。]*继续读取/);
  assert.match(prefix, /readThroughSeq 是桥接本地的 seq，不是 QQ messageId/);
  assert.match(prefix, /没有水位[^。]*省略 throughSeq/);
  assert.match(prefix, /总提示随新会话送达[^。]*缺失时才查 qq_get_prompt/);
});

test('one closing action can acknowledge the read watermark after the full observation', () => {
  assert.match(prefix, /qq_mark_read\(throughSeq=/);
  assert.match(prefix, /qq_set_wake_config\(config=[^)]*throughSeq=/);
  assert.match(prefix, /不需先 mark_read/);
  assert.match(prefix,/想暂时潜水时，按这个会话的观察窗口等待/);
});

test('模型结合上下文选择短等和自然收尾，计时细节在等待工具中', () => {
  assert.match(prefix,/最近几句是谁说给谁的/);
  assert.match(prefix,/还没打完.*purpose="reply"/);
  assert.match(prefix,/都道过别.*直接 qq_close_conversation/);
  assert.match(prefix,/对方再开口，再接新的话/);
  assert.match(mcp,/预算到但 quiet=false/);
  assert.match(mcp,/短等待不能代替/);
  assert.match(mcp,/preSleepWaitRemainingMs 只用于潜水/);
});

test('有证据的口头禅反馈会在收尾前写入 selfNote', () => {
  assert.match(prefix, /原话、口头禅或截图做梗[^。]*先看在模仿你哪种说法/);
  assert.match(prefix, /确实反复说过的句式[^。]*这轮收尾前用 qq_memory_append\(category="selfNote", content="一句"\)[^。]*QQ 开口/);
  assert.match(prefix, /证据不足或已经记过就略过/);
  assert.match(prefix, /DSH 小记[^。]*实际调记忆工具/);
});

const mcp = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
test('voice leads the preset and action contracts live with the exposed tools', () => {
  assert.ok(prefix.indexOf('【开口的语感】') < 120);
  assert.ok(prefix.indexOf('你不也没睡') < prefix.indexOf('工具协议'));
  assert.ok(prefix.length < 5000);
  assert.match(prefix, /qq_send_message.*qq_send_voice.*qq_send_sticker.*一次回复可以只有其中一种/);
  assert.match(prefix, /安静下来/);
  assert.match(prefix, /不会自动发送到 QQ/);
  for (const name of ['qq_send_poke','qq_generate_image','qq_collect_sticker','qq_sticker_note',
      'qq_get_self_image','qq_set_sticker_remark','qq_list_voices','qq_send_voice','qq_memory_query','qq_recall',
      'qq_look_at_screen','qq_set_my_group_card','qq_get_message_images','qq_get_forward_msg']) {
    assert.ok(mcp.includes("'" + name + "'"), name);
  }
  const recall = mcp.slice(mcp.indexOf("'撤回一条 QQ 消息"), mcp.indexOf("'撤回一条 QQ 消息") + 800);
  for (const phrase of ['不需要主人授权','本群管理员','明显违规','别当枪','私聊','一次一条','如实说撤不回']) assert.ok(recall.includes(phrase), phrase);
  assert.match(mcp, /群聊不卡时间窗口/);
});
