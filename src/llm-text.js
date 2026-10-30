// 通用文本补全（一次请求、一段回复，不带工具）。
//
// 为什么要这个模块：SurfCore 里有些活需要「另一段脑子」——把散碎的记忆记录压成
// 一段回忆、给一段聊天起个小标题。这些活不该塞进 DSH 会话（那会污染她自己的上下文，
// 也烧 QQ 额度），所以直接走一条独立的小请求。
//
// 通道复用 web_search 那条：DeepSeek 的 Anthropic 兼容 Messages 端点，同一个 key
// （解析顺序也一致：config.json → 环境变量 → DSH 凭据）。这样不用再要一份凭据。
//
// 安全边界：
// - key 只发往 https 公网端点（拒绝本机/内网地址，防 SSRF 式外泄）；
// - key 不进日志、不进错误信息；
// - 响应体有上限、请求有总超时。
import https from 'node:https';
import { URL } from 'node:url';
import { loadSearchConfig, resolveSearchApiKey } from './web-search.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MODEL = 'deepseek-flash';
const PUBLIC_HOST_RE = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

/**
 * 校验补全端点：必须 https、必须公网。
 * 返回 { url, addresses } 形态和 web-search 的校验结果对齐（这里只需要 url）。
 */
function validateEndpoint(baseURL) {
  let url;
  try {
    url = new URL(String(baseURL ?? '').trim());
  } catch {
    throw Object.assign(new Error('补全端点不是合法 URL'), { code: 'BAD_ENDPOINT' });
  }
  if (url.protocol !== 'https:') throw Object.assign(new Error('补全端点必须是 https'), { code: 'BAD_ENDPOINT' });
  if (PUBLIC_HOST_RE.test(url.hostname)) throw Object.assign(new Error('补全端点不能是本机/内网地址'), { code: 'BAD_ENDPOINT' });
  return url;
}

function postJson(url, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'POST', headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(Object.assign(new Error('补全响应超过大小上限'), { code: 'TOO_LARGE' }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('补全请求超时'), { code: 'TIMEOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

/** 从 Anthropic 兼容响应里取纯文本。 */
function extractText(parsed) {
  const blocks = Array.isArray(parsed?.content) ? parsed.content : [];
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * 发一次补全请求，返回纯文本。
 *
 * @param {object} opts
 * @param {string} opts.user  用户消息（必填）
 * @param {string} [opts.system] 系统提示
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.root] 读 config.json 的目录（默认 process.cwd()）
 */
export async function completeText({ user, system = '', model, maxTokens = 1200, timeoutMs = 60000, root } = {}) {
  if (!user || !String(user).trim()) throw Object.assign(new Error('completeText：user 不能为空'), { code: 'BAD_INPUT' });
  const cfg = loadSearchConfig(root || process.cwd());
  const { key } = resolveSearchApiKey(cfg);
  if (!key) {
    throw Object.assign(new Error('没有可用的 DeepSeek API key（config.json 的 webSearch.apiKey / DEEPSEEK_API_KEY / DSH 凭据都没有）'), { code: 'NO_KEY' });
  }
  const base = String(cfg.baseURL || 'https://api.deepseek.com/anthropic/v1').replace(/\/+$/, '');
  const endpointBase = validateEndpoint(base);
  const endpoint = new URL(`${endpointBase.toString().replace(/\/+$/, '')}/messages`);
  const payload = {
    model: String(model || cfg.model || DEFAULT_MODEL),
    // 下限给 512：deepseek-flash 会先出一段 thinking，max_tokens 太小（试过 100）
    // 会被 thinking 吃光，返回 200 但只有 thinking 块、没有正文。
    max_tokens: Math.max(512, Math.min(8192, Number(maxTokens) || 1200)),
    messages: [{ role: 'user', content: [{ type: 'text', text: String(user) }] }]
  };
  if (system && String(system).trim()) payload.system = String(system).trim();
  const response = await postJson(endpoint, {
    headers: {
      'x-api-key': key,
      authorization: `Bearer ${key}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'surfcore-llm-text/0.1.0'
    },
    body: JSON.stringify(payload),
    timeoutMs: Math.max(5000, Math.min(180000, Number(timeoutMs) || 60000))
  });
  if (response.status < 200 || response.status >= 300) {
    let detail = '';
    try {
      const parsed = JSON.parse(response.text);
      const message = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message;
      if (typeof message === 'string') detail = message.slice(0, 200);
    } catch {}
    throw Object.assign(new Error(`补全接口 HTTP ${response.status}${detail ? `：${detail}` : ''}`), {
      code: 'HTTP_ERROR',
      status: response.status
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw Object.assign(new Error('补全接口返回了无法解析的响应'), { code: 'BAD_BODY' });
  }
  const text = extractText(parsed);
  if (!text) {
    const reason = parsed?.stop_reason === 'max_tokens' ? '（max_tokens 被 thinking 吃光了，调大一点）' : '';
    throw Object.assign(new Error(`补全接口没有返回正文${reason}`), { code: 'EMPTY', stopReason: parsed?.stop_reason ?? null });
  }
  return { text, model: payload.model, usage: parsed?.usage ?? null };
}
