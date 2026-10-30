// 网络超时回归（2026-10-30，P1-14）。
//
// 背景：Node fetch 默认无超时；B站/Webhook 网络半开时一次工具调用会挂到
// harness 超时。这里验证 fetchWithTimeout 真的会中止，且 bili.mjs 子进程有总预算。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchWithTimeout, DEFAULT_HTTP_TIMEOUT_MS } from '../tools/lib/http-timeout.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`) }

const realFetch = globalThis.fetch
// 假的「永不返回、但会响应 abort」的 fetch：模拟网络半开
globalThis.fetch = (url, options = {}) => new Promise((resolve, reject) => {
  const signal = options?.signal
  if (signal?.aborted) { reject(signal.reason); return }
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
})

// AbortSignal.timeout 的定时器是 unref 的：只在等它时事件循环会空 → 进程提前退出。
// 测试里挂一个 keepAlive 把事件循环撑住（真实请求有 socket 句柄，不需要这个）。
const keepAlive = setInterval(() => {}, 1000)

try {
  // ── ① 超时会中止 ──────────────────────────────────────────────────────────
  {
    const started = Date.now()
    await assert.rejects(
      () => fetchWithTimeout('https://example.test/slow', {}, 40),
      (error) => ['TimeoutError', 'AbortError'].includes(error?.name),
      '应在超时后以 TimeoutError 拒绝'
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, `超时耗时异常：${elapsed}ms`)
    ok(`fetchWithTimeout 在 ${elapsed}ms 内中止（默认 ${DEFAULT_HTTP_TIMEOUT_MS}ms，本用例 40ms）`)
  }

  // ── ② 调用方自带的 signal 仍然生效（合并，不是被覆盖） ─────────────────────
  {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('caller abort')), 30)
    await assert.rejects(
      () => fetchWithTimeout('https://example.test/slow2', { signal: controller.signal }, 5000),
      (error) => /caller abort/.test(String(error?.message ?? error)),
      '调用方 abort 应能中止请求'
    )
    ok('调用方 signal 与超时合并生效')
  }

  // ── ③ bili.mjs 子进程有总预算 ────────────────────────────────────────────
  {
    const source = fs.readFileSync(path.join(ROOT, 'tools', 'bili.mjs'), 'utf8')
    assert.ok(/spawnSync\([\s\S]{0,300}?timeout:\s*600_000/.test(source), 'bili.mjs 的 spawnSync 必须带 timeout: 600_000')
    ok('bili.mjs 子进程调用带 timeout: 600_000')
  }
} finally {
  clearInterval(keepAlive)
  globalThis.fetch = realFetch
}

console.log(`\n✅ 网络超时测试通过（${passed} 项）`)
