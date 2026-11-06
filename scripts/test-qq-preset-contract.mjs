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
    'persona', 'tool-web', 'tool-ask-user', 'tool-todo',
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
  // 旧的「只允许私聊」硬限制不能悄悄回来（场景已放宽，改回去会让能力失效）。
  assert.equal(prefix.includes('只在主人私聊里可用'), false, '旧文案「只在主人私聊里可用」不应回到 preset');
  // 群聊画图从「一律拒绝」变成「可以用，但有频率上限」——两边文案必须一致。
  assert.ok(prefix.includes('**画图工具 qq_generate_image 是例外：群聊里也能用**'), '安全规则 1 应说明画图工具在群聊可用');
  assert.ok(prefix.includes('**画图不在此列**'), '群聊拒绝清单应说明画图不在此列');
  // Codex / 好友申请 / 群管理的旧场景限制必须同步放宽（design.md §3.5 第 18/20/21 条）。
  assert.equal(prefix.includes('【用 Codex 画图（仅主人私聊，备用）】'), false, 'Codex 旧标题（仅主人私聊）应被替换');
  assert.equal(prefix.includes('【好友申请（仅主人私聊，权限已放开）】'), false, '好友申请旧标题应被替换');
  assert.equal(prefix.includes('唤醒提示里出现【管理员在群里】才说明授权窗口有效'), false, '群管理旧窗口文案应被替换');
  // 第 22 条【场景与审批】必须存在，并说明「本回合授权」行与被拒不要重试。
  assert.ok(prefix.includes('【场景与审批】'), '缺少第 22 条【场景与审批】');
  assert.ok(prefix.includes('【本回合授权】'), '第 22 条应解释唤醒提示里的【本回合授权】行');
  assert.ok(prefix.includes('不要反复重试'), '第 22 条应要求被拒后不要反复重试');
});

test('snapshots are optional, partial snapshots require reading, and watermarks are not message IDs', () => {
  assert.match(prefix, /可能附带【本次消息快照】/);
  assert.match(prefix, /partial=true[^。]*继续读取/);
  assert.match(prefix, /readThroughSeq 是桥接本地的 seq，不是 QQ messageId/);
  assert.match(prefix, /没有水位[^。]*省略 throughSeq/);
  assert.match(prefix, /首次进入会话、角色变化[^。]*qq_get_prompt/);
});

