// 发送前评审（2026-11-01，surfcore 自己的 reviewer）纯函数 + 编排回归。
// 不启服务、不连 QQ、不调真模型：completeText 全用 fake。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PRESEND_REVIEW_CONFIG,
  buildMemoryCompressSystemPrompt,
  buildReviewPrompt,
  buildReviewScene,
  buildReviewSystemPrompt,
  createMemoryAbstractProvider,
  createPresendReviewer,
  createRejectFallback,
  createReviewThrottle,
  formatReviewRejection,
  memorySourceHash,
  normalizePresendReviewConfig,
  parseReviewVerdict,
  truncateChars,
} from '../src/presend-review.js';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'presend-review-'));

// ── 配置归一化 ──────────────────────────────────────────────────────────────
test('review 配置：默认关闭 + 非法值回落默认（不静默放宽）', () => {
  const def = normalizePresendReviewConfig({});
  assert.equal(def.enabled, false, '只有显式 true 才开');
  assert.equal(def.threshold, 80);
  assert.equal(def.failOpen, true);
  const clamped = normalizePresendReviewConfig({
    enabled: 1, threshold: 0, maxTokens: 99999, timeoutMs: 1,
    sceneMaxChars: 1, memoryMaxChars: 99999, styleMaxChars: -5,
    maxReviews: 0, maxRejects: 99, memoryRefreshMs: 1,
  });
  assert.equal(clamped.enabled, false, 'enabled 必须是布尔 true');
  assert.equal(clamped.threshold, 1);
  assert.equal(clamped.maxTokens, 1200);
  assert.equal(clamped.timeoutMs, 3000);
  assert.equal(clamped.sceneMaxChars, 120);
  assert.equal(clamped.memoryMaxChars, 2000);
  assert.equal(clamped.styleMaxChars, 0);
  assert.equal(clamped.maxReviews, 1);
  assert.equal(clamped.maxRejects, 10);
  assert.equal(clamped.memoryRefreshMs, 60 * 60 * 1000);
  assert.equal(normalizePresendReviewConfig({ failOpen: false }).failOpen, false);
  assert.equal(normalizePresendReviewConfig({}).parseRetries, 1, '解析失败默认重试 1 次');
  assert.equal(normalizePresendReviewConfig({ parseRetries: 9 }).parseRetries, 2);
  assert.equal(normalizePresendReviewConfig({ parseRetries: -3 }).parseRetries, 0);
  assert.equal(normalizePresendReviewConfig({}).rejectFallbackMs, 90000, '退回兜底默认 90s');
  assert.equal(normalizePresendReviewConfig({ rejectFallbackMs: 0 }).rejectFallbackMs, 0, '0=关闭兜底');
  assert.equal(normalizePresendReviewConfig({ rejectFallbackMs: 99999999 }).rejectFallbackMs, 10 * 60 * 1000);
});

test('truncateChars：按 Unicode 字符截断，不切坏 emoji', () => {
  assert.equal(truncateChars('abcdef', 10), 'abcdef');
  assert.equal(truncateChars('abcdef', 3), 'ab…');
  assert.equal(truncateChars('🐟🐟🐟🐟', 2), '🐟…');
  assert.equal(truncateChars('x', 0), '');
});

// ── 情景块 ──────────────────────────────────────────────────────────────────
function sampleRecent() {
  const now = Date.now();
  return [
    { sender: '鱼A', plain: '今天好热啊，谁在摸鱼', time: now - 60000 },
    { isSelf: true, plain: '我在，不过今天只当一条安静的鱼', time: now - 50000 },
    { sender: '管理员', isOwner: true, plain: '长者已经变敏感了吗', time: now - 40000 },
    { sender: '鱼B', plain: '[图片]', time: now - 30000 },
  ];
}

