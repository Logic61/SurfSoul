// 安全姿态一屏（2026-11-03）回归：
//   · 桥接只读接口 /api/security-posture 在，且把「硬闸开/关 + 令牌 + state ACL」聚合出来；
//   · 控制台访问页有对应的 section 与渲染函数；
//   · 关掉的闸门会产生 alert（避免「关着却没人知道」）；
//   · 不泄露 token 值（只报是否配置/是否 staged）。
//
// 只做静态接线断言（跑不了真实控制台的环境里也能进 test-audit）；
// 真机验证：打开控制台 → 访问与安全 → 看「安全姿态」一屏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS', name); } catch (error) { failures += 1; console.error('FAIL', name, error.message); }
}

const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const consoleHtml = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');

check('桥接有只读接口，且包含关键检查项', () => {
  const start = bridgeSrc.indexOf("url.pathname === '/api/security-posture'");
  assert.ok(start > 0, '缺少 /api/security-posture 路由');
  const block = bridgeSrc.slice(start, start + 9000);
  for (const key of ['stateAcl', 'snowlumaToken', 'fishGuard', 'tokenGuard', 'sendRate', 'review', 'crossScene', 'allow', 'adminActions', 'disabledTools']) {
    assert.ok(block.includes(`key: '${key}'`), `安全姿态缺少检查项：${key}`);
  }
  assert.ok(block.includes('const alerts = items'), '应把 warn 项聚合成 alerts');
  assert.ok(block.includes('staged: Boolean('), '应检测 SnowLuma token 是否 staged');
});

check('姿态接口不把 token 明文放进响应', () => {
  const start = bridgeSrc.indexOf("url.pathname === '/api/security-posture'");
  const block = bridgeSrc.slice(start, start + 9000);
  // 只允许出现 token 的布尔/计数，不允许把 token 值拼进 value/note。
  assert.ok(!/value:\s*[^\n]*accessToken/.test(block), 'token 值不能直接进 value');
  assert.ok(!/value:\s*[^\n]*consoleToken/.test(block), 'consoleToken 不能进 value');
});

check('控制台访问页有「安全姿态」卡片与渲染函数', () => {
  for (const needle of [
    'id="section-posture"',
    'data-page="access"',
    'id="postureAlerts"',
    'id="postureTable"',
    'id="postureRefresh"',
    'function loadPosture',
    "api('/api/security-posture')",
    "page === 'access' && typeof loadPosture",
  ]) {
    assert.ok(consoleHtml.includes(needle), `console.html 缺少：${needle}`);
  }
});

check('姿态卡片会区分「warn」并给人工确认提示', () => {
  assert.ok(consoleHtml.includes('需要你确认'), '应有「需要你确认是否有意关掉」的提示');
  assert.ok(consoleHtml.includes("item.level === 'warn'"), 'warn 项应高亮');
});

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\nsecurity posture tests OK');
}
