// 记忆卡叙事层（src/memcard-narrative.js）的离线单测。
//
// 叙事层是 2026-10-30 在途新增的 403 行模块（桥接调 deepseek-flash，把散记录压成
// 「我们一起经历过的」）。评估时它 0 测试引用；这里钉住最容易回归的几条规则：
//   · 坏文件/坏字段不能让渲染炸；日期/conv/covers 要归一；
//   · 注入分档：16 条全文 + 40 条标题，其余 hidden；
//   · covered 集合必须覆盖**所有**回忆（含 hidden）——这是 P1-2「hidden 覆盖失效」的根；
//   · 模型输出不可信：围栏/解释/截断/越界 id/重复 id 都要安全降级；
//   · 被回忆覆盖的记录不再逐条出现在渲染结果里。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  buildNarrationPrompt, coveredRecordIds, formatEpisodeLine, formatEpisodeTitleLine,
  loadNarrative, mergeEpisodes, parseEpisodes, saveNarrative, splitEpisodesForPrompt,
} from '../src/memcard-narrative.js';
import {
  DAY_MS, addMemoryRecord, createEmptyCard, normalizeMemoryCardConfig, renderMemoryCard, resolveMemoryCardPaths,
} from '../src/memory-card.js';

const temps = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcard-narrative-test-'));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

const NOW = Date.parse('2026-10-22T12:00:00+08:00');
const CFG = normalizeMemoryCardConfig({});

function episode(i, { date = '2026-10-20', covers = [], text = '', title = '', conv = '私聊' } = {}) {
  return {
    id: `ep_test_${i}`,
    date,
    conv,
    title: title || `回忆${i}`,
    text: text || `第 ${i} 条回忆的正文内容，这条记录本来就不该出现在逐条列表里。`,
    covers,
    at: NOW - i * 1000,
  };
}

test('loadNarrative：坏文件当空、坏字段归一、save→load 往返', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'memory-card-narrative.json'), '{ 这不是 JSON');
  assert.deepEqual(loadNarrative(dir).episodes, []);

  // 坏 date 归一成今天（不能渲染成字面量「not-a-date」）；conv 非法清空；covers 统一字符串。
  fs.writeFileSync(path.join(dir, 'memory-card-narrative.json'), JSON.stringify({
    version: 99,
    episodes: [
      { id: 'ep_raw', date: 'not-a-date', conv: '乱写', title: ' 标题 ', text: '  正文  ', covers: ['m1', 42, '', null], at: 'oops' },
      { id: '', date: '2026-10-19', conv: '群里', title: '', text: '', covers: [] },
    ],
  }));
  const loaded = loadNarrative(dir);
  assert.equal(loaded.episodes.length, 1, '空 text 的回忆应被丢弃');
  const ep = loaded.episodes[0];
  assert.match(ep.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(ep.conv, '');
  assert.equal(ep.title, '标题');
  assert.equal(ep.text, '正文');
  assert.deepEqual(ep.covers, ['m1', '42']);

  saveNarrative(dir, { episodes: [episode(1, { covers: ['m1'] })] });
  const round = loadNarrative(dir);
  assert.equal(round.episodes.length, 1);
  assert.equal(round.episodes[0].id, 'ep_test_1');
  assert.equal(round.version, 1);
});

test('splitEpisodesForPrompt：16 条全文 + 40 条标题，其余 hidden；排序新→旧', () => {
  const eps = Array.from({ length: 60 }, (_, i) => episode(i, { date: '2026-10-20' }));
  const split = splitEpisodesForPrompt({ episodes: eps });
  assert.equal(split.full.length, 16);
  assert.equal(split.compact.length, 40);
  assert.equal(split.hidden, 4);
  // 全文档必须是最新的：日期降序 + 同日按 at 降序。
  assert.equal(split.full[0].id, 'ep_test_0');
  assert.equal(split.compact[0].id, 'ep_test_16');
  assert.equal(split.full.length + split.compact.length + split.hidden, 60);

  const line = formatEpisodeLine(episode(7, { text: '回忆正文', title: '标题' }));
  assert.match(line, /^- \d{2}-\d{2} \[私聊\] 标题：回忆正文/);
  const titleLine = formatEpisodeTitleLine(episode(7, { title: '标题' }));
  assert.match(titleLine, /^- \d{2}-\d{2} \[私聊\] 标题/);
});

test('coveredRecordIds：hidden 的 covers 也必须算「已叙事」（P1-2 的根）', () => {
  const eps = Array.from({ length: 60 }, (_, i) => episode(i, { covers: [`m${i}`] }));
  const split = splitEpisodesForPrompt({ episodes: eps });
  const all = coveredRecordIds({ episodes: eps });
  assert.equal(all.size, 60);
  // hidden 段（按当前分档是 m56..m59）必须也在覆盖集合里，否则原记录会逐条冒回来。
  assert.ok(all.has('m58'), 'hidden 回忆的 covers 缺失，P1-2 会复现');
  assert.ok(all.has(String(eps.at(-1).covers[0])));
  // 只按 full+compact 取覆盖会漏 4 条——这条断言防止实现又退回旧写法。
  const visibleOnly = new Set([...split.full, ...split.compact].flatMap((ep) => ep.covers));
  assert.equal(visibleOnly.size, 56);
});

