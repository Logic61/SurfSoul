/** 配置存储回归：脱敏/还原密钥、范围收敛、默认值合并、备份失败/坏配置可观测（P1-11）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 隔离环境 ────────────────────────────────────────────────────────────────
// store.js 的路径常量在 import 时从 env 解析，所以必须先设 env 再 import。
// 目的：P1-11 的备份/坏配置断言必须真的写文件，但绝不允许写真实 ~/.dsh 或仓库里的
// config.json —— 全部重定向到一个临时目录。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-store-test-'));
const qqRoot = path.join(tmp, 'qqbot');
const dshHome = path.join(tmp, 'dsh');
const stateDir = path.join(dshHome, 'surfcore');
const backupDir = path.join(stateDir, 'backups');
const qqConfigFile = path.join(qqRoot, 'config.json');
const unifiedFile = path.join(stateDir, 'config.json');
fs.mkdirSync(path.join(qqRoot, 'src'), { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
// paths.js 的 QQBOT_ROOT 探针要求 config.json 与 src/bridge.js 同时存在。
fs.writeFileSync(path.join(qqRoot, 'src', 'bridge.js'), '// test stub\n');
fs.writeFileSync(qqConfigFile, JSON.stringify({ ownerQQ: '12345678' }));
process.env.SURFCORE_ROOT = qqRoot;
process.env.DSH_HOME = dshHome;
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const store = await import('../lib/store.js');
const {
  MASK, normalizeBiliConfig, normalizeQqConfig, redactForUi, restoreMaskedSecrets,
  readBiliConfig, readQqConfig, readUnified, readAll, saveQqConfig, saveUnified,
} = store;

const sample = {
  dsh: { authToken: 'secret-token' },
  snowluma: { accessToken: 'snow-secret' },
  webSearch: { apiKey: 'search-secret' },
  consoleToken: 'console-secret',
  allow: { private: [12345678, '87654321', 'abc'], groups: [] },
};
const redacted = redactForUi(sample);
assert.equal(redacted.dsh.authToken, MASK);
assert.equal(redacted.snowluma.accessToken, MASK);
assert.equal(redacted.webSearch.apiKey, MASK);
assert.equal(redacted.consoleToken, MASK);

const restored = restoreMaskedSecrets(redacted, sample);
assert.equal(restored.dsh.authToken, 'secret-token');
assert.equal(restored.snowluma.accessToken, 'snow-secret');
assert.equal(restored.webSearch.apiKey, 'search-secret');
assert.equal(restored.consoleToken, 'console-secret');

const normalized = normalizeQqConfig({
  ...sample,
  consolePort: 999999,
  allow: { private: ['12345678', 'abc'], groups: ['100000004'] },
  biliBridge: { memory: { enabled: false, refreshIntervalMs: 1 }, share: { times: ['7:00', '99:99'] } },
});
assert.equal(normalized.consolePort, 65535);
assert.deepEqual(normalized.allow.private, ['12345678']);
assert.equal(normalized.biliBridge.memory.enabled, false);
assert.equal(normalized.biliBridge.memory.refreshIntervalMs, 60000);
assert.deepEqual(normalized.biliBridge.share.times, ['07:00']);
// 分享形式：旧 card:boolean 收敛成 cardMode；card 变成派生值（PITFALLS #24）
assert.equal(normalized.biliBridge.share.cardMode, 'text', '没写 cardMode 时默认文本链接');
assert.equal(normalized.biliBridge.share.card, true);
const cardOff = normalizeQqConfig({ biliBridge: { share: { card: false } } });
assert.equal(cardOff.biliBridge.share.cardMode, 'off');
assert.equal(cardOff.biliBridge.share.card, false);
const cardMini = normalizeQqConfig({ biliBridge: { share: { card: true, cardMode: 'miniapp' } } });
assert.equal(cardMini.biliBridge.share.cardMode, 'miniapp', '显式 cardMode 优先于旧 card');
assert.equal(cardMini.biliBridge.share.card, true);
const cardBad = normalizeQqConfig({ biliBridge: { share: { cardMode: 'weird' } } });
assert.equal(cardBad.biliBridge.share.cardMode, 'text', '非法值回默认，不要静默变 off');

const bili = normalizeBiliConfig({
  night: { windows: [{ start: '6:00', end: '8:00', wakes: 3 }], skipChance: 2, maxVideos: 99 },
  quota: { shareDaily: -1 },
  share: { via: 'nope' },
});
assert.equal(bili.night.windows[0].start, '6:00');
assert.equal(bili.night.skipChance, 0.95);
assert.equal(bili.night.maxVideos, 20);
assert.equal(bili.night.minGapMin, 20);
assert.equal(bili.quota.shareDaily, 0);
assert.equal(bili.share.via, 'dynamic');

// 2026-10-22：四本账额度 / 四类动态改成可编辑，保存时必须收敛
const biliEditable = normalizeBiliConfig({
  limits: { daily: -1, globalMin: 999, mineDaily: 50 },
  dynamics: { gapMin: 1, kinds: { best: { slot: 99 }, game: { enabled: false } } },
});
assert.equal(biliEditable.limits.daily, 0);
assert.equal(biliEditable.limits.globalMin, 120);
assert.equal(biliEditable.limits.mineDaily, 50);
assert.equal(biliEditable.dynamics.gapMin, 5);
assert.equal(biliEditable.dynamics.kinds.best.slot, 23);
assert.equal(biliEditable.dynamics.kinds.best.minLen, 50);
assert.equal(biliEditable.dynamics.kinds.anime.slot, 16);
assert.equal(biliEditable.dynamics.kinds.game.enabled, false);
assert.equal(biliEditable.dynamics.enabled, true);

// 2026-10-23：偏好权重（用户要求「每个偏好能拉高/降低」）保存时收敛。
const biliTaste = normalizeBiliConfig({
  preferences: {
    like: ['DeepSeek', 'deepseek ', ' 猫咪 ', '', 'AI'],
    keywords: ['手书', 'deepseek'],
    dislike: [],
    weights: { deepseek: 9, '猫咪': 0, '不存在': 3, '手书': 'abc' },
  },
});
assert.deepEqual(biliTaste.preferences.like, ['DeepSeek', '猫咪', 'AI'], '大小写变体合并、空项丢弃');
assert.deepEqual(biliTaste.preferences.keywords, ['手书'], '和爱看重复的额外关键词去掉');
assert.equal(biliTaste.preferences.weights.DeepSeek, 5, '权重越界收敛到 5');
assert.equal(biliTaste.preferences.weights['猫咪'], 0, '0 是合法的「停用」');
assert.equal(biliTaste.preferences.weights['不存在'], undefined, '不在列表里的权重键要清掉');
assert.equal(biliTaste.preferences.weights['手书'], 1, '非法权重回落到默认 1');

// ── P1-11：备份失败 / 坏配置不能静默 ─────────────────────────────────────────
// 1) 首次安装：文件不存在 = 正常（不是损坏，也没有可备份的旧文件）。行为必须和修复前一致。
fs.rmSync(qqConfigFile, { force: true });
const freshState = readQqConfig();
assert.equal(freshState.corrupt, false, '文件不存在不是“损坏”（首次安装行为不能变）');
assert.equal(freshState.hasUserFile, false);
const freshSave = saveQqConfig({ ownerQQ: '12345678' });
assert.equal(freshSave.backup, null, '首次保存没有旧文件可备份');
assert.equal(freshSave.backupError, null, '首次保存不能报备份错误');
assert.equal(freshSave.corrupt, false);
assert.equal(freshSave.corruptFile, null);
assert.equal(fs.readdirSync(qqRoot).filter((name) => name.includes('.corrupt-')).length, 0, '首次安装不能产生 .corrupt 文件');
assert.equal(JSON.parse(fs.readFileSync(qqConfigFile, 'utf8')).ownerQQ, '12345678');

// 2) 文件存在但 JSON 坏：读要报 corrupt（不能静默显示默认值），保存前把坏文件改名 .corrupt-<ts>。
fs.writeFileSync(qqConfigFile, '{"ownerQQ": "123', 'utf8');
assert.equal(readQqConfig().corrupt, true, '坏 JSON 必须以 corrupt 暴露');
const corruptSave = saveQqConfig({ ownerQQ: '87654321' });
assert.equal(corruptSave.corrupt, true);
assert.ok(corruptSave.corruptFile, '坏文件必须被隔离并返回隔离路径');
assert.ok(fs.existsSync(corruptSave.corruptFile), '隔离后的坏文件必须留在磁盘上（可人工抢救）');
assert.ok(fs.readFileSync(corruptSave.corruptFile, 'utf8').includes('"123'), '隔离文件必须保留原始坏内容');
assert.equal(fs.readdirSync(qqRoot).filter((name) => name.startsWith('config.json.corrupt-')).length, 1, '坏文件应改名为 .corrupt-<ts>');
const afterCorrupt = readQqConfig();
assert.equal(afterCorrupt.corrupt, false, '写入后配置文件必须恢复可解析');
assert.equal(afterCorrupt.config.ownerQQ, '87654321', '本次保存的值必须落盘');

// 3) 备份失败（backups 目录被一个普通文件占住）：save* 必须回传 backupError，且不能挡住保存。
fs.rmSync(backupDir, { recursive: true, force: true });
fs.writeFileSync(backupDir, 'not a directory');
const blockedSave = saveQqConfig({ ownerQQ: '11112222' });
assert.notEqual(blockedSave.backupError, null, '备份失败必须回传 error（旧版静默返回 null）');
assert.match(String(blockedSave.backupError), /ENOTDIR|EEXIST|EPERM|EACCES|ENOENT/, '备份错误要带可读原因');
assert.equal(blockedSave.backup, null);
assert.equal(JSON.parse(fs.readFileSync(qqConfigFile, 'utf8')).ownerQQ, '11112222', '备份失败不能挡住保存');
fs.rmSync(backupDir, { force: true });

// 4) 合体层配置：corrupt 暴露 + saveUnified 隔离坏文件。
fs.writeFileSync(unifiedFile, 'not-json-at-all', 'utf8');
assert.equal(readUnified().corrupt, true, '合体层坏 JSON 也必须是 corrupt');
const badUnified = saveUnified({ admin: { qq: '12345678' } });
assert.equal(badUnified.corrupt, true);
assert.ok(badUnified.corruptFile && fs.existsSync(badUnified.corruptFile), '合体层坏文件必须被隔离');
assert.equal(readUnified().corrupt, false, 'saveUnified 之后合体层配置必须可解析');
assert.equal(readAll().corrupt.qq, false);
assert.equal(readBiliConfig().corrupt, false, 'B站配置文件不存在时不能误报损坏');

console.log('store tests OK');
