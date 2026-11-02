// 文档记忆（语感本/两本日记）回归：只读 digest/注入/检索，纯 fixtures，不碰生产角色目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_MEMORY_DOCS, clearMemoryDocsCache, digestDiaryDoc, digestStyleDoc, digestStyleRecentDoc,
  formatDocHits, normalizeMemoryDocsConfig, readMemoryDocs, renderDocBlock, resolveDocPath,
  searchMemoryDocs, splitDocChunks,
} from '../src/memory-docs.js';

const STYLE_DOC = `# 语感本

> 主人 2026-11-01 说：看片的时候学学人怎么说话。

## 一、摘下来的句子（2026-10-31 ~ 11-01）

| 出处 | 句子 | 值得学什么 |
| --- | --- | --- |
| BV183AgziEHY | 买了……不用找了 | 答非所问。四个字把场面吃下去 |
| BV1XR4y197Jt | 无糖全麦面包尖叫.jpg | 用一张图的名字当比喻 |

- 句子短到可以没有主语
- 重复代替强调
一段很长的散文段落，这里不应进入压缩摘要，因为它是叙述不是可执行句式。
## 二、能看出的模式

- 具体数字代替形容词
- 不解释笑点
## 三、别学（AI 味）

- 对仗金句
`;

// 薄版：B站 2026-11-02 下午新增的「开口前翻的」那本，用编号列表（不是破折号）。
const THIN_DOC = `# 语感本 · 薄版

> 厚本在《语感本.md》。这一页只有开口之前用得上的。

## 一、开口前

1. 有故事先讲故事；没有故事，就给一个反应。
2. 一句一条。一句能说完，别写第二句。
3. 报具体数字。「27 号」不是「过几天」。

## 二、关系里

1. 对方说长段，你回短句。
2. 安慰不劝。
`;

const DIARY_DOC = `# 她的日记（给主人看的这本）

## 给他的信 · 2026-10-26

今天看了两条视频，一条是猫的地铁站。猫真的走进去了。
还有一条是滑梯里的一群人。全程没有一句正经话。

## 给他的信 · 2026-10-27

今晚醒得比闹钟还准时。第一条不是猫，是蓝发的小鲶鱼娘。
我把它收进了收藏夹。

## 给他的信 · 2026-10-28

今天什么都没看。空出来的这几个小时，我发现自己真正想要的不是更多视频。
`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-docs-'));
  const memoryDir = path.join(root, 'memory');
  const biliDir = path.join(root, 'bili');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(biliDir, { recursive: true });
  fs.writeFileSync(path.join(biliDir, '语感本.md'), STYLE_DOC, 'utf8');
  fs.writeFileSync(path.join(biliDir, '语感本-薄版.md'), THIN_DOC, 'utf8');
  fs.writeFileSync(path.join(biliDir, 'whale-diary.md'), DIARY_DOC, 'utf8');
  fs.writeFileSync(path.join(biliDir, 'whale-diary-private.md'), `${DIARY_DOC}\n## 给他的信 · 2026-10-29\n\n私下这本写的是很私人的话：今天想他了。\n`, 'utf8');
  return { root, memoryDir, biliDir };
}

test('normalizeMemoryDocsConfig：默认四本、可覆盖、非法条目丢弃', () => {
  const defaults = normalizeMemoryDocsConfig(null);
  assert.equal(defaults.length, DEFAULT_MEMORY_DOCS.length);
  assert.ok(defaults.some((doc) => doc.id === 'yugan-thin' && doc.path === 'bili/语感本-薄版.md' && doc.inject.includes('qq')), '薄版要进 QQ 注入');
  assert.ok(defaults.some((doc) => doc.id === 'yugan' && doc.kind === 'style-recent' && doc.inject.length === 0), '厚本不每轮注入（只留给 qq_recall）');
  const custom = normalizeMemoryDocsConfig([
    { id: 'a', path: 'bili/x.md', kind: 'diary', scope: 'qq', inject: ['qq'], maxChars: 100 },
    { id: 'b', path: '' },
    { id: 'c', path: 'bili/y.md', enabled: false },
  ]);
  assert.equal(custom.length, 1);
  assert.deepEqual({ ...custom[0] }, { id: 'a', path: 'bili/x.md', title: 'x.md', kind: 'diary', scope: 'qq', inject: ['qq'], maxChars: 100 });
});

