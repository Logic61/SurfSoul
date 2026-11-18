/** Closed, audited API allowlist. No credentials, identity, grants or hard money caps. */
const hour = 3600000;
const minute = 60000;
const common = {
  permission: 'autonomous', risk: 'low', evidenceProducer: 'qq', effect: 'next-schedule',
  verification: '运行时在真实读取点回报采用值；待执行计时器与平台行为另外核实。',
  rollback: '预览回滚历史版本，再执行该计划；保留旧计时器与本人明确的会话选择。',
  cost: '增加唤醒或上下文通常增加调用或 token；原有预算硬闸始终优先。',
};
const make = (id, name, defaultValue, rule, impact, extra = {}) => ({
  ...common, id, name, domain: id.startsWith('bili.') ? 'bili' : 'qq',
  path: id.startsWith('purpose.') ? id : id.split('.').slice(1).join('.'),
  defaultValue, rule, impact, description: impact, dependencies: [], ...extra,
});
const int = (min, max) => ({ type: 'integer', min, max });
const prob = { type: 'number', min: 0, max: 1 };
const bool = { type: 'boolean' };
export const PARAMETERS = Object.freeze([
  make('qq.socialV2.autoReplyCheckMs', 'QQ 自动回复检查周期', 30000, int(5000, hour), '只影响下一次新建的检查计时器，不取消正在进行的对话。'),
  make('qq.socialV2.wake.recommendedProbability', '普通消息默认唤醒概率', 0.05, prob, '仅是尚未自行设置的会话默认值；本人或管理员的显式 wakeConfig 优先。'),
  make('qq.socialV2.wake.recommendedSleepMinMs', '推荐潜水最短时间', 5 * minute, int(minute, 24 * hour), '影响默认潜水建议，不覆盖本人已选择的沉睡时间。'),
  make('qq.socialV2.wake.recommendedSleepMaxMs', '推荐潜水最长时间', 2 * hour, int(minute, 24 * hour), '必须不小于最短时间；显式睡眠配置不会被强制改写。'),
  make('qq.socialV2.proactive.enabled', 'QQ 主动冒泡机会', true, bool, '关闭后不再提供主动冒泡机会；正常来信和明确呼叫仍遵循原规则。'),
  make('qq.socialV2.proactive.checkIntervalMinMs', '主动机会最短间隔', 30 * minute, int(minute, 24 * hour), '下一次排程使用此间隔；旧 nextProactiveAt 单独显示。'),
  make('qq.socialV2.proactive.checkIntervalMaxMs', '主动机会最长间隔', 90 * minute, int(minute, 24 * hour), '与最短间隔一同约束随机排程。'),
  make('qq.socialV2.proactive.idleThresholdMs', '主动冒泡前安静时间', 15 * minute, int(minute, 24 * hour), '群聊至少安静这么久才可能提供主动机会。'),
  make('qq.socialV2.proactive.probability', '主动冒泡机会概率', 0.3, prob, '提高只增加机会，不要求必须发言；白名单、鱼群保护和预算仍有效。'),
  make('qq.socialV2.closure.cooldownMs', '对话收尾后的安静时间', 20 * minute, int(minute, 24 * hour), '收尾后压低普通概率唤醒；明确提问、私聊和直接呼叫不受此冷却压制。'),
  make('qq.socialV2.context.wakeMaxChars', 'QQ 唤醒上下文字数', 6000, int(1000, 12000), '改变下一次唤醒的上下文上限；可能显著增加 token。', { permission: 'approval', risk: 'medium', effect: 'next-wake' }),
  make('purpose.enabled', '自主目的机会', true, bool, '关闭自动目的 tick；不删除未完成目的或终止进行中的交流。'),
  make('purpose.gapMinMs', '目的机会最短间隔', 150 * minute, int(5 * minute, 24 * hour), '下一次目的排程使用新范围；已有 nextFireAt 单独展示。'),
  make('purpose.gapMaxMs', '目的机会最长间隔', 300 * minute, int(5 * minute, 24 * hour), '必须不小于最短间隔；安静时段、每日上限、载体与预算仍可阻止行动。'),
  make('purpose.quietStart', '目的安静时段开始', '23:30', { type: 'clock' }, '按运行进程本地时区判断；开始等于结束表示关闭安静时段。'),
  make('purpose.quietEnd', '目的安静时段结束', '08:30', { type: 'clock' }, '允许跨午夜；不会改变进程时区。'),
  make('purpose.idleThresholdMs', '主动联系前安静时间', 30 * minute, int(minute, 12 * hour), '最近刚说过话时不打断对话。'),
  make('purpose.maxCandidates', '候选目的数量', 6, int(3, 10), '限制规则引擎提供的候选数量；候选分数不是主体的内心愿望。'),
  make('purpose.pendingTtlDays', '待续目的保留天数', 14, int(1, 90), '过期的是待续候选；不删除长期记忆或聊天原始证据。'),
  ...[
    ['night.windows', 'B站活动时间窗口', [{ start: '20:00', end: '24:00', wakes: 1 }], { type: 'windows' }, '为每日计划分配机会；每窗 wakes、每日上限、最小间隔、预算与登录共同约束。'],
    ['night.maxWakesPerDay', 'B站每日浏览机会', 1, int(0, 12), '0 表示不再自动浏览；提高不绕过窗口、监听独立路径或预算。'],
    ['night.skipChance', 'B站跳过机会概率', 0.3, { type: 'number', min: 0, max: 0.95 }, '跳过浏览仍会轻醒并调用模型，不保证节省调用；跳过不等于失败，不强制发言。'],
    ['night.maxVideos', 'B站单次浏览数量', 5, int(1, 20), '改变真实唤醒任务的浏览数量上限；模型仍可提前停止。'],
    ['night.minGapMin', 'B站浏览最短间隔（分钟）', 20, int(1, 120), '重排保留当天已用次数和最后活动时间，不补跑错过机会。'],
    ['preferences.like', '愿意探索的兴趣词', [], { type: 'keywords' }, '用于 feed 选题；人类默认词不代表本人已经选择。'],
    ['preferences.keywords', '额外探索关键词', [], { type: 'keywords' }, '与 like 去重后使用；不自动推导永久人格。'],
    ['preferences.weights', '兴趣词权重', {}, { type: 'weights' }, '0 停用，1 常规，最高 5；只允许已登记兴趣词，推荐效果需行为观察。'],
    ['share.enabled', 'B站分享机会', true, bool, '可以关闭自动分享；开启不授予新的外部发言权限。'],
    ['share.minScore', 'B站分享评分门槛', 13, int(0, 20), '改变分享门槛；实际发送仍经过原有额度、账号和隐私检查。'],
    ['listen.commentIntervalSec', 'B站评论监听周期（秒）', 300, int(60, 86400), '下一次检查采用新周期；不改变监听对象范围或启用未授权平台。'],
  ].map(([id, name, value, rule, impact]) => make('bili.' + id, name, value, rule, impact, {
    evidenceProducer: 'bili', effect: id.startsWith('night.') ? 'next-plan' : 'next-read',
  })),
]);
export const BY_ID = new Map(PARAMETERS.map((p) => [p.id, p]));
export const READ_ONLY = Object.freeze([
  { id: 'qq.dsh.model', name: 'QQ 模型', source: 'qq', path: 'dsh.model', reason: '可能修改 DSH 全局默认；仅显示保存值，wire 未验收。' },
  { id: 'qq.dsh.reasoningEffort', name: 'QQ 思考档位', source: 'qq', path: 'dsh.reasoningEffort', reason: '配置值不等于实际请求；本轮不经普通接口改模型。' },
  { id: 'qq.socialV2.tokenGuard', name: 'QQ token 硬保护', source: 'qq', path: 'socialV2.tokenGuard', reason: '保护预算和外部活动上限，不允许普通接口放宽。' },
  { id: 'purpose.dailyMax', name: '目的每日硬上限', source: 'qq', path: 'purpose.dailyMax', reason: '原代码 0 表示不限，故保持只读。' },
  { id: 'memory.memoryCard', name: '记忆容量、注入与保留规则', source: 'unified', path: 'memoryCard', reason: '涉及遗忘和隐私；本轮只读审计。' },
  { id: 'bili.limits', name: 'B站行为硬额度', source: 'bili', path: 'limits', reason: '普通偏好不改变外部行为授权或硬额度。' },
]);
export function getPath(object, dotted) {
  return dotted.split('.').reduce((value, key) => value?.[key], object);
}
export function setPath(object, dotted, value) {
  const keys = dotted.split('.');
  let current = object;
  for (const key of keys.slice(0, -1)) current = current[key] ??= {};
  current[keys.at(-1)] = structuredClone(value);
}
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CLOCK_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/**
 * 本地化增强（IMPL-SPEC §2.4）：工具入参允许跨午夜窗口写法（end <= start，如 22:00→02:00）。
 *
 * 为什么必须拆、而不是直接存 wrap：
 *   · 参考 catalog 的存储规则是 `start < end` 且窗口不重叠，file-store.readState 会按这条校验历史
 *     overrides；存 wrap 会被自己判成坏 state。
 *   · B站运行层对 wrap 的支持不一致（whale-night 的 windowsOf 支持，scheduler 的 inWindow 不支持），
 *     存 wrap 会让两个消费者看到不同窗口。
 * 所以写入前统一拆成两个非重叠窗口（22:00–24:00 + 00:00–02:00），存储与消费者只见拆分后的窗口。
 * wakes 沿用原窗口值：wakes 是每窗机会上限，每日总数仍由 bili.night.maxWakesPerDay 硬上限约束。
 *
 * 返回 { windows, split }；非数组/非字符串窗口原样返回，交给 validateValue 报错。
 */
