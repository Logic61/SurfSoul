// 带超时的 fetch（2026-10-30 补，P1-14）。
//
// 背景：Node 的 fetch **默认没有超时**；B站 接口/Webhook 网络半开时，
// agent 的一次工具调用会挂到 harness 超时（`bili.mjs` 子进程也是一样）。
//
// 约定：
//   · 只给「读 JSON / 发小请求」用；下载大文件（封面、视频、音频）不要用它，
//     那些需要长超时或流式处理。
//   · 调用方自带的 signal 会被合并（AbortSignal.any，Node 18.17+ / 22 可用）。
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000

/**
 * @param {string|URL} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
export function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  const ms = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_HTTP_TIMEOUT_MS
  const opts = options && typeof options === 'object' ? { ...options } : {}
  const caller = opts.signal
  const timer = AbortSignal.timeout(ms)
  opts.signal = caller ? AbortSignal.any([caller, timer]) : timer
  return fetch(url, opts)
}
