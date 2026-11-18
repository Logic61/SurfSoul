/**
 * 生活参数 MCP 工具（本版本是 bridge HTTP 代理，不是本地 manager）。
 *
 * 为什么重写成代理：本地（surfcore-work 0.6.22）把 manager 放在 bridge 进程里，
 * 9 个工具只是「转发 + 鉴权头」；权限/归因（owner 回合、白名单、频率、审计）在 bridge。
 * 因此：
 *   · 每个工具 schema 必填 `key`（QQ 会话 key）+ `token`（当前会话令牌）；
 *   · token 只放 `x-agent-token` 头，不放 query/body；`key` 放 query（GET）或 body（POST），
 *     bridge 用 agentTokenOk(key, token) 做绑定校验（bridge 不信任 body 里的 key）；
 *   · 成功透传 bridge 的 JSON；业务失败统一 `{status:'rejected',error}` 的 isError 结果；
 *   · 没有 approve 工具（审批只在 CLI / 管理端）。
 *
 * 启动不依赖 bridge 在线：解析 SURFCORE_ROOT/DSH_HOME 只读本地文件；真正 HTTP 只在工具调用时发生。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const CONSOLE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const DEFAULT_CONSOLE_PORT = 3100;
const DEFAULT_TIMEOUT_MS = 30000;

/** 从入口脚本反推仓库根（node <root>/src/mcp-life-settings.js 启动时 argv[1] 就是本文件）。 */
function rootFromEntry(entry) {
  try {
    const resolved = String(entry ?? '');
    if (!resolved) return null;
    const dir = path.dirname(path.resolve(resolved));
    if (path.basename(dir) === 'src') return path.dirname(dir);
  } catch {}
  return null;
}
const looksLikeRepoRoot = (candidate) => {
  try {
    return fs.existsSync(path.join(candidate, 'config.json')) && fs.existsSync(path.join(candidate, 'src', 'bridge.js'));
  } catch { return false; }
};
/**
 * SURFCORE_ROOT 解析：env 优先；否则按 `config.json + src/bridge.js` 探测
 * （入口所在仓库根、cwd、本模块相对根，依次尝试）。探测失败时退回入口/ cwd，
 * 后续工具调用会因为找不到 bridge 配置而给出可读错误，而不是启动即崩。
 */
export function detectSurfcoreRoot() {
  if (process.env.SURFCORE_ROOT) return path.resolve(process.env.SURFCORE_ROOT);
  const candidates = [];
  const entryRoot = rootFromEntry(process.argv[1]);
  if (entryRoot) candidates.push(entryRoot);
  candidates.push(process.cwd());
  try { candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')); } catch {}
  const found = candidates.find(looksLikeRepoRoot);
  return found || candidates[0] || process.cwd();
}
export function resolveLifeConnection(options = {}) {
  const root = path.resolve(options.root || process.env.SURFCORE_ROOT || detectSurfcoreRoot());
  const dshHome = path.resolve(options.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  return { root, dshHome };
}
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return fallback; }
}
/**
 * 读 bridge 控制台连接参数（每次请求重新读，令牌轮换后不用重启 MCP）：
 * config.json 的 consolePort / consoleToken 优先；令牌格式不合法时按 bridge 的口径
 * 回退 `<root>/state/console-token`（bridge 的 STATE_DIR 就是 <root>/state）。
 */
