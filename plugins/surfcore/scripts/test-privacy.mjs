/** 隐私闸门回归：私信/密钥/PII 必须被挡住，正常公开内容必须放行。 */
import assert from 'node:assert/strict';
import { sanitizeText, scanText, assertSafeOutput, isPublicGroupMessage } from '../lib/privacy.js';

const cases = [
  { text: '我的QQ是123456789，手机13800138000', ok: false, why: 'QQ号/手机号' },
  { text: '私信我，我告诉你', ok: false, why: '私信话题' },
  { text: '密码：abcd1234', ok: false, why: '密码' },
  { text: 'SESSDATA=abc123456789', ok: false, why: 'cookie' },
  { text: '今天看了个视频 BV1xx411c7mD 很好笑', ok: true, why: '正常内容' },
  { text: '这个猫猫好可爱 mer', ok: true, why: '正常内容' },
  { text: '我住在北京市朝阳区某某小区', ok: false, why: '住址' },
  { text: '身份证 110101199001011234', ok: false, why: '身份证' },
];
for (const item of cases) {
  const result = sanitizeText(item.text);
  assert.equal(result.ok, item.ok, `${item.why}: ${JSON.stringify(result)}`);
}

assert.equal(scanText('sk-1234567890abcdef1234567890abcdef').severe, true);

// 2026-10-30 P0-1 回归：private-key 正则曾漏掉 g 标志 → collect() 的 while(exec)
// 永不前进，一段 PEM 就能把宿主事件循环锁死（GET /privacy/explain 也能触发）。
// 这里必须能正常返回、且命中次数正确（锚定 g 标志 + 位置不前进防御）。
const pem = scanText('x -----BEGIN RSA PRIVATE KEY----- y');
assert.equal(pem.secrets.length, 1, 'PEM 私钥必须命中且不能死循环');
assert.equal(pem.severe, true);
assert.equal(sanitizeText('x -----BEGIN RSA PRIVATE KEY----- y').ok, false, 'PEM 私钥必须被丢弃');
const twoPem = scanText('-----BEGIN PRIVATE KEY----- a -----BEGIN PRIVATE KEY----- b');
assert.equal(twoPem.secrets.length, 2, '含 g 标志时多段私钥都要命中');
assert.throws(() => assertSafeOutput('password: hunter2'), /隐私闸门拒绝/);
assert.doesNotThrow(() => assertSafeOutput('今天看了个视频，挺好笑的'));

assert.equal(isPublicGroupMessage({ key: 'private:12345', groupIds: [], text: 'hi' }).ok, false);
assert.equal(isPublicGroupMessage({ key: 'group:100000004', groupIds: ['100000004'], text: 'hi' }).ok, true);
assert.equal(isPublicGroupMessage({ key: 'group:999999999', groupIds: ['100000004'], text: 'hi' }).ok, false);
assert.equal(isPublicGroupMessage({ key: 'group:100000004', groupIds: ['100000004'], text: '/reset' }).ok, false);

console.log('privacy tests OK');
