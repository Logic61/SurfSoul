/**
 * watch-storyboard 的纯逻辑（可单测；不碰网络 / ffmpeg / 插件进程）。
 *
 * 为什么单独抽出来：这条命令的价值全在「参数对、产物名对、找不到插件能降级」，
 * 这些都能离线断言；真跑一回 B站 下载 + 视频扫描太贵，不适合当回归测试。
 *
 * 约定：
 *   · 本文件只做 parse/拼装/查找/摘要，任何 fs 读都走参数注入或 try/catch；
 *   · 真正的网络/子进程都在 tools/commands/watch-storyboard.mjs。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const STORYBOARD_PKG = 'dsh-video-storyboard'
export const DEFAULT_CELLS = 9
export const MAX_CELLS = 16
export const DEFAULT_DETAIL = 'med'
export const ALLOWED_DETAIL = ['low', 'med', 'high']
export const DEFAULT_LAN = 'ai-zh'

/** cells → bili-watch 的 `3x3` 写法（插件缺失时降级用；不是每一项都有整格布局）。 */
const GRID_BY_CELLS = { 1: '1x1', 2: '2x1', 4: '2x2', 6: '3x2', 9: '3x3', 12: '4x3', 16: '4x4' }
export function gridForCells(cells) {
  const n = Number.isInteger(Number(cells)) ? Number(cells) : DEFAULT_CELLS
  const clamped = Math.min(MAX_CELLS, Math.max(1, n))
  return GRID_BY_CELLS[clamped] ?? '3x3'
}

export const USAGE = `用法: node bili.mjs watch-storyboard <BV> [选项]

选项:
  --cells N          分镜格数 1~16（默认 ${DEFAULT_CELLS}；大视频建议 9，读字用 4）
  --from 秒          只看这一段（配合 --to；长片/追剧情用）
  --to 秒
  --detail low|med|high   清单里每格台词长度（默认 ${DEFAULT_DETAIL}；high=400 字）
  --lan ai-zh        官方字幕语言（默认 ${DEFAULT_LAN}）
  --no-subs          不拉官方字幕（只出画面分镜）
  --download-only    只下载 + 取字幕，打印 MP4:/SUBS: 两个路径后退出（给原生 video_storyboard 工具用）
  --out 目录         原片/分镜图落盘目录（默认 ~/.dsh/shots/video）
  --subs-out 目录    字幕 JSON 落盘目录（默认 ~/.dsh/shots/subs）
  --storyboard-cli   显式指定 dsh-video-storyboard 的 bin/storyboard.mjs
  --no-history       不写 watch-history.jsonl（调试/试看用）
  -h, --help

说明:
  · 分镜出图/清单由已安装的 ${STORYBOARD_PKG} 提供（MIT）；
    没装也不会报错——自动退回 bili-watch 九宫格，并把原因写在第一行。
  · 看图后请按「第 N 格」引用（清单里带每格起止时间与 frame@）；要读小字用
    --from/--to --cells 4 重出，不要重抽全片。
  · 本机装了 dsh-video-storyboard 的原生工具时，推荐两步走：
    \`watch-storyboard <BV> --download-only\` → \`video_storyboard({input: MP4, transcriptFile: SUBS})\`，
    图直接进模型上下文，还能用 \`video_zoom({cellId})\` 按格回看。`

function fail(message) {
  const error = new Error(message)
  error.code = 'EUSAGE'
  throw error
}

/**
 * 解析 CLI 参数。`--` 形式的未知参数直接报错（避免拼错却静默走默认值）。
 * @param {string[]} argv 不含 node/脚本名
 */
