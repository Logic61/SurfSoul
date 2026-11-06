// qq-owner-approval —— 内部模型审批行（只挂在 qq-chat-v2 / reserved2 的 preset 里）。
//
// 它解决什么
// ----------
// 2026-11-06 用户拍板：本机工具（pwsh/read/write/…/subagent_codex）、账号级动作
// （好友申请、跨场合投递）与群管理（禁言/改别人名片）不再要求「只能在主人私聊」，
// 改成「**主人本人触发的回合**里可用」，但每次调用必须先过一道内部模型审批。
// 硬边界仍然是「真实 sender QQ 归因（桥接写 state/turn-triggers.json）+ 工具白名单
// + guard」；模型审批是**启发式**安全层，不替代硬边界（design.md §0 红线）。
//
// 三个必须遵守的 DSH 契约（证据见 _recon/reports/dsh-scout.md）
// ------------------------------------------------------------
// 1) 返回 `{kind:'deny'}` **不带非空 reason** 会被 DSH 当成「没有拒绝理由」而
//    **继续执行**（fail-open，dsh-tools prepareExecution）。所以本文件所有 deny 都走
//    `denyDecision()`，它保证 reason 一定非空；绝不返回协议外的 kind。
// 2) pre-execute 没有内建超时：listener 必须自己 `AbortSignal.any([exec.signal,
//    超时, 生命周期])`，否则工具调用会挂到回合取消（取消也不会放弃 promise）。
// 3) `approval/request` 是唯一能**程序化领取**人工审批的钩子，而且必须 `{prepend:true}`
//    才能抢在桥接的转发 listener 之前；只对「同一个 sessionId+callId 刚刚被模型批准」
//    的本地工具返回 `'allowed-once'`，其余一律 next() 交回人工。
//
// 失败模式（这是 preset 里的一行，抛错代价极高）
// --------------------------------------------
// 模块顶层 import 失败或 apply() 抛错 → 该行 failed → agent-preset/invalid →
// **QQ 会话直接建不出来**。因此：
//   · 零 `@deepseek-ai/*` import（仓库 node_modules 没有 dsh-tools / dsh-llm）；
//   · import 只有 node: 内建 + 包内 `./lib/turn-trigger.js`（同一 bundle，files 白名单含 lib）；
//   · apply() 里每一步都 try/catch；缺失 `ctx.on/effect/get`（老测试的 fake ctx 就只有
//     `{tools}`）时安全跳过注册，绝不依赖它们存在；
//   · 任何配置/状态文件缺失都只是「无归因 → deny」，不会抛。
//
// 兼容性铁律
// ----------
//   · 一代 preset（qq-chat）**不挂本行**，chat/reserved 行为完全不变；
//   · 新逻辑只在 `turn-triggers.json` 的 mode === 'reserved2' 且
//     `socialV2.toolApproval.enabled !== false` 时生效；
//   · 主人私聊（会话 key === `private:<ownerQQ>`）直接 next()——老行为不变，不跑模型审批。
//
// 审计：每次 allow/deny/fail 追加一行 `state/tool-approvals.jsonl`
//   {t, key, sessionId, tool, decision, risk, reason(≤160,脱敏), model, latencyMs,
//    triggerUserId, triggerIsOwner, mode, source:'model'}
//   **参数原文与令牌绝不入日志**（reason 也过 sanitizeAuditText，去掉盘符与长串）。
//   文件 >1MB 轮转为 `.1`；写失败只 log。

export const name = 'qq-owner-approval'

// 只依赖 tools：llm 用 ctx.get('llm') 懒取。**不能**把 'llm' 放进 inject ——
// llm 缺失/启动顺序问题时该行会 pending → preset invalid → QQ 会话建不出来（dsh-scout Q4）。
export const inject = ['tools']

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  buildApprovalArgsText,
  buildApprovalSystemPrompt,
  buildApprovalUserText,
  isLocalExecutionTool,
  isOwnerPrivateKey,
  isPrivilegedTool,
  parseApprovalVerdict,
  readToolApprovalConfig,
  resolveSurfcoreRoot,
  resolveTurnContext,
  sanitizeAuditText,
  sessionIdCandidates,
} from './lib/turn-trigger.js'

