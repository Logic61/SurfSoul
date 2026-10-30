// 界面可见性回归：防止"浅色底 + 浅色字"和"未限定作用域的全局覆盖"再次出现。
//
// 背景：2026-10-27 用户反馈深色主题下更新弹窗像一层白膜（白底浅字）；
// 修的时候还差点引入全局覆盖（.qbw-hint 被改成 #9aa3ad，影响所有提示文字）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js');
const css = fs.readFileSync(file, 'utf8');

// 1) 弹窗必须自带高对比配色（不依赖主题 token）
const modal = /\.qbw-modal\{([^}]*)\}/.exec(css)?.[1] ?? '';
assert.ok(modal, '找不到 .qbw-modal 样式');
assert.match(modal, /background:\s*#[0-9a-f]{6}/i, '.qbw-modal 必须写死深色背景（不能只靠主题 token）');
assert.match(modal, /color:\s*#[0-9a-f]{6}/i, '.qbw-modal 必须写死浅色文字');

// 2) 任何 #fff / 近白色文字都不许配浅底：禁止全局把 hint/chip 改成固定浅色
const globalLightText = [/^\.qbw-hint\{color:#/m, /^\.qbw-chip\{background:rgba\(255,255,255/m];
for (const bad of globalLightText) {
  assert.ok(!bad.test(css), `发现未限定作用域的浅色覆盖：${bad}`);
}

// 3) 弹窗内的覆盖必须带 .qbw-modal 前缀
const lines = css.split('\n').filter((line) => line.includes('#9aa3ad') || line.includes('rgba(255,255,255,.12)'));
for (const line of lines) {
  assert.ok(line.trimStart().startsWith('.qbw-modal'), `弹窗配色覆盖没有限定作用域：${line.trim().slice(0, 60)}`);
}

// 4) 主要文字使用成对的 label token（而不是写死 #fff）
assert.match(css, /\.qbw-app\{[^}]*color:var\(--dsw-alias-label-primary\)/, '.qbw-app 的文字颜色应跟随主题 label-primary');

// 5) inline 样式不许写死浅色底 / 浅色边框（深色主题下就是"白底浅字"）。
//    2026-10-30 audit F3：目的页 stepBox/seg/载体卡曾写死 #fafbff / #fff / #e3e6ee，
//    深色主题下「素材→观察→目标假设→候选→今天」整条链路发白看不清。
//    白名单只有一处：B站 登录二维码必须纯白底（否则手机扫不出来）。
const INLINE_LIGHT = [
  { what: '浅色背景 background: "#f…"', re: /background\s*:\s*"#f[0-9a-f]{3,5}"/i },
  { what: '白色背景 background: "#fff"', re: /background\s*:\s*"#fff(?:fff)?"/i },
  { what: '浅色边框 border: "1px solid #e…"', re: /border\s*:\s*"1px solid #e[0-9a-f]{5}"/i },
  { what: '浅色分隔线 border*: "1px dashed #e…"', re: /border(?:Top|Bottom|Left|Right)?\s*:\s*"1px dashed #e[0-9a-f]{5}"/i },
];
const INLINE_LIGHT_ALLOW = [
  /qbw-contrast-allow/, // 显式白名单标记：目前只有 B站 登录二维码的纯白底（扫码识别，任何主题都保留）
];
for (const [index, line] of css.split('\n').entries()) {
  if (INLINE_LIGHT_ALLOW.some((re) => re.test(line))) continue;
  for (const { what, re } of INLINE_LIGHT) {
    assert.ok(!re.test(line), `第 ${index + 1} 行出现 inline ${what}（深色主题会白底浅字）：${line.trim().slice(0, 80)}`);
  }
}
// 三元 / 模板字面量里的浅色对比常量上一条正则扫不到（引号前是表达式），按字面量钉死。
for (const literal of ['#fafbff', '#e3e6ee', '#e1e6f0', '#e9edf5', '#6d6a78']) {
  assert.ok(!css.includes(`"${literal}"`), `inline 浅色常量 ${literal} 不许再出现（应换主题 token 或 .qbw-card）`);
}

console.log('✅ 界面可见性检查通过');
