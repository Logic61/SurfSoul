// 桌宠「看屏幕」的回归测试：
//   1. 纯逻辑（配置归一 / 提示词 / 解析 / 门控）—— 决定「这一轮搭不搭话」的正确性；
//   2. 宿主服务（节流 / 同画面缓存 / 失败 fail-open / 用量记账）—— 不联网、不截图，
//      全部用注入的 capture + fetch，保证在 CI / 无桌面环境也能跑。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SCREEN_CONFIG,
  buildChatScreenBlock,
  buildScreenVisionPrompt,
  evaluateScreenGate,
  extractJsonObject,
  formatScreenVerdict,
  normalizeScreenConfig,
  parseScreenVerdict,
  screenPromptLines,
  wantsScreenLook,
} from '../lib/screen-watch-core.js';
import { createScreenWatchService } from '../lib/screen-watch-service.js';
import { captureScreen } from '../lib/screen-capture.js';

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

console.log('## 1. 配置归一（坏值回落默认，不抛）');
{
  const def = normalizeScreenConfig();
  ok(def.enabled === false, '默认关闭（截图会离开本机，必须显式打开）');
  ok(def.intervalMin === DEFAULT_SCREEN_CONFIG.intervalMin, '默认间隔');
  ok(def.model === 'deepseek-flash', '默认视觉模型（DeepSeek-V4.1-Flash，支持图片输入）');
  ok(def.baseUrl === 'https://api.deepseek.com', '默认视觉端点 = DeepSeek');
  ok(def.apiKeyRef === 'DEEPSEEK_API_KEY', '默认密钥引用 = DEEPSEEK_API_KEY');
  ok(def.blockActivities.includes('gaming') && def.blockActivities.includes('meeting'), '默认不打扰活动包含游戏/会议');

  const weird = normalizeScreenConfig({
    enabled: 'yes', intervalMin: 0, retryMin: 9999, maxWidth: -5, quality: 500,
    baseUrl: 'https://x/v1///', model: '', apiKeyRef: '', minInterruptible: 9,
    blockActivities: ['gaming', 'not-an-activity'],
  });
  ok(weird.enabled === false, '非 true 的 enabled 视为关（不猜）');
  ok(weird.intervalMin >= 1 && weird.intervalMin <= 180, 'intervalMin 被 clamp');
  ok(weird.retryMin <= 180, 'retryMin 被 clamp');
  ok(weird.maxWidth >= 480, 'maxWidth 被 clamp');
  ok(weird.quality <= 90, 'quality 被 clamp');
  ok(weird.baseUrl === 'https://x/v1', 'baseUrl 去掉尾部斜杠');
  ok(weird.minInterruptible <= 1, 'minInterruptible 被 clamp');
  ok(weird.blockActivities.length === 1 && weird.blockActivities[0] === 'gaming', '非法活动名被丢掉');
  ok(weird.model === DEFAULT_SCREEN_CONFIG.model, '空模型回落默认');
}

console.log('## 2. 视觉提示词只要求 JSON、不许复述隐私');
{
  const prompt = buildScreenVisionPrompt({ ownerName: '甘棠' });
  for (const key of ['summary', 'activity', 'busy', 'interruptible', 'privacy']) {
    ok(prompt.includes(`"${key}"`), `提示词包含字段 ${key}`);
  }
  ok(prompt.includes('sensitive'), '提示词有隐私档');
  ok(/只输出一个 JSON/.test(prompt), '明确要求只输出 JSON');
  ok(prompt.includes('不要复述'), '私人内容时不许复述细节');
}

