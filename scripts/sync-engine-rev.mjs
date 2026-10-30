// 把「插件 → 核心」的 ?rev= 从手工字符串改成**引擎内容哈希**（2026-10-30 批次 C）。
//
// 背景：?rev= 是让 DSH 插件热重载时重新求值核心模块的唯一手段；以前靠手工改字符串，
// 改完引擎忘了 bump / 只 bump 一处都会导致「旧代码继续生效」（P1-9）。现在：
//   · rev = `memfix-<sha1(src/memory-card.js + src/memcard-narrative.js) 前 10 位>`
//   · 改完任一文件跑一次 `npm run sync:engine-rev`；`test-core-rev-sync` 会校验是否一致。
// 哈希前先把 `?rev=...` 归一掉，否则 rev 本身会改变文件内容 → 自引用。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENGINE = path.join(ROOT, 'src', 'memory-card.js');
const NARRATIVE = path.join(ROOT, 'src', 'memcard-narrative.js');
const PLUGIN_FILES = [
  path.join(ROOT, 'plugins', 'surfcore', 'lib', 'memory-card.js'),
  path.join(ROOT, 'plugins', 'surfcore', 'lib', 'pet-chat.js'),
  path.join(ROOT, 'plugins', 'surfcore', 'lib', 'store.js'),
];

function computeRev() {
  const text = [ENGINE, NARRATIVE].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const normalized = text.replace(/\?rev=[^'"]+/g, '');
  return `memfix-${crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 10)}`;
}

const rev = computeRev();
let changed = 0;
for (const file of PLUGIN_FILES) {
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(/(memory-card\.js\?rev=)[^']+/g, `$1${rev}`);
  if (after !== before) {
    fs.writeFileSync(file, after);
    changed += 1;
  }
}
{
  const before = fs.readFileSync(ENGINE, 'utf8');
  const after = before.replace(/(memcard-narrative\.js\?rev=)[^']+/g, `$1${rev}`);
  if (after !== before) {
    fs.writeFileSync(ENGINE, after);
    changed += 1;
  }
}
console.log(`引擎内容哈希 rev = ${rev}`);
console.log(changed ? `已更新 ${changed} 个文件` : '所有引用已是最新');
