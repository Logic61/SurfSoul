/**
 * 每日生活参数心跳（2026-11-08，用户要求「每天定时心跳唤醒判断要不要改动，就在早安一个心跳」）。
 *
 * 纯函数：配置归一、下一次触发时间、提示词文案、与「早安问候」合并的判定。
 * 桥接只负责定时器、投递与「今天是否已跑过」的状态文件（state/life-review.json）。
 *
 * 设计约束（与 greeting-schedule.js 同一套教训）：
 *   · 错过时间点后允许在 graceHours 内补跑（桥接正好在 08:00 重启过，不能整天丢掉）；
 *   · DSH 离线/投递失败要重试，而不是标记成已完成；
 *   · reserved2 下纯文本不会自动发到 QQ：要改变参数/汇报都必须真的调工具；
 *   · 只跑一次/天：同一天不反复唤醒（用户说的「就一个心跳」），手动试跑不占当天名额。
 */
import { localDateKey, parseGreetingTime } from './greeting-schedule.js';

export const LIFE_REVIEW_DEFAULTS = Object.freeze({
  enabled: true,
  time: '08:00',
  maxChanges: 2,
  notifyOwner: true,
  graceHours: 3,
});

/** 错过时间点后的补跑窗口（与早安问候一致：默认 3 小时）。 */
export const LIFE_REVIEW_GRACE_MS = 3 * 60 * 60 * 1000;
/** 投递失败/DSH 离线后的重试间隔。 */
export const LIFE_REVIEW_RETRY_MS = 10 * 60 * 1000;
/** 补跑不立刻抢跑，留 5 秒给 DSH 事件流（与早安一致）。 */
export const LIFE_REVIEW_CATCHUP_DELAY_MS = 5000;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 归一化 `lifeSettings.dailyReview`（缺省 = 用户要的默认：每天 08:00 一次、最多改 2 项、改完汇报）。
 * 非法值安全落地，不抛错（配置坏不能把桥接启动搞挂）。
 */
export function normalizeLifeReviewConfig(raw, fallback = LIFE_REVIEW_DEFAULTS) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const base = fallback && typeof fallback === 'object' ? fallback : LIFE_REVIEW_DEFAULTS;
  const time = parseGreetingTime(src.time ?? base.time, base.time);
  return {
    enabled: src.enabled !== false && base.enabled !== false,
    time: time.text,
    maxChanges: clampInt(src.maxChanges, base.maxChanges, 1, 5),
    notifyOwner: src.notifyOwner !== false && base.notifyOwner !== false,
    graceHours: clampInt(src.graceHours, base.graceHours, 0, 12),
  };
}

/**
 * 下一次该在什么时候跑「每日生活参数心跳」。
 * 语义与 planMorningGreeting 对齐：准点 / 补跑 / 失败重试 / 明天。
 *
 * @param {{now?:number, time?:string, doneToday?:boolean, retryDelayMs?:number, graceMs?:number}} options
 * @returns {{fireAt:number, mode:'scheduled'|'catchup'|'retry'|'tomorrow'}}
 */
export function planLifeReviewFire({
  now = Date.now(),
  time = '08:00',
  doneToday = false,
  retryDelayMs = 0,
  graceMs = LIFE_REVIEW_GRACE_MS,
} = {}) {
  const { hh, mm } = parseGreetingTime(time);
  const today = new Date(now);
  today.setHours(hh, mm, 0, 0);
  const target = today.getTime();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const atTomorrow = tomorrow.getTime();
  // 今天已经跑过：只能排明天（绝不在同一天反复叫醒她）。
  if (doneToday) return { fireAt: atTomorrow, mode: 'tomorrow' };
  const withinGrace = now >= target && now - target <= Math.max(0, Number(graceMs) || 0);
  // 失败重试只在补跑窗口内有效；出了窗口就排明天，避免整夜反复重试。
  if (retryDelayMs > 0 && withinGrace) {
    return { fireAt: Math.min(now + retryDelayMs, target + Math.max(0, Number(graceMs) || 0)), mode: 'retry' };
  }
  if (target > now) return { fireAt: target, mode: 'scheduled' };
  if (withinGrace) return { fireAt: now + LIFE_REVIEW_CATCHUP_DELAY_MS, mode: 'catchup' };
  return { fireAt: atTomorrow, mode: 'tomorrow' };
}

/**
 * 心跳正文（可与早安提示词拼接，也可单独成篇）。
 *
 * 原则：**只在有明确理由时改，不为了改而改**；每次最多改 maxChanges 项；改完要汇报；
 * 只读/审批参数不碰（目录与 bridge 端点会拒）；不要为了「有变化」而折腾。
 */
