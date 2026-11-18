// Opt-in stdio service: life-settings MCP 代理。不启动 life / 平台 / web server / 模型；
// 只有工具调用才会 HTTP 调本机 bridge（127.0.0.1:<consolePort>），启动不依赖 bridge 在线。
//
// 环境：
//   SURFCORE_ROOT  env 优先；否则按 config.json + src/bridge.js 探测（入口仓库根 / cwd / 模块相对根）
//   DSH_HOME       env 优先；否则 ~/.dsh
// 控制台端口/令牌在 tools.js 里每次请求现读（config.json 优先，其次 <root>/state/console-token），
// 所以桥接轮换令牌后不需要重启 MCP server。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerLifeTools } from './life-settings/tools.js';

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
  try { return fs.existsSync(path.join(candidate, 'config.json')) && fs.existsSync(path.join(candidate, 'src', 'bridge.js')); }
  catch { return false; }
};
/** SURFCORE_ROOT 解析：env 优先，否则按 config.json+src/bridge.js 探测。 */
export function resolveSurfcoreRoot(env = process.env, argv1 = process.argv[1], cwd = process.cwd()) {
  if (env.SURFCORE_ROOT) return path.resolve(env.SURFCORE_ROOT);
  const entryRoot = rootFromEntry(argv1);
  const candidates = [];
  if (entryRoot) candidates.push(entryRoot);
  candidates.push(path.resolve(cwd));
  try { candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')); } catch {}
  return candidates.find(looksLikeRepoRoot) || candidates[0] || path.resolve(cwd);
}

const options = {
  root: resolveSurfcoreRoot(),
  dshHome: process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh'),
};

const server = new McpServer({ name: 'life-settings', version: '1.0.0' });
registerLifeTools(server, options);
await server.connect(new StdioServerTransport());