/** 模型已批准 → 领取工具体内人工审批（沙箱升级）的有效期。消费即删。 */
const GRANT_TTL_MS = 180000
/** 同一回合内「相同工具+相同参数」的去重有效期（不重复审）。 */
const DEDUPE_TTL_MS = 180000
/** 审计文件轮转阈值。 */
const AUDIT_ROTATE_BYTES = 1024 * 1024
/** 审计文件最多留一行多少字的理由（脱敏后）。 */
const AUDIT_REASON_MAX = 160
/** grants/budget 超过这个规模时做一次惰性清扫（不挂 timer，少一个生命周期坑）。 */
const MAX_TRACKED_ENTRIES = 256

function logError(scope, error) {
  try {
    const message = error && typeof error === 'object' && 'message' in error ? error.message : String(error ?? '')
    console.error(`[qq-owner-approval] ${scope}：${String(message).slice(0, 300)}`)
  } catch { /* 日志失败不影响主流程 */ }
}

/** 组合多个 AbortSignal（AbortSignal.any 不存在时手写；Node 22 有，但别赌宿主实现）。 */
function combineSignals(signals) {
  const list = []
  for (const signal of signals) {
    if (signal && typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function') list.push(signal)
  }
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') {
    try { return AbortSignal.any(list) } catch { /* 落到手写实现 */ }
  }
  const controller = new AbortController()
  const onAbort = () => {
    try { controller.abort(list.find((s) => s.aborted)?.reason ?? new Error('aborted')) } catch { /* ignore */ }
  }
  for (const signal of list) {
    if (signal.aborted) { onAbort(); break }
    try { signal.addEventListener('abort', onAbort, { once: true }) } catch { /* ignore */ }
  }
  return controller.signal
}

/** 超时信号：优先 AbortSignal.timeout；不可用时手写 setTimeout（记得 clear）。 */
function makeTimeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') {
    try { return { signal: AbortSignal.timeout(ms), clear: () => {} } } catch { /* 落到手写 */ }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    try { controller.abort(new Error('approval review timeout')) } catch { /* ignore */ }
  }, ms)
  if (typeof timer.unref === 'function') timer.unref()
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

/** 参数指纹：同一回合内「同工具+同参数」复用审批结果（design.md §3.2 第 5 步）。 */
function hashArguments(args) {
  let text = ''
  try {
    const json = JSON.stringify(args)
    text = typeof json === 'string' ? json : ''
  } catch { text = '' }
  return crypto.createHash('sha1').update(text).digest('hex')
}

/** 一次模型的审批调用：手写 chunk 收集（不能 import BlockAssembler）。 */
async function collectReviewText(llm, options) {
  const { provider, model, system, userText, signal, sessionId, maxTokens } = options
  if (signal && signal.aborted) throw new Error('审批请求已取消')
  const stream = llm.stream({
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    temperature: 0,
    maxTokens,
    signal,
    sessionId,
  })
  let text = ''
  let finished = false
  let failure = ''
  for await (const chunk of stream) {
    if (signal && signal.aborted) throw new Error('审批请求已取消')
    if (finished) break
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') {
      if (typeof chunk.text === 'string') text += chunk.text
      continue
    }
    // reasoning-delta / block-* / usage 一律忽略：我们只要最终文本。
    if (chunk.type === 'finish') {
      finished = true
      const kind = chunk.reason && typeof chunk.reason === 'object' ? chunk.reason.kind : undefined
      if (kind !== 'stop') failure = `finish:${kind ?? 'unknown'}`
    }
  }
  if (signal && signal.aborted) throw new Error('审批请求已取消')
  if (!finished) throw new Error('审批模型没有返回终止块')
  if (failure) throw new Error(`审批模型异常结束（${failure}）`)
  return text
}

