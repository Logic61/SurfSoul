// 桌宠本地接口（lib/pet-api.js）的**行为**回归：不发网络、不碰 ~/.dsh。
//
// 为什么必须有一条真行为测试：`test-client-contract.mjs` 只做字符串包含检查
// （"index.js 里有 createPetApiService"），它能证明"路由注册了"，证明不了
// "没令牌真的会被拒 / 令牌对了真的能通"。而 2026-10-26 的重构把
// 回环/同源/令牌判据抽到了 lib/http-guard.js —— 这类改动一旦出错，
// 现象是「桌宠连不上」或「谁都能连」，两种都不会自己报错。
//
// 这里用假 chat / purpose 服务 + 假 req/res，把每一条分支都钉住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPetApiService } from '../lib/pet-api.js';

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

const TOKEN = 'a'.repeat(48);
const BASE = 'http://127.0.0.1:57981';
const PREFIX = '/dsh-surfcore/pet-api';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-api-test-'));
let emitted = [];
let focusState = { enabled: false, updatedAt: '', source: '' };

const chat = {
  token: () => TOKEN,
  publicConfig: () => ({ ok: true, chat: { enabled: true, modality: 'text' } }),
  history: (limit) => ({ ok: true, limit, messages: [] }),
  poll: async ({ since, waitMs, clientId }) => ({ ok: true, since, waitMs, clientId, events: [], nextSince: 7 }),
  chat: async ({ text, modality }) => ({ ok: true, reply: { id: 'm1', text: `reply:${text}`, modality, audio: { key: 'deadbeef' } } }),
  setFocus: (enabled, source) => { focusState = { enabled, source, updatedAt: 'now' }; return focusState; },
  readAudio: (key) => (key === 'deadbeef' ? { bytes: Buffer.from('RIFFxxxxWAVE') } : null),
  emit: (event) => { emitted.push(event); },
  status: () => ({
    chat: { enabled: true }, role: { id: 'default' }, proactive: {}, presence: {},
    voice: { route: 'cloud' }, llm: {}, focus: focusState, events: {}, lastError: '',
  }),
};

const purpose = {
  // statusForPet 用的是 config()（载体设置），不是 status()（运行时状态）——两者别混。
  config: () => ({ carrier: 'pet', modality: 'text' }),
  status: () => ({ ok: true, carrier: 'pet', online: true }),
  preview: async () => ({ ok: true, preview: '说点什么' }),
  run: async () => ({ ok: true, sent: false }),
  online: true,
};

const petService = { status: () => ({ installed: true, running: true, dir: 'D:/fake/pet', skins: ['fish'] }) };
const api = createPetApiService({
  chat, purpose, petService, stateDir,
  currentDshUrl: () => BASE,
  pluginLog: () => {},
  version: '0.1.0-test',
});

function makeReq({ method = 'GET', headers = {}, body = null } = {}) {
  const handlers = {};
  const req = {
    method,
    headers,
    on(evt, fn) { handlers[evt] = fn; return req; },
    destroy() {},
    flush() {
      if (body !== null) handlers.data?.(Buffer.from(body));
      handlers.end?.();
    },
  };
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    raw: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; },
    end(chunk) {
      if (chunk === undefined || chunk === null) { this.body = ''; return; }
      if (Buffer.isBuffer(chunk)) { this.raw = chunk; this.body = chunk.toString('utf8'); return; }
      this.body = String(chunk);
    },
  };
}

async function call({ method = 'GET', pathname = '/health', headers = {}, body = null, query = '' } = {}) {
  const req = makeReq({ method, headers, body });
  const res = makeRes();
  const url = new URL(`${BASE}${PREFIX}${pathname}${query}`);
  const pending = api.handle(req, res, url);
  req.flush();
  await pending;
  let data = null;
  try { data = JSON.parse(res.body); } catch {}
  return { res, data };
}

const loopback = { host: '127.0.0.1:57981', 'x-pet-token': TOKEN };
const jsonPost = (extra = {}) => ({ ...loopback, 'content-type': 'application/json', ...extra });

console.log('## 1. 令牌：没有 / 不对 / 空，一律 401（失败关闭）');
{
  const noToken = await call({ headers: { host: '127.0.0.1:57981' } });
  ok(noToken.res.statusCode === 401, '不带令牌 → 401');
  const wrong = await call({ headers: { host: '127.0.0.1:57981', 'x-pet-token': 'b'.repeat(48) } });
  ok(wrong.res.statusCode === 401, '令牌错误 → 401');
  const okHeader = await call({ headers: loopback });
  ok(okHeader.res.statusCode === 200 && okHeader.data?.ok === true, '令牌正确（header）→ 200');
  const okQuery = await call({ headers: { host: '127.0.0.1:57981' }, query: `?token=${TOKEN}` });
  ok(okQuery.res.statusCode === 200, '令牌正确（?token=，音频用这条）→ 200');
  const leak = JSON.stringify(wrong.data ?? {});
  ok(!leak.includes(TOKEN) && !leak.includes('57981'), '401 响应不回显令牌、不泄露主机配置');
}

