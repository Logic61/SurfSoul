// 发送前评审 dry-run：只拼 prompt / 调评审模型，**绝不发送任何 QQ 消息**。
//
// 用途：
//   · 调 prompt 预算、检查情景+记忆卡长啥样；
//   · 换模型/阈值前先用真实上下文试评分；
//   · 排查「为什么被退回」。
//
// 用法（仓库根目录）：
//   node scripts/review-dryrun.mjs --key group:1021716885 --text "要发的内容" [--llm] [--json]
//   node scripts/review-dryrun.mjs --key group:1021716885 --text "..." --text "第二条"
//   node scripts/review-dryrun.mjs --key private:3237216875 --text "..." --prompt-only
//
// 默认不调模型（--prompt-only 默认行为），只打印拼好的 prompt 与字数预算；
// 加 --llm 才会真的调用一次评审模型（会消耗 token，但不会发 QQ）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeMemoryPaths, characterPaths, readCurrentCharacter } from '../src/character-persona.js';
import { readPromptBlock, resolveMemoryCardPaths } from '../src/memory-card.js';
import { completeText } from '../src/llm-text.js';
import {
  buildReviewPrompt, buildReviewScene, createMemoryAbstractProvider,
  formatReviewRejection, normalizePresendReviewConfig, parseReviewVerdict,
} from '../src/presend-review.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_DIR = path.join(ROOT, 'state');
const args = process.argv.slice(2);

const flag = (name) => args.includes(`--${name}`);
const valueOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const valuesOf = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === `--${name}`) out.push(args[i + 1]);
  return out.filter((v) => typeof v === 'string');
};

const key = String(valueOf('key') ?? '').trim();
const messages = valuesOf('text').map((s) => String(s));
const jsonOut = flag('json');
if (!key || !messages.length) {
  console.error('用法: node scripts/review-dryrun.mjs --key group:<id>|private:<qq> --text "内容" [--text "第二条"] [--llm] [--json]');
  process.exit(2);
}

const cfgFile = path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const reviewCfg = normalizePresendReviewConfig(cfg.socialV2?.review ?? {});
if (!reviewCfg.enabled) {
  console.log('注意：config.json 里 socialV2.review.enabled 是 false；本 dry-run 仍按该配置参数执行，便于试参数。');
}
const character = readCurrentCharacter();
const personaName = String(character?.name ?? '').trim() || '她';
const memoryPaths = resolveMemoryCardPaths(activeMemoryPaths().dir);
const memorySource = (() => {
  try { return readPromptBlock(memoryPaths, 'qq'); } catch { return ''; }
})();
const styleRaw = (() => {
  try {
    if (!character?.id) return '';
    const file = path.join(characterPaths(character.id).dir, 'style-notes.md');
    return fs.readFileSync(file, 'utf8').trim();
  } catch { return ''; }
})();
const socialState = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'social-v2.json'), 'utf8')); } catch { return {}; }
})();
const conversation = socialState?.conversations?.[key] ?? {};
const recent = Array.isArray(conversation.recentMessages) ? conversation.recentMessages.slice(-8) : [];
const statusLines = [];
if (String(key).startsWith('group:')) {
  const recentList = Array.isArray(conversation.recentMessages) ? conversation.recentMessages : [];
  const now = Date.now();
  const others = recentList.filter((m) => m && !m.isSelf && now - Number(m.time || 0) < 10 * 60 * 1000);
  if (others.length) statusLines.push(`近10分钟群友发言 ${others.length} 条${others.filter((m) => m.fish).length ? `（钓鱼号 ${others.filter((m) => m.fish).length} 条）` : ''}`);
  const closure = conversation.closure;
  if (Number(closure?.cooldownUntil) > now) statusLines.push('刚自然收尾过（冷却中），这轮不该主动刷');
}

const kind = key.startsWith('private:') ? 'private' : 'group';
const scene = buildReviewScene({
  key, kind, groupName: '', personaName, statusLines, recent, maxChars: reviewCfg.sceneMaxChars,
});

const memoryProvider = createMemoryAbstractProvider({
  cachePath: path.join(STATE_DIR, 'review-context', 'memory-abstract.json'),
  readSource: () => memorySource,
  getConfig: () => cfg.socialV2?.review,
  completeText: (opts) => completeText({ ...opts, root: ROOT }),
  log: (tag, extra) => console.error(`[dry-run] ${tag}`, extra ?? ''),
});
const memory = await memoryProvider.get();
const prompt = buildReviewPrompt({
  scene: scene.text,
  memory,
  style: styleRaw,
  messages,
  personaName,
  threshold: reviewCfg.threshold,
  memoryMaxChars: reviewCfg.memoryMaxChars,
  styleMaxChars: reviewCfg.styleMaxChars,
});

const report = {
  key, personaName, kind,
  config: reviewCfg,
  scene: { chars: prompt.stats.sceneChars, dialogueLines: scene.dialogueLines, text: scene.text },
  memory: { sourceChars: memorySource.length, abstractChars: prompt.stats.memoryChars, cachePath: path.join(STATE_DIR, 'review-context', 'memory-abstract.json') },
  style: { chars: prompt.stats.styleChars },
  messages,
  prompt: { stats: prompt.stats, userChars: prompt.user.length },
};

if (!flag('llm')) {
  report.prompt.system = prompt.system;
  report.prompt.user = prompt.user;
  if (jsonOut) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('=== 预算 ===');
    console.log(`场合 ${prompt.stats.sceneChars} 字（对话 ${scene.dialogueLines} 条） + 记忆卡 ${prompt.stats.memoryChars} 字 + 习惯 ${prompt.stats.styleChars} 字 + 待审消息 ${prompt.stats.messageChars} 字 = ${prompt.stats.totalChars} 字`);
    console.log('\n=== system ===\n' + prompt.system);
    console.log('\n=== user ===\n' + prompt.user);
    console.log('\n（未调用评审模型；加 --llm 试评分。本次不会发送任何 QQ 消息。）');
  }
  process.exit(0);
}

const startedAt = Date.now();
const reply = await completeText({
  system: prompt.system,
  user: prompt.user,
  model: reviewCfg.model || undefined,
  maxTokens: reviewCfg.maxTokens,
  timeoutMs: reviewCfg.timeoutMs,
  root: ROOT,
});
const verdict = parseReviewVerdict(reply?.text ?? '');
report.llm = {
  elapsedMs: Date.now() - startedAt,
  model: reply?.model ?? reviewCfg.model ?? '(default)',
  usage: reply?.usage ?? null,
  raw: String(reply?.text ?? '').slice(0, 600),
  verdict,
};
if (verdict) {
  const pass = verdict.score >= reviewCfg.threshold;
  report.decision = { pass, score: verdict.score, threshold: reviewCfg.threshold, reason: verdict.reason, fix: verdict.fix };
  report.wouldSend = pass;
  if (!pass) report.toolError = formatReviewRejection({ verdict, threshold: reviewCfg.threshold, personaName });
}
if (jsonOut) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`评审：${verdict ? `${verdict.score}/${reviewCfg.threshold} ${verdict.score >= reviewCfg.threshold ? '通过（会发送）' : '未通过（会被退回）'}` : '解析失败（真实链路会放行）'}`);
  if (verdict?.reason) console.log(`理由：${verdict.reason}`);
  if (verdict?.fix) console.log(`建议：${verdict.fix}`);
  if (report.toolError) console.log(`\n模型会看到的工具错误：\n${report.toolError}`);
  console.log(`用时 ${report.llm.elapsedMs}ms；usage=${JSON.stringify(report.llm.usage)}；本次没有发送任何 QQ 消息。`);
}
