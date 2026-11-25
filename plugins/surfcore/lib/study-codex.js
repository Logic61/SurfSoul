import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
let proxyCheck;
let proxyCheckedAt = 0;

export async function windowsLoopbackProxy({ openAiApi = false } = {}) {
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const endpoint = openAiApi ? 'https://api.openai.com/v1/responses' : 'https://chatgpt.com/backend-api/codex/responses';
  const script = "$u=[uri]'" + endpoint + "'; $p=[Net.WebRequest]::GetSystemWebProxy(); if (!$p.IsBypassed($u)) { $p.GetProxy($u).AbsoluteUri }";
  try {
    const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 2500, maxBuffer: 4096,
    });
    const url = new URL(stdout.trim());
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)
        && !url.username && !url.password) return url.origin;
  } catch { /* Direct access or unavailable Windows proxy information. */ }
}

export async function codexEnvironment() {
  if (process.platform !== 'win32' || process.env.HTTPS_PROXY || process.env.ALL_PROXY || process.env.HTTP_PROXY) return process.env;
  if (!proxyCheck || Date.now() - proxyCheckedAt >= 30000) {
    proxyCheckedAt = Date.now();
    proxyCheck = windowsLoopbackProxy();
  }
  const proxy = await proxyCheck;
  return proxy ? { ...process.env, HTTPS_PROXY: proxy } : process.env;
}

function failure(message) {
  if (/auth|unauthorized|sign in|401/i.test(message)) return new Error('Codex 登录状态失效，请检查 codex login status');
  if (/connect|network|timed? ?out|stream|websocket/i.test(message)) return new Error('Codex 连接超时或中断，请检查系统代理和网络');
  return new Error('Codex CLI 未完成看图，请检查登录与模型服务');
}

export async function codexVision({ prompt, jpeg, signal }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'surfcore-study-'));
  const cleanup = () => rm(dir, { recursive: true, force: true, maxRetries: 3 });
  let child;
  try {
    const image = path.join(dir, 'frame.jpg');
    const [env] = await Promise.all([codexEnvironment(), writeFile(image, jpeg, { mode: 0o600 })]);
    signal?.throwIfAborted();
    const exe = process.env.SURFCORE_CODEX_EXE || (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe') : 'codex');
    const args = ['-a', 'never', 'exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral',
      '--sandbox', 'read-only', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps',
      '--disable', 'plugins', '--disable', 'image_generation', '-c', 'web_search="disabled"',
      '-c', 'model_reasoning_effort="low"', '--json', '--image', image, '-'];
    return await new Promise((resolve, reject) => {
      child = spawn(exe, args, { cwd: dir, env, signal, windowsHide: true, timeout: 90000 });
      let reply = '', lastError = '';
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') reply = event.item.text;
        if (event.type === 'error') lastError = String(event.message || '');
        if (event.type === 'turn.failed') reject(failure(event.error?.message || lastError));
        if (event.type === 'turn.completed' && reply) resolve(reply);
      });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.once('error', error => reject(signal?.aborted ? new Error('请求已停止')
        : error.code === 'ENOENT' ? new Error('找不到 Codex CLI，请检查运行路径') : failure(error.message)));
      child.once('close', (code, stopSignal) => {
        void cleanup().catch(() => {});
        if (code === 0 && reply) resolve(reply);
        else reject(failure(lastError || (stopSignal ? 'timeout' : '')));
      });
      child.stdin.end(prompt);
    });
  } finally {
    if (!child) await cleanup();
  }
}
