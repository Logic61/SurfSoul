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
  evaluateScreenPolicy,
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

  // ── 打扰概率策略的持久化状态（2026-11-07 leaky）─────────────────────────
  // 为什么要落盘：screen 拒绝后排程会按 retryMin 反复重试，同一段低可打扰期会反复抽签；
  // 泄漏次数/冷却不跨 tick 保留，「每天最多漏 1 次」就形同虚设。
  // 同一张截图（hash+at）复用同一次抽签结果 —— 3 分钟重试不再重抽，概率才不会被重试磨平。
  const policyFile = path.join(screenDir, 'policy.json');
  let policyState = null;

  function localDayKey(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function loadPolicyState(now = Date.now()) {
    if (!policyState) {
      try {
        const raw = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
        policyState = {
          day: String(raw?.day || ''),
          leakCount: Math.max(0, Number(raw?.leakCount) || 0),
          lastLeakAt: Number(raw?.lastLeakAt) || 0,
          lastDraw: raw?.lastDraw && typeof raw.lastDraw === 'object' ? raw.lastDraw : null,
        };
      } catch {
        policyState = { day: '', leakCount: 0, lastLeakAt: 0, lastDraw: null };
      }
    }
    const day = localDayKey(now);
    if (policyState.day !== day) {
      policyState.day = day;
      policyState.leakCount = 0;
      policyState.lastLeakAt = 0;
      policyState.lastDraw = null;
    }
    return policyState;
  }

  function savePolicyState() {
    try {
      fs.mkdirSync(screenDir, { recursive: true });
      fs.writeFileSync(policyFile, `${JSON.stringify(policyState, null, 2)}\n`, 'utf8');
    } catch (error) {
      pluginLog('[pet-screen] 写抽签状态失败：', String(error?.message ?? error).slice(0, 120));
    }
  }

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

  /**
   * 决定「这一轮要不要打扰」：看一眼（带节流/缓存）→ 硬闸 + 抽签 → 记录泄漏预算。
   * 与 gate() 的区别：gate() 是纯阈值视角（设置页展示用），decide() 才会消耗随机数/泄漏预算。
   *
   * @param {{ownerName?:string, reason?:string, random?:()=>number, fresh?:boolean}} [options]
   * @returns {Promise<{allow:boolean,reason:string,kind:string,retryMs:number,verdict:object|null,p:number|null,u:number|null,x:number|null,at:number,degraded:boolean}>}
   */
  async function decide({ ownerName = '', reason = 'gate', random = Math.random, fresh = false } = {}) {
    const cfg = config();
    if (!cfg.enabled && fresh !== true) {
      return { allow: true, reason: 'screen-disabled', kind: 'disabled', retryMs: 0, verdict: null, p: null, u: null, x: null, at: Date.now(), degraded: false };
    }
    const lookResult = await look({ force: fresh === true, ownerName, reason });
    const verdict = lookResult?.verdict || null;
    const now = Date.now();
    const st = loadPolicyState(now);
    const lookKey = lookResult?.hash
      ? `${lookResult.hash}:${Number(lookResult.at) || 0}`
      : `at:${Number(lookResult?.at) || 0}`;
    let decision;
    if (st.lastDraw && st.lastDraw.key === lookKey && st.lastDraw.decision) {
      // 同一张截图/同一次判定 → 沿用上一次抽签结果，不重抽（3 分钟重试不会把概率磨成必然）。
      decision = st.lastDraw.decision;
    } else {
      const evaluated = evaluateScreenPolicy(verdict, cfg, {
        random,
        leakBudget: {
          used: st.leakCount,
          lastLeakAt: st.lastLeakAt,
          maxPerDay: cfg.maxLeakPerDay,
          cooldownMs: cfg.leakCooldownMin * ONE_MINUTE,
          now,
        },
      });
      decision = {
        allow: evaluated.allow === true,
        reason: evaluated.reason,
        kind: evaluated.kind,
        degraded: evaluated.degraded === true,
        policy: evaluated.policy,
        p: evaluated.p ?? null,
        u: evaluated.u ?? null,
        x: evaluated.x ?? null,
        budgetBlocked: evaluated.budgetBlocked === true,
      };
      if (decision.kind === 'leak') {
        st.leakCount = Math.max(0, Number(st.leakCount) || 0) + 1;
        st.lastLeakAt = now;
      }
      st.lastDraw = { key: lookKey, at: now, x: decision.x, p: decision.p, u: decision.u, decision };
      savePolicyState();
      // 只记分数/概率/随机数，不记画面内容（隐私约定同截图）。
      if (decision.p !== null) {
        const score = decision.x === null ? '?' : Number(decision.x).toFixed(2);
        pluginLog(
          `[pet-screen] 抽签 ${decision.allow ? '放行' : '拦下'}（${decision.reason}）` +
          ` x=${score} p=${Number(decision.p).toFixed(2)} u=${Number(decision.u).toFixed(2)}` +
          (decision.budgetBlocked ? ' · 今日泄漏预算已用完' : ''),
        );
      }
    }
    let nextRetryMs = 0;
    if (decision.allow !== true) {
      const above = decision.x !== null && Number(decision.x) >= cfg.minInterruptible;
      if (decision.reason === 'screen-lottery' && above) {
        // ≥阈值但这次抽签没过：snooze 一下，别 3 分钟重抽把 0.85 磨成「必然打扰」。
        nextRetryMs = cfg.lotterySnoozeMin * ONE_MINUTE;
      } else {
        nextRetryMs = retryMs(cfg);
      }
    }
    return {
      ...decision,
      retryMs: nextRetryMs,
      verdict,
      at: Number(lookResult?.at) || now,
      configured: true,
    };
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
    const st = loadPolicyState();
    return {
      enabled: cfg.enabled,
      intervalMin: cfg.intervalMin,
      retryMin: cfg.retryMin,
      endpoint: cfg.baseUrl,
      model: cfg.model,
      apiKeyRef: cfg.apiKeyRef,
      failOpen: cfg.failOpen,
      // 打扰概率策略（2026-11-07）：设置页展示「现在是什么策略 / 最近一次抽签」。
      policy: {
        interruptPolicy: cfg.interruptPolicy,
        rateAbove: cfg.rateAbove,
        rateBelow: cfg.rateBelow,
        softBand: cfg.softBand,
        maxLeakPerDay: cfg.maxLeakPerDay,
        leakCooldownMin: cfg.leakCooldownMin,
        lotterySnoozeMin: cfg.lotterySnoozeMin,
      },
      leak: { day: st.day, count: st.leakCount, lastAt: st.lastLeakAt || 0 },
      lastDraw: st.lastDraw
        ? {
            at: st.lastDraw.at || 0,
            x: st.lastDraw.x ?? null,
            p: st.lastDraw.p ?? null,
            u: st.lastDraw.u ?? null,
            allow: st.lastDraw.decision?.allow === true,
            reason: st.lastDraw.decision?.reason || '',
            kind: st.lastDraw.decision?.kind || '',
            budgetBlocked: st.lastDraw.decision?.budgetBlocked === true,
          }
        : null,
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
    decide,
    latest,
    gate,
    status,
    intervalMs: () => intervalMs(config()),
    retryMs: () => retryMs(config()),
    formatVerdict: (verdict) => formatScreenVerdict(verdict),
    defaults: DEFAULT_SCREEN_CONFIG,
  };
}