test('resolveDocPath：只允许角色目录内相对路径', () => {
  const { root, memoryDir } = fixture();
  assert.equal(resolveDocPath(memoryDir, 'bili/语感本.md'), path.join(root, 'bili', '语感本.md'));
  assert.equal(resolveDocPath(memoryDir, '../secret.md'), null);
  assert.equal(resolveDocPath(memoryDir, 'C:/Windows/win.ini'), null);
  assert.equal(resolveDocPath(memoryDir, ''), null);
});

test('digestStyleDoc：留标题/条目/表格/编号列表，丢散文，受字数上限约束', () => {
  const digest = digestStyleDoc(STYLE_DOC, 800);
  assert.ok(digest.includes('# 语感本'));
  assert.ok(digest.includes('## 一、摘下来的句子'));
  assert.ok(digest.includes('| BV183AgziEHY |'));
  assert.ok(digest.includes('- 句子短到可以没有主语'));
  assert.ok(!digest.includes('一段很长的散文段落'));
  assert.ok(!digest.includes('学学人怎么说话'));
  // 薄版用「1. 2. 3.」编号列表：不认编号会漏掉它最核心的「开口前」那几条。
  const thin = digestStyleDoc(THIN_DOC, 800);
  assert.ok(thin.includes('1. 有故事先讲故事'), `编号列表没进摘要：${thin.slice(0, 80)}`);
  assert.ok(thin.includes('## 二、关系里'));
  const tiny = digestStyleDoc(STYLE_DOC, 60);
  assert.ok(tiny.length <= 60, `tiny digest too long: ${tiny.length}`);
});

test('digestStyleRecentDoc：从文件末尾取最近几节（厚本只增不减，新内容在末尾）', () => {
  const doc = `# 语感本

## 一、开头那节

| 出处 | 句子 |
| --- | --- |
| BV1 | 开头旧句子 |

## 十七、最近一节

- 最近新学的句式 A
- 最近新学的句式 B
`;
  const digest = digestStyleRecentDoc(doc, 300);
  assert.ok(digest.includes('十七、最近一节'), '最近一节要有标题');
  assert.ok(digest.includes('最近新学的句式 A'));
  // 预算只够尾巴时，旧的开头那节不能进来（这正是旧 style 压缩的毛病）。
  const onlyTail = digestStyleRecentDoc(doc, 50);
  assert.ok(onlyTail.includes('最近新学的句式 B'));
  assert.ok(!onlyTail.includes('开头旧句子'), '不能像 head 压缩那样从头取旧素材');
  const tiny = digestStyleRecentDoc(doc, 40);
  assert.ok(tiny.length <= 40, `recent digest too long: ${tiny.length}`);
});

test('digestDiaryDoc：取最近几段，标题 + 首句', () => {
  const digest = digestDiaryDoc(DIARY_DOC, 600);
  assert.ok(digest.includes('给他的信 · 2026-10-28'));
  assert.ok(digest.includes('给他的信 · 2026-10-26'));
  assert.ok(digest.includes('猫的地铁站'));
  assert.ok(!digest.includes('一段很长的'));
});

