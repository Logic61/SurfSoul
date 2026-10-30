// memctl —— 甘棠自己的「记忆 / 说话习惯」修改入口（2026-10-29 主人要求）
//
// 背景：主人经常在 QQ 上顺口说「这句太冲了」「以后别用括号」「记住我讨厌 X」。
// 只口头答应没有用：下一轮她又忘了。所以给她两条**可以自己动手**的通道：
//
//   style —— `<角色目录>/style-notes.md`，一行一条 `- 文本`。
//            桥接每轮都读它、紧跟在记忆卡后面注入（和记忆冲突时以它为准），
//            所以「说话方式」的修正写这里立刻生效，不需要重启任何进程。
//
//   mem   —— 往 `memory-inbox.jsonl` 追加一条「主人在私聊里说的」事件。
//            插件每 10 分钟摄入一次，按主人消息计权（重要度 ≥ minOwnerImportance），
//            于是它会变成记忆卡里一条真正的记忆。
//
// 用法（在 owner 私聊里，她有本地工具）：
//   node scripts/memctl.mjs style add "别用括号写内心戏"
//   node scripts/memctl.mjs style list
//   node scripts/memctl.mjs style rm 3
//   node scripts/memctl.mjs mem add "羽不吃香菜，别再问他要不要放"
//   node scripts/memctl.mjs mem recent 8
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  activeMemoryPaths, activePersonaFile,
} from '../src/character-persona.js'
import {
  resolveMemoryCardPaths, appendMemoryInboxEvent, loadMemoryCard, normalizeCard,
} from '../src/memory-card.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const today = () => new Date().toLocaleDateString('sv-SE')

function styleFile() {
  return path.join(path.dirname(activePersonaFile()), 'style-notes.md')
}

function readStyleLines() {
  try {
    return fs.readFileSync(styleFile(), 'utf8').split(/\r?\n/).filter((line) => line.trim().startsWith('- '))
  } catch {
    return []
  }
}

function ownerQQ() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
    return String(cfg.ownerQQ ?? cfg.admin ?? '').trim()
  } catch {
    return ''
  }
}

const [group, action, ...rest] = argv
const text = rest.join(' ').trim()

if (group === 'style') {
  const file = styleFile()
  if (action === 'list' || !action) {
    const lines = readStyleLines()
    if (!lines.length) console.log('（还没有现场修正）')
    else lines.forEach((line, i) => console.log(`${String(i + 1).padStart(2)}. ${line.replace(/^-\s*/, '')}`))
    console.log(`\n文件：${file}`)
    process.exit(0)
  }
  if (action === 'add') {
    if (!text) { console.error('用法：memctl style add "一句话"'); process.exit(1) }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 已经有一条一样的就不重复写（他常一句话说两遍）
    if (readStyleLines().some((line) => line.replace(/^-\s*/, '').includes(text))) {
      console.log(`已经有了，没重复写：${text}`)
      process.exit(0)
    }
    fs.appendFileSync(file, `- ${today()} ${text.replace(/\s*\n\s*/g, ' ')}\n`, 'utf8')
    console.log(`记下了（下一轮消息就生效）：${text}`)
    process.exit(0)
  }
  if (action === 'rm') {
    const n = Number(text)
    const lines = readStyleLines()
    if (!Number.isInteger(n) || n < 1 || n > lines.length) {
      console.error(`编号不对；现有 ${lines.length} 条，用 style list 看编号`)
      process.exit(1)
    }
    const keep = lines.filter((_, i) => i + 1 !== n)
    fs.writeFileSync(file, keep.length ? `${keep.join('\n')}\n` : '', 'utf8')
    console.log(`删掉了第 ${n} 条：${lines[n - 1].replace(/^-\s*/, '')}`)
    process.exit(0)
  }
  console.error('用法：memctl style list | add "…" | rm <编号>')
  process.exit(1)
}

if (group === 'mem') {
  const paths = resolveMemoryCardPaths(activeMemoryPaths().dir)
  if (action === 'recent') {
    const n = Math.min(30, Math.max(1, Number(text) || 8))
    const card = normalizeCard(loadMemoryCard(paths))
    const recs = [...card.records]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, n)
    for (const r of recs) {
      console.log(`${String(r.createdAt).slice(0, 10)}  重要度${String(r.importance ?? '?').padStart(3)}  ${String(r.text).slice(0, 60)}`)
    }
    console.log(`\n共 ${card.records.length} 条；目录：${paths.dir}`)
    process.exit(0)
  }
  if (action === 'add') {
    if (!text) { console.error('用法：memctl mem add "一句话"'); process.exit(1) }
    const qq = ownerQQ()
    const ok = appendMemoryInboxEvent(paths, {
      text,
      sender: '羽',
      senderId: qq,
      isOwner: true,
      kind: 'private',
      private: true,
      direct: true,
      conversationKey: qq ? `private:${qq}` : '',
    })
    console.log(ok
      ? `排进记忆收件箱了（插件 10 分钟内并入记忆卡）：${text}`
      : '没写进去（文本为空或命中脱敏规则）')
    process.exit(ok ? 0 : 1)
  }
  console.error('用法：memctl mem recent [n] | add "…"')
  process.exit(1)
}

console.log('memctl —— 改她自己的记忆 / 说话习惯\n  memctl style list | add "…" | rm <编号>\n  memctl mem recent [n] | add "…"')
