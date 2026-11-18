/**
 * 生活参数（life-settings）桥接 HTTP 面。
 *
 * 设计要点（为什么不是把 manager 塞进 MCP 进程）：
 *   · MCP stdio 进程拿不到「这一轮是谁触发的」；而 bridge 有真实 sender 归因
 *     （state/turn-triggers.json + ownerTurnAllowed），所以写权限必须在这里判。
 *   · MCP 进程持有 consoleToken（历史原因，见 mcp-snowluma-safe.js）；如果它直接调
 *     管理端点就等于把会话体升级成管理员（confused deputy）。因此这里的契约是：
 *       - 带 x-agent-token 的请求：只按「会话自身」权限处理，且写操作必须过 owner 回合闸；
 *       - 不带 x-agent-token 的请求：才是控制台管理端（approve / pending / 只读查看）。
 *   · MCP 侧只做 HTTP 代理，工具调用的鉴权/限频/审计全部集中在本文件与 bridge 的闭包里。
 *
 * 本模块不 import bridge 的任何全局状态，所有环境依赖通过参数注入（便于单测）。
 * manager 的落盘格式/事务语义见 src/life-settings/manager.js（参考实现移植）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createManager } from './life-settings/manager.js';

const MAX_BODY_CHARS = 200000;
const AUDIT_MAX_BYTES = 1024 * 1024;

function trimText(value, max = 1200) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function appendAudit(root, record) {
  try {
    const dir = path.join(root, 'state');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'life-settings-audit.jsonl');
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* 不存在=0 */ }
    if (size > AUDIT_MAX_BYTES) {
      try { fs.renameSync(file, `${file}.1`); } catch { /* 轮转失败就继续追加 */ }
    }
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch { /* 审计失败不能影响主流程 */ }
}

/**
 * @param {object} options
 * @param {string} options.root            surfcore 仓库根（用于审计文件与 manager scope）
 * @param {string} options.dshHome         DSH 用户目录
 * @param {(msg:string)=>void} [options.log]
 */
