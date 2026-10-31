// 场合作用域（2026-10-31 路线 A）纯函数回归：
// 规矩 scope / style-notes 作用域 / 场合档位 / 记忆卡 audience 过滤 / 跨场合发送配置。
// 这些函数是桥接、插件、CLI 共用的唯一实现，必须能离线单测（不启服务、不连 QQ）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIENCE_GROUP_ONLY_TAG, AUDIENCE_PRIVATE_ONLY_TAG, collectRulesForScene,
  crossSceneRateBlocked, filterMemoryCardPromptForScene, filterStyleNotesForScene,
  formatRulesBlock, formatSceneCard, formatStyleNoteLine, isCrossSceneTargetAllowed,
  normalizeCrossSceneSendConfig, normalizeCrossSceneTarget, normalizeRuleScope, normalizeRuleText,
  parseStyleNoteLine, resolveSceneProfile, ruleScopeAppliesTo, styleNoteAppliesTo,
} from '../src/scene-scope.js';
import { normalizeCard, renderMemoryCard } from '../src/memory-card.js';

const PRIVATE = 'private:123';
const GROUP = 'group:456';

// ── 规矩 scope ──────────────────────────────────────────────────────────────
test('规矩 scope：别名与 here 解析', () => {
  assert.equal(normalizeRuleScope('global'), 'global');
  assert.equal(normalizeRuleScope('all'), 'global');
  assert.equal(normalizeRuleScope('全局'), 'global');
  assert.equal(normalizeRuleScope(''), 'global', '不写 scope 默认全局（旧行为）');
  assert.equal(normalizeRuleScope('private'), 'private');
  assert.equal(normalizeRuleScope('私聊'), 'private');
  assert.equal(normalizeRuleScope('group'), 'group');
  assert.equal(normalizeRuleScope('群'), 'group');
  assert.equal(normalizeRuleScope('group:123'), 'group:123');
  assert.equal(normalizeRuleScope('group：123'), 'group:123', '中文冒号也认');
  assert.equal(normalizeRuleScope('here', { key: PRIVATE }), 'private');
  assert.equal(normalizeRuleScope('here', { key: GROUP }), 'group:456');
  assert.equal(normalizeRuleScope('bogus'), null, '不认识的 scope 必须拒绝，不能静默回落');
  assert.equal(normalizeRuleScope('group:0'), null);
});

test('规矩 scope：生效范围矩阵（私聊/群/指定群）', () => {
  assert.equal(ruleScopeAppliesTo('global', GROUP), true);
  assert.equal(ruleScopeAppliesTo('global', PRIVATE), true);
  assert.equal(ruleScopeAppliesTo('private', PRIVATE), true);
  assert.equal(ruleScopeAppliesTo('private', GROUP), false);
  assert.equal(ruleScopeAppliesTo('group', GROUP), true);
  assert.equal(ruleScopeAppliesTo('group', PRIVATE), false);
  assert.equal(ruleScopeAppliesTo('group:456', GROUP), true);
  assert.equal(ruleScopeAppliesTo('group:999', GROUP), false);
  assert.equal(ruleScopeAppliesTo('group:999', PRIVATE), false);
  assert.equal(ruleScopeAppliesTo('global', ''), true, '没有 key（控制台预览）不过滤');
});

test('规矩注入：本会话 + 跨会话 global，但 private/group:<id> 不跨场合', () => {
  const current = [
    { text: '别叫管理员', scope: 'global' },
    { text: '私聊里可以放开一点', scope: 'private' },
    { text: '本群别发路径', scope: 'group:456' },
  ];
  const otherSets = [
    { key: PRIVATE, rules: [{ text: '别叫管理员', scope: 'global' }, { text: '只私聊能说的话', scope: 'private' }] },
    { key: 'group:999', rules: [{ text: '别的群的规矩', scope: 'group:999' }, { text: '群里别发路径（全局版）', scope: 'global' }] },
  ];
  const forGroup = collectRulesForScene(current, otherSets, GROUP);
  assert.ok(forGroup.lines.some((l) => l.includes('别叫管理员') && l.includes('（全局）')));
  assert.ok(!forGroup.lines.some((l) => l.includes('私聊里可以放开一点')), 'private 规矩不能进群');
  assert.ok(forGroup.lines.some((l) => l.includes('本群别发路径') && l.includes('（仅本群）')));
  assert.deepEqual(forGroup.sharedLines, ['- 群里别发路径（全局版）（全局规矩，另一个场合定下的）'], '只跨场合共享 global，且本会话已有的去重');
  const forPrivate = collectRulesForScene(current, otherSets, PRIVATE);
  assert.ok(forPrivate.lines.some((l) => l.includes('私聊里可以放开一点') && l.includes('（仅私聊）')));
  assert.ok(!forPrivate.lines.some((l) => l.includes('本群别发路径')), 'group:<id> 规矩不能进私聊');
  assert.ok(forPrivate.sharedLines.some((l) => l.includes('群里别发路径（全局版）')));
  const block = formatRulesBlock(current, otherSets, GROUP);
  assert.ok(block.startsWith('【记下的规矩（按场合生效）】'));
  assert.ok(block.includes('（全局）'));
});

