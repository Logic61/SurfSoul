// 快速生图（Agnes / OpenAI 兼容 `/images/generations`）的纯逻辑实现。
//
// 为什么单独一个模块：桥接路由、MCP 工具、测试三处都要用到同一套「配置归一 /
// 请求构造 / 响应解析 / 落盘命名」；逻辑写进 bridge.js 的那个单回调巨函数会既难测、
// 又容易和别的分支抢作用域（见 PITFALLS「单回调里的 TDZ」）。
//
// 2026-11-01 选型背景：
//   · freegpt（DSH 里配的 CLI Proxy API 面板）的 gpt-image-* 模型实测 503
//     `auth_not_found: no auth available (providers=codex, …)` —— 面板侧没给这个 key
//     配生图通道，客户端绕不过去；它的纯文本 chat 模型只会吐 SVG 代码，不是真出图。
//   · 本机已有的 AGNES_API_KEY（原本给「看屏幕」做视觉理解）暴露了
//     agnes-image-2.5-flash（实测 1024×1024 PNG、约 15 秒），且从这台机器直连可用，
//     所以把它接成「快速画图」通道；Codex 子智能体留给照片级/复杂图（约 4~5 分钟）。
//
// 安全/成本口径：这是**外部 API 调用**，prompt 会发给 Agnes（第三方）。入口只在桥接侧；
// 2026-11-01 主人要求「允许群聊画图」后，对「群聊 + 主人私聊」开放，并按会话配额限流
// （群聊默认每小时 3 张 / 每天 10 张；0 = 不限；别人私聊仍不可用）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const DEFAULT_IMAGE_GEN_CONFIG = Object.freeze({
  enabled: true,
  baseUrl: 'https://apihub.agnes-ai.com/v1',
  model: 'agnes-image-2.5-flash',
  size: '1024x1024',
  apiKeyEnv: 'AGNES_API_KEY',
  apiKey: '',
  timeoutMs: 240000,
  maxPromptChars: 2000,
  maxImageBytes: 10 * 1024 * 1024,
  outputDir: 'state/generated-images',
  keepDays: 7,
  // 会话配额（0 = 不限）。群聊是「能画但别被刷屏」；主人私聊放宽一些。
  group: Object.freeze({ enabled: true, maxPerHour: 3, maxPerDay: 10 }),
  owner: Object.freeze({ enabled: true, maxPerHour: 20, maxPerDay: 100 }),
})

/** 允许 override 的 model/size 形态（防止把任意字符串塞进请求）。 */
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
const SIZE_RE = /^\d{3,4}x\d{3,4}$/

function clampInt(value, fallback, min, max) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 生图配额归一：0 = 不限（仓库里 `maxPerMinute > 0 &&` 的老约定）。
 * 2026-11-01 主人要求「允许群聊画图」后加：群聊是**外部 API 花钱**的动作，
 * 一刀切禁止体验差、完全不限又容易被刷屏/注入带着刷额度，所以按会话配额。
 */
function normalizeQuota(raw, fallback) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: src.enabled !== false,
    maxPerHour: clampInt(src.maxPerHour, fallback.maxPerHour, 0, 500),
    maxPerDay: clampInt(src.maxPerDay, fallback.maxPerDay, 0, 5000),
  }
}