export function readBridgeConnection(connection) {
  const config = readJsonSafe(path.join(connection.root, 'config.json'), {});
  const port = Number(config.consolePort) || DEFAULT_CONSOLE_PORT;
  let token = String(config.consoleToken ?? '').trim();
  if (!CONSOLE_TOKEN_RE.test(token)) {
    try { token = fs.readFileSync(path.join(connection.root, 'state', 'console-token'), 'utf8').trim(); }
    catch { token = ''; }
  }
  return { port, token };
}
function errorText(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      if (text && text !== '{}') return text.slice(0, 500);
    } catch {}
    const message = value.message ?? value.msg ?? value.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  }
  return fallback;
}
async function bridgeRequest(connection, request) {
  const { port, token } = readBridgeConnection(connection);
  if (!token) throw new Error('BRIDGE_TOKEN_UNAVAILABLE: 读不到桥接控制台令牌（config.json 的 consoleToken 或 <root>/state/console-token）；请确认桥接已在同一 SURFCORE_ROOT 启动');
  const url = new URL('http://127.0.0.1:' + port + request.pathname);
  for (const [name, value] of Object.entries(request.query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  }
  const headers = { 'x-console-token': token, 'x-agent-call': '1' };
  if (request.agentToken) headers['x-agent-token'] = String(request.agentToken);
  const init = { method: request.method || 'GET', headers, signal: AbortSignal.timeout(request.timeoutMs || DEFAULT_TIMEOUT_MS) };
  if (init.method !== 'GET' && request.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(request.body);
  }
  let response;
  try { response = await fetch(url, init); }
  catch (error) { throw new Error('BRIDGE_UNREACHABLE: 桥接未响应（' + String(error?.message || error).slice(0, 140) + '）'); }
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  if (!response.ok) throw new Error(errorText(parsed?.error, '桥接 API HTTP ' + response.status));
  if (parsed && typeof parsed === 'object' && parsed.ok === false) throw new Error(errorText(parsed.error, '桥接 API 返回 ok:false（未说明原因）'));
  return parsed;
}

export function registerLifeTools(server, options = {}) {
  const connection = resolveLifeConnection(options);
  const tool = (name, description, shape, run) => server.registerTool(name, {
    description, inputSchema: z.object(shape).strict(),
  }, async (args) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await run(args), null, 2) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', error: String(error?.message ?? error) }) }] }; }
  });
  const ONLY_QQ = '仅 QQ 会话可用（reserved2 模式、且会话在当前模式白名单内）；写参数还需主人本人身份（主人私聊或主人本人触发的回合），否则桥接拒绝。';
  const key = z.string().min(3).max(200).describe('QQ 会话 key：private:<QQ号> 或 group:<群号>；必须是当前会话，不要猜测、拼接或伪造');
  const token = z.string().min(1).max(1024).describe('当前会话令牌（唤醒提示里的【会话令牌】）；只随本次调用发送，不写文件、不转发');
  const id = z.string().min(1).max(200);
  const reason = z.string().min(1).max(1200);
  const keyed = (name, description, shape, method, pathname, pick) => tool(name, description, { key, token, ...shape }, async (args) => {
    const { key: sessionKey, token: sessionToken, ...rest } = args;
    const query = method === 'GET' ? { key: sessionKey, ...(pick ? pick(rest) : {}) } : undefined;
    const body = method === 'POST' ? { key: sessionKey, ...rest } : undefined;
    return bridgeRequest(connection, { method, pathname, query, body, agentToken: sessionToken });
  });
  keyed('life_state',
    '查询系统事实：保存值、运行时采用证据、待生效、调度、预算和未知项。配置采用不是平台行为证明。' + ONLY_QQ,
    {}, 'GET', '/api/life/state', () => ({}));
  keyed('life_catalog',
    '发现能自行调整的生活参数和意图方案；不搜索源码，不执行修改。可传 query 过滤（如“群聊”“B站”“目的”）。' + ONLY_QQ,
    { query: z.string().max(200).optional() }, 'GET', '/api/life/catalog', (rest) => ({ q: rest.query }));
  keyed('life_explain',
    '理解一个参数的影响、成本、依赖、生效和恢复办法。' + ONLY_QQ,
    { id }, 'GET', '/api/life/explain', (rest) => ({ id: rest.id }));
  keyed('life_preview',
    '预览精确计划。patch 的键必须是目录中的稳定 ID，或提供一个明确 intent；不会执行。' + ONLY_QQ,
    { patch: z.record(z.string(), z.unknown()).optional(), intent: z.string().max(80).optional(), reason, experience: z.string().max(1200).optional() },
    'POST', '/api/life/preview');
  keyed('life_apply',
    '在本人选择后执行已预览计划；并发或审批不满足时拒绝。返回已保存，之后需 verify。' + ONLY_QQ,
    { planId: id }, 'POST', '/api/life/apply');
  keyed('life_verify',
    '检查独立运行时读点；停用、旧版本、过期或未观察都不假装生效。' + ONLY_QQ,
    { changeId: id.optional() }, 'GET', '/api/life/verify', (rest) => ({ changeId: rest.changeId }));
  keyed('life_history',
    '分页查修改及后续观察；不把规则推断写成真实心理或自动接受永久偏好。' + ONLY_QQ,
    { offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() },
    'GET', '/api/life/history', (rest) => ({ offset: rest.offset, limit: rest.limit }));
  keyed('life_rollback',
    '预览恢复某次修改前的值；拒绝覆盖后来改变的同一参数。返回计划，仍需本人调用 apply。' + ONLY_QQ,
    { changeId: id, reason }, 'POST', '/api/life/rollback');
  keyed('life_observe',
    '记录本人明确报告的观察和保留/考虑撤回选择；不自动修改设置或伪造平台结果。' + ONLY_QQ,
    { changeId: id, text: reason, decision: z.enum(['undecided', 'keep', 'consider-revert']).optional(), evidenceRef: z.string().max(1200).optional() },
    'POST', '/api/life/observe');
  return connection;
}