test('规矩文本归一化：多行压一行并截断', () => {
  assert.equal(normalizeRuleText('  别用\n括号  '), '别用 括号');
  assert.equal(normalizeRuleText('x'.repeat(300)).length, 200);
});

// ── style-notes 作用域 ──────────────────────────────────────────────────────
test('style-notes：旧格式（无前缀）按全局解析', () => {
  const parsed = parseStyleNoteLine('- 2026-10-29 说话短一点');
  assert.deepEqual({ ...parsed, raw: undefined }, { text: '说话短一点', scope: 'global', date: '2026-10-29', raw: undefined });
});

test('style-notes：作用域前缀解析（全局/私聊/群/指定群）', () => {
  assert.equal(parseStyleNoteLine('- 2026-10-29 [私聊] 私聊里放开').scope, 'private');
  assert.equal(parseStyleNoteLine('- 2026-10-29 [群] 群里别发路径').scope, 'group');
  assert.equal(parseStyleNoteLine('- 2026-10-29 [群:123] 这个群正经点').scope, 'group:123');
  assert.equal(parseStyleNoteLine('- [群:123] 没有日期也行').scope, 'group:123');
  assert.equal(parseStyleNoteLine('- 2026-10-29 [不是作用域] 保留原文').scope, 'global', '不认识的方括号不吞文本');
  assert.equal(parseStyleNoteLine('随便一行'), null);
});

test('style-notes：按场合过滤（群看不到私聊条，反之亦然）', () => {
  const lines = [
    '- 2026-10-29 全局条',
    '- 2026-10-29 [私聊] 私聊条',
    '- 2026-10-29 [群] 群条',
    '- 2026-10-29 [群:456] 本群条',
    '- 2026-10-29 [群:999] 别的群条',
  ];
  const forGroup = filterStyleNotesForScene(lines, GROUP);
  assert.deepEqual(forGroup, ['- 2026-10-29 全局条', '- 2026-10-29 [群] 群条', '- 2026-10-29 [群:456] 本群条']);
  const forPrivate = filterStyleNotesForScene(lines, PRIVATE);
  assert.deepEqual(forPrivate, ['- 2026-10-29 全局条', '- 2026-10-29 [私聊] 私聊条']);
  assert.equal(filterStyleNotesForScene(lines, '').length, 5, '无 key = 不过滤（控制台预览）');
  assert.equal(styleNoteAppliesTo('private', GROUP), false);
});

test('style-notes：写入格式带中文作用域标签', () => {
  assert.equal(formatStyleNoteLine({ scope: 'global', date: '2026-11-01', text: '全局条' }), '- 2026-11-01 [全局] 全局条');
  assert.equal(formatStyleNoteLine({ scope: 'private', date: '2026-11-01', text: '私聊条' }), '- 2026-11-01 [私聊] 私聊条');
  assert.equal(formatStyleNoteLine({ scope: 'group:123', date: '2026-11-01', text: '群条' }), '- 2026-11-01 [群:123] 群条');
  // 写出去的行必须能被自己解析回来（往返一致）
  const line = formatStyleNoteLine({ scope: 'group:456', date: '2026-11-01', text: '往返' });
  assert.equal(parseStyleNoteLine(line).scope, 'group:456');
});

// ── 场合档位 ────────────────────────────────────────────────────────────────
test('场合档位：默认私聊/群聊 + overrides 覆盖', () => {
  const scenes = {
    defaultPrivate: { label: '私聊', toneHint: '放松一点' },
    defaultGroup: { label: '群聊', memoryGuard: true },
    overrides: { [GROUP]: { label: '工作群' } },
  };
  const p = resolveSceneProfile(PRIVATE, scenes);
  assert.equal(p.kind, 'private');
  assert.equal(p.label, '私聊');
  assert.equal(p.toneHint, '放松一点');
  assert.equal(p.memoryGuard, false, '私聊默认不守群边界');
  const g = resolveSceneProfile(GROUP, scenes);
  assert.equal(g.kind, 'group');
  assert.equal(g.label, '工作群', 'overrides 生效');
  assert.equal(g.memoryGuard, true);
  const g2 = resolveSceneProfile('group:999', scenes);
  assert.equal(g2.label, '群聊', '别的群回落默认群聊档位');
  assert.equal(g2.memoryGuard, true);
});