/** 配置归一：旧 config.json 没有 socialV2.imagegen 时给默认值；坏值回退默认。 */
export function normalizeImageGenConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const baseUrl = String(src.baseUrl ?? DEFAULT_IMAGE_GEN_CONFIG.baseUrl).trim().replace(/\/+$/, '')
  const model = MODEL_RE.test(String(src.model ?? '').trim())
    ? String(src.model).trim()
    : DEFAULT_IMAGE_GEN_CONFIG.model
  const size = SIZE_RE.test(String(src.size ?? '').trim())
    ? String(src.size).trim()
    : DEFAULT_IMAGE_GEN_CONFIG.size
  const outputDir = String(src.outputDir ?? DEFAULT_IMAGE_GEN_CONFIG.outputDir).trim() || DEFAULT_IMAGE_GEN_CONFIG.outputDir
  return {
    enabled: src.enabled !== false,
    baseUrl: /^https?:\/\//i.test(baseUrl) ? baseUrl : DEFAULT_IMAGE_GEN_CONFIG.baseUrl,
    model,
    size,
    apiKeyEnv: String(src.apiKeyEnv ?? DEFAULT_IMAGE_GEN_CONFIG.apiKeyEnv).trim() || DEFAULT_IMAGE_GEN_CONFIG.apiKeyEnv,
    apiKey: String(src.apiKey ?? '').trim(),
    timeoutMs: clampInt(src.timeoutMs, DEFAULT_IMAGE_GEN_CONFIG.timeoutMs, 10_000, 600_000),
    maxPromptChars: clampInt(src.maxPromptChars, DEFAULT_IMAGE_GEN_CONFIG.maxPromptChars, 1, 8000),
    maxImageBytes: clampInt(src.maxImageBytes, DEFAULT_IMAGE_GEN_CONFIG.maxImageBytes, 1024, 64 * 1024 * 1024),
    outputDir,
    keepDays: clampInt(src.keepDays, DEFAULT_IMAGE_GEN_CONFIG.keepDays, 0, 365),
    group: normalizeQuota(src.group, DEFAULT_IMAGE_GEN_CONFIG.group),
    owner: normalizeQuota(src.owner, DEFAULT_IMAGE_GEN_CONFIG.owner),
  }
}

/**
 * 会话配额检查：返回 `{ ok, reason?, limit?, retryAfterMs?, hourCount, dayCount }`。
 * 时间戳数组由调用方持久化在 socialV2 会话状态里（`st.imageGenTimes`）。
 * 0 / 缺省 = 不限。
 */
export function imageGenQuotaStatus(times, { now = Date.now(), maxPerHour = 0, maxPerDay = 0 } = {}) {
  const list = Array.isArray(times) ? times.filter((t) => Number.isFinite(t) && t > 0) : []
  const hourWindow = 60 * 60 * 1000
  const dayWindow = 24 * hourWindow
  const inHour = list.filter((t) => now - t < hourWindow)
  const inDay = list.filter((t) => now - t < dayWindow)
  const status = { ok: true, hourCount: inHour.length, dayCount: inDay.length, maxPerHour, maxPerDay }
  if (maxPerHour > 0 && inHour.length >= maxPerHour) {
    const oldest = Math.min(...inHour)
    return { ...status, ok: false, reason: 'hour', limit: maxPerHour, retryAfterMs: Math.max(0, oldest + hourWindow - now) }
  }
  if (maxPerDay > 0 && inDay.length >= maxPerDay) {
    const oldest = Math.min(...inDay)
    return { ...status, ok: false, reason: 'day', limit: maxPerDay, retryAfterMs: Math.max(0, oldest + dayWindow - now) }
  }
  return status
}

/** 记录一次成功生成；只保留最近 7 天、最多 keep 条（配额窗口最长 24h，足够）。 */
export function recordImageGenTime(times, now = Date.now(), keep = 200) {
  const list = Array.isArray(times) ? times.filter((t) => Number.isFinite(t) && t > 0) : []
  const cutoff = now - 7 * 24 * 60 * 60 * 1000
  list.push(now)
  return list.filter((t) => t >= cutoff).slice(-Math.max(1, keep))
}

/**
 * 解析生图密钥：config.apiKey → 环境变量 apiKeyEnv → credentialLookup(apiKeyEnv)。
 * `credentialLookup` 由桥接注入（读 DSH 的 ~/.dsh/.credentials.yaml），测试里可传假函数。
 */
