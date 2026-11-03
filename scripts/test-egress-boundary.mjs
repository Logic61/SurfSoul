// 出站出口边界（2026-11-03）：
//   QQ 写动作**唯一**合法出口 = 桥接 HTTP（127.0.0.1:3100，带会话令牌 → 白名单/模式/审计/频率闸）。
//   MCP 工具面只允许对 SnowLuma OneBot HTTP 直连 5 个**只读**动作（qq_status / 群列表 /
//   群成员 / 群历史），用于桥接没起来时仍能回答「QQ 在不在线」。
//   这条旁路绕开桥接，所以必须冻结：任何写动作混进去 = 绕过全部发送闸门。
//
// 本测试只读源码/模块，不连真 QQ、不启服务。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ONEBOT_DIRECT_READ_ACTIONS,
  assertReadonlyOneBotAction,
  isReadonlyOneBotAction,
} from '../src/onebot-readonly.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS', name); } catch (error) { failures += 1; console.error('FAIL', name, error.message); }
}

const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const agentToolsDoc = fs.readFileSync(path.join(ROOT, 'docs', 'guides', 'AGENT-TOOLS-AND-PRESETS.md'), 'utf8');

check('直连白名单只含只读动作（get_* / fetch_*），且不含任何写动作', () => {
  assert.equal(ONEBOT_DIRECT_READ_ACTIONS.length, 5, '当前应只有 5 个直连只读动作');
  for (const action of ONEBOT_DIRECT_READ_ACTIONS) {
    assert.match(action, /^(get|fetch)_/, `直连动作必须是读取：${action}`);
    assert.doesNotMatch(action, /^(send|set|delete|upload|create|kick|ban|mute|recall)_/, `写动作不能直连：${action}`);
  }
});

check('闸门函数：白名单内放行、写动作/空值一律抛错', () => {
  for (const action of ONEBOT_DIRECT_READ_ACTIONS) {
    assert.equal(isReadonlyOneBotAction(action), true);
    assert.equal(assertReadonlyOneBotAction(action), action);
  }
  for (const action of ['send_group_msg', 'send_private_msg', 'set_group_ban', 'delete_msg', 'upload_group_file', '', null, undefined]) {
    assert.equal(isReadonlyOneBotAction(action), false, `不应放行：${JSON.stringify(action)}`);
    assert.throws(() => assertReadonlyOneBotAction(action), /禁止直连/, `应抛错：${JSON.stringify(action)}`);
  }
});

check('MCP 里所有直连调用都在白名单内，且直连前真的过了闸', () => {
  assert.ok(mcpSrc.includes('assertReadonlyOneBotAction(action)'), 'onebot() 必须调用闸门函数');
  const actions = [...mcpSrc.matchAll(/await onebot\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(actions.length >= 5, `应能扫到直连调用，实际 ${actions.length}`);
  for (const action of actions) {
    assert.ok(ONEBOT_DIRECT_READ_ACTIONS.includes(action), `发现未登记的直连动作：${action}`);
  }
  // 写动作绝不能出现在 onebot('…') 调用里。
  assert.ok(!/await onebot\('(send|set|delete|upload|kick|ban|mute)/.test(mcpSrc), '直连调用里出现写动作');
});

check('写动作仍只走桥接：发送工具走 agentApi，桥接侧发送端点存在', () => {
  for (const endpoint of [
    '/api/socialV2/send-message',
    '/api/socialV2/send-burst',
    '/api/send/reply',
    '/api/socialV2/send-image',
  ]) {
    assert.ok(bridgeSrc.includes(`'${endpoint}'`), `桥接缺少发送端点：${endpoint}`);
  }
  // MCP 的发送类工具必须调 agentApi（桥接），不能调 onebot()。
  for (const tool of ['qq_send_message', 'qq_send_burst', 'qq_send_image', 'qq_send_sticker']) {
    const idx = mcpSrc.indexOf(`'${tool}'`);
    assert.ok(idx > 0, `缺少工具：${tool}`);
  }
  const sendBlock = mcpSrc.slice(mcpSrc.indexOf("'qq_send_message'"), mcpSrc.indexOf("'qq_send_message'") + 5000);
  assert.ok(sendBlock.includes('agentApi('), 'qq_send_message 必须经桥接 agentApi');
});

check('文档写明了这条只读旁路（避免以后有人以为是遗漏）', () => {
  assert.ok(agentToolsDoc.includes('直连'), 'AGENT-TOOLS 文档应提到直连旁路');
  assert.ok(agentToolsDoc.includes('只读'), 'AGENT-TOOLS 文档应写明只读边界');
});

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\negress boundary tests OK');
}
