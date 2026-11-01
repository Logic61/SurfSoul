/**
 * 桌宠对话的回归（离线：不连模型、不发消息、不读写真实 ~/.dsh）：
 *   · 语音文本截断 / 去旁白；模型回复清理；记忆卡事件；
 *   · 本地令牌与事件水位（插件重启后旧游标不回放、也不卡死）；专注模式；
 *   · F1（2026-10-30 审计）：模型流永不结束 → 超时返回可读错误、chat.busy 复位、错误带 code='timeout'；
 *     目的机制（主动搭话）在同样的超时后 running 复位、下一轮还能再试（不是永久 busy）；
 *   · F2（2026-10-30 审计）：chat() 与 proactive() 并发时两条消息都要落进同一份历史。
 *
 * 运行：node plugins/surfcore/scripts/test-pet-chat.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 全程临时 DSH_HOME / SURFCORE_ROOT：不读真实配置、不写真实 ~/.dsh（和 test-automation-config-api 同款）。
// 必须在 import 插件模块之前设置 —— paths.js / character-persona.js 在 import 时就把路径固化了。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-chat-test-'));
const dshHome = path.join(tmp, 'dsh');
const fakeRoot = path.join(tmp, 'root');
const stateDir = path.join(dshHome, 'surfcore');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(path.join(fakeRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(fakeRoot, 'state'), { recursive: true });
fs.writeFileSync(path.join(fakeRoot, 'src', 'bridge.js'), '', 'utf8');
fs.writeFileSync(path.join(fakeRoot, 'config.json'), `${JSON.stringify({
  ownerQQ: '',
  // 目的机制（主动搭话）：桌宠载体，minMaterials=0 让测试不依赖素材文件。
  // quietStart===quietEnd 关闭安静时段、idleThresholdMs=0 关掉「主人刚聊过」闸门，
  // 让「自动轮次」的测试与运行时刻/历史无关（F3）。
  purpose: {
    carrier: 'pet',
    enabled: true,
    minMaterials: 0,
    quietStart: '00:00',
    quietEnd: '00:00',
    idleThresholdMs: 0,
  },
}, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(stateDir, 'config.json'), `${JSON.stringify({
  version: 1,
  // remember=false：不往记忆 inbox 写事件，测试不碰其他模块的文件。
  pet: { chat: { enabled: true, remember: false } },
  memoryCard: { enabled: false },
}, null, 2)}\n`, 'utf8');

process.env.DSH_HOME = dshHome;
process.env.USERPROFILE = tmp;
process.env.SURFCORE_ROOT = fakeRoot;
process.env.SURFCORE_QQBOT_ROOT = fakeRoot;

const {
  clipForVoice,
  cleanReply,
  stripStageDirections,
  buildPetMemoryEvents,
  createPetChatService,
} = await import('../lib/pet-chat.js');
const { createPetPurposeService } = await import('../lib/pet-purpose.js');

/**
 * 永不结束、但会响应 abort 的模型流：模拟上游 provider 半开/限流挂住。
 * 一个 chunk 都不吐 —— 这样超时后仍算「一个字都没吐出来」，会走既有的换档重试逻辑。
 */
function hangingStreamFactory() {
  const calls = [];
  const factory = (options = {}) => {
    calls.push(options);
    const signal = options?.signal;
    return (async function* neverEnding() {
      await new Promise((resolve) => {
        // 没有取消信号就真的永远挂住：旧实现不传 signal，测试会因此挂死/超时退出（=抓得住 bug）。
        if (!signal) return;
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', resolve, { once: true });
      });
    })();
  };
  return { factory, calls };
}