export function resolveImageGenApiKey({ config, env = process.env, credentialLookup } = {}) {
  const cfg = normalizeImageGenConfig(config)
  if (cfg.apiKey) return cfg.apiKey
  const fromEnv = cfg.apiKeyEnv ? String(env?.[cfg.apiKeyEnv] ?? '').trim() : ''
  if (fromEnv) return fromEnv
  if (cfg.apiKeyEnv && typeof credentialLookup === 'function') {
    try {
      const fromStore = String(credentialLookup(cfg.apiKeyEnv) ?? '').trim()
      if (fromStore) return fromStore
    } catch { /* 读凭据失败按“没配密钥”处理，由调用方给可读错误 */ }
  }
  return ''
}

/** 构造 `/images/generations` 请求体。prompt 已被调用方做长度校验。 */
export function buildImageGenRequestBody(config, { prompt, model, size } = {}) {
  const cfg = normalizeImageGenConfig(config)
  const text = String(prompt ?? '').trim()
  if (!text) throw new Error('prompt 不能为空')
  if (text.length > cfg.maxPromptChars) throw new Error(`prompt 过长（${text.length} > ${cfg.maxPromptChars} 字）`)
  const useModel = MODEL_RE.test(String(model ?? '').trim()) ? String(model).trim() : cfg.model
  const useSize = SIZE_RE.test(String(size ?? '').trim()) ? String(size).trim() : cfg.size
  return {
    model: useModel,
    size: useSize,
    prompt: text,
    n: 1,
    // OpenAI 兼容端点的常规参数：gpt-image 类总是返回 b64_json，显式写出来对
    // “返回 url 的代理”也兼容（解析侧两种都认）。
    response_format: 'b64_json',
  }
}

/** 从响应 JSON 里取图：优先 data[0].b64_json，其次 data[0].url。 */
export function extractImageFromResponse(body) {
  const item = body && typeof body === 'object' ? body.data?.[0] : null
  if (!item || typeof item !== 'object') return null
  const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : ''
  if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
    return { kind: 'b64', data: item.b64_json.trim(), revisedPrompt }
  }
  if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url.trim())) {
    return { kind: 'url', data: item.url.trim(), revisedPrompt }
  }
  return null
}