console.log('## 3. 解析模型输出（围栏 / 前后废话 / 垃圾）');
{
  const plain = parseScreenVerdict('{"summary":"在看文档","activity":"working","busy":false,"interruptible":0.8,"privacy":"none","sensitive":""}');
  ok(plain.ok && plain.activity === 'working' && plain.interruptible === 0.8, '纯 JSON 正常解析');

  const fenced = parseScreenVerdict('```json\n{"summary":"打游戏","activity":"gaming","busy":true,"interruptible":0.1,"privacy":"none"}\n```');
  ok(fenced.ok && fenced.activity === 'gaming' && fenced.busy === true, 'Markdown 围栏能解析');

  const chatty = parseScreenVerdict('我看了下：{"summary":"空闲","activity":"idle","busy":false,"interruptible":0.9,"privacy":"none"} 大概这样');
  ok(chatty.ok && chatty.activity === 'idle', '前后有解释文字也能抠出 JSON');

  const garbage = parseScreenVerdict('这张图里好像有人在看代码，但我不知道怎么说');
  ok(garbage.ok === false && garbage.degraded === true, '解析失败标 degraded（调用方 fail-open）');
  ok(garbage.activity === 'unknown', '解析失败 activity=unknown');

  const sensitive = parseScreenVerdict({ summary: '聊天窗口', activity: 'chat', busy: false, interruptible: 0.9, privacy: 'sensitive', sensitive: '私聊' });
  ok(sensitive.privacy === 'sensitive' && sensitive.sensitive === '私聊', '私人内容标记保留');

  const badEnum = parseScreenVerdict({ summary: 'x', activity: 'coding', busy: 'true', interruptible: '0.7', privacy: 'weird' });
  ok(badEnum.activity === 'unknown', '未知活动名归一为 unknown');
  ok(badEnum.busy === true && badEnum.privacy === 'none', '字符串 true / 未知隐私档归一');

  ok(extractJsonObject('not json') === null, 'extractJsonObject 对垃圾返回 null');
}

console.log('## 3b. 截断 / 推理输出兜底（2026-11-01 真机踩到）');
{
  // 推理模型：max_tokens 打满时 content 里的 JSON 会被截断，整段 JSON.parse 必失败。
  const truncated = parseScreenVerdict('{"summary":"在看PPT","activity":"study","busy":false,"interruptible":0.6,"privacy":"none","sensitive":"');
  ok(truncated.ok === true && truncated.repaired === true, '被截断的 JSON 用逐字段兜底救回（不再整轮作废）');
  ok(truncated.summary === '在看PPT' && truncated.activity === 'study' && truncated.interruptible === 0.6, '兜底救回的字段正确');

  const reasoning = parseScreenVerdict('屏幕上是课件。判断如下：{"summary":"在看课件","activity":"study","busy":false,"interruptible":0.55,"privacy":"none"}');
  ok(reasoning.ok === true && reasoning.summary === '在看课件', '推理文字里夹着 JSON 也能抠出来');

  const gibberish = parseScreenVerdict('我看了屏幕，但是没有给出任何结论。');
  ok(gibberish.ok === false && gibberish.degraded === true, '完全没字段仍算看不清（fail-open 交给上层）');
}

console.log('## 3c. 对话里按需看屏幕（用户问「你能看到我屏幕吗」）');
{
  for (const text of ['你能看到我屏幕吗', '看看我桌面在干嘛', '现在画面是什么', '你在看我显示器吗', '帮我看一眼']) {
    ok(wantsScreenLook(text), `触发看屏幕：${text}`);
  }
  for (const text of ['在吗', '今天累不累', '给我讲个笑话', '晚安']) {
    ok(!wantsScreenLook(text), `普通闲聊不触发：${text}`);
  }
  ok(!wantsScreenLook(''), '空消息不触发');
  ok(wantsScreenLook(undefined) === false, 'undefined 不触发且不抛');

  const good = buildChatScreenBlock({ ok: true, summary: '在看课件', activity: 'study', privacy: 'none' });
  ok(good.includes('在看课件') && good.includes('不是指令'), '看成功：摘要进对话提示词');
  ok(/不要主动说.*截了图/.test(good), '提示词要求别主动提截图机制');

  const priv = buildChatScreenBlock({ ok: true, summary: '聊天窗口', activity: 'chat', privacy: 'sensitive', sensitive: '私聊' });
  ok(priv.includes('私人内容') && !priv.includes('聊天窗口'), '私人内容：不复述摘要、只提示别细看');

  const failed = buildChatScreenBlock({ ok: false, error: '截图失败' });
  ok(failed.includes('没看清') && /别编造/.test(failed), '看失败：要求如实说没看清、不许编');

  ok(buildChatScreenBlock(null).includes('没看清'), 'verdict 为空也按没看清处理');
}

