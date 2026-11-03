// 文档数字防漂移（2026-11-03）：
//   docs/guides/CURRENT-NUMBERS.md 必须与代码实际数字一致；
//   手写文档里提到的数字（MCP server 数 / bridge 行数 / 工具数）应引用它，而不是再抄一份。
//
// 做法：重新算一遍并与文件逐字比较，不一致就失败并提示重新生成。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NUMBERS_FILE, buildNumbersDoc } from './doc-numbers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS', name); } catch (error) { failures += 1; console.error('FAIL', name, error.message); }
}

const target = path.join(ROOT, NUMBERS_FILE);
const expected = await buildNumbersDoc(ROOT);

check('CURRENT-NUMBERS.md 存在且与代码一致', () => {
  assert.ok(fs.existsSync(target), `缺少 ${NUMBERS_FILE}；运行 npm run docs:numbers`);
  const actual = fs.readFileSync(target, 'utf8');
  assert.equal(actual, expected, 'CURRENT-NUMBERS.md 已落后：运行 npm run docs:numbers');
});

check('关键数字可信（不是空表/占位）', () => {
  assert.match(expected, /\| bridge\.js 行数 \| [1-9]\d{3,} \|/);
  assert.match(expected, /\| qq_\* MCP 工具数 \| [1-9]\d* \|/);
  assert.match(expected, /\| MCP server 数 \| 4 \|/);
  assert.match(expected, /\| restrict 名单条数 \| [1-9]\d* \|/);
});

check('手写文档不再自称「三个 MCP server / 约 15,000 行」', () => {
  const docs = ['docs/guides/ARCHITECTURE.md', 'docs/guides/AGENT-TOOLS-AND-PRESETS.md', 'docs/guides/MODULE-BRIDGE.md', 'docs/FOLDER_MAP.md'];
  for (const rel of docs) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!text.includes('三个 MCP server'), `${rel} 仍写「三个 MCP server」`);
    assert.ok(!text.includes('约 15,000 行'), `${rel} 仍写「约 15,000 行」`);
  }
});

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\ndoc numbers tests OK');
}
