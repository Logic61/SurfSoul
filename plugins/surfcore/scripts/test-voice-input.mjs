import assert from 'node:assert/strict';
import { transcribe, fastVoiceReply } from '../lib/voice-input.js';

const keyFor = () => 'offline-test';
const signal = AbortSignal.timeout(3000);
const wav = Buffer.alloc(364);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
let requests = 0;
const original = globalThis.fetch;
try {
  globalThis.fetch = async (url, opts) => {
    requests++;
    assert.equal(opts.signal, signal);
    assert.equal(opts.headers.Authorization, 'Bearer offline-test');
    if (url.endsWith('/asr')) {
      const input = opts.body.get('file');
      assert.deepEqual(Buffer.from(await input.arrayBuffer()), wav);
      return Response.json({ text:' 三加四？ ' });
    }
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.thinking.type, 'disabled');
    assert.equal(body.messages[1].content, '三加四？');
    return Response.json({ choices:[{ message:{ content:'七。' } }], usage:{ prompt_tokens:16, completion_tokens:2 } });
  };
  assert.equal(await transcribe(wav.toString('base64'), keyFor, signal), '三加四？');
  await assert.rejects(transcribe('abcd', keyFor, signal), /PCM WAV/);
  await assert.rejects(transcribe(wav.toString('base64'), () => '', signal), /密钥/);
  const result = await fastVoiceReply({ system:'测试', user:'三加四？', maxTokens:100 }, keyFor, signal);
  assert.equal(result.text, '七。'); assert.equal(result.usage.outputTokens, 2);
  assert.equal(requests, 2);
} finally { globalThis.fetch = original; }
console.log('PASS speech format, transcription, credentials, low-reasoning chat and usage.');