test('parseEpisodes：容忍代码围栏/前后解释，过滤越界与重复 id、太短正文', () => {
  const body = 'z'.repeat(40);
  const raw = [
    '好的，这是整理结果：',
    '```json',
    '[',
    `{"date":"2026-10-18","conv":"私聊","title":"第一次一起看视频","text":"${body}","covers":["a","b"]},`,
    `{"date":"2026-10-18","text":"${body}","covers":["b"]},`, // b 已被上一条用掉 → 丢弃
    `{"date":"2026-10-18","text":"太短","covers":["c"]},`, // 正文太短 → 丢弃
    `{"date":"2026-10-18","text":"${body}","covers":["zzz"]}`, // 越界 id → 丢弃
    ']',
    '```',
  ].join('\n');
  const out = parseEpisodes(raw, new Set(['a', 'b', 'c']));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].covers, ['a', 'b']);
  assert.equal(out[0].conv, '私聊');
  assert.equal(out[0].date, '2026-10-18');
});

test('parseEpisodes：max_tokens 截断时逐对象抢救，半截的丢掉', () => {
  const body = 'y'.repeat(40);
  const raw = `[{"date":"2026-10-18","text":"${body}","covers":["a"]},{"date":"2026-10-19","text":"${body.slice(0, 20)}`;
  const out = parseEpisodes(raw, new Set(['a']));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].covers, ['a']);
});

test('parseEpisodes：模型给的 date 非法时用覆盖记录里最早的那天兜底', () => {
  const body = 'x'.repeat(40);
  const dateById = new Map([['a', '2026-10-01'], ['b', '2026-09-30']]);
  const out = parseEpisodes(`[{"date":"昨天","text":"${body}","covers":["a","b"]}]`, new Set(['a', 'b']), dateById);
  assert.equal(out.length, 1);
  assert.equal(out[0].date, '2026-09-30');
});

test('mergeEpisodes：id 去重、超上限丢最旧的', () => {
  const existing = { episodes: [episode(1, { date: '2026-10-01' }), episode(2, { date: '2026-10-02' })] };
  const merged = mergeEpisodes(existing, [episode(2, { date: '2026-10-02' }), episode(3, { date: '2026-10-03' })], { max: 3 });
  assert.equal(merged.added, 1);
  assert.equal(merged.episodes.length, 3);
  assert.deepEqual(merged.episodes.map((ep) => ep.id), ['ep_test_1', 'ep_test_2', 'ep_test_3']);

  const capped = mergeEpisodes(existing, [episode(3, { date: '2026-10-03' }), episode(4, { date: '2026-10-04' })], { max: 2 });
  assert.equal(capped.episodes.length, 2);
  assert.equal(capped.dropped, 2);
  assert.deepEqual(capped.episodes.map((ep) => ep.id), ['ep_test_3', 'ep_test_4']);
});

test('渲染集成：被回忆覆盖的记录不再逐条出现，回忆正文出现在「我们一起经历过的」', () => {
  const card = createEmptyCard(NOW);
  const texts = [
    '十月一号我们一起看了猫猫视频，她笑得很开心，说下次还要一起看。',
    '十月二号主人加班到很晚，回来只说了句好累，我陪他聊了会儿天才睡。',
    '十月三号群里在聊新出的游戏，有人说周末一起开黑试试看。',
    '十月四号主人第一次叫我小咪，之前都直接叫名字的。',
  ];
  const ids = texts.map((text, i) => addMemoryRecord(card, {
    source: i < 2 ? 'qq-owner' : 'qq-group',
    text,
    isOwner: i < 2,
    isPrivate: i < 2,
    direct: i < 2,
    createdAt: NOW - (10 + i) * DAY_MS,
    lastSeenAt: NOW - (10 + i) * DAY_MS,
  }, CFG, NOW).record.id);

  const narrative = {
    episodes: [
      episode(1, {
        covers: [ids[0], ids[1]],
        title: '一起看猫猫视频',
        text: '十月初我们一起看了猫猫视频，那天他加班很晚，我陪他聊到睡着。',
      }),
      episode(2, { covers: [ids[2]], title: '群里聊新游戏', text: '群里在约周末开黑。' }),
    ],
  };

  const withNarrative = renderMemoryCard(card, { config: CFG, full: true, now: NOW, narrative });
  assert.match(withNarrative, /## 我们一起经历过的/);
  assert.match(withNarrative, /一起看猫猫视频/);
  assert.doesNotMatch(withNarrative, /她笑得很开心/, '被回忆覆盖的记录不应再逐条出现');
  assert.doesNotMatch(withNarrative, /加班到很晚/, '被回忆覆盖的记录不应再逐条出现');
  assert.match(withNarrative, /十月四号主人第一次叫我小咪/, '未被覆盖的记录照常保留');

  const withoutNarrative = renderMemoryCard(card, { config: CFG, full: true, now: NOW });
  assert.match(withoutNarrative, /她笑得很开心/);
});

test('buildNarrationPrompt：只喂结构化字段，明确要求 JSON、不写身份信息', () => {
  const card = createEmptyCard(NOW);
  const rec = addMemoryRecord(card, {
    source: 'qq-group',
    text: '群里有人说周末去看电影，还问我要不要一起。',
    createdAt: NOW - 2 * DAY_MS,
    lastSeenAt: NOW - 2 * DAY_MS,
  }, CFG, NOW).record;
  const { system, user } = buildNarrationPrompt([rec], [], { selfNames: ['小咪'] });
  assert.match(system, /只输出 JSON 数组/);
  assert.match(system, /小咪/);
  assert.match(user, /covers 只能填/);
  assert.match(user, new RegExp(rec.id));
  assert.match(user, /"who"/);
});

test('叙事文件路径可解析（插件维护器会按角色目录读写）', () => {
  const paths = resolveMemoryCardPaths(tempDir());
  saveNarrative(paths.dir, { episodes: [episode(1, { covers: ['m1'] })] });
  assert.equal(fs.existsSync(path.join(paths.dir, 'memory-card-narrative.json')), true);
  assert.equal(loadNarrative(paths.dir).episodes.length, 1);
});