export function parseArgs(argv = []) {
  const opts = {
    bvid: '',
    cells: DEFAULT_CELLS,
    from: 0,
    to: 0,
    detail: DEFAULT_DETAIL,
    lan: DEFAULT_LAN,
    noSubs: false,
    noHistory: false,
    downloadOnly: false,
    outDir: '',
    subsOutDir: '',
    storyboardCli: '',
    help: false,
  }
  const positional = []
  const takeValue = (name, i) => {
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) fail(`${name} 需要一个值`)
    return value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true
        break
      case '--cells': {
        const value = Number(takeValue('--cells', i))
        i += 1
        if (!Number.isInteger(value) || value < 1 || value > MAX_CELLS) fail(`--cells 应为 1~${MAX_CELLS} 的整数`)
        opts.cells = value
        break
      }
      case '--from': {
        const value = Number(takeValue('--from', i))
        i += 1
        if (!Number.isFinite(value) || value < 0) fail('--from 应为 ≥0 的秒数')
        opts.from = value
        break
      }
      case '--to': {
        const value = Number(takeValue('--to', i))
        i += 1
        if (!Number.isFinite(value) || value < 0) fail('--to 应为 ≥0 的秒数')
        opts.to = value
        break
      }
      case '--detail': {
        const value = takeValue('--detail', i)
        i += 1
        if (!ALLOWED_DETAIL.includes(value)) fail(`--detail 应为 ${ALLOWED_DETAIL.join('|')}`)
        opts.detail = value
        break
      }
      case '--lan':
        opts.lan = takeValue('--lan', i)
        i += 1
        break
      case '--out':
        opts.outDir = takeValue('--out', i)
        i += 1
        break
      case '--subs-out':
        opts.subsOutDir = takeValue('--subs-out', i)
        i += 1
        break
      case '--storyboard-cli':
        opts.storyboardCli = takeValue('--storyboard-cli', i)
        i += 1
        break
      case '--no-subs':
        opts.noSubs = true
        break
      case '--no-history':
        opts.noHistory = true
        break
      case '--download-only':
        opts.downloadOnly = true
        break
      default:
        if (arg.startsWith('--')) fail(`未知参数: ${arg}（跑 --help 看清单）`)
        positional.push(arg)
    }
  }
  const bvid = positional.find((x) => /^BV[0-9A-Za-z]{10}$/.test(x)) ?? positional[0] ?? ''
  if (!opts.help) {
    if (!bvid) fail('缺少 BV 号')
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) fail(`BV 号格式不对: ${bvid}`)
  }
  opts.bvid = bvid
  if (opts.from > 0 && opts.to > 0 && opts.to <= opts.from) fail('--to 要大于 --from')
  return opts
}

/**
 * 找已安装的 dsh-video-storyboard CLI（照 install-dev 的布局，不猜包管理器）。
 * 顺序：显式参数 → 环境变量 → $DSH_HOME/plugins → ~/.dsh/plugins → npm 全局。
 * @returns {string|null}
 */
export function resolveStoryboardCli({
  env = process.env,
  home = os.homedir(),
  exists = fs.existsSync,
  explicit = '',
} = {}) {
  const dshHome = env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || home, '.dsh')
  const candidates = [
    explicit,
    env.SURFCORE_STORYBOARD_CLI,
    path.join(dshHome, 'plugins', STORYBOARD_PKG, 'bin', 'storyboard.mjs'),
    path.join(home, '.dsh', 'plugins', STORYBOARD_PKG, 'bin', 'storyboard.mjs'),
    env.APPDATA ? path.join(env.APPDATA, 'npm', 'node_modules', STORYBOARD_PKG, 'bin', 'storyboard.mjs') : '',
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (exists(candidate)) return candidate
    } catch { /* 单个候选探测失败不阻断 */ }
  }
  return null
}

/** 拼 dsh-video-storyboard CLI 的参数（保持和 bin/storyboard.mjs 的 flag 一致）。 */
export function buildStoryboardArgs({
  mp4, cells = DEFAULT_CELLS, from = 0, to = 0, sheet, manifest, transcriptFile = null, detail = DEFAULT_DETAIL,
}) {
  if (!mp4) throw new Error('buildStoryboardArgs: 缺少 mp4')
  if (!sheet) throw new Error('buildStoryboardArgs: 缺少 sheet')
  const args = [
    mp4,
    '--cells', String(cells),
    '--out', sheet,
    '--detail', detail,
    '--text',
  ]
  if (manifest) args.push('--manifest', manifest)
  if (transcriptFile) args.push('--transcript-file', transcriptFile)
  if (Number(from) > 0) args.push('--from', String(Number(from)))
  if (Number(to) > 0) args.push('--to', String(Number(to)))
  return args
}