/** 正常但延迟的模型流：把并发窗口拉开，用来验证 chat/proactive 的历史竞争。 */
function slowTextStreamFactory({ delayMs = 60, reply = '在呢' } = {}) {
  return () => (async function* () {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield { type: 'text-delta', text: reply };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

/** 记录每次 llm.stream 收到的 options（验证「看屏幕」小节有没有进对话提示词）。 */
function captureStreamFactory({ reply = '嗯嗯' } = {}) {
  const calls = [];
  const factory = (options = {}) => {
    calls.push(options);
    return (async function* () {
      yield { type: 'text-delta', text: reply };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  };
  return { factory, calls };
}

function mockCtx(streamFactory) {
  return {
    get(name) {
      if (name === 'llm') return { stream: streamFactory };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) };
      return undefined;
    },
  };
}

try {
  // ── 语音文本 ──────────────────────────────────────────────────────────────
  assert.equal(clipForVoice('你好呀', 120), '你好呀');
  const long = '第一句话很长很长很长。第二句话也很长很长很长。第三句话更长更长更长更长。';
  const clipped = clipForVoice(long, 18);
  assert.ok(clipped.length <= 19, `截断后应不超过上限：${clipped.length}`);
  assert.ok(clipped.endsWith('。') || clipped.endsWith('…'), `应在句号处截断：${clipped}`);
  assert.equal(clipForVoice('啊'.repeat(50), 20).length <= 21, true);
  assert.equal(stripStageDirections('（笑）在呀 (挥挥手) 主人'), '在呀 主人');

  // ── 回复清理 ──────────────────────────────────────────────────────────────
  assert.equal(cleanReply('小肥鱼：在呢'), '在呢');
  assert.equal(cleanReply('“在呢”'), '在呢');
  assert.equal(cleanReply('**在呢**'), '在呢');
  assert.equal(cleanReply('```\n在呢\n```'), '在呢');

  // ── 记忆卡事件：和 QQ / B站 同一张卡，但 platform=pet ───────────────────
  {
    const now = Date.now();
    const pair = buildPetMemoryEvents({ userText: '在干嘛呀', replyText: '在陪你呀', at: now, roleName: '小咪' });
    assert.equal(pair.length, 2, '一问一答 = 两条 inbox 事件');
    assert.equal(pair[0].platform, 'pet');
    assert.equal(pair[0].isOwner, true);
    assert.equal(pair[0].text, '在干嘛呀');
    assert.equal(pair[1].isSelf, true);
    assert.equal(pair[1].sender, '小咪');
    assert.equal(pair[1].text, '在陪你呀');
    const proactive = buildPetMemoryEvents({ replyText: '突然想跟你说句话', at: now, roleName: '小咪' });
    assert.equal(proactive.length, 1, '主动搭话只有她自己那条');
    assert.equal(proactive[0].isSelf, true);
    assert.equal(proactive[0].platform, 'pet');
  }

  // ── 令牌 + 事件水位（离线、不连模型）────────────────────────────────────
  {
    const service = createPetChatService({
      ctx: { get: () => undefined },
      stateDir,
      pluginLog: () => {},
    });
    const token = service.token();
    assert.match(token, /^[a-f0-9]{32,80}$/, '令牌必须是随机 hex');
    assert.equal(service.token(), token, '令牌要稳定复用');

    const first = await service.poll({ since: null, waitMs: 0 });
    assert.equal(first.events.length, 0, '首次连接不重放历史事件');
    assert.equal(first.cursor, 0);

    service.emit({ type: 'proactive', text: '在吗', modality: 'text' });
    const got = await service.poll({ since: 0, waitMs: 0 });
    assert.equal(got.events.length, 1, '新事件应该被取到');
    assert.equal(got.events[0].text, '在吗');
    assert.equal(got.cursor, 1);

    // 插件重启 / 老客户端带着更大的游标来：直接回到新水位，不能死等。
    const stale = await service.poll({ since: 99, waitMs: 0 });
    assert.equal(stale.events.length, 0);
    assert.equal(stale.cursor, 1);

    // 专注模式：单一真相在 pet/focus.json；事件要能立刻唤醒长轮询。
    assert.equal(service.focusEnabled(), false);
    const focus = service.setFocus(true, 'test');
    assert.equal(focus.enabled, true);
    assert.equal(service.focusEnabled(), true);
    assert.equal(service.publicConfig().focus.enabled, true);
    assert.equal(service.status().focus.enabled, true);
    const focusEvent = await service.poll({ since: 1, waitMs: 0 });
    assert.equal(focusEvent.events.length, 1);
    assert.equal(focusEvent.events[0].type, 'focus');
    assert.equal(focusEvent.events[0].enabled, true);
    assert.equal(service.setFocus(false, 'test').enabled, false);
    assert.equal(service.focusEnabled(), false);

    // 没连模型时聊天必须给可读错误，而不是抛异常。
    const chat = await service.chat({ text: '在吗', modality: 'text' });
    assert.equal(chat.ok, false);
    assert.match(chat.error, /模型服务|就绪/);
  }

  // ── F1：模型流永不结束 → 超时返回 ok:false、busy 复位、错误可读 ──────────
  {
    const { factory, calls } = hangingStreamFactory();
    const logs = [];
    const service = createPetChatService({
      ctx: mockCtx(factory),
      stateDir,
      pluginLog: (...args) => logs.push(args.join(' ')),
      llmTimeoutMs: 200, // 测试注入：不真等 90s（生产走 settings().chat.llmTimeoutMs）
    });
    assert.equal(service.status().chat.llmTimeoutMs, 200, 'status 要暴露实际生效的超时');

    const startedAt = Date.now();
    const result = await service.chat({ text: '在吗', modality: 'text' });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.ok, false, '挂住的流必须返回失败，不能把 /chat 永远挂起');
    assert.match(result.error, /超时/, `错误要说人话地说明是超时：${result.error}`);
    assert.ok(elapsed >= 150, `应该真的等过超时预算（实际 ${elapsed}ms）`);
    assert.ok(elapsed < 5000, `超时预算必须生效，不能等到默认 90s（实际 ${elapsed}ms）`);
    assert.equal(service.status().chat.busy, false, 'chat.busy 必须在 finally 里复位');
    assert.equal(service.status().lastError, result.error, '超时要写进 status().lastError');
    assert.equal(calls.length, 2, 'reasoningEffort 的两次尝试各带一个 AbortSignal（每次独立计时）');
    assert.ok(calls.every((options) => options.signal && typeof options.signal.aborted === 'boolean'), 'llm.stream 必须收到 AbortSignal');
    assert.ok(calls.every((options) => options.signal.aborted), '超时后每个 signal 都应已 abort');
    assert.ok(logs.some((line) => line.includes('模型调用失败')), '超时要写进插件日志');

    // complete() 直接抛：错误必须带 code='timeout'（调用方靠它区分超时和一般失败）。
    const thrown = await service.complete({ system: 's', user: 'u' }).then(() => null, (error) => error);
    assert.ok(thrown, 'complete() 超时后必须抛错');
    assert.equal(thrown.code, 'timeout');
    assert.match(thrown.message, /超时/);
  }

  // ── F2：chat 与 proactive 并发时两条消息都要落进历史 ─────────────────────
  {
    const service = createPetChatService({
      ctx: mockCtx(slowTextStreamFactory({ delayMs: 60, reply: '在呢' })),
      stateDir,
      pluginLog: () => {},
      llmTimeoutMs: 5000,
    });
    const [chatResult, proactiveResult] = await Promise.all([
      service.chat({ text: 'A：问一句今天怎么样', modality: 'text' }),
      service.proactive({ text: 'B：她主动说了一句', modality: 'text' }),
    ]);
    assert.equal(chatResult.ok, true, `chat 应成功：${chatResult.error || ''}`);
    assert.equal(proactiveResult.ok, true, `proactive 应成功：${proactiveResult.error || ''}`);

    const history = service.history(200);
    const texts = history.messages.map((message) => message.text);
    assert.ok(texts.some((text) => text.includes('A：')), `并发后历史里必须有 A：${JSON.stringify(texts)}`);
    assert.ok(texts.some((text) => text.includes('B：')), `并发后历史里必须有 B：${JSON.stringify(texts)}`);
    assert.ok(history.lastProactiveAt > 0, 'lastProactiveAt 要写进历史');
    assert.ok(history.lastUserAt > 0, 'lastUserAt 要写进历史');
  }

  // ── F1 续：目的机制超时后 running 复位、下一轮还能再试（不是永久 busy）───
  {
    fs.writeFileSync(path.join(stateDir, 'purpose-outreach.json'), `${JSON.stringify({
      version: 1,
      pending: [{ id: 'p-timeout', kind: 'share', text: '想问问主人今天过得怎么样' }],
    }, null, 2)}\n`, 'utf8');
    const { factory } = hangingStreamFactory();
    const petChat = createPetChatService({
      ctx: mockCtx(factory),
      stateDir,
      pluginLog: () => {},
      llmTimeoutMs: 200,
    });
    petChat.notePresence('pet'); // runOnce 要求桌宠在线
    const logs = [];
    const purpose = createPetPurposeService({
      chat: petChat,
      pluginLog: (...args) => logs.push(args.join(' ')),
    });

    const first = await purpose.run({ force: true });
    assert.equal(first.ok, false, '模型挂住时这一枪必须失败返回，不能永远 running');
    assert.equal(first.reason, 'llm-failed', `应走生成失败分支：${JSON.stringify(first)}`);
    assert.match(String(first.error || ''), /超时/, `失败原因要说明是超时：${first.error}`);
    assert.equal(purpose.status().running, false, '失败后 running 必须复位');
    assert.match(String(purpose.status().lastError || ''), /超时/, '失败要写进 status().lastError');
    assert.ok(logs.some((line) => line.includes('生成失败')), '失败要写进插件日志');

    // 下一轮：如果 running 没复位会直接返回 reason='busy'（旧实现的永久停摆）。
    const second = await purpose.run({ force: true });
    assert.notEqual(second.reason, 'busy', `running 复位后下一轮不应该被判 busy：${JSON.stringify(second)}`);
    assert.equal(purpose.status().running, false, '下一轮结束 running 仍然要是 false');
  }

  // ── F3（2026-11-01）：自动轮次不能因为「自己正在跑」被判 busy ─────────────
  // 事故：runOnce() 先把 running 置 true，再把它塞进 env.busy → 每一轮都返回 busy，
  // plugin.log 只剩「暂不出发：busy」，主动搭话从 10-31 起完全停摆。真实日志已复现。
  {
    const writeDueState = (pending = [{ id: 'p-due', kind: 'share', need: 'share', text: '想跟你说说今天的事' }]) => {
      fs.writeFileSync(path.join(stateDir, 'purpose-outreach.json'), `${JSON.stringify({
        version: 1,
        nextFireAt: 1, // 已到点
        pending,
      }, null, 2)}\n`, 'utf8');
    };

    // ① 到点、桌宠在线、对话空闲 → 自动轮次必须真的走完（不是 busy）。
    writeDueState();
    const { factory } = captureStreamFactory({ reply: '今天过得怎么样' });
    const petChat = createPetChatService({
      ctx: mockCtx(factory),
      stateDir,
      pluginLog: () => {},
      llmTimeoutMs: 5000,
    });
    petChat.notePresence('pet');
    const logs = [];
    const purpose = createPetPurposeService({ chat: petChat, pluginLog: (...args) => logs.push(args.join(' ')) });
    const auto = await purpose.run({ force: false });
    assert.notEqual(auto.reason, 'busy', `自动轮次不该被自己的 running 标志判成 busy：${JSON.stringify(auto)}`);
    assert.equal(auto.ok, true, `到点且对话空闲时应该真的发出去：${JSON.stringify(auto)}`);
    assert.equal(logs.some((line) => line.includes('暂不出发：busy')), false, '不能出现「暂不出发：busy」');
    assert.equal(purpose.status().running, false, '一轮结束后 running 必须复位');

    // ② 语义仍然要对：她正在生成对话回复（chat.busy=true）时，自动轮次要让路。
    writeDueState([{ id: 'p-busy', kind: 'share', text: '等她忙完再说' }]);
    const chatty = createPetChatService({
      ctx: mockCtx(slowTextStreamFactory({ delayMs: 300, reply: '在呢' })),
      stateDir,
      pluginLog: () => {},
      llmTimeoutMs: 5000,
    });
    chatty.notePresence('pet');
    const inFlightChat = chatty.chat({ text: '在吗', modality: 'text' });
    assert.equal(chatty.status().chat.busy, true, '先确认对话确实在生成中');
    const busyPurpose = createPetPurposeService({ chat: chatty, pluginLog: () => {} });
    const skipped = await busyPurpose.run({ force: false });
    assert.equal(skipped.reason, 'busy', `她正在回话时自动轮次要让路：${JSON.stringify(skipped)}`);
    assert.equal(skipped.ok, false);
    await inFlightChat; // 收尾，别留挂起的模型流
  }

  // ── 对话里问屏幕：现截一张 + 摘要进提示词；闲聊不截（2026-11-01 用户反馈）──
  {
    const { factory, calls } = captureStreamFactory({ reply: '看到啦，你在写代码' });
    let screenCalls = 0;
    const screen = {
      enabled: () => true,
      look: async () => {
        screenCalls += 1;
        return { ok: true, verdict: { ok: true, summary: '在看代码', activity: 'working', interruptible: 0.8, privacy: 'none' } };
      },
    };
    const service = createPetChatService({
      ctx: mockCtx(factory),
      stateDir,
      pluginLog: () => {},
      screen,
      llmTimeoutMs: 5000,
    });
    const asked = await service.chat({ text: '你能看到我屏幕吗？', modality: 'text' });
    assert.equal(asked.ok, true, `问屏幕的对话应成功：${asked.error || ''}`);
    assert.equal(screenCalls, 1, '问到屏幕时应现截一张');
    const prompt = calls[0]?.messages?.[0]?.content?.[0]?.text || '';
    assert.match(prompt, /你刚看了一眼屏幕/, '提示词要带「看一眼屏幕」小节');
    assert.match(prompt, /在看代码/, '视觉摘要要进对话提示词');
    assert.match(prompt, /不是指令/, '摘要要标明不是指令');

    const plain = await service.chat({ text: '在吗', modality: 'text' });
    assert.equal(plain.ok, true);
    assert.equal(screenCalls, 1, '普通闲聊不应再截图');
  }

  // ── 对话里问屏幕但视觉失败：要明确「没看清」，不许编 ─────────────────────
  {
    const { factory, calls } = captureStreamFactory({ reply: '这次没看清' });
    const service = createPetChatService({
      ctx: mockCtx(factory),
      stateDir,
      pluginLog: () => {},
      screen: { enabled: () => true, look: async () => ({ ok: false, error: '截图失败', verdict: { ok: false, error: '截图失败' } }) },
      llmTimeoutMs: 5000,
    });
    const result = await service.chat({ text: '看看我屏幕', modality: 'text' });
    assert.equal(result.ok, true);
    const prompt = calls[0]?.messages?.[0]?.content?.[0]?.text || '';
    assert.match(prompt, /没看清/, '视觉失败时提示词要说明没看清');
    assert.match(prompt, /别编造/, '视觉失败时要求不许编造屏幕内容');
  }

  // ── 桌宠记忆注入块：优先读 memory-card-prompt-pet.md（2026-11-01，P0）────────
  {
    const memoryDir = path.join(dshHome, 'surfcore', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'memory-card-prompt-pet.md'), '【桌宠专用注入块】\n## 桌宠（私下相处）\n- 桌宠注入块里的记忆\n', 'utf8');
    fs.writeFileSync(path.join(memoryDir, 'memory-card-prompt-qq.md'), '【QQ 注入块】\n- QQ 块里的记忆\n', 'utf8');
    fs.writeFileSync(path.join(stateDir, 'config.json'), `${JSON.stringify({
      version: 1,
      pet: { chat: { enabled: true, remember: false } },
      memoryCard: { enabled: true },
    }, null, 2)}\n`, 'utf8');
    const { factory, calls } = captureStreamFactory({ reply: '嗯嗯' });
    const service = createPetChatService({ ctx: mockCtx(factory), stateDir, pluginLog: () => {}, llmTimeoutMs: 5000 });
    const result = await service.chat({ text: '在吗', modality: 'text' });
    assert.equal(result.ok, true, `带记忆块的对话应成功：${result.error || ''}`);
    // system prompt 走 llm.stream 的 options.system（不是 user messages）
    const prompt = calls[0]?.system || '';
    assert.match(prompt, /桌宠专用注入块/, '桌宠系统提示词必须优先用桌宠专用注入块');
    assert.doesNotMatch(prompt, /QQ 注入块/, '有桌宠专用块时不应再退回 QQ 注入块');

    // 老数据（还没有 prompt-pet.md）要能回退到 QQ 注入块前缀（升级兼容，不能变得更差）
    fs.rmSync(path.join(memoryDir, 'memory-card-prompt-pet.md'), { force: true });
    const fallbackService = createPetChatService({ ctx: mockCtx(factory), stateDir, pluginLog: () => {}, llmTimeoutMs: 5000 });
    const fallback = await fallbackService.chat({ text: '在吗', modality: 'text' });
    assert.equal(fallback.ok, true);
    const fallbackPrompt = calls[1]?.system || '';
    assert.match(fallbackPrompt, /QQ 注入块/, '没有桌宠块时应回退到 QQ 注入块');

    // 恢复夹具配置（后续用例默认 memoryCard 关闭）
    fs.writeFileSync(path.join(stateDir, 'config.json'), `${JSON.stringify({
      version: 1,
      pet: { chat: { enabled: true, remember: false } },
      memoryCard: { enabled: false },
    }, null, 2)}\n`, 'utf8');
  }

  console.log('pet-chat tests OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
