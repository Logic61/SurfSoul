#!/usr/bin/env node
// watch-storyboard — 让 agent 真"看"一条 B站 视频，交出的是**可引用的分镜**：
//   取直链 → 下载 720p mp4 → 拉官方字幕 JSON → 调已安装的 dsh-video-storyboard 出
//   9 格分镜图 + 可寻址清单（每格编号/起止时间/frame@/台词）+ 音频包络条。
//
// 为什么加这条命令（2026-10-30）：`watch-video` 的九宫格没有编号/时间码/音频条，
//   模型只能"看图猜"，没法说"第 7 格"；分镜方法把「看结构 → 按格回看」变成两段式，
//   同一条视频的图片 token 从 ~3 张 968 降到 1 张 392（+ 文本清单）。
//   取流/凭据/字幕仍走 surfcore 自己的链路（不需要 yt-dlp / cookies.txt / ASR）。
//
// 依赖：ffmpeg（lib/ffmpeg.mjs）；可选依赖 dsh-video-storyboard（MIT，装在
//   ~/.dsh/plugins/dsh-video-storyboard）。**没装不会失败**：自动退回 bili-watch 九宫格。
//
// 用法与选项见 lib/watch-storyboard.mjs 的 USAGE（node bili.mjs watch-storyboard --help）。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { accountBili } from '../lib/state-paths.mjs'
import { requireFfmpeg } from '../lib/ffmpeg.mjs'
import { appendWatch } from '../lib/watch-history.mjs'
import { fetchWithTimeout, DEFAULT_HTTP_TIMEOUT_MS } from '../lib/http-timeout.mjs'
import {
  USAGE, parseArgs, gridForCells, resolveStoryboardCli, buildStoryboardArgs,
  storyboardPaths, pickSubtitleJson, parseStoryboardStdout, summaryLines,
} from '../lib/watch-storyboard.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const QN = { 16: '360P', 32: '480P', 64: '720P', 80: '1080P' }
const line = (text = '') => console.log(text)
const warn = (text) => console.error(text)

function usageError(err) {
  if (err?.code !== 'EUSAGE') throw err
  warn(`参数错误: ${err.message}\n`)
  warn(USAGE)
  process.exit(2)
}

