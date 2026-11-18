// 临时：抓某个 UP 主的空间投稿列表（WBI 签名 + cookie）。用法: node space-arc.mjs <mid> [页数]
import { accountBili } from './lib/state-paths.mjs'
import fs from 'node:fs'
import crypto from 'node:crypto'

const mid = process.argv[2]
const pages = Number(process.argv[3] ?? 3)
if (!mid) { console.error('用法: node space-arc.mjs <mid> [页数]'); process.exit(2) }

const cred = JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const H = { 'user-agent': UA, referer: `https://space.bilibili.com/${mid}/video`, cookie }
const jget = async (u) => (await fetch(u, { headers: H })).json()

const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
const nav = await jget('https://api.bilibili.com/x/web-interface/nav')
const raw = keyOf(nav.data?.wbi_img?.img_url ?? '') + keyOf(nav.data?.wbi_img?.sub_url ?? '')
const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
const clean = (v) => String(v).replace(/[!'()*]/g, '')
function wbi(params) {
  const wts = Math.round(Date.now() / 1000)
  const q = Object.keys({ ...params, wts }).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : params[k]))}`).join('&')
  return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`
}

const info = await jget(`https://api.bilibili.com/x/space/wbi/acc/info?${wbi({ mid })}`)
console.log(`UP: ${info.data?.name}  mid=${mid}  签名=${(info.data?.sign ?? '').replace(/\n/g, ' / ')}`)
console.log(`粉丝=${info.data?.fans}  关注=${info.data?.attention}  code=${info.code} ${info.message ?? ''}`)

for (let pn = 1; pn <= pages; pn++) {
  const qs = wbi({
    mid, ps: 30, pn, order: 'pubdate',
  })
  const d = await jget(`https://api.bilibili.com/x/space/wbi/arc/search?${qs}`)
  const list = d.data?.list?.vlist ?? []
  console.log(`\n===== 第 ${pn} 页  code=${d.code} ${d.message ?? ''}  共 ${d.data?.page?.count ?? '?'} 条  本页 ${list.length} =====`)
  if (!list.length) { console.log(JSON.stringify(d).slice(0, 300)); break }
  for (const r of list) {
    console.log(`[${r.bvid}] ${new Date((r.created ?? 0) * 1000).toISOString().slice(0, 10)} 播放=${r.play} 弹幕=${r.video_review} 评论=${r.comment} 时长=${r.length}  ${r.title}`)
  }
}
