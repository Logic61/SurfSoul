// config 默认层核对（2026-11-03）
//
// 背景（RISK_REGISTER A5）：`config.example.json` 既是模板、又被插件 `readQqConfig()` 当
// **运行时默认层** deepMerge。但它缺了几段（chat / platforms.start / pet / tokenBudget…），
// 于是「模板里没有」=「新装用户看不见这些能力」。默认层本身怎么改要先定权威层，
// 本脚本只做**只读核对**：把 example 与运行中 config.json 的键集合求差，让人先看见缺口。
//
// 用法：
//   node scripts/config-check.mjs            # 人类可读，恒 exit 0
//   node scripts/config-check.mjs --strict   # live 有、example 没有的键 → exit 1
//   node scripts/config-check.mjs --json
// 永远不打印任何配置值（可能含 token），只打印键路径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = path.join(ROOT, 'config.example.json');
const LIVE = path.join(ROOT, 'config.json');
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const strict = argv.includes('--strict');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

function leafPaths(value, prefix = '', out = new Set()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      leafPaths(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out.add(prefix || '(root)');
  return out;
}

let example;
let live;
try {
  example = readJson(EXAMPLE);
} catch (error) {
  console.error(`❌ 读不了 config.example.json：${error.message}`);
  process.exit(2);
}
if (!fs.existsSync(LIVE)) {
  console.log('ℹ️ 没有运行中的 config.json（只有模板）；没有可核对的缺口。');
  process.exit(0);
}
try {
  live = readJson(LIVE);
} catch (error) {
  console.error(`❌ 读不了 config.json：${error.message}`);
  process.exit(2);
}

// 顶层键：最直观的「example 漏了哪一整段」。
const exampleTop = new Set(Object.keys(example));
const liveTop = new Set(Object.keys(live));
const missingSections = [...liveTop].filter((key) => !exampleTop.has(key)).sort();
const exampleOnlySections = [...exampleTop].filter((key) => !liveTop.has(key)).sort();

// 叶子键：同名字段内部的缺口（例如 socialV2.wake 少一个默认值）。
const exampleLeaves = leafPaths(example);
const liveLeaves = leafPaths(live);
const missingLeaves = [...liveLeaves].filter((key) => !exampleLeaves.has(key)).sort();
const exampleOnlyLeaves = [...exampleLeaves].filter((key) => !liveLeaves.has(key)).sort();

/** 已知的历史缺口（写在这里等于承认它们，避免每次都被当成新发现）。 */
const KNOWN_EXAMPLE_GAPS = new Set(['chat', 'platforms.start', 'pet', 'tokenBudget']);

const result = {
  ok: true,
  missingSections,
  exampleOnlySections,
  missingLeafCount: missingLeaves.length,
  missingLeaves: missingLeaves.slice(0, 200),
  exampleOnlyLeafCount: exampleOnlyLeaves.length,
  knownGaps: [...KNOWN_EXAMPLE_GAPS].filter((key) => liveTop.has(key) && !exampleTop.has(key)),
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('config 默认层核对（只读；只列键名，不打印值）\n');
  if (missingSections.length) {
    console.log(`⚠️ 运行中 config.json 有、config.example.json 没有的整段（${missingSections.length}）：`);
    for (const key of missingSections) {
      const known = KNOWN_EXAMPLE_GAPS.has(key);
      console.log(`  - ${key}${known ? '（已知缺口 A5，有 ?? 兜底）' : '（新缺口，先确认是不是漏登）'}`);
    }
  } else {
    console.log('✅ 顶层段落一致');
  }
  if (exampleOnlySections.length) {
    console.log(`\nℹ️ 模板有、运行中没有的段落（${exampleOnlySections.length}）：${exampleOnlySections.join(', ')}`);
  }
  if (missingLeaves.length) {
    console.log(`\n⚠️ 运行中有、模板没有的叶子键：${missingLeaves.length} 个（前 20）：`);
    for (const key of missingLeaves.slice(0, 20)) console.log(`  - ${key}`);
    if (missingLeaves.length > 20) console.log(`  … 还有 ${missingLeaves.length - 20} 个`);
  }
  console.log('\n注意：模板同时是插件的运行时默认层；补缺口前先定「哪一层是权威默认」，不要顺手改。');
}

if (strict && missingSections.length > 0) {
  console.error(`\n--strict：存在 ${missingSections.length} 个 example 缺失段落`);
  process.exitCode = 1;
}
