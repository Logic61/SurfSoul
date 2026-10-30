// 记忆卡备份 / 恢复 / 轮转 / stats 重建回归（P1-10、P2-7、P2-8、P2-9，2026-10-30 审计）。
//
// 旧实现的问题：
//   · 备份名不含角色 → 多角色用户点「恢复」会用别的角色的卡覆盖当前角色；
//   · restore 不校验 JSON/结构、copyFileSync 非原子 → 坏备份恢复返回 ok:true 后变空卡；
//   · pruneBackups 正则匹配不到 ISO 时间 → 备份目录无限增长；
//   · 每日备份闸门用 lastDecayDate → 00:00–04:00 每 10 分钟备份一份；
//   · stats 丢失时整份读 JSONL 重建，10GB 会打爆内存。
// 本测试 hermetic：临时 DSH_HOME + 临时角色目录，不读真实数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const temps = [];
function tempDir(prefix = 'memory-card-backup-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

process.env.DSH_HOME = tempDir('dsh-');
const { BACKUP_DIR } = await import('../plugins/surfcore/lib/paths.js');
const store = await import('../plugins/surfcore/lib/store.js');
const memoryLib = await import('../plugins/surfcore/lib/memory-card.js');
const engine = await import('../src/memory-card.js');

const ISO = '2026-10-30T00:00:00.000Z';

function ensureCharacter(id = 'testchar') {
  const characters = path.join(process.env.DSH_HOME, 'surfcore', 'characters');
  fs.mkdirSync(path.join(characters, id), { recursive: true });
  fs.writeFileSync(path.join(characters, 'current.json'), JSON.stringify({ version: 1, id, name: '测试角色', epoch: 1 }));
}

function record(i, text = `备份测试记录 ${i}：这是一条用来验证恢复的记忆。`) {
  return {
    id: `mem_backup_${i}`,
    source: 'qq-owner',
    sourceId: '',
    platform: 'qq',
    scope: 'qq',
    kind: 'owner',
    title: `测试 ${i}`,
    text,
    tags: ['owner'],
    importance: 80,
    importanceReasons: ['主人私聊'],
    clarity: 'vivid',
    pinned: false,
    createdAt: ISO,
    lastSeenAt: ISO,
    private: true,
    conversationKey: 'private:1',
  };
}

function cardJson(records) {
  return {
    version: 1,
    createdAt: ISO,
    updatedAt: ISO,
    lastMaintenanceAt: '',
    lastDecayDate: '',
    meta: {
      inboxSeen: [], sourceSeen: [], firstOwnerRecordId: '', firstOwnerAt: '',
      firstMetSource: '', firstMetAt: '', firstMetRecordIds: [], firstMetEventId: '',
      lastBackupDate: '',
    },
    alerts: { level: 0, at: null, acknowledgedLevel: 0, acknowledgedAt: null, lastNotified: {} },
    stats: { ingested: 0, fromBili: 0, fromQq: 0, decayed: 0, compacted: 0, forgotten: 0 },
    records,
  };
}

function writeCard(records) {
  const paths = memoryLib.memoryCardPaths();
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.json, `${JSON.stringify(cardJson(records), null, 2)}\n`);
  return paths;
}

function backupFiles(prefix) {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((name) => name.startsWith(prefix)).sort();
  } catch {
    return [];
  }
}

test('pruneBackups：ISO 时间戳能被正确分组，按来源各留 N 份（P2-7）', () => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const write = (name) => fs.writeFileSync(path.join(BACKUP_DIR, name), '{}');
  for (let i = 0; i < 50; i += 1) {
    write(`memory-card-2026-10-30T12-00-${String(i).padStart(2, '0')}-000Z.json`);
  }
  for (let i = 0; i < 5; i += 1) {
    write(`config-2026-10-30T12-00-${String(i).padStart(2, '0')}-000Z.json`);
  }
  store.pruneBackups(40);
  const memoryLeft = fs.readdirSync(BACKUP_DIR).filter((name) => /^memory-card-\d{4}-\d{2}-\d{2}T/.test(name));
  const configLeft = fs.readdirSync(BACKUP_DIR).filter((name) => /^config-\d{4}-\d{2}-\d{2}T/.test(name));
  assert.equal(memoryLeft.length, 40, 'memory-card 旧格式最多留 40 份');
  assert.equal(configLeft.length, 5, '别的来源不受影响');
});

test('每日备份闸门：同一天只备份一次，成功后回写 lastBackupDate（P2-7）', async () => {
  ensureCharacter();
  const paths = writeCard([record(1)]);
  const now = Date.parse('2026-10-30T12:00:00+08:00');
  const before = backupFiles('memory-card-testchar-').length;
  const first = await memoryLib.runMemoryCardMaintenance({ now });
  assert.ok(Array.isArray(first.warnings), '维护结果要透出 warnings（备份失败不能静默）');
  assert.equal(backupFiles('memory-card-testchar-').length, before + 1, '当天首次维护应留一份备份');
  const card = JSON.parse(fs.readFileSync(paths.json, 'utf8'));
  assert.equal(card.meta.lastBackupDate, '2026-10-30', '备份成功后要写回闸门日期');

  await memoryLib.runMemoryCardMaintenance({ now: now + 10 * 60_000 });
  assert.equal(backupFiles('memory-card-testchar-').length, before + 1, '同一天第二次维护不再备份');
});

