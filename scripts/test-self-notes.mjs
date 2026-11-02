// selfNote 自我认知层（src/self-notes.js）的离线单测。
//
// 覆盖：整句去重（重复只刷新时间）/ 40 条上限淘汰最久没碰的 / 坏文件自愈 /
//       删除与清空 / 注入块（最近在前、相对时间、预算截断、空不注入）/ 原子写无残留。
//
// 运行：node scripts/test-self-notes.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  SELF_NOTE_BLOCK_MAX_CHARS, SELF_NOTES_MAX, addSelfNote, clearSelfNotes, formatSelfNotesBlock,
  loadSelfNotes, normalizeSelfNoteText, normalizeSelfNotes, removeSelfNote, saveSelfNotes, selfNotesPath,
} from '../src/self-notes.js';

const T0 = Date.parse('2026-11-02T12:00:00+08:00');
const DAY = 24 * 60 * 60 * 1000;
const temps = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-notes-test-'));
  temps.push(dir);
  return dir;
}

after(() => {
  for (const dir of temps) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('归一化：合并空白、去首尾、只去句尾标点（中间标点保留）', () => {
  assert.equal(normalizeSelfNoteText('  我 今天   有点累。 '), '我 今天 有点累');
  assert.equal(normalizeSelfNoteText('「不知道」也是一种回答……'), '「不知道」也是一种回答');
  assert.equal(normalizeSelfNoteText('今天，我发现…。'), '今天，我发现');
  assert.equal(normalizeSelfNoteText(''), '');
  assert.equal(normalizeSelfNoteText(null), '');
});

test('坏数据归一化：空句/非对象/重复句都收敛，重复保留更新的一次', () => {
  const notes = normalizeSelfNotes({
    notes: [
      { text: '我最近更愿意主动开口了', createdAt: T0, lastTouchedAt: T0 },
      { text: '我最近更愿意主动开口了。', createdAt: T0 + DAY, lastTouchedAt: T0 + 2 * DAY },
      { text: '   ', createdAt: T0 },
      null,
      { text: '我发现自己不太爱解释了', createdAt: '不是时间', lastTouchedAt: T0 + 3 * DAY },
    ],
  });
  assert.equal(notes.length, 2);
  const merged = notes.find((note) => note.text === '我最近更愿意主动开口了');
  assert.equal(merged.lastTouchedAt, T0 + 2 * DAY, '重复句应保留更晚的 lastTouchedAt');
  assert.equal(merged.createdAt, T0, 'createdAt 保留更早的');
  assert.equal(Number.isFinite(notes[1].createdAt), true, '坏时间戳应回 0 而不是 NaN');
});

test('空目录：读空、注入块为空、不写文件', () => {
  const dir = tempDir();
  assert.deepEqual(loadSelfNotes(dir), []);
  assert.equal(fs.existsSync(selfNotesPath(dir)), false);
});

test('追加 + 整句去重：重复只刷新 lastTouchedAt，不占条数', () => {
  const dir = tempDir();
  const first = addSelfNote(dir, '我最近好像更能接受「不知道」了。', { now: T0 });
  assert.equal(first.ok, true);
  assert.equal(first.added, true);
  assert.equal(first.total, 1);
  const again = addSelfNote(dir, '我最近好像更能接受「不知道」了', { now: T0 + 3600_000 });
  assert.equal(again.ok, true);
  assert.equal(again.added, false);
  assert.equal(again.touched, true);
  assert.equal(again.total, 1, '同一句不应重复占条数');
  const notes = loadSelfNotes(dir);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].lastTouchedAt, T0 + 3600_000);
  assert.equal(notes[0].createdAt, T0);
});

