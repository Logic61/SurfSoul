// 出站身份闸覆盖面回归（2026-10-30，P1-10）。
//
// 背景：闸门是「调用点约定」而不是「发送原语」，之前只有 comment / dynamic / dm /
// share-dynamic 接了。daily 的转发、edit-dynamic、danmaku、dynamic-image 四个公开出口
// 完全不过闸 → 一条含主人 QQ / 别人 mid 的动态发出去就收不回。
//
// 覆盖：
//   ① 闸门本身：受保护 ID（主人 QQ / owner mid / 对齐表里的 id）出现在文本里要抛错，
//      干净文本放行
//   ② 静态接线：4 个公开出口的源码里必须调用 assertOutboundIdentitySafe
//   ③ dynamic-image 的 @ mid 也要过受保护身份检查（collectProtectedIdentities）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertOutboundIdentitySafe, collectProtectedIdentities,
} from '../tools/lib/outbound-guard.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMMANDS = path.join(ROOT, 'tools', 'commands')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-outbound-'))
let passed = 0
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`) }

// ── ① 闸门正反例（临时 surfcoreDir，不碰真实配置） ─────────────────────────
{
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ admin: { qq: '12345678' } }))
  fs.writeFileSync(path.join(tmp, 'bili.config.json'), JSON.stringify({ owner: { mid: '99887766' }, self: { mid: '11112222' } }))
  fs.writeFileSync(path.join(tmp, 'alignments.json'), JSON.stringify({
    links: [{ identities: { qq: { id: '55556666' }, bili: { id: '77778888' } } }],
  }))
  const ids = collectProtectedIdentities({ surfcoreDir: tmp })
  assert.ok(ids.includes('12345678') && ids.includes('99887766') && ids.includes('55556666'), `受保护 ID 收集不对：${ids.join(',')}`)
  assert.ok(!ids.includes('11112222'), '自己的 B站 mid 不应被当成受保护（公开资料）')

  for (const [label, text] of [
    ['主人 QQ', '有事加我 QQ 12345678'],
    ['主人 B站 mid', '我主人是 space.bilibili.com/99887766'],
    ['对齐表里的别人', '那个 55556666 又来了'],
  ]) {
    assert.throws(() => assertOutboundIdentitySafe(text, { surface: '测试', surfcoreDir: tmp }), undefined, `${label} 应该被拦`)
  }
  assert.equal(assertOutboundIdentitySafe('今天看了个视频 BV1xx411c7mD，挺好看的', { surface: '测试', surfcoreDir: tmp }).ok, true)
  ok('闸门正反例正确（主人 QQ / owner mid / 对齐表 id 被拦，正文放行）')
}

// ── ② 4 个公开出口必须接线 ─────────────────────────────────────────────────
{
  const required = ['daily.mjs', 'edit-dynamic.mjs', 'danmaku.mjs', 'dynamic-image.mjs']
  for (const name of required) {
    const source = fs.readFileSync(path.join(COMMANDS, name), 'utf8')
    assert.ok(/assertOutboundIdentitySafe/.test(source), `${name} 必须调用 assertOutboundIdentitySafe`)
  }
  ok('4 个公开出口都已接出站身份闸（daily / edit-dynamic / danmaku / dynamic-image）')
}

// ── ③ dynamic-image 的 @mid 也过闸 ────────────────────────────────────────
{
  const source = fs.readFileSync(path.join(COMMANDS, 'dynamic-image.mjs'), 'utf8')
  assert.ok(/collectProtectedIdentities\(\)/.test(source), 'dynamic-image 必须检查 @ 的 mid 是否受保护')
  ok('dynamic-image 的 --at mid 走受保护身份检查')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n✅ 出站身份闸覆盖面测试通过（${passed} 项）`)
