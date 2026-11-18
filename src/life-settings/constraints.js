import { BY_ID, validateValue, same, splitCrossMidnightWindows } from './catalog.js';

const PAIRS = [
  ['qq.socialV2.wake.recommendedSleepMinMs', 'qq.socialV2.wake.recommendedSleepMaxMs'],
  ['qq.socialV2.proactive.checkIntervalMinMs', 'qq.socialV2.proactive.checkIntervalMaxMs'],
  ['purpose.gapMinMs', 'purpose.gapMaxMs'],
];
export function checkPlan(current, requested) {
  if (!requested || typeof requested !== 'object' || Array.isArray(requested) || Object.keys(requested).length === 0 || Object.keys(requested).length > 32) throw new Error('INVALID_PATCH');
  const next = structuredClone(current);
  const additions = {};
  const warnings = [];
  for (const [id, value] of Object.entries(requested)) {
    const p = BY_ID.get(id);
    if (!p) throw new Error('PROTECTED_OR_UNKNOWN_PARAMETER: ' + id);
    // 本地化增强（IMPL-SPEC §2.4）：跨午夜窗口在这里先拆成存储可接受的非重叠窗口，
    // 校验、change、存储、消费者都只见拆分后的值；apply 重放时输入已是拆分值，不会重复拆。
    let normalized = value;
    let splitNote = null;
    if (id === 'bili.night.windows') {
      const split = splitCrossMidnightWindows(value);
      normalized = split.windows;
      if (split.split) splitNote = '跨午夜窗口已拆成 ' + normalized.map((w) => String(w?.start) + '–' + String(w?.end)).join('、') + '；存储与消费者只见拆分后的非重叠窗口，每日总次数仍受 bili.night.maxWakesPerDay 约束。';
    }
    validateValue(p, normalized);
    next[id] = structuredClone(normalized);
    if (splitNote) warnings.push(splitNote);
  }
  const add = (id, value, explanation) => {
    additions[id] = explanation;
    next[id] = structuredClone(value);
  };
  for (const [min, max] of PAIRS) {
    if (!Object.hasOwn(requested, min) && !Object.hasOwn(requested, max)) continue;
    if (next[min] > next[max]) {
      if (Object.hasOwn(requested, min) && Object.hasOwn(requested, max)) throw new Error('COUPLED_RANGE_INVALID: ' + min + ' > ' + max);
      if (Object.hasOwn(requested, min)) add(max, next[min], '同步上界，避免实际引擎钳位造成保存值与采用值不一致');
      else add(min, next[max], '同步下界，避免上下界倒置');
    }
  }
  if (Object.keys(requested).some((id) => id.startsWith('bili.night.'))) {
    const windows = structuredClone(next['bili.night.windows']);
    const cap = next['bili.night.maxWakesPerDay'];
    const gap = next['bili.night.minGapMin'];
    const minutes = (time) => Number(time.slice(0,2)) * 60 + Number(time.slice(3));
    const capacity = windows.map((w) => Math.max(0, Math.floor((minutes(w.end) - minutes(w.start) - 1) / gap) + 1));
    const total = windows.reduce((sum,w) => sum + w.wakes, 0);
    if (cap > 0 && windows.length === 0) throw new Error('NO_ACTIVITY_WINDOW: 请明确选择至少一个窗口，或每日次数设为 0');
    if (Object.hasOwn(requested, 'bili.night.maxWakesPerDay') && cap > total) {
      let missing = cap - total;
      for (let i = 0; i < windows.length && missing; i++) {
        const more = Math.max(0, Math.min(missing, capacity[i] - windows[i].wakes, 12 - windows[i].wakes));
        windows[i].wakes += more; missing -= more;
      }
      if (missing) throw new Error('INFEASIBLE_SCHEDULE: 当前窗口与最小间隔容纳不了所选次数，请先明确扩展窗口或缩短间隔');
      add('bili.night.windows', windows, '同步每窗机会数，使提高每日次数不会被窗口 wakes 吞掉');
    }
    // wakes is capacity, not a requirement to consume every opportunity.
    if (cap>0) {
      let earliest = -Infinity;
      for (const w of windows.slice(0,cap).sort((a,b) => a.start.localeCompare(b.start))) {
        earliest=Math.max(minutes(w.start),earliest+gap);
        if (earliest>=minutes(w.end)) throw new Error('INFEASIBLE_GLOBAL_GAP: 相邻活动窗口容纳不了全局最小间隔，请扩展窗口或减少机会');
      }
      const possible=windows.reduce((sum,w,i)=>sum+Math.min(w.wakes,capacity[i]),0);
      if (possible<cap) warnings.push('窗口与间隔最多容纳 '+possible+' 次，少于每日上限；随机排程还可能继续减少。');
    }
    if (cap > windows.reduce((sum,w) => sum + w.wakes, 0)) warnings.push('每日次数是上限，当前窗口机会更少，实际取更小值。');
    warnings.push('这是可行机会的上限，不保证实际次数；随机排程可放弃额外 slot。今日已用次数、错过窗口、跳过概率、登录、独立监听与 token 预算仍约束结果；不补跑错过机会。');
  }
  if (Object.keys(requested).some((id) => id.startsWith('bili.preferences.'))) {
    const like = next['bili.preferences.like'];
    const keywords = next['bili.preferences.keywords'].filter((k) => !like.some((x) => x.toLowerCase() === k.toLowerCase()));
    if (!same(keywords, next['bili.preferences.keywords'])) add('bili.preferences.keywords', keywords, '同一个主题只计一次，以 like 为准');
    const allowed = new Set([...like, ...keywords]);
    const weights = next['bili.preferences.weights'];
    const unknown = Object.keys(weights).filter((k) => !allowed.has(k));
    if (unknown.length) {
      if (Object.hasOwn(requested, 'bili.preferences.weights')) throw new Error('UNKNOWN_INTEREST_WEIGHT: 先登记兴趣词再为它设置权重');
      add('bili.preferences.weights', Object.fromEntries(Object.entries(weights).filter(([k]) => allowed.has(k))), '移除已删除主题的残留权重');
    }
  }
  const changes = [];
  for (const id of new Set([...Object.keys(requested), ...Object.keys(additions)])) {
    const p = BY_ID.get(id);
    validateValue(p, next[id]);
    if (!same(current[id], next[id])) changes.push({
      id, name: p.name, before: current[id], after: next[id],
      coupled: Object.hasOwn(additions,id), explanation: additions[id] || p.impact,
      permission: p.permission, effect: p.effect, risk: p.risk, verification: p.verification,
    });
  }
  return { changes, warnings, next };
}
/** Deterministic choices to preview, never keyword-triggered execution. */
export function intentPatch(intent, current) {
  switch (intent) {
    case 'less-disturbance': return {
      'qq.socialV2.proactive.enabled': false, 'purpose.enabled': false,
      'qq.socialV2.wake.recommendedProbability': Math.min(0.02, current['qq.socialV2.wake.recommendedProbability']),
    };
    case 'more-group-opportunities': return {
      'qq.socialV2.proactive.enabled': true,
      'qq.socialV2.proactive.probability': Math.min(0.6, current['qq.socialV2.proactive.probability'] + 0.1),
      'qq.socialV2.proactive.checkIntervalMinMs': Math.max(60000, Math.round(current['qq.socialV2.proactive.checkIntervalMinMs'] * 0.8)),
      'qq.socialV2.proactive.checkIntervalMaxMs': Math.max(60000, Math.round(current['qq.socialV2.proactive.checkIntervalMaxMs'] * 0.8)),
    };
    case 'more-solitude': return { 'qq.socialV2.proactive.enabled': false, 'purpose.enabled': false, 'bili.night.maxWakesPerDay': 0 };
    case 'more-exploration': return {
      'bili.night.maxWakesPerDay': Math.min(12, current['bili.night.maxWakesPerDay'] + 1),
      'bili.night.maxVideos': Math.min(20, current['bili.night.maxVideos'] + 1),
    };
    case 'fewer-model-opportunities': return {
      'qq.socialV2.proactive.enabled': false, 'purpose.enabled': false,
      'bili.night.maxWakesPerDay': Math.max(0, current['bili.night.maxWakesPerDay'] - 1),
    };
    default: throw new Error('UNKNOWN_INTENT: 请选择目录中的明确操作或提供参数 patch');
  }
}
export const INTENTS = [
  { id: 'less-disturbance', name: '减少主动打扰', note: '关闭主动机会；来信、B站监听与已有会话选择独立生效' },
  { id: 'more-group-opportunities', name: '提高群聊参与机会', note: '增加机会不要求发言；不绕过社交保护与预算' },
  { id: 'more-solitude', name: '增加独处时间', note: '关闭两类主动机会和自动浏览；不关闭来信监听或取消在途活动' },
  { id: 'more-exploration', name: '增加自主浏览机会', note: '联动窗口机会、每日次数与单次浏览量，仍需登录与预算' },
  { id: 'fewer-model-opportunities', name: '减少自主模型机会', note: '减少自动机会，不能保证具体金额，监听/人工消息/在途请求仍可能消费' },
];
