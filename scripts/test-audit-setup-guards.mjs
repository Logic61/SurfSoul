// Execute both real preset plugins against a captured tools service, without DSH/QQ.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractPresetPrefix } from '../src/preset-prompt.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
for (const preset of ['qq-chat', 'qq-chat-v2']) {
  const { apply } = await import(pathToFileURL(path.join(root, 'dsh/agent-presets', preset, 'qq-tool-restrict.mjs')).href);
  let guard;
  const restricted = [];
  apply({ tools: {
    restrict: ({ deny }) => restricted.push(...deny),
    guard: (callback) => { guard = callback; },
  } });
  assert.equal(typeof guard, 'function');
  assert.ok(restricted.includes('dev_install_package'));
  for (const name of ['ask_user_question', 'todo_write',
    // 梗记忆（dsh-memewiki v2，2026-10-30 主人要求写进 QQ 工具白名单）
    'search_meme_wiki', 'meme_recall', 'meme_feedback', 'meme_remember',
    'mcp__snowluma__qq_send_message',
    'mcp__snowluma-host__snowluma_status', 'mcp__web-search-safe__web_fetch']) {
    assert.equal(guard({ name }), undefined, `${preset}: expected allowed ${name}`);
  }
  // 2026-11-01：subagent_codex 归入「仅主人私聊」——没挂会话时也必须是 fail-closed
  // （把它放进 deny 列表一起断言，防止有人图省事直接加进 SAFE_EXACT）。
  for (const name of ['web_fetch', 'web_search', 'bash', 'read_file', 'subagent_codex', 'dev_future_tool',
    'mcp__untrusted__web_fetch', '', null, undefined]) {
    try { assert.equal(typeof guard({ name }), 'string', `${preset}: must reject ${String(name)}`); }
    catch (error) { failures++; console.error(`FAIL ${error.message}`); }
  }
  console.log(`${preset}: checked allowed tools and denied inherited/local/invalid tools`);
}
// ── state/ 权限收紧（Windows 上 mode 0o600 是空操作，必须动 ACL）的离线守卫 ──────────
// 这里只做"结构 + 编码"级断言：真正的 icacls/UAC 行为在这个环境里跑不了（沙箱禁止改 ACL），
// 而**假装测过**比不测更危险，所以明确只钉住下面这些不会骗人的事实。
import fs from 'node:fs';
{
  const helperPath = path.join(root, 'scripts/harden-state-acl.mjs');
  assert.ok(fs.existsSync(helperPath), 'ACL 收紧助手必须存在（start.bat 依赖它）');
  const helper = fs.readFileSync(helperPath, 'utf8');
  for (const needle of ['icacls', '/inheritance:r', '--elevated', 'isHardened', 'process.exit(0)']) {
    assert.ok(helper.includes(needle), `ACL 助手应包含 ${needle}`);
  }
  // 失败必须降级为非阻断：任何一条 sayAlways/console.log 之后都不得以非 0 退出。
  assert.ok(!/process\.exit\([1-9]/.test(helper), 'ACL 助手不得以非 0 退出码结束（否则会阻断启动）');
  // 提权递归防护：被自己拉起的那一次必须跳过提权重试。
  assert.ok(/!isElevatedRun/.test(helper), '提权重试必须被 --elevated 标记短路，防止递归');

  const bat = fs.readFileSync(path.join(root, 'start.bat'));
  const batText = bat.toString('latin1');
  const nonAscii = [...bat].filter((b) => b > 127).length;
  assert.equal(nonAscii, 0, 'start.bat 必须保持纯 ASCII（否则非 UTF-8 控制台会乱码）');
  assert.equal(batText.match(/(?<!\r)\n/g)?.length ?? 0, 0, 'start.bat 必须使用 CRLF');
  assert.ok(batText.includes('harden-state-acl.mjs'), 'start.bat 必须在启动桥接前调用 ACL 助手');
  // 助手必须排在 node src/bridge.js 之前，否则"启动时收紧"就不成立
  assert.ok(batText.indexOf('harden-state-acl.mjs') < batText.indexOf('node src/bridge.js'), 'ACL 助手必须先于桥接启动');
  console.log('state ACL hardening: helper is non-blocking, recursion-guarded, and wired into start.bat');
}

// ── 合规不变量 L6：本程序**只探测、不部署** SnowLuma ────────────────────────────────
// 依据：SnowLuma EULA §5.4（中文为准）
//   「除事先取得著作权人的书面授权外……不得复制、修改、单独再分发或再许可该组件。
//     将其并入第三方安装包或 Docker 镜像、**通过自动化脚本部署**，或者将其用于任何商业用途，
//     均须事先取得书面授权。」
// 2026-09-20：`start_snowluma` / `stop_snowluma` 与 `snowluma.allowProcessControl` 已整体移除。
// 这条测试**防止它们（或同类能力）被无意加回来**——本项目唯一一条"删掉的功能不许复活"的约束。
{
  const host = fs.readFileSync(path.join(root, 'src/mcp-host-server.js'), 'utf8');
  // ① 代码里不得再出现进程启停原语（注释中为记录原因可以提，故先剔掉纯注释行）
  const code = host.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  for (const bad of ['spawn(', 'taskkill', 'execFileSync', 'child_process']) {
    assert.ok(!code.includes(bad), `mcp-host-server.js 不得再出现「${bad}」（违反 EULA §5.4 的 L6 不变量）`);
  }
  // ② 不得再注册这两个工具
  for (const tool of ['start_snowluma', 'stop_snowluma']) {
    assert.ok(!host.includes(`'${tool}'`), `不得再注册 ${tool}（EULA §5.4）`);
  }
  // ③ 配置项不得复活（代码与模板两侧都查）
  assert.ok(!code.includes('allowProcessControl'), 'mcp-host-server.js 不得再读取 allowProcessControl');
  const example = fs.readFileSync(path.join(root, 'config.example.json'), 'utf8');
  assert.ok(!example.includes('allowProcessControl'), 'config.example.json 不得再提供 allowProcessControl');
  // ④ 只读工具必须还在（别把整个 server 删空）
  assert.ok(host.includes("'snowluma_status'"), 'snowluma_status（只读探活）必须保留');
  // ⑤ 包元数据必须声明许可证（独立复核发现此前缺失）
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT', 'package.json 必须声明 license 字段');
  console.log('L6 compliance: no SnowLuma process control, no allowProcessControl, license declared');
}

// ── 模型审批行（qq-owner-approval）的 fake-ctx 兼容 + 挂载面 ─────────────────────
// 现有测试/其它脚本会直接 apply 一个只有 tools 的假 ctx；审批插件新增了
// ctx.on / ctx.effect / ctx.get('llm')，缺任何一个都必须安全跳过（apply 抛错会让该行
// failed → agent-preset/invalid → QQ 会话建不出来）。
{
  const impl = path.join(root, 'plugins', 'surfcore', 'qq-owner-approval.mjs');
  assert.ok(fs.existsSync(impl), '模型审批插件实现必须存在');
  const mod = await import(pathToFileURL(impl).href);
  assert.equal(mod.name, 'qq-owner-approval');
  assert.deepEqual(mod.inject, ['tools'], 'inject 只保留 tools：llm 必须懒取，否则 llm 缺失会拖垮整个 preset');
  assert.doesNotThrow(() => mod.apply({ tools: {} }), 'fake ctx {tools} 下 apply 不得抛错');
  assert.doesNotThrow(() => mod.apply({}), '空 ctx 下 apply 也不得抛错');

  const listeners = new Map();
  const effects = [];
  const ctx = {
    tools: {},
    on: (event, fn, options) => listeners.set(event, { fn, options }),
    effect: (fn) => effects.push(fn),
    get: () => undefined,
  };
  assert.doesNotThrow(() => mod.apply(ctx));
  assert.ok(listeners.has('tools/pre-execute'), '必须注册 tools/pre-execute（主门）');
  assert.ok(listeners.has('approval/request'), '必须注册 approval/request（领取沙箱升权审批）');
  assert.deepEqual(listeners.get('tools/pre-execute').options, { prepend: true }, 'pre-execute 必须 prepend');
  assert.deepEqual(listeners.get('approval/request').options, { prepend: true }, 'approval/request 必须 prepend');
  assert.equal(effects.length > 0, true, '必须用 ctx.effect 管生命周期');
  // 没有归因也没有 llm 服务：本地工具必须 fail-closed 拒绝，且 reason 非空
  // （DSH 对「空 reason 的 deny」会 fail-open 执行——dsh-scout 最大坑）。
  const pre = listeners.get('tools/pre-execute').fn;
  const decision = await pre({
    name: 'pwsh', arguments: {}, callId: 'c1',
    signal: new AbortController().signal,
    agent: { id: 's1', session: { id: 's1' } },
  }, async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'deny', '无归因/无 llm 时必须 fail-closed');
  assert.equal(typeof decision.reason, 'string');
  assert.ok(decision.reason.length > 0, 'deny 必须带非空 reason');

  const v2 = fs.readFileSync(path.join(root, 'dsh/agent-presets', 'qq-chat-v2/agent.cordis.yml'), 'utf8');
  const v2Prefix = extractPresetPrefix(v2);
  assert.ok(v2Prefix.includes('主人本人触发的回合'), 'qq-chat-v2 正文必须包含新安全不变量「主人本人触发的回合」');
  assert.equal(v2Prefix.includes('只在主人私聊里可用'), false, '旧文案「只在主人私聊里可用」必须被替换（场景已放宽）');
  console.log('qq-owner-approval: fake-ctx compatible, listeners prepended, new safety invariant present');
}

process.exitCode = failures ? 1 : 0;