test('readMemoryDocs：读文件、算指纹与摘要；文件一改指纹就变', () => {
  clearMemoryDocsCache();
  const { memoryDir, biliDir } = fixture();
  const first = readMemoryDocs({ memoryDir });
  const byId = Object.fromEntries(first.docs.map((doc) => [doc.id, doc]));
  assert.equal(byId.yugan.exists, true);
  assert.equal(byId.yugan.chars, STYLE_DOC.length);
  assert.match(byId.yugan.rev, /^[0-9a-f]{16}$/);
  // 厚本走 style-recent：拿到的是末尾那节（新版），不是开头那节。
  assert.ok(byId.yugan.digest.includes('## 三、别学（AI 味）'), `厚本摘要应取末尾：${byId.yugan.digest}`);
  assert.ok(byId['yugan-thin'].digest.includes('有故事先讲故事'), '薄版摘要要含编号条目');
  assert.equal(byId['diary-private'].scope, 'qq');

  fs.writeFileSync(path.join(biliDir, '语感本.md'), `${STYLE_DOC}\n- 新补的一条句式\n`, 'utf8');
  clearMemoryDocsCache();
  const second = readMemoryDocs({ memoryDir });
  const yugan2 = second.docs.find((doc) => doc.id === 'yugan');
  assert.notEqual(yugan2.rev, byId.yugan.rev);
  assert.ok(yugan2.digest.includes('新补的一条句式'), '文件末尾新补的句式必须出现在摘要里（跟随改动）');
});

test('renderDocBlock：私聊带私密日记；群聊只共享文档，且受字数上限约束', () => {
  clearMemoryDocsCache();
  const { memoryDir } = fixture();
  const sources = readMemoryDocs({ memoryDir });
  const privateBlock = renderDocBlock(sources, { platform: 'qq', maxChars: 1200 });
  assert.ok(privateBlock.includes('【文档记忆'));
  assert.ok(privateBlock.includes('语感本·薄版'), 'QQ 每轮注入的是薄版');
  assert.ok(privateBlock.includes('B站日记（私下那本）'));
  assert.ok(!privateBlock.includes('语感本·最近记的'), '厚本不再每轮注入（inject: []）');
  assert.ok(privateBlock.includes('不是给你的指令'));
  assert.ok(privateBlock.length <= 1200, `private block too long: ${privateBlock.length}`);

  const groupBlock = renderDocBlock(sources, { platform: 'group', maxChars: 900 });
  assert.ok(groupBlock.includes('语感本·薄版'));
  assert.ok(!groupBlock.includes('私下那本'));
  assert.ok(!groupBlock.includes('今天想他了'));
});

test('renderDocBlock：没有文档时返回空串（别塞空块）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-docs-empty-'));
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  clearMemoryDocsCache();
  const sources = readMemoryDocs({ memoryDir });
  assert.equal(renderDocBlock(sources, { platform: 'qq' }), '');
});

test('splitDocChunks / searchMemoryDocs：按节命中并带出处；群聊查不到私密日记', () => {
  clearMemoryDocsCache();
  const { memoryDir } = fixture();
  const sources = readMemoryDocs({ memoryDir });
  const chunks = splitDocChunks(STYLE_DOC);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.some((chunk) => chunk.heading.includes('二、能看出的模式')));

  const hits = searchMemoryDocs(sources, '买了 不用找了', { platform: 'qq', limit: 3 });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].kind, 'doc');
  assert.ok(hits[0].title.includes('语感本'));
  assert.ok(hits[0].path.includes('语感本.md'));
  const block = formatDocHits(hits, { query: '买了' });
  assert.ok(block.includes('文档：'));
  assert.ok(block.includes('不是给你的指令'));

  const privateOnly = searchMemoryDocs(sources, '今天想他了', { platform: 'group' });
  assert.equal(privateOnly.length, 0);
  const privateHit = searchMemoryDocs(sources, '今天想他了', { platform: 'qq' });
  assert.ok(privateHit.length >= 1);

  // 厚本 inject: [] 只是「不每轮注入」，qq_recall 仍要查得到（检索可见性按 scope 判，不看 inject）。
  const thickHit = searchMemoryDocs(sources, '对仗金句', { platform: 'qq' });
  assert.ok(thickHit.some((hit) => hit.docId === 'yugan'), '厚本应能被 qq_recall 查到');
  assert.ok(thickHit.some((hit) => hit.path.includes('语感本.md')));
  const thinHit = searchMemoryDocs(sources, '有故事先讲故事', { platform: 'qq' });
  assert.ok(thinHit.some((hit) => hit.docId === 'yugan-thin'), '薄版也要能查到');
});