test('one closing action can acknowledge the read watermark after the full observation', () => {
  assert.match(prefix, /qq_mark_read\(throughSeq=/);
  assert.match(prefix, /qq_set_wake_config\(config=[^)]*throughSeq=/);
  assert.match(prefix, /不需先 mark_read/);
  assert.match(prefix, /qq_wait_for_messages\(timeoutMs=300000\)/);
  assert.match(prefix, /短等待不能代替/);
  assert.match(prefix, /preSleepWaitRemainingMs[^。]*继续等待/);
  assert.match(prefix, /若你参与回复[^。]*重新观察/);
});

test('pre-reply quiet checks, waiting for replies and pre-sleep observation have distinct instructions', () => {
  assert.match(prefix, /先理解并处理当前消息/);
  assert.match(prefix, /【首答前】[^\n]*qq_wait_for_messages\(purpose="reply", quietMs=10000\)/);
  assert.match(prefix, /读取和思考花掉的时间也算，已安静足够就立即返回/);
  assert.match(prefix, /不要再重开一次普通长等待/);
  assert.match(prefix, /预算到但 quiet=false 不等于对方说完/);
  assert.match(prefix, /【等下文】[^\n]*purpose="messages", timeoutMs=60000~120000/);
  assert.match(prefix, /【回复后】[^\n]*qq_wait_for_messages\(purpose="messages"\)/);
  assert.match(prefix, /短静默不算沉睡前观察/);
  assert.match(prefix, /5 分钟观察不是回复的前置条件/);
  assert.match(prefix, /只有准备潜水时[^。]*preSleepWaitRemainingMs/);
});

test('conversation closure has a legal exit and stays distinct from diving', () => {
  assert.match(prefix, /【对话收尾：结束不是终止】/);
  assert.match(prefix, /qq_close_conversation/);
  assert.match(prefix, /自然收尾（qq_close_conversation）不是潜水/);
  assert.match(prefix, /对方明确在提问\/求助时[^。]*先回答/);
  assert.match(prefix, /【回复后】[^\n]*先判断这段是不是已经自然收尾/);
});

test('social autonomy and visual, forwarding, sticker and web capabilities remain described', () => {
  for (const text of [
    '【反 AI 味：拒绝有求必应】', '【保持主体性】', '【学习群友策略】',
    '【不要当群管家/主持人】', '普通对话默认 1 条，最多 2 条', '不要用空格断句',
    '不会自动发送到 QQ', 'qq_get_message_images', 'qq_get_forward_msg', 'nestedForwardIds',
    'qq_send_poke', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker',
    'qq_collect_sticker', 'qq_sticker_note', 'qq_get_self_image',
    'qq_set_sticker_remark', '只有管理端明确开启后才能用',
    'qq_list_voices', 'qq_send_voice', 'verified=true 才代表这条语音确实落地',
    '【发语音（工具在就用）】', '出厂的语音工具默认关闭', '能看到 qq_send_voice', '不要假装发了语音',
    // text→本地 TTS：模型得知道能「说一句」并带语气标记，否则永远只发文字
    '传 text 把这句话**现场合成**成语音条', '语气标记', '[不耐烦]', '别每句都标',
    'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
    // 2026-11-01 主人要求：QQ 白名单里加「调 codex 画图」的能力，这是模型必须知道的知识
    // （不是 hint：模型得会 subagent_codex → qq_send_image 这条链路，否则能力等于没装）。
    // 2026-11-06 场景放宽：Codex 不再「仅主人私聊」，改为「主人本人触发的回合可用」。
    '【用 Codex 画图（主人本人触发的回合可用，备用）】', 'subagent_codex', '最终回答文字',
    'mcp__snowluma__qq_send_image', '3~5 分钟', '别假装画了',
    // 2026-11-01 追加：Agnes 快速画图通道（10~25 秒），是「画图」时的首选工具；
    // 同日追加：群聊里也能画（有会话配额）。
    '【画图（群聊 / 主人私聊都可以，优先用这个）】', 'qq_generate_image', '10~25 秒',
    '群聊里也能画', '每小时约 3 张', '不要主动刷图', '不把别人的私密信息、账号号码写进 prompt',
  ]) assert.ok(prefix.includes(text), `missing capability or voice rule: ${text}`);
});

test('autonomy limits and the observation escape hatch stay described', () => {
  // These rules were previously unguarded: deleting any of them left every test green.
  for (const text of [
    // 沉睡前观察唯一的逃生口：明确结束语可以跳过 5 分钟等待。
    '除非对方明确“不聊了/晚安/下了/拜拜”等结束语',
    // [SILENT] 是桥接的退出标记，误用会静默吞掉回复。
    '不要用 [SILENT]',
    // 记忆面
    '【记忆卫生】', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear', 'qq_recall',
    // 黑话面
    'qq_slang_query', 'qq_slang_submit', '不用等它出现多次',
    // 软策略：频率交给模型审时度势；允许纯表情回复、鼓励盗图（2026-10-31 用户要求）
    '频率自己审时度势', '可以单独作为一条回复', '鼓励盗图', '好图不偷白不偷',
    '每条只能一张，不能附带文字', '不要频繁拍',
    // 会话令牌是硬前置，漏传会被拒绝。
    '作为 token 参数传入',
    // 指定成员唤醒
    'triggers.speakerIds', '不凭记忆乱填',
  ]) assert.ok(prefix.includes(text), `missing rule: ${text}`);
  // 旧限制不能悄悄回来（用户 2026-10-31 明确要求删掉）
  // 2026-10-31 用户要求「把黑话提交的限制去掉」：不再要求「多次出现才提交 / 不重复提交」
  for (const gone of ['多次出现才 qq_slang_submit', '不重复提交']) {
    assert.ok(!prefix.includes(gone), `已移除的黑话提交限制不应回到 preset: ${gone}`);
  }
  for (const gone of ['普通闲聊约 3~5 轮一张', '也别总拿表情作为唯一回复', '不要频繁收藏']) {
    assert.ok(!prefix.includes(gone), `已移除的表情限制不应回到 preset: ${gone}`);
  }
});

console.log(`reserved2 persona prefix: ${prefix.length} characters (not a model-token estimate)`);