/**
 * 解析审批模型路由：provider 必须来自本会话的 request header（不猜默认模型）；
 * model 允许被 `socialV2.toolApproval.model` 覆盖（例如固定用便宜的小模型审批）。
 */
function resolveReviewRoute(exec, config) {
  let headerConfig
  try {
    headerConfig = exec?.agent?.session?.requestHeader?.()?.config
  } catch { headerConfig = undefined }
  const provider = headerConfig && typeof headerConfig.provider === 'string' ? headerConfig.provider : ''
  const headerModel = headerConfig && typeof headerConfig.model === 'string' ? headerConfig.model : ''
  const model = config.model || headerModel
  return { provider, model }
}

/**
 * 插件运行时状态 + 监听器工厂。
 *
 * 单独拆成工厂函数（而不是模块级 Map）是为了：
 *   · 测试可以反复 import 出独立实例，互不串状态；
 *   · `apply` 里任何一步抛错都能被兜住，不会拖垮 preset。
 */
export function createApprovalRuntime(ctx) {
  const life = new AbortController()
  /** `${sessionId}\0${callId}` → {until, toolName}：模型已批准、待领取人工审批的调用。 */
  const grants = new Map()
  /** `${sessionId}\0${triggerAt}` → count：本回合已用掉的模型审批次数。 */
  const budget = new Map()
  /** `${sessionId}\0${triggerAt}\0${tool}\0${sha1(args)}` → {until, risk}：本回合已批准的去重缓存。 */
  const reviewed = new Map()

  function clearState() {
    grants.clear()
    budget.clear()
    reviewed.clear()
  }

  /** 惰性清扫：只在这些小 Map 变大时做，避免额外定时器/生命周期。 */
  function sweep(now = Date.now()) {
    if (grants.size + budget.size + reviewed.size <= MAX_TRACKED_ENTRIES) return
    for (const [key, grant] of grants) if (!(grant.until > now)) grants.delete(key)
    for (const [key, entry] of reviewed) if (!(entry.until > now)) reviewed.delete(key)
    for (const [key, count] of budget) {
      const triggerAt = Number(key.slice(key.indexOf('\u0000') + 1))
      if (!Number.isFinite(triggerAt) || now - triggerAt > 3600000 || count <= 0) budget.delete(key)
    }
  }

  /** 登记「该 callId 已获模型批准」——只对这一对 sessionId+callId 生效，领取即删。 */
  function registerGrant(sessionIds, callId, toolName, now) {
    if (callId === undefined || callId === null) return
    const idPart = String(callId)
    const seen = new Set()
    for (const sid of sessionIds) {
      if (!sid || seen.has(sid)) continue
      seen.add(sid)
      grants.set(`${sid}\u0000${idPart}`, { until: now + GRANT_TTL_MS, toolName })
    }
  }

  /** 领取：清掉该调用在所有候选 sessionId 下的登记（避免残留被后续同 callId 命中）。 */
  function takeGrant(sessionIds, callId) {
    const idPart = String(callId)
    let found = null
    for (const sid of sessionIds) {
      const key = `${sid}\u0000${idPart}`
      const grant = grants.get(key)
      if (!grant) continue
      grants.delete(key)
      if (!found) found = grant
    }
    return found
  }

  /** 审计：每次决定追加一行；参数与令牌绝不落盘。写失败只 log。 */
  function appendAudit(record) {
    try {
      const file = path.join(resolveSurfcoreRoot(), 'state', 'tool-approvals.jsonl')
      try {
        const stat = fs.statSync(file)
        if (stat.size > AUDIT_ROTATE_BYTES) {
          const rotated = `${file}.1`
          try { fs.rmSync(rotated, { force: true }) } catch { /* 旧轮转文件删不掉就覆盖失败时再试 */ }
          fs.renameSync(file, rotated)
        }
      } catch { /* 文件不存在：正常首次写 */ }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    } catch (error) {
      logError('审计写入失败', error)
    }
  }

  function auditDecision({ decision, risk, reason, model, latencyMs, turn, sessionId, tool }) {
    const now = Date.now()
    appendAudit({
      t: now,
      key: turn?.key ?? '',
      sessionId: sessionId || turn?.sessionId || '',
      tool: typeof tool === 'string' ? tool : '',
      decision,
      risk: typeof risk === 'string' ? risk : '',
      reason: sanitizeAuditText(typeof reason === 'string' ? reason : '', AUDIT_REASON_MAX),
      model: typeof model === 'string' ? model.slice(0, 120) : '',
      latencyMs: Number.isFinite(latencyMs) ? Math.max(0, Math.trunc(latencyMs)) : 0,
      triggerUserId: turn?.trigger?.userId ?? '',
      triggerIsOwner: turn?.isOwnerTrigger === true,
      // wakeReason 来自 turn-triggers 记录（atMention/timeout/proactiveCheck/…）——诊断用；
      // 授权只看 trigger.isOwner，不看它（bridge 已把系统唤醒的 isOwner 置 false）。
      wakeReason: turn?.wakeReason ?? '',
      mode: turn?.mode ?? '',
      source: 'model',
    })
  }

  /**
   * 统一的 deny 出口：**保证 reason 非空**（DSH 对「无 reason 的 deny」会 fail-open 执行）。
   * info 里带结构化错误码，方便模型/日志区分「政策拒绝」与「审批不可用」。
   */
  function denyDecision(toolName, summary, rawReason) {
    const short = sanitizeAuditText(typeof rawReason === 'string' ? rawReason : '', 120)
    const label = typeof toolName === 'string' && toolName ? toolName : '未知工具'
    const base = `工具 "${label}" ${summary || '未通过内部审批'}`
    return {
      kind: 'deny',
      reason: short ? `${base}：${short}` : `${base}，已拒绝`,
      info: {
        name: 'QqApprovalDenied',
        code: 'QQ_APPROVAL_DENIED',
        ...(short ? { reason: short } : {}),
      },
    }
  }

  // ── 主门：tools/pre-execute ────────────────────────────────────────────────
  async function handlePreExecute(exec, next) {
    const toolName = exec && typeof exec === 'object' ? exec.name : undefined
    if (typeof toolName !== 'string' || !isPrivilegedTool(toolName)) return next()
    try {
      return await reviewGate(exec, next)
    } catch (error) {
      // 兜底 fail-closed：预执行阶段任何意外都不能放行特权工具。
      logError(`预执行异常（${toolName}）`, error)
      return denyDecision(toolName, '的模型审批发生内部错误，为防止越权已拒绝', '审批内部错误')
    }
  }

  async function reviewGate(exec, next) {
    const toolName = exec.name
    const localTool = isLocalExecutionTool(toolName)
    const sessionIds = sessionIdCandidates(exec)
    const turn = resolveTurnContext(sessionIds)
    const config = turn.config

    // ① 主人私聊：沿用旧语义，直接放行、不跑模型审批（lead 补充要求 6）。
    if (isOwnerPrivateKey(turn.key, turn.ownerKey)) return next()

    // ② 新逻辑未生效（非 reserved2 / 开关关闭 / 归因文件缺失）：
    //    本地工具保持旧的「仅主人私聊」拒绝；账号级/群管理交给 bridge 旧闸判定
    //    （群管理 ownerAt 窗口、好友申请私聊准入等旧路径全部保留）。
    const newPath = turn.mode === 'reserved2' && config.enabled
    if (!newPath) {
      if (localTool) {
        return denyDecision(toolName, '是本地能力，只允许主人本人在私聊里、或主人本人触发的回合里使用', `当前会话 ${turn.key || '未知'} 不在授权范围`)
      }
      return next()
    }

    // ③ reserved2 且开关开启：只认「主人本人触发的回合」。
    if (!turn.isValidOwnerTurn) {
      const reason = turn.turnActive !== true
        ? '当前没有进行中的回合归因（fail-closed）'
        : (turn.isOwnerTrigger !== true ? '当前回合的触发者不是主人' : '主人触发消息已超过授权窗口')
      return denyDecision(toolName, '只能在主人本人触发的回合里使用', reason)
    }

    // ④ 预算 / 去重
    sweep()
    const sessionId = turn.sessionId || sessionIds[0] || ''
    const turnKey = `${sessionId}\u0000${turn.triggerAt}`
    const argsHash = hashArguments(exec.arguments)
    const dedupeKey = `${turnKey}\u0000${toolName}\u0000${argsHash}`
    const now = Date.now()
    const deduped = reviewed.get(dedupeKey)
    if (deduped && deduped.until > now) {
      registerGrant(sessionIds, exec.callId, toolName, now)
      auditDecision({ decision: 'allow', risk: deduped.risk, reason: '同一回合内相同调用已批准（去重）', model: '', latencyMs: 0, turn, sessionId, tool: toolName })
      return next()
    }
    const used = budget.get(turnKey) ?? 0
    if (used >= config.maxReviewsPerTurn) {
      return denyDecision(toolName, '的本回合模型审批次数已达上限，请合并操作后重试', `上限 ${config.maxReviewsPerTurn} 次/回合`)
    }
    budget.set(turnKey, used + 1)

    // ⑤ llm 懒取 + 路由（任一缺失 → fail-closed）
    let llm
    try {
      llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    } catch (error) {
      logError('获取 llm 失败', error)
      llm = undefined
    }
    if (!llm || typeof llm.stream !== 'function') {
      return denyDecision(toolName, '的模型审批不可用（llm 服务缺失），已拒绝', '模型审批不可用')
    }
    const route = resolveReviewRoute(exec, config)
    if (!route.provider || !route.model) {
      return denyDecision(toolName, '的模型审批无法确定模型路由，已拒绝', '缺少审批模型路由')
    }

    // ⑥ 调模型（超时/取消/生命周期三合一 signal；失败一律 fail-closed）
    const argsText = buildApprovalArgsText(toolName, exec.arguments)
    const userText = buildApprovalUserText({
      toolName,
      argsText,
      trigger: turn.trigger,
      recent: turn.recent,
      mode: turn.mode,
      sessionKey: turn.key,
      groupName: turn.groupName,
    })
    const timeout = makeTimeoutSignal(config.timeoutMs)
    const signal = combineSignals([exec.signal, timeout.signal, life.signal])
    const startedAt = Date.now()
    let verdict
    try {
      const text = await collectReviewText(llm, {
        provider: route.provider,
        model: route.model,
        system: buildApprovalSystemPrompt(),
        userText,
        signal,
        sessionId: sessionId || undefined,
        maxTokens: config.maxTokens,
      })
      verdict = parseApprovalVerdict(text)
    } catch (error) {
      const latencyMs = Date.now() - startedAt
      const detail = sanitizeAuditText(error && error.message ? error.message : String(error), 80)
      auditDecision({ decision: 'fail', risk: '', reason: `审批失败：${detail}`, model: `${route.provider}/${route.model}`, latencyMs, turn, sessionId, tool: toolName })
      return denyDecision(toolName, '的模型审批失败，已拒绝', detail || '审批失败')
    } finally {
      timeout.clear()
    }

    // ⑦ 结果解析（严格 JSON + fail-closed）
    const latencyMs = Date.now() - startedAt
    if (!verdict.valid) {
      auditDecision({ decision: 'fail', risk: '', reason: '审批结果不可用', model: `${route.provider}/${route.model}`, latencyMs, turn, sessionId, tool: toolName })
      return denyDecision(toolName, '的审批结果不可用，已拒绝', '审批结果不是合法的 JSON 协议')
    }
    if (verdict.decision !== 'allow') {
      auditDecision({ decision: 'deny', risk: verdict.risk, reason: verdict.reason || '模型审批拒绝', model: `${route.provider}/${route.model}`, latencyMs, turn, sessionId, tool: toolName })
      return denyDecision(toolName, '的模型审批未通过（高风险或与主人要求不符），未执行', verdict.reason || '模型审批拒绝')
    }

    // ⑧ 批准：登记领取凭据，再 next() 走 guard 硬边界与下游 listener。
    //    **不能**直接返回 {kind:'allow'}——那会跳过 guard 与下游 listener。
    reviewed.set(dedupeKey, { until: now + DEDUPE_TTL_MS, risk: verdict.risk })
    registerGrant(sessionIds, exec.callId, toolName, now)
    auditDecision({ decision: 'allow', risk: verdict.risk, reason: '', model: `${route.provider}/${route.model}`, latencyMs, turn, sessionId, tool: toolName })
    return next()
  }

  // ── 配套：领取工具体内的人工审批（沙箱升级等）──────────────────────────────
  async function handleApprovalRequest(request, next) {
    try {
      const toolName = request && typeof request === 'object' ? request.toolName : undefined
      if (typeof toolName !== 'string' || !isLocalExecutionTool(toolName)) return next()
      const config = readToolApprovalConfig()
      if (config.claimSandboxApproval === false) return next()
      const agent = request.agent
      // lead 补充要求 7：拿不到 agent（字段形状与推断不符）就**不领取**，把人工路径留给桥接，
      // 绝不在没把握时回 'allowed-once'（那等于替主人批准了沙箱升权）。
      if (!agent || typeof agent !== 'object') return next()
      const sessionIds = sessionIdCandidates(agent)
      if (sessionIds.length === 0) return next()
      const callId = request.callId
      if (callId === undefined || callId === null) return next()
      const grant = takeGrant(sessionIds, callId)
      if (!grant) return next()
      if (!(grant.until > Date.now())) return next()
      if (grant.toolName && grant.toolName !== toolName) return next()
      return 'allowed-once'
    } catch (error) {
      logError('approval/request 领取异常', error)
      return next()
    }
  }

  return { life, handlePreExecute, handleApprovalRequest, clearState, grants, budget, reviewed }
}

