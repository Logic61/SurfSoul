/**
 * SurfCore · 桌宠「看屏幕」服务（宿主侧）
 *
 * 数据流（全部在本机插件进程里）：
 *   截图（PowerShell/System.Drawing）→ JPEG bytes → 视觉模型（OpenAI 兼容 HTTP）
 *   → 一个 JSON 判定（在干什么 / 可打扰度 / 有没有私人内容）→ 决定这一轮要不要搭话
 *
 * 三条硬约定：
 *   1. **默认关闭**：截图会离开本机（发给用户配置的视觉端点），必须用户显式打开；
 *   2. **失败 fail-open**：截图/视觉任何一步失败，都当作「没看见」，不阻断原有排程；
 *   3. **不落盘**：截图读完即删（`keepScreenshots` 仅排障用），日志里只写分数/活动，
 *      不写画面内容；判定为私人内容时连摘要都不会进提示词。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readQqConfig } from './store.js';
import { captureScreen } from './screen-capture.js';
import {
  DEFAULT_SCREEN_CONFIG,
  buildScreenVisionPrompt,
  evaluateScreenGate,
  formatScreenVerdict,
  intervalMs,
  normalizeScreenConfig,
  parseScreenVerdict,
  retryMs,
} from './screen-watch-core.js';

const ONE_MINUTE = 60_000;

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return '';
}

function usageOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = Number(raw.prompt_tokens ?? raw.input_tokens ?? raw.inputTokens) || 0;
  const output = Number(raw.completion_tokens ?? raw.output_tokens ?? raw.outputTokens) || 0;
  if (!input && !output) return null;
  return { inputTokens: input, outputTokens: output };
}

/**
 * @param {object} opts
 * @param {object} opts.ctx              Cordis host context（查 credentials）
 * @param {string} opts.stateDir         ~/.dsh/surfcore
 * @param {(msg:string, ...args:any[])=>void} [opts.pluginLog]
 * @param {object} [opts.tokenBudget]    每日额度服务（可选）
 * @param {Function} [opts.capture]      测试注入：captureScreen
 * @param {Function} [opts.fetchImpl]    测试注入：fetch
 * @param {Function} [opts.getConfig]    测试注入：返回原始 screen 配置（默认从 store 读）
 */