export function createLifeApi(options = {}) {
  const root = options.root;
  const dshHome = options.dshHome;
  const log = typeof options.log === 'function' ? options.log : () => {};
  if (!root || !dshHome) throw new Error('createLifeApi 需要 root 与 dshHome');

  /** 只读管理端（consoleToken 已由 bridge 验证过）。 */
  function operatorManager() {
    return createManager({ root, dshHome, actor: 'operator:console' });
  }

  /** agent 会话：actor 绑定到会话 key，apply 只能提交自己预览的计划。 */
  function agentManager(key) {
    return createManager({ root, dshHome, actor: `agent:${key}` });
  }

  function auditBase(req) {
    return {
      at: new Date().toISOString(),
      via: req.isAgent ? 'agent' : 'operator',
      key: req.isAgent ? String(req.key ?? '') : '',
      ownerTurn: req.isAgent ? req.ownerTurn === true : null,
    };
  }

  function ok(body) {
    return { status: 200, body: { ok: true, ...body } };
  }

  function fail(status, error) {
    return { status, body: { ok: false, error: String(error || '未知错误') } };
  }

  function reject(error) {
    const message = String(error?.message || error || '未知错误');
    const code = /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1] || '';
    // CONFIG_BUSY/APPROVAL_REQUIRED 之类是「现在不行」，不是路由错误；统一 400 交给工具层展示。
    return fail(code ? 409 : 400, message);
  }

  function readPaging(query) {
    const offset = Number(query.get('offset') ?? 0);
    const limit = Number(query.get('limit') ?? 20);
    return {
      offset: Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0,
      limit: Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 20,
    };
  }

  /**
   * 处理一次 /api/life/* 请求。
   *
   * req 由 bridge 组装（鉴权已由 bridge 完成，本函数只做「权限标志 → 动作」映射）：
   *   { method, pathname, query: URLSearchParams, body: object, isAgent, key,
   *     allowedRead:boolean, allowedWrite:boolean, ownerTurn:boolean }
   *
   * 返回 {status, body}，由 bridge 统一 sendJson。
   */
  async function handle(req) {
    const method = String(req.method ?? 'GET').toUpperCase();
    const pathname = String(req.pathname ?? '');
    const suffix = pathname.replace(/^\/api\/life/, '');
    const query = req.query instanceof URLSearchParams ? req.query : new URLSearchParams();
    const body = asObject(req.body);
    const isAgent = req.isAgent === true;
    const key = String(req.key ?? '').trim();
    const audit = auditBase(req);

    if (!['GET', 'POST'].includes(method)) return fail(405, '仅支持 GET/POST');
    if (isAgent && !key) return fail(403, '缺少 key：agent 工具调用必须带会话 key');
    if (isAgent && req.allowedRead !== true) return fail(403, '当前会话不允许读取生活参数');

    // 写操作统一在这里判：读权限 + owner 回合 + 频率预算（bridge 注入）。
    // preview 只是生成计划（不影响生效参数），按规格不计入写入频率；apply/rollback/observe 计。
    const requireWrite = ({ count = true } = {}) => {
      if (!isAgent) return null;
      if (req.allowedWrite !== true) {
        return fail(403, '生活参数只能在主人本人私聊、或主人本人触发的回合里修改（当前会话不在授权范围）');
      }
      if (typeof req.rateLimitOk === 'function') {
        const gate = req.rateLimitOk(key, { count });
        if (gate && gate.ok === false) {
          return fail(429, gate.error || '修改太频繁：请稍后再试');
        }
      }
      return null;
    };

    const record = (extra) => appendAudit(root, { ...audit, ...extra });
    const done = (action, result, extra = {}) => {
      record({ action, ...extra, ok: true });
      return ok(result);
    };
    const failed = (action, error, extra = {}) => {
      const message = String(error?.message || error || '未知错误');
      record({ action, ...extra, ok: false, error: message.slice(0, 300) });
      return reject(error);
    };

    try {
      switch (`${method} ${suffix}`) {
        // ── 只读 ────────────────────────────────────────────────────────────
        case 'GET /state': {
          const manager = isAgent ? agentManager(key) : operatorManager();
          const state = manager.state();
          return done('state', state);
        }
        case 'GET /catalog': {
          const manager = isAgent ? agentManager(key) : operatorManager();
          const q = trimText(query.get('q') ?? '', 200);
          return done('catalog', manager.catalog(q));
        }
        case 'GET /explain': {
          const id = trimText(query.get('id') ?? '', 100);
          if (!id) return fail(400, '缺少 id');
          const manager = isAgent ? agentManager(key) : operatorManager();
          return done('explain', manager.explain(id), { id });
        }
        case 'GET /verify': {
          const changeId = trimText(query.get('changeId') ?? '', 100) || null;
          const manager = isAgent ? agentManager(key) : operatorManager();
          return done('verify', manager.verify(changeId), { changeId });
        }
        case 'GET /history': {
          const manager = isAgent ? agentManager(key) : operatorManager();
          const paging = readPaging(query);
          return done('history', manager.history(paging));
        }

        // ── 写（agent 需 owner 回合；operator 走 consoleToken）────────────────
        case 'POST /preview': {
          if (isAgent) {
            const gate = requireWrite({ count: false });
            if (gate) return gate;
          }
          const manager = isAgent ? agentManager(key) : operatorManager();
          const patch = body.patch === undefined ? undefined : asObject(body.patch);
          const intent = typeof body.intent === 'string' ? trimText(body.intent, 80) : undefined;
          const reason = trimText(body.reason, 1200);
          const experience = trimText(body.experience, 1200);
          if (!patch && !intent) return fail(400, 'patch 与 intent 必须二选一');
          const plan = manager.preview({ patch, intent, reason, experience });
          return done('preview', plan, { planId: plan?.id });
        }
        case 'POST /apply': {
          const gate = requireWrite();
          if (gate) return gate;
          const planId = trimText(body.planId, 100);
          if (!planId) return fail(400, '缺少 planId');
          const manager = isAgent ? agentManager(key) : operatorManager();
          const result = manager.apply(planId);
          return done('apply', result, { planId, changeId: result?.changeId });
        }
        case 'POST /rollback': {
          const gate = requireWrite();
          if (gate) return gate;
          const changeId = trimText(body.changeId, 100);
          const reason = trimText(body.reason, 1200);
          if (!changeId) return fail(400, '缺少 changeId');
          if (!reason) return fail(400, '回滚必须说明原因');
          const manager = isAgent ? agentManager(key) : operatorManager();
          const plan = manager.rollback({ changeId, reason });
          return done('rollback', plan, { changeId, planId: plan?.id });
        }
        case 'POST /observe': {
          const gate = requireWrite();
          if (gate) return gate;
          const changeId = trimText(body.changeId, 100);
          const text = trimText(body.text, 1200);
          if (!changeId || !text) return fail(400, 'observe 需要 changeId 与 text');
          const manager = isAgent ? agentManager(key) : operatorManager();
          const observation = manager.observe({
            changeId,
            text,
            decision: body.decision,
            evidenceRef: trimText(body.evidenceRef, 1200),
          });
          return done('observe', observation, { changeId });
        }

        // ── 管理端（只允许 consoleToken 路径；带 agent token 的请求已在 bridge 拒绝）──
        case 'GET /pending': {
          if (isAgent) return fail(403, '该接口仅控制台可用');
          const manager = operatorManager();
          const state = manager.state();
          return done('pending', {
            revision: state.revision,
            pendingApprovals: state.pendingApprovals,
            recentChanges: state.recentChanges,
            observedAt: state.observedAt,
          });
        }
        case 'POST /approve': {
          if (isAgent) return fail(403, '该接口仅控制台可用');
          const planId = trimText(body.planId, 100);
          const reason = trimText(body.reason, 1200);
          if (!planId || !reason) return fail(400, 'approve 需要 planId 与 reason');
          const manager = operatorManager();
          const result = manager.approve({ planId, reason, operator: true });
          return done('approve', result, { planId });
        }

        default:
          return fail(404, `未知的生活参数接口：${method} ${pathname}`);
      }
    } catch (error) {
      const action = `${method} ${suffix}`;
      return failed(action, error);
    }
  }

  return { handle, MAX_BODY_CHARS };
}
