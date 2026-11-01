// 快速生图（src/imagegen.js）的纯逻辑 + 注入式服务测试：不联网、不碰真实凭据。
//
// 覆盖最容易被改坏的几处：配置归一、密钥解析优先级、请求体形态、b64/url 两种响应解析、
// 文件头校验、落盘命名与清理、外部错误文本的可读性。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_IMAGE_GEN_CONFIG,
  buildImageGenRequestBody,
  extractImageFromResponse,
  findCredentialInYamlText,
  generateImageNow,
  imageGenErrorText,
  imageGenQuotaStatus,
  normalizeImageGenConfig,
  recordImageGenTime,
  resolveImageGenApiKey,
  saveGeneratedImage,
  sniffImageExt,
} from '../src/imagegen.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const JPG = Buffer.from('ffd8ffe000104a4649460001010000010001', 'hex')
const GIF = Buffer.from('47494638396101000100800000000000', 'hex')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)])
const TEXT = Buffer.from('this is definitely not an image file', 'utf8')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-imagegen-'))
}

test('配置归一：缺省/坏值回退默认，显式值生效', () => {
  const def = normalizeImageGenConfig(undefined)
  assert.equal(def.enabled, true)
  assert.equal(def.model, DEFAULT_IMAGE_GEN_CONFIG.model)
  assert.equal(def.size, '1024x1024')
  assert.equal(def.apiKeyEnv, 'AGNES_API_KEY')
  // 2026-11-01 主人要求「允许群聊画图」：群聊默认有配额，主人私聊放宽（0=不限）。
  assert.deepEqual(def.group, { enabled: true, maxPerHour: 3, maxPerDay: 10 })
  assert.deepEqual(def.owner, { enabled: true, maxPerHour: 20, maxPerDay: 100 })

  const custom = normalizeImageGenConfig({
    enabled: false, baseUrl: 'https://example.com/v1/', model: 'my-image-model', size: '1536x1024',
    apiKeyEnv: 'OTHER_KEY', timeoutMs: 9999999, maxPromptChars: 0, keepDays: -3, outputDir: '',
    group: { enabled: false, maxPerHour: 1, maxPerDay: 0 },
    owner: { maxPerHour: -5, maxPerDay: 99999999 },
  })
  assert.equal(custom.enabled, false)
  assert.equal(custom.baseUrl, 'https://example.com/v1')
  assert.equal(custom.model, 'my-image-model')
  assert.equal(custom.size, '1536x1024')
  assert.equal(custom.apiKeyEnv, 'OTHER_KEY')
  assert.equal(custom.timeoutMs, 600000, 'timeoutMs 上限 600s')
  assert.equal(custom.maxPromptChars, 1, 'maxPromptChars 下限 1')
  assert.equal(custom.keepDays, 0)
  assert.equal(custom.outputDir, DEFAULT_IMAGE_GEN_CONFIG.outputDir)
  assert.deepEqual(custom.group, { enabled: false, maxPerHour: 1, maxPerDay: 0 }, '0 = 不限要保留')
  assert.deepEqual(custom.owner, { enabled: true, maxPerHour: 0, maxPerDay: 5000 }, '坏值/上限收敛')

  const bad = normalizeImageGenConfig({ baseUrl: 'not-a-url', model: 'bad model!', size: 'huge' })
  assert.equal(bad.baseUrl, DEFAULT_IMAGE_GEN_CONFIG.baseUrl, '非法 baseUrl 回退默认')
  assert.equal(bad.model, DEFAULT_IMAGE_GEN_CONFIG.model)
  assert.equal(bad.size, DEFAULT_IMAGE_GEN_CONFIG.size)
})

test('会话配额：小时/日窗口、0=不限、retryAfterMs、记账裁剪（群聊画图放开后的成本边界）', () => {
  const now = new Date('2026-11-01T12:00:00').getTime()
  const hour = 60 * 60 * 1000
  assert.equal(imageGenQuotaStatus([], { now, maxPerHour: 3 }).ok, true)
  assert.equal(imageGenQuotaStatus([now - hour / 2, now - hour / 4], { now, maxPerHour: 3 }).ok, true)

  const hourFull = imageGenQuotaStatus([now - hour / 2, now - hour / 4, now - hour / 3], { now, maxPerHour: 3 })
  assert.equal(hourFull.ok, false)
  assert.equal(hourFull.reason, 'hour')
  assert.ok(hourFull.retryAfterMs > 0 && hourFull.retryAfterMs <= hour, '应给出等待到最早一条移出窗口的时间')

  // 日限：2 小时前/3 小时前的记录不在小时窗口内，但计入 24 小时窗口
  const dayFull = imageGenQuotaStatus([now - 2 * hour, now - 3 * hour], { now, maxPerHour: 3, maxPerDay: 2 })
  assert.equal(dayFull.ok, false)
  assert.equal(dayFull.reason, 'day')

  assert.equal(imageGenQuotaStatus([now, now, now, now], { now, maxPerHour: 0, maxPerDay: 0 }).ok, true, '0=不限')
  assert.equal(imageGenQuotaStatus([null, undefined, NaN, 'x', now], { now, maxPerHour: 2 }).ok, true, '非法时间戳忽略')

  const recorded = recordImageGenTime([now - 8 * 24 * hour, now - hour], now)
  assert.deepEqual(recorded, [now - hour, now], '只留 7 天内并追加本次')
  const capped = recordImageGenTime(Array.from({ length: 300 }, (_, i) => now - i), now, 50)
  assert.equal(capped.length, 50)
  assert.equal(capped[capped.length - 1], now)
})

