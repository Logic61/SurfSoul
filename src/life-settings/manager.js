import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PARAMETERS, BY_ID, READ_ONLY, getPath, same } from './catalog.js';
import { checkPlan, intentPatch, INTENTS } from './constraints.js';
import { hash, scopePaths, readJson, readState, withStateLock, saveState, sourceFingerprint } from './file-store.js';
import { readRuntimeEvidence } from './runtime.js';
import { budgetSnapshot } from './budget.js';

const note = (text, required = false) => {
  if (typeof text !== 'string' || (required && !text.trim()) || text.length > 1200 || /\0/.test(text)) throw new Error('INVALID_REASON: 使用不超过 1200 字的明确说明');
  return text.trim();
};
/**
 * 本地化增强（IMPL-SPEC §3 manager 行）——写入上限裁剪，防止 plans/history/observations 单调增长：
 *   · plans 最多 50 条；超限时先清「已应用 / 已过期」的历史计划，仍有超额则只留最近 50 条未决计划。
 *   · history 最多 1000 条（超出丢最旧，回滚保护只覆盖仍在档的历史）。
 *   · observations 最多 1000 条（同上）。
 * 只做裁剪，不改任何事务语义；apply 的幂等记录仍保留在 history 的 change 上（planId 可查最近 50 条计划）。
 */