/** 产物命名：同一 bvid 每次跑一份，不互相覆盖；stamp 由调用方给（可测）。 */
export function storyboardPaths({ outDir, bvid, stamp, cells = DEFAULT_CELLS }) {
  if (!outDir) throw new Error('storyboardPaths: 缺少 outDir')
  const base = `${bvid}-${stamp}-storyboard-${cells}`
  return {
    mp4: path.join(outDir, `${bvid}-${stamp}.mp4`),
    sheet: path.join(outDir, `${base}.png`),
    manifest: path.join(outDir, `${base}.json`),
    index: path.join(outDir, `${base}-index.txt`),
  }
}

/** 从 subtitles.mjs 的 stdout 或字幕目录里找回「官方字幕 JSON」路径（给 transcriptFile 用）。 */
export function pickSubtitleJson({ stdout = '', subsDir = '', bvid = '', exists = fs.existsSync, readdir = fs.readdirSync, stat = fs.statSync } = {}) {
  // ① stdout 里 "JSON : <path>（原始）"
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = /^JSON\s*:\s*(.+?)(?:（原始）)?\s*$/.exec(line.trim())
    if (!match) continue
    const candidate = match[1].trim()
    try { if (exists(candidate)) return candidate } catch { /* 下一个 */ }
  }
  // ② 目录里最新一份 `<bvid>-*.json`
  if (!subsDir || !bvid) return null
  let names = []
  try { names = readdir(subsDir) } catch { return null }
  const hits = names
    .filter((name) => name.startsWith(`${bvid}-`) && name.endsWith('.json'))
    .map((name) => {
      const full = path.join(subsDir, name)
      let mtime = 0
      try { mtime = stat(full).mtimeMs } catch { /* 忽略 */ }
      return { full, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
  return hits[0]?.full ?? null
}

/** 从 CLI stdout 里抽几行给摘要（不解析整份清单，清单本身落盘给 read 用）。 */
export function parseStoryboardStdout(stdout = '') {
  const text = String(stdout)
  const pick = (label) => {
    const line = text.split(/\r?\n/).find((l) => l.trim().startsWith(`[${label}]`))
    return line ? line.trim() : ''
  }
  const tag = /<storyboard[^>]*>/.exec(text)?.[0] ?? ''
  const attr = (name) => {
    const m = new RegExp(`${name}="([^"]*)"`).exec(tag)
    return m ? m[1] : ''
  }
  return {
    plan: pick('plan'),
    scan: pick('scan'),
    audio: pick('audio'),
    transcript: pick('transcript'),
    sheet: pick('sheet'),
    done: pick('done'),
    image: attr('image'),
    tokens: attr('tokens'),
  }
}

/** `--download-only` 的收尾：把两个路径交给 agent，下一步直接调原生 video_storyboard。 */
export function downloadOnlyLines({ mp4, subs, title, duration }) {
  const lines = [`MP4 : ${mp4}`]
  if (subs) lines.push(`SUBS: ${subs}`)
  else lines.push('SUBS: （无官方字幕；调原生工具时不要传 transcriptFile）')
  lines.push('下一步：`video_storyboard({ input: <MP4>, transcriptFile: <SUBS>, cells: 9, detail: "med" })`'
    + '；引用画面说「第 N 格」，读细节用 `video_zoom({ input: <MP4>, cellId: N, cells: 4 })`。')
  if (title) lines.push(`（${title}${duration ? ` · ${duration}s` : ''}）`)
  return lines
}

/** 给 agent 看的收尾摘要（marker 风格和 debrief 的 SHEET:/SUBS: 保持一致）。 */
export function summaryLines({
  sheet, manifest, index, transcript, title, duration, cells, fallback = false,
}) {
  const lines = []
  lines.push(`STORYBOARD: ${sheet}`)
  lines.push(`MANIFEST  : ${manifest}`)
  lines.push(`INDEX     : ${index}（完整可寻址清单：cell 号 + 起止时间 + frame@ + 台词；长片用 read 分页读）`)
  if (transcript) lines.push(`TRANSCRIPT: ${transcript}`)
  lines.push(`（${fallback ? '插件缺失，已降级为九宫格' : `分镜 ${cells} 格`}；`
    + `引用画面请说「第 N 格」，frame@ 是取帧瞬间、不是格起点；`
    + `要读小字/界面细节用 --from/--to --cells 4 重出，别重抽全片）`)
  if (title) lines.push(`（${title}${duration ? ` · ${duration}s` : ''}）`)
  return lines
}
