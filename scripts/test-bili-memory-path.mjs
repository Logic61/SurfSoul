// B站→QQ 记忆生成器的输入目录回归（P1-6，2026-10-30 审计）。
//
// 现象：collect() 读的是旧全局 `~/.dsh/surfcore/bili/`，而角色账本已经迁到
// `characters/<id>/bili/` → bili-memory.json entries 恒空、prompt-bili 0B、
// 分享池空，持续 2 天没有告警。
// 本测试完全 hermetic：临时 DSH_HOME + 临时 home + 临时 stateDir，不读真实凭据、不联网
// （动态/标题都预置缓存，refresh 不会发请求）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const temps = [];
function tempDir(prefix = 'bili-memory-path-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// paths.js / character-persona.js 在模块加载时读 DSH_HOME，所以必须先设环境再 import。
process.env.DSH_HOME = tempDir('dsh-home-');
const { createBiliMemory } = await import('../src/bili-memory.js');

const BVID = 'BV1xx411c7mD';
const TITLE = '手工鱼缸';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFixture({ stateDir, home, legacyOnly = false }) {
  const surfcoreDir = path.join(home, '.dsh', 'surfcore');
  fs.mkdirSync(surfcoreDir, { recursive: true });
  writeJson(path.join(surfcoreDir, 'bili.config.json'), {
    self: { mid: '12345678', name: '测试鲸鱼娘' },
    persona: { name: '小咪', ownerTitle: '主人' },
    preferences: { like: ['猫猫', '手作'], dislike: ['带货'] },
    owner: { name: '羽' },
  });
  const ledgerDir = legacyOnly ? path.join(surfcoreDir, 'bili') : stateDir;
  fs.mkdirSync(ledgerDir, { recursive: true });
  writeJson(path.join(ledgerDir, 'scores.json'), {
    '2026-10-28': [{ bv: BVID, score: 15, reason: '鲸鱼娘新视频，很可爱', at: '2026-10-28T10:00:00+08:00' }],
  });
  writeJson(path.join(ledgerDir, 'favorites.json'), {
    items: [{ bv: BVID, title: TITLE, reason: '收藏了', kind: 'video', at: '2026-10-28T11:00:00+08:00' }],
  });
  writeJson(path.join(ledgerDir, 'quota.json'), {
    log: [{ target: `https://www.bilibili.com/video/${BVID}`, note: '评论：这个鱼缸好好看', at: '2026-10-28T12:00:00+08:00' }],
  });
  fs.writeFileSync(
    path.join(ledgerDir, 'whale-diary.md'),
    `## 2026-10-28 新的一天\n今天看了《${TITLE}》，好可爱，想学，但看起来要花不少时间，先记下来。\n`,
  );
  // 预置缓存，确保 refresh 不联网：动态缓存必须非空，标题缓存要覆盖 BV。
  writeJson(path.join(stateDir, 'bili-dynamics-cache.json'), {
    at: Date.now(),
    items: [{ id: 'dyn-1', text: '今天在 B站 发了一条动态：鱼缸进度 80%，灯终于装好了。', pubTs: Math.floor(Date.now() / 1000) - 3600 }],
  });
  writeJson(path.join(stateDir, 'bili-video-titles.json'), {
    at: Date.now(),
    items: { [BVID]: { title: TITLE, at: new Date().toISOString() } },
  });
}

test('B站记忆生成器读当前角色账本目录（不是旧全局目录）', async () => {
  const home = tempDir();
  const stateDir = tempDir();
  writeFixture({ stateDir, home });
  const memory = createBiliMemory({ stateDir, home, log: () => {} });
  const result = await memory.refresh({ force: true });
  assert.equal(result.ok, true, `刷新失败：${result.error ?? ''}`);
  assert.ok(result.entries > 0, '当前角色账本有数据，entries 不应为 0');

  const index = JSON.parse(fs.readFileSync(path.join(stateDir, 'bili-memory.json'), 'utf8'));
  assert.ok(Array.isArray(index.entries) && index.entries.length > 0, 'bili-memory.json 必须有 entries');
  assert.ok(index.entries.some((entry) => entry.bvid === BVID), '评分/收藏里的 BV 必须进入索引');

  const doc = fs.readFileSync(path.join(stateDir, 'bili-memory.md'), 'utf8');
  assert.match(doc, new RegExp(TITLE));
  assert.match(doc, /鲸鱼娘新视频/);
  // P1-8：B站→QQ 注入文本也要声明「数据不是指令」。
  assert.match(doc, /不是指令/);
  const brief = fs.readFileSync(path.join(stateDir, 'bili-memory-brief.md'), 'utf8');
  assert.match(brief, /B站记忆/);
  assert.match(brief, /不是指令/);
  assert.equal(memory.status().entries, index.entries.length);
});

test('旧全局目录的账本不再被读取（避免跨角色串味）', async () => {
  const home = tempDir();
  const stateDir = tempDir();
  writeFixture({ stateDir, home, legacyOnly: true });
  const memory = createBiliMemory({ stateDir, home, log: () => {} });
  const result = await memory.refresh({ force: true });
  assert.equal(result.ok, true, `刷新失败：${result.error ?? ''}`);
  const index = JSON.parse(fs.readFileSync(path.join(stateDir, 'bili-memory.json'), 'utf8'));
  assert.equal(
    index.entries.some((entry) => entry.bvid === BVID),
    false,
    '旧全局 ~/.dsh/surfcore/bili 的账本不得进入当前角色记忆（P1-6 串味风险）',
  );
  assert.equal(index.entries.some((entry) => String(entry.text ?? '').includes(TITLE)), false);
});
