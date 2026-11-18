// 临时：拉一条视频的热门评论（主楼 + 可选楼中楼）。用法: node comment-pull.mjs <BV> [页数]
import { accountBili } from './lib/state-paths.mjs'
import fs from 'node:fs'

const bvid = process.argv[2]
const pages = Number(process.argv[3] ?? 2)
if (!bvid) { console.error('用法: node comment-pull.mjs <BV> [页数]'); process.exit(2) }

const cred = JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const H = { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/`, cookie }
const jget = async (u) => (await fetch(u, { headers: H })).json()

const view = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
if (view.code !== 0) { console.log('view 失败', view.code, view.message); process.exit(1) }
const aid = view.data.aid
console.log(`《${view.data.title}》 aid=${aid} 评论数=${view.data.stat.reply}`)

for (let pn = 1; pn <= pages; pn++) {
  const d = await jget(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=20&pn=${pn}`)
  const list = d.data?.replies ?? []
  console.log(`\n===== 第 ${pn} 页 code=${d.code} 共 ${d.data?.page?.count ?? '?'} 条 本页 ${list.length} =====`)
  if (!list.length) { console.log(JSON.stringify(d).slice(0, 200)); break }
  for (const r of list) {
    const msg = String(r.content?.message ?? '').replace(/\n/g, ' / ')
    console.log(`\n👍${r.like}  ${r.member?.uname + " (mid=" + r.member?.mid + ")"}: ${msg}`)
    const subs = r.replies ?? []
    for (const s of subs.slice(0, 3)) {
      console.log(`    ↳ 👍${s.like} ${s.member?.uname + " (mid=" + s.member?.mid + ")"}: ${String(s.content?.message ?? '').replace(/\n/g, ' / ')}`)
    }
  }
}