export function createScreenWatchService({
  ctx,
  stateDir,
  pluginLog = () => {},
  tokenBudget = null,
  capture = captureScreen,
  fetchImpl = null,
  getConfig = null,
} = {}) {
  const screenDir = path.join(stateDir, 'pet', 'screen');
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (...args) => fetch(...args);

  let last = null;
  let lastError = '';
  let lastErrorAt = 0;
  let inFlight = null;

  function config() {
    let raw = {};
    try {
      raw = typeof getConfig === 'function' ? getConfig() : (readQqConfig()?.config?.purpose?.screen ?? {});
    } catch { raw = {}; }
    return normalizeScreenConfig(raw);
  }

  function enabled() {
    return config().enabled === true;
  }

  async function resolveApiKey(ref) {
    const name = String(ref || '').trim();
    if (!name) return '';
    try {
      const credentials = ctx?.get?.('credentials');
      if (credentials?.resolve) {
        const hit = await credentials.resolve(name);
        if (hit?.value) return String(hit.value);
      }
    } catch {}
    const fromEnv = process.env[name];
    return fromEnv ? String(fromEnv) : '';
  }

  function recordUsage(cfg, usage, ms) {
    if (!usage || !tokenBudget?.recordExternalUsage) return;
    try {
      tokenBudget.recordExternalUsage({
        category: 'other',
        sessionId: 'pet-screen',
        model: cfg.model,
        usage,
        at: Date.now(),
        label: '桌宠看屏幕',
      });
    } catch (error) {
      pluginLog('[pet-screen] 记录 token 用量失败：', String(error?.message ?? error).slice(0, 120));
    }
    if (ms) pluginLog(`[pet-screen] 视觉调用 ${ms}ms，${usage.inputTokens}+${usage.outputTokens} tokens`);
  }

  async function visionLook(buffer, cfg, ownerName) {
    const key = await resolveApiKey(cfg.apiKeyRef);
    if (!key) {
      const error = new Error(`没有配置视觉模型密钥（${cfg.apiKeyRef}）：在 DSH 凭据里配一个就能用`);
      error.code = 'no-credential';
      throw error;
    }
    const started = Date.now();
    const body = {
      model: cfg.model,
      temperature: 0.1,
      // 320 太小：推理模型会先说一段 reasoning 再吐 JSON，真机实测恰好打满 320 时
      // JSON 被截断（2026-11-01 旧端点）→ 给 800 留余量。
      max_tokens: 800,
      // 别把预算烧在推理上（2026-11-01 真机实测）：
      //   · DeepSeek（deepseek-flash）：thinking:{type:'disabled'} → reasoning 0、38 completion tokens、0.8s；
      //     不传时 reasoning 能吃掉 499~800 tokens，甚至打满 800 让 content 为空。
      //   · Qwen 系兼容端点：chat_template_kwargs.enable_thinking=false → 直接吐 JSON，快 ~4 倍。
      // 两个参数一起发，各家忽略/不认识对方那个；严格的端点若 400/422 会去掉它们重试一次。
      thinking: { type: 'disabled' },
      chat_template_kwargs: { enable_thinking: false },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildScreenVisionPrompt({ ownerName }) },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` } },
        ],
      }],
    };
    const send = (payload) => doFetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    let response = await send(body);
    // 不太标准的兼容端点可能不认 thinking / chat_template_kwargs（400/422）：去掉再试一次，别整轮看不到。
    if (!response.ok && (response.status === 400 || response.status === 422)) {
      const { thinking: _thinking, chat_template_kwargs: _tw, ...fallbackBody } = body;
      response = await send(fallbackBody);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = new Error(`视觉接口 HTTP ${response.status}${text ? `：${text.slice(0, 120)}` : ''}`);
      error.code = 'vision-http';
      throw error;
    }
    const payload = await response.json();
    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    const text = textOfContent(choice?.message?.content);
    let verdict = parseScreenVerdict(text);
    // 推理模型偶尔把内容放在 reasoning_content（或 content 为空）：再解析一次，
    // 能捞到字段就别整轮作废（仍按 degraded 标记，提示词照用摘要）。
    if (verdict.ok !== true) {
      const reasoning = textOfContent(choice?.message?.reasoning_content ?? choice?.message?.reasoning);
      if (reasoning) verdict = parseScreenVerdict(reasoning);
    }
    if (verdict.ok !== true) {
      const finish = String(choice?.finish_reason ?? payload?.choices?.[0]?.finish_reason ?? '');
      verdict.error = `视觉模型没有返回可解析的 JSON${finish ? `（finish=${finish}）` : ''}`;
    }
    const usage = usageOf(payload?.usage);
    recordUsage(cfg, usage, Date.now() - started);
    return { verdict, ms: Date.now() - started, usage, model: cfg.model };
  }

  function noteError(message) {
    lastError = String(message ?? '').slice(0, 240);
    const now = Date.now();
    // 视觉/截图失败不刷屏：同一类错误 10 分钟内只记一次。
    if (now - lastErrorAt > 10 * ONE_MINUTE) {
      lastErrorAt = now;
      pluginLog('[pet-screen] 看屏幕失败（按 fail-open 继续）：', lastError);
    }
  }

  /**
   * 看一眼屏幕（带节流 + 相同画面缓存）。
   * @param {{force?:boolean, ownerName?:string, reason?:string}} [options]
   */
  async function look({ force = false, ownerName = '', reason = 'tick' } = {}) {
    const cfg = config();
    if (!cfg.enabled && force !== true) return { ok: false, reason: 'screen-disabled', verdict: null, at: 0 };
    const now = Date.now();
    if (force !== true && last && now - last.at < intervalMs(cfg)) {
      return { ...last, cached: true };
    }
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const started = Date.now();
      try {
        fs.mkdirSync(screenDir, { recursive: true });
        const captured = await capture({
          outFile: path.join(screenDir, `shot-${started}.jpg`),
          maxWidth: cfg.maxWidth,
          quality: cfg.quality,
          timeoutMs: cfg.timeoutMs,
          keep: cfg.keepScreenshots,
        });
        if (!captured?.ok || !captured.buffer) {
          const error = captured?.error || '截图失败';
          noteError(error);
          last = { ok: false, at: Date.now(), hash: '', verdict: { ok: false, degraded: true, error }, captureMs: captured?.ms || 0, visionMs: 0, error, reason };
          return last;
        }
        const hash = crypto.createHash('sha1').update(captured.buffer).digest('hex');
        const sameScreen = last?.hash === hash && last?.verdict?.ok === true && Date.now() - last.at < intervalMs(cfg) * 2;
        if (sameScreen) {
          last = { ...last, ok: true, at: Date.now(), cached: true, captureMs: captured.ms, error: '' };
          return last;
        }
        const vision = await visionLook(captured.buffer, cfg, ownerName);
        last = {
          ok: true,
          at: Date.now(),
          hash,
          verdict: vision.verdict,
          capture: { width: captured.width, height: captured.height, bytes: captured.bytes },
          captureMs: captured.ms,
          visionMs: vision.ms,
          model: vision.model,
          cached: false,
          error: vision.verdict.ok ? '' : (vision.verdict.error || '视觉结果不可用'),
          reason,
        };
        if (vision.verdict.ok) lastError = '';
        else noteError(last.error);
        pluginLog(`[pet-screen] ${reason === 'manual' ? '手动' : '自动'}看一眼：${formatScreenVerdict(vision.verdict)}`);
        return last;
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, 240);
        noteError(message);
        last = { ok: false, at: Date.now(), hash: '', verdict: { ok: false, degraded: true, error: message }, error: message, reason };
        return last;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** 只取最近一次结果（不做新截图）；调用方用它做门控。 */
  function latest() {
    return last;
  }

  /** 按当前配置判断「最近这次观察」是否允许搭话。 */
  function gate() {
    return evaluateScreenGate(last?.verdict, config());
  }

  function status() {
    const cfg = config();
    return {
      enabled: cfg.enabled,
      intervalMin: cfg.intervalMin,
      retryMin: cfg.retryMin,
      endpoint: cfg.baseUrl,
      model: cfg.model,
      apiKeyRef: cfg.apiKeyRef,
      failOpen: cfg.failOpen,
      last: last
        ? {
            at: last.at,
            ok: last.ok === true,
            cached: last.cached === true,
            captureMs: last.captureMs || 0,
            visionMs: last.visionMs || 0,
            verdict: last.verdict,
            summary: last.verdict?.ok ? last.verdict.summary : '',
            activity: last.verdict?.activity || 'unknown',
            interruptible: last.verdict?.ok ? last.verdict.interruptible : null,
            privacy: last.verdict?.privacy || 'unknown',
            error: last.error || '',
          }
        : null,
      lastError,
    };
  }

  return {
    config,
    enabled,
    look,
    latest,
    gate,
    status,
    intervalMs: () => intervalMs(config()),
    retryMs: () => retryMs(config()),
    formatVerdict: (verdict) => formatScreenVerdict(verdict),
    defaults: DEFAULT_SCREEN_CONFIG,
  };
}