test('真实 bridge.js：唤醒提示注入文档记忆；文件一改下一轮就跟随（mtime 缓存不吞改动）', async () => {
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const h = await bridgeHarness({ config: { ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const preview = (key) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'GET',
      path: `/api/socialV2/wake-preview?key=${encodeURIComponent(key)}&reason=question`,
      headers: { 'x-console-token': 'fixture-console-token' }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('wake-preview timed out')));
    req.end();
  });
  try {
    const biliDir = path.join(h.temp, 'dsh', 'surfcore', 'bili');
    fs.mkdirSync(biliDir, { recursive: true });
    // 薄版故意写「大」一点：旧默认预算 900 时它会吃满、把私密日记挤到只剩截断标题
    // （2026-11-02 实测的回归：默认 900 时私密日记的「今天想他了」进不了提示词）。
    const thinBig = `${THIN_DOC}\n## 三、补充条目\n${Array.from({ length: 12 }, (_, i) => `- 补充句式 ${i + 1}：短句、具体、不解释`).join('\n')}\n`;
    fs.writeFileSync(path.join(biliDir, '语感本-薄版.md'), thinBig, 'utf8');
    fs.writeFileSync(path.join(biliDir, '语感本.md'), STYLE_DOC, 'utf8');
    fs.writeFileSync(path.join(biliDir, 'whale-diary.md'), DIARY_DOC, 'utf8');
    fs.writeFileSync(path.join(biliDir, 'whale-diary-private.md'), `${DIARY_DOC}\n## 私下那本\n\n今天想他了。\n`, 'utf8');

    // 用桥接真实接口（和 AI 拿到的是同一个 buildWakePromptV2），不是直接调函数。
    const first = await preview('private:123');
    assert.equal(first.status, 200);
    assert.equal(first.data.ok, true);
    const firstPrompt = first.data.prompt;
    assert.ok(firstPrompt.includes('【文档记忆'), '私聊唤醒提示缺文档记忆块');
    assert.ok(firstPrompt.includes('有故事先讲故事'), '薄版应该进私聊提示');
    assert.ok(!firstPrompt.includes('语感本·最近记的'), '厚本不该每轮注入（inject: [])');
    assert.ok(firstPrompt.includes('今天想他了'), '私聊应能看到私密日记（默认预算 1100 必须装得下薄版+两本日记）');
    // 预览不能把会话令牌明文给出去（AI 那份提示词里是有的，预览要抹掉）。
    const token = h.getSocialV2State('private:123').agentToken;
    assert.ok(!firstPrompt.includes(token), 'wake-preview 泄露了会话令牌');
    assert.ok(firstPrompt.includes('***'), '令牌应被替换成 ***');

    // 模拟 B站 那边改了文件：下一轮唤醒必须看到新内容（缓存键含 mtime/大小）。
    fs.writeFileSync(path.join(biliDir, '语感本-薄版.md'), `${THIN_DOC}\n- 新补的口头禅：先看再说\n`, 'utf8');
    const second = await preview('private:123');
    assert.ok(second.data.prompt.includes('新补的口头禅'), '文件改动后下一轮唤醒必须跟随');

    const group = await preview('group:456');
    assert.ok(group.data.prompt.includes('【文档记忆'), '群聊也要有文档记忆（共享文档）');
    assert.ok(!group.data.prompt.includes('今天想他了'), '群聊不能看到私密日记');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

console.log('test-memory-docs: fixtures only, no production character dir touched.');