export const PLAN_RETENTION = 50;
export const HISTORY_RETENTION = 1000;
export const OBSERVATION_RETENTION = 1000;
function pruneState(state) {
  if (state.plans.length > PLAN_RETENTION) {
    const now = Date.now();
    const settled = (p) => Boolean(p?.appliedRevision) || Date.parse(p?.expiresAt) <= now;
    let kept = state.plans.filter((p) => !settled(p));
    if (kept.length > PLAN_RETENTION) kept = kept.slice(-PLAN_RETENTION);
    state.plans = kept;
  }
  if (state.history.length > HISTORY_RETENTION) state.history = state.history.slice(-HISTORY_RETENTION);
  if (state.observations.length > OBSERVATION_RETENTION) state.observations = state.observations.slice(-OBSERVATION_RETENTION);
  return state;
}
function baseConfigurations(paths) {
  const example = readJson(path.join(paths.root, 'config.example.json'), {});
  const qq = readJson(paths.qq, {});
  const bili = readJson(paths.bili, {});
  const unified = readJson(paths.unified, {});
  return { qq, bili, unified, example };
}
function savedValues(paths, state) {
  const sources = baseConfigurations(paths);
  const values = {};
  const origins = {};
  for (const p of PARAMETERS) {
    const value = getPath(sources[p.domain], p.path) ?? (p.domain === 'qq' ? getPath(sources.example, p.path) : undefined);
    values[p.id] = structuredClone(Object.hasOwn(state.overrides,p.id) ? state.overrides[p.id] : (value ?? p.defaultValue));
    origins[p.id] = Object.hasOwn(state.overrides,p.id) ? 'agent-managed-override' : value === undefined ? 'catalog-reference-default' : 'human-base-config';
  }
  return { values, origins, sources };
}
function proofFor(p, value, state, evidence) {
  const e = evidence[p.evidenceProducer];
  if (!e.valid) return { status: 'saved-unverified', effectiveValue: null, evidenceStatus: e.status };
  if (e.revision !== state.revision) return { status: 'pending-runtime-reload', effectiveValue: e.values?.[p.id] ?? null, evidenceRevision: e.revision };
  if (!Object.hasOwn(e.values || {},p.id)) return { status: 'saved-unverified', effectiveValue: null, evidenceStatus: 'reader-not-observed' };
  return { status: same(e.values[p.id],value) ? 'runtime-adopted' : 'verification-failed',
    effectiveValue: e.values[p.id], observedAt: e.observedAt, source: e.source,
    mode: e.details?.mode || 'runtime', behavioralEffect: 'not-proven-by-config-adoption' };
}
export function createManager(options = {}) {
  const paths = scopePaths(options);
  const actor = options.actor || 'agent:surfcore';
  const evidenceNow = () => ({
    qq: readRuntimeEvidence('qq', options), bili: readRuntimeEvidence('bili', options),
  });
  // sidecar 与 journal 是单次原子提交；写入前统一做保留上限裁剪。
  const commit = (state) => { pruneState(state); saveState(paths, state); };
  const state = () => {
    const s = readState(paths);
    const { values, origins, sources } = savedValues(paths,s);
    const evidence = evidenceNow();
    return {
      revision: s.revision, observedAt: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      parameters: PARAMETERS.map((p) => ({ id:p.id, name:p.name, savedValue:values[p.id], origin:origins[p.id], ...proofFor(p,values[p.id],s,evidence) })),
      runtime: evidence,
      readOnly: READ_ONLY.map((p) => ({ ...p, savedValue: getPath(sources[p.source],p.path) ?? null, effectiveValue:null, status:'saved-only' })),
      budget: budgetSnapshot(options),
      subject: { actor, scopeId:paths.scopeId, identitySource:'运行目录绑定；不把模型自述当账号身份' },
      recentChanges: s.history.slice(-5).map(({id,revision,actor,createdAt,reason}) => ({id,revision,actor,createdAt,reason})),
      pendingApprovals: s.plans.filter((p) => p.approvalRequired && !p.approval && !p.appliedRevision && Date.parse(p.expiresAt) > Date.now()).map((p)=>({id:p.id,expiresAt:p.expiresAt,changes:p.changes})),
      capabilities: { parameterManagement:true, qq:evidence.qq.valid ? 'runtime-observed' : 'not-observed', bili:evidence.bili.valid ? 'runtime-observed' : 'not-observed', externalSending:'原有平台授权、登录、白名单与硬额度另行约束' },
    };
  };
  const catalog = (query = '') => {
    if (typeof query !== 'string' || query.length > 200) throw new Error('INVALID_QUERY');
    const q = query.trim().toLowerCase();
    const aliases = q.includes('群') ? 'qq' : /b站|浏览|探索/.test(q) ? 'bili' : /目的|联系/.test(q) ? 'purpose' : '';
    return {
      parameters: PARAMETERS.filter((p) => !q || [p.id,p.name,p.description].join(' ').toLowerCase().includes(q) || (aliases && p.id.startsWith(aliases))).map((p) => ({...p})),
      intents:INTENTS, readOnly:READ_ONLY,
    };
  };
  const explain = (id) => {
    const p = BY_ID.get(id);
    if (!p) { const ro = READ_ONLY.find((p)=>p.id===id); if (ro) return ro; throw new Error('UNKNOWN_PARAMETER'); }
    const s = state();
    return { ...p, ...s.parameters.find((x) => x.id===id), relatedIntents:INTENTS,
      dependencies:[...p.dependencies, ...(id.startsWith('bili.night.') ? ['bili.night.windows','bili.night.maxWakesPerDay','bili.night.minGapMin','bili.night.skipChance','bili.limits','tokenBudget','platform-login','scheduler-running'] : [])],
      restartRequired:false, semantics:'保存、运行时采用、实际行为/消费是三个不同事实；默认值不是本人偏好。' };
  };
  const preview = ({ patch, intent, reason, experience = '', rollbackOf = null, expectedRevision, expectedSourceFingerprint } = {}) => withStateLock(paths,(s) => {
    if ((expectedRevision!==undefined && expectedRevision!==s.revision) ||
      (expectedSourceFingerprint!==undefined && expectedSourceFingerprint!==sourceFingerprint(paths))) throw new Error('ROLLBACK_CONFLICT: 环境已改变，请重新检查历史');
    const rationale = note(reason,true);
    note(experience);
    const initialFingerprint=sourceFingerprint(paths);
    const { values } = savedValues(paths,s);
    if (Boolean(patch) === Boolean(intent)) throw new Error('EXACTLY_ONE_PATCH_OR_INTENT_REQUIRED');
    const checked = checkPlan(values, intent ? intentPatch(intent,values) : patch);
    if (!checked.changes.length) return { status:'no-change', revision:s.revision, changes:[], warnings:checked.warnings };
    const plan = {
      id:'plan-' + randomUUID(), baseRevision:s.revision, sourceFingerprint:initialFingerprint,
      createdAt:new Date().toISOString(), expiresAt:new Date(Date.now()+15*60000).toISOString(),
      actor, reason:rationale, experience, intent:intent||null, rollbackOf,
      changes:checked.changes, warnings:checked.warnings,
      approvalRequired:checked.changes.some((c)=>c.permission==='approval'), approval:null,
      restartRequired:false,
      evidenceBefore: Object.fromEntries(Object.entries(evidenceNow()).map(([k,e])=>[k,{valid:e.valid,status:e.status,revision:e.revision??null,observedAt:e.observedAt??null}])),
    };
    const evidence=evidenceNow();
    for (const c of plan.changes) {
      const p=BY_ID.get(c.id), e=evidence[p.evidenceProducer];
      c.beforeEffective=e.valid && e.revision===s.revision && Object.hasOwn(e.values||{},c.id) ? structuredClone(e.values[c.id]) : null;
      c.beforeEffectiveStatus=c.beforeEffective===null?'unverified':'runtime-observed';
    }
    if(initialFingerprint!==sourceFingerprint(paths))throw new Error('CONFIG_CONFLICT: 基础文件在预览读取期间变化');
    plan.digest = hash({baseRevision:plan.baseRevision,sourceFingerprint:plan.sourceFingerprint,changes:plan.changes,actor});
    s.plans.push(plan); commit(s);
    return { ...plan, status:plan.approvalRequired?'approval-required':'ready-for-agent-choice',
      confirmation:'只有明确调用 life_apply(planId) 才执行；预览不改变任何生效参数。' };
  });
  const apply = (planId) => withStateLock(paths,(s) => {
    const p = s.plans.find((p)=>p.id===planId);
    if (!p || p.actor!==actor) throw new Error('UNKNOWN_PLAN_OR_ACTOR');
    if (p.appliedRevision) return { status:'already-applied', revision:p.appliedRevision, changeId:p.changeId };
    if (Date.parse(p.expiresAt)<=Date.now()) throw new Error('PLAN_EXPIRED');
    if (p.baseRevision!==s.revision || p.sourceFingerprint!==sourceFingerprint(paths)) throw new Error('CONFIG_CONFLICT: 配置或基础文件已变化，请重新预览');
    if (p.approvalRequired && (!p.approval || p.approval.digest!==p.digest)) throw new Error('APPROVAL_REQUIRED: 需要本地维护者审批，Agent 工具没有审批权限');
    const { values } = savedValues(paths,s);
    const checked = checkPlan(values,Object.fromEntries(p.changes.map((c)=>[c.id,c.after])));
    if (!same(checked.changes,p.changes)) {
      // Coupled labels can differ when explicit patch replayed; compare actual transition only.
      if (!same(checked.changes.map(({id,before,after})=>({id,before,after})),p.changes.map(({id,before,after})=>({id,before,after})))) throw new Error('PLAN_CHANGED');
    }
    const beforeOverrides=structuredClone(s.overrides);
    for (const c of p.changes) s.overrides[c.id]=structuredClone(c.after);
    s.revision++;
    const change = { id:'change-'+randomUUID(), revision:s.revision, previousRevision:p.baseRevision,
      actor, createdAt:new Date().toISOString(), reason:p.reason, experience:p.experience,
      changes:p.changes, beforeOverrides, afterOverrides:structuredClone(s.overrides),
      evidenceBefore:p.evidenceBefore, rollbackOf:p.rollbackOf, planId:p.id,
      status:'saved-unverified', approval:p.approval };
    s.history.push(change); p.appliedRevision=s.revision; p.changeId=change.id;
    if(p.sourceFingerprint!==sourceFingerprint(paths))throw new Error('CONFIG_CONFLICT: 基础文件在执行读取期间变化');
    // Sidecar and journal are a single atomic commit, never a partially-written set of base files.
    commit(s);
    return {status:'saved-unverified',revision:s.revision,changeId:change.id,changes:change.changes,
      next:'调用 life_verify，等待真实运行时读取；写盘成功不表示已采用。'};
  });
  const verify = (changeId = null) => {
    const s=readState(paths);
    const current=state();
    const target=changeId?s.history.find((h)=>h.id===changeId):s.history.at(-1);
    if (!target) return {revision:s.revision,status:'no-change-to-verify',parameters:current.parameters};
    const checks=target.changes.map((c)=>({id:c.id,targetValue:c.after,...current.parameters.find((p)=>p.id===c.id)}));
    const superseded=target.revision!==current.revision || current.revision!==s.revision;
    return {changeId:target.id,revision:s.revision,targetRevision:target.revision,
      status:superseded?'superseded':checks.every((c)=>c.status==='runtime-adopted' && same(c.targetValue,c.effectiveValue))?'runtime-adopted':'saved-unverified',
      checks,validationScope:checks.some((c)=>c.mode==='local-simulation')?'local-simulation':'runtime-evidence-only',
      behavioralEffect:'需要查看真实调度/活动计数；参数采用不是外部行为验收。'};
  };
  const history = ({ offset=0, limit=20 } = {}) => {
    if (!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100) throw new Error('INVALID_PAGINATION');
    const s=readState(paths);
    return { total:s.history.length,offset,nextOffset:offset+limit<s.history.length?offset+limit:null,
      records:s.history.slice(offset,offset+limit), observations:s.observations.filter((o)=>s.history.slice(offset,offset+limit).some((h)=>h.id===o.changeId)) };
  };
  const rollback = ({changeId,reason}={}) => {
    const s=readState(paths);
    const fingerprint=sourceFingerprint(paths);
    const change=s.history.find((h)=>h.id===changeId);
    if (!change) throw new Error('UNKNOWN_CHANGE');
    const {values}=savedValues(paths,s);
    for (const c of change.changes) if (!same(values[c.id],c.after)) throw new Error('ROLLBACK_CONFLICT: 后续选择已改变同一参数，请自行预览明确目标，禁止覆盖');
    return preview({patch:Object.fromEntries(change.changes.map((c)=>[c.id,c.beforeEffectiveStatus==='runtime-observed'?c.beforeEffective:c.before])),
      reason:note(reason,true),rollbackOf:changeId,expectedRevision:s.revision,expectedSourceFingerprint:fingerprint});
  };
  const observe = ({changeId,text,decision='undecided',evidenceRef=''}={}) => withStateLock(paths,(s)=>{
    if (!s.history.some((h)=>h.id===changeId)) throw new Error('UNKNOWN_CHANGE');
    if (!['undecided','keep','consider-revert'].includes(decision)) throw new Error('INVALID_DECISION');
    const observation={id:'observation-'+randomUUID(),changeId,actor,occurredAt:new Date().toISOString(),
      observedAt:new Date().toISOString(),text:note(text,true),decision,evidenceRef:note(evidenceRef),kind:'agent-reported-observation',systemVerification:verify(changeId)};
    s.observations.push(observation); commit(s);
    return observation;
  });
  /**
   * 本地化改动（IMPL-SPEC §3 manager 行）：approve 不再依赖 createManager 的 operator 选项，
   * 改为显式传 operator —— bridge 的 /api/life/approve 只传 {operator:true}；
   * MCP 工具层没有入口（tools.js 不注册 approve），CLI 传 'cli-maintainer'。
   */
  const approve = ({planId,reason,operator,expectedRevision}={}) => {
    const operatorLabel = operator === true ? 'local-maintainer' : (typeof operator === 'string' && operator.trim() ? operator.trim().slice(0, 80) : '');
    if (!operatorLabel) throw new Error('OPERATOR_ONLY');
    return withStateLock(paths,(s)=>{
      const p=s.plans.find((p)=>p.id===planId);
      if (!p || !p.approvalRequired || p.appliedRevision) throw new Error('INVALID_APPROVAL_PLAN');
      if ((expectedRevision !== undefined && expectedRevision !== s.revision) || p.baseRevision!==s.revision || p.sourceFingerprint!==sourceFingerprint(paths) || Date.parse(p.expiresAt)<=Date.now()) throw new Error('APPROVAL_CONFLICT_OR_EXPIRED');
      p.approval={operator:operatorLabel,reason:note(reason,true),at:new Date().toISOString(),digest:p.digest};
      commit(s); return {status:'approved-for-this-exact-plan',planId,digest:p.digest};
    });
  };
  /** 待审批计划（管理端 /api/life/pending 与 CLI pending 共用；只返回仍有效且未应用的）。 */
  const pending = () => {
    const s=readState(paths);
    const now=Date.now();
    return { revision:s.revision, plans:s.plans.filter((p)=>p.approvalRequired && !p.approval && !p.appliedRevision && Date.parse(p.expiresAt)>now)
      .map((p)=>({id:p.id,createdAt:p.createdAt,expiresAt:p.expiresAt,reason:p.reason,changes:p.changes,digest:p.digest})) };
  };
  return {state,catalog,explain,preview,apply,verify,history,rollback,observe,approve,pending,paths};
}
