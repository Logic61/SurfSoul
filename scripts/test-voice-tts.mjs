// 本地 TTS 客户端的行为测试：不联网、不依赖 voxd（用本地 http server 冒充）。
//
// 覆盖：正常合成落盘、按内容复用、超时/未启动的可读错误、非 200 透传 detail、空文本拒绝。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { synthesizeToFile, ttsKey, wavDurationMs, pruneCache } from '../src/voice-tts.js';

const WAV = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(60, 0) // 44 字节以上的假 wav 就够（客户端只判长度）
]);

/** 造一个带正确 RIFF 头的 wav（用来验 wavDurationMs）。 */
function makeWav(seconds, sr) {
  const n = Math.round(sr * seconds);
  const data = Buffer.alloc(n * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-tts-test-'));
let calls = 0;

// ① 正常：返回 wav + 时长头；② 第二次同内容不再请求服务端
{
  const srv = await serve((req, res) => {
    calls += 1;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      assert.equal(j.text, '你好呀');
      assert.equal(j.format, 'wav');
      res.writeHead(200, { 'content-type': 'audio/wav', 'x-duration-ms': '1234', 'x-cached': '0' });
      res.end(WAV);
    });
  });
  const a = await synthesizeToFile({ text: '你好呀', baseUrl: srv.url, outDir: dir });
  assert.equal(a.durationMs, 1234);
  assert.ok(fs.existsSync(a.path) && fs.statSync(a.path).size > 44);
  const b = await synthesizeToFile({ text: '你好呀', baseUrl: srv.url, outDir: dir });
  assert.equal(b.path, a.path);
  assert.equal(b.cached, true);
  assert.equal(calls, 1, '同内容应复用本地文件，不再打服务端');
  await srv.close();
}

// ③ 非 200：把服务端的 detail 透出来（模型据此改回打字）
{
  const srv = await serve((req, res) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: '引擎 piper 不可用' }));
  });
  await assert.rejects(
    () => synthesizeToFile({ text: '你好', baseUrl: srv.url, outDir: dir }),
    (e) => e.message.includes('502') && e.message.includes('引擎 piper 不可用')
  );
  await srv.close();
}

// ④ 服务没起来：错误要说人话
{
  await assert.rejects(
    () => synthesizeToFile({ text: '你好', baseUrl: 'http://127.0.0.1:1', outDir: dir, timeoutMs: 1500 }),
    (e) => e.message.includes('TTS')
  );
}

// ⑤ 空文本：本地就拒绝，不发请求
{
  await assert.rejects(() => synthesizeToFile({ text: '   ', outDir: dir }), /空的/);
}

// ⑥ wav 头解析：缓存命中时没有响应头，时长只能自己算
{
  const wav = makeWav(0.5, 24000);
  assert.equal(wavDurationMs(wav), 500);
  assert.equal(wavDurationMs(Buffer.from('RIFF')), 0, '坏文件返回 0，不能抛');
  const base = 'http://127.0.0.1:1';
  const key = ttsKey({ baseUrl: base, text: '缓存命中', character: '', voice: '', style: null });
  fs.writeFileSync(path.join(dir, `${key}.wav`), wav);
  const r = await synthesizeToFile({ text: '缓存命中', baseUrl: base, outDir: dir, timeoutMs: 500 });
  assert.equal(r.cached, true);
  assert.equal(r.durationMs, 500, '本地命中也要能报时长');
}

fs.rmSync(dir, { recursive: true, force: true });


// ⑦ 缓存清理：超过上限按最旧删，留下的必须是最新的那批
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-prune-'));
  for (let i = 0; i < 10; i += 1) {
    const f = path.join(d2, `f${i}.wav`);
    fs.writeFileSync(f, Buffer.alloc(1000));
    const t = new Date(Date.now() - (10 - i) * 60000);
    fs.utimesSync(f, t, t);
  }
  const r = pruneCache(d2, { maxFiles: 4, maxBytes: 1e9 });
  assert.equal(r.removed, 6);
  assert.deepEqual(fs.readdirSync(d2).sort(), ['f6.wav', 'f7.wav', 'f8.wav', 'f9.wav']);
  fs.rmSync(d2, { recursive: true, force: true });
}

// ⑧ 合成超时：必须抛结构化错误（code=TTS_TIMEOUT / statusCode=504），
//    桥接据此映射 HTTP 504 —— 2026-10-30 事故就是这里没标记，被中文正则兜底成 400。
{
  const srv = await serve((req, res) => {
    req.resume();
    // 故意拖过客户端 timeout；客户端放弃后服务端再回（模拟 voxd 合成完成）
    setTimeout(() => {
      try {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(WAV);
      } catch {}
    }, 800);
  });
  await assert.rejects(
    () => synthesizeToFile({ text: '超时验证', baseUrl: srv.url, outDir: dir, timeoutMs: 250 }),
    (e) => e.code === 'TTS_TIMEOUT' && e.statusCode === 504 && /合成超时/.test(e.message)
  );
  await srv.close();
}

// ⑨ 服务没起来：TTS_UNAVAILABLE / 502（桥接映射成 5xx，而不是 400）
{
  await assert.rejects(
    () => synthesizeToFile({ text: '断连验证', baseUrl: 'http://127.0.0.1:1', outDir: dir, timeoutMs: 800 }),
    (e) => e.code === 'TTS_UNAVAILABLE' && e.statusCode === 502 && /TTS/.test(e.message)
  );
}

// ⑩ voxd 非 2xx：TTS_HTTP_ERROR / 502，并把 detail 透传出来
{
  const srv = await serve((req, res) => {
    req.resume();
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: '引擎 piper 不可用' }));
  });
  await assert.rejects(
    () => synthesizeToFile({ text: '503 验证', baseUrl: srv.url, outDir: dir }),
    (e) => e.code === 'TTS_HTTP_ERROR' && e.statusCode === 502 && e.message.includes('引擎 piper 不可用')
  );
  await srv.close();
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('test-voice-tts: ok');