test('条数上限：超过 40 条淘汰最久没碰的，新写的保留', () => {
  const dir = tempDir();
  for (let i = 0; i < SELF_NOTES_MAX + 5; i += 1) {
    const result = addSelfNote(dir, `关于自己的第 ${i} 条观察`, { now: T0 + i * 1000 });
    assert.equal(result.ok, true);
    if (i === SELF_NOTES_MAX + 4) assert.equal(result.dropped, 1);
  }
  const notes = loadSelfNotes(dir);
  assert.equal(notes.length, SELF_NOTES_MAX);
  assert.equal(notes.some((note) => note.text === '关于自己的第 0 条观察'), false, '最久没碰的应被淘汰');
  assert.equal(notes.at(-1).text, `关于自己的第 ${SELF_NOTES_MAX + 4} 条观察`, '最新一条必须还在');
});

test('坏文件自愈：坏 JSON 当空；下次写入覆盖成合法文件', () => {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(selfNotesPath(dir), '{ 这不是 JSON', 'utf8');
  assert.deepEqual(loadSelfNotes(dir), []);
  assert.equal(addSelfNote(dir, '坏文件之后写的第一句', { now: T0 }).ok, true);
  const parsed = JSON.parse(fs.readFileSync(selfNotesPath(dir), 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.notes.length, 1);
  assert.equal(parsed.noteCount, 1);
});

test('删除 / 清空：按归一化文本匹配', () => {
  const dir = tempDir();
  addSelfNote(dir, '第一句。', { now: T0 });
  addSelfNote(dir, '第二句', { now: T0 + 1 });
  const removed = removeSelfNote(dir, '第一句');
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, 1);
  assert.equal(loadSelfNotes(dir).length, 1);
  assert.equal(removeSelfNote(dir, '不存在的一句').removed, 0);
  const cleared = clearSelfNotes(dir);
  assert.equal(cleared.ok, true);
  assert.deepEqual(loadSelfNotes(dir), []);
});

test('写入原子：目录里不残留 .tmp 文件', () => {
  const dir = tempDir();
  saveSelfNotes(dir, [{ text: '一句', createdAt: T0, lastTouchedAt: T0 }]);
  saveSelfNotes(dir, []);
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('注入块：最近在前、带相对时间、页脚提示怎么写', () => {
  const dir = tempDir();
  addSelfNote(dir, '更早的一句观察', { now: T0 - 5 * DAY });
  addSelfNote(dir, '最近的一句观察', { now: T0 - DAY });
  const block = formatSelfNotesBlock(loadSelfNotes(dir), { now: T0 });
  assert.ok(block.startsWith('【你对自己的记录（你自己写下的，不是别人给你的设定）】'));
  assert.ok(block.indexOf('最近的一句观察') < block.indexOf('更早的一句观察'), '最近碰过的要排在前面');
  assert.ok(block.includes('（昨天）'), '相对时间要可读');
  assert.ok(block.includes('（5 天前）'));
  assert.ok(block.includes('qq_memory_append(category="selfNote")'), '页脚要告诉她怎么补');
  assert.ok(block.length <= SELF_NOTE_BLOCK_MAX_CHARS);
});

test('注入块：空列表返回空串；预算小则少放几条但标题页脚不丢', () => {
  const dir = tempDir();
  assert.equal(formatSelfNotesBlock([], { now: T0 }), '');
  for (let i = 0; i < 8; i += 1) addSelfNote(dir, `第 ${i} 条自我观察，写得稍微长一点方便占预算`, { now: T0 - i * DAY });
  const short = formatSelfNotesBlock(loadSelfNotes(dir), { now: T0, maxChars: 200 });
  assert.ok(short.length <= 200);
  assert.ok(short.includes('【你对自己的记录'));
  assert.ok(short.includes('qq_memory_append'));
  assert.ok(short.split('\n').length < 10, '预算小的时候不应把所有条都塞进去');
});

test('注入块：maxNotes 限制条数', () => {
  const dir = tempDir();
  for (let i = 0; i < 5; i += 1) addSelfNote(dir, `观察 ${i}`, { now: T0 - i * DAY });
  const block = formatSelfNotesBlock(loadSelfNotes(dir), { now: T0, max: 2 });
  assert.equal(block.split('\n').filter((line) => line.startsWith('- ')).length, 2);
});
