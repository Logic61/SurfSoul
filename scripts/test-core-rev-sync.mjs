// 插件 → 核心模块引用的一致性回归（零运行时副作用，只读文件）。
//
// 背景（PITFALLS #68）：插件跑在 DSH 宿主进程里，热重载只重新加载插件自己的文件，
// 不会让 `../../src/*.js` 重新求值，于是「改了引擎却还在用旧引擎」。
// 现有唯一的绕法是给说明符挂缓存破坏后缀：`'../../../src/memory-card.js?rev=20261025-pet-memory2'`。
//
// 这个绕法有两个失败模式，本测试各钉一条：
//   1. **只改一处**：3 个文件里 rev 不同 → Node 视为 3 个不同模块 → 3 份模块级状态并存
//      （记忆卡的默认值/缓存分裂，现象是"有时生效有时不生效"，极难查）。
//   2. **漏挂后缀**：某个文件用裸 `'../../../src/memory-card.js'` → 同上，两份状态。
//
// 注意：`?rev=` 只挂在 `src/memory-card.js` 上，是历史遗留的局部绕法，**不是通用机制**。
// 改其它 `src/*.js` 后仍然是"热重载不生效，要重启 DSH"——本测试会把清单打出来提醒。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIB = path.join(ROOT, 'plugins', 'surfcore', 'lib');

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.js'));
const SPEC_RE = /from\s+'([^']*?\/src\/[^']+)'/g;
const CORE_PREFIX = '../../../src/';

const revs = new Map();      // rev 值 -> [file:line]
const coreImports = [];      // { file, spec, hasRev }
const bareMemoryCard = [];   // 没挂 ?rev= 的 memory-card 引用

for (const file of files) {
  const full = path.join(LIB, file);
  const text = fs.readFileSync(full, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(SPEC_RE)) {
      const spec = match[1];
      const rel = spec.startsWith(CORE_PREFIX) ? spec.slice(CORE_PREFIX.length) : null;
      if (!rel) continue;
      const [name, query = ''] = rel.split('?');
      const rev = /(?:^|&)rev=([^&]*)/.exec(query)?.[1] ?? '';
      coreImports.push({ file, line: index + 1, name, rev });
      if (rev) {
        const list = revs.get(rev) ?? [];
        list.push(`${file}:${index + 1}`);
        revs.set(rev, list);
      }
      if (name === 'memory-card.js' && !rev) bareMemoryCard.push(`${file}:${index + 1}`);
    }
  });
}

console.log(`## 1. 插件引用的核心模块（共 ${coreImports.length} 条）`);
{
  const byName = new Map();
  for (const item of coreImports) {
    const list = byName.get(item.name) ?? [];
    list.push(item.file);
    byName.set(item.name, list);
  }
  for (const [name, list] of [...byName].sort((a, b) => a[0].localeCompare(b[0]))) {
    const rev = coreImports.find((i) => i.name === name && i.rev)?.rev;
    console.log(`   · ${name}${rev ? `  (rev=${rev})` : ''}  ← ${[...new Set(list)].join(', ')}`);
  }
  ok(coreImports.length > 0, '插件确实通过相对路径引用核心模块（这条测试有对象）');
}

console.log('## 2. 同一核心模块的 ?rev= 必须完全一致');
{
  ok(revs.size <= 1, `?rev= 取值只有一种（实际 ${revs.size} 种：${[...revs.keys()].join(' | ') || '无'}）`);
  for (const [rev, where] of revs) {
    console.log(`   rev=${rev} → ${where.join(', ')}`);
  }
  const memoryCardRevs = coreImports.filter((i) => i.name === 'memory-card.js' && i.rev).map((i) => i.rev);
  ok(new Set(memoryCardRevs).size === 1, `src/memory-card.js 的 rev 在 ${memoryCardRevs.length} 处一致（不一致会产生多个模块实例）`);
}

console.log('## 3. 不允许「同一个核心模块，一处挂 rev、一处裸引用」');
{
  ok(bareMemoryCard.length === 0, `没有裸引用 src/memory-card.js 的插件文件${bareMemoryCard.length ? `（${bareMemoryCard.join(', ')}）` : ''}`);
}

console.log('## 3b. 传递依赖也要挂同一个 rev（2026-10-30 新增：叙事层）');
{
  // P1-9：插件 → memory-card.js?rev=X → memory-card.js 里裸 import './memcard-narrative.js'。
  // 后者不会随 rev 重新求值，于是热重载后「引擎新、叙事旧」，且 0 测试能发现。
  const engineFile = path.join(ROOT, 'src', 'memory-card.js');
  const engineText = fs.readFileSync(engineFile, 'utf8');
  const narrativeSpecs = [...engineText.matchAll(/from\s+'([^']*memcard-narrative\.js[^']*)'/g)].map((m) => m[1]);
  ok(narrativeSpecs.length >= 1, 'src/memory-card.js 确实引用了叙事层（这条测试有对象）');
  const narrativeRevs = narrativeSpecs.map((spec) => /(?:^|[?&])rev=([^&]*)/.exec(spec)?.[1] ?? '');
  ok(narrativeSpecs.every((_, i) => narrativeRevs[i]), `叙事层引用都挂了 ?rev=（当前：${narrativeSpecs.join(' | ')}）`);
  const allRevs = new Set([...revs.keys(), ...narrativeRevs.filter(Boolean)]);
  ok(allRevs.size <= 1, `插件与叙事层的 ?rev= 只有一种取值（实际 ${allRevs.size} 种：${[...allRevs].join(' | ') || '无'}）`);
}

console.log('## 4. 提醒：其它核心模块改完后热重载不会生效');
{
  const others = [...new Set(coreImports.map((i) => i.name))].filter((n) => n !== 'memory-card.js');
  console.log(`   未挂 ?rev= 的核心模块（改它们必须重启 DSH，热重载会继续用旧代码）：\n     ${others.join(', ') || '（无）'}`);
  ok(others.length >= 0, '清单已打印（供改动前自查）');
}

console.log(failures === 0 ? '\n✅ 核心引用一致性通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