test('密钥解析优先级：config.apiKey > 环境变量 > DSH 凭据 > 空', () => {
  assert.equal(resolveImageGenApiKey({ config: { apiKey: 'direct' }, env: { AGNES_API_KEY: 'env' } }), 'direct')
  assert.equal(resolveImageGenApiKey({ config: {}, env: { AGNES_API_KEY: ' env ' }, credentialLookup: () => 'store' }), 'env')
  assert.equal(resolveImageGenApiKey({ config: {}, env: {}, credentialLookup: (name) => (name === 'AGNES_API_KEY' ? 'store' : '') }), 'store')
  assert.equal(resolveImageGenApiKey({ config: {}, env: {} }), '')
  assert.equal(resolveImageGenApiKey({ config: {}, env: {}, credentialLookup: () => { throw new Error('boom') } }), '', '凭据读取异常按未配置处理')
  // 自定义 apiKeyEnv 的名字要透传
  assert.equal(resolveImageGenApiKey({ config: { apiKeyEnv: 'OTHER' }, env: { OTHER: 'x' } }), 'x')
})

test('请求体：默认模型/尺寸 + 合法 override + 非法 override 静默回退 + prompt 校验', () => {
  const def = buildImageGenRequestBody({}, { prompt: '一只鲸鱼' })
  assert.equal(def.model, 'agnes-image-2.5-flash')
  assert.equal(def.size, '1024x1024')
  assert.equal(def.prompt, '一只鲸鱼')
  assert.equal(def.n, 1)

  const over = buildImageGenRequestBody({}, { prompt: 'x', model: 'agnes-image-2.0-flash', size: '1536x1024' })
  assert.equal(over.model, 'agnes-image-2.0-flash')
  assert.equal(over.size, '1536x1024')

  const bad = buildImageGenRequestBody({}, { prompt: 'x', model: 'bad model!', size: 'huge' })
  assert.equal(bad.model, 'agnes-image-2.5-flash', '非法 model 回退默认（不把任意字符串发给外部 API）')
  assert.equal(bad.size, '1024x1024')

  assert.throws(() => buildImageGenRequestBody({}, { prompt: '   ' }), /prompt 不能为空/)
  assert.throws(() => buildImageGenRequestBody({ maxPromptChars: 5 }, { prompt: '123456' }), /prompt 过长/)
})

test('响应解析：b64_json / url / 缺失', () => {
  assert.deepEqual(
    extractImageFromResponse({ data: [{ b64_json: 'AAAA', revised_prompt: 'rev' }] }),
    { kind: 'b64', data: 'AAAA', revisedPrompt: 'rev' },
  )
  assert.deepEqual(
    extractImageFromResponse({ data: [{ url: 'https://x/y.png' }] }),
    { kind: 'url', data: 'https://x/y.png', revisedPrompt: '' },
  )
  assert.equal(extractImageFromResponse({ data: [] }), null)
  assert.equal(extractImageFromResponse({ data: [{ url: 'javascript:alert(1)' }] }), null)
  assert.equal(extractImageFromResponse(null), null)
})

test('文件头识别', () => {
  assert.equal(sniffImageExt(PNG), 'png')
  assert.equal(sniffImageExt(JPG), 'jpg')
  assert.equal(sniffImageExt(GIF), 'gif')
  assert.equal(sniffImageExt(WEBP), 'webp')
  assert.equal(sniffImageExt(TEXT), null)
  assert.equal(sniffImageExt(Buffer.alloc(0)), null)
})

test('错误文本：OpenAI 形状 / 纯文本 / 空', () => {
  assert.equal(imageGenErrorText(503, JSON.stringify({ error: { message: 'auth_not_found: no auth available' } })), 'auth_not_found: no auth available（HTTP 503）')
  assert.equal(imageGenErrorText(502, JSON.stringify({ error: 'boom' })), 'boom（HTTP 502）')
  assert.equal(imageGenErrorText(500, 'plain text'), 'plain text（HTTP 500）')
  assert.equal(imageGenErrorText(504, ''), 'HTTP 504')
})