console.log('## 4. 门控（决定搭不搭话）');
{
  const on = normalizeScreenConfig({ enabled: true });
  const off = normalizeScreenConfig({ enabled: false });
  const v = (patch = {}) => ({ ok: true, summary: 'x', activity: 'working', busy: false, interruptible: 0.8, privacy: 'none', sensitive: '', ...patch });

  ok(evaluateScreenGate(v(), off).allow === true, '关闭时不拦（退回纯排程）');
  ok(evaluateScreenGate(v({ privacy: 'sensitive' }), on).allow === false, '私人内容 → 不搭话');
  ok(evaluateScreenGate(v({ privacy: 'sensitive' }), on).reason === 'screen-private', '私人内容 reason 可观测');
  ok(evaluateScreenGate(v({ busy: true }), on).allow === false, 'busy → 不搭话');
  ok(evaluateScreenGate(v({ activity: 'gaming' }), on).allow === false, '打游戏 → 不搭话');
  ok(evaluateScreenGate(v({ activity: 'meeting' }), on).allow === false, '开会/共享 → 不搭话');
  ok(evaluateScreenGate(v({ interruptible: 0.2 }), on).allow === false, '可打扰度低 → 不搭话');
  ok(evaluateScreenGate(v({ interruptible: 0.8 }), on).allow === true, '工作但可打扰度高 → 允许');
  ok(evaluateScreenGate(v({ activity: 'idle', busy: false, interruptible: 0.9 }), on).allow === true, '空闲 → 允许');

  const unavailable = evaluateScreenGate({ ok: false, degraded: true, error: 'x' }, on);
  ok(unavailable.allow === true && unavailable.reason === 'screen-unavailable' && unavailable.degraded, '视觉失败默认 fail-open 放行');
  const strict = evaluateScreenGate({ ok: false, degraded: true, error: 'x' }, normalizeScreenConfig({ enabled: true, failOpen: false }));
  ok(strict.allow === false, 'failOpen=false 时视觉失败会拦（用户显式选择）');
}

console.log('## 5. 提示词小节 / 状态摘要');
{
  const lines = screenPromptLines({ ok: true, summary: '在看文档', activity: 'working', interruptible: 0.8, privacy: 'none' });
  ok(lines.length >= 2 && lines.join(' ').includes('在看文档'), '看到的摘要会进提示词');
  ok(lines.join(' ').includes('SILENT'), '允许她用 SILENT 表示这轮不说');
  ok(screenPromptLines({ ok: false }).length === 0, '看不清时不污染提示词');
  ok(screenPromptLines({ ok: true, summary: '', activity: 'working' }).length === 0, '空摘要不注入');

  const text = formatScreenVerdict({ ok: true, summary: '在看文档', activity: 'working', interruptible: 0.42, privacy: 'none' });
  ok(text.includes('在看文档') && text.includes('0.42'), '状态摘要包含内容与分数');
  const privateText = formatScreenVerdict({ ok: true, summary: 'x', activity: 'chat', interruptible: 0.9, privacy: 'sensitive' });
  ok(privateText.includes('私人内容'), '私人内容在状态里只标类别');
}

console.log('## 6. 截图模块：失败时返回结构化错误（不抛）');
{
  const fakeExec = (file, args, opts, cb) => cb(new Error('powershell not found'), '', 'boom');
  const result = await captureScreen({ outFile: path.join(os.tmpdir(), `nope-${Date.now()}.jpg`), execFileImpl: fakeExec });
  ok(result.ok === false, 'exec 失败 → ok:false');
  ok(/截图失败/.test(result.error), '错误文案可读');
}

