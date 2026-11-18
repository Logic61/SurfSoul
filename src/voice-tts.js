// 本地 TTS 客户端：把一段文字变成「能交给 sendVoiceV2 的本地音频文件」。
//
// 只做一件事，且失败要**可读**——桥接那层会把它翻译成 502 交给模型，
// 模型据此决定「改回打字」而不是编一句「我发了语音」。
//
// 与 voxd 的契约见 ../voice/README.md：POST /v1/speak/file → wav 字节，
// X-Duration-Ms 是时长（毫秒），X-Cached 表示是否命中服务端缓存。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readDshCredential } from './web-search.js';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';

// 2026-11-15：DeepSeek 官方 TTS（POST /v1/tools/tts，Bearer 鉴权，直接返回 wav 字节）。
// 桥接原本只会打本地 voxd 的 /v1/speak/file，这两个接口路径和鉴权都不同，
// 所以按 baseUrl 认服务：指向 api.deepseek.com 时走 DeepSeek，其余仍走 voxd。
// character 在 DeepSeek 这里就是音色（stella 女声 / tide 男声），默认 stella。
export function isDeepSeekTts(baseUrl) {
  return /^https?:\/\/([a-z0-9-]+\.)*api\.deepseek\.com(:\d+)?(\/|$)/i.test(String(baseUrl ?? '').trim());
}

function deepseekTtsKey() {
  return String(process.env.DEEPSEEK_API_KEY ?? '').trim() || readDshCredential('DEEPSEEK_API_KEY');
}

function deepseekVoiceId(character, voice) {
  const want = String(voice || character || '').trim().toLowerCase();
  return want === 'stella' || want === 'tide' ? want : 'stella';
}

/**
 * 抛给调用方（桥接/桌宠）的可分类错误。
 *
 * 为什么必须带 code/statusCode：桥接历史上靠中文正则 `/语音合成|TTS/` 猜 HTTP 状态码，
 * 而超时文案是「合成超时（>60s）」——不含那两个词，被兜底成 400（docs §10.6 #5）。
 * 只改文案不可靠（以后换个说法又坏），错误类型必须结构化。
 */
function ttsFailure(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/** 按内容寻址：同一句话重复发不会在磁盘上堆文件（voxd 端也有缓存）。 */
export function ttsKey({ baseUrl, text, character, voice, style, cacheVersion }) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify([baseUrl, cacheVersion ?? null, text, character ?? null, voice ?? null, style ?? null]))
    .digest('hex');
}

/** 从 wav 头算时长（本地命中缓存时没有响应头可用）。坏文件返回 0，不抛。 */
export function wavDurationMs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return 0;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 20 <= buf.length) byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') {
      if (!byteRate) return 0;
      // DeepSeek 流式返回的 wav 会把 data 长度写成 0xFFFFFFFF（占位），
      // 直接拿它算会得到「几十万小时」。以实际剩余字节为准。
      const actual = buf.length - (off + 8);
      const usable = !size || size > actual ? actual : size;
      if (!usable) return 0;
      return Math.round((usable / byteRate) * 1000);
    }
    off += 8 + size + (size % 2);
  }
  return 0;
}

/**
 * DeepSeek 的 wav 是流式吐出来的，头里的 RIFF/data 长度是 0xFFFFFFFF 占位。
 * 存盘前按实际字节补正，免得下游解码器（QQ 转 silk）读不出长度直接放弃。
 */
export function fixWavLengths(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return buf;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const actual = buf.length - (off + 8);
      if (!size || size > actual) buf.writeUInt32LE(actual, off + 4);
      buf.writeUInt32LE(buf.length - 8, 4);
      return buf;
    }
    if (size > buf.length - off - 8) break;
    off += 8 + size + (size % 2);
  }
  return buf;
}

/**
 * @returns {Promise<{path:string,durationMs:number,cached:boolean}>}
 * @throws  Error（message 已可直接展示给模型/操作者）
 */