test('generateImageNow：b64 响应成功 + 请求形状正确', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'rp' }] }),
    }
  }
  const out = await generateImageNow({ config: {}, prompt: '鲸鱼', apiKey: 'k', fetchImpl })
  assert.equal(out.ext, 'png')
  assert.equal(out.revisedPrompt, 'rp')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${DEFAULT_IMAGE_GEN_CONFIG.baseUrl}/images/generations`)
  assert.equal(calls[0].init.headers.authorization, 'Bearer k')
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.prompt, '鲸鱼')
  assert.equal(sent.model, DEFAULT_IMAGE_GEN_CONFIG.model)
})

test('generateImageNow：url 响应会二次下载；非图片/超限被拒', async () => {
  let downloadHit = false
  const fetchUrl = async (url) => {
    if (String(url).endsWith('/images/generations')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ url: 'https://cdn.example.com/a.jpg' }] }) }
    }
    downloadHit = true
    return { ok: true, status: 200, arrayBuffer: async () => JPG }
  }
  const out = await generateImageNow({ config: {}, prompt: 'x', apiKey: 'k', fetchImpl: fetchUrl })
  assert.equal(out.ext, 'jpg')
  assert.equal(downloadHit, true)

  const badImage = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: TEXT.toString('base64') }] }) })
  await assert.rejects(() => generateImageNow({ config: {}, prompt: 'x', apiKey: 'k', fetchImpl: badImage }), /不是图片/)

  const oversize = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ b64_json: Buffer.concat([PNG, Buffer.alloc(2048)]).toString('base64') }] }),
  })
  await assert.rejects(
    () => generateImageNow({ config: { maxImageBytes: 1024 }, prompt: 'x', apiKey: 'k', fetchImpl: oversize }),
    /生成图太大/,
  )
})

test('generateImageNow：上游错误 / 无密钥 / 关闭开关都给可读错误', async () => {
  const errFetch = async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ error: { message: 'auth_not_found' } }) })
  await assert.rejects(
    () => generateImageNow({ config: {}, prompt: 'x', apiKey: 'k', fetchImpl: errFetch }),
    /auth_not_found（HTTP 503）/,
  )
  await assert.rejects(() => generateImageNow({ config: {}, prompt: 'x', apiKey: '', fetchImpl: errFetch }), /未配置生图密钥/)
  await assert.rejects(() => generateImageNow({ config: { enabled: false }, prompt: 'x', apiKey: 'k', fetchImpl: errFetch }), /已关闭/)
})

test('saveGeneratedImage：按约定命名落盘 + 清理过期文件', () => {
  const root = tmpRoot()
  try {
    const config = normalizeImageGenConfig({ outputDir: 'state/generated-images', keepDays: 7 })
    const now = new Date('2026-11-01T12:34:56')
    const out = saveGeneratedImage({ rootDir: root, config, buffer: PNG, now, randomSuffix: 'abc123' })
    assert.equal(out.filename, 'img-20261101-123456-abc123.png')
    assert.equal(out.ext, 'png')
    assert.equal(fs.readFileSync(out.path).length, PNG.length)

    // 过期文件（9 天前）应被清理；非本工具命名的文件不碰。
    const dir = path.dirname(out.path)
    const oldFile = path.join(dir, 'img-20261001-000000-dead.png')
    fs.writeFileSync(oldFile, PNG)
    fs.utimesSync(oldFile, new Date('2026-10-01T00:00:00'), new Date('2026-10-01T00:00:00'))
    const keepFile = path.join(dir, 'manual-note.png')
    fs.writeFileSync(keepFile, PNG)
    const out2 = saveGeneratedImage({ rootDir: root, config, buffer: JPG, now, randomSuffix: 'def456' })
    assert.equal(out2.ext, 'jpg')
    assert.equal(fs.existsSync(oldFile), false, '过期生成图应被清理')
    assert.equal(fs.existsSync(keepFile), true, '非本工具命名的文件不能被清理')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  assert.throws(() => saveGeneratedImage({ rootDir: tmpRoot(), config: {}, buffer: TEXT }), /不是图片/)
})

test('从 DSH 凭据 YAML 文本里找密钥（递归、找不到/坏 YAML 返回空）', () => {
  const yamlLoad = (text) => {
    // 这里用一个极简假解析器模拟 js-yaml 的嵌套结构（避免测试依赖 js-yaml 行为）。
    if (text.includes('BROKEN')) throw new Error('bad yaml')
    return { env: { NESTED: { AGNES_API_KEY: 'found-key' } }, other: { X: 'y' } }
  }
  assert.equal(findCredentialInYamlText('ok', 'AGNES_API_KEY', yamlLoad), 'found-key')
  assert.equal(findCredentialInYamlText('ok', 'MISSING', yamlLoad), '')
  assert.equal(findCredentialInYamlText('BROKEN', 'AGNES_API_KEY', yamlLoad), '')
  assert.equal(findCredentialInYamlText('', 'AGNES_API_KEY', yamlLoad), '')
  assert.equal(findCredentialInYamlText('ok', 'AGNES_API_KEY', null), '')
})