console.log('## 2. 令牌还没生成时：空令牌不得通过');
{
  const emptyTokenApi = createPetApiService({
    chat: { ...chat, token: () => '' },
    purpose, petService, stateDir, currentDshUrl: () => BASE, pluginLog: () => {}, version: 't',
  });
  const req = makeReq({ headers: { host: '127.0.0.1:57981' }, });
  const res = makeRes();
  const pending = emptyTokenApi.handle(req, res, new URL(`${BASE}${PREFIX}/health`));
  req.flush();
  await pending;
  ok(res.statusCode === 401, 'chat.token() 为空时 → 401（不会把"空=空"当通过）');
}

console.log('## 3. 回环与同源');
{
  const remote = await call({ headers: { host: '192.168.1.5:57981', 'x-pet-token': TOKEN } });
  ok(remote.res.statusCode === 403, '非回环 Host → 403');
  const crossSite = await call({ method: 'POST', pathname: '/focus', headers: { ...jsonPost(), origin: 'http://evil.com' }, body: '{}' });
  ok(crossSite.res.statusCode === 403, '写操作跨站 Origin → 403');
  const noOrigin = await call({ method: 'POST', pathname: '/focus', headers: jsonPost(), body: '{"enabled":true}' });
  ok(noOrigin.res.statusCode === 200, '没带 Origin（桌宠主进程）→ 放行');
  const formType = await call({ method: 'POST', pathname: '/focus', headers: { ...loopback, 'content-type': 'application/x-www-form-urlencoded' }, body: 'enabled=1' });
  ok(formType.res.statusCode === 415, '写操作非 JSON content-type → 415');
}

console.log('## 4. 只读接口');
{
  const health = await call({ headers: loopback });
  ok(health.data?.name === 'surfcore-pet' && health.data?.version === '0.1.0-test', '/health 返回名字与版本');
  const status = await call({ pathname: '/status', headers: loopback });
  ok(status.data?.pet?.installed === true && status.data?.purpose?.carrier === 'pet', '/status 带桌宠与目的载体状态');
  const config = await call({ pathname: '/config', headers: loopback });
  ok(config.data?.chat?.modality === 'text', '/config 返回对话参数');
  const history = await call({ pathname: '/history', headers: loopback, query: '?limit=5' });
  ok(history.data?.limit === 5, '/history 透传 limit');
  const events = await call({ pathname: '/events', headers: loopback, query: '?since=6&wait=100&client=pet' });
  ok(events.data?.since === 6 && events.data?.clientId === 'pet', '/events 透传 since/wait/client');
  const purposeStatus = await call({ pathname: '/purpose/status', headers: loopback });
  ok(purposeStatus.data?.carrier === 'pet', '/purpose/status 走目的服务');
  const unknown = await call({ pathname: '/nope', headers: loopback });
  ok(unknown.res.statusCode === 404, '未知路径 → 404');
}

console.log('## 5. 写接口（对话 / 专注 / 目的 / 测试气泡）');
{
  const chatRes = await call({ method: 'POST', pathname: '/chat', headers: jsonPost(), body: '{"text":"在吗","modality":"voice"}' });
  ok(chatRes.data?.reply?.text === 'reply:在吗', '/chat 把文本交给对话服务');
  ok(chatRes.data?.reply?.modality === 'voice', '/chat 透传 modality（语音对话）');

  const focusOn = await call({ method: 'POST', pathname: '/focus', headers: jsonPost(), body: '{"enabled":true,"source":"pet"}' });
  ok(focusOn.data?.focus?.enabled === true, '/focus 打开专注模式');
  const focusOff = await call({ method: 'POST', pathname: '/focus', headers: jsonPost(), body: '{"enabled":false}' });
  ok(focusOff.data?.focus?.enabled === false, '/focus 关闭专注模式');

  const preview = await call({ method: 'POST', pathname: '/purpose/preview', headers: jsonPost(), body: '{}' });
  ok(preview.data?.preview === '说点什么', '/purpose/preview 透传结果');
  const run = await call({ method: 'POST', pathname: '/purpose/run', headers: jsonPost(), body: '{}' });
  ok(run.res.statusCode === 200 && run.data?.ok === true, '/purpose/run 可用');

  emitted = [];
  const testBubble = await call({ method: 'POST', pathname: '/chat/test', headers: jsonPost(), body: '{"text":"嗨"}' });
  ok(testBubble.res.statusCode === 200, '/chat/test → 200');
  ok(emitted.length === 1 && emitted[0].type === 'reply' && emitted[0].text === 'reply:嗨', '/chat/test 会推一条 reply 事件给气泡');
}