test('情景块：场合头/状态/最近对话都进，且不超预算', () => {
  const scene = buildReviewScene({
    key: 'group:1021716885', kind: 'group', groupName: '摸鱼群', personaName: '甘棠',
    statusLines: ['近10分钟群友发言 12 条', '刚自然收尾过（冷却中），这轮不该主动刷', '第三行会被丢掉'],
    recent: sampleRecent(),
    maxChars: 420,
  });
  assert.ok(scene.text.includes('QQ 群聊「摸鱼群」（group:1021716885）'));
  assert.ok(scene.text.includes('角色：甘棠'));
  assert.ok(scene.text.includes('近10分钟群友发言 12 条'));
  assert.ok(scene.text.includes('【最近对话】'), '最近对话必须在');
  assert.ok(scene.text.includes('长者已经变敏感了吗'), '最新的对话内容要在');
  assert.ok(scene.text.length <= 420, `预算 420，实际 ${scene.text.length}`);
  assert.ok(scene.dialogueLines >= 1 && scene.dialogueLines <= 4);
});

test('情景块：预算极小时优先保场合头，对话从最新往前塞', () => {
  const scene = buildReviewScene({
    key: 'private:3237216875', kind: 'private', personaName: '甘棠',
    statusLines: [], recent: sampleRecent(), maxChars: 150,
  });
  assert.ok(scene.text.includes('QQ 私聊'), '私聊场合头必须保留');
  assert.ok(scene.text.length <= 150);
  if (scene.dialogueLines > 0) assert.ok(scene.text.includes('长者') || scene.text.includes('鱼'), '塞进去的应是最新几条');
});

// ── 评审 prompt ─────────────────────────────────────────────────────────────
test('评审 prompt：分段齐全、预算生效、空段落不出现', () => {
  const prompt = buildReviewPrompt({
    scene: '【场合】QQ 群聊（group:1）',
    memory: '她叫甘棠，是群里的一条鱼。'.repeat(80),
    style: '说话短一点。'.repeat(40),
    messages: ['今天不接这个话题啦', '换个轻松点的'],
    personaName: '甘棠',
    threshold: 80,
    memoryMaxChars: 620,
    styleMaxChars: 140,
  });
  assert.ok(prompt.system.includes('JSON'));
  assert.ok(prompt.system.includes('阈值 80'));
  assert.ok(prompt.user.includes('<场合与状态>'));
  assert.ok(prompt.user.includes('<她的抽象记忆卡>'));
  assert.ok(prompt.user.includes('<她的说话习惯>'));
  assert.ok(prompt.user.includes('<她准备发送的消息'));
  assert.ok(prompt.user.includes('1. 今天不接这个话题啦'));
  assert.ok(prompt.stats.memoryChars <= 620);
  assert.ok(prompt.stats.styleChars <= 140);
  const noEmpty = buildReviewPrompt({ messages: ['嗯嗯'] });
  assert.ok(!noEmpty.user.includes('<她的抽象记忆卡>'), '没有记忆就不该出现空段');
  assert.ok(!noEmpty.user.includes('<她的说话习惯>'));
});

test('评审 system prompt 要求「证据不足从宽」，避免误杀', () => {
  const system = buildReviewSystemPrompt({ personaName: '甘棠', threshold: 80 });
  assert.ok(system.includes('从宽'));
  assert.ok(system.includes('甘棠'));
  assert.ok(buildMemoryCompressSystemPrompt({ maxChars: 620 }).includes('高度抽象'));
});

// ── 评审结果解析 ────────────────────────────────────────────────────────────
test('parseReviewVerdict：合法 JSON / 代码块 / 前后缀都能解析', () => {
  assert.deepEqual(parseReviewVerdict('{"score": 88, "reason": "接住了话题", "fix": ""}'), { score: 88, reason: '接住了话题', fix: '' });
  const fenced = parseReviewVerdict('```json\n{"score": 55, "reason": "重复了", "fix": "压成一句"}\n```');
  assert.equal(fenced.score, 55);
  assert.equal(fenced.fix, '压成一句');
  const noisy = parseReviewVerdict('评分如下：{"score": 92, "reason": "很自然"} 以上。');
  assert.equal(noisy.score, 92);
  assert.equal(noisy.fix, '');
});