test('坏备份被拒绝：非法 JSON / 结构不对都不能把当前卡变成空卡（P1-10/P2-8）', async () => {
  ensureCharacter();
  const paths = writeCard([record(1), record(2)]);
  const before = fs.readFileSync(paths.json, 'utf8');

  const badName = 'memory-card-testchar-2026-10-30T09-00-00-000Z.json';
  fs.writeFileSync(path.join(BACKUP_DIR, badName), '{ 这不是 JSON');
  const badJson = await memoryLib.restoreMemoryCardBackup(badName);
  assert.equal(badJson.ok, false);
  assert.match(String(badJson.error), /JSON/);
  assert.equal(fs.readFileSync(paths.json, 'utf8'), before, '恢复失败不得改动当前记忆卡');

  const wrongShape = 'memory-card-testchar-2026-10-30T09-01-00-000Z.json';
  fs.writeFileSync(path.join(BACKUP_DIR, wrongShape), JSON.stringify({ hello: 'world' }));
  const badShape = await memoryLib.restoreMemoryCardBackup(wrongShape);
  assert.equal(badShape.ok, false);
  assert.match(String(badShape.error), /records/);
  assert.equal(fs.readFileSync(paths.json, 'utf8'), before);
});

test('跨角色备份被拒绝（P1-10）', async () => {
  ensureCharacter();
  const paths = writeCard([record(1)]);
  const before = fs.readFileSync(paths.json, 'utf8');
  const otherName = 'memory-card-otherchar-2026-10-30T09-02-00-000Z.json';
  fs.writeFileSync(path.join(BACKUP_DIR, otherName), JSON.stringify(cardJson([record(9)])));
  const result = await memoryLib.restoreMemoryCardBackup(otherName);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /别的角色/);
  assert.equal(fs.readFileSync(paths.json, 'utf8'), before);
});

test('正常备份可以恢复：先校验再原子写，恢复前自动留底（P1-10）', async () => {
  ensureCharacter();
  writeCard([record(1)]);
  const goodName = 'memory-card-testchar-2026-10-30T10-00-00-000Z.json';
  fs.writeFileSync(path.join(BACKUP_DIR, goodName), JSON.stringify(cardJson([record(3), record(4), record(5)])));
  const result = await memoryLib.restoreMemoryCardBackup(goodName);
  assert.equal(result.ok, true, result.error ?? '');
  assert.ok(Array.isArray(result.warnings));
  const snapshot = memoryLib.memoryCardSnapshot();
  assert.equal(snapshot.records.length, 3);
  assert.deepEqual(snapshot.records.map((item) => item.id).sort(), ['mem_backup_3', 'mem_backup_4', 'mem_backup_5']);
  // 恢复前的当前卡必须已留底。
  const preRestore = backupFiles('memory-card-testchar-');
  assert.ok(preRestore.length >= 2, '恢复前应自动备份当前卡');
});

test('维护器锁：另一个实例正在维护时跳过；陈旧锁可回收（P2-10）', async () => {
  ensureCharacter();
  const paths = writeCard([record(1)]);
  const lockFile = path.join(paths.dir, '.memory-maintain.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, at: Date.now() }));
  const skipped = await memoryLib.runMemoryCardMaintenance({ now: Date.now() });
  assert.equal(skipped.skipped, 'locked');
  assert.equal(fs.existsSync(lockFile), true, '别人的锁不能被删');

  fs.rmSync(lockFile);
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.writeFileSync(lockFile, '{}');
  fs.utimesSync(lockFile, stale, stale);
  const run = await memoryLib.runMemoryCardMaintenance({ now: Date.now() });
  assert.equal(run.ok, true);
  assert.notEqual(run.skipped, 'locked');
  assert.equal(fs.existsSync(lockFile), false, '维护结束应释放锁');
});

test('stats 丢失时流式重建（P2-9）', () => {  const dir = tempDir();
  const paths = engine.resolveMemoryCardPaths(dir);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < 120; i += 1) {
    lines.push(JSON.stringify({ id: `full_${i}`, source: 'qq-group', text: `全量记录 ${i}`, createdAt: ISO, tags: ['qq'] }));
  }
  fs.writeFileSync(paths.fullJsonl, `${lines.join('\n')}\n`);
  const status = engine.fullMemoryCardStatus(paths, engine.normalizeMemoryCardConfig({}));
  assert.equal(status.records, 120);
  const expectedChars = lines.reduce((sum, line) => sum + String(JSON.parse(line).text).length, 0);
  assert.equal(status.chars, expectedChars, '统计字符数应与内容一致');
});
