#!/usr/bin/env node
// 手动跑一次「记忆压缩」：把散碎的聊天记录压成「我们一起经历过的」。
//
// 正常情况下不用管它——桥接每 45 分钟自己跑一遍（socialV2.memoryNarrative）。
// 这个脚本是给「想立刻看到效果 / 想调批次大小 / 想看模型到底写了什么」用的。
//
// 用法：
//   node scripts/memcard-narrate.mjs --dry            只看会压什么、模型写成什么样，不落盘
//   node scripts/memcard-narrate.mjs                  真跑一次，写入 memory-card-narrative.json
//   node scripts/memcard-narrate.mjs --batch 20       这次最多喂 20 条记录
//   node scripts/memcard-narrate.mjs --list           只列已有的回忆
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeMemoryPaths } from '../src/character-persona.js';
import { loadNarrative, resolveNarrativePath, runNarration } from '../src/memcard-narrative.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : true;
}

function loadBridgeConfig() {
  try {
    const text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return {};
  }
}

/** 角色自己的名字/昵称：叙事时要把这些 speaker 认成「我」。 */
function selfNamesOf(dir) {
  const names = [];
  try {
    const character = JSON.parse(fs.readFileSync(path.join(dir, '..', 'character.json'), 'utf8').replace(/^\uFEFF/, ''));
    for (const key of ['name', 'nickname']) if (character?.[key]) names.push(String(character[key]));
  } catch {}
  try {
    const unified = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'surfcore', 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (unified?.role?.name) names.push(String(unified.role.name));
  } catch {}
  return [...new Set(names.filter(Boolean))];
}

const dryRun = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const listOnly = process.argv.includes('--list');
const batch = Number(argValue('batch', 0)) || 0;
const memoryDir = String(argValue('dir', '') || activeMemoryPaths().dir);

const narrative = loadNarrative(memoryDir);
console.log(`记忆目录：${memoryDir}`);
console.log(`叙事文件：${resolveNarrativePath(memoryDir)}`);
console.log(`已有回忆：${narrative.episodes.length} 条`);

if (listOnly) {
  for (const ep of [...narrative.episodes].sort((a, b) => String(b.date).localeCompare(String(a.date)))) {
    console.log(`\n[${ep.date}] ${ep.title}（${ep.covers.length} 条记录）`);
    console.log(ep.text);
  }
  process.exit(0);
}

const config = { ...(loadBridgeConfig()?.socialV2?.memoryNarrative ?? {}) };
if (batch > 0) config.batchRecords = batch;
// 手动跑的时候把「够不够一批」的门槛降到 2，方便验证。
config.minRecords = Math.min(Number(config.minRecords) || 6, 2);

const result = await runNarration({
  memoryDir,
  config,
  root: ROOT,
  dryRun,
  selfNames: selfNamesOf(memoryDir),
  log: (message) => console.log(message)
});

if (!result.ok) {
  console.log(`\n没压成：${result.error ?? result.skipped ?? '未知原因'}`);
  if (result.raw) console.log(`模型原始输出（前 300 字）：${result.raw}`);
  process.exit(1);
}
console.log(`\n${dryRun ? '[dry-run] ' : ''}喂了 ${result.picked ?? 0} 条记录，新增 ${result.added ?? 0} 条回忆，现有 ${result.total ?? narrative.episodes.length} 条`);
for (const ep of result.episodes ?? []) {
  console.log(`\n[${ep.date}] ${ep.title}（覆盖 ${ep.covers.length} 条记录）`);
  console.log(ep.text);
}
