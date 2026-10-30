/**
 * watch-storyboard 纯逻辑回归（2026-10-30，C-1）：
 *   · 参数解析：默认值、--cells 范围、--from/--to 校验、未知参数报错；
 *   · 插件定位顺序（显式 / env / DSH_HOME / ~/.dsh / npm 全局）与缺失返回 null；
 *   · 拼 CLI 参数（--transcript-file / --from / --to / --manifest）；
 *   · 产物命名与降级格表；
 *   · 字幕 JSON 回收（stdout 优先，目录兜底）与清单摘要解析。
 *
 * 全程临时目录 + 假 fs，不联网、不 spawn ffmpeg、不读真实凭据。
 * 运行：node scripts/test-watch-storyboard.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  parseArgs, gridForCells, resolveStoryboardCli, buildStoryboardArgs,
  storyboardPaths, pickSubtitleJson, parseStoryboardStdout, summaryLines,
  DEFAULT_CELLS,
} from '../tools/lib/watch-storyboard.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-watch-sb-'))

// ── 1. 参数解析 ─────────────────────────────────────────────────────────────
assert.deepEqual(
  { ...parseArgs(['BV1q8no6rE3Q']) },
  {
    bvid: 'BV1q8no6rE3Q', cells: DEFAULT_CELLS, from: 0, to: 0, detail: 'med',
    lan: 'ai-zh', noSubs: false, noHistory: false, outDir: '', subsOutDir: '',
    storyboardCli: '', help: false,
  },
  '默认值',
)
const parsed = parseArgs([
  'BV1q8no6rE3Q', '--cells', '4', '--from', '120', '--to', '180',
  '--detail', 'high', '--no-subs', '--no-history', '--out', 'D:/o', '--subs-out', 'D:/s',
  '--lan', 'zh-CN', '--storyboard-cli', 'D:/x/storyboard.mjs',
])
assert.equal(parsed.cells, 4)
assert.equal(parsed.from, 120)
assert.equal(parsed.to, 180)
assert.equal(parsed.detail, 'high')
assert.equal(parsed.noSubs, true)
assert.equal(parsed.noHistory, true)
assert.equal(parsed.outDir, 'D:/o')
assert.equal(parsed.subsOutDir, 'D:/s')
assert.equal(parsed.lan, 'zh-CN')
assert.equal(parsed.storyboardCli, 'D:/x/storyboard.mjs')

for (const bad of [
  [], ['not-a-bv'], ['BV1q8no6rE3Q', '--cells', '0'], ['BV1q8no6rE3Q', '--cells', '17'],
  ['BV1q8no6rE3Q', '--cells', '2.5'], ['BV1q8no6rE3Q', '--from', '-1'],
  ['BV1q8no6rE3Q', '--from', '100', '--to', '100'], ['BV1q8no6rE3Q', '--detail', 'huge'],
  ['BV1q8no6rE3Q', '--nope', '1'],
]) {
  assert.throws(() => parseArgs(bad), (err) => err.code === 'EUSAGE', `应拒绝: ${JSON.stringify(bad)}`)
}
assert.equal(parseArgs(['-h']).help, true, '--help 不需要 BV')
assert.equal(parseArgs(['foo', 'BV1q8no6rE3Q']).bvid, 'BV1q8no6rE3Q', '位置参数里取合法 BV')
console.log('parseArgs OK')

// ── 2. cells → 降级格表 ─────────────────────────────────────────────────────
assert.equal(gridForCells(9), '3x3')
assert.equal(gridForCells(16), '4x4')
assert.equal(gridForCells(6), '3x2')
assert.equal(gridForCells(3), '3x3', '非整格数走默认')
assert.equal(gridForCells(99), '4x4', '越界夹到 16 并用 4x4')
assert.equal(gridForCells(0), '1x1', '0 夹到 1')
console.log('gridForCells OK')

// ── 3. 插件定位顺序 ─────────────────────────────────────────────────────────
const pluginBin = path.join(tmp, '.dsh', 'plugins', 'dsh-video-storyboard', 'bin', 'storyboard.mjs')
fs.mkdirSync(path.dirname(pluginBin), { recursive: true })
fs.writeFileSync(pluginBin, '// fixture\n')
const home = tmp
const found = resolveStoryboardCli({ env: { USERPROFILE: home, HOME: home }, home, explicit: '' })
assert.equal(found, pluginBin, '从 ~/.dsh/plugins 找到')
const viaExplicit = resolveStoryboardCli({ env: {}, home, exists: (p) => p === 'D:/explicit/storyboard.mjs', explicit: 'D:/explicit/storyboard.mjs' })
assert.equal(viaExplicit, 'D:/explicit/storyboard.mjs', '显式参数优先')
const viaDshHome = resolveStoryboardCli({
  env: { DSH_HOME: path.join(tmp, 'alt') }, home,
  exists: (p) => p === path.join(tmp, 'alt', 'plugins', 'dsh-video-storyboard', 'bin', 'storyboard.mjs'),
})
assert.ok(viaDshHome && viaDshHome.includes(path.join('alt', 'plugins')), 'DSH_HOME 优先于 ~/.dsh')
assert.equal(resolveStoryboardCli({ env: {}, home: path.join(tmp, 'empty'), exists: () => false }), null, '缺失返回 null')
console.log('resolveStoryboardCli OK')

// ── 4. 拼 CLI 参数 ─────────────────────────────────────────────────────────
const args = buildStoryboardArgs({
  mp4: 'D:/v.mp4', cells: 9, from: 0, to: 0, sheet: 'D:/s.png', manifest: 'D:/m.json',
  transcriptFile: 'D:/subs.json', detail: 'med',
})
assert.deepEqual(args, [
  'D:/v.mp4', '--cells', '9', '--out', 'D:/s.png', '--detail', 'med', '--text',
  '--manifest', 'D:/m.json', '--transcript-file', 'D:/subs.json',
])
const windowed = buildStoryboardArgs({
  mp4: 'v', cells: 4, from: 120, to: 180, sheet: 's', manifest: null, transcriptFile: null,
})
assert.deepEqual(windowed, ['v', '--cells', '4', '--out', 's', '--detail', 'med', '--text', '--from', '120', '--to', '180'])
assert.throws(() => buildStoryboardArgs({ mp4: '', sheet: 's' }), /缺少 mp4/)
console.log('buildStoryboardArgs OK')

// ── 5. 产物命名 ─────────────────────────────────────────────────────────────
const paths = storyboardPaths({ outDir: 'D:/out', bvid: 'BV1q8no6rE3Q', stamp: '2026-10-30T12-00-00-000Z', cells: 9 })
assert.equal(paths.mp4, path.join('D:/out', 'BV1q8no6rE3Q-2026-10-30T12-00-00-000Z.mp4'))
assert.equal(paths.sheet, path.join('D:/out', 'BV1q8no6rE3Q-2026-10-30T12-00-00-000Z-storyboard-9.png'))
assert.equal(paths.manifest, path.join('D:/out', 'BV1q8no6rE3Q-2026-10-30T12-00-00-000Z-storyboard-9.json'))
assert.equal(paths.index, path.join('D:/out', 'BV1q8no6rE3Q-2026-10-30T12-00-00-000Z-storyboard-9-index.txt'))
console.log('storyboardPaths OK')

// ── 6. 字幕 JSON 回收 ───────────────────────────────────────────────────────
const subsDir = path.join(tmp, 'subs')
fs.mkdirSync(subsDir, { recursive: true })
const realJson = path.join(subsDir, 'BV1q8no6rE3Q-ai-zh.json')
fs.writeFileSync(realJson, '{"body":[]}')
const oldJson = path.join(subsDir, 'BV1q8no6rE3Q-zh-CN.json')
fs.writeFileSync(oldJson, '{"body":[]}')
const now = Date.now()
fs.utimesSync(oldJson, new Date(now - 60_000), new Date(now - 60_000))
fs.utimesSync(realJson, new Date(now), new Date(now))
assert.equal(
  pickSubtitleJson({ stdout: `JSON : ${realJson}（原始）\n`, subsDir, bvid: 'BV1q8no6rE3Q' }),
  realJson, 'stdout 里的路径优先',
)
assert.equal(
  pickSubtitleJson({ stdout: 'no subtitle here', subsDir, bvid: 'BV1q8no6rE3Q' }),
  realJson, '目录兜底取最新一份',
)
assert.equal(pickSubtitleJson({ stdout: '', subsDir, bvid: 'BV0000000000' }), null, '没有就 null')
assert.equal(pickSubtitleJson({ stdout: 'JSON : D:/missing.json', subsDir: '', bvid: 'BV1q8no6rE3Q' }), null, '不存在的 stdout 路径不采信')
console.log('pickSubtitleJson OK')

// ── 7. 清单解析 + 摘要 ─────────────────────────────────────────────────────
const stdout = [
  '[probe] 1280x720 30.00fps 286.68s audio',
  '[scan] 8598 帧 → 95 个切点（阈值 12，自适应 11 个密集段）',
  '[plan] 9 格 × 1 张 — explicit',
  '[audio] mean -17 LUFS',
  '[transcript] file (file:srt)，139 段',
  '[sheet] /x/sheet-9.png  1009x620  3x3',
  '[done] 11761ms',
  '',
  '<storyboard path="v.mp4" image="1009x620" grid="9 cells x 1 image(s)" tokens="384 (est@384/img)">',
  'cell 1 (r1c1) = 00:00.00-00:24.13 frame@00:23.88 cuts 11',
  'cell 2 (r1c2) = 00:24.13-00:41.53 frame@00:24.38 cuts 10',
].join('\n')
const meta = parseStoryboardStdout(stdout)
assert.equal(meta.plan, '[plan] 9 格 × 1 张 — explicit')
assert.equal(meta.transcript, '[transcript] file (file:srt)，139 段')
assert.equal(meta.image, '1009x620')
assert.equal(meta.tokens, '384 (est@384/img)')
assert.equal(parseStoryboardStdout('').plan, '')

const lines = summaryLines({
  sheet: '/x/sheet-9.png', manifest: '/x/m.json', index: '/x/i.txt',
  transcript: 'file', title: '标题', duration: 286, cells: 9,
})
assert.ok(lines[0].startsWith('STORYBOARD: /x/sheet-9.png'))
assert.ok(lines.some((l) => l.startsWith('MANIFEST  :')))
assert.ok(lines.some((l) => l.startsWith('INDEX     :') && l.includes('cell')))
assert.ok(lines.some((l) => l.includes('第 N 格')))
assert.ok(lines.some((l) => l.includes('标题')), '带标题')
assert.ok(summaryLines({ sheet: 's', manifest: 'm', index: 'i', cells: 9, fallback: true })
  .some((l) => l.includes('降级')))
console.log('parseStoryboardStdout / summaryLines OK')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('watch-storyboard tests OK')
