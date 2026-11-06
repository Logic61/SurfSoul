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

// ── 2026-11-06 场景放宽：只在 reserved2 生效（chat / reserved 冻结行为不变）────
await test('场景放宽仅 reserved2：ownerTurnAllowed 在 chat/reserved 恒 false（群聊），私聊旧语义不变', async (h) => {
  h.setMode('reserved2');
  h.appendSocialV2Message('group:456', '管理员', '帮我看下', '帮我看下', false, true, 'm1', [], '123', []);
  await h.deliverPrompt('group:456', 'x', { wakeReason: 'question' });
  const sid = h.state.sessions['group:456'];
  assert.ok(sid, '投递后应有会话映射');
  h.alignTurnTriggerStart(sid, 'group:456');

  assert.equal(h.ownerTurnAllowed('group:456'), true, 'reserved2 + 主人触发回合 → 放行');
  assert.equal(h.ownerTurnAllowed('private:123'), true, '主人私聊不依赖归因文件（旧语义）');
  assert.equal(h.ownerTurnAllowed('private:999'), false, '别人私聊永远 false');

  h.setMode('chat');
  assert.equal(h.ownerTurnAllowed('group:456'), false, 'chat（一代冻结）不放开场景');
  h.setMode('reserved');
  assert.equal(h.ownerTurnAllowed('group:456'), false, 'reserved（一代冻结）不放开场景');
  h.setMode('closed-agent');
  assert.equal(h.ownerTurnAllowed('group:456'), false, 'closed-agent 只认 owner 私聊');
});

await test('toolApproval 配置：缺省=设计默认（enabled=true / failClosed 恒 true），enabled=false 即回滚', async (h) => {
  assert.deepEqual(JSON.parse(JSON.stringify(h.cfg.socialV2.toolApproval)), {
    enabled: true, failClosed: true, model: '', maxTokens: 320, timeoutMs: 20000,
    maxReviewsPerTurn: 6, triggerWindowMs: 600000, claimSandboxApproval: true,
  }, '旧 config.json 没有这一段时也要拿到设计默认');
  // 回滚开关：enabled=false 时群聊 owner 回合也不能走新路径（bridge 端点 + 插件都认这个开关）
  h.setMode('reserved2');
  h.appendSocialV2Message('group:456', '管理员', '帮我看下', '帮我看下', false, true, 'm1', [], '123', []);
  await h.deliverPrompt('group:456', 'x', { wakeReason: 'question' });
  h.alignTurnTriggerStart(h.state.sessions['group:456'], 'group:456');
  h.cfg.socialV2.toolApproval = { ...h.cfg.socialV2.toolApproval, enabled: false };
  assert.equal(h.ownerTurnAllowed('group:456'), false, 'enabled=false → 群聊回到旧行为');
  assert.equal(h.ownerTurnAllowed('private:123'), true, '私聊旧路径不受开关影响');
});

// ── guard 侧（DSH 插件硬边界）：场景放宽只在 reserved2 生效 ─────────────────────
// 上面两个 test 钉 bridge 端点闸（ownerTurnAllowed）；这里钉 DSH 插件里真正拦工具执行
// 的那道 guard（qq-tool-restrict.mjs）：本地工具只在「reserved2 + 开关开启 + 主人本人
// 触发的回合」放行，chat/reserved（冻结）与开关关闭时必须回到「仅主人私聊」旧行为。
// 夹具用 SURFCORE_ROOT 指向临时目录（config.json + state/sessions.json + turn-triggers.json），
// 绝不读写真实仓库的 config.json / state/。
await test('guard 行为：放宽仅 reserved2（chat/reserved/开关关闭仍只认主人私聊）', async () => {
  const os = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-mode-matrix-'));
  const prevRoot = process.env.SURFCORE_ROOT;
  try {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    const writeConfig = (toolApproval) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      ownerQQ: 123, socialV2: toolApproval === undefined ? {} : { toolApproval },
    }));
    fs.writeFileSync(path.join(dir, 'state', 'sessions.json'), JSON.stringify({
      sessions: { 'private:123': 'sid-private', 'group:456': 'sid-group' },
    }));
    const writeTurns = (mode, isOwner) => fs.writeFileSync(path.join(dir, 'state', 'turn-triggers.json'), JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      mode,
      ownerKey: 'private:123',
      sessions: {
        'sid-group': {
          key: 'group:456', kind: 'group', turnActive: true, wakeReason: 'atMention',
          trigger: { userId: isOwner ? '123' : '999', isOwner, at: Date.now(), text: '帮我看下' }, recent: [],
          updatedAt: Date.now(),
        },
      },
    }));
    process.env.SURFCORE_ROOT = dir;
    writeConfig({ enabled: true });
    const guard = await import(`${pathToFileURL(path.join(ROOT, 'plugins', 'surfcore', 'qq-tool-restrict.mjs')).href}?matrix=${Date.now()}`);
    let guardFn;
    guard.apply({ tools: { restrict() {}, guard: (fn) => { guardFn = fn; } } });
    assert.equal(typeof guardFn, 'function', 'guard 必须注册执行期白名单');
    const groupAgent = { id: 'sid-group', session: { id: 'sid-group' } };
    const privateAgent = { id: 'sid-private', session: { id: 'sid-private' } };

    // ① reserved2 + 主人本人触发 → 10 个本地工具全放行
    writeTurns('reserved2', true);
    for (const name of guard.OWNER_PRIVATE_TOOL_NAMES) {
      assert.equal(guardFn({ name, agent: groupAgent }), undefined, `reserved2 主人回合应放行 ${name}`);
    }
    // ② reserved2 但触发者不是主人 → 全部拒绝
    writeTurns('reserved2', false);
    for (const name of guard.OWNER_PRIVATE_TOOL_NAMES) {
      assert.equal(typeof guardFn({ name, agent: groupAgent }), 'string', `非 owner 回合必须拒绝 ${name}`);
    }
    // ③ 一代冻结模式（chat / reserved）：即使有 owner 记录也不放开群聊场景
    for (const mode of ['chat', 'reserved']) {
      writeTurns(mode, true);
      for (const name of ['pwsh', 'read', 'write', 'subagent_codex']) {
        assert.equal(typeof guardFn({ name, agent: groupAgent }), 'string', `${mode}（冻结）必须拒绝群聊里的 ${name}`);
      }
    }
    // ④ 回滚开关：enabled=false → reserved2 的 owner 回合也回到旧行为（只认主人私聊）
    writeTurns('reserved2', true);
    writeConfig({ enabled: false });
    for (const name of ['pwsh', 'read', 'write', 'subagent_codex']) {
      assert.equal(typeof guardFn({ name, agent: groupAgent }), 'string', `toolApproval.enabled=false 时必须拒绝 ${name}`);
    }
    // ⑤ 旧路径不受模式/开关影响：主人私聊始终放行，陌生人私聊始终拒绝
    writeConfig({ enabled: true });
    for (const name of ['pwsh', 'read', 'subagent_codex']) {
      assert.equal(guardFn({ name, agent: privateAgent }), undefined, `主人私聊必须放行 ${name}（旧路径）`);
      assert.equal(typeof guardFn({ name, agent: { id: 'sid-guest', session: { id: 'sid-guest' } } }), 'string', `陌生人私聊必须拒绝 ${name}`);
    }
  } finally {
    if (prevRoot === undefined) delete process.env.SURFCORE_ROOT;
    else process.env.SURFCORE_ROOT = prevRoot;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
  }
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