export function buildLifeReviewBlock({ maxChanges = 2, notifyOwner = true } = {}) {
  const limit = clampInt(maxChanges, 2, 1, 5);
  const notify = notifyOwner !== false
    ? '改完之后，用 qq_send_private_message 给主人发一句短的：改了什么、为什么改；并说一句「不满意可以让我改回」。没改就不用特意发消息，最多说句早安。'
    : '改完只在心里记着，不用主动发消息；主人问起再说明。';
  return [
    '【每日生活参数复查 · 一次心跳】这是今天唯一一次生活参数自检：先看状态，再决定要不要动；**不要为了改而改**。',
    '步骤：',
    '1) 调用 life_state 看 saved/effective/revision/采用证据/预算余量；需要时用 life_history 看最近 5 条修改。',
    '2) 结合最近几天的情况判断：是不是总被打断、几乎没机会探索、目的节奏太密或太疏、安静时段不合适、主动机会太多/太少……',
    `3) 只有出现**明确的不合适**才调整；每次最多改 ${limit} 项；同一参数不要来回调；默认结论是「保持不动」。`,
    '4) 要改就 life_preview（写清理由）→ life_apply → life_verify；verify 没到 runtime-adopted 就别宣称成功，必要时 life_rollback。',
    '5) 目录里只读/需要主人审批的参数不要碰（工具会拒绝）；不要改白名单、预算硬上限、权限、凭据或系统提示词。',
    `6) ${notify}`,
  ].join('\n');
}

/**
 * 独立的「每日心跳」提示词（早安问候未启用，或问候对象不是主人时走这条；只投到主人私聊）。
 */
export function buildLifeReviewPrompt({
  who = '主人',
  time = '08:00',
  mode = 'reserved2',
  token = '',
  catchUp = false,
  manual = false,
  maxChanges = 2,
  notifyOwner = true,
} = {}) {
  const target = String(who || '').trim() || '主人';
  const lines = [];
  if (manual) {
    // 手动试跑（控制台/验收）不能假装现在是早上：用户可能就是晚上点「试一下」，
    // 提示词里写死「现在是早上」会让她在半夜道早安、还会误导她判断当前时段。
    lines.push('【每日生活参数心跳 · 手动试跑】这不是真实的早上，是主人刚刚手动触发的一次试跑；按下面的流程自检一次。');
  } else if (catchUp) {
    lines.push(`【每日生活参数心跳 · 补跑】原定 ${time} 的那次生活参数心跳没有跑，现在补一次。`);
  } else {
    lines.push(`【每日生活参数心跳 · 早安】现在是早上 ${time}，对 ${target} 说声早安，然后做今天唯一一次生活参数复查。`);
  }
  lines.push(buildLifeReviewBlock({ maxChanges, notifyOwner }));
  if (manual) {
    lines.push('这次是手动试跑：**不用道早安**，也不用假装现在是早上；有改动就按第 6 条汇报，没改动就简短回一句「检查过了，先不动」。');
  }
  if (String(mode) === 'reserved2') {
    lines.push(
      '【发送与工具】reserved2 下你的纯文本不会自动发到 QQ：要说话/汇报就用 qq_send_private_message（userId 填主人 QQ）。'
      + '生活参数工具是 life_*，调用时带下面的会话令牌；不要 @ 任何人，不要提「定时任务/心跳」这些词。',
    );
    if (token) lines.push(`【会话令牌】${token}（调用 life_* / qq_* 工具时带上；不要写进发给主人的消息里）`);
  } else {
    lines.push('其它模式下你可以直接输出想说的话，不要解释「定时任务」。');
  }
  return lines.join('\n');
}

/**
 * 「早安问候」与「生活参数心跳」是否合并成同一个唤醒。
 *
 * 用户要的是「就在早安一个心跳」：当早安问候开着、对象就是主人本人、且两个时间一致时，
 * 把心跳正文拼进早安提示词（一次唤醒干两件事），不再单独排心跳，避免同一天两次打扰。
 * 任一条件不满足就保持两条独立路径（心跳仍会单独投到主人私聊）。
 */
export function shouldPiggybackGreeting({
  greetingEnabled = false,
  greetingTarget = '',
  ownerUin = '',
  greetingTime = '08:00',
  reviewTime = '08:00',
} = {}) {
  if (greetingEnabled !== true) return false;
  const target = String(greetingTarget ?? '').trim();
  const owner = String(ownerUin ?? '').trim();
  if (!target || !owner || target !== owner) return false;
  return parseGreetingTime(greetingTime).text === parseGreetingTime(reviewTime).text;
}

/** 给桥接打日志/控制台看的一句话摘要（纯函数，防止两处文案漂移）。 */
export function describeLifeReviewPlan({ plan, config, piggyback = false, today = localDateKey() } = {}) {
  const { fireAt, mode } = plan ?? {};
  const modeLabel = { scheduled: '准点', catchup: '补跑', retry: '重试', tomorrow: '明天' }[mode] ?? String(mode ?? '');
  const when = Number.isFinite(fireAt) ? new Date(fireAt).toLocaleString() : '未知';
  const conf = config ?? LIFE_REVIEW_DEFAULTS;
  const path = piggyback ? '合并进早安' : '独立心跳';
  return `[生活心跳] ${modeLabel}（${path}）：每天 ${conf.time}；今天 ${today}${mode === 'tomorrow' ? '（今天不再跑）' : ''}；下次 ${when}`;
}