export async function synthesizeToFile({
  text,
  character = '',
  voice = '',
  style = null,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 60000,
  cacheVersion = null,
  outDir,
  fetchImpl = fetch
} = {}) {
  const say = String(text ?? '').trim();
  if (!say) throw ttsFailure('要合成的内容是空的', 'TTS_EMPTY_TEXT', 400);
  if (!outDir) throw ttsFailure('缺少 outDir（TTS 缓存目录）', 'TTS_INTERNAL', 500);
  fs.mkdirSync(outDir, { recursive: true });

  const url = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const key = ttsKey({ baseUrl: url, text: say, character, voice, style, cacheVersion });
  const file = path.join(outDir, `${key}.wav`);
  if (fs.existsSync(file)) {
    const st = fs.statSync(file);
    if (st.size > 44) return { path: file, durationMs: wavDurationMs(fs.readFileSync(file)), cached: true };
  }

  const viaDeepSeek = isDeepSeekTts(url);
  const dskey = viaDeepSeek ? deepseekTtsKey() : '';
  if (viaDeepSeek && !dskey) {
    throw ttsFailure('没有可用的 DeepSeek API key（DEEPSEEK_API_KEY）', 'TTS_NO_KEY', 502);
  }

  let res;
  try {
    if (viaDeepSeek) {
      const body = { text: say, voice_id: deepseekVoiceId(character, voice), format: 'wav', filter_markdown: true };
      res = await fetchImpl(`${url}/v1/tools/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${dskey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } else {
      const body = { text: say, format: 'wav', sr: 24000, cache: true };
      if (character) body.character = String(character);
      if (voice) body.voice = String(voice);
      if (style && typeof style === 'object') body.style = style;
      res = await fetchImpl(`${url}/v1/speak/file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    }
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError';
    const hint = timedOut
      ? `合成超时（>${Math.round(timeoutMs / 1000)}s）`
      : viaDeepSeek
        ? 'DeepSeek TTS 连不上'
        : 'TTS 服务没起来（voxd 是否在运行？）';
    throw ttsFailure(`${hint}：${error?.message ?? error}`, timedOut ? 'TTS_TIMEOUT' : 'TTS_UNAVAILABLE', timedOut ? 504 : 502);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.detail ?? (typeof j?.error === 'string' ? j.error : j?.error?.message) ?? j?.message ?? '';
    } catch {}
    throw ttsFailure(`TTS 服务返回 ${res.status}${detail ? `：${detail}` : ''}`, 'TTS_HTTP_ERROR', 502);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (viaDeepSeek) fixWavLengths(buf);
  if (buf.length <= 44) throw ttsFailure('TTS 返回了空音频', 'TTS_EMPTY_AUDIO', 502);

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  pruneCache(outDir);

  const dur = Number(res.headers.get('x-duration-ms')) || wavDurationMs(buf);
  return { path: file, durationMs: dur, cached: res.headers.get('x-cached') === '1' };
}

/**
 * 合成缓存是有上限的：按字节数寻址意味着**每句新话都多一个文件**，长期跑会长到几万个。
 * 这里按 mtime 从旧到新删，直到回到水位以下（默认 400 个 / 150MB）。
 * 失败一律吞掉——缓存清理绝不能影响"这条语音能不能发出去"。
 */
export function pruneCache(dir, { maxFiles = 400, maxBytes = 150 * 1024 * 1024 } = {}) {
  let entries;
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.wav'))
      .map((e) => {
        const p = path.join(dir, e.name);
        try {
          const st = fs.statSync(p);
          return { p, size: st.size, at: st.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return { removed: 0, files: 0, bytes: 0 };
  }
  let total = entries.reduce((n, e) => n + e.size, 0);
  let count = entries.length;
  if (count <= maxFiles && total <= maxBytes) return { removed: 0, files: count, bytes: total };

  entries.sort((a, b) => a.at - b.at);
  let removed = 0;
  for (const e of entries) {
    if (count <= maxFiles && total <= maxBytes) break;
    try {
      fs.unlinkSync(e.p);
      count -= 1;
      total -= e.size;
      removed += 1;
    } catch {}
  }
  return { removed, files: count, bytes: total };
}