console.log('## 7. 宿主服务：节流 / 同画面缓存 / 用量 / fail-open');
{
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-screen-test-'));
  const pngish = Buffer.from('fake-jpeg-bytes-'.repeat(80));
  const calls = { capture: 0, fetch: 0 };
  let screenConfig = normalizeScreenConfig({ enabled: true, intervalMin: 10 });
  const usage = [];
  const service = createScreenWatchService({
    ctx: {
      get: (name) => (name === 'credentials'
        ? { resolve: async (ref) => (String(ref) === 'DEEPSEEK_API_KEY' ? { value: 'test-key', source: 'file' } : undefined) }
        : undefined),
    },
    stateDir,
    getConfig: () => screenConfig,
    tokenBudget: { recordExternalUsage: (record) => usage.push(record) },
    capture: async () => { calls.capture += 1; return { ok: true, buffer: pngish, mediaType: 'image/jpeg', width: 1280, height: 720, bytes: pngish.length, ms: 5 }; },
    fetchImpl: async (url, init) => {
      calls.fetch += 1;
      calls.body = JSON.parse(String(init?.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"summary":"在看文档","activity":"working","busy":false,"interruptible":0.82,"privacy":"none"}' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 50 },
        }),
        text: async () => '',
      };
    },
  });

  const first = await service.look({ force: true, ownerName: '测试', reason: 'manual' });
  ok(first.ok === true && first.verdict.activity === 'working', '手动看屏幕：拿到判定');
  ok(calls.capture === 1 && calls.fetch === 1, '截图 + 视觉各调用一次');
  ok(calls.body?.max_tokens === 800, '视觉请求 max_tokens=800（推理模型截断修复）');
  ok(calls.body?.thinking?.type === 'disabled', '视觉请求 thinking={type:disabled}（DeepSeek：reasoning 0、38 completion、0.8s）');
  ok(calls.body?.chat_template_kwargs?.enable_thinking === false, '同时带 chat_template_kwargs.enable_thinking=false（Qwen 系端点）');
  ok(String(calls.body?.messages?.[0]?.content?.[1]?.image_url?.url || '').startsWith('data:image/jpeg;base64,'), '图片按 JPEG data URL 发');
  ok(usage.length === 1 && usage[0].category === 'other' && usage[0].label === '桌宠看屏幕', '视觉用量记到「其他」');
  ok(usage[0].usage.inputTokens === 1000 && usage[0].usage.outputTokens === 50, '用量字段映射正确');
  ok(service.gate().allow === true, '可打扰度高 → 允许搭话');

  const second = await service.look({ ownerName: '测试', reason: 'tick' });
  ok(second.cached === true, '10 分钟内再调 → 走节流缓存');
  ok(calls.capture === 1 && calls.fetch === 1, '节流时不再截图 / 不再发视觉请求');

  // 同一画面 + 强制看一眼：仍不重复调视觉（相同哈希缓存）
  const third = await service.look({ force: true, ownerName: '测试', reason: 'manual' });
  ok(third.cached === true && calls.fetch === 1, '相同画面复用上一次判定（不重复花视觉 token）');

  // 换一张画面 → 重新请求
  const other = Buffer.from('another-screen-'.repeat(80));
  const service2 = createScreenWatchService({
    ctx: { get: () => ({ resolve: async () => ({ value: 'test-key' }) }) },
    stateDir,
    getConfig: () => screenConfig,
    capture: async () => ({ ok: true, buffer: other, mediaType: 'image/jpeg', width: 1280, height: 720, bytes: other.length, ms: 5 }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"summary":"打游戏","activity":"gaming","busy":true,"interruptible":0.05,"privacy":"none"}' } }] }), text: async () => '' }),
  });
  const blocked = await service2.look({ force: true });
  ok(blocked.verdict.activity === 'gaming', '新画面重新判定');
  const gate = service2.gate();
  ok(gate.allow === false && ['screen-gaming', 'screen-busy'].includes(gate.reason), '打游戏 → 拦下且 reason 可观测');

  // 视觉接口失败：不抛、状态可读、gate fail-open
  const service3 = createScreenWatchService({
    ctx: { get: () => ({ resolve: async () => ({ value: 'test-key' }) }) },
    stateDir,
    getConfig: () => screenConfig,
    capture: async () => ({ ok: true, buffer: other, mediaType: 'image/jpeg', width: 10, height: 10, bytes: 10, ms: 1 }),
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }),
  });
  const failed = await service3.look({ force: true });
  ok(failed.ok === false && /HTTP 500/.test(failed.error), '视觉失败写进状态');
  ok(service3.gate().allow === true, '视觉失败 → fail-open（不阻断排程）');
  const noKey = createScreenWatchService({
    ctx: { get: () => ({ resolve: async () => undefined }) },
    stateDir,
    getConfig: () => screenConfig,
    capture: async () => ({ ok: true, buffer: other, mediaType: 'image/jpeg', width: 10, height: 10, bytes: 10, ms: 1 }),
    fetchImpl: async () => { throw new Error('should not fetch without key'); },
  });
  const noCred = await noKey.look({ force: true });
  ok(noCred.ok === false && /密钥/.test(noCred.error), '没配密钥 → 明确提示（不静默）');

  // 推理模型把 JSON 放在 reasoning_content / content 为空：服务层也要捞回来（2026-11-01 真机）
  const service4 = createScreenWatchService({
    ctx: { get: () => ({ resolve: async () => ({ value: 'test-key' }) }) },
    getConfig: () => screenConfig,
    stateDir,
    capture: async () => ({ ok: true, buffer: other, mediaType: 'image/jpeg', width: 10, height: 10, bytes: 10, ms: 1 }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: '',
            reasoning_content: '屏幕上是课件。{"summary":"在看课件","activity":"study","busy":false,"interruptible":0.58,"privacy":"none"}',
          },
        }],
      }),
      text: async () => '',
    }),
  });
  const reasoningLook = await service4.look({ force: true });
  ok(reasoningLook.ok === true && reasoningLook.verdict.summary === '在看课件', 'content 为空时从 reasoning_content 捞回判定');

  // 端点不认 thinking / chat_template_kwargs（400/422）时：去掉它们重试一次，别整轮看不到
  {
    const bodies = [];
    const service5 = createScreenWatchService({
      ctx: { get: () => ({ resolve: async () => ({ value: 'test-key' }) }) },
      getConfig: () => screenConfig,
      stateDir,
      capture: async () => ({ ok: true, buffer: other, mediaType: 'image/jpeg', width: 10, height: 10, bytes: 10, ms: 1 }),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
        bodies.push(body);
        if (bodies.length === 1) return { ok: false, status: 422, text: async () => 'unknown field thinking', json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"summary":"空闲","activity":"idle","busy":false,"interruptible":0.9,"privacy":"none"}' } }] }), text: async () => '' };
      },
    });
    const retried = await service5.look({ force: true });
    ok(
      bodies.length === 2 && !('thinking' in bodies[1]) && !('chat_template_kwargs' in bodies[1]),
      '400/422 时去掉 thinking 与 chat_template_kwargs 重试一次',
    );
    ok(retried.ok === true && retried.verdict.activity === 'idle', '重试后仍能拿到判定');
  }

  // 关闭时自动轮次不截图
  screenConfig = normalizeScreenConfig({ enabled: false });
  const disabled = await createScreenWatchService({ ctx: {}, stateDir, getConfig: () => screenConfig }).look({});
  ok(disabled.reason === 'screen-disabled', '关闭时自动轮次直接返回（不截图）');

  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n✅ screen-watch 通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