console.log('## 6. 音频与发现文件');
{
  const audio = await call({ pathname: '/audio/deadbeef.wav', headers: { host: '127.0.0.1:57981' }, query: `?token=${TOKEN}` });
  ok(audio.res.statusCode === 200 && audio.res.headers['Content-Type'] === 'audio/wav', '/audio/<key>.wav 返回 wav');
  ok(Buffer.isBuffer(audio.res.raw) && audio.res.raw.toString('utf8').startsWith('RIFF'), '音频字节原样返回');
  const missing = await call({ pathname: '/audio/nosuch.wav', headers: loopback });
  ok(missing.res.statusCode === 404, '不存在的音频 → 404');

  const url = api.audioUrlFor('deadbeef');
  ok(url.includes(`?token=${TOKEN}`) && url.startsWith(`${PREFIX}/audio/`), 'audioUrlFor 带令牌');
  const dirty = api.audioUrlFor('../../etc/passwd');
  const dirtyName = dirty.slice(dirty.lastIndexOf('/audio/') + 7, dirty.indexOf('.wav'));
  ok(/^[a-f0-9]+$/i.test(dirtyName), `audioUrlFor 只保留 hex key（${JSON.stringify(dirtyName)}），不拼进路径穿越字符`);

  api.writeHostFile(true);
  const hostFile = path.join(stateDir, 'pet', 'host.json');
  const host = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
  ok(host.baseUrl === BASE && host.token === TOKEN && host.api === PREFIX, 'host.json 含 baseUrl / token / api');
  ok(host.version === 1, 'host.json 带协议版本号（桌宠据此判断兼容）');
}

console.log('## 7. 看屏幕闸门端点（2026-11-07）：QQ 载体通过 pet-api 要决定');
{
  const noScreen = await call({ method: 'POST', pathname: '/purpose/screen/decide', headers: jsonPost(), body: '{}' });
  ok(noScreen.res.statusCode === 503, '没装 screen 服务 → 503（桥接按 fail-open 继续）');

  const callWith = async (instance, { method = 'GET', pathname = '/health', headers = {}, body = null } = {}) => {
    const req = makeReq({ method, headers, body });
    const res = makeRes();
    const url = new URL(`${BASE}${PREFIX}${pathname}`);
    const pending = instance.handle(req, res, url);
    req.flush();
    await pending;
    let data = null;
    try { data = JSON.parse(res.body); } catch {}
    return { res, data };
  };

  const decisions = [];
  const screen = {
    decide: async ({ reason, ownerName }) => {
      decisions.push({ reason, ownerName });
      return { allow: false, reason: 'screen-lottery', kind: 'deny', retryMs: 900000, at: 123, p: 0.85, u: 0.93, x: 0.75, degraded: false };
    },
    status: () => ({ enabled: true, policy: { interruptPolicy: 'leaky' }, leak: { day: '2026-11-07', count: 0, lastAt: 0 } }),
  };
  const apiWithScreen = createPetApiService({
    chat, purpose, petService, screen, stateDir, currentDshUrl: () => BASE, pluginLog: () => {}, version: 't',
  });
  const decided = await callWith(apiWithScreen, {
    method: 'POST', pathname: '/purpose/screen/decide', headers: jsonPost(),
    body: '{"reason":"bridge-gate","ownerName":"主人"}',
  });
  ok(decided.data?.ok === true && decided.data?.allow === false && decided.data?.reason === 'screen-lottery', 'decide 透传 allow/reason');
  ok(decided.data?.retryMs === 900000 && decided.data?.p === 0.85, 'decide 透传 retryMs / p');
  ok(decisions.length === 1 && decisions[0].reason === 'bridge-gate' && decisions[0].ownerName === '主人', 'reason / ownerName 透传给插件');
  const screenStatus = await callWith(apiWithScreen, { pathname: '/purpose/screen', headers: loopback });
  ok(screenStatus.data?.screen?.policy?.interruptPolicy === 'leaky', 'GET /purpose/screen 返回策略状态');

  const boom = createPetApiService({
    chat, purpose, petService, screen: { decide: async () => { throw new Error('boom'); } },
    stateDir, currentDshUrl: () => BASE, pluginLog: () => {}, version: 't',
  });
  const failedDecide = await callWith(boom, { method: 'POST', pathname: '/purpose/screen/decide', headers: jsonPost(), body: '{}' });
  ok(failedDecide.res.statusCode === 500, 'decide 抛错 → 500（让桥接 fail-open，而不是默认放行）');
}

fs.rmSync(stateDir, { recursive: true, force: true });
console.log(failures === 0 ? '\n✅ pet-api 行为回归通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