/**
 * preset 行入口。**任何情况下都不允许抛错**（抛错会让 preset invalid → QQ 会话建不出来）。
 */
export function apply(ctx) {
  let runtime
  try {
    runtime = createApprovalRuntime(ctx)
  } catch (error) {
    logError('初始化失败，本行降级为不注册监听', error)
    return
  }

  // 生命周期：行被卸载时 abort 在飞的审批请求并清状态。
  // fake ctx（现有测试只传 {tools}）没有 effect → 跳过；不能因此让 apply 抛错。
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => {
        try {
          runtime.life.abort(new Error('qq-owner-approval disposed'))
        } catch { /* ignore */ }
        runtime.clearState()
      }, 'qq-owner-approval lifecycle')
    } catch (error) {
      logError('注册生命周期失败', error)
    }
  }

  if (typeof ctx?.on === 'function') {
    try {
      ctx.on('tools/pre-execute', runtime.handlePreExecute, { prepend: true })
    } catch (error) {
      logError('注册 tools/pre-execute 失败', error)
    }
    try {
      // prepend 才能抢在 api-remotes 的转发 listener 之前，否则 QQ 已经收到审批卡片。
      ctx.on('approval/request', runtime.handleApprovalRequest, { prepend: true })
    } catch (error) {
      logError('注册 approval/request 失败', error)
    }
  }
}