test('parseReviewVerdict：越界/非整数/空理由/垃圾全部拒绝', () => {
  assert.equal(parseReviewVerdict(''), null);
  assert.equal(parseReviewVerdict('not json'), null);
  assert.equal(parseReviewVerdict('{"score": 99.9, "reason": "x"}'), null);
  assert.equal(parseReviewVerdict('{"score": "88", "reason": "x"}'), null);
  assert.equal(parseReviewVerdict('{"score": 0, "reason": "x"}'), null);
  assert.equal(parseReviewVerdict('{"score": 101, "reason": "x"}'), null);
  assert.equal(parseReviewVerdict('{"score": 88, "reason": "   "}'), null, '理由不能是空白');
  assert.equal(parseReviewVerdict('{"score": 88}'), null);
});

test('formatReviewRejection：说清没发出去 + 理由 + 改写要求，不提评审机制', () => {
  const text = formatReviewRejection({ verdict: { score: 62, reason: '答非所问', fix: '先回答对方的问题' }, threshold: 80, personaName: '甘棠' });
  assert.ok(text.includes('消息未发送'));
  assert.ok(text.includes('62/100'));
  assert.ok(text.includes('80'));
  assert.ok(text.includes('答非所问'));
  assert.ok(text.includes('先回答对方的问题'));
  assert.ok(text.includes('改写'));
});

// ── 节流 ────────────────────────────────────────────────────────────────────
test('节流：短消息/刚通过/次数上限/cap 的决策矩阵', () => {
  let clock = 1_000_000;
  const throttle = createReviewThrottle({ now: () => clock });
  // reviewWindowMs 最小 60s（clamp），所以窗口过期测试用 70s。
  const cfg = normalizePresendReviewConfig({ enabled: true, minChars: 8, skipAfterPassMs: 1000, maxReviews: 5, maxRejects: 2, reviewWindowMs: 60000 });

  assert.equal(throttle.decide('k', { config: cfg, totalChars: 2, at: clock }).action, 'skip');
  assert.equal(throttle.decide('k', { config: cfg, totalChars: 20, at: clock }).action, 'review');

  throttle.recordPass('k', { at: clock });
  assert.equal(throttle.decide('k', { config: cfg, totalChars: 20, at: clock + 500 }).reason, 'after-pass');
  clock += 2000;
  assert.equal(throttle.decide('k', { config: cfg, totalChars: 20, at: clock }).action, 'review', '冷却过后重新审');

  throttle.recordReject('k', { at: clock });
  assert.equal(throttle.rejectCount('k', { at: clock }), 1);
  assert.equal(throttle.decide('k', { config: cfg, totalChars: 20, at: clock }).action, 'review', '退回 1 次还没到 cap');
  throttle.recordReject('k', { at: clock });
  assert.equal(throttle.decide('k', { config: cfg, totalChars: 20, at: clock }).reason, 'reject-cap', '退回次数达上限后放行');

  clock += 70_000;
  assert.equal(throttle.decide('k', { config: cfg, totalChars: 20, at: clock }).action, 'review', '窗口过期后计数清零');

  // 评审次数上限（maxReviews）单独验
  const capped = createReviewThrottle({ now: () => clock });
  const capCfg = normalizePresendReviewConfig({ enabled: true, minChars: 8, skipAfterPassMs: 0, maxReviews: 5, maxRejects: 2, reviewWindowMs: 60000 });
  capped.recordReject('k', { at: clock });
  capped.recordReject('k', { at: clock });
  assert.equal(capped.decide('k', { config: capCfg, totalChars: 20, at: clock }).reason, 'reject-cap', '先撞 reject cap');
  capped.recordReject('k', { at: clock });
  capped.recordReject('k', { at: clock });
  capped.recordReject('k', { at: clock });
  assert.equal(capped.decide('k', { config: capCfg, totalChars: 20, at: clock }).reason, 'review-cap', 'reviews 达上限后按 review cap 放行');
  throttle.reset();
  assert.equal(throttle.decide('k', { config: cfg, totalChars: 20, at: clock }).action, 'review');
});

