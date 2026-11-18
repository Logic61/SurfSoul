// 临时：抓一条视频的完整弹幕（xml 接口，按时间排序）。用法: node danmaku-pull.mjs <BV> [最多条数]
import { accountBili } from './lib/state-paths.mjs'
import fs from 'node:fs'

const bvid = process.argv[2]
const max = Number(process.argv[3] ?? 400)
if (!bvid) { console.error('用法: node danmaku-pull.mjs <BV> [最多条数]'); process.exit(2) }

const cred = JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const H = { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/`, cookie }

const view = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: H })).json()
if (view.code !== 0) { console.log('view 失败', view.code, view.message); process.exit(1) }
const cid = view.data.cid
const title = view.data.title
const xml = await (await fetch(`https://comment.bilibili.com/${cid}.xml`, { headers: H })).text()
const rows = [...xml.matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)].map((m) => {
  const parts = m[1].split(',')
  return { t: Number(parts[0]), text: m[2] }
}).sort((a, b) => a.t - b.t)

console.log(`《${title}》 cid=${cid} 弹幕总数=${rows.length}`)
for (const r of rows.slice(0, max)) {
  const mm = String(Math.floor(r.t / 60)).padStart(2, '0')
  const ss = String(Math.floor(r.t % 60)).padStart(2, '0')
  console.log(`[${mm}:${ss}] ${r.text}`)
}
