// 账本原子写 + 跨进程锁回归（2026-10-30，P1-9）。
//
// 覆盖：
//   ① writeJsonAtomic：落盘内容正确、不留 tmp 残留、原子替换（读到的永远是完整 JSON）
//   ② updateJson：读-改-写；过期锁会被回收；并发下不丢更新
//   ③ 并发真进程：8 个 quota.mjs record 同时跑 → quota.json 的 log 必须恰好 8 条
//      （旧实现是「各自 load → push → save」，后写者覆盖先写者 → 大概率 <8）
//   ④ quota check 的 fail-closed 语义没被改坏：账本 JSON 坏掉仍退出 2
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeJsonAtomic, updateJson } from '../tools/lib/atomic-json.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-tools-ledger-'))
let passed = 0
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`) }

// ── ① 原子写 ────────────────────────────────────────────────────────────────
{
  const file = path.join(tmp, 'state', 'demo.json')
  writeJsonAtomic(file, { a: 1, list: ['x'] })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, list: ['x'] })
  writeJsonAtomic(file, { a: 2 })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2 })
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], `不应留下临时文件，实际：${leftovers.join(',')}`)
  ok('writeJsonAtomic 落盘正确且无 tmp 残留')
}

// ── ② updateJson：基本读写 / 过期锁回收 / 锁文件清理 ──────────────────────────
{
  const file = path.join(tmp, 'state', 'counter.json')
  updateJson(file, (cur) => ({ n: (cur?.n ?? 0) + 1 }), { fallback: {} })
  updateJson(file, (cur) => ({ n: (cur?.n ?? 0) + 1 }), { fallback: {} })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 2)

  // 故意留一个 60 秒前的过期锁：updateJson 应该回收它而不是一直等
  const lock = `${file}.lock`
  fs.writeFileSync(lock, '{"pid":1}')
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lock, old, old)
  updateJson(file, (cur) => ({ n: (cur?.n ?? 0) + 1 }), { fallback: {}, staleMs: 5_000 })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 3)
  assert.equal(fs.existsSync(lock), false, '锁文件应在写完后释放')
  ok('updateJson 读改写 + 过期锁回收 + 锁释放')
}

// ── ③ 并发真进程：8 × quota record ──────────────────────────────────────────
const dshHome = path.join(tmp, 'dsh-home')
const quotaFile = path.join(dshHome, 'surfcore', 'bili', 'quota.json')
const env = { ...process.env, DSH_HOME: dshHome }
function runNode(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...env, ...extraEnv }, windowsHide: true })
    let err = ''
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('close', (code) => resolve({ code, err }))
  })
}
{
  const N = 8
  const quotaCli = path.join(ROOT, 'tools', 'commands', 'quota.mjs')
  const runs = await Promise.all(Array.from({ length: N }, () => runNode([quotaCli, 'record', '--type', 'comment', '--target', 'BV:TEST'])))
  const failed = runs.filter((r) => r.code !== 0)
  assert.deepEqual(failed.map((r) => r.code), [], `record 不应失败：${failed.map((r) => r.err).join('|')}`)
  const ledger = JSON.parse(fs.readFileSync(quotaFile, 'utf8'))
  assert.equal(ledger.log.length, N, `并发 ${N} 次 record 应全部落账，实际 ${ledger.log.length} 条`)
  ok(`并发 ${N} 个 quota record 全部落账（无丢更新）`)
}

// ── ④ fail-closed 语义没被改坏 ─────────────────────────────────────────────
{
  fs.writeFileSync(quotaFile, '{ 这不是 JSON')
  const r = await runNode([path.join(ROOT, 'tools', 'commands', 'quota.mjs'), 'check', '--type', 'comment', '--auto'])
  assert.equal(r.code, 2, `账本损坏时 check 必须退出 2（实际 ${r.code}）`)
  ok('账本损坏时 quota check 仍然 fail-closed（退出码 2）')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n✅ 账本原子写/并发锁测试通过（${passed} 项）`)