// ── 抽象记忆卡：压缩 + 缓存 ─────────────────────────────────────────────────
test('记忆抽象卡：缓存命中不重压、源变/过期才重压、失败回退旧值', async () => {
  const dir = tmpRoot();
  const cachePath = path.join(dir, 'memory-abstract.json');
  const calls = [];
  let source = '记忆卡 v1：她和主人在春天认识。';
  const provider = createMemoryAbstractProvider({
    cachePath,
    readSource: () => source,
    getConfig: () => ({ enabled: true, memoryMaxChars: 40 }),
    completeText: async (opts) => { calls.push(opts); return { text: '抽象摘要 v1' }; },
  });

  assert.equal(await provider.get(), '抽象摘要 v1');
  assert.equal(calls.length, 1);
  assert.equal(await provider.get(), '抽象摘要 v1', '第二次直接读缓存');
  assert.equal(calls.length, 1, '缓存命中不能重复调模型');
  assert.equal(provider.readCache().hash, memorySourceHash(source));

  source = '记忆卡 v2：她后来搬到了群里。';
  assert.equal(await provider.get(), '抽象摘要 v1', '缓存失效时先返回旧摘要（本轮不阻塞）…');
  assert.equal(calls.length, 2, '源变了要重压');
  assert.equal(await provider.get(), '抽象摘要 v1');

  // TTL 过期后重压
  let clock = Date.now() + 13 * 60 * 60 * 1000;
  const ttlProvider = createMemoryAbstractProvider({
    cachePath,
    readSource: () => source,
    getConfig: () => ({ enabled: true, memoryMaxChars: 40, memoryRefreshMs: 12 * 60 * 60 * 1000 }),
    now: () => clock,
    completeText: async () => ({ text: '抽象摘要 v2' }),
  });
  assert.equal(await ttlProvider.get(), '抽象摘要 v2');

  // 压缩失败回退旧缓存
  const failProvider = createMemoryAbstractProvider({
    cachePath,
    readSource: () => '记忆卡 v3',
    getConfig: () => ({ enabled: true, memoryMaxChars: 40 }),
    completeText: async () => { throw new Error('boom'); },
  });
  assert.equal(await failProvider.get(), '抽象摘要 v2', '压缩失败也要回退旧摘要');

  const emptyProvider = createMemoryAbstractProvider({
    cachePath: path.join(dir, 'none.json'),
    readSource: () => '',
    getConfig: () => ({ enabled: true }),
    completeText: async () => ({ text: '不该出现' }),
  });
  assert.equal(await emptyProvider.get(), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── reviewer 编排 ───────────────────────────────────────────────────────────
function reviewerHarness({ verdicts, cfgOverrides = {}, memoryText = '抽象记忆：她是群里的一条鱼。', throwOnce = false }) {
  let i = 0;
  const calls = [];
  const reviewer = createPresendReviewer({
    getConfig: () => ({ enabled: true, threshold: 80, ...cfgOverrides }),
    completeText: async (opts) => {
      calls.push(opts);
      if (throwOnce && calls.length === 1) throw new Error('llm down');
      const next = verdicts[Math.min(i, verdicts.length - 1)];
      i += 1;
      return { text: next, usage: { input_tokens: 10, output_tokens: 5 } };
    },
    memory: { get: async () => memoryText },
    styleFor: () => '说话短、别做汇报。',
    log: () => {},
  });
  return { reviewer, calls };
}

const sceneArgs = {
  key: 'group:1021716885', kind: 'group', messages: ['长者已经变敏感了，这词在群里太烫手'],
  groupName: '摸鱼群', personaName: '甘棠',
  statusLines: ['近10分钟群友发言 6 条'], recent: sampleRecent(),
};

test('reviewer：停用时直接放行，不调模型', async () => {
  const { reviewer, calls } = reviewerHarness({ verdicts: ['{"score": 10, "reason": "x"}'], cfgOverrides: { enabled: false } });
  const result = await reviewer.review(sceneArgs);
  assert.equal(result.allow, true);
  assert.equal(result.skipped, 'disabled');
  assert.equal(calls.length, 0);
});

test('reviewer：通过时放行并记录评分；2 分钟内的后续发送跳过评审', async () => {
  let clock = 1_000_000;
  const controlled = createPresendReviewer({
    getConfig: () => ({ enabled: true, threshold: 80 }),
    completeText: async () => ({ text: '{"score": 91, "reason": "接得自然", "fix": ""}' }),
    memory: { get: async () => '记忆' },
    styleFor: () => '',
    now: () => clock,
  });
  const first = await controlled.review(sceneArgs);
  assert.equal(first.allow, true);
  assert.equal(first.score, 91);
  const second = await controlled.review(sceneArgs);
  assert.equal(second.allow, true);
  assert.equal(second.skipped, 'after-pass');
  clock += 3 * 60 * 1000;
  const third = await controlled.review(sceneArgs);
  assert.equal(third.allow, true);
  assert.equal(third.score, 91, '冷却后重新审');
});

test('reviewer：低于阈值不发，返回可读错误；连续退回达上限后放行', async () => {
  let clock = 1_000_000;
  const controlled = createPresendReviewer({
    getConfig: () => ({ enabled: true, threshold: 80, maxRejects: 2, reviewWindowMs: 600000, skipAfterPassMs: 0 }),
    completeText: async () => ({ text: '{"score": 62, "reason": "答非所问", "fix": "先回答对方的问题"}' }),
    memory: { get: async () => '记忆' },
    styleFor: () => '',
    now: () => clock,
  });
  const first = await controlled.review(sceneArgs);
  assert.equal(first.allow, false);
  assert.equal(first.score, 62);
  assert.ok(first.error.includes('消息未发送'));
  assert.ok(first.error.includes('62/100'));
  clock += 1000;
  const second = await controlled.review(sceneArgs);
  assert.equal(second.allow, false);
  assert.equal(second.attempt, 2);
  clock += 1000;
  const third = await controlled.review(sceneArgs);
  assert.equal(third.allow, true, '超过 maxRejects 后 fail-open 放行，避免消息永远发不出去');
  assert.equal(third.skipped, 'reject-cap');
});

test('reviewer：评审批失败/解析失败默认放行（failOpen），关掉 failOpen 则拦截', async () => {
  const failing = createPresendReviewer({
    getConfig: () => ({ enabled: true, threshold: 80 }),
    completeText: async () => { throw new Error('timeout'); },
    memory: { get: async () => '' },
    styleFor: () => '',
  });
  assert.equal((await failing.review(sceneArgs)).allow, true);
  assert.equal((await failing.review(sceneArgs)).skipped, 'error');

  const garbage = createPresendReviewer({
    getConfig: () => ({ enabled: true, threshold: 80 }),
    completeText: async () => ({ text: '我觉得挺好的，给 95 分' }),
    memory: { get: async () => '' },
    styleFor: () => '',
  });
  assert.equal((await garbage.review(sceneArgs)).allow, true);
  assert.equal((await garbage.review(sceneArgs)).skipped, 'parse-fail');

  const strict = createPresendReviewer({
    getConfig: () => ({ enabled: true, threshold: 80, failOpen: false }),
    completeText: async () => { throw new Error('timeout'); },
    memory: { get: async () => '' },
    styleFor: () => '',
  });
  const strictResult = await strict.review(sceneArgs);
  assert.equal(strictResult.allow, false);
  assert.ok(strictResult.error.includes('评审暂时不可用'));
});

test('reviewer：评审回复不是 JSON 时先重试一次，拿到合法 JSON 就用它', async () => {
  const replies = ['我觉得这条挺好，给 90 分', '{"score": 90, "reason": "接得自然"}'];
  let calls = 0;
  const reviewer = createPresendReviewer({
    getConfig: () => ({ enabled: true, threshold: 80, parseRetries: 1 }),
    completeText: async () => {
      calls += 1;
      return { text: replies[Math.min(calls - 1, replies.length - 1)] };
    },
    memory: { get: async () => '' },
    styleFor: () => '',
  });
  const result = await reviewer.review(sceneArgs);
  assert.equal(result.allow, true);
  assert.equal(result.score, 90);
  assert.equal(calls, 2, '第一次非 JSON、第二次合法 → 共调用两次');

  const noRetry = createPresendReviewer({
    getConfig: () => ({ enabled: true, threshold: 80, parseRetries: 0 }),
    completeText: async () => ({ text: '不是 JSON' }),
    memory: { get: async () => '' },
    styleFor: () => '',
  });
  const skipped = await noRetry.review(sceneArgs);
  assert.equal(skipped.allow, true);
  assert.equal(skipped.skipped, 'parse-fail');
  assert.ok(skipped.raw.includes('不是 JSON'), 'parse-fail 要带原始回复片段便于排障');
});

test('退回兜底：到点补发、cancel 取消、重复退回只更新稿子不延长截止', async () => {
  const timers = [];
  const sends = [];
  const setTimeoutFn = (fn, ms) => { const handle = { fn, ms, cleared: false }; timers.push(handle); return handle; };
  const clearTimeoutFn = (handle) => { if (handle) handle.cleared = true; };
  const fallback = createRejectFallback({
    delayMs: 90000,
    send: async (key, messages) => { sends.push({ key, messages }); },
    setTimeoutFn,
    clearTimeoutFn,
  });
  const first = fallback.schedule('group:1', ['第一版']);
  assert.equal(first.scheduled, true);
  assert.equal(first.delay, 90000);
  assert.equal(timers.length, 1);
  assert.deepEqual(fallback.pendingMessages('group:1'), ['第一版']);

  // 再次被退回：更新稿子，但不新开计时器、不延长截止（防止一直重试一直不发）
  const second = fallback.schedule('group:1', ['第二版']);
  assert.equal(second.updated, true);
  assert.equal(timers.length, 1);
  assert.equal(second.deadline, first.deadline);
  assert.deepEqual(fallback.pendingMessages('group:1'), ['第二版']);

  timers[0].fn();
  await Promise.resolve();
  assert.deepEqual(sends, [{ key: 'group:1', messages: ['第二版'] }], '到点只补发最新退回稿');
  assert.equal(fallback.size(), 0);

  // cancel：有成功重发时不补发
  fallback.schedule('group:2', ['不该发']);
  assert.equal(fallback.cancel('group:2'), true);
  timers[1].fn();
  await Promise.resolve();
  assert.equal(sends.length, 1, '取消后到点也不补发');

  // 0/负数 = 关闭
  assert.equal(fallback.schedule('group:3', ['x'], { delay: 0 }).scheduled, false);
  assert.equal(fallback.schedule('group:3', ['x'], { delay: -1 }).scheduled, false);
  // 空消息不挂
  assert.equal(fallback.schedule('group:4', ['  ']).scheduled, false);

  // dispose 清空
  fallback.schedule('group:5', ['最后一版']);
  assert.equal(fallback.size(), 1);
  fallback.dispose();
  assert.equal(fallback.size(), 0);
});

test('reviewer：短消息不审、prompt 带预算上下文', async () => {
  const calls = [];
  const reviewer = createPresendReviewer({
    getConfig: () => ({ enabled: true, threshold: 80, minChars: 8, memoryMaxChars: 120, styleMaxChars: 60, sceneMaxChars: 200 }),
    completeText: async (opts) => { calls.push(opts); return { text: '{"score": 90, "reason": "ok"}' }; },
    memory: { get: async () => '记忆'.repeat(200) },
    styleFor: () => '风格'.repeat(200),
  });
  const short = await reviewer.review({ ...sceneArgs, messages: ['嗯'] });
  assert.equal(short.allow, true);
  assert.equal(short.skipped, 'too-short');
  assert.equal(calls.length, 0);
  const okResult = await reviewer.review(sceneArgs);
  assert.equal(okResult.allow, true);
  assert.equal(calls.length, 1);
  const promptText = calls[0].user;
  assert.ok(promptText.includes('<场合与状态>'));
  assert.ok(promptText.includes('<她的抽象记忆卡>'));
  assert.ok(promptText.length < 2000, '整体 prompt 不该无限膨胀');
  assert.ok(okResult.context.memoryChars <= 120);
  assert.ok(okResult.context.styleChars <= 60);
});
