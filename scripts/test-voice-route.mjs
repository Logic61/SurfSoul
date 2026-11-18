// 走真实 bridge.js 的语音路由：text → voxd（本地假服务）→ record 段 → 网关（假）。
// 不连真 QQ、不碰真实 config；用来证明「AI 说一句」这条链路在代码层是通的。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

import { bridgeHarness } from './audit-bridge-harness.mjs';

function wav(seconds = 0.1, sr = 16000) {
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

const seen = [];
const tts = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push(JSON.parse(body || '{}'));
    if (!req.url.startsWith('/v1/speak/file')) {
      res.writeHead(404).end();
      return;
    }
    const buf = wav(seen.at(-1).text === '试试长一点' ? 0.65 : 0.1);
    res.writeHead(200, { 'content-type': 'audio/wav', 'x-duration-ms': '1500' });
    res.end(buf);
  });
});
await new Promise((r) => tts.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${tts.address().port}`;

const h = await bridgeHarness({
  config: {
    allow: { groups: ['456'], private: ['789'] },
    sendDelayMs: 15,
    socialV2: {
      send: { burstIntervalMinMs: 100 },
      mode: 'reserved2',
      voice: {
        enabled: true,
        maxPerMinute: 5,
        trigger: { who: 'anyone' },
        tts: {
          enabled: true,
          // 桥接解析顺序是 endpoints[route] > endpoints[默认 route] > baseUrl；
          // 只给 baseUrl 会被默认 127.0.0.1:8765 覆盖（本机只跑云端 8767 时直接 fetch failed）。
          baseUrl,
          route: 'local',
          endpoints: { local: baseUrl, cloud: baseUrl },
          maxChars: 20,
          character: 'huayan'
        }
      },
      tools: { sendVoice: true }
    }
  }
});

let server;
try {
  // ① text → 合成 → 本地 wav
  const r = await h.synthesizeVoiceText('来了来了', {});
  assert.ok(fs.existsSync(r.path), '应该落成本地文件');
  assert.equal(r.via, 'tts');
  assert.equal(fs.readFileSync(r.path).subarray(0, 4).toString(), 'RIFF', '必须是 wav');
  assert.ok(seen.length, '应该请求 TTS 服务');
  assert.equal(seen[0].text, '来了来了');
  assert.equal(seen[0].format, 'wav');
  assert.equal(seen[0].character, 'huayan', 'character 应该来自 voice.tts.character');

  // ② 发出去的是 record 段，不是文本
  const sent = await h.sendVoiceForV2('group:456', null, { resolved: r, verify: false });
  assert.equal(sent.key, 'group:456');
  const onebot = h.calls.http.filter((c) => c.url.endsWith('send_group_msg')).pop();
  assert.ok(onebot, '应该调用 send_group_msg');
  assert.equal(onebot.body.message[0].type, 'record');
  assert.equal(onebot.body.group_id, 456);

  // ③ 超长：给可读错误，而不是让模型猜
  await assert.rejects(() => h.synthesizeVoiceText('字'.repeat(30), {}), /最多 20 字/);

  h.setMode('reserved2');
  server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/socialV2/send-voice';
  const send = (key, text, token = h.getSocialV2State(key).agentToken) => fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': token, 'x-console-token': 'fixture-console-token' },
    body: JSON.stringify({ key, text, label: '不该盖掉原话' })
  });
  const prompt = async key => {
    await h.deliverPrompt(key, '', { wakeReason: 'question', silent: true });
    return h.calls.prompts.at(-1).content[0].text;
  };
  assert.equal(h.isSendToolName('mcp__snowluma__qq_send_voice'), true);
  assert.equal(h.isSendToolName('mcp__snowluma__qq_list_voices'), false);
  for (const key of ['group:456', 'private:789']) {
    const st = h.getSocialV2State(key);
    assert.match(await prompt(key), /qq_send_voice\(text\)/);
    assert.doesNotMatch(await prompt(key), /qq_send_voice\(text\)/);
    const previous = h.calls.http.length;
    const response = await send(key, '那我可听见了');
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.verified, true);
    const sends = h.calls.http.slice(previous).filter(call => /send_(group|private)_msg$/.test(call.url));
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].body.message.map(part => part.type), ['record']);
    assert.equal(h.calls.sent.length, 0);
    const last = st.recentMessages.at(-1);
    assert.ok(last.isSelf && last.time > 0);
    assert.equal(last.plain, '[语音] 那我可听见了');
  }
  assert.equal((await send('group:456', '谁啊', h.getSocialV2State('private:789').agentToken)).status, 403);
  await h.sendToQQ('group:456', '先发文字');
  const groupState = h.getSocialV2State('group:456');
  const textAck = groupState.lastOutboundAt;
  const timedVoice = await send('group:456', '试试长一点');
  assert.equal(timedVoice.status, 200);
  assert.ok(groupState.lastOutboundAt - textAck > 650, 'text acknowledgement to voice must exceed the measured 650 ms');
  const saved = fs.readFileSync(h.temp + '/state/social-v2.json', 'utf8');
  const resumed = await bridgeHarness({files:{'state/social-v2.json':saved}});
  try {
    assert.equal(resumed.getSocialV2State('group:456').lastOutboundAt, groupState.lastOutboundAt);
  } finally { await resumed.close(); }
  h.cfg.socialV2.voice.maxPerMinute = 1; // obsolete settings from an older installation
  const burst = await Promise.all(['早啊', '中午好', '晚安'].map(text => send('group:456', text)));
  assert.deepEqual(burst.map(r => r.status), [200, 200, 200]);
  h.cfg.socialV2.send.maxSendPerMinute = 1;
  assert.equal((await send('group:456', '喂')).status, 429, 'voice shares the normal message policy');
  h.cfg.socialV2.send.maxSendPerMinute = 0;
  const st = h.getSocialV2State('group:456');
  const beforeFailure = st.lastOutboundAt;
  await assert.rejects(h.queueQqSend('group:456', async () => { throw Error('gateway failed'); }));
  assert.equal(st.lastOutboundAt, beforeFailure);
  st.lastIncomingAt = Date.now() + 60000; // another speaker never advances the gate
  const sentAt = [];
  await h.queueQqSend('group:456', () => {});
  const anchor = st.lastOutboundAt;
  const voice = h.queueQqSend('group:456', () => { sentAt.push(['voice', Date.now()]); }, { voiceMs: 400 });
  const other = h.queueQqSend('private:789', () => { sentAt.push(['other', Date.now()]); });
  await Promise.all([voice, other]);
  assert.equal(sentAt[0][0], 'other');
  assert.ok(sentAt[1][1] - anchor > 400);
  assert.equal(JSON.parse(fs.readFileSync(h.temp + '/state/social-v2.json')).conversations['group:456'].lastOutboundAt, st.lastOutboundAt);
  const junkDir = h.temp + '/audio';
  fs.mkdirSync(junkDir, {recursive:true});
  fs.writeFileSync(junkDir + '/unknown.silk', Buffer.alloc(512));
  await assert.rejects(h.sendVoiceForV2('group:456', 'unknown.silk'), /时长/);
  h.cfg.socialV2.voice.trigger.who = 'owner';
  for (const key of ['group:456', 'private:789']) assert.equal((await send(key, '喂')).status, 403);
  h.cfg.socialV2.voice.enabled = false;
  assert.equal((await send('private:789', '喂')).status, 403);
  console.log('test-voice-route: ok');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await h.close();
  await new Promise((r) => tts.close(r));
}