export function splitCrossMidnightWindows(windows) {
  if (!Array.isArray(windows)) return { windows, split: false };
  const out = [];
  let split = false;
  for (const w of windows) {
    if (!w || typeof w !== 'object' || typeof w.start !== 'string' || typeof w.end !== 'string') { out.push(w); continue; }
    if (!CLOCK_RE.test(w.start) || !(w.end === '24:00' || CLOCK_RE.test(w.end))) { out.push(w); continue; }
    if (w.end > w.start) { out.push(w); continue; }
    split = true;
    if (w.start === w.end) {
      // start === end 视作整日窗口（00:00–24:00）；拆成两个零长度以上子窗没有意义。
      out.push({ ...w, start: '00:00', end: '24:00' });
    } else if (w.end === '00:00') {
      // 22:00→00:00：wrap 后正好落在午夜，只剩 [start, 24:00) 一段。
      out.push({ ...w, end: '24:00' });
    } else {
      out.push({ ...w, end: '24:00' });
      out.push({ ...w, start: '00:00' });
    }
  }
  if (!split) return { windows: out, split };
  out.sort((a, b) => String(a?.start ?? '').localeCompare(String(b?.start ?? '')));
  return { windows: out, split };
}
export function validateValue(parameter, value) {
  const rule = parameter.rule;
  const fail = () => { throw new Error('INVALID_VALUE: ' + parameter.id + ' 需要 ' + JSON.stringify(rule)); };
  if (rule.type === 'boolean') { if (typeof value !== 'boolean') fail(); }
  else if (rule.type === 'integer' || rule.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max || (rule.type === 'integer' && !Number.isInteger(value))) fail();
  } else if (rule.type === 'clock') {
    if (typeof value !== 'string' || !CLOCK_RE.test(value)) fail();
  } else if (rule.type === 'keywords') {
    if (!Array.isArray(value) || value.length > 40 || value.some((v) => typeof v !== 'string' || !v.trim() || v.length > 60 || /[\r\n\0]/.test(v)) || new Set(value.map((v) => v.toLowerCase())).size !== value.length) fail();
  } else if (rule.type === 'weights') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 80 || Object.entries(value).some(([k,v]) => !k || k.length > 60 || ['__proto__', 'constructor', 'prototype'].includes(k) || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 5)) fail();
  } else if (rule.type === 'windows') {
    const time = (t) => t === '24:00' || (typeof t === 'string' && CLOCK_RE.test(t));
    if (!Array.isArray(value) || value.length < 1 || value.length > 12 || value.some((w) => !w || Object.keys(w).some((k) => !['start','end','wakes'].includes(k)) || !time(w.start) || !time(w.end) || w.start === '24:00' || w.start >= w.end || !Number.isInteger(w.wakes) || w.wakes < 1 || w.wakes > 12)) fail();
    const sorted = [...value].sort((a,b) => a.start.localeCompare(b.start));
    if (sorted.some((w,i) => i && sorted[i-1].end > w.start)) fail();
  } else fail();
}