/** 按文件头识别图片类型；不认识返回 null（不落盘未知内容）。 */
export function sniffImageExt(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'gif'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

/**
 * 从错误响应体里提取可读原因。
 * 兼容 OpenAI 形状 `{error:{message}}` / `{error:"..."}` / `{message}`，以及纯文本。
 */
export function imageGenErrorText(status, bodyText) {
  const raw = String(bodyText ?? '')
  try {
    const j = JSON.parse(raw)
    const message = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail
    if (typeof message === 'string' && message.trim()) return `${message.trim().slice(0, 400)}（HTTP ${status}）`
  } catch { /* 非 JSON，按纯文本截断 */ }
  return raw.trim() ? `${raw.trim().slice(0, 300)}（HTTP ${status}）` : `HTTP ${status}`
}

/**
 * 调外部 API 生成一张图，返回 PNG/JPEG 字节。
 * @param options.fetchImpl 可注入（测试用），默认全局 fetch。
 */
export async function generateImageNow({ config, prompt, model, size, apiKey, fetchImpl } = {}) {
  const cfg = normalizeImageGenConfig(config)
  if (!cfg.enabled) throw new Error('快速生图已关闭（socialV2.imagegen.enabled=false）')
  const key = String(apiKey ?? '').trim()
  if (!key) throw new Error('未配置生图密钥（socialV2.imagegen.apiKey / 环境变量 AGNES_API_KEY / DSH 凭据都没找到）')
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('当前运行时不支持 fetch')
  const payload = buildImageGenRequestBody(cfg, { prompt, model, size })
  const started = Date.now()
  const res = await doFetch(`${cfg.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`生图接口失败：${imageGenErrorText(res.status, text)}`)
  let body
  try { body = JSON.parse(text) } catch { throw new Error('生图接口返回的不是 JSON') }
  const picked = extractImageFromResponse(body)
  if (!picked) throw new Error('生图接口没有返回图片（缺 data[0].b64_json / url）')
  let buffer
  if (picked.kind === 'b64') {
    buffer = Buffer.from(picked.data, 'base64')
  } else {
    const imgRes = await doFetch(picked.data, { signal: AbortSignal.timeout(cfg.timeoutMs) })
    if (!imgRes.ok) throw new Error(`下载生成图失败：HTTP ${imgRes.status}`)
    buffer = Buffer.from(await imgRes.arrayBuffer())
  }
  if (!buffer.length) throw new Error('生成图内容为空')
  if (buffer.length > cfg.maxImageBytes) throw new Error(`生成图太大（${(buffer.length / 1024 / 1024).toFixed(1)}MB > ${cfg.maxImageBytes / 1024 / 1024}MB）`)
  const ext = sniffImageExt(buffer)
  if (!ext) throw new Error('生成结果不是图片（文件头不认识）')
  return {
    buffer,
    ext,
    model: payload.model,
    size: payload.size,
    revisedPrompt: picked.revisedPrompt,
    ms: Date.now() - started,
  }
}

/**
 * 落盘到 `outputDir`，文件名 `img-YYYYMMDD-HHmmss-<6hex>.<ext>`（不用模型给的任何字符串，
 * 避免路径穿越/奇怪文件名）。同时按 keepDays 清理旧文件（尽力而为，失败不影响本次）。
 * @returns {{path: string, bytes: number, ext: string, filename: string}}
 */
export function saveGeneratedImage({ rootDir, config, buffer, now = new Date(), randomSuffix } = {}) {
  const cfg = normalizeImageGenConfig(config)
  const ext = sniffImageExt(buffer)
  if (!ext) throw new Error('不是图片，拒绝落盘')
  const dir = path.resolve(String(rootDir ?? '.'), cfg.outputDir)
  fs.mkdirSync(dir, { recursive: true })
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const suffix = (randomSuffix ?? crypto.randomBytes(3).toString('hex')).replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'x'
  const filename = `img-${stamp}-${suffix}.${ext}`
  const filePath = path.join(dir, filename)
  fs.writeFileSync(filePath, buffer)
  if (cfg.keepDays > 0) {
    try {
      const cutoff = now.getTime() - cfg.keepDays * 24 * 60 * 60 * 1000
      for (const name of fs.readdirSync(dir)) {
        if (!/^img-.*\.(png|jpg|gif|webp)$/i.test(name)) continue
        const full = path.join(dir, name)
        try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full) } catch { /* 单个文件失败忽略 */ }
      }
    } catch { /* 清理失败不影响本次生成 */ }
  }
  return { path: filePath, bytes: buffer.length, ext, filename }
}

/**
 * 从 DSH 凭据文件（`<DSH_HOME>/.credentials.yaml`）里按名字找密钥。
 * DSH 的凭据文件结构不是公开契约，所以：只做**递归找同名 key**、只在内存里用、
 * 找不到/读失败都返回空串（绝不让它影响桥接启动）。
 * @param {string} name 例如 AGNES_API_KEY
 * @param {(text: string) => any} yamlLoad 由调用方注入 js-yaml（避免这里硬依赖）
 * @returns {string}
 */
export function findCredentialInYamlText(text, name, yamlLoad) {
  if (typeof text !== 'string' || !text.trim() || typeof yamlLoad !== 'function') return ''
  let doc
  try { doc = yamlLoad(text) } catch { return '' }
  const wanted = String(name ?? '').trim()
  if (!wanted) return ''
  const seen = new Set()
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) return ''
    seen.add(node)
    if (typeof node[wanted] === 'string' && node[wanted].trim()) return node[wanted].trim()
    for (const value of Object.values(node)) {
      const hit = walk(value, depth + 1)
      if (hit) return hit
    }
    return ''
  }
  return walk(doc, 0)
}
