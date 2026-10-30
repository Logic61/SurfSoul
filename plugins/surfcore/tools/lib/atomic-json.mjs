// 状态文件的原子写 + 跨进程互斥（2026-10-30 补，P1-9）。
//
// 背景：B站 工具链是**每条命令一个独立进程**，而 quota / 待审 / 钦定 / 鱼群状态 /
// 每日动态状态都是「读整份 JSON → 改 → 写整份」。两个进程并行（agent 一回合里
// 并发调工具、或 scheduler 后台跑 plan）就会后写者覆盖先写者 → 静默少记。
// 更糟的是直接 writeFileSync：写到一半被 kill 会留下截断 JSON。
//
// 这里只解决两件事，不引入依赖：
//   · writeJsonAtomic —— 同目录 临时文件 + rename（rename 在同一卷上是原子的）
//   · updateJson      —— 用 `wx` 锁文件把「读-改-写」串起来（跨进程），过期锁可回收
//
// 用法：
//   import { writeJsonAtomic, updateJson } from '../lib/atomic-json.mjs'
//   writeJsonAtomic(file, data)
//   updateJson(file, (current) => { current.items.push(x); return current }, { fallback: { items: [] } })
import fs from 'node:fs'
import path from 'node:path'

/** 同步 sleep：这些命令是 CLI，用忙等换掉异步以免调用方改成 async（每次几十 ms 可接受）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) { /* spin */ }
  }
}

function readJsonLoose(file, fallback) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // 文件不存在 / 内容不是 JSON：都回 fallback（调用方要区分损坏时自己读文件判断）
    return fallback
  }
  return raw ?? fallback
}

/**
 * 原子写 JSON：同目录 tmp → rename。失败会抛（调用方决定吞不吞）。
 * @param {string} file
 * @param {any} data
 * @param {{ mode?: number, pretty?: number }} [options]
 */
export function writeJsonAtomic(file, data, { mode = 0o600, pretty = 2 } = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  const text = `${JSON.stringify(data, null, pretty)}\n`
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode })
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw error
  }
}

/**
 * 加锁的读-改-写。mutator 会拿到当前 JSON（不存在/坏掉时是 fallback），返回新对象。
 * 锁文件 `<file>.lock`（wx 原子创建）；拿不到就退避重试；超过 staleMs 的锁视为死锁回收。
 *
 * @param {string} file
 * @param {(current:any) => any} mutator
 * @param {{ fallback?: any, retries?: number, retryMs?: number, staleMs?: number, mode?: number }} [options]
 * @returns {any} 写入后的新对象
 */
export function updateJson(file, mutator, {
  fallback = null,
  retries = 50,
  retryMs = 20,
  staleMs = 10_000,
  mode = 0o600,
} = {}) {
  const lockFile = `${file}.lock`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let fd = null
    try {
      fd = fs.openSync(lockFile, 'wx')
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // 锁被占：先看是不是上一个进程被杀留下的过期锁
      try {
        const st = fs.statSync(lockFile)
        if (Date.now() - st.mtimeMs > staleMs) fs.rmSync(lockFile, { force: true })
      } catch {}
      if (attempt < retries) sleepSync(retryMs + Math.min(180, attempt * 8))
      continue
    }
    try {
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })) } catch {}
      const current = readJsonLoose(file, fallback)
      const next = mutator(current)
      writeJsonAtomic(file, next, { mode })
      return next
    } finally {
      try { fs.closeSync(fd) } catch {}
      try { fs.rmSync(lockFile, { force: true }) } catch {}
    }
  }
  throw new Error(`updateJson: 等锁超时（${lockFile}）`)
}
