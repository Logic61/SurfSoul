// 语音路由错误分类回归：合成失败必须映射成可区分的 HTTP 状态，且绝不发 QQ 消息。
//
// 2026-10-30 事故：两声「合成超时（>60s）」在 AI 通道被兜底成 HTTP 400（中文正则
// /语音合成|TTS/ 不匹配超时文案），模型据此以为"参数不对"。
// 修法：voice-tts.js 给错误打 code/statusCode；bridge 用 voiceSynthError() 统一分类。
// 本测试用 bridgeHarness + 假合成器，全程不发真 QQ、不碰真实 config。
import assert from 'node:assert/strict';
import http from 'node:http';

import { bridgeHarness } from './audit-bridge-harness.mjs';

function synthError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function post(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request hung')));
    req.end(JSON.stringify(body));
  });
}

async function withBridge(thrown, fn) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 123,
      allow: { groups: ['456'], private: ['123'] },
      fishGuard: { enabled: false },
      // 万一流程走到网关：httpUrl 指向不可达端口，只会立刻失败；本测试只关心分类。
      snowluma: { httpUrl: 'http://127.0.0.1:1' },
      socialV2: {
        mode: 'reserved2',
        tools: { sendVoice: true },
        voice: {
          enabled: true,
          maxPerMinute: 5,
          tts: {
            enabled: true,
            baseUrl: 'http://127.0.0.1:1',
            route: 'local',
            endpoints: { local: 'http://127.0.0.1:1', cloud: 'http://127.0.0.1:1' },
            maxChars: 20
          }
        }
      }
    },
    // 直接替换合成器：只测「错误 → 状态码/文案」这一层，不重复测 voice-tts 的网络细节。
    globals: {
      synthesizeToFile: async () => {
        throw thrown;
      }
    }
  });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('private:123');
    return await fn({ h, server, st });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

const sendVoice = (server, st, text) =>
  post(server.address().port, '/api/socialV2/send-voice', { key: 'private:123', token: st.agentToken, text });

// ① 超时 → 504（不是 400），文案要教模型改回打字，且不得发出任何消息
await withBridge(synthError('合成超时（>150s）：The operation was aborted due to timeout', 'TTS_TIMEOUT', 504), async ({ h, server, st }) => {
  const r = await sendVoice(server, st, '你好');
  assert.equal(r.status, 504, `超时必须 504，实际 ${r.status}：${r.body}`);
  const body = JSON.parse(r.body);
  assert.match(body.error, /合成超时/);
  assert.match(body.error, /改回打字/, '5xx 文案要教模型改回打字（MCP 会丢掉状态码，文案是唯一通道）');
  assert.ok(!h.calls.http.some((c) => String(c.url).endsWith('send_private_msg')), '合成失败不得发出任何消息');
});

// ② 引擎返回 503 → 502（引擎侧故障，不是参数错）
await withBridge(synthError('TTS 服务返回 503：引擎 piper 不可用', 'TTS_HTTP_ERROR', 502), async ({ server, st }) => {
  const r = await sendVoice(server, st, '你好');
  assert.equal(r.status, 502, r.body);
  assert.match(JSON.parse(r.body).error, /改回打字/);
});

// ③ 引擎没起来 → 502
await withBridge(synthError('TTS 服务没起来（voxd 是否在运行？）：fetch failed', 'TTS_UNAVAILABLE', 502), async ({ server, st }) => {
  const r = await sendVoice(server, st, '你好');
  assert.equal(r.status, 502, r.body);
});

// ④ 旧式错误（没有 statusCode）按文案兜底：超时也必须 504，不能退回 400
await withBridge(new Error('合成超时（>150s）：aborted'), async ({ server, st }) => {
  const r = await sendVoice(server, st, '你好');
  assert.equal(r.status, 504, `旧错误文案兜底也必须是 504，实际 ${r.status}：${r.body}`);
});

// ⑤ 参数错误（超过 tts.maxChars）→ 400，不能是 5xx
await withBridge(synthError('不该走到合成器', 'TTS_INTERNAL', 500), async ({ server, st }) => {
  const r = await sendVoice(server, st, '字'.repeat(30));
  assert.equal(r.status, 400, r.body);
  assert.match(JSON.parse(r.body).error, /最多 20 字/);
});

console.log('test-voice-route-errors: ok');
