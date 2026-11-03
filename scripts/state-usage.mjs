// state/ 用量报表（2026-11-03）
//
// 背景：`state/` 从「只放桥接运行时数据」逐渐混进了会话工作区、语音包、生图产物与
// 一次性验证素材（2026-11-03 实测 7.2GB，其中 voice-packs 6.8GB、slang-agent 239MB、
// agents 141MB）。目录本身不能乱删（AGENTS：用户数据绝不删除），先要能**看见**。
//
// 本脚本**只读**：只统计、不删除、不改名。清理必须人工确认 + 先备份/隔离。
//
// 用法：
//   node scripts/state-usage.mjs                # 人类可读报表（默认前 15 项）
//   node scripts/state-usage.mjs --top 30
//   node scripts/state-usage.mjs --json         # 机器可读
//   node scripts/state-usage.mjs --warn-mb 4096 # 超过阈值时退出码 1（给运维/定时任务用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');

/** 已知类别 + 处理建议（名字 → { hint, keep }）。 */
const CATEGORY_HINTS = {
  'voice-packs': '用户安装的语音包（素材，不要自动删；换包/删包走控制台）',
  'voice-tts': '本地 TTS 合成缓存（可清，重启会重建）',
  'generated-images': '快速生图产物（bridge 按 socialV2.imagegen.keepDays 自动清理，默认 7 天）',
  'slang-agent': '黑话学习会话工作区（work/ 里可能有 tools/ffmpeg 副本与验证视频；不是运行必需）',
  agents: 'DSH 会话工作区（sessionCwd 默认落在这里；建议配 config.sessionCwd 移到仓库外）',
  'review-context': '预发送评审的记忆摘要缓存（可清，会按 hash 重建）',
};
const FILE_HINTS = {
  'bridge.log': '桥接日志（轮转 .1；保留最近一段即可）',
  'bridge.log.1': '桥接日志轮转备份',
  'qq-activity.log': 'QQ 活动日志（保留最近 500 行）',
  'token-usage.jsonl': 'token 用量账本（用于额度/看板，别删）',
  'tool-calls.jsonl': '工具调用审计日志（别删）',
  'social-v2.json': '二代仿真会话状态（未读/唤醒/收尾，别删）',
  'sessions.json': 'QQ 会话 ↔ DSH 会话映射（别删）',
};

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function walkSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      try { bytes += fs.statSync(full).size; files += 1; } catch { /* 统计不到就跳过 */ }
    }
  }
  return { bytes, files };
}

function collect({ top = 15 } = {}) {
  const items = [];
  let entries = [];
  try { entries = fs.readdirSync(STATE, { withFileTypes: true }); } catch {
    return { totalBytes: 0, totalFiles: 0, items: [], missing: true };
  }
  for (const entry of entries) {
    const full = path.join(STATE, entry.name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    const size = entry.isDirectory() ? walkSize(full) : { bytes: st.size, files: 1 };
    items.push({
      name: entry.name,
      kind: entry.isDirectory() ? 'dir' : 'file',
      bytes: size.bytes,
      files: size.files,
      modifiedAt: st.mtimeMs,
      hint: entry.isDirectory ? (CATEGORY_HINTS[entry.name] ?? '') : (FILE_HINTS[entry.name] ?? ''),
    });
  }
  items.sort((a, b) => b.bytes - a.bytes);
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  const totalFiles = items.reduce((sum, item) => sum + item.files, 0);
  return { totalBytes, totalFiles, items: items.slice(0, Math.max(1, Number(top) || 15)), allItems: items };
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const topArg = argv.indexOf('--top');
const top = topArg >= 0 ? Number(argv[topArg + 1]) || 15 : 15;
const warnArg = argv.indexOf('--warn-mb');
const warnMb = warnArg >= 0 ? Number(argv[warnArg + 1]) || 0 : 0;

const report = collect({ top });
if (json) {
  console.log(JSON.stringify({ ok: !report.missing, stateDir: STATE, ...report }, null, 2));
} else if (report.missing) {
  console.log(`（没有 state/ 目录：${STATE}）`);
} else {
  console.log(`state/ 总用量：${humanSize(report.totalBytes)}（${report.totalFiles} 个文件）`);
  console.log(`位置：${STATE}\n`);
  const pad = (s, n) => String(s).padEnd(n, ' ');
  console.log(`${pad('名称', 32)} ${pad('大小', 10)} ${pad('文件数', 8)}  建议`);
  console.log('-'.repeat(100));
  for (const item of report.items) {
    const name = item.kind === 'dir' ? `${item.name}/` : item.name;
    console.log(`${pad(name, 32)} ${pad(humanSize(item.bytes), 10)} ${pad(item.files, 8)}  ${item.hint || ''}`);
  }
  console.log('');
  console.log('提示：本脚本只读。清理前先隔离（rename 到 _backups/ 或 ~/.dsh/_quarantine/）并确认可回滚。');
  console.log('      `agents/` 可以从下一次重启起不再增长：把 config.json 的 sessionCwd 指到仓库外的目录。');
  if (warnMb > 0 && report.totalBytes > warnMb * 1024 * 1024) {
    console.error(`\n⚠️ state/ 超过 ${warnMb} MB 阈值`);
    process.exitCode = 1;
  }
}