async function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (err) { usageError(err) }
  if (opts.help) { line(USAGE); return }

  let ffmpeg
  try { ffmpeg = requireFfmpeg() } catch (err) { warn(String(err.message)); process.exit(2) }
  const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  const hasFfprobe = fs.existsSync(ffprobe)
  const storyboardCli = resolveStoryboardCli({ explicit: opts.storyboardCli })

  const outDir = opts.outDir || path.join(HOME, '.dsh', 'shots', 'video')
  const subsOutDir = opts.subsOutDir || path.join(HOME, '.dsh', 'shots', 'subs')
  fs.mkdirSync(outDir, { recursive: true })

  // ── ① B站元信息 + 直链（和 bili-watch 同一套：platform=pc & qn=80 → 720p mp4）
  const cred = JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8'))
  const H = {
    'user-agent': UA,
    referer: `https://www.bilibili.com/video/${opts.bvid}/`,
    cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
  }
  const jget = async (url) => (await fetchWithTimeout(url, { headers: H }, DEFAULT_HTTP_TIMEOUT_MS)).json()

  const view = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${opts.bvid}`)
  if (view.code !== 0) { warn(`view 失败 code=${view.code} ${view.message}`); process.exit(3) }
  const { aid, cid, title, duration, tname } = view.data
  const owner = view.data.owner ?? {}
  line(`标题: ${title}`)
  line(`UP: ${owner.name ?? ''}   时长: ${duration}s   cid=${cid}`)

  // 窗口参数先按真实时长校正（CLI 对越界窗口会退化成最后一格，静默又难查）
  if (opts.from >= duration) { warn(`--from ${opts.from}s 超出视频时长 ${duration}s`); process.exit(2) }
  if (opts.to > duration) opts.to = duration

  const play = await jget(`https://api.bilibili.com/x/player/playurl?bvid=${opts.bvid}` +
    `&cid=${cid}&qn=80&fnval=1&platform=pc&high_quality=1`)
  const directUrl = play.data?.durl?.[0]?.url
  if (!directUrl) { warn(`没拿到直链（code=${play.code}）——有些视频要登录或只有 dash 流`); process.exit(4) }
  line(`实际画质: ${QN[play.data.quality] ?? String(play.data.quality ?? '?')}`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const paths = storyboardPaths({ outDir, bvid: opts.bvid, stamp, cells: opts.cells })

  const download = await fetch(directUrl, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', range: 'bytes=0-' } })
  if (!download.ok) { warn(`下载失败 HTTP ${download.status}`); process.exit(5) }
  fs.writeFileSync(paths.mp4, Buffer.from(await download.arrayBuffer()))
  line(`已下载: ${paths.mp4}  (${(fs.statSync(paths.mp4).size / 1024 / 1024).toFixed(2)} MB)`)

  // ── ② 官方字幕 → JSON（给 transcriptFile；拿不到就只出画面，不阻断）
  let subtitleJson = null
  if (!opts.noSubs) {
    try {
      const stdout = execFileSync(
        process.execPath,
        [path.join(HERE, 'subtitles.mjs'), opts.bvid, '--lan', opts.lan, '--out', subsOutDir, '--print', '0'],
        { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      )
      subtitleJson = pickSubtitleJson({ stdout, subsDir: subsOutDir, bvid: opts.bvid })
    } catch (err) {
      warn(`（官方字幕没拿到，继续出画面分镜：${String(err?.message ?? err).split('\n')[0]}）`)
    }
    if (subtitleJson) line(`官方字幕: ${subtitleJson}`)
    else warn('（这视频没有可用官方字幕轨 → 分镜只出画面，台词层留空）')
  }

  // ── ③ 主路径：dsh-video-storyboard 出分镜；没装则降级九宫格（不阻断）
  if (!storyboardCli) {
    line('')
    line('[fallback] 没找到 dsh-video-storyboard CLI（~/.dsh/plugins/… 或 SURFCORE_STORYBOARD_CLI）')
    line('           先跑九宫格版；装插件后这条命令会自动升级成「编号分镜 + 可寻址清单」。')
    line('           安装：node ~/.dsh/plugins/dsh-video-storyboard/scripts/install-dev.mjs')
    const fallback = spawnSync(
      process.execPath,
      [path.join(HERE, 'bili-watch.mjs'), opts.bvid, gridForCells(opts.cells), outDir],
      { stdio: 'inherit' },
    )
    if (opts.from || opts.to) warn('（--from/--to 只在分镜模式生效，降级九宫格时忽略）')
    process.exit(fallback.status ?? 1)
  }

  const args = buildStoryboardArgs({
    mp4: paths.mp4,
    cells: opts.cells,
    from: opts.from,
    to: opts.to,
    sheet: paths.sheet,
    manifest: paths.manifest,
    transcriptFile: subtitleJson,
    detail: opts.detail,
  })
  let stdout = ''
  let rendered = true
  try {
    stdout = execFileSync(process.execPath, [storyboardCli, ...args], {
      encoding: 'utf8',
      timeout: 540_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, DSH_FFMPEG_PATH: ffmpeg, ...(hasFfprobe ? { DSH_FFPROBE_PATH: ffprobe } : {}) },
    })
  } catch (err) {
    rendered = false
    const detail = String(err?.stderr ?? err?.message ?? err).split('\n').slice(0, 8).join('\n')
    warn(`分镜生成失败（保留原片 ${paths.mp4}，可手动重跑）：\n${detail}`)
    process.exit(7)
  }
  fs.writeFileSync(paths.index, stdout, 'utf8')
  const meta = parseStoryboardStdout(stdout)
  if (meta.plan) line(meta.plan)
  if (meta.scan) line(meta.scan)
  if (meta.audio) line(meta.audio)
  if (meta.transcript) line(meta.transcript)

  line('')
  for (const text of summaryLines({
    sheet: paths.sheet, manifest: paths.manifest, index: paths.index,
    transcript: subtitleJson ? 'file（官方字幕，已对齐到每格）' : 'off（无官方字幕，只有画面）',
    title, duration, cells: opts.cells,
  })) line(text)

  // 清单预览：agent 不读 INDEX 也能先看到前几格的编号/时间，避免"知道有清单但不去读"
  const preview = stdout.split(/\r?\n/).filter((l) => /^\s*cell \d+ /.test(l) || /^<storyboard /.test(l))
  if (preview.length) {
    line('')
    line('--- 清单预览（前 12 行；全文见 INDEX）---')
    for (const row of preview.slice(0, 12)) line(row.trimEnd())
    if (preview.length > 12) line(`…（其余 ${preview.length - 12} 行在 INDEX 里）`)
  }

  // ── ④ 观看历史（被 debrief 之类父进程调用时不重复记账）
  if (!process.env.SURFCORE_WATCH_PARENT && !opts.noHistory) {
    const record = appendWatch({
      at: new Date().toISOString(),
      bvid: opts.bvid,
      aid: String(aid ?? ''),
      title,
      up: owner.name ?? '',
      upMid: owner.mid ?? '',
      duration,
      tname: tname ?? '',
      mode: 'frames',
      frames: true,
      source: 'watch-storyboard',
      sheet: rendered ? paths.sheet : '',
      subs: subtitleJson ?? '',
    })
    if (record.ok) line(`[观看历史] 已记一笔：${opts.bvid}（分镜）`)
  }
  line(`（原片留着: ${paths.mp4}；换参数重出不必重新下载）`)
}

main().catch((err) => {
  warn(`watch-storyboard 失败: ${String(err?.stack ?? err)}`)
  process.exit(1)
})
