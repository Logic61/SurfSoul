// QQ 自我表达（改个性签名 / 发 QQ 空间说说）回归测试：真实 bridge 路由 + 夹具网关，绝不连真 QQ。
//
// 病象：这两个动作 SnowLuma 运行时里有、surfcore 原本没接。若只把路由 / MCP 工具拼起来而漏掉
// 任一道闸，模型就能在**公开面**（个性签名、QQ 空间说说）写出主人 QQ、群号或凭据 —— 这些内容
// 发出去就收不回来，事后也删不干净。
// 根因：接线分散在三处（bridge 路由 / MCP 工具 / 控制台开关），而闸门顺序（模式 → 令牌 →
// 工具开关 → 暂停 → 长度 → 敏感信息 → 身份泄露）只存在于真实 bridge.js 内部；静态字符串检查
// 看不出「闸门写反 / 漏调用」，必须让真实路由跑一遍，并断言**真正发出去的 OneBot 动作与参数**。
// 覆盖点：
//   · 签名：happy path（/set_self_longnick body.longNick + /get_stranger_info 回读 → verified=true）、
//     空串=清除、120/121 长度边界、敏感信息 403、主人 QQ 403、坏 agent token 403、工具开关关 403、
//     非 reserved2 403、二次 AI 暂停 403、longNick / long_nick 别名（v1 兼容）。
//   · 说说：默认 ugc_right=4、visibility self→64 / all→1、显式 ugcRight 64 允许 / 16→400、
//     非法 visibility 400、空正文 400、1000/1001 长度边界、换行保留（剥离其它控制字符）、
//     敏感信息 403、「群号 + 数字」身份闸 403、工具开关关 403。
//   · 静态接线：bridge.js 两处 tools 默认表 / POST config 的 toolFlags / 两个路由与 bot.raw 参数、
//     MCP 的 TOOL_CONFIG_FLAGS 与 server.tool 注册、console.html 两个 data-v2-tool、
//     config.example.json 两个 key、plugins/surfcore/lib/client.js 两个标签，
//     以及本文件已经接进 scripts/test-audit.mjs 的回归链。
// 闸门被拒绝的用例同时断言「没有发出 OneBot 动作」：只回 403 但真的调了网关也算失败。
// 夹具：scripts/audit-bridge-harness.mjs（VM 里跑真实 bridge.js，FakeBot.raw → fakeFetch），
// 不连真 SnowLuma / QQ，也不读写真实 DSH_HOME。
// 运行：node scripts/test-qq-self-expression.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'group:456';
const SELF_QQ = '999000111';
const CONSOLE_TOKEN = 'fixture-console-token';

