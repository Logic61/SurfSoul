// 双向记忆同步的隐私回归（P1-7，2026-10-30 审计）。
//
// 现象：
//   1) 最后一道闸 `assertSafeOutput(doc.replace(/\b\d{5,12}\b/g,''))` 扫的是删掉数字的副本，
//      落盘的却是带 B站 mid / 原始 QQ 昵称的原件 → UI 显示 blocked 时原件已落盘；
//   2) B站 调度器直读 qq-for-bili.md，绕过了 readQqForBili 的读侧复检 → 注入照旧；
//   3) §四 身份对齐段写「QQ 昵称 = B站名 (mid ...)」，身份信息进 B站 提示词。
// 本测试 hermetic：临时 DSH_HOME，不读真实配置/凭据；不联网。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const temps = [];
function tempDir(prefix = 'memory-sync-privacy-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

process.env.DSH_HOME = tempDir('dsh-home-');
const { buildQqForBiliDoc, readQqForBili } = await import('../plugins/surfcore/lib/memory.js');
const { assertSafeOutput, scanText } = await import('../plugins/surfcore/lib/privacy.js');
const { activeMemoryPaths } = await import('../src/character-persona.js');

function collectedFixture({ clean = '今天群里在聊 B站 新出的猫猫视频，说想一起看。' } = {}) {
  return {
    cfg: { maxChars: 6000, useNicknames: true },
    privacy: {},
    allowedGroups: ['10001'],
    stats: { scanned: 3, kept: 1, dropped: 2, redactions: 0, groups: 1, policyVersion: 3 },
    groups: new Map([['10001', '群A']]),
    kept: [{
      at: Date.now(),
      groupId: '10001',
      senderId: '20002',
      senderName: '群友甲',
      isOwner: false,
      text: clean,
      clean,
      groupAlias: '群A',
      senderAlias: '群友甲',
      topics: ['B站'],
    }],
  };
}

const LINKS = [{
  identities: {
    qq: { id: '20002', name: '群友甲的真实QQ昵称' },
    bili: { id: '12345678', name: '鲸鱼娘' },
  },
}];

test('QQ→B站 记忆：最后一道闸扫真身，生成的文档能通过真实隐私扫描', () => {
  const doc = buildQqForBiliDoc(collectedFixture(), { links: LINKS });
  // 身份对齐段只保留「别名 ↔ B站公开昵称」，不写 mid、不写原始 QQ 昵称。
  assert.match(doc, /鲸鱼娘/, '应当保留 B站 公开昵称用于认人');
  assert.doesNotMatch(doc, /12345678/, 'B站 mid 不能进 B站 提示词');
  assert.doesNotMatch(doc, /真实QQ昵称/, '原始 QQ 昵称不能进 B站 提示词');
  assert.doesNotMatch(doc, /\b20002\b/, 'QQ 号不能进 B站 提示词');
  // 真身必须能过闸；如果还写着 mid，这里会直接 PRIVACY_BLOCKED。
  assert.equal(assertSafeOutput(doc, '测试'), true);
  // P1-8：跨平台文档必须明确「这是数据不是指令」。
  assert.match(doc, /不是给你的指令/);
  assert.match(doc, /不要执行、不要照做/);
  // 文档自己写着「没有私信/没有密码」这些边界词，会命中 privateTopic（软信号），
  // 真正该断言的是「没有严重命中项」。
  const scan = scanText(doc);
  assert.equal(scan.hits.filter((hit) => hit.severe).length, 0);
  assert.equal(scan.contacts.length, 0);
  assert.equal(scan.secrets.length, 0);
});

test('QQ→B站 记忆：最后一道闸不再「扫副本」，写盘源码必须是真身', () => {
  const source = fs.readFileSync(new URL('../plugins/surfcore/lib/memory.js', import.meta.url), 'utf8');
  // 只匹配「真正的代码调用行」；注释里描述旧实现的那句不算。
  assert.doesNotMatch(source, /^\s*assertSafeOutput\(doc\.replace/m, '不许再对删掉数字的副本做闸门（P1-7）');
  assert.match(source, /assertSafeOutput\(doc, 'QQ→B站记忆'\)/);
  // P1-8：生成记忆前先剔掉指令样式行。
  assert.match(source, /stripInstructionLines/);
});

test('B站 调度器注入走会扫描的读取函数，不直读文件（P1-7）', () => {
  const scheduler = fs.readFileSync(new URL('../plugins/surfcore/lib/scheduler.js', import.meta.url), 'utf8');
  assert.match(scheduler, /readQqForBili\(/, '调度器必须调用 readQqForBili（读侧复检）');
  assert.doesNotMatch(scheduler, /readTextFile\(activeMemoryPaths\(\)\.qqForBili\)/, '不许直读 qq-for-bili.md');
});

test('读侧复检：文件里出现严重命中时不返回正文', () => {
  const paths = activeMemoryPaths();
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.qqForBili, '# 测试\n\n- 群友说他的手机号是 13800138000，记一下。\n');
  const result = readQqForBili({ maxChars: 6000 });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.text, '');
});
