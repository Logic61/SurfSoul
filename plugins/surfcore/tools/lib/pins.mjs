// 「今天这条动态用哪个视频」的钦定表（2026-10-21 加）
//
// 为什么要有：管理员会先看候选再拍板。他说"就发这条"之后，脚本要**照办**，
//   而不是等她晚上自己从候选池里再挑一次（很可能挑成别的）。
//
// 数据：~/.dsh/surfcore/bili/dynamic-pins.json
//   { "2026-10-21": { "gaming": "BV1Menj62Eig", "game": "BV15Dng6rEPw" } }
import { biliState } from './state-paths.mjs'
import fs from 'node:fs'
// 2026-10-30（P1-9）：跨进程锁 + 原子写，避免并发 setPin/clearPin 丢更新。
import { writeJsonAtomic, updateJson } from './atomic-json.mjs'

export const FILE = biliState('dynamic-pins.json')
const today = () => new Date().toLocaleDateString('sv-SE')

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} }
}

function trimDays(all) {
  const keys = Object.keys(all).sort().slice(-10)
  const trimmed = {}
  for (const k of keys) trimmed[k] = all[k]
  return trimmed
}

function save(o) {
  try {
    writeJsonAtomic(FILE, o)
  } catch {}
}

/** 今天这一类钦定了哪个 BV（没有就 ''） */
export function pinOf(kind, date = today()) {
  return String(load()?.[date]?.[kind] ?? '')
}

/** 管理员对这条动态的"要点"（会原样塞进她的唤醒提示） */
export function noteOf(kind, date = today()) {
  return String(load()?.[date]?.[`_note_${kind}`] ?? '')
}

export function setNote(kind, text, date = today()) {
  let result = null
  updateJson(FILE, (all) => {
    all[date] = { ...(all[date] ?? {}), [`_note_${kind}`]: String(text ?? '') }
    const trimmed = trimDays(all)
    result = trimmed[date]
    return trimmed
  }, { fallback: {} })
  return result
}

/** 钦定一条（kind = best|game|anime|gaming） */
export function setPin(kind, bv, date = today()) {
  let result = null
  updateJson(FILE, (all) => {
    all[date] = { ...(all[date] ?? {}), [kind]: String(bv) }
    const trimmed = trimDays(all)
    result = trimmed[date]
    return trimmed
  }, { fallback: {} })
  return result
}

/** 清掉某类的钦定（发出去之后调，免得明天还认） */
export function clearPin(kind, date = today()) {
  updateJson(FILE, (all) => {
    const day = all?.[date]
    if (!day) return all
    let changed = false
    if (day[kind] !== undefined) { delete day[kind]; changed = true }
    if (day[`_note_${kind}`] !== undefined) { delete day[`_note_${kind}`]; changed = true }
    if (!changed) return all
    return trimDays(all)
  }, { fallback: {} })
}