test('场合卡：说清楚在哪种场合 + 群边界提示', () => {
  const group = formatSceneCard(resolveSceneProfile(GROUP, {}), { groupName: '测试群' });
  assert.ok(group.includes('【场合】'));
  assert.ok(group.includes('群聊「测试群」'));
  assert.ok(group.includes(GROUP));
  assert.ok(group.includes('群里不要主动提'), '群聊默认带私聊边界提示');
  const priv = formatSceneCard(resolveSceneProfile(PRIVATE, {}), {});
  assert.ok(priv.includes('私聊'));
  assert.ok(priv.includes('群里刚才'), '私聊里提群里的事要先交代来源');
  assert.ok(!priv.includes('群里的场合不要主动提'), '私聊不该发群边界提示');
});

// ── 记忆卡 audience 过滤 ────────────────────────────────────────────────────
test('记忆卡：audience 标记渲染 + 按场合过滤', () => {
  const card = normalizeCard({
    meta: {},
    stats: {},
    records: [
      { text: '群和私聊都能看的事', source: 'qq-owner', private: false, conversationKey: GROUP, createdAt: '2026-10-31T00:00:00.000Z', importance: 60 },
      { text: '只在私聊看的事', source: 'qq-owner', private: true, conversationKey: PRIVATE, audience: 'private-only', createdAt: '2026-10-31T00:00:00.000Z', importance: 60 },
      { text: '只在群里看的事', source: 'qq-group', private: false, conversationKey: GROUP, audience: 'group-only', createdAt: '2026-10-31T00:00:00.000Z', importance: 60 },
    ],
  });
  const rendered = renderMemoryCard(card, { platform: 'qq', maxChars: 20000, config: {} });
  assert.ok(rendered.includes(AUDIENCE_PRIVATE_ONLY_TAG), 'private-only 记录要带可见性标记');
  assert.ok(rendered.includes(AUDIENCE_GROUP_ONLY_TAG), 'group-only 记录要带可见性标记');

  const forGroup = filterMemoryCardPromptForScene(rendered, GROUP);
  assert.ok(forGroup.includes('群和私聊都能看的事'), '默认记忆共同：private 记录也进群');
  assert.ok(forGroup.includes('只在群里看的事'));
  assert.ok(!forGroup.includes('只在私聊看的事'), 'private-only 记录不得进群提示词');
  const forPrivate = filterMemoryCardPromptForScene(rendered, PRIVATE);
  assert.ok(forPrivate.includes('只在私聊看的事'));
  assert.ok(!forPrivate.includes('只在群里看的事'), 'group-only 记录不得进私聊提示词');

  // 硬开关：群聊连 [私聊] 记录也一起过滤（默认关，保持「记忆共同」）
  const hard = filterMemoryCardPromptForScene(rendered, GROUP, { groupExcludePrivate: true });
  assert.ok(!hard.includes('只在私聊看的事'));
  assert.ok(!hard.split('\n').some((line) => /^\s*-\s/.test(line) && line.includes('[私聊]')), 'groupExcludePrivate 应滤掉 [私聊] 条目行');
});

// ── 跨场合发送配置 ─────────────────────────────────────────────────────────
test('跨场合发送配置：默认关、目标规范化、白名单判定、频率', () => {
  const off = normalizeCrossSceneSendConfig(null);
  assert.equal(off.enabled, false);
  assert.deepEqual(off.allowTargets, []);
  assert.equal(off.maxPerHour, 6);
  assert.equal(off.maxChars, 200);
  assert.equal(normalizeCrossSceneTarget('456'), 'group:456');
  assert.equal(normalizeCrossSceneTarget('group:456'), 'group:456');
  assert.equal(normalizeCrossSceneTarget('private:456'), '', '只允许私聊→群，目标是私聊时拒绝');
  assert.equal(normalizeCrossSceneTarget('群456'), '');

  const cfg = normalizeCrossSceneSendConfig({ enabled: true, allowTargets: ['456', 'group:789', 'bad'], maxPerHour: 999, maxChars: 9999 });
  assert.deepEqual(cfg.allowTargets, ['group:456', 'group:789']);
  assert.equal(cfg.maxPerHour, 60, '上限收敛到 60');
  assert.equal(cfg.maxChars, 500, '上限收敛到 500');
  assert.equal(isCrossSceneTargetAllowed(cfg, 'group:456'), true);
  assert.equal(isCrossSceneTargetAllowed(cfg, 'group:999'), false);
  assert.equal(isCrossSceneTargetAllowed({ enabled: false, allowTargets: ['group:456'] }, 'group:456'), false, '总开关关掉就一律拒绝');

  const now = 1_000_000;
  assert.equal(crossSceneRateBlocked([now - 1000, now - 2000], now, 3), false);
  assert.equal(crossSceneRateBlocked([now - 1000, now - 2000, now - 3000], now, 3), true);
  assert.equal(crossSceneRateBlocked([now - 2 * 60 * 60 * 1000], now, 1), false, '只算最近一小时');
});