const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** POST 到夹具控制台。JSON 走 chunked 即可（桥接 readBody 支持），与真实 MCP 调用形状一致。 */
function post(port, route, body, { token } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/socialV2/${route}`,
      method: 'POST',
      headers: {
        'x-console-token': CONSOLE_TOKEN,
        ...(token ? { 'x-agent-token': token } : {}),
        'content-type': 'application/json',
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`fixture request timed out: ${route}`)));
    req.end(JSON.stringify(body));
  });
}

// ── 行为回归：真实 bridge.js 的 set-signature / send-qzone 路由 ─────────────
test('QQ 自我表达：改签名 / 发空间说说（真实 bridge 路由 + 夹具网关）', async (t) => {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 123456789,
      socialV2: { sticker: { enabled: false } },
    },
  });
  h.setMode('reserved2');
  h.setSelfIdentity('fixture-bot', SELF_QQ);
  const state = h.getSocialV2State(KEY);
  assert.ok(state.agentToken, '夹具二代会话应生成 agent token');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const call = (route, body = {}, opts = {}) =>
    post(port, route, { key: KEY, ...body }, { token: state.agentToken, ...opts });
  const httpCalls = (action) => h.calls.http.filter((entry) => entry.url.endsWith(`/${action}`));
  const lastHttp = (action) => httpCalls(action).at(-1);
  const countHttp = (action) => httpCalls(action).length;
  /** 闸门拒绝：状态码 + 错误文案 + 「一步 OneBot 动作都没发」。 */
  const denied = async (route, body, { status, pattern, action, opts = {} }) => {
    const before = countHttp(action);
    const result = await call(route, body, opts);
    assert.equal(result.status, status, `期望 HTTP ${status}，实际 ${result.status}：${JSON.stringify(result.data)}`);
    if (pattern) assert.match(result.data?.error ?? '', pattern);
    assert.equal(countHttp(action), before, `被闸门拒绝的请求不得触发 OneBot ${action}`);
    return result;
  };

  try {
    // ── 签名 ────────────────────────────────────────────────────────────
    await t.test('签名 happy path：写入 longNick、回读签名，verified=true', async () => {
      const signature = '今天也在看鱼';
      const beforeReads = countHttp('get_stranger_info');
      const result = await call('set-signature', { signature });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data?.ok, true);
      assert.equal(result.data?.key, KEY);
      assert.equal(result.data?.signature, signature);
      assert.equal(result.data?.verified, true, `verified=${result.data?.verified}（回读不一致）`);

      const sent = lastHttp('set_self_longnick');
      assert.ok(sent, '桥接应调用 OneBot set_self_longnick');
      assert.deepEqual(sent.body, { longNick: signature }, 'set_self_longnick 参数必须是 { longNick }');

      const readback = lastHttp('get_stranger_info');
      assert.ok(readback, '设置后应回读当前签名（get_stranger_info）');
      assert.equal(readback.body?.user_id, Number(SELF_QQ), '回读的 user_id 必须是她自己的 QQ');
      assert.equal(countHttp('get_stranger_info'), beforeReads + 1, 'happy path 应恰好回读一次');
      assert.equal(h.calls.longNick, signature, '夹具网关里的当前签名应已被更新');
    });

    await t.test('签名空字符串 = 清除签名', async () => {
      const result = await call('set-signature', { signature: '' });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data?.ok, true);
      assert.equal(result.data?.signature, '');
      assert.equal(result.data?.verified, true, '清除后回读也应为空串');
      assert.deepEqual(lastHttp('set_self_longnick').body, { longNick: '' });
      assert.equal(h.calls.longNick, '');
    });

    await t.test('签名兼容 longNick / long_nick 别名', async () => {
      const viaLongNick = await call('set-signature', { longNick: '别名 longNick' });
      assert.equal(viaLongNick.status, 200, JSON.stringify(viaLongNick.data));
      assert.deepEqual(lastHttp('set_self_longnick').body, { longNick: '别名 longNick' });

      const viaLongNickSnake = await call('set-signature', { long_nick: '别名 long_nick' });
      assert.equal(viaLongNickSnake.status, 200, JSON.stringify(viaLongNickSnake.data));
      assert.deepEqual(lastHttp('set_self_longnick').body, { longNick: '别名 long_nick' });
    });

    await t.test('签名长度边界：120 字允许，121 字 400', async () => {
      const allowed = await call('set-signature', { signature: 'x'.repeat(120) });
      assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
      assert.equal(allowed.data?.verified, true);

      await denied('set-signature', { signature: 'x'.repeat(121) }, {
        status: 400, pattern: /120/, action: 'set_self_longnick',
      });
    });

    await t.test('签名敏感信息 → 403', async () => {
      await denied('set-signature', { signature: 'token: sk-abcdefghijklmnop' }, {
        status: 403, pattern: /敏感信息/, action: 'set_self_longnick',
      });
    });

    await t.test('签名含主人 QQ（身份泄露）→ 403', async () => {
      const result = await denied('set-signature', { signature: '有事加 QQ：123456789' }, {
        status: 403, pattern: /账号标识/, action: 'set_self_longnick',
      });
      assert.match(result.data?.error ?? '', /个性签名/, '错误文案应说明是哪个公开面');
    });

    await t.test('签名错 agent token → 403', async () => {
      await denied('set-signature', { signature: 'x' }, {
        status: 403, pattern: /token/, action: 'set_self_longnick', opts: { token: 'bad-token' },
      });
    });

    await t.test('签名工具开关关 → 403 工具未启用', async () => {
      h.cfg.socialV2.tools.setSignature = false;
      try {
        await denied('set-signature', { signature: 'x' }, {
          status: 403, pattern: /工具未启用.*setSignature/, action: 'set_self_longnick',
        });
      } finally {
        h.cfg.socialV2.tools.setSignature = true;
      }
    });

    await t.test('签名非 reserved2 模式 → 403', async () => {
      h.setMode('chat');
      try {
        await denied('set-signature', { signature: 'x' }, {
          status: 403, pattern: /reserved2/, action: 'set_self_longnick',
        });
        // 关掉模式闸后同一个请求必须能通过，证明确实是模式在拦。
        h.setMode('reserved2');
        const allowed = await call('set-signature', { signature: '模式恢复后可以改' });
        assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
      } finally {
        h.setMode('reserved2');
      }
    });

    await t.test('二代 AI 暂停 → 403', async () => {
      h.socialV2.paused = true;
      try {
        await denied('set-signature', { signature: 'x' }, {
          status: 403, pattern: /暂停/, action: 'set_self_longnick',
        });
      } finally {
        h.socialV2.paused = false;
      }
    });

    // ── QQ 空间说说 ─────────────────────────────────────────────────────
    await t.test('说说 happy path：默认好友可见（ugc_right=4），回包透传 data', async () => {
      const content = '今天看了海，风很大';
      const beforeSends = countHttp('send_qzone_msg');
      const result = await call('send-qzone', { content });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data?.ok, true);
      assert.equal(result.data?.key, KEY);
      assert.equal(result.data?.content, content);
      assert.equal(result.data?.ugcRight, 4, '默认可见性必须是好友可见（4），比运行时默认的 1=所有人可见更收');
      assert.deepEqual(result.data?.data, { tid: 'fixture-qzone-tid' }, '网关 data 应原样透传');
      assert.equal(countHttp('send_qzone_msg'), beforeSends + 1);

      const sent = lastHttp('send_qzone_msg');
      assert.ok(sent, '桥接应调用 OneBot send_qzone_msg');
      assert.deepEqual(sent.body, { content, ugc_right: 4 }, 'send_qzone_msg 参数必须是 { content, ugc_right }');
    });

    await t.test('说说 visibility：self→64 / all→1 / friends→4，真实 ugc_right 跟着变', async () => {
      const selfOnly = await call('send-qzone', { content: '仅自己可见的测试', visibility: 'self' });
      assert.equal(selfOnly.status, 200, JSON.stringify(selfOnly.data));
      assert.equal(selfOnly.data?.ugcRight, 64);
      assert.deepEqual(lastHttp('send_qzone_msg').body, { content: '仅自己可见的测试', ugc_right: 64 });

      const everyone = await call('send-qzone', { content: '所有人可见的测试', visibility: 'all' });
      assert.equal(everyone.status, 200, JSON.stringify(everyone.data));
      assert.equal(everyone.data?.ugcRight, 1);
      assert.deepEqual(lastHttp('send_qzone_msg').body, { content: '所有人可见的测试', ugc_right: 1 });

      const friends = await call('send-qzone', { content: '好友可见的测试', visibility: 'friends' });
      assert.equal(friends.status, 200, JSON.stringify(friends.data));
      assert.equal(friends.data?.ugcRight, 4);
      assert.deepEqual(lastHttp('send_qzone_msg').body, { content: '好友可见的测试', ugc_right: 4 });
    });

    await t.test('说说显式 ugcRight：64 允许，16 明确 400（v1 不支持部分好友）', async () => {
      const explicitSelf = await call('send-qzone', { content: '显式仅自己可见', ugcRight: 64 });
      assert.equal(explicitSelf.status, 200, JSON.stringify(explicitSelf.data));
      assert.equal(explicitSelf.data?.ugcRight, 64);
      assert.deepEqual(lastHttp('send_qzone_msg').body, { content: '显式仅自己可见', ugc_right: 64 });

      const partial = await denied('send-qzone', { content: 'test', ugcRight: 16 }, {
        status: 400, pattern: /16|128|名单/, action: 'send_qzone_msg',
      });
      assert.match(partial.data?.error ?? '', /vc?1|暂不支持/, '错误文案应说明 v1 不支持 16/128');
    });

    await t.test('说说非法 visibility → 400', async () => {
      await denied('send-qzone', { content: 'x', visibility: 'partial' }, {
        status: 400, pattern: /visibility/, action: 'send_qzone_msg',
      });
    });

    await t.test('说说空正文（含纯空白）→ 400', async () => {
      await denied('send-qzone', { content: '   ' }, {
        status: 400, pattern: /不能为空/, action: 'send_qzone_msg',
      });
    });

    await t.test('说说长度边界：1000 字允许，1001 字 400', async () => {
      const allowed = await call('send-qzone', { content: 'x'.repeat(1000) });
      assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
      assert.equal(allowed.data?.content.length, 1000);

      await denied('send-qzone', { content: 'x'.repeat(1001) }, {
        status: 400, pattern: /1000/, action: 'send_qzone_msg',
      });
    });

    await t.test('说说正文：保留换行，剥离其它控制字符', async () => {
      const result = await call('send-qzone', { content: '第一行\n第二行\u0001尾巴' });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.deepEqual(lastHttp('send_qzone_msg').body, {
        content: '第一行\n第二行尾巴',
        ugc_right: 4,
      });
    });

    await t.test('说说敏感信息 → 403', async () => {
      await denied('send-qzone', { content: 'api_key=abcdef123456789' }, {
        status: 403, pattern: /敏感信息/, action: 'send_qzone_msg',
      });
    });

    await t.test('说说「群号 + 5~12 位数字」身份闸 → 403', async () => {
      const result = await denied('send-qzone', { content: '群号 12345678 加群' }, {
        status: 403, pattern: /账号标识/, action: 'send_qzone_msg',
      });
      assert.match(result.data?.error ?? '', /QQ空间说说/, '错误文案应说明是哪个公开面');
    });

    await t.test('说说工具开关关 → 403 工具未启用', async () => {
      h.cfg.socialV2.tools.sendQzone = false;
      try {
        await denied('send-qzone', { content: 'test' }, {
          status: 403, pattern: /工具未启用.*sendQzone/, action: 'send_qzone_msg',
        });
      } finally {
        h.cfg.socialV2.tools.sendQzone = true;
      }
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

// ── 静态接线：漏一处就等于「工具存在但模型永远看不到 / 开关关不掉」────────────
test('QQ 自我表达：静态接线（bridge / MCP / 控制台 / 示例配置 / 插件标签 / 审计链）', () => {
  const bridge = readSource('src/bridge.js');

  // 两处 socialV2.tools 默认表（cfg 骨架 + 深合并默认表）都必须默认开启；
  // 漏一处会让 MCP 工具在某些配置形状下静默消失。
  assert.equal((bridge.match(/setSignature:\s*true/g) ?? []).length, 2,
    'src/bridge.js 两处 socialV2.tools 默认表都应有 setSignature: true');
  assert.equal((bridge.match(/sendQzone:\s*true/g) ?? []).length, 2,
    'src/bridge.js 两处 socialV2.tools 默认表都应有 sendQzone: true');

  // 控制台 /api/socialV2/config 的工具开关清单。
  const toolFlags = /const toolFlags = \[([\s\S]*?)\];/.exec(bridge);
  assert.ok(toolFlags, 'src/bridge.js 里找不到 const toolFlags = [...]');
  assert.match(toolFlags[1], /'setSignature'/);
  assert.match(toolFlags[1], /'sendQzone'/);

  // 两个 POST 路由 + 真实发给 SnowLuma 的裸动作与参数形状。
  assert.match(bridge, /url\.pathname === '\/api\/socialV2\/set-signature'/);
  assert.match(bridge, /url\.pathname === '\/api\/socialV2\/send-qzone'/);
  assert.match(bridge, /bot\.raw\('set_self_longnick', \{ longNick: signature \}\)/);
  assert.match(bridge, /bot\.raw\('send_qzone_msg', \{ content, ugc_right: ugcRight \}\)/);

  // 公开面审计：两处都必须过身份泄露闸（敏感信息另有 SENSITIVE_RE）。
  assert.match(bridge, /import \{ findIdentityLeaks, formatIdentityLeakError \} from '\.\/identity-guard\.js'/);
  assert.match(bridge, /findIdentityLeaks\(signature, \{ ids: selfExpressionProtectedIds\(\) \}\)/);
  assert.match(bridge, /findIdentityLeaks\(content, \{ ids: selfExpressionProtectedIds\(\) \}\)/);

  // 发布后不得用 get_qzone_msg_list 做校验：SnowLuma 空列表会回 retcode 100「响应结构异常」，
  // 拿它当校验会把「动作没实现」和「本来就没说说」混为一谈（见 QQ_SELF_EXPRESSION_SPEC §0）。
  const qzoneStart = bridge.indexOf("url.pathname === '/api/socialV2/send-qzone'");
  const qzoneEnd = bridge.indexOf("url.pathname === '/api/socialV2/sticker-image'");
  assert.ok(qzoneStart > 0 && qzoneEnd > qzoneStart, '找不到 send-qzone 路由块的边界');
  assert.doesNotMatch(bridge.slice(qzoneStart, qzoneEnd), /get_qzone_msg_list/,
    '发说说后不得用 get_qzone_msg_list 做发布校验');

  // MCP 工具面：TOOL_CONFIG_FLAGS 两项 + 两个 server.tool 注册 + 开关判断 + 桥接路径。
  const mcp = readSource('src/mcp-snowluma-safe.js');
  assert.match(mcp, /qq_set_signature:\s*'setSignature'/);
  assert.match(mcp, /qq_send_qzone:\s*'sendQzone'/);
  assert.match(mcp, /server\.tool\(\s*'qq_set_signature'/);
  assert.match(mcp, /server\.tool\(\s*'qq_send_qzone'/);
  assert.match(mcp, /cfg\.socialV2\?\.tools\?\.setSignature !== false/);
  assert.match(mcp, /cfg\.socialV2\?\.tools\?\.sendQzone !== false/);
  assert.match(mcp, /\/api\/socialV2\/set-signature/);
  assert.match(mcp, /\/api\/socialV2\/send-qzone/);

  // 控制台开关：两个 data-v2-tool 的 checkbox，且给模型看到的是工具名。
  const html = readSource('public/console.html');
  assert.match(html, /data-v2-tool="setSignature"/);
  assert.match(html, /data-v2-tool="sendQzone"/);
  assert.match(html, /<b>qq_set_signature<\/b>/);
  assert.match(html, /<b>qq_send_qzone<\/b>/);

  // 示例配置：两 key 默认 true（跟 bridge 默认表一致，否则新装用户会看到开关默认关）。
  const example = JSON.parse(readSource('config.example.json'));
  assert.equal(example.socialV2?.tools?.setSignature, true, 'config.example.json 应默认开 setSignature');
  assert.equal(example.socialV2?.tools?.sendQzone, true, 'config.example.json 应默认开 sendQzone');

  // 插件活动记录标签：工具调用要能在控制台活动里认出来。
  const client = readSource('plugins/surfcore/lib/client.js');
  assert.match(client, /setSignature:\s*"改个性签名"/);
  assert.match(client, /sendQzone:\s*"发QQ空间说说"/);

  // 本文件必须仍在 scripts/test-audit.mjs 的 tests 数组里，否则等于没有回归门。
  assert.match(readSource('scripts/test-audit.mjs'), /'test-qq-self-expression\.mjs'/,
    "scripts/test-audit.mjs 的 tests 数组应包含 'test-qq-self-expression.mjs'");
});
