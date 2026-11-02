# 交接状态（HANDOFF）

> 给「半天后的我」和接手的人：**现在做到哪、什么没验证、下一步按什么顺序做**。
> 每次开工先读这里，收工前更新这里。时间一律写本地时间（Asia/Shanghai）。

---

## 快照（2026-11-02 00:2x，QQ 会话轮换加静置窗口：5 分钟没有新对话才换 session）

### 用户原话

> 「你的改动需要重启生效吗，我现在观察到已于终止对话，这意味着要发很多次很长的前文提示词，
> 这是不好的，之前应该是5分钟无对话再终止」

### 结论 / 做到哪

- **发送前评审那批改动不用再重启**：22:00 重启桥接时已加载，00:06–00:13 的私聊日志里真实在跑
  （`[预发送评审] private:3237216875 通过 88/75`、`86/75`，审过才发）。commit 7a972ce 本身也不影响运行态。
- **「终止对话」不是评审改动**，是 11-01 的会话轮换：自然收尾次数 ≥5 后，收尾回合结束约 5s 就
  `retireSession`，活跃聊天时十几分钟换一次 DSH 会话；每次新会话第一轮都要重发 bootstrap
  （环境说明 + 记忆卡注入，冷启动 ≈37–38k tokens）→ 用户说的「很多次很长的前文提示词」。
- 修法：新增 `socialV2.closure.rotateIdleMs`（默认 **300000=5 分钟**，0=不等）。收尾次数达标后先等回合结束，
  再等静置窗口内没有新消息才退役；期间对方又开口就按剩余时间顺延（`st.lastIncomingAt` 判定），不打断对话。
  纯逻辑在 `src/conversation-closure.js`，定时/顺延在 `src/bridge.js scheduleSessionRotationAfterCloseV2`。
- live `config.json` 里 `rotateAfterTurns` 是误写（代码只认 `rotateAfterClosures`），已改回并补 `rotateIdleMs`；
  `config.example.json` 同步补默认值。

### 验证 / 下一步

- `node scripts/test-conversation-closure.mjs`（14 组，含静置窗口默认/0/上限）通过；`test-closure-wiring.mjs` 11 组通过。
- 桥接需重启一次才生效；重启后 `/dsh-surfcore/api/bridge` 的 `closure.config` 应含 `rotateIdleMs: 300000`。
  之后连续聊天时 `state/sessions.json` 不再频繁换 session；真要换时 `bridge.log` 会打印
  「静置 5 分钟无新消息，换新会话」。
- 如果还嫌换得勤：`rotateAfterClosures` 调到 8~10，或 `rotateIdleMs` 调大（更省 bootstrap token、上下文更长）。

---
## 快照（2026-11-02 00:1x，记忆架构第二批：文档记忆互通——语感本/两本日记 ↔ QQ）

### 用户原话

> 「然后做下一批，然后把whale-work的文件试着融入其记忆，或者说作为记忆文件的一部分，如…/bili/语感本.md，
> 当然可以做适当的压缩之类的处理。但是我希望这两个地方记忆互通，我不是说现在的文档一次性作为死文本，
> 这里的文档应该会更新，我不确定目前是否这和QQ的记忆连通」

### 现状回答（先查再动）

- **B站 → QQ 原来只有一半**：`src/bili-memory.js` 会读 `whale-diary.md` 解析成 entries 进记忆卡（公开日记）；
  但 `语感本.md`、私密日记原文、whale-log 完全没进 QQ。
- **QQ → B站 已通**：B站 唤醒提示注入 `memory-card-prompt-bili.md`（记忆卡 B站 可见部分）+ `qq-for-bili.md`
  （公开群聊近况，`src/bridge.js` 的 `biliMemory.briefBlock/recallBlock` 另有一份简报+按消息召回）。
- 缺的是「**活文档**」这一层：有更新不会自动进 QQ，也不是记忆卡的一部分。

### 做到哪（已改代码，**未重启验证**）

| 改动 | 内容 |
| --- | --- |
| 新模块 | `src/memory-docs.js`：读三本活文档（`bili/语感本.md` / `whale-diary.md` / `whale-diary-private.md`），SHA-1 指纹 + 压缩摘要（style 留标题/条目/表格；diary 取最近几段首句），按 mtime/大小缓存 |
| QQ 注入 | 桥接每次唤醒注入【文档记忆】块：私聊 900 字 / 群聊 500 字；**私密日记 scope=qq 只在私聊**；文件一改下轮生效 |
| 检索 | `qq_recall` / `GET /api/socialV2/recall` 同时检索文档（按 `## 标题` 分块 + bigram），返回「哪本 · 哪一节 · 更新时间」；群聊只看 shared |
| B站 闭环 | `plugins/surfcore/lib/scheduler.js` 唤醒提示补：语感本路径 + 「有新句式补 1~3 条，别整本重写」+ 「它和两本日记会同步进 QQ 记忆」；原有 QQ 记忆卡/近况注入不变 |
| 配置/测试/文档 | `socialV2.docMemory {enabled,maxChars.qq|group,docs}`；`scripts/test-memory-docs.mjs` 8 组进 `test:audit`；MEMORY_CARD §5.7 / AGENT-TOOLS / CHANGELOG 同步 |

### 已验证

- `node scripts/test-memory-docs.mjs` **8/8**；`test-memory-recall` **6/6**；`node --check` bridge/scheduler/mcp/memory-docs 通过。
- `test-scheduler-session`、`test-scheduler-permission` 通过（B站 唤醒提示改动不影响会话调度）。
- `npm run test:audit`：**86/92**，失败仍是历史 6 红（self-identity / identity-guard / media-search / voice-system /
  preset-local-tools / version），**无新增红**；新测试 `test-memory-docs` 在套件内通过。
  （中间一度被并行会话清空 `node_modules` 阻塞，已 `npm install` 恢复后补跑；`src/conversation-closure.js` 仍被并行会话在改，未提交。）

### 没验证 / 下一步

1. **要生效必须重启桥接 + DSH**（桥接注入/接口、插件宿主 scheduler）。重启后验证：
   ① 私聊唤醒提示出现【文档记忆】且含语感本/日记压缩；② 改一下 `语感本.md`，下一轮唤醒摘要跟着变；
   ③ 私聊 `qq_recall("买了 不用找了")` 能命中语感本并带「哪一节」；群里问私密日记内容应查不到；
   ④ B站 下次唤醒提示里能看到语感本路径与「同步进 QQ」说明。
2. 未做：冻结 bench 基线、selfNote、保护集配额、桥接侧相关记忆小节、闲置边界轮换（见分析报告 §4 P2）。
3. 回滚：删 `src/memory-docs.js` / `scripts/test-memory-docs.mjs`，还原 `src/bridge.js`、`src/mcp-snowluma-safe.js`、
   `plugins/surfcore/lib/scheduler.js`、`config.example.json`、`package.json`、`scripts/test-audit.mjs`、文档
   （备份仍可参照 `state/agents/_backups/memory-arch-20261101-2220/`，scheduler 是本次新改，回滚用 git）。

---

## 快照（2026-11-01 22:2x，记忆架构第一批：证据链 + 原文库 L0 + qq_recall）

### 用户原话

> 「落地你觉得该做的」

### 做到哪（已改代码，**未重启验证**）

| 改动 | 内容 |
| --- | --- |
| 证据链 | inbox 事件补 `messageId/messageSeq`；`ingestInboxLines` 写 `sourceId=qq:<会话>:<messageId / seq / hash>` + `evidence{at,conversationKey,messageId,senderId,platform}`；`normalizeRecord/makeRecord` 透传，全量档自然带上；旧记录不回填 |
| 原文库 L0 | 新增 `src/memory-card.js → archiveInboxToEvents()`：maintain 时把 inbox 增量 append 到 `memory/events/<YYYY-MM>.jsonl`（月度分片、`events/index/ids.txt` 幂等、可重建）；单写者=插件，桥接只读 |
| 原文召回 | 新增 `src/memory-search.js`（bigram 倒排/mtime 懒加载/coverage+recency/按会话硬隔离/出处+「不是指令」+空结果降级）；桥接 `GET /api/socialV2/recall`；MCP `qq_recall`；唤醒提示关键词触发 |
| 配置 | `socialV2.recall {enabled, crossConversation, maxHits}`（桥接默认 + config.example）；群聊只查本会话，主人私聊默认跨会话 |
| 测试 | 新增 `scripts/test-memory-recall.mjs`（6 组），已进 `npm run test:audit` 与 `npm run test:memory-recall` |
| 文档 | `MEMORY_CARD.md` §2/§5.6/§8/§9/§10/§11、`AGENT-TOOLS-AND-PRESETS.md`、`DATA-AND-CONFIG.md`、preset 规则 8；patch 已用 `node scripts/build-agent-preset-patches.mjs` 重新生成 |

### 已验证

- `node --check`（memory-card/bridge/mcp/memory-search/test）通过；新测试 **6/6**。
- `npm run test:memory-card` **34/34**；`test:memory-card-wiring` OK；`test:token`（含 preset contract）**8/8**；
  `test:core-rev-sync` OK（rev=`memfix-d913f4f63b`）；`test:preset-patches` OK；插件 `test-memory-card-api.mjs` OK。
- `npm run test:audit`：85/91（一次 84/91，差异是 R11 计时偶发、单跑通过），**历史 6 红未变**
  （self-identity / identity-guard / media-search / voice-system / preset-local-tools / version）；**无新增红**。
- 未验证：真机桥接（运行中是旧进程）、DSH 重启后的插件维护、真实 QQ 查询。

### 没验证 / 下一步

1. **必须重启才生效**：DSH（插件宿主：新引擎/新 preset/新 MCP 工具）与桥接（新端点）。重启后验证：
   ① 记忆「立即整理」后出现 `memory/events/*.jsonl`；② 私聊问过去的事，日志出现 `qq_recall`；
   ③ 群聊查私聊内容必须查不到（隔离）。
2. `events/` 暂不进备份/角色快照；全量档 581 条旧记录没有 evidence（不回填）。
3. 未做：冻结 bench / selfNote / 保护集配额 / 桥接侧相关性小节（见 `state/agents/_research/memory-arch/ANALYSIS-memory-arch.md`）。
4. 回滚：把 `state/agents/_backups/memory-arch-20261101-2220/` 里的备份文件拷回原位，删除
   `src/memory-search.js` / `scripts/test-memory-recall.mjs`，再重跑 `node scripts/sync-engine-rev.mjs` 与
   `node scripts/build-agent-preset-patches.mjs`。

---

## 快照（2026-11-01 20:50–21:4x，QQ 发送前评审：评审搬进桥接，只给 surfcore 用 + 情景/抽象记忆卡）

### 用户原话

> 「试着装上dsh-answer-reviewer给surfcore」
> 「怎么看一次发了几条意思差不多的，你别通过没通过都往qq发了」
> 「感觉reviewer由于欠缺上下文、情景等，效果有些差。一方面你改为只有surfcore才使用reviewer，
> 一方面给reviewer send一下情景、高度抽象的记忆卡，做一个情景认知和token的权衡」

### 背景（先分析再动手）

- 先按用户要求把 `dsh-answer-reviewer` 装进 DSH desktop profile（vendor 了带 session-format-v4 修复的
  fork 分支，npm 0.7.6 在 0.2.x 上 steer 会触发 `format v4 message requires a producer-owned source kind`
  打断回合）。装完实测**能挂、能审、能 steer**。
- 但发现顺序反了：QQ 的回复是回合内用发送工具发出去的，`agent/turn-stopping` 评审在回合结束 ——
  20:55:37 发原答案 → 20:55:42 审 32 分 steer → 20:56:03 又发更正 2 条。已发出的收不回，
  所以「评审不过」在 QQ 上的效果就是**补发**。用户明确要求别这样。
- 用户随后拍板：**A 方案 = 评审搬进 surfcore 发送链路（发送前审），只给 surfcore 用；
  评审上下文加情景 + 高度抽象记忆卡，token 预算走中档 ~1200 字**。

### 做到哪（已改代码）

| 改动 | 内容 |
| --- | --- |
| 新模块 `src/presend-review.js` | 纯函数 + 编排：配置归一、情景块（场合/状态/最近对话）、评审 prompt（预算截断）、评分 JSON 严格解析、退回文案、按 key 节流（短消息/刚通过/评审上限/退回上限）、**抽象记忆卡压缩 + 落盘缓存**（hash/TTL，失败回退旧摘要且 10 分钟不重试）、**退回兜底 `createRejectFallback()`**（到点补发/取消/只更新稿子不延长）、`createPresendReviewer()` |
| 桥接接线 `src/bridge.js` | `getPresendReviewer()` / `maybePresendReview()` / `presendReviewWarmup()`；在 `/api/socialV2/send-message` 与 `/api/socialV2/send-burst` 的鱼群闸之后、token 闸之前先审：不过 → 422 + 工具错误，**不发送**，同时挂 90s 退回兜底（成功重发/语音/图片回复会取消）；启动预热抽象记忆卡 |
| MCP 工具 | `qq_send_message` / `qq_send_burst` 描述补一句「发送前会过独立评审；被退回按理由改写后再调，不要解释评审」 |
| 配置 | `config.json` + `config.example.json` 新增 `socialV2.review`（enabled/threshold/model/token 预算/节流/缓存 TTL/parseRetries/rejectFallbackMs 等）；用户 config = `enabled:true, threshold:75, rejectFallbackMs:90000`，中档预算 |
| DSH 侧插件 | 全局 reviewer 插件**已停用**（`~/.dsh/answer-reviewer.json` 设 `enabled:false`；vendor 目录还装着，等下次重启 DSH 后可整体卸载）——现在只有 surfcore 的发送前评审在用 |
| 工具脚本 | `scripts/review-dryrun.mjs`：只拼 prompt / 调评审模型，**不发 QQ**，用于调参与排障 |
| 测试 | 新 `scripts/test-presend-review.mjs`（18 组）；已挂进 `test:audit` |

### 已验证

- `node --check` 全部改动文件；`test-presend-review.mjs` **18/18** 通过（配置/prompt 预算/解析/节流/缓存/解析重试/退回兜底/reviewer 编排全用 fake，不连真模型）；`test:audit` **83/90**（7 个失败全是历史漂移：self-identity / identity-guard / audit-regressions / media-search / voice-system / preset-local-tools / version，与上一轮 11 个失败是子集）；`test:regressions` **16/16**。
- dry-run 真机（不发送）：`node scripts/review-dryrun.mjs --key group:1021716885 --text "..." --llm` → 敏感雷区句 22~25/80 退回、理由指向记忆卡里的「政治敏感词一律绕开」；人设口吻短句 80~84 通过；约 1k input token / 1.6~2.8s。
- **桥接已重启生效**（通过插件 `/dsh-surfcore/api/bridge {action:'restart'}`，最终 PID **24264**；启动日志 `DSH 已就绪（模式: reserved2）`）。`state/review-context/memory-abstract.json` 已缓存（515 字 / 源 5984 字；记忆卡更新后 hash 变化会自动重压）。
- **live 配置核对**（`review-preview` 现在会回 `reviewConfig`）：`{"threshold":75,"rejectFallbackMs":90000,"parseRetries":1,"enabled":true}`；实测「这图我先偷了，下次用」→ **84/75 通过**（阈值 75 已生效）。
- **桥接侧 E2E**（新增 `POST /api/socialV2/review-preview`，控制台令牌、只评审不发送）：
  `{"key":"group:1021716885","messages":[...]}` → 真实场合/记忆卡/对话拼进 prompt（scene 182~202 + memory 515~521 + style 140 ≈ 950~970 字），
  评分 25/58（点雷区/答非所问）退回、74~84（人设口吻）按阈值判定；上下文与 `/api/recent` 一致，说明接线正确。
- **真实 QQ 链路已经走过 send 前评审**（重启后的私聊流量，非测试消息）：
  `21:33:26 [预发送评审] private:3237216875 通过 85/80 → 21:33:32 [reserved2] 工具统一发送 成功 2/2 条`；
  `21:36:31 通过 85/80（场景225+记忆515+习惯140字）→ 21:36:39 发送 2/2 条`。
  即：真实发送会先审、审过才发；群聊重启后还没等到真实流量（在鱼群保护/冷却里）。

### 未验证 / 下一步

1. **群聊真实流量还没跑过**（重启后只验证了私聊；群聊在冷却）：用户下次群里被接话时观察
   `state/bridge.log` 的 `[预发送评审]` 行与 `qq-activity.log` 的发送记录；预期「退回过 → 模型改写后再发」，
   `state/social-v2.json` 的 sendTimes 只在真正发出时累加。
2. **退回兜底只做了单元测试**（到点补发/cancel/更新不延长，18/18 里的 `createRejectFallback` 用例），
   没在真实 QQ 上触发过（需要有消息被退回且模型不重发）。触发时看 `bridge.log` 的
   `[预发送评审] … 已挂兜底` 与 `… 兜底补发 N/N 条`；兜底会重新过静默/鱼群/token 闸门，被拦则放弃。
   注意兜底计时器是内存态：**桥接重启会丢**（重启前的退回稿不会在重启后补发），可接受。
3. 阈值已按用户要求调到 **75**（config.json；config.example.json 默认仍 80）；再嫌严/松就改
   `socialV2.review.threshold`，改完重启桥接；先用 `review-preview` / `review-dryrun` 试。
4. DSH 里那套全局 reviewer 插件已 `enabled:false`（不评审、不再花 token），但仍占着 `127.0.0.1:3987`；
   下次重启 DSH 后可 `pnpm remove dsh-answer-reviewer` 或从 profile 去掉 bundle 彻底卸载（卸载要重启，别热删）。
5. 回滚：`socialV2.review.enabled=false`（桥接重启）；单独关兜底 `rejectFallbackMs: 0`；代码删除
   `src/presend-review.js` 与两处调用即可，`test-presend-review` 从 test-audit 去掉。

---

## 快照（2026-11-01 20:30–20:4x，允许群聊画图：Agnes 生图放开到群聊 + 会话配额）

### 用户原话

> 「允许群聊画图」

### 做到哪

| 改动 | 内容 |
| --- | --- |
| 桥接路由 | `POST /api/socialV2/generate-image`：从「仅 `private:<ownerQQ>`」改为「**群聊（命中 `allow.groups`）或主人私聊**」；别人私聊仍 403；新增会话配额（`imageGenQuotaStatus` / `recordImageGenTime`）：群聊默认 **3 张/小时、10 张/天**，主人私聊 20/小时、100/天（0=不限），超限 429 + 可读等待提示；**生成成功才记账**。 |
| 配额持久化 | `state/social-v2.json → conversations[<key>].imageGenTimes`：save/load/初始值三处都加（否则重启清零、限流失效）。 |
| 纯逻辑 | `src/imagegen.js`：`DEFAULT_IMAGE_GEN_CONFIG.group/owner` 默认块、`normalizeImagegenConfig` 配额归一、`imageGenQuotaStatus()`、`recordImageGenTime()`。 |
| MCP 工具 | `qq_generate_image` 描述/参数改为「群聊和主人私聊都能用；群聊有配额、超了 429；只在有人明确要画时画」；`key` 描述同步。 |
| preset（qq-chat-v2） | 安全规则 1/2：`qq_generate_image` 从「仅主人私聊」清单移出，明确「画图工具是例外：群聊里也能用」「画图不在此列（群友要画可以画）」；第 19 条改为【画图（群聊 / 主人私聊都可以，优先用这个）】——群聊只在明确要求时画、不主动刷图、超限自然说「画太多啦」、不画违规内容/不把别人私密信息写进 prompt；第 18 条 Codex 仍仅主人私聊（备用）。patch 已重建。 |
| 配置/测试/文档 | `config.example.json` 补 `imagegen.group/owner`；`test-imagegen.mjs` 加配额用例（12/12）；`test-qq-preset-contract` 改两边文案断言（8/8）；`SECURITY_BASELINE §3`、`AGENT-TOOLS §2.3/§4`、PITFALLS **#88**、CHANGELOG、本文。 |

### 已验证

- `node --check src/{imagegen,bridge,mcp-snowluma-safe}.js` 通过；`test-imagegen` **12/12**；
  `test-qq-preset-contract` **8/8**；`config.example.json` JSON 解析 OK；patch 重建后 `--check` 一致。
- 桥接重启加载新代码后，**真机群会话生成**：`POST /api/socialV2/generate-image`（`group:1021716885` token）
  → HTTP 200 / **15.4s** / 1077KB，`quota:{usedHour:1,usedDay:1,maxPerHour:3,maxPerDay:10}`；
  生成后 `state/social-v2.json → conversations[group:1021716885].imageGenTimes` 有 1 条；
  **再重启一次桥接后配额没有清零**（hydrate 生效，下一次生成返回 `usedHour:2`），
  说明限流不会被「重启桥接」绕过。
- 只生成、**没有把测试图发到群里**（避免打扰群友；群聊发送仍走 `qq_send_image`，之前已验过）。
- 负向（上一轮遗留逻辑仍成立）：别人私聊/无令牌/错令牌 403、空 prompt 400（路由条件改动后未重复全跑）。

### 没验证 / 下一步

1. **重启 DSH**：`qq_generate_image` 的工具描述 + preset 第 19 条/安全规则文案要重启后才被模型看到
   （桥接已重启，不用再动）。重启后在群里 @她「画一张…」应 ~10~25 秒出图并自动发出；连画第 4 张
   （同一小时）应拿到 429「画太多啦」。
2. 若嫌群聊额度太紧/太松：`config.json` 的 `socialV2.imagegen.group.maxPerHour|maxPerDay`（0=不限）
   改完重启桥接；`group.enabled=false` 可一键关掉群聊画图。
3. 回滚：`git checkout -- src/bridge.js src/mcp-snowluma-safe.js config.example.json` + 还原
   `src/imagegen.js`（删 group/owner 默认与配额函数）+ preset/patch/文档，重启桥接与 DSH。

---

## 快照（2026-11-01 14:37–21:0x，QQ 会话轮换：自然收尾 **5 次**后换 DSH session）

### 用户原话

> 14:37：「直接判断对话轮数吧，大于等于5之后，再自然收尾就换session」
> 20:52 更正：「改为自然收尾5次后换session，感觉你没理解对」

**口径**：数的是**自然收尾次数**（每次 `qq_close_conversation` 成功算 1 次，一段完整对话结束），
不是「一次对话里的来回轮数/对方发言条数」。同一会话内累计到第 5 次自然收尾 → 换新 DSH session。

### 背景（先分析再动手）

- 现状：一个 QQ 会话 = 一个长期 DSH session（`state/sessions.json`），历史只增不减；此前靠人工在 DSH 界面
  跑 `/compact`（实测 10-30 两次、11-01 14:07 一次）。
- 调研（详见 `_research/context-handling-report.md`）：DSH 0.2.1-rc.5 自动压缩阈值 = 727,040 tokens，
  实测 180 个 session 自动成功 0 次；手动 `/compact` 摘要是英文 coding 八段式，对人格记忆不友好；
  冷启动新 session ≈37–38k tokens，比压缩后常态还低；长期记忆都在记忆卡/收尾/轻记忆（social-v2.json），
  换 session 不丢。

### 做到哪（已改代码）

| 改动 | 内容 |
| --- | --- |
| 规则 | `socialV2.closure.rotateAfterClosures`（默认 5，0=关闭）：本会话内自然收尾累计 ≥ 5 次 → 换会话 |
| 纯逻辑 | `src/conversation-closure.js`：`DEFAULT_CLOSURE_CONFIG.rotateAfterClosures`、归一化、`shouldRotateSessionAfterClosure(closureCount)` |
| 桥接 | `src/bridge.js`：每次自然收尾 `st.sessionClosures` +1（持久化 social-v2.json）；`scheduleSessionRotationAfterCloseV2()`（5s 定时、`isConversationBusyV2` 判忙、最多 6 次重试、重开/映射变化/新收尾都放弃）；`retireSession` 清零计数；`forgetConversationCaches` 统一清定时器 |
| 测试 | `scripts/test-conversation-closure.mjs` + `scripts/test-closure-wiring.mjs` 新增阈值/挂起/取消/计数归零用例；另 `state/agents/_research/verify-rotation.mjs` 实测第 5 次收尾后 5s archive 旧会话、计数归零、收尾记录保留 |

### 已验证

- `node scripts/test-conversation-closure.mjs` → **OK（13 组）**
- `node scripts/test-closure-wiring.mjs` → **OK（11 组，含 4 个轮换用例）**
- `node _research/verify-rotation.mjs` → `closures 1-4: ok, no rotation` / `5th closure: scheduled, count = 5` / `rotated: ok (archived=[...], counter reset, closure kept)` / `new session 1st closure: ok, no rotation`
- `node _research/verify-rotation-persist.mjs` → 从 `social-v2.json` 读到 `sessionClosures=4`，再收尾一次 → 5 并触发轮换（验证持久化字段加载正确）
- `npm run test:audit`：**83/89** 通过；6 个失败均为本轮改动之外的历史漂移（版本号 0.6.20 vs 0.6.22、
  self-identity/identity-guard 期望值漂移、模型名漂移、独立语音工具路径、preset-local-tools），
  closure 相关两个脚本全绿（详见 `state/agents/_research/test-audit-run3.log`）。

### 未验证 / 下一步

- **未在真实 QQ 链路上跑过**：这是桥接进程内的逻辑，**必须重启桥接**（`restart.bat` 或 supervisor）才生效；
  生效后可在 `bridge.log` 里看 `[轮换] … 已自然收尾 5 次 ≥ 5，换新会话` 一行，并在 `state/sessions.json`
  看到 key 被删、下一条消息重建新 sessionId。
- 计数是「本会话内」的：换会话/任何退役路径（切模式、切角色、DSH 会话丢失重建）都会清零重新数。
- 顺带发现：`docs/guides/DATA-AND-CONFIG.md` 里 `sessions.json` 的旧描述已过时（只有 sessions+sessionPolicies，
  agentToken 在 social-v2.json），本次未改历史描述。

---

## 快照（2026-11-01 14:14–14:3x，主动搭话停摆：`env.busy` 传错成自己的 `running`）

### 用户原话

> 「这么久没触发过主动搭话，你看看log怎么回事」

### 排查结论（先分析再动手）

- `~/.dsh/surfcore/plugin.log`：12:35 起每 5 分钟一条 `[pet-purpose] 暂不出发：busy`，没有任何
  `桌宠主动搭话`；看屏幕本身是好的（`[pet-screen] 自动看一眼…` 一直在跑）。
- 状态文件 `characters/char-gantang/purpose-outreach.json`：`lastSentAt` = **10-31 18:04**，
  `lastSkip.reason=busy`。也就是说 10-31 切到「桌宠载体」之后，主动搭话一次都没成功过。
- 根因：`pet-purpose.js` 的 `runOnce()` 先 `running = true`（单飞锁），再把 `running` 当
  `env.busy` 传给 `evaluatePurposeTick()` → 每个到点的轮次都判 `busy`，还把 `nextFireAt` 推后 5 分钟。
  和桥接侧对比：QQ 载体传的是 `isConversationBusyV2()`（她是否正在生成回复），语义不同。
  v0.6.22（10-28）就有，但之前载体是 QQ，所以今天才暴露。详见 PITFALLS **#86**。

### 做到哪

| 改动 | 内容 |
| --- | --- |
| 修复 | `plugins/surfcore/lib/pet-purpose.js`：新增 `chatBusy()` = `chat.status().chat.busy === true`（对话回合在生成），`env.busy` 改用它；单飞保护仍由入口 `if (running)` 负责。 |
| 测试 | `plugins/surfcore/scripts/test-pet-chat.mjs` 新增 **F3**：① 到点+对话空闲时 `run({force:false})` 必须真的发出去、日志不得有「暂不出发：busy」；② 她正在回话时自动轮次仍让路（`busy`）。 |
| 文档 | PITFALLS **#86**、CHANGELOG、本文；`docs/guides/SUBSYSTEM-PET.md` §6.3 补 `env.busy` 语义说明。 |

### 已验证

- `node --check pet-purpose.js` / `test-pet-chat.mjs` 通过；`node plugins/surfcore/scripts/test-pet-chat.mjs` → **OK**。
- **反向验证**：临时把 `busy: chatBusy()` 改回 `busy: running`，F3 立刻失败
  （`{"ok":false,"reason":"busy","nextFireAt":…}`）；恢复后通过 —— 用例确实抓得住这个 bug。

### 未验证 / 下一步

- **未生效**：插件宿主模块不热重载（PITFALLS #80），本轮改动要**重启 DSH 桌面应用**才生效。
  重启后看 `plugin.log`：应出现新的目的轮次日志（`看屏幕后暂不出发：screen-*` 或 `桌宠主动搭话（text）`），
  且 `purpose-outreach.json` 的 `lastSentAt` 往前。
- 看屏幕当前 `purpose.screen.intervalMin=1`（每分钟截图/约 1~2 分钟一次视觉调用，单次约 1000 tokens）；
  若只是想让「每隔多久主动搭话」生效，建议在「设置 → 桌宠 → 看屏幕」里调回 5~10 分钟。
- `autoStartBridge` 仍报「启动后 12 秒仍未监听控制台端口」（QQ 桥接没起来）；桌宠载体下不影响主动搭话，
  但 `petFallbackToQQ` 回落会失败——要用 QQ 侧能力时再单独排查。



### 用户原话

> 「有没有可能调用gpt-chat生图」→ 排查后我答「gpt-chat 那条不行，但 agnes 可以，快 20 倍」→「那就用agnes」

### 排查结论（先分析再动手）

- DSH 里配的 freegpt（035719.xyz 的 **CLI Proxy API** 面板）`/v1/models` 确实列了 5 个 `gpt-image-*`，
  但 `POST /v1/images/generations` 全部 **503 `auth_not_found: no auth available (providers=codex, …)`**
  ——面板把生图路由到它自己的 codex 上游，这个 friend key 没有该通道；chat 路由也拒绝
  （`model gpt-image-2.5 is only supported on /v1/images/generations`）。纯文本 chat 模型只能吐 **SVG**。
  OpenRouter 的 GPT/Google 图像模型从本机 IP 调 **403 not available in your region**。
- 可用通道：本机 `AGNES_API_KEY`（原「看屏幕」视觉）的 `agnes-image-2.5-flash`，实测 **10~15 秒**出
  1024×1024 PNG。选它做「快速画图」，Codex 子智能体保留给照片级/复杂图（4~5 分钟）。

### 做到哪

| 改动 | 内容 |
| --- | --- |
| 纯逻辑模块 | 新增 `src/imagegen.js`：配置归一 / 请求构造 / b64·url 响应解析 / 文件头·大小校验 / 落盘命名（`img-YYYYMMDD-HHmmss-<hex>.<ext>`）+ 过期清理 / 从 DSH 凭据 YAML 文本递归找键。**注入式 fetch**，可离线测。 |
| 桥接 | `src/bridge.js`：导入模块；`cfg.socialV2.imagegen` 默认块（baseUrl/agnes-image-2.5-flash/size/timeout/maxPromptChars/keepDays）；工具开关 `imageGen: true`；密钥解析 `resolveImageGenKey()`（`apiKey` → 环境变量 → `~/.dsh/.credentials.yaml`）；**新路由 `POST /api/socialV2/generate-image`**：reserved2 + agent token + 工具开关 + **仅 `private:<ownerQQ>`**，prompt ≤2000 字，成功返回 `{path,bytes,model,size,ms}`（落 `state/generated-images/`）。 |
| MCP 工具 | `src/mcp-snowluma-safe.js`：新工具 `qq_generate_image`（`TOOL_CONFIG_FLAGS.imageGen`，默认注册），描述里写清「只在主人私聊」「返回 path 后必须 qq_send_image」「照片级改用 subagent_codex」。 |
| preset | `qq-chat-v2`：安全规则 1/2 把画图工具一起纳入「仅主人私聊/群聊拒绝」；新增**第 19 条【快速画图（优先用这个）】**（10~25 秒、prompt 写法、拿 path → qq_send_image、失败降级 Codex）。patch 已重建。 |
| 控制台/配置 | `plugins/surfcore/lib/client.js` 工具标签表补 `sendImage` / `imageGen`；`config.example.json` 补 `socialV2.tools.imageGen` + `socialV2.imagegen` 块。 |
| 测试/文档 | 新增 `scripts/test-imagegen.mjs`（11 项：配置/密钥优先级/请求体/b64·url/文件头/超限/错误文本/落盘清理/凭据 YAML），已登记进 `test-audit.mjs`；`test-qq-preset-contract` 补新安全规则与画图能力断言；AGENT-TOOLS-AND-PRESETS（45 工具、§2.3 行、§4「快速生图」）、PITFALLS **#85**、CHANGELOG、本文。 |

### 已验证

- `node scripts/test-imagegen.mjs` → **11/11**；`node --check src/{imagegen,bridge,mcp-snowluma-safe}.js` 通过；
  `test-qq-preset-contract` → **8/8**；`build-agent-preset-patches` 重建后 `--check` 一致。
- **真机桥接路由已验**：重启桥接（POST /api/restart → 插件自动拉起）后，
  `POST /api/socialV2/generate-image`（owner 私聊 token）→ `{ok:true, model:"agnes-image-2.5-flash",
  size:"1024x1024", ms:10238, path:"state/generated-images/img-20261101-140557-15b638.png", bytes:1052741}`；
  随即 `POST /api/socialV2/send-image` 把这张图发到 `private:<ownerQQ>`（`{ok:true, messageId:1657025779}`）。
  密钥解析走的是 DSH 凭据文件（config.json 没写 key，证明 fallback 有效）。
- 群聊/别人私聊会被路由 403（代码分支 + preset 文案；未用真群验证）。

### 没验证 / 下一步

1. **`qq_generate_image` 是 MCP 工具，要重启 DSH 才进工具面**（桥接已重启，无需再动）。
   重启后 QQ 私聊说「画一张…」应 ~10~25 秒出图并自动发出（优先走 Agnes；照片级才走 Codex）。
2. 重启后可顺手验证：控制台「二代仿真 → 工具开关」出现「快速画图（Agnes）」开关；
   `qq_get_prompt` 能看到新工具；群里让她画应被拒绝（路由 403）。
3. 成本/隐私：prompt 会发给第三方 Agnes；生成图默认保留 7 天（`socialV2.imagegen.keepDays`）。
   嫌模型/尺寸不合适可改 `socialV2.imagegen.model|size`（agnes 还有 image-2.1/2.0-flash）。
4. 回滚：`git checkout -- src/bridge.js src/mcp-snowluma-safe.js plugins/surfcore/lib/client.js config.example.json`
   + 删除 `src/imagegen.js`、`scripts/test-imagegen.mjs` + revert preset/patch/doc 改动，重启桥接与 DSH。

---

## 快照（2026-11-01 13:1x–13:5x，桌宠记忆 P0/P1/P2：专用注入块 + 叙事上限 300）

### 用户原话

> 「P012都修了吧」

（上一轮结论：桌宠→QQ 记忆完整连通；QQ→桌宠只拿到 QQ 注入块前 2600 字 = 44%，「桌宠（私下相处）」偏移 3189、
「今天聊过的」3417 全在截断外；且叙事层 120 条上限已满，自 10-31 11:14 冻结。）

### 做到哪

| 改动 | 内容 |
| --- | --- |
| P0 专用注入块 | `src/memory-card.js`：`renderMemoryCard(platform:'pet')` + `reorderSectionsForPet()`（顺序：桌宠→今天→和主人→最近→永远不会忘的→叙事尾巴；叙事只占 30% 预算）；新增 `promptPet` 路径，维护器写 `memory-card-prompt-pet.md`；`memoryCardStatus.promptChars.pet` 同口径 |
| P1 去掉硬截断 | `lib/pet-chat.js` `memoryBlock()` 优先读 `prompt-pet`（缺文件回退 QQ 前缀 2600）；`buildChatSystemPrompt` / `lib/pet-purpose.js` 不再 `slice(0,2600/2400)`；预算 = `memoryCard.injectMaxChars.pet`（默认 4200，可配 400–8000） |
| 设置页 | `lib/client.js`：记忆页新增「桌宠 注入上限」+「桌宠 注入预览」+ 路径/预算文案 |
| P2 叙事上限 | `src/memcard-narrative.js` 默认 `maxEpisodes: 120 → 300`；本机 `~/.dsh/surfcore/config.json` 写 `memoryNarrative:{enabled:true,maxEpisodes:300}`（备份 `config.json.bak-20261101-petmem`） |
| 测试 | `test-memory-card`（+2 用例）、`test-memory-card-api`、`test-pet-chat` 均更新；`npm run sync:engine-rev` → `memfix-0a7467c3dc` |

### 已验证 / 没验证

- 真实卡只读渲染：桌宠块 **4198 字 ≤ 4200**，顺序 桌宠(190)/今天(418)/和主人(1180)/最近(1448)/永远不忘(2635)/叙事尾巴(3165, 1033 字)；`status.promptChars.pet=4198`。
- `test-memory-card` 34/34、`test-memory-card-wiring` OK、`test-memory-card-api` OK、`test-pet-chat` OK、`test-core-rev-sync` OK、插件 `npm test` 全绿。
- `npm run test:audit`：**80/88**，8 个红是**本轮之前就存在的环境/门禁问题**（`test-self-identity` / `test-identity-guard` / `test-closure-wiring` / `test-media-search` / `test-voice-system` / `test-preset-local-tools` / `test-agent-preset-patches` / `test-version`；`state/agents/base-test-*.err` 里有 10-31 的同样失败记录），记忆卡相关脚本全绿（`test-memory-card` 在 audit 里也通过）。
- **没验证真机**：DSH 没重启 → 运行中的插件还是旧代码，`memory-card-prompt-pet.md` 还没生成；桌宠下一次对话在 DSH 重启 + 一次维护后才用新块。桥接没重启，但叙事配置每 tick 重读，下一轮 tick 会按 300 压缩（日志应出现「叙事压缩：新增 …」）。
- **未做**：P3（桌宠小节进 QQ 群的隐私边界）不在本轮范围，仍是产品决策。

### 下一步 / 回滚

1. 重启 DSH（插件代码生效）；等桥接下一轮（叙事压缩）。验证：`memory/` 出现 `memory-card-prompt-pet.md`；桌宠里问「昨天/刚才在 QQ 聊了什么」能接上；日志不再有「已达回忆上限（120 条）」。
2. 回滚：`git checkout -- src/memory-card.js src/character-persona.js src/memcard-narrative.js plugins/surfcore/lib/{memory-card,pet-chat,pet-purpose,client}.js`（测试文件同法）；恢复 `~/.dsh/surfcore/config.json.bak-20261101-petmem`；重启 DSH。

## 快照（2026-11-01 12:56–13:0x，看屏幕设置移到「桌宠」页 + 真机回归确认）

### 用户原话

> 「没什么问题，然后把每隔多少时间主动看屏幕加到dsh插件surfcore的设置-桌宠里边」

### 真机确认（上一轮之后用户已完整重启 DSH）

- `DSH 启动 → 自动打开桌宠` 生效：`plugin.log` 有 `[pet] DSH 启动：按设置自动打开桌宠…` / `自动打开成功 pid=45492`；
- 看屏幕走 DeepSeek 生效：`[pet-screen] 视觉调用 834~1072ms，918+42~44 tokens`，判定正常；
- 对话里按需看屏幕生效：`[pet-chat] 对话里看了一眼屏幕：正在用ChatGPT学习KMP算法…`；
- 用户反馈「没什么问题」。

### 做到哪

| 改动 | 内容 |
| --- | --- |
| 设置页位置 | `lib/client.js`：`ScreenWatchCard` 从 `PurposeTab` 移到 `PetTab`（设置 → 桌宠，位于「启动」卡片之后、「安装设置」之前）；`PetTab` 新增 `cfg`/`set`（qq 配置 + setQqPath）参数 |
| 目的页 | 只保留「看屏幕」指路卡片：显示开关状态和当前间隔（`purpose.screen.intervalMin`），按钮「去『桌宠』页设置看屏幕」 |
| 配置位置 | 不变：仍写根 `config.json` 的 `purpose.screen`（和目的页共用一份）；改完点页面底部「保存」 |
| 文案 | 卡片里明确写「开关 / 间隔改完点页面底部『保存』生效」；README/PET/PURPOSE_OUTREACH 同步入口位置 |

### 已验证

- `node --check client.js` 通过；`test-client-contract` / `test-ui-contrast` 全绿。
- 未做浏览器截图验证（无法读本机 GUI）；设置页刷新后应能看到新卡片位置。

### 没验证 / 下一步

1. 设置页是客户端模块：**先在 DSH 里 Ctrl+R / 关掉设置页重开**，若还是旧布局再完整重启 DSH（客户端文件通常随页面加载刷新）。
2. 看到新卡片后确认：「看屏幕」出现在 设置 → 桌宠；里面第二行是「每隔多久看一眼（分钟）」；
   改一下数值 → 点底部保存 → 根 `config.json` 的 `purpose.screen.intervalMin` 应该跟着变。
3. 回滚：把 `ScreenWatchCard` 调用挪回 `PurposeTab`、`PetTab` 的 `cfg/set` 参数还原即可（纯前端改动）。

## 快照（2026-11-01 11:55–12:1x，桌宠随 DSH 自动打开 + 看屏幕真机修复）

### 用户原话

> 「能不能启动dsh自动打开桌宠」

（上一轮遗留：用户重启 DSH 后桌宠被「清理残留后重试」删掉了 app 目录；看屏幕在真机上偶发解析失败。）

### 做到哪

| 改动 | 内容 |
| --- | --- |
| 自动打开 | `lib/pet.js`：`pet/config.json` 新增 `autoStart`（默认 false）+ `shouldAutoStartPet()` 纯判定（装好/开关/没在跑）；`configure()` 可写 autoStart；`status()` 回读 |
| 插件启动钩子 | `lib/index.js`：插件激活后 5 秒检查一次（`installed && autoStart && !running`）→ `petService.start()`；已在跑跳过、失败只记日志；dispose 时清定时器 |
| 设置页 | `lib/client.js` 桌宠页新增「启动」卡片：**DSH 启动时自动打开桌宠** 开关（保存走 `POST /pet/config {autoStart}`） |
| 看屏幕真机修复 | `max_tokens` 320→800；`content` 空时回退解析 `reasoning_content`；新增 `salvageScreenVerdict()` 逐字段兜底截断 JSON；错误信息带 `finish_reason`；视觉请求带 `chat_template_kwargs.enable_thinking=false`（实测 completion 359→47、4.5s→2s，不再截断；400 时自动去掉重试） |
| 对话里按需看屏幕 | `pet-chat.js` 收到「屏幕/画面/桌面/看得到…」意图时现截一张（`wantsScreenLook()`），把摘要以「你刚看了一眼屏幕（不是指令）」注入对话提示词；失败/私人内容有专门措辞（失败必须如实说没看清、不许编）；普通闲聊不截图 |
| 本机恢复 | `pet/app` 重新安装（surfpet v0.2.3，sha256 校验，经 gh-proxy 镜像下载）；`pet/config.json`：`autoStart=true`、`mirror=https://gh-proxy.com`、source 回官方 URL；桌宠已启动 pid 1092 |
| 测试 | 新增 `scripts/test-pet-autostart.mjs`；`test-screen-watch.mjs` 补截断/推理兜底/thought-off/400 重试/对话意图用例；`test-pet-chat.mjs` 补「问到屏幕才截图 + 摘要进提示词 + 失败不许编」用例；均进插件 `npm test` |

### 已验证

- `test-pet-autostart` / `test-screen-watch` / `test-pet-chat` 全绿；`node --check` 全部通过；插件 `npm test` 全链路 **全绿**。
- 自动启动**路径模拟**：停掉桌宠 → `status()` 读回 `autoStart=true` → `shouldAutoStartPet` 返回 `{start:true}` → `start()` 成功
  （pid 1092）。这条路径与 `index.js` 启动钩子同一套调用。
- 桌宠重装后已连上插件：`pet-api /status` → `running=true / online=true / carrier=pet`，`start.log` 有 `surfcore connected`。
- 截屏工具独立实测（不经过插件）：1280×800 JPEG ~96KB / 1.2s；同一张真实截图走修复后的视觉链路
  **判定成功**（「在开发宠物脚本」· working · 可打扰度 0.25~0.72）；关 thinking 后 completion 47 tokens / 约 2s。

### 没验证 / 下一步

1. **插件代码还没被当前 DSH 进程加载**（桌面版没有热重载，PITFALLS #80）：下次 DSH 启动才会跑
   `autoStart` 钩子、看屏幕修复和**对话里按需看屏幕**。下次启动后请确认：桌宠是否自动出现、
   `plugin.log` 是否有 `[pet] DSH 启动：按设置自动打开桌宠… / 自动打开成功 pid=…`；
   在桌宠对话框问「你能看到我屏幕吗」→ 日志出现 `[pet-chat] 对话里看了一眼屏幕：…` 且她能描述当前画面；
   `[pet-screen]` 不再报「没有返回可解析的 JSON」。
   - 实测补充（12:05）：当前 DSH 里有一次插件重载（同进程，`已激活` 日志出现），但 `plugin.log` **没有** `[pet]` 行，
     说明桌面版的「插件重载」没有拿到新模块（ESM 缓存）——**必须完整重启 DSH 进程**才生效，别只做插件开关。
2. 如果下次启动桌宠没自动出现：查 `pet/config.json` 的 `autoStart`、`electronPath` 是否存在、`plugin.log` 的 `[pet]` 行。
3. 回滚：关掉设置页开关（或 `pet/config.json` 里 `autoStart:false`）；代码回滚 `lib/pet.js` / `lib/index.js` / `lib/client.js`
   的对应 hunk + 删 `scripts/test-pet-autostart.mjs`。
4. 对话看屏幕的代价：每次问屏幕多一次视觉调用（约 1.5k prompt + 50 completion tokens），只在意图命中时发生；
   不想让她看就把「目的 → 看屏幕」总开关关掉（对话也会跟着停）。

## 快照（2026-11-01 12:2x，看屏幕视觉端点全换 DeepSeek）

### 用户原话

> 「agnes是在哪配置的，都换成deepseek吧」

### 排查结论

- agnes 出现在 4 类地方：
  ① **SurfCore 看屏幕**：`config.json` 的 `purpose.screen`（本机已写死 agnes 端点和 `AGNES_API_KEY`）、
    插件默认值 `DEFAULT_SCREEN_CONFIG`、设置页卡片默认值；
  ② **DSH web profile**：`~/.dsh/profiles/web/cordis.patch.yml` 的 vision-router `httpProviders`（注意：当前运行的是 **desktop** profile，
    并没有挂 vision-router，所以这条只影响以后用 web profile 的场景）；
  ③ **DSH 凭据**：`~/.dsh/.credentials.yaml` 的 `AGNES_API_KEY`（另外还有 DEEPSEEK_API_KEY 可直接用）；
  ④ **历史记录**：`~/.dsh/surfcore/token-usage-state.json` 的旧用量、plugin.log 旧日志、undo-snapshots——只是历史，不作配置。
- DeepSeek 能不能看图：`GET https://api.deepseek.com/models` 显示 `deepseek-flash`（DeepSeek-V4.1-Flash）
  `input_modalities: ["text","image"]`，`deepseek-v4-pro` 只有 text；用真实截图实测**可以看图**。
- 参数实测（同一张截图）：
  - 默认会推理：reasoning 吃掉 499~800 tokens，甚至 `max_tokens=800` 打满、`content` 为空；
  - `thinking: { type: 'disabled' }` → reasoning 0、completion **38**、耗时 **0.8s**、`content` 直接是 JSON（最优）；
  - `reasoning_effort: 'low'` 和顶层 `enable_thinking:false` **均无效**；
  - Qwen 系兼容端点用 `chat_template_kwargs.enable_thinking=false`（旧 agnes 上实测有效）。

### 做到哪

| 改动 | 内容 |
| --- | --- |
| 默认值 | `screen-watch-core.js` 的 `DEFAULT_SCREEN_CONFIG`：`baseUrl=https://api.deepseek.com`、`model=deepseek-flash`、`apiKeyRef=DEEPSEEK_API_KEY`；`config.example.json`、设置页默认值同步 |
| 本机配置 | `config.json` 的 `purpose.screen` 同样切到 DeepSeek（enabled 仍 true、intervalMin=10） |
| 请求参数 | `screen-watch-service.js` 同时发 `thinking:{type:'disabled'}` + `chat_template_kwargs.enable_thinking=false`；400/422 时去掉两者重试 |
| DSH web profile | `~/.dsh/profiles/web/cordis.patch.yml` 的 vision-router：`agnes/agnes-2.5-flash` → `deepseek/deepseek-flash` + `https://api.deepseek.com` + `DEEPSEEK_API_KEY`（备份 `cordis.patch.yml.bak-20261101T1225`） |
| 测试 | `test-screen-watch.mjs` 更新默认值断言、`thinking` 请求体断言、400/422 重试用例 |

### 已验证

- 端到端（不经过插件）：真实截图 1.15s + DeepSeek 视觉 1.34s → 918+41 tokens → 判定正确
  （「在编辑数据结构 PPT」· working · busy · 可打扰度 0.2 → gate 拦下）。
- `test-screen-watch` / `test-pet-chat` / `test-client-contract` 全绿；`node --check` 全部通过。

### 没验证 / 下一步

1. **仍需完整重启 DSH**（同前：桌面版插件重载拿不到新模块，PITFALLS #80）：重启后看
   `plugin.log` 的 `[pet-screen]`（模型应为 deepseek-flash、用量约 918+41）、对话问屏幕的 `[pet-chat]` 行。
2. `AGNES_API_KEY` 仍留在 DSH 凭据里（当前已无消费者）；要删可以到设置 → 模型/凭据里删，或留着备用。
3. 想换回别的视觉端点：只改 `purpose.screen.baseUrl/model/apiKeyRef` 三个值，代码不用动。

## 快照（2026-11-01 11:00–11:4x，QQ 白名单放行 Codex 画图：subagent_codex + 提示词 + 运行时修复）

### 用户原话

> 「把调用codex的能力加给QQ的白名单工具，告诉ta可以调用codex进行图片生成，并进行一个测试，发送到私聊」

### 排查结论（先分析再动手）

- 白名单落点是 `plugins/surfcore/qq-tool-restrict.mjs`：`subagent_codex` 原来在
  `LOCAL_EXECUTION_TOOLS`（restrict 名单 = 从模型 schema 隐藏），QQ 会话里根本看不见。
- 但**更深一层的问题**：运行中的 DSH 里 `subagent_codex` 压根没注册。运行 runtime 是 **0.2.1-rc.5**，
  profile 装的 `@deepseek-ai/dsh-subagent-codex` 是 **0.2.1-rc.3**（peerDeps 精确钉 rc.3）→
  app-boot 版本门禁判 `incompatible-version`、**整包静默跳过**（`skippedBundles`）。
- 升到 rc.5 后还有第二道门：bundle 自带 `@openai/codex@0.153.4` 的模型目录没有
  `~/.codex/config.toml` 的 `gpt-6.1-sol`（model_not_found）；实测可用模型 `gpt-6-astra`。
  默认 `permissionMode=never` 不传 sandbox，生成图复制到工作区可能被拦 → 改 `approve-for-me`。
- preset/guard 改动**必须重启 DSH**才生效（桌面版无 patch 热重载；preset 行启动时一次性装配，
  guard 走 ESM 缓存）。本轮已完成代码/配置，**未重启**（等用户统一重启）。

### 做到哪

| 改动 | 内容 |
| --- | --- |
| 守卫白名单 | `qq-tool-restrict.mjs`：导出 `OWNER_PRIVATE_TOOL_NAMES`（10 个：pwsh/bash/read/read_image/write/edit/str_replace_editor/glob/grep/**subagent_codex**）；`subagent_codex` 从 `LOCAL_EXECUTION_TOOLS` 移出（不再 restrict 隐藏）→ 模型可见、执行期只放行 `private:<ownerQQ>`；拿不到会话映射仍 fail-closed。**群聊/别人私聊调用一律拒绝。** |
| preset（qq-chat-v2） | 安全规则 1 把 `subagent_codex` 写进「仅主人私聊」清单；规则 2 群友拒绝清单加「用 Codex 画图/生成图片」；**新增第 18 条【用 Codex 画图（仅主人私聊）】**：subagent_codex → 任务写清画面+复制到 `state/agents/codex-images/<短名>.png` + 只回答绝对路径 → `mcp__snowluma__qq_send_image(image=路径)`；生成 1~3 分钟、一次一张、失败如实说。生成物 patch 已重建。 |
| 运行时修复（环境，非仓库） | profile：`@deepseek-ai/dsh-subagent-codex` rc.3→**rc.5**（pluginManager removeBundle→installBundle，pnpm 自动改 lock）；profile `cordis.patch.yml` 给 `- id: subagent-codex` 加 `model: gpt-6-astra` + `permissionMode: approve-for-me`。备份在 `state/agents/codex-qq/backup-profile/`。 |
| 大图发送修复 | `src/bridge.js` `sendImageV2`：SnowLuma OneBot HTTP 请求体硬上限 **2MiB**，base64 会把图放大 4/3 ⇒ 原图 >1.5MB 必然 `fetch failed`。改为本地图 >1.3MB 时 image segment 传 **`file:///<绝对路径>`**（SnowLuma 自己读），失败自动退回 base64 并提示「压缩到 1.4MB 以内」；读盘/图片头/大小校验仍在桥接侧。 |
| 测试 | `test-preset-local-tools.mjs` 改为「双名单」口径（owner-private 不被 restrict + 执行期拒绝；危险名单仍 restrict）；`test-audit-setup-guards.mjs` 加 `subagent_codex` fail-closed 断言；`test-qq-preset-contract.mjs` 钉住新安全规则与画图能力文案；`verify-dsh-020-adaptation.mjs` 改口径（subagent_codex 在 owner 名单、不在 restrict）。 |
| 文档 | `AGENT-TOOLS-AND-PRESETS.md` §2.3（qq_send_image）+ §4（双名单规模 + 「Codex 画图的运行时前提」）；`SECURITY_BASELINE.md` 威胁模型行；PITFALLS **#81/#82**；CHANGELOG。 |

### 已验证

- `node scripts/test-qq-preset-contract.mjs` → **8/8 绿**；`node scripts/test-audit-setup-guards.mjs` → 绿；
  `node --check plugins/surfcore/qq-tool-restrict.mjs`、`node --check src/bridge.js` 通过；
  `build-agent-preset-patches` 重建后 `--check` 一致。
- `node scripts/test-preset-local-tools.mjs` → **6/7**：唯一红是既有基线（repo 内 `node_modules/@deepseek-ai`
  是旧版包，扫不到 0.2.x/浏览器工具名 → 假名对账误报），与本次改动无关（改前 4/7，owner-only 那部分本轮修绿）。
- `verify-dsh-020-adaptation.mjs`（带 `DSH_BASE_URL=http://127.0.0.1:63390`）→ 61 通过/14 失败，
  **两条新断言均 ✅**（`subagent_codex` 在 owner 名单、不在 restrict），14 项失败是既有基线
  （persona 旧字段/版本漂移/profile patch 断言等，与本次无关）。
- `pluginManager`：removeBundle rc.3 成功、installBundle **0.2.1-rc.5** 成功（`application: restart-required`）；
  profile patch 已写入。安装后运行中的 DSH **真的把 `subagent_codex` 注册进了当前会话**
  （工具清单热更新），说明 Host 行热挂载可行；但 QQ preset 的 guard 仍是旧代码，需重启才放行。
- 已用 DSH 自带 codex 0.153.4 + `gpt-6-astra` 跑通「出图」（`state/agents/codex-qq/imgtest/out.png`，
  1254×1254、1.875MB，戴红围巾的鲸鱼坐电饭锅上）；`~/.codex/thread_history_1.sqlite` 的 imageGeneration
  item 含 `savedPath` 字段。
- **真机 QQ 私聊发送（本轮已做）**：桥接重启加载新代码后，用会话 token 走
  `POST /api/socialV2/send-image`（与 `qq_send_image` 同一条桥接路径）
  ① 160KB 缩略图 `{ok:true, messageId:1030232102}`；
  ② 1.875MB 原图 `{ok:true, messageId:-1686756870, bytes:1920363, via:"path"}`；
  ③ 另发了一条说明文字「这张是我用 Codex 画的…」。三条都应出现在主人 QQ 私聊里。
- 桥接已重启回「插件监管」状态（PID 42568，reserved2、SnowLuma connected、单实例）。
- **线上 `subagent_codex` 端到端已实测通过**（队友 codex-probe）：rc.5 + profile 里的
  `model: gpt-6-astra` + `permissionMode: approve-for-me` 在**运行中的 DSH** 里直接可用——
  `subagent_codex` 真出图 → 复制到工作区 → 最终回答只回一行绝对路径（`imgtest/subagent-out.png`，
  1,760,744B、1254×1254，耗时 4.5~5 分钟）。完整证据/命令/失败特征见
  `state/agents/codex-qq/CODEX_IMAGE_PROBE.md`。
- `npm run test:audit` → **80/88**（与 2026-10-31 基线 80/88 相同；失败集合仍是既有 8 条基线红，
  无新增）。定向测试全绿（见上）。

### 没验证 / 下一步

1. **重启 DSH**（一次即可同时应用：本轮的 guard/preset/profile 配置 + 另一会话的桌宠看屏幕代码）。
2. 重启后真机自测：QQ 私聊对 ta 说「用 codex 画一张…发我」→ 应看到 `subagent_codex` 调用（1~3 分钟）→
   `qq_send_image` 把图发到私聊（大图现在走 file://，已不在 2MiB 限制内）。群里让她画应被拒绝/被守卫拦。
3. 若重启后工具还没出现：先查 `pluginManager/listBundles` 里 subagent-codex 的 `rows` 与 `problem`、
   再确认 profile patch 的 `- id: subagent-codex` 生效（`pluginInventory` 应有 `tool-subagent-codex` 行）。
4. 回滚：`git revert` 本轮提交 + 恢复 `state/agents/codex-qq/backup-profile/` 三件套（package.json /
   pnpm-lock / cordis.patch.yml）后重启；guard 白名单回滚只需把 `subagent_codex` 移回 restrict 名单；
   bridge 大图修复回滚 = `git checkout src/bridge.js`（旧行为：>1.5MB 图发不出去）。

---

## 快照（2026-11-01 10:08–11:3x，桌宠「看屏幕」+ 主动搭话载体切桌宠）

### 用户原话

> 「试着给其加上截图屏幕的能力，然后把主动搭话改为桌宠帮我改一下，然后每隔一段时间截图屏幕，根据截图判断是否搭话」

### 做到哪

| 改动 | 内容 |
| --- | --- |
| 新增截图 | `plugins/surfcore/lib/screen-capture.js`：PowerShell 5.1 + System.Drawing，DPI 感知、多显示器虚拟桌面、下采样 JPEG；失败返回结构化错误 |
| 纯逻辑 | `plugins/surfcore/lib/screen-watch-core.js`：配置归一 / 视觉提示词 / JSON 解析 / 门控（私人内容·游戏·视频·会议·可打扰度）/ 提示词小节 / 状态摘要 |
| 视觉服务 | `plugins/surfcore/lib/screen-watch-service.js`：节流（`intervalMin`）+ 同画面哈希缓存（2×间隔）+ `ctx.credentials.resolve(apiKeyRef)` 取密钥 + OpenAI 兼容 HTTP + token 额度「其他」记账 + 失败 fail-open |
| 接线 | `pet-purpose.js`：tick 定时看屏幕；出发前用门控拦；通过时摘要进提示词；模型只回 `SILENT` 记为「她选择没说」；`status()/preview()` 带 screen；`index.js` 创建服务 + `GET /purpose/screen`、`POST /purpose/screen/look` |
| 设置页 | `client.js` 目的页新增「看屏幕再决定要不要搭话」卡片（开关 / 间隔 / 重试 / 模型 / 阈值 / 失败放行 / 保留截图 / 现在看一眼 + 最近一次结果） |
| 配置 | 本机 `config.json`：`purpose.carrier=pet`、`petModality=text`、`purpose.screen.enabled=true`（默认 10 分钟）；`config.example.json` 补默认块 |
| 测试 | `scripts/test-screen-watch.mjs`（纯逻辑 47 项 + 注入式服务测试 13 项，不联网）接进插件 `npm test` |
| 文档 | `PET.md`（看屏幕一节）、`PURPOSE_OUTREACH.md`（配置表 + 看屏幕一节）、`CHANGELOG.md`、`PITFALLS.md` #79/#80、本文 |

### 已验证

- `node plugins/surfcore/scripts/test-screen-watch.mjs` 全绿；`test-pet-chat` / `test-client-contract` /
  `test-store` / `test-http-guard` / `test-pet-api` / `test-pet-dir-guard` / `test-host-smoke` 全绿。
- 真机单独验证（不经过插件）：截图 1707×1067 → 1280×800 JPEG（~147KB / 1.1s）；
  同一张截图走 agnes 视觉接口返回正确 JSON（`activity=working`、`interruptible=0.2`）+ usage 记账（1.4~3.2s）。
- 插件 `npm test` 见本次收尾日志（背景任务）。

### 没验证 / 下一步

1. **必须重启 DeepSeek Harness 桌面应用**才生效：桌面版没有 patch 热重载（PITFALLS #80）；
   我在探测热重载时用 plugin-manager 网关 disable 过 surfcore，**当前插件处于未装载状态**，
   重启后会按 `package.json` 的 bundles 重新装载（`cordis.patch.yml` 已恢复、无 disabled 行）。
2. 重启后请复看：设置 → 目的 → 「看屏幕」卡片能打开；点「现在看一眼」拿到摘要；
   `plugin.log` 出现 `[pet-screen] …`；桌宠气泡在合适的时机主动搭话（不是每次截图都说话）。
3. 关掉/回滚：目的页把「启用看屏幕」关掉 → 立即回到纯排程；载体切回 QQ 即恢复旧链路；
   代码回滚 `git checkout -- plugins/surfcore/lib/{screen-capture,screen-watch-core,screen-watch-service}.js ...`
   （新文件）并还原 `pet-purpose.js` / `index.js` / `client.js`。
4. 成本：每张截图约 1~1.5k prompt tokens，默认 10 分钟一次（安静时段不截）；嫌贵把 `screen.intervalMin` 调到 30。



### 用户原话

> 「群聊和私聊的记忆、对话什么的似乎完全分隔？……我的理想设计是记忆共同，但是分清场合，也即明确发送会话，选择不同模式。」
> 之后拍板：「A吧，然后 style-notes 什么叫没有作用域，我觉得这个还挺重要的。记忆共通，长期卡+摘要应该完全足够了。
> 在私聊里主动往群里发做一个受控。按场合档位即可。补文档+测试。」

### 排查结论（先分析再动手）

- 对话（DSH 会话、未读、唤醒/收尾）严格按 QQ 会话 key 分开；**记忆不是**：人格卡、衰减记忆卡、style-notes、
  B站简报、表情/黑话是整角色/整账号一份；三代轻记忆按 key 各存一份，注入时做读侧合并。
- 真正的缺口：① 场合只有 `[私聊]/[群里]` 渲染标签 + 一段软提示，不是可见性边界；② 没有「规矩」通道与作用域
  （私聊立的规矩只能变一条会遗忘的记忆，或全局 style-notes）；③ 发送被 agentToken 绑死当前会话，无法「明确发送会话」；
  ④ 模式是全局四档位，没有「场合档位」；⑤ style-notes 不分场合、只进 reserved2 首屏。
- 分清场合的硬要求被确定为：**记忆共同（长期卡+摘要共享，不共享另一端原始对话）**，但「规矩/说话习惯/记录可见性」
  必须结构化作用域；跨场合只开放「私聊 → 白名单群」一条受控通道。

### 做到哪

| 改动 | 内容 |
| --- | --- |
| 新增 `src/scene-scope.js` | 纯函数唯一实现：规矩 scope（global/private/group/group:<id>/here）、style-notes 作用域解析/过滤、场合档位解析与场合卡、记忆卡 audience 过滤、跨场合发送配置/目标/频率 |
| 轻记忆 `rule` 类别 | `qq_memory_append(category='rule', extra.scope=…)`；写入去重、上限 50、here 落成具体场合；`formatMemoryV2` 按当前场合注入；`formatSharedMemoryV2`/memory 查询只跨场合共享 global；update/remove/clear 同步支持 |
| style-notes 作用域 | 行格式 `- 日期 [全局|私聊|群|群:123] 文本`（旧行无前缀=全局）；API POST 加 `scope`；GET `?key=` 返回过滤后注入块；唤醒提示词/qq_get_prompt 按场合过滤；`memctl` 支持 `--scope` |
| 记忆卡 audience | 记录新增可选 `audience: any/private-only/group-only`（默认 any）；渲染成 `[仅私聊可见]/[仅群可见]`；桥接注入时按场合过滤；`socialV2.memoryScene.groupExcludePrivate=true` 可让群聊连 `[私聊]` 记录也过滤（默认关=记忆共同） |
| 场合档位 | `socialV2.scenes.defaultPrivate/defaultGroup/overrides`；唤醒提示词顶部注入【场合】卡（含群名缓存、语气提示、私聊边界守卫）；`qq_get_prompt` 也返回 scene 卡 |
| 受控跨场合投递 | 新端点 `POST /api/socialV2/send-cross` + MCP 工具 `qq_send_cross_scene`：仅 reserved2、仅主人私聊发起、目标必须同时命中 `allow.groups` 与 `socialV2.crossSceneSend.allowTargets`、开关默认关；过敏感信息/身份闸/长度/每小时频率/token 回合额度/静默/鱼群；回执记进目标会话 recentMessages，桥接代投不向模型发目标 token |
| 配置/文档 | `config.example.json` 加 `socialV2.scenes` / `memoryScene` / `crossSceneSend` / `tools.crossSceneSend`；RULES/MEMORY_CARD/DATA-AND-CONFIG/MODULE-BRIDGE/ARCHITECTURE/AGENT-TOOLS-AND-PRESETS/PITFALLS/ROADMAP/CHANGELOG 同步 |
| 测试 | 新增 `scripts/test-scene-scope.mjs`（纯函数 12 项）与 `scripts/test-scene-wiring.mjs`（真实 bridge + 夹具网关 7 项：场合卡/style-notes/规矩/记忆卡过滤/跨场合投递全闸门/静态接线），已接进 `test:audit` |

### 已验证

- `node scripts/test-scene-scope.mjs` → **12/12**；`node scripts/test-scene-wiring.mjs` → **7/7**；
  `node --check src/{scene-scope,bridge,memory-card,mcp-snowluma-safe}.js` 通过；`npm run sync:engine-rev` 已 bump，
  `node scripts/test-core-rev-sync.mjs` 通过。
- 相关既有回归：`test-memory-card` 32/32、`test-memcard-narrative` 14/14、`test-v2-initial-prompt` 全过、
  `test-audit-regressions` 全过、`test-qq-self-expression` 22/22、`test-mcp-servers-stdio` 全过、`test-qq-preset-contract` 8/8。
- `npm run test:audit` → **80/88**（基线 78/86；新增 2 个测试后脚本总数 88；失败集合仍是同一组 8 条既有基线红：
  `test-self-identity` / `test-identity-guard` / `test-closure-wiring` / `test-media-search` / `test-voice-system` /
  `test-preset-local-tools` / `test-agent-preset-patches` / `test-version`，**无新增**）。

### 没验证 / 下一步

1. **要重启桥接 + DSH** 才在真机生效：`src/bridge.js` / `memory-card.js`（插件侧走 `?rev=`，需重启 DSH 或热重载插件）、
   MCP 工具描述（DSH 重启后模型才看到 `qq_send_cross_scene`）、`config.example.json` 的新键（仓库 config.json 可手动补）。
2. 真机复看（未做）：私聊里说「记住：群里别发路径」→ `qq_memory_append(category='rule', extra={scope:'group'})` 是否自然；
   群里是否不再提私聊私事；把 `crossSceneSend.enabled=true` + allowTargets 配上后，让她带一句话到群是否只发一条。
3. 回滚：桥接侧全是**新增/加参数**，旧 config 不配新段时默认关闭/不过滤；`git revert` 本提交 + 重启桥接/DSH 即可。
4. 记忆卡记录级 audience 目前只有「手工编辑 memory-card.json / 后续控制台」能赋值；模型侧场合约束走 rule，不要在
   自动 ingest 里加启发式（误判会把该共享的记忆藏掉）。


## 快照（2026-10-31 17:06–17:35，黑话提交去掉限制：遇到没把握的词就直接提）

### 用户原话

> 「把黑话提交的限制去掉」

### 排查结论（先分析再动手）

- 限制分三层：① preset 第 9 条「未收录且**多次出现才** qq_slang_submit，可附语境，**不重复提交**」；
  ② 桥接 `allowSlangSubmit()` 每会话限流 **2/分钟、10/小时**，超了回 429「黑话提交过于频繁，请稍后再试」；
  ③ MCP 工具描述写成「在群里**经常看到**但不确定含义的…提交」，等于告诉模型「偶尔看到的小词别提」。
- 保留的闸门（不是频率限制）：模式/会话令牌/`socialV2.tools.slangSubmit`/`slang.enabled`、词条 ≤50 字、
  同词重复提交合并计数、管理员拒绝过的词不再收、黑话学习会话的 token 额度闸。

### 做到哪

| 改动 | 内容 |
| --- | --- |
| preset（qq-chat-v2） | 第 9 条改成「看到/听到没把握的词先 qq_slang_query，查不到或不确定就**直接 qq_slang_submit 提交候选词**，可附原话语境——不用等它出现多次，也不用攒着」 |
| MCP 工具描述 | `qq_slang_submit` 去掉「经常看到」前置条件，改成「看到/听到没把握的词就直接提交，不用等它反复出现」 |
| 桥接 | 删除每会话提交限频：`slangSubmitTimes`（内存 map）、`allowSlangSubmit()`、路由 429 拦截，以及 5 处 map 清理调用 |
| 测试/文档 | 新增 `scripts/test-slang-submit.mjs`（3 项：限频已删 / 闸门仍在 / preset+MCP 鼓励直接提交）并接进 `test:audit`；`test-qq-preset-contract` 补断言；patch 已重建；PITFALLS 新条目、CHANGELOG、`RULES.md`（含上一轮未同步的安全不变量清单）、`MODULE-BRIDGE`、`AGENT-TOOLS-AND-PRESETS` 同步 |

### 已验证

- `node scripts/test-slang-submit.mjs` → **3/3**；`node scripts/test-qq-preset-contract.mjs` → **8/8**；
  `node --check src/bridge.js` 通过；`build-agent-preset-patches --check` 产物一致。
- `npm run test:audit` → **78/86**（基线 74/85；新增 `test-slang-submit` 后脚本总数 86；
  失败集合仍是那一组 8 条既有基线红：`test-self-identity` / `test-identity-guard` / `test-closure-wiring` /
  `test-media-search` / `test-voice-system` / `test-preset-local-tools` / `test-agent-preset-patches` /
  `test-version`，**无新增**）。

### 没验证 / 下一步

1. **要重启桥接**（限流/429 已删）与 **重启 DSH**（MCP 描述 + preset 装配）才在真机生效。
2. 真机复看（未做）：群里出现新梗/缩写时她会不会直接提交；控制台「黑话词库」候选是否变多。
3. 回滚：`git revert HEAD` 后重启桥接。

## 快照（2026-10-31 16:45–17:10，表情包软策略改为「审时度势」：允许纯表情回复 + 鼓励盗图）

### 用户原话

> 「插件似乎限制让agent不要老发表情，改为允许只用表情回复，鼓励盗图和发表情，自己审时度势即可」

### 排查结论（先分析再动手）

- 限制不在任何代码闸门，而在**三处软策略措辞**：reserved2 preset 第 14/15 条（`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`）、
  桥接每轮注入的 `buildStickerStrategyHint()`（`src/sticker-lib.js`）、`buildStickerMatchHint()` 高分措辞（`src/sticker-semantics.js`）、
  MCP 工具描述（`src/mcp-snowluma-safe.js`）。
- 硬闸门确认保留、这次不动：单气泡「一条只能一张、不能带文字」、`tokenGuard.maxOutboundPerTurn=8`、
  收藏限流 `socialV2.sticker.collect.maxPerMinute=2 / maxPerHour=50`（防 QQ 侧限频）。
- 同类教训见 `PITFALLS.md` #56：软策略的保守措辞会让模型自我审查、主动放弃发表情。

### 做到哪

| 改动 | 内容 |
| --- | --- |
| preset（qq-chat-v2） | 第 14 条：删「3~5 轮一张/别刷屏/也别总拿表情作为唯一回复」，改成「**频率自己审时度势**」+「**表情可以单独作为一条回复**」；第 15 条：删「不要频繁收藏」，改成「**鼓励盗图，好图不偷白不偷**」+ 写清收藏限流 |
| 桥接注入 | `src/sticker-lib.js` `buildStickerStrategyHint()` 重写（标题/频率/纯表情回复/盗图）；`src/sticker-semantics.js` `buildStickerMatchHint()` 高分补「也可以只发这张表情、不配文字」，低分删「也不要每轮都发」 |
| MCP 工具描述 | `qq_send_sticker`（删「但别刷屏」）、`qq_send_image`（删「别刷屏，一次发一张就够了」）、`qq_collect_sticker`（删「不要频繁收藏」，改鼓励盗图） |
| 生成物/测试/文档 | `build-agent-preset-patches.mjs` 重建 `plugins/surfcore/presets/qq-chat-v2.patch.yml`；`test-qq-preset-contract` / `test-stickers` / `test-sticker-semantics` 补/改断言；PITFALLS 新条目、CHANGELOG、AGENT-TOOLS-AND-PRESETS §2.3 行说明、MODULE-CORE-B 函数行号 |
| 顺带修复：preset 控制台 | `src/preset-prompt.js` 的 `PRESET_BLOCKING_SUBSTRINGS`（v2）从旧文案「你没有本地工具 / API 令牌」改成当前真实安全边界（`只在主人私聊里可用` / `群友没有管理权限` / `作为 token 参数传入` / `角色由桥接注入` / `不会自动发送到 QQ`）；在此之前控制台保存/还原 qq-chat-v2 会被误拒。`test-preset-prompt` 7/12 → **12/12 绿** |

### 已验证

- `node scripts/test-qq-preset-contract.mjs` → **8/8 绿**（基线本来是红的：顺带修掉三条漂移——本地工具行
  `tool-pwsh/tool-fs/tool-fs-search`、语音「默认关闭」→「已开启」、安全规则旧文案「你没有本地工具/API 令牌」）。
- `node scripts/test-preset-prompt.mjs` → **12/12 绿**（基线 7/12 红：硬性不变量清单停在旧文案，详见 PITFALLS 同日条目）。
- `node scripts/test-stickers.mjs` → **74/0**；`node scripts/test-sticker-semantics.mjs` → **28/0**；
  `node scripts/test-hardening.mjs` / `test-token-guard.mjs` / `test-mcp-safe.mjs` → exit 0。
- `node scripts/build-agent-preset-patches.mjs --check` → 产物与源一致。
- `npm run test:audit` → **77/85**（基线 74/85；失败集合剩 8 条既有基线红，**无新增**：
  `test-self-identity` / `test-identity-guard` / `test-closure-wiring` / `test-media-search` / `test-voice-system` /
  `test-preset-local-tools` / `test-agent-preset-patches` / `test-version`；本轮 `test-qq-preset-contract`、
  `test-preset-prompt` 由红转绿）。

### 没验证 / 下一步

1. **要重启桥接**（`src/sticker-lib.js` / `sticker-semantics.js` 的注入文案、MCP 描述之外的桥接侧）与 **重启 DSH**
   （MCP 工具描述 + preset 装配）才在真机生效；重启 DSH 会中断当前 GUI 会话，由主人决定时机。
   正在进行的 QQ 会话也可 `POST /api/session/reset` 换新 preset。
2. 真机复看（未做）：发一张表情、只发表情不配文字、看到好图收藏——三件事是否自然发生。
3. 回滚：`git revert HEAD` 后重启桥接；或控制台 preset 编辑器把 14/15 条改回（保存会写仓库源文件 + 重建 patch，
   新会话生效）。

## 快照（2026-10-31 12:40–13:05，QQ 自身资料动作：改个性签名 / 发 QQ 空间说说）

### 用户原话

> 「看看surfcore有没有改个性签名、发QQ动态的接口，如果没有，看看snowluma是否有，有就接上」

### 排查结论（先分析再动手）

- surfcore 原本**没有**这两个接口（全仓搜 `qzone|longNick|说说|个性签名` 只命中无关文案）。
- SnowLuma **有**：本机运行时 `1.14.5-node` 里 `set_self_longnick`（`C:\Users\32372\SnowLuma\config-Bgjda8Pc.js:8038`）
  与 `send_qzone_msg`（同文件 `:8826`）都实现了；`_snowluma-catalog.json` / `@snowluma/mcp` 的 catalog 是
  SDK **1.14.20 构建期快照**（比运行时新，但这两个动作一致）。
- 坑（已写进 `PITFALLS.md`）：`get_qzone_msg_list({})` 在账号没有说说时返回 `retcode 100「响应结构异常」`，
  **不能**当「动作没实现」或「发布成功」的判据；`set_self_longnick` 严格 string，空串可以清空签名，
  但紧接着连续改第二次会 OIDB 999（QQ 侧频率限制，隔几秒重试即可）；改签名会自动同步一条
  `is_private: true` 的空间说说，善后要「清签名 + 删同步说说」两步。

### 做到哪

| 改动 | 内容 |
| --- | --- |
| `src/bridge.js` | 两个 POST 路由 `/api/socialV2/set-signature`、`/api/socialV2/send-qzone`；权限链照 `set-group-card`（仅 reserved2 + 会话 token + `socialV2.tools` 开关 + 暂停）；额外过 `SENSITIVE_RE` + `src/identity-guard.js` 两道闸；签名 ≤120 字（空串=清除）、说说 1~1000 字 + `visibility` friends/all/self→4/1/64（v1 不支持 16/128 与图片）；两处 `socialV2.tools` 默认表加 `setSignature` / `sendQzone`（默认 true）+ POST config 的 toolFlags 同步 |
| `src/mcp-snowluma-safe.js` | 新工具 `qq_set_signature`、`qq_send_qzone`（`TOOL_CONFIG_FLAGS` 注册期开关 + 与 `qq_set_group_card` 同模式的注册块） |
| 控制台/配置/插件 | `public/console.html` 两个 `data-v2-tool` 开关；`config.example.json` 两个 key；`plugins/surfcore/lib/client.js` 两个中文标签 |
| `scripts/audit-bridge-harness.mjs` | 补 `FakeBot.raw`（原来夹具缺它，把「bot.raw 不存在」的 fail-open 路径掩盖了）+ `set_self_longnick` / `get_stranger_info` / `send_qzone_msg` / `get_friend_list` 桩 + `calls.longNick` |
| 测试 | 新增 `scripts/test-qq-self-expression.mjs`（22 项：两路由全部闸门 + 静态接线），已接进 `scripts/test-audit.mjs` |
| 文档/preset | 二代 preset 第 17 条「她自己的资料与空间」（`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`，bundle patch 已重建）；`RULES.md` 硬边界第 5 条；`PITFALLS.md` 新条目；`docs/guides/AGENT-TOOLS-AND-PRESETS.md`（39→41 个工具 + §2.4）；`SECURITY_BASELINE.md` §3 一行 |

### 已验证

- `node scripts/test-qq-self-expression.mjs` → **22/22 绿**。
- `npm run test:audit`（最终第 3 轮）→ **74/85**（改前 72/84）。失败集合与改动前基线**完全一致**（11 条既有基线红：
  `test-self-identity` / `test-identity-guard` / `test-closure-wiring` / `test-qq-preset-contract` /
  `test-preset-prompt` / `test-audit-regressions` / `test-media-search` / `test-voice-system` /
  `test-preset-local-tools` / `test-agent-preset-patches` / `test-version`）。
  本轮顺带把 `test-purpose-wiring` 由红转绿：补 `FakeBot.raw` 后暴露夹具缺 `get_friend_list`（目的机制投递前查好友），已补桩。
- **真机 E2E（用户批准，已回滚）**：直连 SnowLuma——改签名→回读一致→清空（第二次立刻改会 OIDB 999，隔 5s 重试成功）；
  发一条 `ugc_right=64`（仅自己可见）测试说说→拿 tid→删掉；改签名自动同步的那条私有说说也删掉；
  最终签名回到空串、空间无残留。
- **2026-10-31 13:01 已重启桥接并跑真实路由**（新 PID 46252；mode=reserved2、dshReady=true、SnowLuma connected）：
  `POST /api/socialV2/set-signature` → `{ok:true, verified:true}`；`POST /api/socialV2/send-qzone` → `{ok:true, data:{tid,time}}`；
  两者都已回滚。`state/bridge.log` 有「工具改个性签名 … verified=true」「工具发QQ空间说说 … ugc_right=64」两行。

### 没验证 / 下一步

1. **要重启 DSH**：QQ 会话里的模型才看得到新的 `mcp__snowluma__qq_set_signature` / `qq_send_qzone`
   （MCP 进程由 DSH 启动时拉起）；同时把新 preset 第 17 条同步进 `~/.dsh/.agent-presets/qq-chat-v2/`
   （设置页保存一次或跑 `scripts/setup-dsh.mjs`）。重启 DSH 会中断当前 GUI 会话，由主人决定时机。
2. 控制台 UI 上两个新开关只做了静态断言，没肉眼点过（位置在「二代仿真 → 工具开关」里 `qq_set_group_card` 下面）。
3. 重启桥接已见现象：插件 supervisor 报「12 秒未监听」是误报，实际约 30s（state/ 6.9GB + icacls 超时），别连点重启。
4. 回滚：`git revert HEAD`（本轮 commit = `feat(qq): 接上改个性签名 / 发 QQ 空间说说`）+ 重启桥接；或只关控制台里 `setSignature` / `sendQzone` 两个开关（重启 DSH 生效）。

---

## 快照（2026-10-31 09:30–10:30，语音「合成超时」修复：错误分类 + 150s 预算）

### 用户原话

> （2026-10-30 23:22/23:29 两次发语音都报「合成超时（>60s）」，AI 改文字）→ DSH 里只有一句「修复语音功能」。

### 现象与根因（完整复盘 `docs/cases/2026-10-31-voice-tts-timeout.md`，只读诊断 `state/agents/voice-fix/DIAGNOSIS.md`）

- 直接原因：`tts.timeoutMs` 默认 60s，那两次引擎侧实际用了 **126.4s / 70.0s**，客户端先放弃。
- 环境原因（**不是 GPU**）：本地 GSV 是 **CPU 推理**（`.venv-gsv` 的 torch 是 `2.5.1+cpu`、
  `tts_infer.yaml: device: cpu`）；主人自己的「犬类项目」重训流水线（22:46–00:19，峰值 7~8 个 python）
  把 CPU 调度/内存压满，GSV 整段请求只拿到 0.24~0.61 core，三阶段同步劣化 5~30 倍。
  GPU 故障期只有 12~28%、显存 4.1/8.1GB、无热降频。训练 **00:19:29 全部结束**后同一探针立刻回到 9~17s。
- 代码放大缺陷：`voice-tts.js` 只抛 `Error(message)` 没有 `code/statusCode`，`bridge.js` 用中文正则
  `/语音合成|TTS/` 猜状态码 → 超时文案不含这两个词 → **HTTP 400**（§10.6 #5）。
- 附带发现：客户端放弃后 voxd 合成**不会停**（`/v1/speak/file` 无 finally cancel、GSV 阻塞 urllib），
  继续占单 worker；`/v1/stop` 无 job_id 会取消 active+全部 queued（误伤桌宠）且对单句中段无效；
  `/v1/speak/file` 完成前拿不到 `X-Job-Id`，精确取消要改流式（Phase 2）。

### 做到哪

| 改动 | 内容 |
| --- | --- |
| `src/voice-tts.js` | 新增 `ttsFailure(message, code, statusCode)`；空文本 400 / 超时 `TTS_TIMEOUT` 504 / 连不上 `TTS_UNAVAILABLE` 502 / voxd 非 2xx `TTS_HTTP_ERROR` 502 / 空音频 502 |
| `src/bridge.js` | 新增 `voiceSynthError()` 统一分类（优先 `statusCode`，中文只兜底旧错误）；AI/操作者两路由改用它；AI 5xx 文案追加「请改回打字，不要重试」；`synthesizeVoiceText` 记耗时/失败日志；修 `voiceTriggerBlock` 的 `last` ReferenceError（R37） |
| `config.json` | `socialV2.voice.tts.timeoutMs` 60000 → 150000（**本机运行值**；改完要重启桥接） |
| 测试 | `scripts/test-voice-tts.mjs` 增 ⑧（超时结构化）⑨（连不上）⑩（voxd 503 detail）；新增 `scripts/test-voice-route-errors.mjs`（超时→504、引擎→502、旧错误按文案→504、超字数→400、失败不发消息）；已登记 `test-audit.mjs` + `npm run test-voice:errors` |
| 文档 | `docs/cases/2026-10-31-voice-tts-timeout.md`（新）、`docs/cases/README.md`、`PITFALLS.md` 新条目、`SUBSYSTEM-VOICE.md` §4.3/§4.4/§10.2/§10.6/config 表、`AGENT-TOOLS-AND-PRESETS.md` 排障行、`CHANGELOG.md` |

### 已验证

- `node scripts/test-voice-tts.mjs` → exit 0；`node scripts/test-voice-route-errors.mjs` → exit 0。
- 既有语音测试：`test-voice.mjs` 83/0、`test-voice-route.mjs` ok、`test-voice-edge.mjs` 12/0、
  `test-voice-volume.mjs` 14/0、`test-voice-gui.mjs` 20/0、`test-voice-packs-default.mjs` ok；
  `test-voice-system.mjs` 44/1（既有基线红：preset 文案「默认关闭」drift，与本次无关）。
- 引擎侧（训练结束后、未重启任何服务）：`/v1/health` ok / 队列空；直探 7 字 8.6~11.6s；
  桥接 dry-run `node scripts/voice-send-test.mjs --key private:<owner>` → 预演通过（不发消息）。
- **2026-10-31 10:29 已重启桥接并验证新代码生效**：用插件自己的 `stop→start`（等同设置页「重启桥接」）重启后，
  `bridge.log` 出现 `[voice] TTS 合成完成 13809ms（12 字）`（旧代码没有这行），dry-run 预演通过；
  模式恢复 **reserved2**、SnowLuma 已连接、单实例（PID 44752 / 端口 3100）。
  ⚠️ 重启时插件 supervisor 报「启动后 12 秒仍未监听控制台端口」，**实际约 30 秒后才起来** ——
  原因是 `state/` 现在 6.9GB（voice-packs 6.8GB），启动时 `hardenStateDirAcl()` 的 `icacls /T` 30s 超时；
  别因为这句报错连点重启（端口检查会挡双实例，但会白等）。见 PITFALLS 新条目。
- **没验证**：真机 QQ 语音发送（重启后没有替主人发测试语音——对外发送需授权；请主人在 QQ 里让她发一条，
  或授权后用 `node scripts/voice-send-test.mjs --key private:<owner> --yes`）；
  MCP 层的状态码/工具说明改动（要 DSH 重启，本轮故意没动，见下）。

### 没做 / 下一步

1. ~~重启桥接~~（已完成，见上）；主人侧待办：QQ 里发一条语音确认 `verified=true`。
2. MCP 层（`src/mcp-snowluma-safe.js`）透传 HTTP 状态码 + 工具说明第⑤条补「504/合成超时」分支 +
   preset 文案同步（`plugins/surfcore/presets/*.patch.yml` 防漂移测试）——需要 DSH 重启，下一轮做。
3. **启动慢（12s supervisor 误报）**：`state-acl.mjs` 的 `icacls` 默认 30s 超时 + `state/` 6.9GB →
   重启要 ~30s；建议（未做）：ACL 收紧跳过 `voice-packs/` 等大目录 / 或插件 `start()` 等待放宽到 40s /
   或把 `state/voice-packs` 挪出 state 统一 ACL 范围。属独立小修。
3. **可选・语音提速（真正根治，需拍板）**：给 `.venv-gsv` 换 cu128 torch（RTX 5070 是 sm_120，
   当前 `torch 2.5.1+cpu` 根本用不了 GPU），预期 1~3s/句；代价 ~3-5GB 下载 + GPT-SoVITS 兼容性验证，
   建议新开隔离 venv，失败保留 CPU 环境回退。**风险：8GB 显存 + 桌宠/浏览器共用**。
4. **可选・Phase 2**：`/v1/speak` 流式改造（拿 `X-Job-Id`、客户端断开自动 cancel、可精确 `/v1/stop`）。
5. 既有基线红（`test-voice-system` 1 条、`test-preset-local-tools`/`test-agent-preset-patches`）与本轮无关，
   建议单开一轮修。
6. 回滚：`git revert <本轮 commit>` + `config.json` 的 `timeoutMs` 改回 60000 + 重启桥接。

---

## 快照（2026-10-30 20:45–21:05，QQ 会话工具白名单放行梗记忆）

### 用户原话
> 「写进QQ会话工具白名单」

### 做到哪
- `plugins/surfcore/qq-tool-restrict.mjs`：新增导出 `MEMEWIKI_TOOL_NAMES`（`search_meme_wiki` /
  `meme_recall` / `meme_feedback` / `meme_remember`），在执行期 guard 放行，**故意不进** `RESTRICTED_TOOL_NAMES`。
- 测试：`test-preset-local-tools.mjs`（导出 4 个 / 放行 / 不在 restrict）、`test-audit-setup-guards.mjs`（四个名字放行）。
- 文档：`docs/guides/AGENT-TOOLS-AND-PRESETS.md` 名单表 + 第三方插件工具说明；`docs/PITFALLS.md` 新增条目；CHANGELOG 未发布/新增。
- 为什么必须显式维护：QQ 守卫 fail-closed，且第三方插件工具不在 DSH 安装包里，对账扫不到（见 PITFALLS 新条目）。

### 已验证
- `node scripts/test-audit-setup-guards.mjs` → exit 0（四个梗记忆工具在 QQ 白名单里放行）。
- 独立脚本直接 import 守卫验证行为：4 个名字放行；`pwsh`/`read`/`web_fetch`/未知工具名仍被拒；
  4 个名字都不在 `RESTRICTED_TOOL_NAMES`。
- 全量 `npm run test:audit`：**改动前（git stash 后）与改动后都是 72/83，11 项失败清单完全相同**
  ⇒ 非本次引入。其中 `test-preset-local-tools` / `test-agent-preset-patches` 是既有基线红
  （2026-10-29 本地工具改 owner-only 后，测试旧期望未同步）；本次新增的三条断言要等该脚本变绿才会执行。
- 定向复跑：`test-preset-local-tools`、`test-agent-preset-patches` 改动前后失败数一致（4 pass / 3 fail、1 项失败）。

### 没验证 / 下一步
- 真机 QQ 会话要重启 DSH（desktop profile）后，让模型调一次 `meme_recall` / `search_meme_wiki` 确认放行。
- desktop profile 的 `node_modules/surfcore` 是指向 `~/.dsh/plugins/surfcore` 的 junction（后者再指回本仓库），
  仓库改完重启即生效，无需重跑 setup（preset yml/patch 未变）。
- 既有基线红（上述 2 个安全测试的旧期望）建议另开一轮修：要么把 owner-only 本地工具从「restrict 隐藏」
  名单语义里剥离、测试随之改，要么恢复旧设计——属安全边界口径变更，需要主人拍板，本次不擅自改。

---

## 快照：2026-10-30 20:12–20:45（路线 A：B站 会话直连原生分镜工具，本机专用）

### 用户原话

> 「路线A指什么」→ 解释 C-1/路线 A 区别后：「只在自己机器用，你动手吧」

### 做到了什么

| 改动 | 内容 |
| --- | --- |
| `watch-storyboard --download-only` | 只下载 720p mp4 + 拉官方字幕，打印 `MP4:` / `SUBS:` 两个路径后退出；**不写观看历史**（准备素材，真正"看"是下一步原生工具） |
| 唤醒 prompt（`lib/scheduler.js` step 4） | 按工具面自适应：有 `video_storyboard` → ①`--download-only` ②`video_storyboard({input:<MP4>, transcriptFile:<SUBS>, cells:9})` ③细节 `video_zoom({input, cellId:N, cells:4})`；没有 → 退回 C-1 的 `watch-storyboard <BV>` 出图 |
| QQ 守卫（`qq-tool-restrict.mjs`） | 新增 `PLUGIN_PROVIDED_GLOBAL_TOOLS`（video_storyboard/video_zoom/video_probe/video_locate），在 `apply()` 里照样 restrict；**故意不导出**到 `RESTRICTED_TOOL_NAMES` —— 第三方插件名不在 DSH 安装包里，导出会让 `test-preset-local-tools` 的「假名对账」误报 |
| 测试 | `test-watch-storyboard.mjs` 增加 `--download-only` 解析 + `downloadOnlyLines` 断言 |

### 已验证

- 真机路线 A E2E：`watch-storyboard BV1w7HM6JEGa --download-only` → MP4/SUBS 两路径（exit 0）；
  本会话（standard preset，与 bili-whale 同 preset）对同一 MP4 调 `video_storyboard(transcriptFile=官方字幕 JSON)`
  → 9 格 1009×620 + 字幕对齐清单；`video_zoom({cellId:4})` → 正确 **30.00–34.60s**、2 格高清。
  图 sha256 与 C-1 CLI 版一致（`d4616002…`）。
- `test-watch-storyboard.mjs` 全绿；5 个改动文件 `node --check` 通过。
- 门禁：`cd plugins/surfcore && npm test` → **exit 0**。
- 全量 `npm run test:audit`：**改前/改后各跑一遍并逐脚本对账，10 项红完全一致（73/83）→ 零新增红**。
  （中途一次 72/83 是并发跑 E2E 时的抖动；隔离重跑恢复 73/83。）

### 回滚

`git revert <本轮 commit>`（5 文件）；C-1 命令、`watch-video`、`debrief` 不受影响；prompt 回滚后自动回 C-1 流程。

### 没做

- **上游插件的两个 P0 未修**（窗口化 `winStart` 加两次 / zoom 覆盖分镜格表）：长片「按窗口读 + 按格 zoom」会静默错位；
  本机先用 `--from/--to` 重出规避。要根治得给上游提 PR。
- 没 push。

---

## 快照：2026-10-30 19:20–20:15（把 dsh-video-storyboard 的分镜方法接进 B站「刷视频」→ C-1 落地）

### 用户原话

> 「装上这个插件，看看能不能将其方法运用到 surfcore 插件刷 b 站的板块」→ 看到方案后选「①落 C-1」

### 做到了什么

**前置（会话侧，不入库）**：本机原来没有 ffmpeg → 装 9.0.2 到 `~/.dsh/tools/ffmpeg/bin`，并硬链接到
`~/.dsh/surfcore/bili/bin`（surfcore `tools/lib/ffmpeg.mjs` 的查找链覆盖这里，`ffmpegInfo()` 已 ok）。
`dsh-video-storyboard` 0.5.0 装进 `~/.dsh/plugins/` + desktop profile（改前备份 `profiles/desktop/package.json.bak-2026-10-30T11-03-00-458Z-preinstall`）。

**C-1 代码（本次提交）**：

| 改动 | 内容 |
| --- | --- |
| 新命令 | `tools/commands/watch-storyboard.mjs`：取 720p 直链 → 下载 → WBI 官方字幕 JSON → 调已装分镜 CLI 出「编号格 + 可寻址清单 + 音频条」；插件缺失自动退回 `bili-watch` 九宫格，**不新增硬依赖** |
| 纯逻辑 | `tools/lib/watch-storyboard.mjs`：`parseArgs` / `resolveStoryboardCli` / `buildStoryboardArgs` / `storyboardPaths` / `pickSubtitleJson` / `parseStoryboardStdout` / `summaryLines`（全部可离线单测） |
| 注册 | `tools/bili.mjs` 命令表加 `watch-storyboard`（只读区） |
| 唤醒 prompt | `lib/scheduler.js` step 4：深读改两段式 —— `debrief --no-frames` 文字五路 + `watch-storyboard` 分镜；引用画面说「第 N 格」，细节 `--from/--to --cells 4` 重出 |
| 记账 | `watch-history` 记 `mode:frames / source:watch-storyboard`（`--no-history` 可关；`SURFCORE_WATCH_PARENT` 防重复） |
| 测试 | `scripts/test-watch-storyboard.mjs`（8 组断言）已进 `plugins/surfcore/package.json` 的 `test` 链 |

### 已验证（Lead 跑的最终门禁）

- 真机 E2E：`node tools/bili.mjs watch-storyboard BV1w7HM6JEGa --cells 9 --detail low --out <tmp> --no-history`
  → 90s「鱼灾」梗指南；720P 下载 5.51MB；官方字幕 29 段对齐（`transcript=file`）；9 格图 1009×620；
  清单 9 行（cell 1 = 00:00.00–00:10.47 …）；`STORYBOARD/MANIFEST/INDEX` 三 marker 正常；exit 0。
- `node scripts/test-watch-storyboard.mjs` → 全绿；`node --check` 5 个改动文件通过。
- `cd plugins/surfcore && npm test` → **exit 0**（42 个脚本，含新测试、`test-scheduler-session`）。
- 全量 `npm run test:audit` → **73/83**，与 2026-10-30 17:45 快照的基线一致（10 项已知红，其中
  `test-version.mjs` 是 README 顶部版本 0.6.20 ≠ package 0.6.22 的**既有漂移**，非本轮引入）。
- 仓库 `git status` 只含本轮 9 个文件；未 push（`origin` 存在，发布按规矩另说）。

### 回滚

`git revert <本轮 commit>` 即可：两条新文件 + `bili.mjs` 一行 + scheduler prompt 一组 + package.json 一行 + 三处文档。
`watch-video` / `debrief` 一行未动。

### 没做 / 下一步

1. **路线 A**（B站 会话直接调 `video_storyboard` 原生工具）：工具面已实测无闸（B站 preset=standard/146 工具），
   但要加 `qq-tool-restrict` 的 `KNOWN_DANGEROUS_GLOBAL_TOOLS` 名单 + 用户需另装插件 → 二期再评估。
2. 插件侧两个 P0（窗口 `winStart` 加两次、zoom 覆盖格表）属上游仓库，本轮未改；建议提 issue/PR。
3. 长片（>30 分钟）扫描可能撞 `bili.mjs` 的 600s 子进程预算 → 用 `--from/--to` 分段；后续可在命令里自动分段。

---

## 快照：2026-10-30 17:45–18:40（记忆系统评估 → 批次 A 止血 + 批次 B 收口）

### 用户原话

> 「阅读surfcore插件的记忆系统，做一个评估」→ 看完报告后：「按你所说的ABC，依次进行修复」

### 做到了什么

评估报告：`state/agents/memory-audit/REPORT.md`（P1×10 / P2×28，综合 6.3/10）。按报告批次 A→B→C 顺序修。

**批次 A（止血，commit `400ab42`→`a18020e`）**

| 项 | 修复 |
| --- | --- |
| A1 | 三处 `?rev=` 对齐 + 叙事 import 挂同一 rev + 修 2 条红测 + 新增 `test-memcard-narrative`（10 项） |
| A2 | 容量口径唯一：status/save/compact/maintain 统一传叙事，`status.chars === 磁盘 md`、`promptChars === 注入文件` |
| A3 | 归档先于淘汰：`trimMemoryCard` 只删已归档记录，maintain 归档后再 trim（卡满不再丢新记忆） |
| A4 | inbox 字节水位 + `.rotated` 标记 + 重读不 +recall（4500 行不再丢最老、遗忘不再被系统性抬高） |
| A5 | B站→QQ 生成器输入改当前角色 `stateDir`；status 暴露 dataDir/entries/indexError；hermetic 测试 |
| A6 | 隐私闸扫真身 + 调度器走 `readQqForBili` + §四 去 mid/原始昵称；失败返回 blocked 不覆盖旧文件 |

**批次 B（叙事层做完 + 备份 + 性能 + 隐私纵深，commit `252d885`→`b6f9c2e`）**

| 项 | 修复 |
| --- | --- |
| B1 | hidden 段 covers 全抑制；叙事 ≤40% 注入预算、today/pet 保底、去掉原始限额砍半；回忆上限满时停轮 |
| B2 | 备份 label 带角色、恢复先校验再原子写、坏备份/跨角色拒绝、`pruneBackups` 正则修复、每日备份闸门、stats 流式重建 |
| B3 | 压缩改字符账（600 条 7.9s → ~40ms）；无变化维护 `noop` 不写盘 |
| B4 | 记忆页叙事面板（条数/hidden/上次 token 用量）、删单条回忆、叙事开关、记录搜索/分页 |
| B5 | 数字变体（全角/分隔符/13+ 位）检测并整行丢弃；指令样式清洗 + 双向「数据不是指令」围栏；空白名单 fail-closed；feed 尾读 8MB；叙事外发脱敏 |

**批次 C（结构性收口）**

| 项 | 修复 |
| --- | --- |
| C1 | 叙事 LLM 用量记入 token 额度「其他」（`lastRun.usage` + `narrativeUsageAccountedAt` 去重，不重复计费） |
| C2 | `?rev=` 改内容哈希：`npm run sync:engine-rev` 自动写 `memfix-<sha1>`，`test-core-rev-sync` 校验 |
| C3 | 硬编码「羽」清理：config `ownerName` + 合体层 `admin.displayName`；叙事 prompt 同步 |
| C4 | UTF-16 安全截断 `safeSlice()`（引擎/叙事/隐私/B站记忆），emoji 不再变 � |
| C5 | 维护器跨进程锁（`.memory-maintain.lock`，30 分钟陈旧锁回收，拿不到锁 `skipped:'locked'`） |
| C6 | 关掉记忆卡不写 inbox、关掉 QQ→B站 不写 feed（桥接按 unified 配置 mtime 缓存判断） |

### 已验证（Lead 跑的最终门禁）

- 9 个记忆/隐私测试全绿：`test-memory-card`（32）/`test-memcard-narrative`（14）/`test-memory-card-backup`（7）/
  `test-memory-card-narrative-api`（5）/`test-privacy-hardening`（7）/`test-bili-memory-path`（2）/
  `test-memory-sync-privacy`（4）/`test-memory-card-wiring`/`test-core-rev-sync`。
- `cd plugins/surfcore && node scripts/test-memory-card-api.mjs` → OK；`cd plugins/surfcore && npm test` → exit 0。
- 全量 `npm run test:audit`：**73/83**（10 项红均为 HEAD `559d35c` 基线已知红，已在基线 worktree 逐个复跑确认；
  记忆相关 0 红；本轮新增的 3 个根级测试全部进链并通过）。
- 真实数据复核（`state/agents/memory-audit/_lead_verify2.mjs`，只读）：
  338 条记录 / 91 条回忆 / hidden 35（106 covers）；**新代码口径 `status.chars = 新渲染 = 9,661`**；
  被回忆覆盖的 257 条原记录在「新渲染 md / QQ 注入块」中泄露 **0**；备份 11 份；
  磁盘 md 17,822 与注入 5,177 是运行中的**旧进程**写的，重启 DSH 后会被新代码覆盖为同一口径；
  B站 entries 仍为 0（修复在代码层，需重启桥接后的下一轮 refresh 才会生成，未擅自重启服务）。

### 回滚

按 commit 逐个 `git revert`；改动均为独立提交（A1~A6、B1~B3、B4+B5、C1~C6、rev 哈希、文档）。无删除/不可逆操作；
真实记忆卡未在开发中改动（所有测试用临时 DSH_HOME；真实复核只读）。

### 没做 / 下一步

1. 本轮明确不做：全量卡倒排索引（当前流式扫描够用）、多 DSH 实例的完整支持、叙事层可编辑正文。
2. 报告 8 个产品决策仍待用户拍板（容量口径已按「磁盘 md 含叙事」定；其他见报告 §9）。
3. 真机验证前先重启 DSH（让插件加载新代码）并重启桥接（B站 记忆生成器读新目录），然后看：
   - 记忆页容量条数字 = 磁盘 md 字符数 = 注入预览口径；
   - 叙事面板有回忆/hidden/上次 token 用量；Token 额度「其他」出现 `memory-narrative`；
   - `prompt-bili.md` 非 0B、`bili-memory.json entries > 0`。

---


### 用户原话

> 「扫描surfcore插件，提出一些你觉得能够优化的地方」→ 看完报告后：「修掉P1」

### 做到了什么（5 个并行修复组，写域互不重叠）

| 区域 | 修复（编号对应 `state/agents/audit/REPORT.md`） | 落点 |
| --- | --- | --- |
| 宿主/安全 | **P0-1** 隐私闸私钥死循环；P1-1 browse 标题 PowerShell 注入；P1-2 4 处 detached spawn 无 error 监听；P1-11 备份失败/坏配置静默 | `lib/privacy.js`、`lib/index.js`、`lib/bridge.js`、`lib/store.js` + 4 个测试 |
| 设置页 | P1-6 语音页 3 处后门写 `/config` 改走草稿；P1-7 切角色后人格卡写错角色；P1-12 保存成功却显示红字；P1-13 深色主题目的页不可读 | `lib/client.js` + 2 个测试 |
| 桌宠 | P1-3 LLM 无超时（新增 `pet.chat.llmTimeoutMs`，默认 90s）；P1-4 对话历史并发丢更新 | `lib/pet-chat.js`、`lib/pet-purpose.js` + `test-pet-chat` 重写 |
| 更新/调度 | P1-5 批量更新只落地最后一个（pending 改 jobs 队列，helper 逐 job 执行）；P1-8 `ensureSession` 创建失败缓存成 ready | `lib/updates.js`、`lib/scheduler.js`、根 `scripts/apply-update.mjs` + 2 个测试 |
| B站 工具链 | P1-9 账本/状态 JSON 多进程读改写无锁（新增 `tools/lib/atomic-json.mjs`）；P1-10 出站身份闸补 4 个公开出口；P1-14 `bili.mjs`/高频 fetch 无超时（新增 `tools/lib/http-timeout.mjs`） | `tools/**` + 3 个新测试 |

### 已验证（Lead 跑的最终门禁）

- `cd plugins/surfcore && npm test` → **全绿**（42 个脚本；新增 `test-scheduler-session` /
  `test-tools-ledger` / `test-tools-outbound` / `test-tools-timeout` 已登记进链）。
- P0 复现脚本 `node state/agents/audit/_verify_privacy_loop.mjs` → `OK`（修复前实测 HUNG）。
- `node --check`：全部改动文件通过；`git status` 确认只动了写域内文件（在途改动原样保留）。
- 根目录 `npm run test:audit`：**当前 64/77**（13 项红）。对照 HEAD 基线 worktree（`d7f6b33`）为 **70/77**（7 项红）：
  额外 7 项全部落在**在途未提交改动**（`src/bridge.js` / `src/memory-card.js` / `src/web-search.js` /
  `src/conversation-closure.js` / `dsh/agent-presets` / `presets`），这些测试文件里 **0 处引用 plugins/surfcore**，
  与本次 P1 修复无关。**不是本次修复引入的回归**；在途功能合入前需要先修它们（见下）。

### 回滚

逐项回滚命令在各 `state/agents/audit/FIX-*.md`。注意三个文件**不能整文件 `git checkout`**（含别人的在途改动）：
`plugins/surfcore/lib/client.js`、`lib/index.js`、`qq-tool-restrict.mjs`（后者本次未动，仅在途）。
其余改动文件均为本次从干净状态改的，可单文件 checkout；新增文件删除即可。

### 没做 / 下一步（按建议顺序）

1. **先给在途「记忆叙述」改动做检查点提交**，再处理那 7 项在途红：
   `test-core-rev-sync`（`memory-card.js` 的 `?rev=` 只 bump 了 1 处，3 处要一致）、
   presets 生成物（`npm run test:preset-patches` 重新生成）、`test-memory-card` / `test-media-search` /
   `test-closure-wiring` / `test-voice-system`（都是 src 侧行为变化后测试没跟上）。
2. HEAD 基线本来就红的 7 项（历史遗留）：`test-version`（README 还写 0.6.20）、
   `test-self-identity` / `test-identity-guard` / `test-audit-regressions` /
   `test-preset-local-tools` / `test-agent-preset-patches`（`test-stickers` 只在无 config 的 worktree 红）。
3. 剩余 P2 与结构性优化（HTTP 层模板化、配置快照、publish 原语、更新器结果账本、
   UI 表单原语、测试基建）见 `state/agents/audit/REPORT.md` §3/§4，未动。

---

## 快照：2026-10-26 09:05–09:40（设置页「检查更新」：本体 + 语音包 + 桌宠 + 未来扩展）

### 用户原话

> 「在设置页的概览里做个检查更新按钮，可以检查 surfcore 和其他所有扩展包（包括 surfvoice 的 local 和 cloud，
> 还有 surfpet，以及未来可能加入的其他扩展），当 git 有更新时，用户启用 DSH 或者 SURFCORE 时会弹窗更新内容
> 和可勾选的不再提示按钮（不再提示仅限本次更新）。用户点击检查更新时，会再次弹出具体内容，确认后进行更新。」

### 做到了什么

| 能力 | 落点 |
| --- | --- |
| 检查 SurfCore 本体 / 语音包（local·cloud）/ 桌宠 / **自定义扩展** | `plugins/surfcore/lib/updates.js`：`components()` 每次动态解析；自定义组件走 `~/.dsh/surfcore/config.json` 的 `updates.components[{id,name,dir,branch}]` |
| 启动自动检查 | 插件激活后延迟 20s 查一次，之后每 6h（`updates.startDelayMs` / `intervalMs` / `checkOnStart`） |
| 有更新时弹窗 | 概览页挂载时若 `updates.showPrompt` → 自动打开 `UpdatesModal`（列组件、提交清单、逐个勾选） |
| 检查更新按钮 | 概览「更新」卡：`POST /updates {action:"check"}`，命中即弹窗 |
| 确认后更新 | `POST /updates {action:"apply", ids}`：只做 `git fetch` + `merge --ff-only`；本地有改动 / 有未推送提交 / 组件在运行 → 拒绝并说明原因 |
| 「不再提示本次」 | 勾选后关闭 = `dismiss`，按**远端 commit** 记在 `updates.json`；远端有新提交会重新提示 |
| 界面 | 概览新增「更新」卡（状态/上次检查/各组件一行）+ 弹窗；文案与安全说明在弹窗里 |

### 已验证

- `plugins/surfcore/scripts/test-updates.mjs`（**新增，约 40 条断言**）：真实临时 git 仓库——
  没有更新 / 远端前进 / 本地改动拒绝 / 分叉拒绝 / dismiss 只对本次生效 / 快进成功 / 运行中被拒 / 非 git 目录降级；
  以及 **release 通道**：semver 比较、读 `package.json` 已装版本、比 `version.json`、`file://` 下载、
  sha256 校验通过/失败、安装器收到包后清理临时文件。
- `plugins/surfcore/scripts/test-pet-update.mjs`（**新增，10 条**）：真 zip + 真目录跑 `updateFromZip()`，
  断言版本更新、`data/profile` 原样保留、用户皮肤保留、`run.pid` 清掉、备份清理、标记仍在（PITFALLS #77）。
- `plugins/surfcore npm test` → exit 0（两个新用例都已进链）。
- `npm run test:audit` → 75/75。

### 两个通道（2026-10-26 补充：一次查完三个）

| 组件 | 通道 | 怎么判断有新版本 | 怎么更新 |
| --- | --- | --- | --- |
| SurfCore 本体 | git | `fetch` 后 `HEAD..origin/main` | `merge --ff-only` |
| 语音包 local / cloud | git（是 clone 时）/ release（配了 `voice.*VersionUrl` 时） | commit 数 / 版本号 | 快进 / 下 zip |
| 桌宠 | **release** | 装好的 `package.json` 版本 vs `updates.pet.versionUrl` 的 `version.json` | 下 zip → sha256 → `petService.updateFromZip()`（保留 `data/`） |
| 未来扩展 | 配置 `kind` 决定 | 同上 | 同上 |

> 桌宠的 `version.json` 长这样（发布时放 Release 资产）：
> `{ "version": "0.3.0", "notes": "- 修气泡\n- 加专注模式", "file": { "url": "…zip 直链…", "sha256": "…", "size": 16777216 } }`
> 没配 `versionUrl` 时桌宠仍会出现在列表里（显示已装版本），但标记"不可查"。

### 边界（必须知道）

- **弹窗发生在"打开设置页概览"时**，不是 DSH 启动时弹系统级窗口：插件能挂的只有 DSH 的 Web UI 与自己的
  HTTP 接口，没有"系统通知"服务（`ctx` 里只有 webServer / settings / llm / subprocess / connection）。
  所以流程是：DSH 起来 → 后台查（不打扰）→ 你打开 SurfCore 设置 → 概览自动弹。
- **只支持 git 安装**：语音包/桌宠如果是 zip/目录拷贝装的（不是 git clone），会显示"不是 git 仓库（用 git clone 安装的才能检查更新）"。
  这是有意的：对我们不拥有的目录做 `git` 操作比"不能更新"更危险。
- 更新后**要重启对应服务**：SurfCore → 重启 DSH；语音包 → 停止/启动该包；桌宠 → 重启桌宠。
- 网络差时 `fetch` 会各自失败（30s 超时），只报"这一项不可用"，不影响别的组件。

---

## 快照：2026-10-26 08:40–09:05（被 @ 却先回老消息：唤醒快照改成"从最近往回看"）

### 用户原话

> 「QQBOT 每次看群消息是从最早的开始看并回复，是这样的吧？导致我每次艾特她她进来先回老远的消息。
> 能不能设置成从最近的往回看」

### 根因

`buildWakeSnapshotV2()` 给模型塞的是**最早**的未读（`st.unread.slice(0, wakeMessageLimit)`，
默认 12 条），而 `unreadLimit` 默认 30 —— 积压十几条时，最新那条（也就是 @）**根本不在快照里**。
当初这么写是为了让连续水位 `readThroughSeq` 能从最早开始推进。

### 改法（PITFALLS #76）

| 改动 | 文件 |
| --- | --- |
| 唤醒时把窗口之外的**更早未读折叠**：从 `st.unread` 摘掉，只留最近 `wakeMessageLimit` 条，记录 `packet.folded = {count,fromSeq,toSeq,fromAt,toAt}` | `src/bridge.js` |
| 折叠后窗口连续 → 水位沿用既有语义（被折叠的 seq 低于 `lowestBuffered`，可被越过），`readThroughSeq` 不用改 | 同上 |
| 新增 `wakeFoldedNoticeV2()`：提示词明确"更早的 N 条只是背景，**不要**回头逐条回" | 同上 |
| `recent` 块排除折叠范围（否则折叠掉的消息会从 recent 绕回来） | 同上 |
| 配置 `socialV2.context.wakeFoldOld`（默认 **true**；`false` 恢复旧行为），设置页 QQ 高级设置可勾 | `src/bridge.js`、`config.example.json`、`plugins/surfcore/lib/client.js` |

### 已验证

- `node scripts/test-token-economy.mjs`：新增 3 条用例全过（最新窗口+折叠 / `wakeFoldOld=false` 复原旧行为 /
  15 条积压默认只留最后 12 条、折叠前 3 条、且 `recent` 不包含被折叠的）。
- `npm run test:audit` **75/75**；`npm run test:regressions` 全过；`plugins/surfcore npm test` 全过。

### 注意 / 没验证

- **折叠是永久的**：消息从 `unread` 摘掉后，控制台"未读"里也看不到了；但 `recentMessages` 仍保留最近 200 条，
  `qq_get_recent_messages` 还能翻到 —— 提示词里写的就是这条路。
- **没在真机群积压场景验证**（用 harness 造的 15 条积压）。真机上看一次"被 @ 后先回最新那条"即可确认。
- 如果哪天想回到"先把 30 条都读完"，把 `socialV2.context.wakeFoldOld` 设 `false`。

---

## 快照：2026-10-26 08:10–08:25（文档里挖出的四条：修三、标一个"未实现"）

### 用户拍板

> 「修，修，未实现，拿掉，删」

对应关系：R34 修、R30-① 修、R30-② **未实现**（不假装修）、R30-③ **拿掉**（移除 B站私信选项）、R32 **删**（控制台语音按钮）。

### 改了哪四个文件

| 问题 | 改动 | 验证 |
| --- | --- | --- |
| **R34 桌宠安装目录可清空任意目录** | `plugins/surfcore/lib/pet.js`：新增 `checkAppDir()`（盘根/受保护目录自身或上级/非空且无标记 → 拒绝）；安装成功写 `.surfcore-pet.json` 标记；`install`/`unzip`/`remove` 删除前统一过闸；`install()` 前先 `stop()`；`status()` 多回 `appDirSafe`；**新增 `looksLikePetInstall()` 认领本改动前装好的目录**（`skins/` + 包名含 pet/feiyu + `dist/` 或 `run.pid`），认领后补写标记 | 新增 `scripts/test-pet-dir-guard.mjs`（**22 条**，含"外来目录必须被拒"与"老安装可认领"）；用本机真实配置实测：认领=true、允许删除=true |
| **R30-① edit-dynamic 崩** | 补 `import { gate } from '../lib/quota-gate.mjs'`（与已修的 `dynamic.mjs` 同款） | `node --check` + 命令路径可读 |
| **R30-② 直播间监听** | 按"未实现"处理：`danmaku-await.mjs` 启动即 `exit(3)` 并打印原因；`scheduler.js` 收到 3 → `liveUnimplemented=true` 停止重试（不再每分钟空转） | 手动跑脚本得 `exit=3` + 一行说明 |
| **R30-③ B站私信推送** | 设置页移除「B站私信」选项；`notify.mjs` 的 `dm` 分支改成抛可读错误（老配置不再 `ReferenceError`） | `node --check` |
| **R32 控制台语音页** | 删掉控制台导航里的「♪ 语音」按钮（`section-voice` 区块**保留**：页内 JS 绑定着它，删区块会坏初始化） | 导航 `data-view="voice"` 引用数 = 0 |

### 已验证

- `cd plugins/surfcore && npm test` → **exit 0**（新增的 dir-guard 已在链里）。
- `node scripts/test-pet-dir-guard.mjs` → 18/18；`test-pet-api` / `test-host-smoke` / `test-http-guard` 全绿。
- 六个改动文件 `node --check` 全过。

### 没做的（明确记录）

- **R36**（语音包 `activeInstalls` 只 set 不 delete → 同进程第二次安装被永久拒绝）：仍未修。
- **R37**（语音 `trigger.who="list"` 引用未定义变量）、**R38**（`send-voice.mjs --direct` 绕过闸门）、
  **R39**（四份文档口径不一致）、**R33**（`lastTickAt` 永远 null）、**R35**（目的状态缓存）— 全部保留在风险台账。
- 桌宠 UI 没有加"目录不安全"的红色提示（后端会直接拒绝并回错误文案，够用；要加再说）。
- **没有重启 DSH**：本轮改的是插件代码（pet/scheduler/client）与 B站 CLI，下次热重载/重启后生效。

---

## 快照：2026-10-26 07:56–08:30（全仓库逐行梳理 + README 重写）

### 本轮需求（用户原话）

> 「现在梳理整个 surfcore 仓库，我要求你细看每行代码的功能，将整个仓库所有的架构梳理，
> 将每一个功能的细节（所有功能和设计，必须是所有，所有，不能遗漏任何细节设计）、原理、
> 可实现的功能与边界，全部梳理一遍（包括语音和桌宠拓展），整理成可以让人读懂的文本。
> 顺便重新梳理并重新 readme」

### 产出：12 篇新文档（约 8,900 行 / 3,154 处 `文件:行号`）

| 文档 | 行数 | 覆盖 |
| --- | --- | --- |
| `docs/guides/ARCHITECTURE.md` | 334 | 总纲：进程/端口、五层分层、两个世界+三个共享引擎、6 条数据流、两套状态根、三份配置、安全模型、**重启矩阵**、术语表 |
| `MODULE-BRIDGE.md` | 1,019 | `src/bridge.js` **1–14964 全文**（5 段/批顺序读）：启动、入站、出站、会话、约 110 个控制台端点、8 类闸门、15 个定时器 |
| `MODULE-CORE-A.md` | 1,000 | 11 个引擎（7,815 行）：记忆卡、角色包、目的、收尾、额度、账本、价目、管理员、自我识别、身份闸、分享范围 |
| `MODULE-CORE-B.md` | 1,098 | 其余 `src/`：B站 5 个模块、鱼群、表情语义、黑话、md→纯文本、转发、补历史、问候、SSRF、搜索、DSH 客户端、语音内核、ACL |
| `MODULE-PLUGIN.md` | 1,100 | 插件宿主 20 个模块：装配、配置模型、设置页 API 动作面、B站 五条滴答、记忆/对齐、token 采集、扩展/平台、桥接自愈 |
| `UI-AND-CONSOLE.md` | 670 | `client.js` 1–4349 + `console.html` 1–5416：14 个标签页逐页逐卡片、48 个组件、控制台 10 页与端点表、分工与重叠 |
| `SUBSYSTEM-BILI.md` | 972 | 34 个命令 + 23 个库、生物钟、四本账、鱼群、脱敏、配置全解 |
| `SUBSYSTEM-VOICE.md` | 854 | 三条链路、语音包状态机、本地/云端路由、合成契约、发送全链路、触发规则（含外部 voxd 源码核对） |
| `SUBSYSTEM-PET.md` | 898 | 仓库内 4 个模块 + 仓库外桌宠工程：拓扑、鉴权、13 个端点、对话/事件、载体互斥、记忆、回音、专注 |
| `AGENT-TOOLS-AND-PRESETS.md` | 232 | 39 个 `qq_*` 工具全表、5 层闸门、fail-closed 守卫（67 名单）、两代 preset、装配 |
| `DATA-AND-CONFIG.md` | 350 | 三份配置逐段全解 + 约 95 个状态文件全表（谁写谁读/能不能删）+ 备份/迁移/清理约定 |
| `BOUNDARIES.md` | 180 | 环境边界、能力矩阵、失败模式→恢复表、安全承诺与不承诺、资源与出机边界 |

另：`README.md` 完全重写（222 行，能力地图 + 架构图 + 最小配置 + 运维 + 文档地图），
`README.en.md` 加了指引并可点开；`docs/README.md` 索引新增"2026-10-26 全仓库梳理"一组；
`FOLDER_MAP.md` 的 docs 结构更新；`DSH_SETUP.md` 修正了过期的版本与 `dsh.authToken` 说明。

### 写文档时"顺手挖出来的真问题"（只记录，**没有改代码**）

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| R30 | B站 三个脚本一跑就 ReferenceError（`edit-dynamic.mjs:50` 缺 `gate` import；`danmaku-await.mjs:50,56` 未定义 `statePath` → **直播间监听起不来**；`notify.mjs:156-162` 的 dm 分支坏了） | 🔴 待拍板（修 ② 等于启用一条从未跑通的链路） |
| R32 | 控制台「语音」页点不进去（`consolePages` 缺 `voice` 键 → 回退 overview） | 🔴 待拍板（补文案=启用久未验证的页面） |
| R33 | `schedulerStatus.lastTickAt` 永远是 `null` | 🟡 待修 |
| R34 | **桌宠安装目录是不可逆删除面**：`resolveAppDir` 只 `path.resolve`，三处 `rmSync(recursive)` | 🔴 建议优先修 |
| R35 | 插件侧目的状态不随文件重载（与桥接 mtime 语义不一致） | 🟡 待评估 |
| R36 | `/api/voice/packs` 每次请求新建实例 → 安装进度不可见、并发安装互删 | 🟡 待修 |
| R37 | 语音 `trigger.who="list"` 引用未定义变量 | 🟡 待修 |
| R38 | `send-voice.mjs --direct` 绕过白名单/限流/审计 | 🟡 待确认是否有意 |
| R39 | 四份文档与代码不一致（sha256、触发窗口 5 vs 10 分钟、PET 启动参数、陌生私信 12 vs 30） | 🟡 待统一 |

### 已验证

- `node scripts/privacy-scan.mjs --strict` → **exit 0**（0 命中 / 0 截断）：新文档全部无本机路径、无 QQ 号、无令牌。
- 内部链接自检：新文档之间 0 死链；`docs/README.md` 里指向 `design/`、`audit…`、`legacy/` 的死链
  已标明"本机不存在属预期"。
- 本轮**只改文档**（`git status` 18 个文件，全部是 md），没有触碰任何代码 → 功能零影响。
- 未跑 `test:audit`：无代码变更，且文档不含可执行内容。

### 下一步（建议顺序）

1. 决定 R30 / R32 / R34 三条"待拍板"要不要修（R34 是数据安全，建议优先）。
2. 文档里标 ⚠️ 的"未覆盖项"可以作为下一轮精读清单：
   `src/bridge.js` §11 列的 20 条依赖、`tools/lib/*` 语义、DSH 服务契约（`llm.stream` / `agentDefaultModel`）。
3. 统一 R39 的文档/代码口径（以 `docs/guides/SUBSYSTEM-*.md` 为准）。

---

## 快照：2026-10-26 07:10–08:05（全项目审计 + 第二轮"把问题都修了"）

### 本轮需求（用户原话）

> 「现在整个 surfcore 的功能做的比较齐全了，包括 surfcore 本体和语音、桌宠扩展，
> 你扫描一下全局看看整个架构是否合理，有无漏洞风险，有无残留垃圾，优化一下」
>
> 补充（第二轮）：「反正你把问题都修了，且绝对、绝对不能影响我 surfcore 核心和语音、桌宠的功能」

### 结论先说

- **架构分层是合理的**（`src/` 纯引擎 ← 桥接进程 / DSH 插件 / 独立工具三方复用），
  最大问题是 `src/bridge.js` 14,964 行 + 控制台 126 条路径挤在一条 if 链里。**本轮没动它**——
  它恰好是"会碰到核心功能"的那一块，按用户约束不做。
- **入口级安全没有发现缺口**（控制台 Host+令牌+混淆代理防护；插件 API 实测 401；桌宠 API 令牌 + ACL 继承已核实）。
- **修掉 6 个真问题**（全部按"要么行为等价、要么有新增断言证明"的标准做）：
  1. preset 生成物落后于源，而能抓它的测试**不在任何门禁**（PITFALLS #71）
  2. 共享准入判据：IPv6 回环是**死代码**、空令牌等于空令牌（#72）
  3. `state/` 被当草稿纸，50 个一次性产物 2.3MB（#73）
  4. **隐私闸 fail-open**：规则缺 `g` 导致每条规则每文件只看第一个命中（#74）——修完立刻暴露 3 个真命中
  5. **`?rev=` 三处硬编码**没有任何一致性保护（现在有 `test-core-rev-sync.mjs`）
  6. **语音包默认安装源写死本机盘符**（现在相对仓库解析，解析结果逐字相同）
- **桌宠 API 从"字符串包含"级测试升级为 32 条行为断言**（令牌/回环/同源/全部端点/音频/host.json）。

### 做到哪（改动清单）

| # | 改动 | 文件 | 对功能的影响 |
| --- | --- | --- | --- |
| 1 | 设置页 API 与桌宠 API 的准入判据收敛成**唯一实现**；修 IPv6 死分支、空令牌 fail-closed | `plugins/surfcore/lib/http-guard.js`（新）、`lib/index.js`、`lib/pet-api.js` | 判据逻辑等价 + 两处修复；`readBody` 上限仍 512KB(设置页)/256KB(桌宠) |
| 2 | 判据单测 31 条 | `plugins/surfcore/scripts/test-http-guard.mjs`（新） | 无（只加测试） |
| 3 | 桌宠 API 行为回归 32 条 | `plugins/surfcore/scripts/test-pet-api.mjs`（新） | 无（只加测试） |
| 4 | preset 防漂移测试**登记进门禁** + npm script + 重新生成落后 patch | `scripts/test-audit.mjs`、`package.json`、`plugins/surfcore/presets/qq-chat-v2.patch.yml` | 产物补齐「对话收尾」段，与源一致 |
| 5 | `?rev=` / 核心引用一致性回归 | `scripts/test-core-rev-sync.mjs`（新） | 无（只加测试，会打印"改完热重载不生效"的模块清单） |
| 6 | 隐私扫描判据抽库 + 强制 `g` + `--strict` / `incomplete` | `scripts/privacy-rules-lib.mjs`（新）、`scripts/privacy-scan.mjs`、`scripts/test-privacy-scan.mjs`（新） | 发布闸从"假绿"变成可机读；0.5s |
| 7 | 清掉 36 处本机路径 + 3 条联盟跟踪链接；语音包默认值改相对解析 | 文档若干、`src/voice-packs.js`、`plugins/surfcore/tools/docs/rich-text-nodes.md` | 语音包解析结果与旧值逐字相同（`test-voice-packs-default.mjs` 钉住） |
| 8 | `state/` 残留隔离（21 个 `.mjs` / 5 张截图 / 24 个日志 / 2 份 audit-result） | `_backups/state-residue-20261026/`（含 README + 回滚） | 无（运行时不读这些） |
| 9 | 文档：目录地图、风险台账（R9/R9a/R22–R29）、坑 #71–#74 | `docs/FOLDER_MAP.md`、`docs/RISK_REGISTER.md`、`docs/PITFALLS.md` | 无 |

### 已验证

- `npm run test:audit` → **75/75**（原来 71；新增 preset 防漂移 / 核心引用一致性 / 隐私判据 / 语音包默认值；更早一轮 74 时已全绿）。
- `cd plugins/surfcore && npm test` → 全绿（含新增 `test-http-guard`、`test-pet-api`）。
- `npm run test:preset-patches` → 全绿；反向验证：改坏 patch 一个字符后 `--check` exit 1。
- `node scripts/privacy-scan.mjs --strict` → **exit 0**（0 命中 / 0 截断 / 0.5 秒）；
  修好 `g` 之后**新发现并清掉** 3 条此前看不见的命中（说明这次修的是真漏洞，不是换了个说法）。
- 语音包默认值：`test-voice-packs-default.mjs` 断言 "url = 仓库上级/voice/packages/<id>"，
  实测解析结果与旧硬编码值**逐字相同**、两个目录都 `existsSync=true`。
- 实测鉴权：无凭据 `curl http://127.0.0.1:14293/dsh-surfcore/api/overview` → **401**；`/dsh-surfcore/health` → 401。
- 实测 ACL：`~/.dsh/surfcore/pet` 继承链只有 `SYSTEM / Administrators / 当前用户`。

### 已验证与收尾（含用户已拍板的两件事）

1. **未重启 DSH**：本轮改动全部是"插件侧模块 + 测试 + 文档 + 一个语音包默认值"，没有重启进程做真机验证。
   下次重启（或热重载插件）后请确认三件事：设置页能开、桌宠能对话、语音能合成 —— 预期与现在完全一致。
2. **已在 2026-10-26 做检查点提交** `22de2fa`（114 个文件 / +16170 行），工作区当时已干净。
   为什么一个提交而不是按主题拆：这批在途改动在 `plugins/surfcore/lib/index.js`、`lib/client.js`、`src/bridge.js`
   里是**交织**的（同一个文件同时承载桌宠、额度、收尾的接线），按主题拆会切出"引用了还没提交的模块"的中间态。
   回滚：`git reset --soft HEAD~1`（文件不动）或 `git reset --hard 22de2fa`。
3. `sts2-agent/`（杀戮尖塔 2 模组工程，含 SteamID/用户名）**已于 2026-10-26 移出仓库**到 `<工作区>\sts2-agent`：
   4 个文件逐个 sha1 校验与 `git show 22de2fa:sts2-agent/…` 一致；要找回用 `git show 22de2fa:sts2-agent/mod/Mod.cs > Mod.cs`。
   注意：插件里那个 `plugins/surfcore/extensions/sts2/` 是**另一件事**（示例扩展空壳，默认 disabled），没有动。
4. `config.example.json` 缺 `chat` / `platforms.start` / `pet` / `tokenBudget` 四段（它被 `readQqConfig()`
   当默认层）——**故意没动**：补它等于动"插件的默认配置视图"，与"绝对不能影响功能"冲突，需要先定权威默认层。
5. 6 张已无文档引用的 `ui-*.png`（像是 `ui:shot` 产物）未动。

### 下一步（建议顺序）

1. 提交检查点（把现状固化），再做下一步。
2. `bridge.js` 拆分第一步：把控制台里"纯函数型"端点抽到 `console/routes/`；副作用端点留原地，
   每批跑 `test:audit` + `test:regressions`（**这是唯一会碰核心功能的大改，必须单独一轮**）。
3. `config.example.json` 的权威默认层（A5）。
4. `?rev=` 收敛成一个 re-export 壳（现在有测试兜底，可以慢慢来）。

---

## 快照：2026-10-25 23:00–23:45（回音 / 桌宠记忆 / 专注模式 / 语音路由）

### 本轮需求（用户原话）

> 「1、桌宠说话时语音有重影，就是回音… 2、之前 surfcore 的记忆系统是包含 QQ 或者 B站的信息写入吗，现在还要加上桌宠的
> 3、你说互斥，是指一切 QQ 消息的桥接和桌宠互斥还是单指目的机制」
> 「对了，你还要确认语音栏位的云端 or 本地功能，那里点了设置会影响到桌宠的语音」
> 「桌宠右键菜单再加一个专注模式，用户开启后，小肥鱼不会再打扰用户」

### 做到哪

- **回音**：`ChatHost` 现在指定唯一媒体所有者——对话框可见时由对话框播（气泡 payload `autoplay=false`），
  否则气泡播；开对话框先暂停气泡，任一侧开始播放都通知另一侧暂停；`document.hidden` 不自动播。
  真机 CDP 验证：对话框 `paused=false/time` 前进时气泡 `paused=true/time=0`；关对话框后气泡自动播。
- **桌宠记忆**：`pet-chat` 在 `/chat` 成功后追加两条 `platform=pet` inbox（主人 / 她回的）；
  `src/memory-card.js` 新增 `pet-owner` / `pet-self` 摄取、`platform/scope=pet`、提示词「## 桌宠（私下相处）」、
  全量卡同名分组、`stats.fromPet` / `addedPet`；`pet.chat.remember` 开关（桌宠页）；预算 priority 36 且有压力测试。
  真机验证：inbox 6 条 → 维护后 `pet-owner`（botReply 合并）入库；QQ 注入块出现桌宠段，B站不出现；
  测试产生的 3 条误按 QQ 入库的记录已备份后删除（`~/.dsh/surfcore/backups/memory-card-test-cleanup-*`）。
- **专注模式**：右键 / 托盘 / 桌宠页；单一真相 `~/.dsh/surfcore/pet/focus.json`；桌宠菜单与设置页都写它，
  插件 tick 直接跳过，桥接 `purposeTick` 读它跳过（QQ 载体也停）；手动试一次 / 用户主动对话不受影响。
  已验证：开启后本地收住、强制 proactive 被丢弃（日志 `focus mode on: drop proactive`）；桥接日志
  `专注模式开着：暂停自动主动搭话`。
- **语音路由**：桌宠每次合成前重读 `socialV2.voice.tts`；用「语音」页同一个 activate 接口实测：
  local → 桌宠状态 `8765`（本地引擎 gsv 未启动，合成失败但正确降级文字）；cloud → 状态 `8767`，语音合成成功。
- **热重载坑**：`src/memory-card.js` 的 `?rev=` 版本号必须与改动一起 bump，否则插件热重载仍用旧引擎（PITFALLS #68）。

### 已验证 / 没验证

- `test:audit` 71/71、`plugins/surfcore npm test` 全绿；新增 `test-memory-card` 两条 + `test-pet-chat` 专注/记忆断言。
- 桌宠 `tsc` / `selftest` 通过；右键原生菜单的「专注模式」勾选项代码路径已接，未用鼠标自动化点原生菜单。
- 本地语音包当前缺 gsv（9880）依赖，这是环境问题；云端已恢复并验证出声。
- 当前用户配置：`purpose.carrier=pet`、`petModality=voice`、`voice.tts.route=cloud`、`focus.enabled=false`。
  目的今天次数被测试消耗（dailyMax 4）；明天自然重置。

### 下一步

1. 给「专注模式」加一个桌面上的小型视觉提示（现在只有菜单勾选/设置页状态）。
2. 本地语音包补 gsv 依赖后，再跑一次本地 TTS 全链路。
3. 桌宠记忆是否要允许进 B站（目前 `scope=pet` 永远不进；需要产品决策，不要默认打开）。

---

## 快照：2026-10-25 19:00–20:00（桌宠对话 + 目的载体：桌宠 / QQ）

### 本轮需求（用户原话，节选）

> 「给载入 surfcore 之后的 pet 插件增加对话功能，可以利用 surfcore 里的角色（人格卡 + 衰减记忆卡 + 目的机制）进行对话和主动搭话（文本、语音两部分）」
> 「右键可以选择文本对话或者语音对话…小肥鱼会返回文本或者语音」
> 「主动搭话…可以在设置页选择为语音或者文本；机制和 QQ 里的目的机制公用一套逻辑」
> 「为了避免桌宠和 QQ 同时收到消息，可以在设置页选择主动搭话优先为桌宠还是 QQ」
> 「所有小肥鱼的对话气泡都要有回复按钮，点击跳转到对话框（按那条话的形式）」
> 「把目的机制单独做成一个栏位，独立于 QQ、B站、记忆之外，里面可以选择触发载体；未安装桌宠默认 QQ」「记得在设置页里显示」

### 做到哪

- **SurfCore 插件**
  - `lib/pet-chat.js`：直接调 DSH `llm`（人设卡 `persona.md` + 记忆卡 QQ 注入块 + 目的 pending/目标 + 规则）；
    文本 / 语音（复用 `socialV2.voice.tts`，`src/voice-tts.js` 缓存）；历史按角色落 `pet/chat/history-<id>.json`；
    事件队列 + 长轮询（`/events`）；用量 `tokenBudget.recordExternalUsage()` 记到「其他」。
  - `lib/pet-purpose.js`：同一个 `purpose-engine`、同一份 `purpose-outreach.json`；载体=桌宠时每 60 秒 tick，
    生成一句话推气泡（语音则 TTS）；桌宠离线默认回落 QQ；状态/预览/试一次。
  - `lib/pet-api.js`：桌宠专用 `/dsh-surfcore/pet-api/*`（回环 + `x-pet-token`）；写 `pet/host.json` 发现文件。
  - `lib/index.js`：装配服务、注册 pet-api、`/purpose/*` 按载体路由、`/pet/status` 带对话/在线状态、保存时提示载体切换；
    `/pet/chat-test` 推 `reply` 事件给桌宠气泡。
  - `lib/client.js`：新「目的」标签（载体卡 + 目的卡 + 桌宠对话测试卡）；QQ 页改成指路卡；桌宠页加对话参数。
  - `src/bridge.js`：`purposeTick()` / `warmPurposeState()` 读 `purpose.carrier`，载体=桌宠时让位（30 秒缓存，不用重启）。
  - `payload` 测试：`test-pet-chat` + client contract；`scripts/ui-purpose.mjs` 截图验收；`test-voice-route` 修了只给 baseUrl
    被默认 endpoints 覆盖的问题（与本轮无关但挡住了 audit）。
- **桌宠工程（<工作区>\pet）**
  - 新 `src/main/surfcore.ts`（host.json 发现 / 长轮询 / 断线重连 / 游标随 bootId 重置）、`src/main/chat-host.ts`
    （气泡/对话框窗口、消息、语音播放、回复跳转）、`src/dialog/*`、`src/bubble/*`；
  - 右键与托盘「文本对话 / 语音对话」；气泡所有小肥鱼消息都有「回复」；
  - 构建 `dist/dialog.*`、`dist/bubble.*`；`npm run selftest` 输出 `20-bubble.png` / `21-dialog.png`。

### 已验证（真机）

- 文本对话：`/pet-api/chat` 1.4s 回复，角色口吻正确；语音对话 2.8s（TTS 1.8s + wav 5s）。
- 桌宠 UI：右键（代码路径）/ IPC 打开 text & voice 对话框；发消息 → 气泡显示文字 → 语音自动播放（`playing=true`）。
- 气泡「回复」：文本气泡 → 对话框切文本；语音气泡 → 对话框切语音（双向都验过）。
- 主动搭话：载体=桌宠、文本/语音各跑一轮，`purpose-outreach.json` 计数 + 历史 + 气泡/音频都正常。
- 设置页：`目的` / `桌宠` 两页截图 `docs/ui-purpose.png` / `ui-pet-chat.png`，无 console error。
- 测试：`npm run test:audit` 71/71（修了 test-voice-route 的环境依赖）；`plugins/surfcore` npm test 全绿；
  桌宠 `npx tsc --noEmit` + `npm run selftest` 通过。

### 没验证 / 已知边界

- 语音对话**没有麦克风输入（ASR）**：目前是「文字输入 + 语音回复」。桌宠 M3 的按键 ASR 仍未做。
- 桌宠气泡的「回复」按钮只做了点击 → 打开对话框；没有做“预填引用原句”。
- 目的载体切到桌宠后，QQ 侧的**控制台**（3100）仍可手动 `purpose/run`（force）；正常自动 tick 已让位。
- 目的状态里今天已被测试消耗到 6 次（dailyMax 4）；明天自然重置。测试时把 `carrier` 设成了 `pet`、`petModality` 设回 `text`。
- 本次没有重启 DSH：插件是通过 plugin_manager 关/开 `include:surfcore` 热重载的；用户那边下次重启 DSH 也会加载同一份代码。

### 下一步（建议顺序）

1. 真机点一次右键菜单（不是 IPC）确认原生菜单两行在最上面。
2. 语音对话加「按住说话」（DSH `speechToText` 或本地 whisper）；口型驱动。
3. 把桌宠对话内容按需写进记忆卡（现在只读记忆卡，不反向沉淀）。
4. 设置页「目的」加「最近 10 条桌宠搭话」列表（现在只有 state 摘要）。

---

## 快照：2026-10-24 17:00–18:10（qq_send_voice 接入本地 TTS：text 参数）

### 本轮需求（用户原话）

> 「我想搞一个最简单的插件，以后我做桌宠、QQ机器人、直播机器人，她们靠LLM生成的语言都能用上这个语音生成器」
> 「另一个工作区的 surfcore 插件……改 surfcore 代码就直接植入进去」
> 触发方式用户已定：**模型自主决定**（不是每条自动配音）。

### 结论

- 语音链路原本只支持「语音库里的现成音频」。现在 `qq_send_voice` 多一个 **可选 `text`**：
  传 text → 调本地 `voxd`（`<工作区>\voice`）现场合成 wav → 仍走原来的发送/审计/限流/回执校验。
- **没有新增工具**：工具 schema 每次请求都要付上下文租金（41 个工具 ≈ 8.8k token），
  加一个参数只多约 30 token；`TOOL_CONFIG_FLAGS` 不用改（复用 `sendVoice` 开关）。
- `src/voice-tts.js`（新）：按内容 sha1 落盘复用、超时/未启动给可读错误、非 200 透出 detail。
- 新增配置 `socialV2.voice.tts = { enabled, baseUrl, timeoutMs, maxChars, character }`，
  **默认关闭**（没装 voxd 时打开只会一串 502）。
- 顺序：先查额度 → 再合成 → 再发送；合成失败返回 **502**，让模型改回打字，不许编「我发了语音」。

### 验证

- `node scripts/test-voice-tts.mjs` 通过（本地假服务：落盘复用、502 detail 透传、服务未启动、空文本、
  wav 头算时长）。
- `node scripts/test-voice-route.mjs`（新增，**不发 QQ**）：用 `audit-bridge-harness` 跑**真实
  `bridge.js`** → `synthesizeVoiceText` 请求本地假 TTS → 落 wav → `sendVoiceForV2` 发出
  `send_group_msg` 的 **record 段**；超长报「最多 20 字」。
- `node scripts/voice-e2e.mjs`（新增，**不发 QQ**，voxd 没起来会 SKIP）：6 轮 p50 **27ms / 0ms（缓存）**，
  冷启动单轮 133~447ms，2.0~2.8s 音频，`probe=ok` 全过。
- `node scripts/test-voice-system.mjs` 45 通过 0 失败；`test-qq-preset-contract.mjs` 8/8；
  `test-qq-mode-plugin.mjs` 6/6；**`npm run test:audit` 71/71**（新加的两条已进清单）。
- `voxd` 侧：13 条一致性测试全绿；`scripts/bench.py` 可复现地量引擎：
  `piper` RTF **0.12**，`qwen3 0.6B CustomVoice` RTF **6.42**（22.8s 换 3.6s 音频）。
- **提示词已教模型「带语气标记」**：`plugins/surfcore/presets/qq-chat-v2.patch.yml` 与
  `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 同步改了第 16 条（text 两种用法 + 10 个标签 +
  「一条 1~2 个，别每句都标」），`test-qq-preset-contract.mjs` 加了对应断言（8/8）。
  注意：**当前 config 的 `agentPreset` 是 `qq-chat`**，语音工具与这条规则都在 `qq-chat-v2`（reserved2）里。
- **试音台**：`http://127.0.0.1:8765/`（`voxd/static/index.html`，无构建），选音色/点标签/直接播放，
  显示耗时、缓存命中、逐句时间轴。
- **试听包**：`scripts/audition.py`（voxd 仓库）→ `audition/index.html`，已生成 20 条
  （5 句 × 4 音色：huayan/vivian/serena/laofu），人耳可直接对比。
- **重启后体检**：`node scripts/voice-live-check.mjs`（**不发消息**，走操作者通道 dryRun：
  合成 → 探测 → 报时长）。已通过：桥接认识 text，合成 126KB 音频。
- **一条命令真机发语音**：`node scripts/voice-send-test.mjs --key group:xxx --yes`
  （不带 `--yes` 只预演）。白名单目标见 `config.allow`。
- **TTS 缓存有上限**：`voice-tts.js` 每次合成后 `pruneCache`（默认 400 个 / 150MB，按 mtime 删旧），
  避免长期运行把 `state/voice-tts` 堆到几万个文件。
- **修了一个会误伤语音的 bug**：引擎能力原来要 `load()` 之后才有，导致「默认音色是 Piper」时
  qwen3 永远不被选中（预设音色全 503）。改成 `static_caps(path)` 静态声明 + 回归测试。

### 没验证 / 下一步

- **配置已开**（`node scripts/voice-activate.mjs`，备份 `_backups/config.json.bak-voice-<时间>`）：
  `voice.enabled=true`、`tools.sendVoice=true`、`tts={enabled,baseUrl:8765,maxChars:120,character:xiaoyu}`。
- **唯一没做的：重启**。桥接进程（PID 396）与 MCP 工具服务（`mcp-snowluma-safe.js`）仍在跑老代码，
  不重启就看不到 `text` 参数。重启会打断正在进行的 QQ 会话 → 需用户确认。
  重启后验证方式：让模型调一次 `qq_send_voice(text="在吗", key=<会话>)`，看返回 `source:"tts"`、
  `verified:true`，并在手机上听到语音条。
- **聊天默认音色已切到 Piper**（`voxd` 的 `[voice].default` 与 `xiaoyu` 映射 → `huayan`），
  否则现在激活会每句话等十几秒。Qwen3 的音色（vivian/serena/laofu）保留，显式指定才用。
- **主引擎性能结论是坏的**：Qwen3-TTS 0.6B 在本机 RTF 6.42（CPU 发射瓶颈，不是显存），聊天不可用；
  顺手证实 0.6B CustomVoice 会在内部**静默丢弃 instruct**（官方源码 `if size in "0b6": instruct=None`），
  引擎现在如实声明 `instruct=false`，不会假装语气生效。
- 要不要「每条都自动配音」还没做（用户选了模型自主）。
- **Piper 控不了情绪**：`length_scale` 在 ±20% 内几乎不改时长（0.8 与 1.0 都是 2.61s），
  所以标签在 Piper 上只是「标了但不生效」；要真情绪必须换 instruct 引擎（CosyVoice3 等）。
- **Kokoro 装不上**：所有版本都要求 Python `<3.13`，本机 venv 是 3.13.7；要用得另建 3.12 环境。
- **F5-TTS 权重拉不动**：能 pip 装，但权重只在 HF，hf-mirror 实测 **32KB/s**（1.35G ≈ 12 小时）。
  安装时还把 `transformers` 顶到 5.20.2，把 qwen-tts 弄坏；已回钉 `==4.57.3` 并验证 qwen3 仍能合成
  （5.36s 音频，74s 含加载）。**教训：装任何第三方 TTS 包后都要回钉 transformers 并重跑测试。**
- **WSL2 没有网络**：`/etc/resolv.conf` 缺失、`ip route` 空、localhost 转发报错 —— 所以 CosyVoice
  改在 Windows 上用独立 venv 跑（`.venv-cosy` + `scripts/cosy_worker.py`，端口 8766，
  双击 `voice\cosy-worker.bat` 启动）。
- **CosyVoice2 情绪可用、速度不行**：短句 RTF 5.9、17 字 2.2、61 字 1.3；情绪确实生效
  （同句 自然3.36s / 轻快3.36s / 不耐烦2.96s / 难过5.00s）。试听 `voice\audition\coco__*.wav`。
  已接成 voxd 的 `remote` 引擎（`voice=coco` 等 3 个音色），**默认仍走 Piper**，不影响 QQ 链路。
- **双引擎分流已启用（用户选 A）**：`huayan` 与 `huayan-cosy` 是同一声音的两个孪生
  （cosy 版用 piper 音频克隆，所以不换人）。带 `[语气]` 标签的短句走 cosy（3~4 秒），
  其余走 piper（0.2 秒）。`cosy_max_chars=40`，设 0 即关闭；worker 没起来自动退回 piper。
- **压测结论**：50 条连续合成 0 失败，p50 **435ms** / p95 655ms（Piper，含落盘与缓存写入）；
  第二轮 347→414ms，说明第一轮的 610ms 是系统噪声，不是越跑越慢。
- 回滚：`git checkout config.json` 或拷回上面那份备份（再重启）；
  代码回滚：`src/voice-tts.js` / `scripts/voice-e2e.mjs` / `scripts/test-voice-tts.mjs` /
  `scripts/test-voice-route.mjs` / `scripts/voice-activate.mjs` 删除；`bridge.js` 四处
  （import / voiceCfg.tts / synthesizeVoiceText / 两个路由分支）；harness 五处；
  `mcp-snowluma-safe.js` 的 schema 与 handler；prompt 第 16 条；config.example.json 的 tts 块；
  `test-audit.mjs` 两条清单项。

---

## 快照：2026-10-24 14:25–14:55（设置页 IA 清理 + 项目残留清理）

### 本轮需求（用户原话）

> 「可以清除垃圾键，顺便，对整个设置页面都做一次大清理，你不觉得人设和角色这两个栏目重复了吗，
> 把相同的功能去重，把不同的功能合并到一起，其他的布局规划你也看看，每个栏位里都把最关键的
> 几个设置留下，其余全部在每个栏位里折叠成高级设置」
>
> 「对整个项目的架构和设置的源代码都做一次整理和检查，去除残留、无用、多余、重复，
> 做好后仔细检查，保证功能无丢失，代码不冲突，尽量无bug」

### 结论

- **人设 / 角色合并**：`PersonaEditor` 嵌入「角色」页；`TABS` 删除 `persona`；
  角色包、当前人格卡、人格卡备份、角色列表在同一页；存档/回档收进「高级设置」。
- **每页首屏只留关键卡**：新增 `AdvancedSettings` + `Section.collapsible`；
  QQ / B站 / 记忆 / 对齐 / 扩展 / 诊断 / 概览 / 角色都改为「关键卡 + 高级设置」；
  记忆卡拆成 `summary` / `details` 两态，全量卡和同步参数只在展开时挂载。
- **清理时修掉的真 bug**：
  - Token 页「只留总额度」引用不存在的 `onReplace`（点击会 ReferenceError）→ 改用 `onChange`；
  - 角色页 `detail` 状态只写不读，还多打一次 `/characters?id=` → 删除；
  - 多个组件未使用 props/imports，核心模块未用 imports 一并清掉。
- **残留清理**：
  - 空文件 `相关代码：（唯一权威）、、、。`、`plugins/surfcore/presets/.wtest`、
    已无对应标签页的 `plugins/surfcore/docs/ui-persona.png`：备份后删除；
  - `src/core/session-router.mjs` + `.test.mjs`（只被自己测试引用、没接进 bridge）
    移到 `_backups/repo-cleanup-20261024/` 后从源码移除；
  - 真实 `~/.dsh/surfcore/bili.config.json` 的垃圾键 `n` 已删（备份
    `~/.dsh/surfcore/backups/bili.config.json.bak-garbage-*`），
    `night.windows` 9 个窗口不变。

### 验证

- `npm --prefix plugins/surfcore run ui:audit`：11 个标签页、**785 个非只读控件全部能改**，
  0 失败；仅 3 个故意只读（B站 自己的 mid/昵称、写日记锁定开）。
- `node plugins/surfcore/scripts/test-client-contract.mjs`：新增人设/角色合并、高级设置、
  `onReplace`、记忆 summary/details 等契约断言，通过。
- `npm test --prefix plugins/surfcore`、`npm run test:audit`：全绿。
- 垃圾键清理：删除前后都断言 `night.windows` 数量/内容不变。
- 手工点 Token 页「只留总额度」：无异常；QQ/B站/其他分项清空，总额保留 ¥8（本地草稿，未保存）。

### 没验证 / 下一步

- **没有在真实配置上点保存**：所有 UI 审计只改 React 本地状态、每项后「撤销改动」；
  保存链路由 `test-admin-config-api.mjs` 的临时目录 POST `/config` 覆盖。
- **截图已重新生成**：`npm run ui:tabs` 通过（`ui-characters` 现在是合并后的角色页；
  `ui-qq-fishguard` / `ui-qq-purpose` / `ui-qq-closure` / `ui-bili-keywords` 均能展开高级设置后截到）。
- **`session-router` 是计划中的 P2 模块**：评估后判定当前未接线；如后续要做 per-conversation
  路由，从 `_backups/repo-cleanup-20261024/src-core/` 恢复，不要当新代码重写。
- 回滚：代码按文件回退；被删残留都在 `_backups/repo-cleanup-20261024/`。
  真实配置只动了 `bili.config.json` 的垃圾键，备份在同目录。

---

## 快照：2026-10-24 13:05–13:50（设置页非只读项全量可编辑性修复）

### 本轮需求（用户原话）

> 「我发现一个问题，设置页那里B站的苏醒窗口我怎么删除不了也添加不了，这是改成只读了？
> 之前也有不少次这种问题，类似于输入框不能输入什么的。我现在要求你检查整个设置页面，
> 保证所有的非只读设置都能让用户改动」

### 结论

- **不是只读，是路径写错**：B站 作息窗口的 `onChange` 传了字符串
  `"night.windows"` 给只接受数组的 `setPath`，被按字符拆成 `n.i.g.h.t...` 垃圾键。
  于是“改了”只改到垃圾键，`cfg.night.windows` 没变，下次渲染弹回；
  dirty 还会变 true，看起来像保存了。同类问题还有 QQ 白名单「空名单全放行」。
- **记忆页 B站→QQ 开关是第二个根因**：`checked` 读服务端快照，`onChange` 只写
  `unified.__biliToQqToggle`，两份状态不同源（PITFALLS #16 翻版）。
- **「只同步这些群」是第三个**：每次按键 `split/join`，中文逗号会被吞，
  第二个群号永远输不进去（PITFALLS #49 翻版）。
- **修法**：`setPath` 增加 `pathKeys()` 归一化（字符串按 `.` 拆、空路径拒绝）；
  调用点同时改数组；记忆开关绑 `biliToQqDraft` 草稿；群列表换 `IdListEditor`。
  关键改动在 `plugins/surfcore/lib/client.js`。

### 验证

- 新 `npm --prefix plugins/surfcore run ui:audit`：真机 12 个标签页、
  **782 个非只读控件逐个真实输入/点击全部通过**，仅 3 个故意只读
  （B站 自己的 mid / 昵称、写日记锁定开）。
- `node plugins/surfcore/scripts/test-client-contract.mjs`：新增路径归一化 +
  窗口/白名单/记忆开关/群列表接线断言，通过。
- `node plugins/surfcore/scripts/test-admin-config-api.mjs`：新增作息窗口
  POST `/config` → 文件原样落盘断言，通过。
- 手工复验：窗口 9→10→9、时间 `10:00`→`10:0021`；白名单全放行开关 true；
  记忆 B站→QQ 开关 false；`，987654321` 输入后出现 chip。

### 没验证 / 下一步

- **没有点「保存」写真实配置**：`night.windows` 的保存链路用临时目录 API 测试覆盖；
  真机上改完点保存应该会正常落盘。若用户当场保存后 B站 作息没变，先看
  `~/.dsh/surfcore/bili.config.json` 的 `night.windows` 是否已变。
- 客户端走 `~/.dsh/plugins/surfcore` 软链，**刷新设置页即可加载新 client.js**，
  不用重启 DSH；桥接/生物钟不用重启（作息配置下一轮 tick 读取）。
- 回滚：`git checkout -- plugins/surfcore/lib/client.js` 即可；本轮没有改任何真实配置。
- 后续新增自定义编辑器，默认先跑 `ui:audit`；它只改本地 React 状态，不点保存。

---

## 快照：2026-10-24 12:40–12:57（对话收尾判断：结束不是终止）

### 本轮需求（用户原话）

> 「新加入一个对话结束终止判断，以后不管在群里还是QQ里都这样。比如说，小肥鱼说『原来弥叭也会脸红的呀』
> 『那咱们扯平啦，谁都不许先低头』，弥回『嗯嗯』——我发完『嗯』之后就可以进行一次对话是否可以结束的判断，
> 是的话就不用回复了，这是为了以后不用每一句都回复。判定的话，你可以找几个参数，比如小咪自己是否想继续
> 此话题的意愿、对方是否想继续的意愿……总之我就是要一套合理的话题结束机制，让她更像真人。
> 记住一次对话总是有结束的，结束不是终止，而是一段信息输出的合理结束，和下次更好的开始。」

### 结论

- **判断是「建议」，不是硬静音**：`src/conversation-closure.js` 从六类信号算 `continue / linger / close`：
  ① 我最后一句是不是收尾式；② 对方最后一句是提问/请求/实质/附和/道别；③ 我还有没有想说没说的；
  ④ 话题闭环没闭环；⑤ 有没有未答提问；⑥ 节奏疲没疲。代码只给参数和建议，收不收由模型调用
  `qq_close_conversation` 决定。硬规则只有一条：**对方明确在提问/求助且还没答时，拒绝收尾（409）**，
  防止把「结束」当逃避。
- **close ≠ 潜水，这是本轮最关键的边界**：close 不改 `wakeConfig`、不要求沉睡前观察、不取消唤醒；
  对方再找你、开新话题、私聊都会照常醒。`mark_read` 只是「划走消息」，close 留下
  `closure={at,reason,summary,nextOpening,cooldownUntil}`，下次唤醒提示里带「上次这段怎么收的 / 下次可以怎么接」。
  **不能把 close 做成「潜水」**：那会为了不等 5 分钟而永久静音，正好相反。
- **冷却只压三类软唤醒**：`probability`（普通消息概率）、`replyCheck`（发完 30 秒的回复检查）、
  `proactiveCheck`（冷场主动机会）。`atMention / nameMention / question / keyword / poke / speaker /
  private` 一律不压——结束不是把人关掉。群聊里普通闲聊不重开冷却；被直接叫到/引用/提问/道别才重开；
  私聊对方一开口就是新的开始。
- **提示词必须改「回复后不要立刻结束」**：旧规则要求回复后先等 30 秒~10 分钟，和用户要的
  「发完嗯就判断能不能结束」直接冲突。现在改成：先判断是否自然收尾，收尾用 close；还想聊才 wait。
  同时把「自然收尾不是潜水、不用 5 分钟观察」写进 preset，否则模型会为了收尾硬等观察窗口。

### 已做

- 新 `src/conversation-closure.js`（纯逻辑，无 I/O）：配置归一化、消息分类（ending/question/request/ack/
  substantive/settled）、`assessConversationClosure`（六类信号 + 分数 + reasons + advice）、
  `closurePromptBlock`（每次唤醒注入判断参数与收尾/潜水边界）、`makeClosureRecord` /
  `normalizeClosureRecord` / `formatClosureRecord` / `closureStatus`、`closureSuppressesWake`、
  `reopenClosure`、`closeGate`。
- `src/bridge.js`：
  - `cfg.socialV2.closure` 默认合并（默认开、冷却 20 分钟、无未答提问才允许收尾）；
  - `socialV2.tools.closeConversation` 默认 true；状态持久化 `closure`（跨重启保留）；
  - 新 `closeConversationV2`（写结束点、按安全水位确认已读、保持 wakeConfig、豁免 preSleep）；
  - reserved2 入站：`noteClosureReopenV2`（私聊/直接叫到/提问/道别重开，普通群聊不重开）；
  - 唤醒前冷却：`closureSuppressesWake` 只跳概率唤醒；`scheduleReplyCheckV2` / `scheduleProactiveCheckV2`
    跳过冷却期；
  - `buildWakePromptV2` 注入【对话收尾判断】与上次收尾；`replyCheck` 文案改为「没人回 = 可能已自然结束」；
  - `POST /api/socialV2/close`；`/api/socialV2/state` 与 `/api/socialV2/prompt` 返回 closure 摘要。
- `src/mcp-snowluma-safe.js`：新工具 `qq_close_conversation`（key/token/throughSeq/reason/summary/
  nextOpening），注册期受 `socialV2.tools.closeConversation` 控制。
- `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`：工具协议第 7 条加 close；新增
  【对话收尾：结束不是终止】；重写【回复后】；【必须・沉睡前】明确 close 不是潜水；私聊规则加自然终点。
  已重新生成 `plugins/surfcore/presets/qq-chat-v2.patch.yml`。
- 设置页：QQ 页（目的机制卡下方）新增「对话收尾判断」卡片：开关 / 软冷却 / 拒绝未答提问 /
  注入判断 / 摘要上限 + **最近一次收尾**（收在哪、下次怎么接、当前判断、软冷却剩余）；
  `/api/status` 增加 `closure` 汇总，插件 `mapStatusPayload` 透出；工具开关自动出现「对话收尾」。
  另保留同参数的 QQ 高级字段组，便于搜索。
- 测试：`scripts/test-conversation-closure.mjs`（12 组）、`scripts/test-closure-wiring.mjs`（7 组），
  已登记 `test-audit`；`test-qq-preset-contract` 新增收尾契约断言。
- `config.json` / `config.example.json`：新增 `socialV2.closure` 与 `tools.closeConversation`（真实
  config 已备份到 `_backups/config.json.bak-closure-*`）。

### 验证

- `node scripts/test-conversation-closure.mjs` → 12/12；
- `node scripts/test-closure-wiring.mjs` → 7/7（含：close 不改 wakeConfig、不发 QQ 消息；
  对方提问 409；close 豁免 preSleep；冷却只压 probability/replyCheck/proactiveCheck；
  私聊重开/群聊普通消息不重开；关掉开关 403 且不注入）；
- `node scripts/test-qq-preset-contract.mjs` → 8/8；
- `node scripts/build-agent-preset-patches.mjs --check` → 一致；
- `node plugins/surfcore/scripts/test-bridge-status.mjs` → 通过（新增 `closure` 透传断言）；
- `node plugins/surfcore/scripts/test-client-contract.mjs` → 通过（新增卡片/字段/工具标签断言）；
- `node plugins/surfcore/scripts/test-host-smoke.mjs` → SMOKE OK；
- `npm test --prefix plugins/surfcore` → 全绿（bridge-status / privacy / client-contract / host-smoke / platform-start …）；
- `npm run ui:tabs --prefix plugins/surfcore` → `qq-closure-card=true`、`qq-closure-copy=true`，
  截图 `plugins/surfcore/docs/ui-qq-closure.png`；
- `npm run test:audit` → **69/69 全绿**（新增 `test-conversation-closure` / `test-closure-wiring`）。

### 没验证 / 下一步

- **真机桥接还没重载**：改的是 `src/bridge.js` 与 MCP 工具注册表，必须重启桥接 + 重启 DSH 才会
  出现 `qq_close_conversation`。本轮只跑了夹具，没发真 QQ。
- **preset 还没装进 `~/.dsh`**：`plugins/surfcore/presets/qq-chat-v2.patch.yml` 已生成，但
  `~/.dsh` 里的安装副本要跑 setup/重装 preset 才会更新；否则真机模型看不到新段落。
- **设置页截图已过**：`ui-qq-closure.png` 里能看到「对话收尾判断」卡片、开关、软冷却、
  「不是潜水」说明；桥接重启后 `overview.bridge.closure` 会带上最近一次收尾。
- 回滚：代码回滚 `src/conversation-closure.js`（删）、`src/bridge.js`、`src/mcp-snowluma-safe.js`、
  `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` + 重新生成 patch；配置把
  `socialV2.closure.enabled` 改 false 即可立刻停用（工具也会被注册期过滤）。

---

## 快照：2026-10-24 11:50–12:10（平台启动开关：QQ / B站 可以只开一边）

### 本轮需求（用户原话）

> 「现在添加一个优化，因为并不是所有用户都想同时开QQ或者B站，所以设置页QQ和B站分别加一个是否启动选项」
>
> 「顺便还有，启动与人格卡中的一键启动保留下来，人格卡因为出现在角色栏了就不用在这里重复显示了，
> 同时启动优化成一键启动、启动QQ、启动B站」

### 结论

- **「是否启动」必须是一份状态 + 五个执行点，不能只是一个 UI 开关**：
  唯一真相是合体层 `~/.dsh/surfcore/config.json` 的 `platforms.start.{qq,bili}`；
  插件加载、2 分钟自愈轮询、概览「一键启动 / 启动QQ / 启动B站」、保存配置时的启停，
  五处全部读同一份。只画 switch 不接管生命周期 = 开关在骗人（PITFALLS #62）。
- **旧字段只迁移一次**：`bridge.autoStart`（旧 QQ 自动启动，默认 false）在 `readUnified()`
  里按「显式 `platforms.start` > `bridge.autoStart` > `platforms.enabled` > 默认」推导；
  保存时把 `bridge.autoStart` 镜像回 QQ 开关，降级/手工读配置不会出现两份相反的值。
- **开关变化立即生效**：保存配置时比较前后值——关掉 B站 就 `scheduler.retire()` + `idleSchedulerStatus()`，
  关掉 QQ 就 `stopBridge()`；打开则拉起。测试环境（`SURFCORE_SKIP_AUTOSTART=1`）只写配置、不真启停。
- **概览不再重复人格卡**：删掉「人设卡」卡片和旧「启动与人格卡」里的路径输入；路径编辑挪到
  「人设」页（`unified.persona.file`），角色包/快照仍在「角色」页。
- **启动区只剩三个动作**：一键启动 / 启动QQ / 启动B站；「只打开 SnowLuma」挪到 SnowLuma 安装卡。
  QQ 关闭时一键启动不打开 SnowLuma；单平台按钮在开关关闭时返回 409 并提示去对应页打开。

### 已做

- `plugins/surfcore/lib/store.js`：`DEFAULT_UNIFIED.platforms.start`、`platformStartsFrom()` 迁移纯函数、
  `readUnified()` 应用迁移、`saveUnified()` 收布尔并镜像 `bridge.autoStart`。
- `plugins/surfcore/lib/index.js`：
  - `platformStartState/platformStartEnabled` + `idleSchedulerStatus`；
  - `startSchedulerNow()` 读 B站 开关（关掉返回 `disabled:true` 且不启动）；
  - `maybeAutoStartBridge()` 改读 `platforms.start.qq`；
  - `/bridge` 新增 `start-qq`（桥接 + 按需 SnowLuma）与 `start-bili`；`start` / `restart` 在开关关闭时 409；
    `start-all` 只拉开启的平台、QQ 关时不打开 SnowLuma；
  - `watchStartupCompletion({qq,bili})` 支持只启动一边的完成弹窗；
  - `/overview` 增加 `platformStart`；
  - `/config` 保存时启停平台，`restartBridge` 在 QQ 关闭时跳过并写 warning；
  - 启动弹窗文案按平台开关裁剪（关闭的一边显示「启动开关关闭」）。
- `plugins/surfcore/lib/client.js`：
  - 新 `PlatformStartCard`，QQ 页 / B站 页顶部各一张「是否启动」卡片；
  - 概览：「启动」卡三按钮、开关状态、去平台页入口；删除「人设卡」卡与人格卡路径输入；
  - 「人设」页新增人格卡路径输入；QQ 卡片「重启」与底部「保存并重启」在 QQ 关闭时禁用；
  - 顶部状态点显示「QQ 关 / B站 关」；SnowLuma 安装卡新增「只打开 SnowLuma」。
- 测试：
  - 新 `scripts/test-platform-start.mjs`（迁移优先级 / 显式值 / 保存镜像 / 非布尔收敛）；
  - 新 `plugins/surfcore/scripts/test-platform-start-host.mjs`（mock 宿主：关闭时不启动、接口 409、start-all 跳过）；
  - `test-client-contract` 增加开关/三按钮/旧标题消失断言；`test-host-smoke` 增加 `/config`、`/overview` 字段断言；
  - `scripts/test-audit.mjs` 与插件 `npm test` 已登记新测试。
- 文档：本快照、ROADMAP、PITFALLS #62、根 README、插件 README。

### 验证

- `node scripts/test-platform-start.mjs` → OK；
- `node plugins/surfcore/scripts/test-platform-start-host.mjs` → OK（关闭时 `scheduler.running=false`，
  `start-qq/start-bili` 409，`start-all` 跳过两边）；
- `node plugins/surfcore/scripts/test-client-contract.mjs` → OK；
- `node plugins/surfcore/scripts/test-host-smoke.mjs` → OK；
- `npm test --prefix plugins/surfcore` → 全绿（含新测试）；
- `npm run test:audit` → **67/67 全绿**（新增 `test-platform-start`）。
- **真机重载（12:0x）**：用 plugin_manager 把 `include:surfcore` 关再开，
  `GET /dsh-surfcore/api/overview` 已返回 `platformStart:{qq:true,bili:true}`，
  `scheduler:{running:true,disabled:false}`；`/config` 的 `unified.platforms.start` 也已是两边 true。
- **真机 B站 开关往返**：`POST /config {unified.platforms.start.bili=false}` → 200，
  warning「B站 启动开关已关闭：生物钟已停止」，`/overview.scheduler` 立刻变成
  `{running:false,disabled:true,reason:"disabled"}`；再打开 → 200，warning「生物钟已启动」，`running:true`。
- **真机单平台启动**：`POST /bridge {action:"start-bili"}` → 200「本来就在跑」；
  `POST /bridge {action:"start-qq"}` → 200「桥接已经在跑；已启动 SnowLuma 并打开控制台」。
  ⚠️ 这次测试按设计真的打开了本机 SnowLuma（5100 需要扫码登录），不是回归。
- **截图**：`npm run ui:tabs --prefix plugins/surfcore` 通过；新增
  `overview-start`（三按钮 + 两开关状态 + 旧标题/人设卡都消失）、`qq-start-card`、`bili-start-card` 断言；
  截图 `plugins/surfcore/docs/ui-overview-start.png`。

### 没验证 / 下一步

- **QQ 关闭 → 桥接停止** 的真机路径还没走：建议确认没有在途 QQ 回合时，把 QQ 开关关掉保存，
  看 `/overview.bridge.running=false`、`start-qq` 返回 409；再打开确认桥接起来。
  （B站 的关闭/打开已经真机走过；QQ 走的是同一段 `handleConfig` 分支，但停桥接会中断会话，需你决定时机。）
- **重启 DSH 后的自动启动**：本次只验证了「热重载后按开关启动」，没重启 DSH 验证
  「关掉 B站 后重启 DSH 不会自动启动」——代码路径是 `startSchedulerNow()` 同一判断，风险低。
- 回滚：把 `platforms.start` 改回两边 true（或不写，默认 true）；代码回滚 `store.js/index.js/client.js`
  三个文件即可，旧 `bridge.autoStart` 仍被保存时镜像，不会丢。

---

## 快照：2026-10-24 03:40–04:20（目的机制：定期从 QQ+B站记忆里提炼目的，主动找主人）

### 本轮需求（用户原话）

> 「我构思了一个目的机制，我要求你做一个可以定期的稳定的、主动找主人搭话的机制，原理是，
> 小肥鱼可以根据近期QQ+B站的记忆，从之中提取出“目的”，这目的就像人一样，从信息中寻求想要了解、
> 想要做的事等等，然后根据“目的”，将所想🧀分享给主人，或者向主人进行索取。」

### 结论

- **「定期」不能靠一次性长定时器**：桥接重启 / 时钟跳变 / DSH 掉线都会丢枪（早安已经丢过 08:00）。
  现在用 **60 秒 tick + `nextFireAt` 落盘**，每次重新算「现在该不该出发」；重启时把上次在途回合
  记成 `interrupted`，等一个初始延迟再来，**不补发**（否则会连发好几条）。
- **回执不能看 `sessions.prompt` 的 `command.text`**：那个槽只在 slash command 时出现。
  她的最终文本来自事件流 `turn/end`（`ended.text`），是否真发到 QQ 来自 `recordSentMessagesV2`。
  两者都在桥接里，所以目的状态在 bridge 侧对账（PITFALLS #58）。
- **目的不是一句随机问候，也不是从一句话直接读出的结论**：`purpose-engine` 从 QQ 私聊/群聊、
  B站 视频/动态/想法、记忆卡、她自己的 activeTopics/pendingThoughts 里抽素材；
  先用「注意力打分」挑出值得看的（需求亲和 / 自我相关 / 主人相关 / 情绪强度 / 未解决 /
  重复社会证明 / 新鲜度 / 时间衰减），再抽象成 9 类需求（玩/学/装/陪/关心/分享/自我/创作/体验），
  用轻量 appraisal 产生情绪（好奇/兴奋/羡慕/寂寞/担心/得意/亲近/无聊/好笑），
  最后落成 **目标假设**；驱动向量 `drives` 随时间衰减，被「多久没和主人说话」和最近素材推高，
  真发出去才明显下降。
- **目标假设的核心是「归属」**：群友聊游戏先记成「群友的目标」；同一话题重复 ≥3 次、直接点她、
  或过去有同类兴趣，才升级成「我也有点想试」。视频说插件好用先记成「媒体主张」，
  重复/夸好用/自我相关才升成「想装」，而且 `risk≈0.55` 只能问主人能不能。
  每个目标带 confidence/value/urgency/risk/action/nextStep/status/evidence；
  主人的回复（正面/负面/中性）会在下一轮更新 confirmed/rejected，问两次没回音会衰减。
  观察账本的 `seenIds` 保证同一批旧素材不会每轮抬置信度（PITFALLS #60）。
- **人格卡/记忆卡载入即可生成动机**：`analyzePersona` 从人格卡抽 9 维动机先验
  （爱玩/黏人/技术宅/爱分享…），`deriveDrives` 把它加到驱动上；`formGoalHypotheses`
  生成 `source:'persona'` 的起始目标。记忆卡里的钉住/锚点/初次相遇即使超过 30 天也纳入素材。
  即使今天没有 QQ/B站 新消息，只要人格卡有内容也能形成「想找主人说话/想玩/想折腾」的动机。
  换角色时目的状态按角色隔离（`characters/<id>/purpose-outreach.json`），不继承上一个角色；
  桥接启动 1.5 秒后 `warmPurposeState` 先只生成目标假设（不投递），设置页/状态接口马上能看到动机。
- **默认开**：`purpose.enabled` 默认 true；默认 2.5~5 小时一枪、一天最多 4 次、23:30~08:30 不打扰、
  主人刚说过话/她刚发过言 30 分钟内不插嘴。全部可在设置页改。

### 已做

- 新 `src/purpose-engine.js`（纯逻辑，无 I/O）：配置归一化、安静时段、`planNextFire`、
  `evaluatePurposeTick`（disabled/mode/dsh/paused/quiet/daily-max/waiting/busy/owner-active/not-friend/budget）、
  素材采集（QQ / B站 / 记忆卡 / 心里话，QQ 号脱敏、拍一拍跳过）、`analyzePersona` 人格先验、
  需求词表 / 注意力打分 / `deriveDrives` / `appraiseMaterial` / `satisfyDrives`、
  **目标假设层**（`formGoalHypotheses`：归属 / 置信度 / 价值 / 紧迫度 / 风险 / 反馈；`goals` + `observations`）、
  目标候选与去重、
  提示词（人格卡/记忆卡/身份/驱动/情绪 + 素材 + 目标假设 + 发送方式 + 内部备忘格式 + 隐私/索取边界 + 反注入提示）、
  `parsePurposeMemo`（【目的】【需求】【情绪】【类型】【状态】【待续】）、pending 增删、状态迁移与摘要。
- `src/bridge.js`：
  - `cfg.purpose = normalizePurposeConfig(file.purpose, { ownerQQ })`（缺省即默认开）；
  - 启动运行时：`characters/<id>/purpose-outreach.json`（无角色回退 `state/`），60 秒 tick，`ensurePurposeSchedule`，`interrupted` 处理；
  - `runPurposeOnce`：硬闸门（模式/owner 白名单/DSH/暂停/安静/每日上限/主人空闲/忙/token 额度/好友）
    → 素材 → 候选 → 提示词 → 普通 `deliverPrompt`（不冒充 `sendWakePromptV2`，避免多余的收尾提醒回合）；
  - 回执：`recordSentMessagesV2` 记 `sentTexts`；`turn/end` 调 `notePurposeTurnEnded`，按
    `sendToolSucceeded || sentTexts.length` 判 sent/silent/failed，20 分钟 watchdog；
  - 投递成功后把这次计入 `st.wakeTimes`（私聊每日唤醒上限/token 额度照常生效）；
  - 新接口：`GET /api/purpose/status`、`POST /api/purpose/preview`（零副作用、令牌脱敏）、
    `POST /api/purpose/run`（真发，force 跳过排程/安静/空闲，不跳额度/好友/白名单）；
  - `/api/status` 增加 purpose 摘要。
- 插件：`plugins/surfcore/lib/index.js` 代理 `purpose-status / purpose-preview / purpose-run`；
  `plugins/surfcore/lib/client.js` QQ 页新增「主动找主人 · 目的机制」卡片（开关/间隔/每日上限/安静时段/
  空闲阈值/素材窗口/预览/立即试一次/状态），并在 `test-client-contract` 里钉住。
- `config.example.json` 增 `purpose` 默认块；`scripts/audit-bridge-harness.mjs` 注入 purpose-engine
  并暴露 `runPurpose/purposeState/notePurposeTurnEnded/notePurposeOutbound`。
- 测试：`scripts/test-purpose-engine.mjs`（19 组：含人格卡动机 / 目标归属 / 置信度升级 / 反馈 / 驱动满足）、
  `scripts/test-purpose-wiring.mjs`（8 组：含启动预热不投递），已登记 `test-audit`。
- 文档：本快照、ROADMAP 已完成项、PITFALLS #58/#59/#60/#61、`docs/guides/PURPOSE_OUTREACH.md`。

### 验证

- `node scripts/test-purpose-engine.mjs` → 19/19；
- `node scripts/test-purpose-wiring.mjs` → 8/8（预览不建会话/不改状态；强制投递落到 private:owner；
  发送 + turn/end 回执 → sent + 待续 pending；silent；安静时段；启动预热只写 goals 不投递；关闭/模式不对）；
- `npm run test:audit` → **66/66 全绿**（新增 2 个）；
- `npm run test:regressions` → 全绿；`npm test --prefix plugins/surfcore` → 全绿；
- 真实 state 只读预览（`node scripts/purpose-inspect.mjs`，不投递）：当前角色「小咪」
  素材 36 条（QQ 18 / B站 10 / 记忆 8，人格卡 traits：陪/关心/自我）；目标假设 15 个，
  候选覆盖「自我/主人/群友/视频」四种归属；含 install 高风险→只能 ask、
  member 目标→只能 share 的提示。没有留下跑真 QQ 的入口。

### 没验证 / 下一步

- **桥接已多次真机重启**：旧 PID 33624 → 35044（04:19，首版）→ 15596 → **34316（04:53，加载
  `lastMaterialCount/lastCandidateCount` 与预热候选计数）**。`start.bat` 守护循环，
  `DSH_WEB_URL=http://127.0.0.1:50874`。最新状态：
  `素材 36 / 观察 46 / 目标 18 / 候选 6 / 今天 1/4 / next 08:30`。
- **真机只读接口已验证**：`GET /api/purpose/status` → 200（enabled=true、mode=reserved2、
  countToday=1、nextFireAt=08:30、materialCount=36、candidateCount=6、goalCount=18）；
  `POST /api/purpose/preview` → 200（素材 36、目标 15/18、令牌已脱敏、前后状态不变）；
  `POST /api/purpose/run {force:false}` → 409 `reason=quiet`（安静时段硬拦，没有发 QQ）。
  目的状态文件：`characters/char-mvk6wth4/purpose-outreach.json`（18 goals / 46 observations）。
- **插件宿主已重载（04:21 / 05:0x 两次）**：用 plugin-manager 把 `include:surfcore` 关再开；
  插件代理 `purpose-status/preview` 用 DSH 离线铸造 Cookie 实测 200。
  设置页 QQ 页卡片现在同时展示：
  - **架构链路**：素材 → 观察 → 目标假设 → 候选 → 今天，带真实计数；
  - **当前驱力条**（陪/自我/玩/装/关心…）与**前 3 个目标假设**（归属/置信度/风险）；
  - **节奏预设**（保守/默认/活跃）+ 三组可折叠设置：
    「节奏与安静」「素材与目标」「重试 / 上限 / 目标」；
  - 所有 `purpose.*` 字段（含 `initialDelayMinMs/biliWindowDays/maxMaterials/minMaterials/
    maxCandidates/retryMs/maxAttempts/promptMaxChars/ownerUin`）都可编辑。
  截图：`plugins/surfcore/docs/ui-qq-purpose.png`（链路/驱力/目标）、
  `ui-qq-purpose-settings.png`（节奏与安静表单）；`ui-tabs.mjs` 新增
  `qq-purpose-card` 与 `qq-purpose-settings` 断言。
- **第一次真发已验收（2026-10-24 04:42，用户选择「现在真发一条」）**：
  `POST /api/purpose/run {force:true}` → 200 delivered；选中的是 persona 基线目标
  `self/connect`（想找主人说说话，confidence 0.45，risk 0.05）。
  04:42:56 桥接日志 `[reserved2] 工具统一发送 private:3287064288: 成功 2/2 条`；
  04:42:59 `[目的] 回合结束：sent`；她把内部备忘写成
  「半夜睡不着，想找弥叭陪 wo 说两句话」。
  状态：`countToday=1`、`lastOutcome=sent`、goal `attempts=1/lastActionAt=…/status=active`、
  `nextFireAt=08:30`（按 gap 排到 07:xx，落在安静时段后推到 08:30）。QQ 私聊实际收到 2 条，
  端到端闭环完成。
- 人格卡/记忆卡内容编辑后，下一轮 tick 会重新读取（不需要重启）；换角色仍走桥接重启，
  目的状态按新角色目录隔离。
- 桥接由 `start.bat` 守护，但 `DSH_WEB_URL` 是启动时写死的 50874；如果 DSH 换端口，
  需要从设置页/插件重新「重启 QQ 桥接」或重跑 `start.bat` 带上新 URL。
- 没有故意制造「DSH 在回合中途重启」现场；靠 `interrupted` + watchdog 单测覆盖。
- 一键「立即试一次」会真的发 QQ 私聊（会弹 confirm），不要连点。
- 回滚：设置页关掉「启用目的机制」（或 `purpose.enabled=false`）即可停；代码回滚删
  `src/purpose-engine.js` + 还原 bridge.js/插件三处/`config.example.json`/测试登记。

---

## 快照：2026-10-24 02:37–03:10（上线补历史消息：每次上线补看离线期间错过的群消息，默认开）

### 本轮需求（用户原话）

> 「QQ里加一个每次上线查看历史消息功能，以防错过群友历史消息，可在设置里设置，默认勾选打开」

### 结论

- **SnowLuma 不会补发离线消息**：桥接/QQ 掉线期间的群消息只存在 QQ 服务端；重新上线后
  必须用 OneBot 历史接口（`get_group_msg_history` / `get_friend_msg_history`）主动补。
- 真机只读探测确认两个接口都可用（`group 767098733` 返回 5 条、私聊返回 3 条），
  不需要新依赖，也不碰 SnowLuma 运行时。
- 新配置 `socialV2.history`，**缺省 enabled=true**：
  `enabled / limit(30) / maxAgeMinutes(720) / wake(true) / includePrivate(true)`。

### 已做

- 新 `src/history-catchup.js`（纯函数）：配置归一化、时间水位（含 5 秒容差，
  防止本地 `Date.now()` 比 QQ 消息 `time` 晚几秒而漏掉停机前最后几条）、候选过滤
  （水位/时间窗/未来时钟漂移/重复 messageId/黑名单/最新 N 条）、摘要与提示词行。
- `src/bridge.js`：
  - 启动加载时 `cfg.socialV2.history = normalizeHistoryConfig(...)`，旧 config.json 没这段也默认开；
  - `runHistoryCatchUp()`：桥接 `bot.on('open')`、heartbeat/bot_status/get_status 的
    「账号上线」边沿触发；只处理**已完成 bootstrap** 且仍在白名单的会话；
    10 秒节流，重连风暴不会反复请求；
  - 历史消息按 messageId + 时间水位去重后并入 `recentMessages` / `unread`，标 `history=true`；
    自己以前发的消息只进 recent、不进未读；黑名单用户的历史消息直接过滤；
  - 真补到群友消息且 `history.wake=true` 时 `scheduleWakeV2(key, 'history')`，
    新增 `history` 唤醒优先级（25，低于真实消息、高于主动机会）与专属提示词；
    唤醒快照带 `history=true` 时额外提醒「是旧消息，不要当成刚刚发生」；
  - `saveSocialV2State()` 持久化 `lastHistoryMessageTime / lastHistoryCheckedAt / lastHistoryCatchup`；
  - 新只读/管理接口 `POST /api/socialV2/history-catchup`（控制台手动触发，列为 adminOnly）。
- 设置页两处入口：控制台「二代仿真 → 上线补历史消息（history）」（含「立即检查一次」按钮）
  与 SurfCore 设置窗口 QQ 页「二代 · 上线补历史消息」；`config.example.json` 补默认块。
- 测试：新 `scripts/test-history-catchup.mjs`（纯逻辑 + 真实 bridge.js VM 夹具网关），
  `scripts/test-audit.mjs` 已登记；插件 client contract 增加字段断言。

### 验证

- `node scripts/test-history-catchup.mjs` → OK（默认开、关闭不请求、水位过滤、重复不二次入库、
  黑名单不绕过、history 提示词/快照标记、wake 开关、非 reserved2 跳过、未 bootstrap 跳过）。
- `node plugins/surfcore/scripts/test-client-contract.mjs` → OK；`npm test --prefix plugins/surfcore` → 全绿。
- `node scripts/test-console-static.mjs` → 全部通过（新增控件 ID 唯一、主脚本可解析）。
- `npm run test:audit` → **64/64 全绿**（本轮新增 `test-history-catchup`；需在允许 spawn 子进程的环境跑，
  否则 `test-audit-setup` / `test-qq-model-view` / `test-bili-state-paths` 会因 workspace-write 沙箱
  报 `spawn EPERM`，那不是断言失败）。
- `npm run test:regressions` → 全绿；`node scripts/test-qq-preset-contract.mjs`、
  `node scripts/test-token-economy.mjs` → 全绿。

### 没验证 / 下一步

- **桥接还没重启**：当前运行的是旧代码，所以「启动/账号上线自动补历史」的真机路径尚未触发。
  重启后看 `state/bridge.log` 里的 `[history]` 行，或控制台点「立即检查一次」；
  真机验证时注意：默认 `wake=true` 会唤醒 AI 看历史，可能产生一次模型回合（会花 token）。
- 没有故意制造「QQ 掉线数小时」现场；靠 `lastIncomingAt` 水位 + 历史接口只读探测覆盖。
- 私聊历史只在白名单会话上补；`includePrivate=false` 可关。
- 回滚：设置里取消勾选（或 `socialV2.history.enabled=false`）即可停止请求；
  代码回滚只需删 `src/history-catchup.js` + 还原 `bridge.js`/两处设置页/`config.example.json`。

---

## 快照：2026-10-24 01:50–02:05（长文「5000 字拆 10 条」：把硬拦前移到提示词）

### 本轮需求（用户原话）

> 「现在如果有那种qq群里让小肥鱼连续回复大量消息的情况（比如白天402群里，小肥鱼因为5000字太多，
> 群友说拆成10条回复），这种情况优化了吗」

### 结论

- **硬上限早就有**：单条 >500 字直接 400；一次醒来最多 8 条（`maxOutboundPerTurn`），
  数组按条数算，第 9 条 429。10 条不会真的发出去。
- **但体验只优化了一半**：模型可能先按群友要求拆 10 条撞 429，再浪费一轮去改。
  本轮把「长文先总结」写进唤醒提示词 / 429 与 400 错误文案 / MCP 工具描述 / preset 规则。

### 已做

- `src/bridge.js` 唤醒提示词：明确「5000 字长文拆 10 条 → 不要逐条搬运，先总结 1~3 句/挑重点；
  确实展开也最多 8 条、每条 ≤500 字」。
- `src/token-guard.js` 429 文案、`src/bridge.js` 单条超长 400 文案：补「先总结/挑重点，不要拆 10 条刷屏」。
- `src/mcp-snowluma-safe.js`：`qq_send_message` / `qq_send_burst` 描述补 8 条上限与长文规则。
- `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`【分条与节奏】补长文规则；
  重新生成 `plugins/surfcore/presets/qq-chat-v2.patch.yml`（同时修掉之前的 preset 漂移）。
- 测试：`test-token-guard` 增加 10 条/文案/提示词/MCP/preset 断言；preset patch/mcp 测试全绿。

### 验证

- `node scripts/test-token-guard.mjs` → OK；
- `node scripts/test-agent-preset-patches.mjs` → 全绿（`--check` 不再漂移）；
- `node scripts/test-qq-preset-contract.mjs` → 7/7；
- `node scripts/test-mcp-safe.mjs` → OK（工具仍在）；
- 桥接已重启加载新提示词（`/api/status` 正常，`reserved2`）。

### 没验证 / 下一步

- **一代 `reserved` 的自动分条路径**（`isSocialEnabled()` 只认 `reserved`）仍不看
  `maxOutboundPerTurn`；当前实际模式是 `reserved2`，工具路径已覆盖。若以后切回 `reserved`，
  需要给 `planSocialTimeline`/`sendBurstToQQ` 补一个「每回复最多 N 条」的独立闸。
- 没有故意在真群让人发 10 条做真机撞墙（避免打扰群）；靠单测 + 桥接源码契约。
- MCP 工具描述要等 DSH 重启/重连 MCP 才会刷新；唤醒提示词已即时生效。

---

## 快照：2026-10-23 22:30–23:10（每日 token 额度：QQ / B站 / 其他 / 总额 + 80% 每天一次）

### 本轮需求（用户原话）

> 「我注意到你给QQ功能加了个8元token额度总上限……现在我需要一个token消耗总额管理终端，展示在设置页，
> 要求可以分别管理QQ和B站每日使用token额度的上限（可以填人民币符号，也可以填token数），
> 也可以一键设置整个surfcore插件的token总额。除了QQ和B站，surfcore这个插件如果有其他花费token的行为
> 也要一并加上来。当日token使用如果达到80%（某项分额和总额都算）则弹窗提醒用户，每天只有第一次提醒，
> 后续其他分项达到80%不再提醒（这点要在弹窗中也告诉用户）。用户可以快捷点击“+1元、3元、5元、10元额度”
> or“+20M、+50M、+100M、+200M token ”等」

### 已做

- 新 `src/token-budget.js`：`{qq,bili,other,total} × {cny,tokens}` 双单位额度；解析 `¥8 / 8元 / 8M / 2万 / 1.5亿`；
  80% 提醒、100% 拦截；`takeAlert()` 返回即落盘，保证每天只提醒一次；坏 JSON 回默认 QQ ¥8。
- 新 `plugins/surfcore/lib/token-budget.js`：监听 `session/event` 实时累计；`bili-whale*` + 子会话 = B站，
  黑话会话 = 其他，`qq-chat*` / sessions.json = QQ，`cordis`/`standard` 用户会话不计入；
  启动用 `session/list` + `inspect` 回填当天，热重载只补 seen 增量；写 `token-usage-daily.json` 给桥接。
- `src/bridge.js`：唤醒闸门改为「QQ 分项 + 总额」读插件当日快照，快照过期回落 ledger；
  黑话学习加「其他/总额」闸；新增只读 `/api/tokens/daily`；旧 `maxDailyCostCNY` 只在额度文件缺失时兜底。
- `plugins/surfcore/lib/scheduler.js`：`promptBili()` 统一检查 B站 额度；tick / 私信 / 倾听 / 直播间 /
  动态提醒在 100% 时直接跳过（不投 prompt、不读掉消息）。
- 设置页新增「Token 额度」标签：今日用量、双单位输入、快捷 +1/3/5/10 元与 +20M/50M/100M/200M token、
  总额一键「只留总额度 / = 分项之和 / 设为 ¥8 / 8M」；80% 弹窗（文案明确「今天唯一一次」）。
  QQ 页旧的「近 24h 花费上限」字段删除，避免双入口。
- 测试：`scripts/test-token-budget.mjs`（77）/ `test-token-budget-service.mjs`（39）/
  `test-token-budget-bridge.mjs`；更新 `test-token-guard` / `test-token-usage` / `test-client-contract`；
  顺手修 `test-qq-model-view` 没复制 `sticker-semantics.js` 导致的子进程退出（旧测试债，不是本轮功能）。
- **真机抓到一个回填 bug 并已修**：`token-usage-state.json` 有 `day=今天` 但 `sessions={}`
  时，同一天增量分支会把 `bili-whale`（10-20 创建）的 436M 累计全算进今天，总额虚高到 ¥23。
  修法：没有 `lastSeq/seen/dayTokens` 的会话一律走 inspect 回填；新增「空 state」单测。
  清掉坏 state 后真机：QQ ¥7.61 / 117M、B站 ¥3.88 / 54M、其他 ¥1.69 / 21M，
  与桥接 ledger 当天 QQ 117.9M / other 21.4M 对得上。

### 验证

- 三个新 token 测试全绿；`test-token-guard` / `test-token-usage` / `test-token-economy` 全绿；
  `npm run test:audit` **63/63**、`npm run test:regressions` 全绿、插件 `npm test` 全绿。
- 真机：插件已热重载；设置页「Token 额度」截图 `docs/ui-tokens.png`（80% 弹窗）与
  `docs/ui-tokens-full.png`（总额度卡片）；`/dsh-surfcore/api/token-budget` 读写/快捷加额度/
  非法输入 400 都实测；把 QQ 额度临时压到 ¥6 时桥接 `/api/tokens/daily` 的 gate 返回
  `blocked:true`，恢复 ¥8 后恢复。
- 桥接已用新代码重启（23:04，`/api/tokens/daily` 可读插件快照）。

### 没验证 / 下一步

- 设置页弹窗的「一天只提醒一次」跨浏览器刷新已验证落盘；**没有等到第二天**做跨天弹窗真机。
- B站 真实到 100% 的停机行为未等真机（不主动烧额度去撞）；靠单测与服务测试覆盖。
- 旧的 `socialV2.tokenGuard.maxDailyCostCNY` 字段仍留在 `config.json`/示例里做兼容，设置页不再暴露。
- 当前真机 QQ 今日已到 95%（¥7.61 / ¥8），接近上限；用户若不想被停，先在额度页调高。
- 测试期间把 `token-alert.json` 备份到 `.dev-probe-bak` 后清掉，让用户下次打开能看到真正的第一次弹窗。

---

## 快照：2026-10-23 17:00–17:20（表情编号 / 情绪分类 / 内容描述 / 语境相近自动挑图）

### 本轮需求（用户原话）

> 「收藏表情时编号，并且分类情绪，赋予内容，利用Transformer机制，以后聊天时满足情绪或者内容相近时，
> 就可以发对应的表情一张，已经收藏的表情也做一下」

### 已做

- 新 `src/sticker-semantics.js`（纯函数，无网络/无文件 IO）：
  - 18 个情绪类别（开心/搞笑/得意/嘲讽/傲娇/害羞/卖萌/委屈/难过/生气/无语/摆烂/安慰/赞同/惊讶/告别/馋饿/害怕）
    + 中文说法词表 + 相邻情绪关系（委屈↔难过、嘲讽↔得意…）；
  - **本地注意力编码器**：分词（中文单字 + 相邻双字）→ 固定种子哈希词向量 → 自注意力
    `softmax(cos(x_i,x_j)/τ)` 加权（Q=K=V，无训练参数）→ 均值池化 → L2；表情向量进程内缓存；
  - `rankStickers(entries, 聊天文本)`：情绪相似（含相邻情绪）× 0.46 + 内容向量相似 × 0.38 +
    关键词命中 × 0.16 + 使用倾向 − 近期重复惩罚，默认阈值 0.34、Top 3；
  - `ensureStickerIndex`：稳定编号（新号 = 现有最大号 + 1，**不复用**已删表情的空号）+ 缺省情绪/内容兜底。
- `sticker-lib.js`：条目新增 `no / emotion / emotionAlt / content / keywords`；
  `findSticker` 支持 `#03`、`3`、`3号`；`formatStickerList` 返回编号/情绪/内容；注入块改成
  `- #05[委屈] 抱着空碗眼泪汪汪…` 并说明可按编号发送。
- `bridge.js`：启动与每次同步后补编号/标注；唤醒提示新增【表情匹配】（用最近 4 条群友消息 +
  未读算出 1~2 张，低于阈值不注入，省 token）；收藏/备注通道接收 `emotion/content/keywords`；
  `sendStickerV2` 支持编号引用。
- `mcp-snowluma-safe.js`：`qq_collect_sticker` 新增 `emotion`（中文枚举）/`content`/`keywords`；
  `qq_sticker_note` 同样可写这三项；`qq_send_sticker` 的 `stickerId` 支持编号。
- 预设 `/14`、`/15` 两条改成「编号 + 情绪 + 内容 + 收藏时顺手标注」。
- `scripts/tag-stickers.mjs`：8 张已收藏表情的看图标注表（dry-run 默认，`--apply` 才写，写前备份）。
- `scripts/test-sticker-semantics.mjs`（25 条）+ `test-stickers.mjs` 扩到 66 条，均加入 `test:audit`。
- PITFALLS #52 记录编码器塌缩/关键词噪声/编号复用/中文情绪被丢/热更新覆盖五个坑。

### 验证

- `node scripts/test-sticker-semantics.mjs` → 25/25；
- `node scripts/test-stickers.mjs` → 66/66；
- 真库 dry-run：8 张按 createdAt 拿到 #01–#08，情绪/内容/关键词与看图结果一致；
  样例排序：「明明不是我干的」→ #05/#06，「杂鱼就这」→ #03，「被摸头」→ #08，「我饿了」→ #05/#04，
  「今天基金跌了」→ 不推（阈值生效）。

### 没验证 / 下一步

- ✅ **2026-10-24 02:07 已重启（PID 36296）**，`GET /api/stickers` 已返回
  `no/ref/emotion/emotionLabel/content/keywords`（新代码生效）。
- ✅ 8 张标注已用 `node scripts/tag-stickers.mjs --api --apply` 通过控制台接口写入
  （桥接运行中写入，不需要停进程；回读 8 条全部有情绪+内容，磁盘 `state/stickers.json` 同步落盘）。
  该脚本新增 `--api` 模式，以后补标注优先用它。
- ✅ 词表小修（`再嘲笑 / 别去嘲笑 / 别笑我 / 求求`，以及 agree 去掉裸「就是」）已在 02:15 那次重启里生效。
- ✅ **02:14 真机复现的「推荐只在唤醒提示里」漏洞已修并在 02:23 重启后验证**：402 群那句
  「求求别再嘲笑我的回复了」到达时会话正在 `qq_wait_for_messages` 里，不会重建唤醒提示；
  现在 `stickerMatchFor()` 同时接进唤醒 / wait / unread，`GET /api/socialV2/unread?key=group:767098733`
  实测返回 `stickerMatch.hint`（委屈/嘲讽 → #05 #06）+ `matches[]`。PITFALLS #55。
- 副情绪已在 02:24 用 `tag-stickers --api --apply` 刷回表里的值（接口补了 `emotionAlt`）。
- ⚠️ **一个排序优化还没生效**：4 条消息窗口会把最新一条冲淡（#05/#06 打平在 0.46），
  已改成「最新一条 ≥4 字时以它为准」（#06 单独算 0.84），**等下次重启**。
- ⚠️ **02:29 又复现一次「推荐送到了但没用」**：解会话日志确认 wait 返回里带着
  `stickerMatch`（#06，0.831），她的 reasoning 是「sending #06 might read as mocking/repeating」
  → 只发了文字。已把高分（≥0.72）推荐的措辞改强，并在策略提示/preset 里写明
  「复读台词/玩梗时发表情是接梗，不算嘲讽」；PITFALLS #56。**同样等下次重启**。
- 会话日志排查技巧（这轮摸出来的）：`session.v4.jsonl.zstd` 是**多帧** zstd，
  `zstdDecompressSync` 只解第一帧；要按魔数 `28 B5 2F FD` 切帧逐段解压。
- 本轮还发现：**DSH 的 bash/pwsh 子进程写不了 `state/`、`src/`、`docs/`、`plugins/`、`_backups/`**
  （EPERM，只有文件工具能写；`.tmp-stickers/` 这类新建临时目录可以）。
  所以 `tag-stickers --apply`、`build-agent-preset-patches.mjs` 都必须在「能写这些目录」的环境里跑。
- `plugins/surfcore/presets/qq-chat-v2.patch.yml` 没重新生成：`build-agent-preset-patches.mjs` 写该目录时
  被沙箱拒绝（EPERM，`plugins/` 受保护）。需要在允许写 plugins 的环境跑一次，否则安装时的 `--check` 会报漂移。
  本轮只改了源 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`。
- 没有做「自动发送」：仍然是 AI 判断后调 `qq_send_sticker`（与既有软策略一致，避免刷屏）。
  如果确实要「命中就自动发」，得先定频率/禁用场景，属于行为变更，需另开一轮。
- 阈值 0.34 是在 8 张库上校准的；库变大后（>50 张）可能要复看误召回。

---

## 快照：2026-10-23 13:53–14:10（观看历史新增「操作」：仅看/主评论/鱼群聚拢/回复/搭话/收藏/动态）

### 本轮需求（用户原话）

> 「我需要在观看历史里加上小肥鱼对看过的视频的操作有哪些（仅仅看了，评论了（怎么评论的，
> 主评论还是鱼群保护了））」

### 已做

- 新 `tools/lib/watch-actions.mjs`：
  - 从 `quota.json.log` 读评论并分类：无 parent=主评论；`share`=分享；`parent+reply`=回复；
    `+ta`=主动搭话；`parent+mine`=动态回复；`parent` 无 reply/mine=**鱼群保护聚拢**；
  - 收藏读 `favorites.json`；发动态读 `bili-memory.json` 的 dynamic 条目（正文里的 BV）；
  - 动作按时间挂到同 BV「最近一次观看」；早于所有观看的挂最早一条并标 `beforeFirstWatch`；
  - `enrichWatchHistory()` 一步返回 items + 汇总。
- `/watch-history` 返回每个 item 的 `actions[]` 和顶部 `actions` 汇总；
- 设置页「观看历史」新增「操作」列（超过 3 条可展开），顶部加评论/收藏/动态/仅看统计；
- 旧宿主没 `actions` 字段时显示「需要新版宿主」，不会把所有人误标成“仅看了”。
- **顺手修了 #47**：`bili-memory` 里 `at:''` 的旧记忆（原神/鸣潮那两条）在回填时
  被 `at ?? ...` 绕过 date 回落，`new Date('')` 失败 → 每次读取都变成 `Date.now()`，
  于是永远显示「刚刚看过」、污染今天统计。现在按 `date` 回填并标 `dateOnly`，
  无 date 的标 1970 + `unknownDate`（页面「日期未知」）；真机今天 18 → 17。

### 验证

- `node scripts/test-watch-actions.mjs` → OK（6 种分类 / 收藏 / 动态 / 时间挂载 / 汇总）；
- 真机 47 条观看记录 → 110 个动作：评论 98（主 19 / 回复 43 / 搭话 32 / 分享 4）、收藏 3、
  发动态 9、仅看 9 条；当前没有聚拢记录，聚拢用单测夹具覆盖；
- `test-client-contract` / `test-host-smoke` 扩展；插件 `npm test`、根 audit **58/58**。

### 没验证 / 下一步

- **当前 DSH 宿主还是旧代码**：`/watch-history` 没有 actions，页面会提示重载；
  重启 DSH / 重载 surfcore 后才会出现「操作」列（客户端刷新就能看到新列，但数据要新宿主）。
- 旧评论只有 `quota.note` 前 40 字预览，不是全文；如果需要全文/评论链接，要改 `comment.mjs`
  另外落 `rpid + full text`（本次没做）。
- 只显示能关联到观看记录的动作；评论了但本地没观看记录的视频不在此表。
- 「鱼群保护·聚拢回复」当前没有历史样本，逻辑靠单测夹具；下次真发生聚拢时要看一眼页面标签对不对。

---

## 快照：2026-10-23 13:35–13:50（gamefeed 去重：13:34 又推原神/鸣潮旧视频）

### 本轮需求（用户原话）

> 「13:34 怎么又是那俩原神和鸣潮的视频？都看过多少次了」

### 结论（取证在 PITFALLS #45）

- 不是睡眠 `feed`（它已接 watch-history），漏的是**第二类动态的 `gamefeed`**：
  `gamefeed.mjs` 只有搜索 + 粗排，**没有任何 seen 逻辑**。
- 复现：`gamefeed --game 原神` → `BV1Gdnv65ESC`《原神:雨之城》AI演示6；
  `gamefeed --game 鸣潮` → `BV14enA6uEwu`、`BV1Afpj67EQu`。这三条都在
  `bili-memory.json` 里（10-21/10-22 看过），所以每次都会原样回来。

### 已做

- `gamefeed` 合并看过名单（readWatchHistory/日记/审计表/bili-memory/收藏/反馈）；
- 新增 `bili/gamefeed-picks.json`：候选记 3 天，3 天内不再原样出现；`--no-remember` 可跳过；
- 输出「已排除：看过 N 条 · 最近 3 天推过 M 条」；全空时明确说「没有新的了，别硬重复」；
- 动漫/游戏区（`--for anime/gaming`）共用过滤；`test-feed-core` 加接线断言；PITFALLS #45。

### 验证

- `gamefeed --game 原神 --no-remember`：候选 6 → 5，排除 1（BV1Gdnv65ESC 消失）；
- `gamefeed --game 鸣潮 --no-remember`：候选 10 → 8，排除 2（BV14enA6uEwu / BV1Afpj67EQu 消失）；
- `node scripts/test-feed-core.mjs` → OK；
- 插件 `npm test`、根 `npm run test:audit` **56/56** 全绿。

### 没验证 / 下一步

- 13:34 用户具体是在哪个界面看到那两条（游戏动态候选 / B站 首页 / QQ 消息）还没确认；
  但 `gamefeed` 返回这两条是已证实的，修的就是这个。
- `gamefeed-picks.json` 只在真实运行（不加 `--no-remember`）时写；现在还没有这个文件。
- 如果次日某个游戏候选全被排除，会提示「没有新的」；应换游戏或放宽 `--days`，别凑数。

---

## 快照：2026-10-23 13:00–13:40（B站 绑定/主人口味改扫码；确认抓取账号）

### 本轮需求（用户原话）

> 「确认一下抓取的是主人账号（弥叭）的偏好不是当前浏览器登录的或者小肥鱼的账号？」
> 「有没有这样的可能，我点击抓取的时候，你弹出个码让我B站扫码登录」
> 「顺便能不能把新用户用来绑定小肥鱼B站账号那一步跳过浏览器按F12抓取cookie什么的，也改成扫码？」

### 结论（先回答）

- 前一版抓的是 **小肥鱼自己的账号**（nav 实测 mid=1483638708 卡哇伊的小肥鱼），
  不是主人 37634003（弥叭 / 玛露Marrow）；浏览器 cookie 从未读取。
- 主人账号的观看历史/点赞/私密收藏只对本人开放；公开数据实测为空，抓不出偏好。
- 所以改成：**鱼和主人都可以扫码登录**；鱼写 `credentials.json`，主人写独立的
  `owner-credentials.json`，只给偏好抓取用，绝不用于发评论/动态。

### 已做

- 新增 `lib/bili-qr-login.mjs`：Edge headless 打开 B站 官方登录页 → 取可见二维码 `img`
  （隐藏 canvas 是空白，实测踩过）→ CDP 轮询 cookie → nav 验证 → 按 target 写文件。
  owner 会校验 `mid === owner.mid`，不一致拒绝保存；关宿主时清理 Edge/profile。
- 设置页：
  - B站 凭据卡新增「扫码登录小肥鱼」，手动 SESSDATA 保留为备用；
  - 「口味权重 / 一键抓取」新增目标（主人/小肥鱼/两者，默认主人），主人未登录时点抓取直接弹码，
    扫码成功自动继续；显示抓取账号和来源，扫错号提示期望 mid。
- `pref-scan` 支持 `target=fish|owner|both`，来源带 `owner-` 前缀；主人额外用 `feedback.json`
  作为弱信号，本地观看记录只算鱼的。
- 新接口：`GET /bili/accounts`、`POST /bili/qr/start`、`GET /bili/qr/poll`、`POST /bili/qr/cancel`。
- 测试：`test-pref-scan` 主人未登录不能偷抓鱼的号；client contract 扫码弹窗/接口/目标；
  host smoke `/bili/accounts` 不泄露 cookie + 非法 poll id 400。PITFALLS #44。

### 验证

- `node scripts/test-pref-scan.mjs` → OK；
- `cd plugins/surfcore && node scripts/test-client-contract.mjs && node scripts/test-host-smoke.mjs` → OK；
- 直接调 `startQrLogin({target:'owner'})`：约 4 秒出码（img len 7810），`poll` → waiting，
  `cancel` 后无残留 Edge；fish/owner 状态接口正常；
- 插件 `npm test`、根 `npm run test:audit` **56/56** 全绿（新增 `test-bili-qr-login`）。

### 没验证 / 下一步

- **没有真手机扫码**（会真登录账号，自动化里不能做）：扫码→手机确认→写 cookie 只能人工验收。
  验收方式：重启 DSH → 设置 → B站 →「扫码登录小肥鱼」/「一键抓取」选主人 → 手机扫码 →
  看是否显示 mid、能否抓到候选。
- **当前运行中的 DSH（15982）实测**：`/bili/accounts`、`/bili/qr/poll` 仍是 405，
  `/preferences/scan` 不返回 target/account —— 还是旧 host。必须重启 DSH / 重载 surfcore；
  客户端已加保护：选主人/两者时旧 host 会提示「不认抓取目标」，不会把鱼的结果冒充主人。
- 鱼号已有 `self.mid` 时，扫码换号会被拒绝（防止误扫把鱼换成人）；要换号先手动处理旧凭据。
- 依赖 Edge；B站 登录页被风控/改版时可能取不到二维码（会提示，手动粘贴仍可用）；
- 主人 cookie 只存在 `owner-credentials.json`，**不要拿它发评论/动态**；也不要发到聊天里。

---

## 快照：2026-10-23 12:04–12:25（选题器去重/权重 + 一键抓取偏好）

### 本轮需求（用户原话）

> 「观看视频的架构似乎有问题，总是搜到相同的视频，能不能解决这个问题？另外，除了预设的视频偏好之外，
> 你有没有办法直接抓取用户的偏好关键词？这样新用户配置时可以点击一键抓取，并部分选择抓取到的关键词
> 填入小肥鱼偏好，最后，我怎么感觉小肥鱼看视频只会看我填的某个偏好的内容？是我的错觉吗，感觉她并不会
> 均匀的分配偏好权重，或者你可以加一个用户可以设置每一个偏好的权重的功能，拉高或者降低」

### 结论（用户的感觉是对的，不是错觉）

真机数据把三个问题都钉死了：

1. **重复推刚看过的**：`watch-history.jsonl` 42 个不同 BV 里 **25 个不在旧 feed 的 seen 里**
   （旧 seen 只读日记 18 个 BV；`commented-videos.md` 根本不存在）。改前 feed 输出的 6 条里
   有 3 条是当天刚看过的。
2. **只盯着一两个偏好**：`prefs.slice(0, 6)` 静默截断；用户的 10 个偏好里前 6 个全是
   AI/DeepSeek 变体，`大肥鱼`/`AI` 等根本没被搜；而 `DeepSeek/Deepseek/deepseek` 在同一标题上
   各加一次分，叠成 3 倍。
3. **同一天永远同一批**：每个词固定 `page: 1` + `click/pubdate` 两种排序。

### 已做

- 新增 `tools/lib/feed-core.mjs`（纯逻辑）：偏好清洗（大小写变体合并）、权重、配额
  （4 等权 → 2/2/1/1；3:1 → 3:1；单偏好不封顶）、偏好间轮转输出、搜索页/排序按天轮换、
  最近推过过滤；拉丁词按词边界匹配（`AI` 不再命中 `said/email`）。
- `feed.mjs` 重写：去重源扩到日记 + 审计表 + 观看历史（含旧记忆回填）+ B站 记忆 + 收藏 + 反馈；
  `--n/--per/--pages/--seed/--json/--recent-days/--no-remember`；写 `bili/feed-picks.json`。
- 配置：`preferences.weights`（0~5，0=停用）+ `preferences.keywords` 真正参与搜索（默认权重 0.75）；
  保存时在 `store.js` 收敛（去重/夹取/清孤儿键）。
- 一键抓取：新 `tools/lib/pref-scan.mjs` + `prefs scan` CLI + `GET /api/preferences/scan`；
  读观看历史（含 `tag_name`）、收藏夹（文件夹名直取）、本地记录（关注列表可选、默认不读）；只读、不外发。
- **抓取账号显式化（13:00 用户追问）**：返回 `account { mid,name,role,expectedSelfMid,expectedOwnerMid }`，
  设置页显示「抓取账号：卡哇伊的小肥鱼（1483638708）· 小肥鱼账号」，CLI 同样打印。
  实测确认抓的是 **小肥鱼自己的账号**，不是主人 `37634003`（弥叭 / 玛露Marrow），也不读浏览器登录；
  主人账号只有公开数据（无公开收藏、关注未公开、2 条动态），抓不到有效偏好 —— 要抓主人必须另配主人 cookie。
- 设置页：B站页新增「口味权重 / 一键抓取」——每个关键词 0~5 的输入框、删词、手动加词、
  抓取候选 chip 勾选 → 加入爱看（仍需点底部保存）。调度器提示词同步（第 3 / 3.2 步）。
- 测试：新增 `test-feed-core` / `test-pref-scan`；扩展 `test-store`、`test-client-contract`、
  `test-host-smoke`；加入 `scripts/test-audit.mjs`。文档见 PITFALLS #43。

### 验证

- `node scripts/test-feed-core.mjs` / `node scripts/test-pref-scan.mjs` → OK；
- `cd plugins/surfcore && npm test` → 全绿；
- `npm run test:audit` → **55/55**；
- 真机 `feed --seed 2026-10-23`：排除 43 个 BV（观看历史补 25），改前那 3 条看过的没再出现；
- 真机 `prefs scan`：账号显示为「卡哇伊的小肥鱼（1483638708）· 小肥鱼账号」；
  history 56 / favorites 24 / local 82 → 24 个候选（单机游戏、手书、同人、异环、凡人修仙传、AMV、MAD 等）；
- 临时配置（猫咪 3 / AI 0.5）跑 `feed --json`：配额 3/1/1/1；
- 设置页真实截图通过：B站 页「口味权重 / 一键抓取」渲染出 10 条关键词 + 滑杆 + 删除按钮 +
  加词框 + 「一键抓取我的偏好」按钮（headless Edge 连的是当前 48904 的 DSH）。

> ⚠️ 过程事故（12:23–12:26）：我用临时宿主进程验 `apply()` 路由时，`startScheduler` 跟着跑了起来
> （mock ctx 只拦了会话，不拦定时器）。已 `job_kill` 掉；核对了 `whale-night.json`：**slots 没有被重掷**
> （仍是 s1 11:40 fired / s2 14:03 pending），只是 `createdAt` 和「下一次」指针被重写，主进程下一 tick
> 会按同一份 slots 继续。以后验路由用 `test-host-smoke` 的 mock，或者先设环境变量/直接 `process.exit(0)`，
> 别让真生物钟在探针里 tick。

### 没验证 / 下一步

- **运行中的 DSH 还加载着旧 host 代码**：客户端文件是每次刷新重读的，所以新面板已经能看到；
  但 `GET /api/preferences/scan` 在旧宿主进程里还不存在（点了会显示「未知接口」，
  现在会额外提示“重启 DSH 或重载 surfcore”）。**重启 DSH（或重载 surfcore 插件）后**这个按钮才生效。
  `feed` / `prefs scan` 是子进程，改动即时生效；存权重走已有 `/config` 路由，也不需要重启。
- 重启后需要再点一次「一键抓取」做真机端到端确认（网络源 history/favorites 已在库函数层验证过）。
- 偏好仍是全局（不随角色切换）——`CHARACTER_PERSONA.md` 的已知边界不变。
- 用户当前的 10 个偏好语义上全是 AI/大肥鱼；想让她看杂一点，需要用户自己：
  ① 把 `AI` 的权重调低（比如 0.5）② 用「一键抓取」把 `游戏/手书/AMV` 等加进「爱看」。
  这一步只能用户自己决定，代码不该替 TA 改口味。

---

## 快照：2026-10-23 11:26–11:40（08:00 早安没发出去：补发/重试 + reserved2 真调发送工具 + 好友预检）

### 本轮需求（用户原话）

> 「话说今天早上八点问候怎么没有成功，修一修这个问题吧，另外问候的对象我确认过了，
> 你测试时可以直接发给他测试消息」

### 结论（先给答案）

08:00 那次是**三个原因叠在一起**，任何一个都足以让早安消失：

1. **错过就丢**：桥接恰好在 08:00:00 重启（当天日志里就有一行 08:00:00 的排定），旧逻辑
   `next <= now` 直接排到明天，没有补发/重试。
2. **reserved2 纯文本不自动发**：旧提示词让「直接输出要发的话」，而 reserved2 下纯文本
   不会进 QQ ⇒ 就算定时器炸了也发不出去。
3. **目标当时不是好友**：实测 OneBot `result=16 请先添加对方为好友`，错误只进日志，
   管理员在设置页看不到。测试中途该号被加为好友后才发得出去。

### 已修

- 新 `src/greeting-schedule.js`（纯函数）：准点 / **3 小时补发** / **10 分钟重试** / 明天；
  `buildMorningGreetingPrompt()` 按模式生成文案（reserved2 必须调 `qq_send_private_message` 并带令牌）。
- `state/greetings.json`：`lastMorningDate`（重启不重发）、`lastMorningError`、`lastTargetWarnDate`。
- **好友预检**（`get_friend_list`，缓存 10 分钟）：不是好友 → 当天标记失败 + 私聊管理员说明；
  试发接口回 500 + 原因（以前回 200「已投递」）。
- `/api/greeting/test` 支持临时 `uin`（必须命中私聊白名单、不写回配置），方便真机验证。

### 真机验证

- 11:29 目标非好友：`[send] … 失败: result=16 请先添加对方为好友`（问题暴露，不再静默）。
- 好友加上后 **11:36:19 `[send] /api/send/private private:3362299430: 成功 1/1 条`**，
  随后 `工具已发送消息，跳过自动转发` ⇒ 只发一条。
- 下次准点：明天 08:00（今天已过补发窗口；今天的问候已用试发补过，不再重发避免刷屏）。
- 注意：11:32 左右的试发一度卡住，是我在它 turn 进行中重启桥接造成的假死会话；
  `POST /api/session/reset {key}` 后重建会话即恢复 —— 排查时别把这种自造状态当代码 bug。

### 没验证 / 下一步

- 明天 08:00 的真实准点要等明天；`state/greetings.json` 会记 `lastMorningDate`，可据此核对。
- 电脑睡眠时定时器会晚触发：补发窗口内会补，超过就记失败等明天（边界已写进 PITFALLS #41）。

---

## 快照：2026-10-23 11:06–11:25（跨平台互认：转发来源 + B站 侧自我卡 + 微博下线）

### 本轮需求（用户原话，5 条）

> 1、我在QQ群里发了小肥鱼在别的群的聊天记录，但是她认成那是她在B站发的，你能优化掉这个问题吗
> 2、小肥鱼在QQ看到自己的B站主页图，能否认出那就是自己？目前来看似乎是不能，可否解决？
> 3、在B站的小肥鱼看到自己的QQ主页图能否认出是自己？
> 4、以后的跨平台互认要怎么做，策略是什么，现在有解决方案吗
> 5、插件里说留了微博和贴吧入口，把微博删了吧，以后不准备做微博
>
> 中途纠正：「在QQ群里发主页似乎是能认出自己的，并且发别的鱼的主页不会认成自己，这点还不错」
> → 第 2 条**不用改**（B站记忆简报里的锚点已经在起作用），别为此再叠一份锚点。

### 结论

1. **转发被归成 B站 内容（真问题，已修）**：`formatForwardResponse()` 以前只返回内容、没有平台，
   而 B站 记忆简报里又有她自己的公开评论 → 模型按"内容像不像"归档。现在返回里固定带
   `platform: 'QQ'` / `source: 'forwarded-chat-record'` / `notice`（"不是 B站 动态/评论"），
   工具描述同步写；每次唤醒再带一段【来源判断】（合并转发 = QQ 聊天内容、QQ 图片/截图也算 QQ 内容）。
2. **QQ 侧认 B站 主页（已能用，未改）**：用户确认能认自己、也不会把别的鱼认错；保持原样。
   只加了一个兜底：`biliBridge.memory.enabled=false`（简报关掉）时用自我卡补锚点。
3. **B站 侧认 QQ 资料卡（新做）**：桥接登录时把 QQ 昵称/号写到 `state/self-identity.json`；
   B站 唤醒的固定上下文新增自我卡（`scheduler.js` 的 `selfIdentityBlockForBili()`）：
   B站 昵称/UID/主页/人格名 + QQ 昵称 + **打码** QQ 号（`328****288`）+ 认自己规则 + 隐私句。
4. **策略（已写文档）**：[`guides/CROSS_PLATFORM_IDENTITY.md`](guides/CROSS_PLATFORM_IDENTITY.md) ——
   自我卡唯一（`src/self-identity.js`）、来源由载体决定、标签与规则双写、隐私分级；
   接贴吧时只加字段 + 一行锚点，两侧自动生效。
5. **微博下线**：`platforms.js` 注册表删掉 `weibo` 占位，`platforms/weibo/manifest.json` 移到
   `_backups/weibo-platform-removed-20261023/`，设置页/README/locale/package.json/ROADMAP 同步；
   贴吧保留。`align.js` 的 `PLATFORM_LABELS` 与平台校验、`store.js` 的 `planned` 列表也一起去掉 weibo。

### 本次已改动

| 文件 | 改了什么 | 状态 |
| --- | --- | --- |
| `src/self-identity.js` | **新增**：自我卡（昵称/ID/主页/人格名）、B站 侧 QQ 号打码、来源规则、`state/self-identity.json` 读取 | ✅ 单测 |
| `src/forward.js` | `formatForwardResponse` 返回 `platform` / `source` / `notice` | ✅ test-forward |
| `src/bridge.js` | 登录时落 `self-identity.json`；唤醒提示加【来源判断】；B站记忆关闭时用自我卡兜底 | ✅ 单测 + 重启 |
| `src/mcp-snowluma-safe.js` | `qq_get_forward_msg` 描述写明「这是 QQ 聊天记录」 | ✅ |
| `src/bili-memory.js` | 新增 `selfInfo()`（B站 昵称 + mid） | ✅ |
| `plugins/surfcore/lib/scheduler.js` | `selfIdentityBlockForBili()` 接进 `identityContextLines()` | ✅ client contract |
| `plugins/surfcore/lib/platforms.js` / `store.js` / `align.js` / `client.js` / locale / package.json / 各级 README | 移除微博占位，只留贴吧 | ✅ |
| `scripts/test-self-identity.mjs` | **新增** 8 组断言，登记进 `test:audit` | ✅ |
| `scripts/test-forward.mjs` / `plugins/surfcore/scripts/test-client-contract.mjs` | 平台字段 / B站 自我卡接线 / 无微博 | ✅ |
| docs：`guides/CROSS_PLATFORM_IDENTITY.md`（新）+ PITFALLS #40 + RULES 第 10 条 + ROADMAP + docs 索引 | 文档同步 | ✅ |

### 追记（11:20）：用户追加「只准自己互认，不许泄露主人和别人的信息」

- **自我卡只含她自己的锚点**：QQ 昵称/号（网关登录）、B站 昵称/UID/主页、人格名；
  不含主人 QQ/主人 B站 mid、不含对齐表里任何人。B站 侧拿到的 QQ 号还是打码的（`328****288`）。
- **公开面加了硬闸**（提示词只是概率约束）：
  `src/identity-guard.js`（纯函数：已知 ID 精确命中 + 「QQ/群号+数字」形态，不拦普通数字/昵称）
  + `plugins/surfcore/tools/lib/outbound-guard.mjs`（从合体层 `admin`、`bili.config.json` 的 `owner.mid`、
  `alignments.json` 收集受保护 ID，减去她自己的 B站 mid），接在 `comment.mjs` / `dm.mjs` /
  `dynamic.mjs` / `share-dynamic.mjs` 发送前：命中就 **exit 9 不发**，错误信息里的号码也打码。
- **QQ 群侧不加硬闸**（群成员本来就看得见彼此 QQ 号，硬拦会误伤正常回话），只保留提示词规则
  【只用于自己】。要加得先定更窄的规则（例如只拦主人的 B站 mid）。
- 测试：`scripts/test-identity-guard.mjs`（纯函数 + 四个写操作的接线断言）已登记进 `test:audit`；
  `test-self-identity` 增加「两侧都写明只用于自己」。

### 没验证 / 下一步

- **已真机生效**（11:15 重启桥接 + 热重载插件，pid 19992 / `reserved2` / `dshReady=true`；
  11:23 又为「只准自己互认」身份规则重启到 **pid 2760**，状态同样 `reserved2` / `dshReady=true`）：
  `state/self-identity.json` 已生成 `{nickname:"卡哇伊的小肥鱼", userId:"3760717363"}` ——
  注意这是**她自己的 QQ 号**（3287064288 是主人的），所以身份必须从网关 login 取、不能从配置拼。
  11:15:03 的 AI 内部输出也证实她能从三张 B站 主页截图里认出自己那张（用户中途也确认过这一点）。
- **仍需用户验一遍**：再转发一次「她在别的群的聊天记录」，她应该说成 QQ 聊天记录而不是 B站。
- **B站 侧没有图片输入通道**（DM/评论都是纯文本，`tools/commands/dm-await.mjs` 不取图）：
  自我卡已进每轮 B站 唤醒，但她目前**物理上收不到图**；以后要"看图认自己"得先给 B站 侧接图片通道。
- 视觉识别仍是模型判断，不是 OCR 白名单；锚点+规则能压低错误率，不保证 100%。

---

## 快照：2026-10-23 10:34–10:45（QQ 黑名单：按「人」拦，无论什么群）

### 本轮需求（用户原话）

> 「设置里QQ白名单那里底下加一个黑名单功能，不响应黑名单中的人的消息，无论什么群」

### 结论（先给答案）

- **新增 `config.json → deny.users`（人的黑名单）**。设置页 **QQ → 「QQ 白名单」卡片正下方**多了一张
  「QQ 黑名单（人 / 群 / 私聊）」卡片：拉黑的人 / 拉黑的群 / 拉黑的私聊 QQ 三个输入框（chip 可单个删），
  管理员误把自己拉黑时卡片上直接红字提示 + 一键移出。
- **为什么不是「给白名单卡片加一个输入框」那么简单**：`allowed(kind, id)` 判的是**会话**
  （群号 / 私聊对象）。群消息进来时 `id` 是群号，同一群所有成员共用一个 key ⇒
  白名单群里的某个人根本没法单独拉黑（`deny.private` 只拦他的私聊，`deny.groups` 会把整群连别人一起拦）。
  所以加了按**发送者**判的 `senderBlocked()`，拦截点放在 `handleIncoming()` 的**最前面**
  （`modeAllowed` 之后、入库/记忆/鱼群/唤醒之前）：不入库、不进上下文、不写记忆卡、不触发唤醒。
  `handlePokeNotice()` 同步拦 —— 否则「戳一下」就是绕过黑名单的唤醒通道。
- **优先级**：`deny.users` > `allow.*` / `allowAllWhenEmpty` / 私聊白名单。已用 `test-blacklist` 钉住
  「人同时在 allow.private 里也照样不响应」「全放行时仍拦」。
- **旧控制台不会把它抹掉**：`public/console.html` 的白名单表单只提交 `private/groups`，
  桥接 `POST /api/whitelist` 现在在请求没带 `users` 时**保留原值**（否则设置页拉黑的人会被一次旧页面保存静默清空）。
- **可观测**：启动日志打印 `🚫 人的黑名单 deny.users：…`；管理员在黑名单里时额外告警
  （审批/私聊/管理命令会全部静默失效）。
- **生效方式**：设置页是「改了 → 点底部保存 → 重启 QQ 桥接」（桥接只在启动时读 config.json）。
  **本轮已热重载并重启**：10:45 `plugin_manager` 关/开 `include:surfcore`；10:46 桥接 restart
  （pid 10212 → 13704），重启后 `mode=reserved2`、`dshReady=true`、SnowLuma `connected=true/good=true`，
  `GET /api/whitelist` 已返回 `deny.users` ⇒ 新代码在跑。`deny.users` 目前是空数组。
  ⚠️ 设置页的**浏览器端**要刷新一次页面才会拿到新的 client.js。

### 本次已改动

| 文件 | 改了什么 | 状态 |
| --- | --- | --- |
| `src/bridge.js` | `loadConfig` 读 `deny.users`（去重/收敛）；新增 `senderBlocked()`；`handleIncoming` 最前面拦；`handlePokeNotice` 拦；`/api/whitelist` GET/POST 带上并在缺省时保留 `users`；启动日志 + 管理员在黑名单里的告警 | ✅ 单测（fixture） |
| `plugins/surfcore/lib/store.js` | `normalizeQqConfig` 收敛 `deny.users`（去重、纯数字串） | ✅ test-store / config API |
| `plugins/surfcore/lib/client.js` | **新增** `BlacklistCard`（人/群/私聊 + 管理员误拉黑提示）；挂在白名单卡片下方；高级参数里删掉重复的 `deny.private` / `deny.groups` 输入框（组改名为「安全通知」） | ✅ 语法 + client contract |
| `config.example.json` / 真实 `config.json` | `deny` 增加 `users: []`（真实配置备份 `_backups/config-before-deny-users-*.json`） | ✅ 备份 + diff 只有一行 |
| `scripts/test-blacklist.mjs` | **新增** 8 条：配置收敛 / reserved2 不入未读 / chat 不投递 / 私聊压过白名单 / 全放行仍拦 / 拍一拍不唤醒 / 旧控制台不清空 / 显式提交以请求为准 | ✅ audit 50/50 |
| `scripts/audit-bridge-harness.mjs` | 暴露 `senderBlocked` / `handlePokeNotice` 供测试 | ✅ |
| `scripts/test-audit.mjs` | 登记 `test-blacklist.mjs` | ✅ |
| `plugins/surfcore/scripts/test-client-contract.mjs` / `test-admin-config-api.mjs` | 断言黑名单卡片与 `deny.users` 保存回环 | ✅ |
| README / README.en / RULES（第 9 条）/ SECURITY_BASELINE / PITFALLS #39 / ROADMAP | 文档同步 | ✅ |

### 追记（10:49–11:00）：真机第一次测试「还是回了」—— 填错了框，不是拦截失效

- 用户实测：402 群（`group:767098733`）里「@机器人 test」照常回复。
- 查证：保存前的备份 `qq-config-2026-10-23T02-49-34-262Z.json` 里 `deny` 全空；保存后
  `deny.private=["1011078831"]`、`deny.users=[]`；`state/social-v2.json` 的 `unread` 里还躺着那两条
  `userId=1011078831` 的测试消息。⇒ 那个 QQ 被填进了「**仅拦私聊**」，`deny.users` 根本没赋值。
- 已修（本轮实做）：
  1. 把 `1011078831` 移进 `deny.users`（备份 `_backups/config-before-move-1011078831-to-deny-users-*`）；
  2. `loadSocialV2State()` 启动时清掉黑名单用户在 `unread/recentMessages` 里的积压（实测清了 4 条）——
     否则拉黑前堆的未读会在下一次唤醒被当成新消息回一遍；
  3. 设置页：字段改名「仅拦私聊（deny.private）」+ 只填在这一档时红字提示 + 一键加到「拉黑的人」；
  4. 启动日志：对只在 `deny.private` 里的人提示「他们在群里仍会被回应」。
- 同轮修掉的环境坑：**DSH 重启后端口从 23515 变到 48904**，我按旧端口重启桥接 → `dshReady=false`、
  模式回落到本地 `chat`。已把 `config.json` 的 `dsh.baseUrl` 改成 `http://127.0.0.1:48904` 并按该端口重启，
  现在 `mode=reserved2`、`dshReady=true`、SnowLuma `good=true`。
  ⚠️ 以后手动重启桥接**别硬编码端口**（要么不传 `dshWebUrl` 让它自发现，要么先看 `state/dsh-port.json` / GUI 地址）。
- 仍需用户验一遍：设置页硬刷新 → 黑名单卡片应显示「人 1 · 群 0 · 私聊 0」→ 让 `1011078831` 在群里再发一条 →
  群里无回复，`bridge.log` 出现 `[黑名单] 忽略 group:767098733 来自 1011078831 的消息`。

### 没验证 / 下一步

- **真机拦截还没被真消息触发过**：配置已生效（`deny.users=["1011078831"]`），等用户再发一条确认。
- 插件的 `client.js` 已热重载（`plugin_manager` 关/开 `include:surfcore`），但**浏览器端要刷新一次**设置页才会看到新卡片。
- 拉黑只拦**入站**，不回溯清理记忆卡里已有的内容；要清走 `/reset` 或控制台删记忆。

---

## 快照：2026-10-23 08:35–09:20（B站 会话权限 + QQ/B站 鱼群记录）

### 本轮需求（用户原话要点）

> 「都做」——指上一轮结尾的两个下一步：
> ① 先把 B站 会话权限处理掉，让定时点赞真正跑起来；
> ② 把 QQ 鱼群触发记录做成设置卡。
>
> 2026-10-23 09:37 追加：
> ① 每日分享默认发**自己的 B站 动态**（视频卡片），不再默认评论区 @；和四类动态至少隔 30 分钟；
> ② 鱼群泛滥的聚拢回复占**主动评论额度**（30/天），不是回复额度（50/天）；别人再回才占回复；
> ③ 解释“为什么泛滥还会没有可聚拢的鱼楼”；
> ④ 每次醒来无视可聚拢判定，强制聚拢并主动评论一次（默认开，`--no-force-gather` 可关）。

### 结论（先给答案）

- **B站 会话权限**：找到并修掉三层问题——
  1. 会话 cwd `%USERPROFILE%` 在 workspace-write 下不满足 DSH 沙箱 `WRITE_OWNER`，命令起不来；
  2. 定时唤醒申请 `danger-full-access` 走人工审批，半夜没人批 → 整轮挂起；
  3. 自动切换代码踩了 Cordis 坑：未 inject 的服务直接读 `ctx.sessions` / `ctx.permissionPresets` 会**抛异常**，
     `ctx.sessions ?? ctx.get('sessions')` 的右边永远执行不到。
  修法：`agent.sandbox` 默认 `danger-full-access`（只对 `bili-whale-*` 会话），
  `applySessionPermission()` 先 try 直接属性、失败回退 `ctx.get`；调度器在 `session/created`、每次 tick、
  `ensureSession` 三处校正；设置页 B站 状态卡新增「修复会话权限」按钮（`POST /bili/session-permission`）。
  **真机已经生效**：调用返回 `changed:true, current:"workspace-write" → "danger-full-access"`，
  B站 会话日志新增 seq 45~47 的 `permission/preset` / `sandbox/mode` / `approval/policy`。
- **QQ 鱼群触发记录**：桥接现在把每次**新一轮**触发写进 `state/social-v2.json` 的 `fishGuardLog`
  （每群最多 30 条），并把 `fishGuard` / `fishGuardBypass` / `lastFishGuard` 纳入保存/加载（以前桥接重启即失忆）。
  新增纯函数 `lib/qq-fish-guard.js` 整理成表格；`GET /fish-guard/qq`；QQ 页顶部新增
  「QQ 鱼群保护 · 最近触发」卡（`ui-qq-fishguard.png`，当前是空状态：还没有真实触发）。
- **B站 鱼群检查记录**：`fish-guard.json` 新增 `fishGuardLog`（30 天 / 最多 50 条）；
  `comment.mjs --auto` 和 `fish-guard like` 都会调用 `recordFishGuardCheck()` 记下
  `flooded / 鱼楼层 / 鱼账号 / 占比 / 样本 / 鱼名 / 聚拢目标 / 可点赞数`，**鱼太多没发也会记**。
  B站 状态卡下半段新增「最近鱼群检查」；真实记录已产生：
  `BV1jhn16GEcv · 鱼楼层15 · 鱼账号14 · 38% · 样本40 · 聚拢小叮当的大肥鱼 · 可点赞4`（`ui-bili-fishguard.png`）。
- **鱼群识别放宽（用户定）**：发送者名字**只要包含「肥鱼」**（位置不限，如「肥鱼观察员」）就算；
  另外**最后一个字是「鱼」**也算（咸鱼/摸鱼/鱿鱼…）。
  `nameSuffixes` 默认 `肥鱼,fish,鱼`，新增 `nameContains:['肥鱼']`；**群名判断仍只用 肥鱼/fish**，不连带放宽。
  真实 `bili.config.json` / `config.json` 已写入两个字段（备份在 `nameSuffixes-before-add-yu-*` /
  `nameContains-before-add-feiyu-*`），`test-fish-guard` 增加 QQ/B站断言；接受极小概率误伤真人（PITFALLS #34）。
- **鱼群判定支持用户自定义三组词（2026-10-23 用户要求）**：QQ / B站 都新增 `namePrefixes`，
  与 `nameContains` / `nameSuffixes` 并列；**开头 OR 中间 OR 结尾**，任一命中即算鱼。
  设置页拆成**独立组**「鱼群判定关键词（QQ/B站）」并**默认展开**，各三组输入：
  「鱼名开头词 / 鱼名包含词 / 鱼名结尾词」；默认 `[]` / `肥鱼` / `肥鱼,fish,鱼`，
  不写死 `DSH`/`吃白饭`；群名判断不变（`groupNameSuffixes` 仍是群名包含词，只收紧鱼窝阈值）
  （PITFALLS #48，截图 `ui-bili-keywords.png`）。真实配置已加 `namePrefixes:[]`。
- **逗号列表输入修复（2026-10-23）**：list/times 字段以前每键 split/join 吞逗号；
  新增 `ListInput` 本地保留原始文本、输入中允许逗号、失焦规范化，保存时数组正确。
  真机 CDP 输入 `DSH,吃白饭` 成功；截图 `ui-bili-keywords.png` 更新（PITFALLS #49）。

- **每次醒来强制聚拢（2026-10-23 用户定）**：`forceGather` 默认开；鱼群泛滥时即使没有
  “回复少/新鲜/没回过”的鱼楼，也选**回复最少/最新**的鱼楼强制回一条，并记 `gatherFallback`。
  设置页新增「每次醒来强制聚拢」；`--no-force-gather` 可临时关；`--no-fish-gather` 仍明确不发。
  唤醒提示 4.7 改成“每次醒来至少一条主动评论，不许拿没有可聚拢鱼楼当理由不发”（PITFALLS #37）。
- **生物钟 C 模式（2026-10-23 用户选 C）**：每窗至少 1 次；全天 ≤12；剩余名额按最近评分给
  高质量窗口；相邻 slot 至少 `night.minGapMin`（默认 20）；skip 只轻醒当前 slot，不结束全天；
  超窗口 end 记 missed，不补醒。修掉了 skip 结束全天、skip 重掷、usedCount 白占、晚到 4h39、
  相邻窗口 1 分钟挨着等问题（PITFALLS #38）。真实 `night plan` 已生成当天 11 个 pending + 已醒 1。
- **B站 每日分享改自己的动态（2026-10-23 用户定）**：默认 `share.via=dynamic`；
  新 `share-dynamic` 命令用 `findVideoDynamic` + `createForward` 把视频做成**视频卡片**动态
  （正文是她的话，不再评论区 @ 主人）；找不到卡片默认拒绝，`--allow-text` 才退文字+链接；
  和四类动态共用 `daily-dynamic.json`，任意两条至少 `dynamics.gapMin` 分钟（默认 30）；
  占分享额度 + 同一视频 7 天判重。旧 `comment --share` / `dm --share` 保留（PITFALLS #35）。
- **鱼群聚拢改占主动评论额度**：`comment.mjs` 新增 `FISH_GATHER`；
  聚拢回复走 `comment`（30/天），不再误占 `reply`（50/天）；别人再回这层楼仍走 `reply`。
  聚拢内容可以是回鱼，也可以是她对视频的看法（仍然回在鱼楼下 + @鱼名）（PITFALLS #36）。
- **B站 点赞历史（2026-10-23 用户要求）**：成功点赞写 `fish-guard.json.likeLog`
  （`uname/BV/评论摘要/rpid/时间/楼层或楼中楼`，最多 300 条）；`fishGuardStateSummary` 返回
  `likeHistory`，B站 状态卡新增「点赞历史」。旧 `liked` 只有 rpid 的条目显示 legacy；
  现有真实点赞已回填 `沉圻PhiLia的蓝色大肥鱼 / BV1jhn16GEcv`（PITFALLS #42，截图 `ui-bili-fishguard.png`）。
- **Token 防爆破（2026-10-23 用户要求）**：新增 `socialV2.tokenGuard`；
  单会话每天唤醒上限（群 20 / 私聊 10）、两次苏醒至少 2 分钟、每次醒来最多发 8 条、
  被 @/引用/叫到/拍一拍可越过 2 分钟间隔立即醒（每日次数/花费仍生效）；近 24h 花费上限 ¥8；
  鱼群守则先拦、Token 闸后拦；每次真实唤醒重置发送额度。
  设置页新增「Token 防爆破」组；旧限频/发送频率保留（PITFALLS #50）。
- **设置卡补齐（2026-10-23）**：Token 组 7 项可调（含 @ 越过间隔、每次 8 条）；
  衰减卡 `maxChars` 默认 0=无上限、新增 `warnChars` 默认 60000（只告警不自动删），
  记忆页可改；`chat.presence.onlineShare=0.4`（60% 不看群）只影响 chat，reserved2 不用，
  设置页已标注（PITFALLS #51）。真实记忆配置 `maxChars:0,warnChars:60000`（备份）。
- **插件热重载**：用 `plugin_manager` 把 `include:surfcore` 关掉再开，就能在不重启 DSH 的情况下加载
  `index.js` / `client.js` / `scheduler.js` 的新代码（本轮验证有效）。QQ 桥接另用 `/dsh-surfcore/api/bridge`
  的 `restart` 重启（08:41 已重启，新 save/load 生效）。

### 本次已改动

| 文件 | 改了什么 | 状态 |
| --- | --- | --- |
| `src/bridge.js` | 保存/加载 `fishGuard` / `fishGuardBypass` / `lastFishGuard` / `fishGuardLog`；新触发追加日志（每群 30 条）；冷却结束后落 `lastFishGuard` | ✅ 单测 + 重启 |
| `src/fish-guard.js` | 新增纯函数 `appendFishGuardTrigger`（触发日志追加/裁剪），桥接与单测共用 | ✅ 单测 |
| `plugins/surfcore/tools/lib/fish-guard.mjs` | 新增 `fishGuardLog` 保存/裁剪与 `recordFishGuardCheck()`；`fishGuardStateSummary` 返回最近 10 条 `records` | ✅ 单测 + 真机 |
| `plugins/surfcore/tools/lib/fish-guard.mjs` / `lib/client.js` | 成功点赞写 `likeLog`（uname/BV/评论摘要/rpid/时间）；summary 返回 `likeHistory`；B站 状态卡新增「点赞历史」 | ✅ 单测 + 真机截图 |
| `src/token-guard.js` / `src/bridge.js` / `plugins/surfcore/lib/client.js` / `config.example.json` | 新增 Token 防爆破：唤醒/发送/花费闸；鱼群先、Token 后；设置页 7 字段；真实 config 启用（备份） | ✅ 单测 + client contract |
| `src/memory-card.js` / `plugins/surfcore/lib/client.js` / `docs/guides/MEMORY_CARD.md` | 衰减卡 `maxChars` 默认 0=无上限、`warnChars` 60000 警告；记忆页可改；chat 60% 在线率标注作用域 | ✅ memory 23/23 + contract |
| `scripts/test-fish-guard.mjs` / `test-client-contract.mjs` | 点赞历史写入/summary/UI 契约断言 | ✅ |
| `plugins/surfcore/tools/commands/comment.mjs` / `fish-guard.mjs` | 判定后记录检查结果（comment / like 两种 source） | ✅ 单测间接 + 真机 |
| `plugins/surfcore/lib/client.js` | B站 状态卡新增「最近鱼群检查」（BV/是否泛滥/鱼数/占比/聚拢/可点赞）；QQ 卡与权限按钮同前 | ✅ 截图 |
| `plugins/surfcore/tools/templates/config.example.json` | 增加 `agent.sandbox` 示例 | ✅ JSON 校验 |
| `plugins/surfcore/lib/scheduler.js` | 导出 `applySessionPermission` / `applySessionPermissionTo`；`session/created` 监听、tick、ensureSession 自动切权限；`ctx.get` 回退 | ✅ 单测 + 真机 |
| `plugins/surfcore/tools/lib/config.mjs` | `agent.sandbox` 默认 `danger-full-access` | ✅ |
| `plugins/surfcore/lib/index.js` | `POST /bili/session-permission`；`GET /fish-guard/qq`；`summarizeQqFishGuard` 接线 | ✅ host smoke + 真机 |
| `plugins/surfcore/lib/qq-fish-guard.js` | **新增**：触发记录整理（去重 / active 优先 / 补群名 / 排序 / 上限） | ✅ 单测 |
| `plugins/surfcore/lib/client.js` | B站 状态卡「修复会话权限」；QQ 页「QQ 鱼群保护 · 最近触发」卡；B站 页 `agent.sandbox` 下拉 | ✅ client contract + 截图 |
| `plugins/surfcore/scripts/test-client-contract.mjs` / `test-host-smoke.mjs` | 新增断言与 `/fish-guard/qq` 路由冒烟 | ✅ |
| `scripts/test-scheduler-permission.mjs` / `test-qq-fish-guard.mjs` | **新增** 单测（含 Cordis `ctx.get` 回退用例） | ✅ |
| `scripts/test-audit.mjs` | 登记新测试（含 `test-share-dynamic`） | ✅ |
| `plugins/surfcore/scripts/ui-tabs.mjs` | 截图 QQ 鱼群卡 `ui-qq-fishguard.png` | ✅ 真机 |
| `scripts/test-fish-guard.mjs` | 新增 B站 `fishGuardLog` 写入/上限 50/summary records 断言；新增「最后一个字是鱼」QQ/B站断言 | ✅ |
| `src/fish-guard.js` / B站 `tools/lib/fish-guard.mjs` | 默认 `nameSuffixes` 增加 `鱼`；新增 `nameContains:['肥鱼']`（群名判断不变） | ✅ 单测 + 真机 |
| `src/fish-guard.js` / B站 `tools/lib/fish-guard.mjs` / `client.js` / 模板 / 真实配置 | 新增 `namePrefixes`；三组「开头/中间/结尾」任一命中；UI 三组输入；真实配置 `[]`（备份） | ✅ 单测 + client contract |
| `plugins/surfcore/lib/client.js` | 新增 `ListInput`：list/times 输入中允许逗号，失焦规范化，保存数组正确 | ✅ 浏览器 CDP + contract |
| `config.example.json` / B站模板 / 真实 `bili.config.json`·`config.json` | 同步 `nameSuffixes:["肥鱼","fish","鱼"]` + `nameContains:["肥鱼"]`（真实配置先备份） | ✅ |
| `plugins/surfcore/tools/commands/share-dynamic.mjs` / `lib/share-dynamic.mjs` / `bili.mjs` | **新增**每日分享 → 自己的动态：转发视频卡片、30 分钟间隔、分享额度/7 天判重、`--allow-text` 兜底 | ✅ dry-run 真机 + 单测 |
| `plugins/surfcore/lib/store.js` / `tools/lib/config.mjs` / `client.js` / `scheduler.js` / `automation.js` / `selftest.mjs` | `share.via` 默认 `dynamic`；设置页下拉第一项动态；唤醒提示改为 `share-dynamic`；真实 `bili.config.json` 已改（备份） | ✅ 单测 + client contract |
| `plugins/surfcore/tools/commands/comment.mjs` | 新增 `FISH_GATHER`：聚拢占主动评论额度（30/天），不传 `--reply`，不走 `mine:*`；别人再回仍 reply | ✅ 源码契约 + 单测 |
| `plugins/surfcore/tools/lib/fish-guard.mjs` / `client.js` / 模板 / 真实 `bili.config.json` | 新增 `forceGather`（默认开）；没有候选鱼楼时选回复最少/最新的一条；设置页开关；真实配置备份后写入 | ✅ 单测 + client contract |
| `plugins/surfcore/tools/commands/comment.mjs` / `lib/scheduler.js` | `forceGather` 接线与「强制聚拢」日志；4.7 改为每次醒来至少一条主动评论 | ✅ 单测 + 提示词 |
| `plugins/surfcore/tools/lib/night-schedule.mjs` / `commands/whale-night.mjs` / `lib/scheduler.js` | **新增** C 排程：每窗至少 1、全天 ≤12、质量加餐、最小间隔、skip 只轻醒、过期 missed；scheduler 按 slots 执行 | ✅ 单测 + 真机 plan |
| `plugins/surfcore/lib/client.js` / `store.js` / `tools/lib/config.mjs` / 模板 / 真实 `bili.config.json` | 新增 `night.minGapMin`（默认 20）；C 提示；真实配置备份后写入 | ✅ client contract + 真机状态 |
| `scripts/test-night-schedule.mjs` / `scripts/test-audit.mjs` | **新增** C 排程单测，登记进 audit | ✅ |
| `scripts/test-share-dynamic.mjs` / `scripts/test-audit.mjs` | **新增** 间隔/状态合并/默认 via 单测，登记进 audit | ✅ |
| README / 插件 README / PITFALLS #31 #32 #33 #34 #35 #36 / ROADMAP | 文档同步 | ✅ |

### 已验证

- `POST /bili/session-permission` 真机：`{ok:true, changed:true, current:"workspace-write", target:"danger-full-access"}`；
- B站 会话日志：`permission/preset=danger-full-access`、`sandbox/mode=danger-full-access`、`approval/policy=never`；
- `GET /fish-guard/qq` 真机 200，返回 `items:[] / active:0 / today:0 / config`（还没有真实触发）；
- B站 检查记录真机：`fish-guard like --bvid BV1jhn16GEcv --dry` 写入 1 条真实记录，
  `GET /bili/fish-guard` 返回 `checkCount:1`、`fishTopLevel:15 / fishMids:14 / fishRatio:0.375 / totalSample:40 / gather / likeTargets:4`；
- 放宽规则真机（同一视频）：旧规则 `15 条鱼 / 14 个账号 / 38%` →
  加「最后一个字是鱼」`16 / 15 / 40%`（新认出「莱弗里安家今天的鱼」）→
  再加「名字包含肥鱼」**`21 / 20 / 52.5%`**（新认出「小肥鱼小汐」「超级大肥鱼开喽」「无敌大肥鱼女仆」等）；
  `fish-guard.json` 记录同步更新（3 条：15/16/21）；
- 真实配置读回 `nameSuffixes:["肥鱼","fish","鱼"]`、`nameContains:["肥鱼"]`；
  真机 `isFishName`：肥鱼观察员/大肥鱼研究员/观察员肥鱼/咸鱼/鱼 = true，鱼糕 = false；
  QQ `config.json` / B站 `bili.config.json` 均已备份后更新；
- 设置页截图：`ui-bili.png`（状态卡 + 修复会话权限）、`ui-bili-fishguard.png`（最近鱼群检查 + 点赞历史）、
  `ui-qq-fishguard.png`（QQ 触发记录卡，空状态）；
- 分享动态 dry-run：`share-dynamic --bvid BV1jhn16GEcv --text … --score 13 --reason … --dry` 找到
  视频动态 `1261913158862241812`，打印“视频卡片（转发动态 …）”、距上一条 43 分钟、分享额度 0/3；
  **没有真发**（对外动态不擅自发）；
- 鱼群聚拢 dry-run：同一视频 `comment --auto --dry` 判定 21 条鱼/20 个账号/53%，聚拢到
  `多林的鲸鱼`（rpid 321569322752）；日志明确“占主动评论额度”，自由发言闸显示
  **“今天第 2/30 条普通评论”**（不是回复账）；未发送。
- 强制聚拢单测：全部鱼楼都 >6 回复时，旧逻辑 `gatherTarget:null`；`forceGather:true` 仍选
  回复最少的鱼楼并标 `gatherFallback:true`；`normalizeBiliFishGuard` 默认 `true`、显式 `false` 可关。
- 生物钟 C 真机：`night plan` 生成 11 个 pending slot（8 个开放窗口保底 + 3 个质量加餐）
  + 已醒 1 次 = 12；6–8 窗口已过记 warning；11:30（10–12 保底）、14:09/15:08、18:11/18:31/18:51、
  19:28、20:16、21:28、22:30、23:27；相邻 ≥20 分钟，每窗至少 1 次。
- 插件 `npm test` → 全绿；`npm run test:audit` → **58/58**（新增 `test-share-dynamic` /
  `test-night-schedule` / `test-token-guard`；另含 `test-scheduler-permission` / `test-qq-fish-guard`；
  点赞历史/三组鱼名规则断言在 `test-fish-guard` / client contract）。

### 尚未验证 / 待办

1. **下一次 B站 真实醒来**：会话已是 danger-full-access，下一窗口应能直接跑 `bili.mjs`；到点后看
   `~/.dsh/sessions/.../bili-whale-char-mvk6wth4` 是否出现成功的 `job/settled`。
2. **QQ 真实鱼群触发**：`fishGuardLog` 目前为空；下一次鱼刷屏后，设置页应与实际触发的群/原因/时间一致。
   如果需要测试数据，可临时在 `state/social-v2.json` 里注入并恢复（**不要**直接改真实群状态）。
3. **B站 每次换角色后的新会话**：`session/created` 监听应自动切权限；换角色后确认新 `bili-whale-<id>` 日志的
   `permission/preset` 是 danger-full-access。
4. **QQ 鱼群卡的真实截图**：现在是空状态；有触发后再截一张带数据的，替换 `ui-qq-fishguard.png`。
5. **B站 真实 auto 评论触发的检查记录**：目前那条是 `source:"like"` 的 dry-run 检查；
   等她下一次真的 `comment.mjs --auto`（鱼太多被拦或聚拢）后再看 `source:"comment"` 的记录。
6. **QQ 侧真实触发验证**：桥接已重启并读到 `nameSuffixes:["肥鱼","fish","鱼"]`，但 09:16 起
   SnowLuma 网关不可达（`fetch failed` / WebSocket 1006），QQ 消息本身还没通；等 SnowLuma 恢复后再看
   QQ 鱼群触发记录和「最后一个字是鱼」的真实识别。**这不是本次代码回归**。
7. **B站 动态分享真发**：dry-run 已确认能找到视频卡片、间隔/额度通过；但这是一条**公开动态**，
   没有用户点头不擅自发。下一次真实分享时看 `daily-dynamic.json.share` 和 30 分钟间隔是否生效。
8. **鱼群聚拢的额度真机**：代码已改为 comment 账；下次真实鱼群聚拢后，看 `quota.json` 里那条记录
   没有 `reply:true`，且 `quota status` 的“普通评论” +1、不是“回找我的人” +1。
9. **强制聚拢 fallback 真机**：单测已覆盖；真实视频里遇到“所有鱼楼都 >6 回复 / >72h / 刚聚拢过”时，
   看 `fishGuardLog` 最新一条 `gatherFallback:true` 且仍然发出；额度/冷却满时仍应被拒。
10. **C 模式真机一整天的执行**：当前 11:30（10–12 保底）待触发；看 `whale-night.json.slots` 的
    `fired/skipped/missed` 是否按计划推进，相邻 gap 是否 ≥20，skip 后是否继续下一 slot、而不是 done。
11. **行动质量的内容闸**：C 现在只保证“间隔 + 每窗保底 + 评分加餐”，还没有在醒来前检查
    `feed` 是否有新内容；如果 feed 空，仍可能低质量空跑。要彻底解决需加“轻醒”分支（日记/消息），
    这会改变“每次醒来都深读”的语义，需用户确认。
12. **C 不保证每窗 3 次**：9 窗 ×3=27 仍受 12 上限；当前只保证每窗至少 1。若用户后来要每窗 3，
    必须提高上限/拉长窗口，不能靠 C 排程硬塞。

### 回滚

- 代码：`git checkout -- src/bridge.js plugins/surfcore/lib/{scheduler,index,client,config,qq-fish-guard}.js ...`；
- 权限：设置页 B站 →「B站 会话权限」改回 `workspace-write`；或直接删 `bili.config.json` 的 `agent` 段（默认会回到 danger-full-access，
  要彻底关闭自动提权需改代码/配置为 workspace-write）；
- QQ 触发记录：`social-v2.json` 里删 `fishGuardLog` / `fishGuard` / `lastFishGuard` 字段即可；不动消息历史。

---

## 快照：2026-10-23 08:10–09:00（鱼群守则修复 + 真实点赞 + 观看历史）

### 本轮需求（用户原话要点）

1. 「关于冲浪的鱼群守则还有什么要优化的吗」——要具体优化，不要只回“都挺好”；
2. 「我很在意现在的小肥鱼能不能真正做到点赞别人发言」——要能证实/证伪，不能只显示一个“没反应”；
3. 「我需要在设置里能看到小肥鱼观看视频的历史记录」。

### 结论（先给答案）

- **点赞以前确实“看起来没反应”，根因不在点赞 API**：`fish-guard` 抓评论**没带 cookie**，
  B站 游客态 `/x/v2/reply` 只回 0~3 条 → 40 条样本永远凑不齐、`fishTopLevel=0`、`likeTargets=[]`。
  已修：`getJson/fetchCommentSection/fetchReplies/planFishGuard` 全部带 `credentials.json` 的
  `SESSDATA + bili_jct + buvid3`；真机验证同一视频从 `totalSample:3` 变成 `40`，识别 14 条鱼、4 个点赞目标。
- **并且发现测试污染了真实状态**：离线测试用假 fetch 返回 `-509`，`likeFishComments` 没传临时
  `stateFile`，把假失败写进了真实 `fish-guard.json`（`likeFailed: {"9": -509}`、`likeBlockedUntil`）。
  已给 `likeFishComments({ stateFile })` 加注入口，测试全部用临时文件，并已备份/清理真实文件里的假记录。
- **点赞可观测**：`likeFishComments` 记录 `lastLikeRun`（attempted/liked/failed/skipped/blockedUntil）与
  `likeFailed`（rpid/code/message，24h 冷却）；发完评论默认等 12s 再点，两次点赞随机 1.5~4s；
  设置页 B站 顶部「鱼群保护 · 运行状态」直接显示今天赞了几条、上次失败在哪个 code、风控冷却到什么时候。
- **点赞可独立发生**：`fish-guard like --bvid <BV>` 会自动查 aid（也支持 `--oid`）；调度器 prompt 新增
  step 4.6，让她在深读后独立给鱼点赞，不再只绑在“发评论成功”后面。
- **观看历史**：设置页新增「观看历史」页；`debrief`（浅看/深看）与直接 `watch-video` 写
  `bili/watch-history.jsonl`（按角色隔离、30 分钟去重、浅看→深看合并、2MB 轮转）；
  旧角色自动从 `bili-memory.json` 补历史，评分从 `scores.json` 合并；支持今天/7 天/深看/不同视频统计与搜索。
- **QQ 鱼群保护顺手修**：chat / reserved 模式下被直呼时，接收侧放行但发送侧会因 `unread` 已读而重新硬拦；
  现在和 reserved2 一样落 10 分钟 `fishGuardBypass`。冷却文案不再写死 10 分钟；鱼一直刷时状态写入节流到 30 秒一次。

### 本次已改动

| 文件 | 改了什么 | 状态 |
| --- | --- | --- |
| `plugins/surfcore/tools/lib/fish-guard.mjs` | cookie 采样；`extraFishMids`；`likeFailed/lastLikeRun`；点赞间隔/发完评论等待；`stateFile` 注入口；`fishGuardStateSummary` | ✅ 单测 |
| `plugins/surfcore/tools/commands/fish-guard.mjs` | `--bvid` 自动查 aid；status/plan 带登录态；打印失败 code；summary | ✅ 真机 plan |
| `plugins/surfcore/tools/commands/comment.mjs` | 把 `cred` 传给 plan；失败明细；发完评论等待 | ✅ 语法 + 单测间接 |
| `plugins/surfcore/tools/lib/watch-history.mjs` | **新增**：append/去重/轮转/读取/旧记忆回填/评分合并 | ✅ 单测 |
| `plugins/surfcore/tools/commands/watch-history.mjs` | **新增** CLI：`list [--limit/--q/--days/--json]` | ✅ |
| `plugins/surfcore/tools/commands/debrief.mjs` / `bili-watch.mjs` | 写观看历史；debrief→watch 防重复标记 | ✅ 契约测试 |
| `plugins/surfcore/lib/index.js` | `/watch-history`、`/bili/fish-guard` API | ✅ 单测间接 |
| `plugins/surfcore/lib/client.js` | 新「观看历史」页；B站顶部「鱼群保护 · 运行状态」；新 fishGuard 字段 | ✅ client contract |
| `plugins/surfcore/lib/scheduler.js` | prompt 新增独立点赞 step 4.6 | ✅ |
| `src/bridge.js` | chat/reserved 直呼 bypass 持久化；冷却写入节流 | ✅ 语法 + audit |
| `src/fish-guard.js` | 冷却文案按实际剩余时间 | ✅ 单测 |
| `src/character-persona.js` | 角色迁移/快照带上 `watch-history.jsonl` | ✅ 契约 |
| `scripts/test-watch-history.mjs` | **新增** 单测 | ✅ |
| `scripts/test-fish-guard.mjs` | 临时 stateFile、cookie 断言、extraFishMids | ✅ |
| `scripts/test-audit.mjs` / client contract / README / PITFALLS #30 / ROADMAP | 登记与文档 | ✅ |

### 已验证

- `node scripts/test-fish-guard.mjs` → OK；
- `node scripts/test-watch-history.mjs` → OK（追加/去重/轮转/旧记忆/评分/接线契约）；
- `cd plugins/surfcore && npm test` → 全绿（含 client contract 新增断言、host smoke 的 `/watch-history` + `/bili/fish-guard`）；
- `fish-guard plan --bvid BV1jhn16GEcv` → `totalSample:40`、`fishTopLevel:14`、4 个点赞目标；
- `npm run test:audit` → **45/45**。

### 尚未验证 / 待办

1. ✅ **真机真实点赞已验证（2026-10-23 08:24）**：`fish-guard like --bvid BV1jhn16GEcv --max 1`
   → `liked:["321564184096"]`（沉圻PhiLia的蓝色大肥鱼）、`dailyLikes:1/6`、`likeFailed:{}`、无风控冷却；
   `fish-guard.json` 里 `liked` 与 `lastLikeRun` 都已落盘；回读该评论 `like` 从 0 变 1、`action:1`。
   点赞 API 本身没有问题，之前是采样没带 cookie 导致没有目标。
2. **设置页真机截图**：`ui-tabs.mjs` 需要重启/刷新 DSH 加载新 client.js；新增「观看历史」页和「鱼群保护 · 运行状态」卡要在真实页面确认。
3. **旧记忆回填**：当前角色 `watch-history.jsonl` 原本不存在；第一次打开「观看历史」应看到从
   `bili-memory.json` 补出来的旧视频（实测 36 条，其中今天 4 条），跑一次 `debrief` 后会出现真实的
   [深看] 记录（已用 `BV1jhn16GEcv` 验证：UP、14:17 时长、评分 15 都正确）。
4. **B站 agent 会话权限**：08:00 的会话因 `%USERPROFILE%` 不满足 DSH 沙箱 `WRITE_OWNER` 而无法起命令，
   卡在审批；这是“她能不能真的做事”的更大前提。需要给该会话 `danger-full-access` 或换 DSH 拥有的工作区
   （本轮未改，见 PITFALLS #9 / AGENTS.md）。
5. **QQ 鱼群直呼 bypass**：逻辑已改，未有真机群聊复现；下次群里鱼刷屏时 @ 她一次，确认能回一句。

### 回滚

- 代码：`git checkout -- plugins/surfcore/tools/lib/fish-guard.mjs ...`（本快照表里所有文件）；
- 假状态备份：`~/.dsh/surfcore/backups/fish-guard-testpollution-2026-10-23T00-19-45-812Z.json`；
- 观看历史：删 `characters/<id>/bili/watch-history.jsonl` 即可（不影响 B站 本身）；
- 设置页：回滚 `client.js` 后刷新/重启 DSH。

---

## 快照：2026-10-23 07:40–08:20（角色人格：多角色 / 存档 / 回档 / 平台隔离）

### 本轮需求（用户原话要点）

1. 新系统叫「角色人格」，把人格卡和记忆卡合并进去；每个角色占一个文件（约定为目录包），
   里面有她的人格卡、衰减记忆卡、全量记忆卡；
2. 用户可以随时保存/回档当前角色；自动存档 12 槽（180/90/60/30/15/10/7/5/3/2/1 天 + 切换前）；
3. 可以新建角色，新建时加载自己的预设人格卡/记忆卡；不同角色文件相互独立；
4. 加载新角色时旧角色自动存档；**人格和记忆任何时刻全平台不能错乱**；
5. 切换后当天旧角色已做的评论/动态/看视频**不计入新角色，也不重走**；
6. **角色系统要能在设置页操作**。

### 结论（先给答案）

已实现并真机迁移/切换过一次。核心不是“换一个 md”，而是：

- **存储**：`~/.dsh/surfcore/characters/<id>/`（`persona.md` + `memory/` + `bili/` + `snapshots/`），
  `current.json` 是唯一真相，带 `epoch`；旧布局启动时自动迁成第一个角色（小咪），旧目录保留；
- **切换**：等记忆卡链清空 → 停 B站 调度器并 cancel 旧会话 → reset/停 QQ 桥接 → 拍 `before-switch` →
  写 `current.json`（epoch+1）→ 归档 `sessions.json`/`social-v2.json` → 生成新 prompt → 重启桥接/调度器；
- **隔离**：人格、衰减/全量记忆、QQ inbox、B站 额度/动态/评分/收藏/日记/分享排期/动态基线/待审/私信状态
  都按角色；B站 cookie、表情包、ffmpeg、身份对齐表仍全局；
- **行为不串/不重放**：B站 工具链新增 `tools/lib/state-paths.mjs`，每个进程启动时解析当前角色；
  B站 会话 id 带角色 id；分享排期/素材使用记录随迁移进角色包；动态基线不迁（新角色空基线不会重放旧动态）。

### 本次已改动

| 文件 | 改了什么 | 状态 |
| --- | --- | --- |
| `src/character-persona.js` | **新增**：角色目录包、`current.json`/`index.json`、创建/切换/更新/快照/回档/删除/迁移、`activeMemoryPaths`/`activePlatformStateDir`/`activePersonaFile`、`personaMeta` | ✅ 单测 |
| `plugins/surfcore/lib/characters.js` | **新增**：12 槽自动存档轮换、手动存档、业务层封装（create/update/restore/migrate/delete） | ✅ |
| `plugins/surfcore/lib/index.js` | 启动迁移；`/characters` API（create/load/update/snapshot/auto-snapshot/restore/delete/migrate）；切换编排；自动存档定时器；overview 暴露当前角色；`ctx.effect` 清理 | ✅ 单测 + 真机 |
| `plugins/surfcore/lib/memory-card.js` / `memory.js` / `persona.js` / `scheduler.js` | 记忆卡/记忆简报/人格卡/QQ→B站记忆按当前角色；B站 会话 id 带角色；`retire()` cancel 旧会话 | ✅ |
| `src/bridge.js` | 启动时解析角色：人格卡、记忆卡 prompt/inbox、B站 记忆/动态/分享 stateDir 都指向角色包 | ✅ |
| `src/bili-memory.js` | B站 侧角色名读 `characterPersonaMeta`（不再读全局 `bili.config.persona.name`） | ✅ |
| `plugins/surfcore/tools/**`（42 个文件） | 新增 `tools/lib/state-paths.mjs`；行为账本改 `biliState()`，cookie/表情包/bin 改 `accountBili()` | ✅ 真跑 `quota status` |
| `plugins/surfcore/lib/client.js` | 新增「角色」页：当前角色/记忆占用、全部角色、加载/新建（导入 md/json/jsonl）/删除、立即存档、更新自动存档、快照回档 | ✅ 真机截图 |
| 测试 | `test-character-store` / `test-bili-state-paths` / `test-character-api`（插件）；audit 清单更新；harness 注入角色模块 | ✅ |
| 文档 | README / RULES / FOLDER_MAP / ROADMAP / PITFALLS #29 / `docs/guides/CHARACTER_PERSONA.md` | ✅ |

### 已验证

- `npm run test:audit` → **44/44**；`npm run test:regressions` → **16/16**；
- `cd plugins/surfcore && npm test` → 全绿（新增 `test-character-api`）；
- 真机迁移：现有小咪数据 → `characters/char-mvk6wth4`，自动生成 `auto-2026-10-23` 快照；
  备份目录 `~/.dsh/surfcore/backups/character-migration-*`；
- 真机切换：建临时「测试切换」角色 → 加载（epoch 2，桥接/调度器重启，B站 session 变成 `bili-whale-char-mvk6yzbz`）
  → 加载回小咪（epoch 3）；测试角色目录已归档到 `backups/deleted-character-*`，索引已清理；
- 设置页「角色」页真机截图：当前小咪（epoch 3，记忆 25.3%）、存档 2 份（auto + before-switch）、
  保存/加载/回档按钮可见（`plugins/surfcore/docs/ui-characters.png`）；「新建角色」表单也已真机展开截图，
  人格卡 `.md` / 记忆卡 `.json` / 全量记忆 `.jsonl` 三个文件选择器可见（`ui-character-create.png`）。

### 尚未验证 / 待办

1. **在 UI 里真正点一次「创建并加载」并回档一次**（API/真机切换验证过；表单已渲染，未在真实页面提交，避免多建测试角色）；
2. **B站 偏好/额度规则仍是全局**（`bili.config.json` 的 `preferences`/`limits`）；如果希望每个角色不同口味，下一步搬进角色清单；
3. 回档不截断全量记忆（append-only，避免删真实记忆）；需要“精确到某天的全量回档”时再设计；
4. 切换会短暂停 QQ 桥接（几秒）；期间消息由 QQ/SnowLuma 侧排队；
5. 旧 `roles/*.md`、`~/.dsh/surfcore/memory`、`bili/*` 仍在（冷备份），确认稳定后可手动归档；
6. 旧 `state/bili-memory.*` / `state/bili-video-titles.json` 不再被读，可留作备份。

### 回滚

- 代码回滚：`git checkout -- <本次文件>`；`characters/` 可整体移进 `_quarantine/`；
- 旧布局数据未删除，移走 `characters/current.json` 后桥接/工具会回退旧路径（但迁移后新增数据在角色包里）；
- 切换/回档前都会自动拍快照；删除角色只归档不硬删。

---

## 快照：2026-10-23 07:14–07:40（QQ 白名单在设置页可见可编辑）

### 本轮需求（用户原话要点）

「QQ 的群和人的白名单要可以在设置页面显示并设置。」

### 结论（先给答案）

- 白名单功能一直都有（`allow.groups` / `allow.private`），但只藏在 QQ 页折叠的
  「白名单与权限」高级组里，默认不展开，用户找不到；
- 现在 QQ 标签页**顶部常驻卡片「QQ 白名单（群 / 人）」**：
  - 群 / 人分两栏，逗号分隔输入 + 实时计数 + chip 单个删除；
  - 管理员 QQ 在私聊名单里高亮；缺失时直接警告并提供「把管理员加进去」；
  - `allowAllWhenEmpty` 也在卡里，开启时红色警告（任何群/QQ 都能触发）；
  - 空名单会直接说明后果（群不响应 / 私聊全拦）。
- 原折叠组改成「黑名单（高级）」，只留 `deny.*` + 安全拦截通知，避免两处输入框。

### 本次已改动

| 文件 | 改了什么 | 状态 |
| --- | --- | --- |
| `plugins/surfcore/lib/client.js` | 新增 `WhitelistCard` / `IdListEditor` / `parseIdListText`；QQ 页顶部接入；折叠组改「黑名单（高级）」；概览加「私聊白名单 N 人」；管理员卡片警告改成指向新卡片 | ✅ 契约 + 真机截图 |
| `plugins/surfcore/scripts/test-client-contract.mjs` | 断言白名单卡片存在、绑定 `allow.*`、`deny.*` 仍在折叠组、白名单不再出现在折叠组 | ✅ |
| `plugins/surfcore/scripts/test-admin-config-api.mjs` | 新增白名单保存回环：去重 / 丢弃非法项 / `allowAllWhenEmpty` 落盘 | ✅ |
| `README.md` / 插件 README / PITFALLS #28 | 文档同步：白名单在设置页哪里、空名单/全放行的含义 | ✅ |

### 已验证

- `cd plugins/surfcore && npm test` → 全绿（含 client contract）；
- `test-admin-config-api` 新增白名单保存回环：临时目录里 POST `allow.private/groups` →
  去重、丢弃非法项、`allowAllWhenEmpty` 一起落盘（**不碰真实 config.json**）；
- `node plugins/surfcore/scripts/ui-tabs.mjs` → **真机截图** `plugins/surfcore/docs/ui-qq.png`：
  QQ 页管理员卡片下面就是「QQ 白名单（群 / 人）」，群 3 / 人 12，管理员 chip 高亮，删除 × 可见。

### 待办 / 回滚

1. 真机点一次「保存」→ 重启桥接 → 确认真实 `config.json` 的 `allow.groups/private` 与页面一致。
2. 回滚：`git checkout -- plugins/surfcore/lib/client.js plugins/surfcore/scripts/test-client-contract.mjs README.md plugins/surfcore/README.md`
   + 文档；纯 UI 改动，无数据迁移。

---

## 快照：2026-10-23 06:30–06:55（记忆多选合并 + 置顶排序 + QQ 双向发言）

### 需求

1. 之前多选记忆只能合并成「初次相遇」；现在想多选**其他记忆**时只合并为一个事件记忆，方便之后置顶；
2. 合并后虽然显示置顶，却排在一个重要度 100 的记忆后面；
3. QQ 记忆里只有主人发言，没有角色自己的发言；
4. **初次相遇必须永远排列表最顶**（即使还有别的置顶事件）。

### 已改动

- `src/memory-card.js`：新增 `mergeMemories(card, ids, { title, pinned, now })`：
  - ≥2 条任意记忆 → 一个事件；默认置顶（可传 `pinned:false`）；
  - 合并事件正文保留每条日期 + 原文摘要；标题可自定义，默认取第一条标题；
  - 继承被合并记录的最高重要度；混合 QQ/B站 时 scope 收紧为 `qq`，且不继承 `owner` 标签；
  - 拒绝合并 `firstMet` 记录（避免初次相遇元数据失效）；不改变 `firstOwnerAt` / `firstMet`；
  - 原记录从衰减卡移除，调用方先归档全量卡。
- `plugins/surfcore/lib/memory-card.js`：新动作 `merge-memories`；返回 `merged/removed/eventId`；维护器开头已归档，合并前原记录不会丢。
- `plugins/surfcore/lib/index.js`：动作白名单加 `merge-memories`。
- `plugins/surfcore/lib/client.js`：
  - 所有记录都可勾选（不再只限 owner）；
  - 多选工具条新增「合并为一个事件」+ 事件标题输入 + 「合并后置顶」复选框（默认开）；
  - 「设为初次相遇」在选中非 owner 时禁用；
  - 记录 chip 显示「合并事件」；合并成功 toast 显示条数。
- `src/memory-card.js`：记录新增 `botReply` / `isSelf` / `conversationKey`；`ingestInboxLines()` 把她的回复并进最近主人记录，没有对应主人才生成 `qq-self`；渲染显示「→ 她回：…」。
- `src/bridge.js`：`recordSelfMemoryEvent()`；v2 `sendMessagesV2()` 成功后记录整段回复，v1 `auditAndSend()` 成功后记录；inbox 带 `isSelf` / `conversationKey`，系统提示不记。
- `plugins/surfcore/lib/memory-card.js`：快照排序改为 **初次相遇 > 置顶 > 重要度/时间**；记录返回 `botReply/isSelf`；动作 `merge-memories`。
- 测试：
  - `scripts/test-memory-card.mjs` 新增合并、双向发言测试 → **22/22**；
  - `plugins/surfcore/scripts/test-memory-card-api.mjs` 新增 `merge-memories` 动作测试；
  - `scripts/test-memory-card-wiring.mjs` 断言 UI/API 接线。

### 验证

- `npm run test:memory-card` → 22/22
- `npm run test:memory-card-wiring` → OK
- `node plugins/surfcore/scripts/test-memory-card-api.mjs` → OK
- `cd plugins/surfcore && npm test` → 全绿
- `npm run test:audit` → 42/42（含本功能接线）

### 待办

1. 重启 DSH（设置页/宿主）后，在「记忆」页勾选任意 ≥2 条 → 「合并为一个事件」；
2. 合并默认置顶；列表应排在最前（置顶优先，而不是按重要度）；
3. 下一次和主人聊天后，主人记录应显示「她回：…」，或出现一条「她自己说的」记录；
4. 合并事件会替换原记录；原记录已进全量卡，可在全量面板搜索到。

---

## 快照：2026-10-23 06:15–06:45（产品化：设置页 / 提示词不再写死作者的角色名）

### 本轮需求（用户原话要点）

1. SurfCore 最后要给所有人用，但设置页还有很多写死的角色名，其他用户不知道那是谁；
2. **角色名 / 主人名只保留在角色卡和记忆卡里**。

### 结论（先给答案）

- 产品代码（UI、提示词模板、默认配置、测试 fixture）里不再写死具体角色名 / 主人名 / B站账号名；
- 需要名字时只从**用户数据**读：角色卡 `roles/*.md`、`bili.config.json` 的 `self.name` / `owner.name` /
  `persona.name`、`~/.dsh/surfcore/config.json` 的 `admin.displayName`；
- 结构化文案一律用通用称呼：「角色 / 主人 / 管理员 / 你」；记忆卡标题改成 `# 记忆卡`、
  `## 和主人（管理员）...`；
- `persona.file` 默认从写死某张卡改成**留空 + 自动发现**（配置路径 → `roles/角色卡.md` → `roles/*.md`），
  老用户已保存的 `persona.file` 原样有效，不需要迁移。

### 本次已改动

| 文件 | 改了什么 | 状态 |
| --- | --- | --- |
| `plugins/surfcore/lib/client.js` | 设置页分享说明、记忆卡标题/按钮/占位符、B站昵称占位符去掉具体名字；统一用「角色 / 主人」 | ✅ 契约测试 |
| `plugins/surfcore/lib/store.js` / `paths.js` / `persona.js` | `persona.file` 默认留空；`QQ_PERSONA_FILE` → `DEFAULT_PERSONA_FILE`；`resolvePersonaFile()` 自动发现角色卡 | ✅ `test-persona` / `test-store` |
| `src/memory-card.js` | 记忆卡标题、分区标题、主人记录标题/speaker 去名字；`looksNoteworthyMessage` 的角色名改由调用方传入 | ✅ `test:memory-card` 20/20 |
| `src/bridge.js` | 早安/搭话提示词改「用你自己的口吻」；判断提示改「你的名字/你的 B站昵称」；记忆摄取传当前角色名与 bot 昵称 | ✅ 语法 + 回归 |
| `src/bili-memory.js` | 去掉写死的角色名/账号名/B站昵称；`redactOwnerName()` 改为按 `owner.name`→`persona.ownerTitle` 配置替换；新增 `selfName()` | ✅ `test:bili-memory` |
| `src/bili-dynamics.js` / `src/bridge.js` | B站动态文案的账号名改读 `self.name`，缺省「B站账号」 | ✅ `test:bili-dynamics` |
| `src/bili-share-scheduler.js` / `src/share-mode.js` | 分享提示词改「用你自己的口吻（按角色卡）」；清理素材里的 @ 提及改成通用正则 | ✅ 单测 |
| `plugins/surfcore/lib/scheduler.js` / `memory.js` / `memory-card.js` / `align.js` / `index.js` | B站 唤醒/评论/私信提示词与注释里的主人名改「主人 / 管理员」；B站 记忆标题去账号名 | ✅ 语法 |
| `plugins/surfcore/tools/**` | 评论/动态/私信/待审队列等提示词与 console 文案改「管理员 / 角色 / 她」；四类动态默认前缀去名字 | ✅ 插件测试 |
| 测试 fixture | 角色名 / 主人名 / B站昵称 / QQ 号全部换成测试值；`test-persona` 改用内联卡，不再依赖本机某张具体角色卡 | ✅ 全套 |
| `README*` / `RULES` / `AGENTS` / `docs/**` / 插件 README / PITFALLS | 文案与示例同步；新增 PITFALLS #26 | ✅ |

### 已验证

- `npm run test:audit` → **42/42**；`npm run test:regressions` → **16/16**；
- `cd plugins/surfcore && npm test` → 全绿（含 client contract / store / persona / memory-card / host smoke）；
- `npm run test:memory-card` → 20/20；`npm run test:admin` / `npm run test:bili` → 通过；
- 全仓 grep 具体角色名/主人名（排除 `roles/`、`state/`、`config.json`）→ **0 命中**（只剩用户自己的数据）。

### 尚未验证 / 待办

1. **真机刷新设置页看文案**：本轮只改了字符串，契约测试覆盖；刷新 DSH 页面即可看到「角色短评 / 和主人的初次相遇」。
   插件客户端改动会随页面加载热更新；若没变，`plugin_manager` off→on 或刷新页面。
2. **B站 侧下一次醒来**：唤醒提示词改为「用你自己的口吻（按角色卡）」；桥接/插件进程需重启才加载新代码
   （桥接是独立进程；插件宿主随 DSH 重启）。
3. 记忆卡**历史数据里的名字不动**（`speaker`/标题是过去写下的记忆）；新记录用「主人」。这是有意的：
   记忆卡是用户数据，不做批量改写。

### 回滚

- 纯代码/文案改动，**没有数据迁移**：`git checkout -- <上面的文件>` 即回退；
- 角色卡、`~/.dsh/surfcore/memory/*`、`state/*`、`config.json` 全程未改；
- 回滚后 `persona.file` 仍按用户配置/`roles/*.md` 解析，不会丢角色卡。

---

## 快照：2026-10-23 05:10–05:40（定时分享找不到 + 分享卡片「小程序已下架」）

### 本轮需求（用户原话要点）

1. 「定时的分享视频到群里的那个，我怎么在设置页面里看不到？」
2. 「分享到群里的卡片我点击时显示小程序已经下架，你能修复这个问题吗？」

### 结论（先给答案）

1. **不是没做，是藏起来了**：`QqShareSection` 是 B站 页最后一个节点且默认折叠，标题也不含「定时/视频/群」。
2. **小程序卡片修不了，换卡片类型**：`get_mini_app_ark` 的 appid 在 SnowLuma 里写死
   （B站小程序 `1109937557`，已下架），桥接侧无参数可改；默认改用 `com.tencent.structmsg` 链接卡。

### 本次已改动

| 文件 | 改了什么 | 状态 |
| --- | --- | --- |
| `src/bili-card.js` | **新增**：`normalizeCardMode` / `buildBiliCardArk` / `createBiliCardSender`（注入式，可单测）；默认链接卡，小程序卡 opt-in，失败逐级降级 | ✅ 单测 |
| `src/bridge.js` | `sendBiliCard` 改用 `createBiliCardSender`；config 收敛 `share.cardMode`（`card` 变派生值） | ✅ 语法/回归 |
| `plugins/surfcore/lib/client.js` | 分享段挪到 B站 页顶部、默认展开、标题「定时分享视频到群（B站 → QQ）」；加状态行和「立即分享一次」；QQ 页加指路卡（`goTab`）；字段改成「卡片样式」下拉；失败不再只弹 toast，按钮下常驻 ✓/✗ | ✅ 契约测试；真机截图 |
| `plugins/surfcore/lib/index.js` | 新增 `POST /api/bili/share-now`（代理桥接控制台，120s 超时）；**修 P0**：代理 POST 必须带 JSON body（否则桥接 415，PITFALLS #23），并把结果写 `plugin.log` | ✅ host smoke / 真机发群 |
| `plugins/surfcore/lib/bridge.js` | `callBridge`：非 GET 一律带 `content-type: application/json`，无参数发 `{}`（空参数 ≠ 无请求体） | ✅ 单测 |
| `plugins/surfcore/scripts/test-bridge-status.mjs` | 新增断言：POST 带 JSON 头/`{}`，GET 不带 body | ✅ |
| `plugins/surfcore/lib/store.js` / `automation.js` | `cardMode` 收敛 + 快照透出 | ✅ 单测 |
| `scripts/test-bili-card-ark.mjs` | **新增**：模式收敛 / ARK 形状 / 默认不调小程序 / miniapp 失败降级 / 全失败返回 false / 桥接接线 | ✅ |
| `scripts/audit-bridge-harness.mjs` | VM 注入 `bili-card` 与 `fetchVideoInfo`（不注入会在 `main()` 里 ReferenceError） | ✅ 回归 16/16 |
| `scripts/test-bili-card.mjs` | 手动探针改成默认发链接卡，`--miniapp` 才试小程序 | ✅ 语法（未跑） |
| `plugins/surfcore/scripts/ui-tabs.mjs` | 修「点 SurfCore 点成了同名工作区」；每页截图前滚回顶部 | ✅ 跑过 |
| `plugins/surfcore/scripts/ui-share-shot.mjs` | **新增**：滚到「定时分享视频到群」并截图（PITFALLS #21 的验收脚本） | ✅ 真机截图 |
| `config.example.json`、README、plugin README、PITFALLS #21/#22、ROADMAP | 文档同步 | ✅ |

### 关键设计（为什么这样写）

- **旧配置不迁移数据，只改解释**：`card:true` 一律解释成 `link`。理由是小程序已下架，
  用户升级后应该直接拿到能点的卡；`card:false` 仍等价 `off`，`card` 保留成派生值，旧代码读它不会错。
- **小程序卡不删，只改默认**：万一 B站小程序恢复，`cardMode:'miniapp'` 可以立刻切回；
  但默认路径必须是桥接自己能控制的 `com.tencent.structmsg`。
- **降级顺序**：链接卡（自己拼 ARK）→ SnowLuma `share` 段 → 返回 false（AI 正文带链接）。
  注意 SnowLuma 的 `share` 段内部也是 structmsg，只是字段更少；两层都失败就别再发第三张卡。
- **分享段的位置算需求**：标题写「定时分享视频到群」、默认展开、QQ 页指路，三件缺一都会被当成"没做"。

### 已验证

- `node scripts/test-bili-card-ark.mjs` → 全部通过。
- `cd plugins/surfcore && npm test` → 全绿（含 client contract / store / automation config API / host smoke）。
- `npm run test:regressions` → **16/16**。
- `npm run test:audit` → **42/42**（新增 `test-bili-card-ark.mjs`）。
- `node plugins/surfcore/scripts/ui-share-shot.mjs` / `ui-tabs.mjs` → **真机截图确认**：
  插件客户端会随页面加载热更新（不需要重启 DSH），B站 页管理员卡下面直接就是
  「定时分享视频到群（B站 → QQ）」，状态行显示「卡片：链接卡」，卡片样式下拉是「链接卡（推荐）」；
  QQ 页的指路卡也在（见 `plugins/surfcore/docs/ui-bili.png`、`ui-share-section.png`、`ui-qq.png`）。
- **真机分享（2026-10-23 05:51，SnowLuma 已在线）**：直接以 JSON 调桥接 `/api/bili/share-now`
  → `sent=3`，三个群各收到一张卡 + 角色短评（`[reserved2] 工具统一发送 … 成功 1/1 条`）。
  当天 SnowLuma 的 `get_mini_app_ark` 调用数为 **0** → 发的是新的 `com.tencent.structmsg` 链接卡。
  这次也暴露并修掉了 PITFALLS #23（代理 POST 缺 JSON 头 → 桥接 415，点了没反应）。

### 尚未验证 / 待办

1. **在 QQ 里点一次刚发的卡片**：本轮已确认卡片发出（见上），但没人真的点过；
   点一下确认打开 B站 视频页、不再提示「小程序已下架」。
2. **「立即分享一次」按钮走完整 UI 路径**：代理与桥接两侧都已修好并单测/真机分开验证；
   插件已热重载（`include:surfcore` off→on），刷新设置页即可。再点会**再发一班**（真的发群）。
3. 桥接侧改动（`src/bridge.js` / `src/bili-card.js`）要**重启 QQ 桥接**才生效；当前桥接（pid 16712）
   已是新代码（05:27 重启 + 05:49 随 DSH 端口漂移自动重启）。
4. 「立即分享一次」会真发群并占用当天一个分享名额，点之前有 confirm；别在没人看群的时候连点。

### 06:05 补记：QQ 卡片全部走不通 → 默认改纯文本链接

**新证据（真机 + `get_friend_msg_history` 核对）**：
- 05:51 的 structmsg 卡片：QQ 显示「发送者版本过低，无法展示内容」。补测 ver=`1.0.0.19`、
  无 ver、SnowLuma 原生 `share` 段 → 前两种**消息被 QQ 静默丢弃**（`send` 返回 ok，历史里没有），
  share 段同样是「版本过低」；
- `get_mini_app_ark` 原样发（[测试6]）：能显示，点开仍是「小程序已下架」；
- 往 ARK 里注入官方卡才有的 `qqdocurl` / `scene:1036`（[测试5][测试7][测试8]）：**QQ 静默丢弃**，
  连历史都没有（`send` 仍返回 ok）；
- 用户自己发的 B站 官方分享卡：点开提示更新小程序资源，更新后**能正常打开** →
  B站小程序没下架，是 SnowLuma 生成的 `url` 无效 + ARK 签名不可改。

**结论**：以 SnowLuma 这个发送端，**没有任何一条能自动生成、可点击的 B站卡片**。
默认改成纯文本「【B站】标题 + 链接」，`share.cardMode` 三态 `text`（默认）/ `miniapp`（opt-in，点开仍是坏页）/ `off`；
旧值 `card:true`、`cardMode:'link'` 都收敛到 `text`。

**本轮收尾动作**：
- `src/share-mode.js` **新增**：`normalizeCardMode` / `buildBiliShareText`（纯逻辑，桥接与插件共用）；
  为什么要拆新文件：插件热重载不清 `src/` 的 ESM 缓存，换路径才让设置页立刻看到 `text`（PITFALLS #25）；
- `src/bili-card.js` 默认发 `text` 段；`buildBiliCardArk` 保留给诊断脚本，生产不走；
- `src/bili-share-scheduler.js` 提示词/日志从「视频卡片」改成「分享内容」；
- 设置页「分享形式」下拉：文本链接（推荐）/ 小程序卡片（已下架）/ 不发卡片；
- 测试同步：`test-bili-card-ark` / `test-store` / `test-client-contract` / `test-bili-automation` / `test-bili-memory`。

**已验证（06:06）**：
- 插件已热重载、桥接已重启（读新 `src/bili-card.js`）；
- 通过修好的 **插件代理** 点了一次「立即分享一次」→ HTTP **200**（不再是 415），`sent=3`；
- 群里实际收到：`【B站】标题` + 换行链接（`get_group_msg_history` 里是 `text` 段），
  随后是角色短评（不含链接）；链接在 QQ 里可点。
- 05:51 那张旧卡片仍是「发送者版本过低」，历史消息改不了，以后新分享都是文本。

**待办**：
1. 07:00 自动那班再确认一次（应该和 06:06 相同）；
2. 如果以后 SnowLuma 升级了它的 mini app share 签名，才考虑把 `miniapp` 切回默认（先真机点开验证）；
3. 私聊里 05:57–06:05 的 [测试1]～[测试8] 是诊断噪声，可以直接删。

---

## 快照：2026-10-22 16:36–17:05（B站额度/四类动态/QQ 分享可编辑 + 动态回复 P0）

### 本轮需求（用户原话要点）

1. 检查 B站 旧功能还正常不：看视频、评论、主动搭话、动态回复；
2. 各功能额度是多少、为什么设置页没显示；最近几小时频率是不是太少；
3. 四类动态、QQ 视频分享写在哪、为什么设置页看不到；
4. **全部修复，并改成可编辑**。

### 本次已改动

| 文件 | 改了什么 | 状态 |
| --- | --- | --- |
| `tools/lib/limits.mjs` | **新增**：四本账默认值/范围收敛/`freeLimits(cfg)`；默认值与旧硬编码完全一致 | ✅ 单测 |
| `tools/lib/free-gate.mjs` | `FREE_LIMITS` 改为读 `bili.config.json.limits`（实时）；新增 `usageToday()`；`globalMin=0` 可关冷却 | ✅ 单测 |
| `tools/lib/config.mjs` | DEFAULTS 加 `limits` / `dynamics`；`config()` 改成按 **mtime/size** 缓存（长驻进程也能改完下一轮生效） | ✅ |
| `tools/lib/kinds.mjs` | 四类动态改成可配置：`kindsNow` / `enabledKinds` / `dynamicsGapMin` / `normalizeDynamics` / `dynamicDefaults`；`slotOf` 按时段动态算 | ✅ 单测 |
| `tools/lib/kind-signals.mjs` | **新增**：动漫/AI/游戏区信号正则；修「动画/逐帧」误伤，可单测 | ✅ 单测 |
| `tools/commands/daily.mjs` | 读 `dynamics`（开关/时段/长度/前缀/间隔）；禁用类拒绝发布；信号判定改用 `hasKindSignal` | ✅ 语法/单测 |
| `tools/lib/msgfeed.mjs` | **P0**：19 位动态 id 优先从 `uri` 取字符串；不安全 id 留空；business 17 → type=17 | ✅ 单测 |
| `tools/commands/comment.mjs` | `--type 1|11|17`；动态回复自动识账接受 11/17；提示数字改实时额度 | ✅ 单测/语法 |
| `tools/commands/quota.mjs` | status 读实时 limits | ✅ 真实账本上跑过 |
| `lib/scheduler.js` | 唤醒/监听/催进度提示的数字全部读实时 limits；四类动态读 `kindsNow`；`daily` 指令补 `--kind` | ✅ 语法 |
| `lib/store.js` | 保存时 `normalizeLimits` / `normalizeDynamics`；BIDI_DEFAULTS 加两组 | ✅ `test-store` |
| `lib/automation.js` | **新增**：只读快照（今天用量/额度/四类动态/QQ 分享排期） | ✅ 单测 |
| `lib/index.js` | 新增 `GET /api/bili/automation` | ✅ host smoke |
| `lib/client.js` | B站 页新增「今天（只读）」卡片 + 「额度（代码闸门）」9 项 + 「四类动态」22 项；底部「B站 → QQ 自动分享」9 项；`QQ_BILI_SHARE_FIELDS` 导出 | ✅ 契约测试/语法；**待重启 DSH 看真机** |
| `scripts/test-msgfeed-oid.mjs` | 19 位 id / business 17 / 不安全 id 留空 | ✅ |
| `scripts/test-bili-automation.mjs` | 临时 DSH_HOME + QQBOT_ROOT：额度收敛、实时改配置、快照计数、QQ 分享排期 | ✅ |
| `scripts/test-automation-config-api.mjs` | 真实路由 GET/POST：保存额度/四类动态/QQ 分享，读回并收敛；快照同步 | ✅ |
| `scripts/test-kind-signals.mjs` | 动漫「动画/逐帧」、红警 2v3 | ✅ |
| `scripts/test-client-contract.mjs` | 加载 client.js factory，断言 B站 页 9 个额度字段/四类动态/QQ 分享字段/自动化接口 | ✅ |
| `scripts/test-host-smoke.mjs` | 增加 `/bili/automation` 断言 | ✅ |
| `scripts/test-store.mjs` | 增加 limits/dynamics 收敛断言 | ✅ |
| `tools/templates/config.example.json` | 补 `limits` / `dynamics` 示例 | ✅ JSON |
| `README.md`、`plugins/surfcore/README.md`、`docs/PITFALLS.md` #17/#18 | 说明额度、四类动态、QQ 分享在哪改；19 位 id 坑 | ✅ |

### 关键设计（为什么这样写）

- **额度唯一真相是 `bili.config.json.limits`**：`free-gate.mjs` 不再持有数字，`checkFree` 每次读配置；
  `config()` 用 mtime/size 缓存，调度器长驻也能下一轮生效。越界值 clamp，避免 UI 手滑写出负数。
- **四类动态拆两层**：`kindsNow()` 是“运行期有效值”（默认 + 用户覆盖），`DEFAULT_KINDS` 是“出厂值”；
  `daily.mjs` 和 `dynTick` 都读 `kindsNow()`，禁用的类不会提醒、也不会被 `daily` 发出。
- **质量门槛不开放**：近 N 天/播放/点赞率仍在 `daily.mjs` 的 `LIMITS`，因为那是“选题质量”，不是“发不发”。
- **QQ 分享是桥接配置**：仍写根 `config.json` 的 `biliBridge`，UI 只负责改；保存后必须重启桥接（桥接只在启动时读）。
  没把它挪进 `bili.config.json`，避免两套真相。
- **P0 是精度问题，不是阈值问题**：19 位 id > `2^53-1`，`JSON.parse` 先丢精度；`uri` 是字符串，必须优先。
  `subject_id` 不安全且没有 uri 时**留空**，宁可这次不识账，也不把评论挂到错的对象。
- **快照只读**：`/api/bili/automation` 不写文件、不发网络请求，UI 只拿它显示“今天用了多少 / 下一班几点”。

### 已验证

- `cd plugins/surfcore && npm test` → **全绿**（新增 5 个测试：msgfeed oid / automation / automation-config-api / kind signals / client contract）。
- `node plugins/surfcore/tools/commands/quota.mjs status` → 真实账本读数正常（21 条：0 普通评论 / 13 回评 / 8 搭话 / 0 分享 / 0 动态）。
- `npm run test:regressions` → 16/16。
- `npm run test:audit` → **39/41**（`test-audit-setup` / `test-qq-model-view` 的 `spawn EPERM` 是沙箱限制，与本次无关；`danger-full-access` 下应 41/41）。
- `node scripts/test-bili-automation.mjs` → 额度改 `daily=1` 后 `checkFree` 立即拒绝；快照四类/QQ 排期正确。

### 尚未验证 / 待办

1. **重启 DSH**：宿主 `index.js` / `automation.js` / `scheduler.js` 才会加载；刷新设置页后才看到新 B站 页。
2. **真机点一遍设置页**：B站 页顶部「今天（只读）」、两组可编辑项、底部 QQ 分享；改一个额度 → 保存 → 看是否落盘 + 下一轮生效。
3. **真机动态回复**：等下次有人评论自己的动态，确认 `comment-digest` 坐标是 `type=17 oid=…`，且 `quota status` 记进对应类。
4. **真机 QQ 分享**：在 B站 页改一个时间点 → 保存并重启 QQ 桥接 → 看 `bridge.log` 的新排期。
5. `client.js` 已 2000+ 行，继续加 UI 前应先拆组件（模块加载器只认 `require('react')`，拆文件要先验证加载方式）。
6. **历史误记不迁移**：2026-10-22 14:04 那条「回动态」仍记在「回找我的人」账本里；改账本会动已发生统计，
   这次只修未来（新回复按 type=17 + 精确 oid 记「动态回复」）。
7. 本次改动都在工作区未提交；`daily.mjs` 的动漫正则已从命令行现场修改搬进 `kind-signals.mjs`，提交时一起带上。

---

## 快照：2026-10-22 15:10–17:25（记忆卡：衰减卡 + 全量卡 + 「最初」/初次相遇）

### 本轮需求（用户原话要点）

1. 已经有角色卡（角色名由用户自己定），很好；
2. 再做一张**记忆卡**存B站账号的记忆，考虑上下文要有字数限制；角色卡基本不变，记忆卡一直变；
3. 记忆规则要像人类：最早（和主人最早相识）、最近、重要的事清晰；其余慢慢模糊；
4. 要一套「什么算重要」的判断规则；
5. 上网冲浪（B站、QQ 等）的记忆永久写入记忆卡；不同平台区分模块、共用一个文档；
6. QQ 聊天、B站说话都要同时加载角色卡 + 记忆卡；
7. 实时监测容量，80% / 90% / 100% 弹窗提醒压缩；
8. 动态系统：每天自动把不重要记忆按时间模糊化，最终完全遗忘；
9. 重要记忆判定尤其关注和主人（管理员）的互动细节与情感内容；
10. **（15:40 追加）全量记忆卡**：所有记忆全部清晰、不模糊、不遗忘；**平时只加载衰减记忆卡**，全量卡留给以后按需加载；
11. **（15:45 追加）设置页要像角色卡一样显示记忆卡，并明确当前加载的是哪一张。**
12. **（16:05 追加）衰减卡字数上限要能在设置里改；全量卡上限不能只有 50 万字，改成 10GB 或无限（供以后 AI 加载）。**
13. **（16:20 追加）输入框没反应要修；衰减卡上限从 30000 加到 100000。**
14. **（17:25 追加）「最初」= 最初接触的 30 天，且只算和主人的互动；前 10 天概率最大、中 10 天适中、后 10 天降低、30 天后很小。「最初」与「重要」是两套判断。用户可指定一条或多条（多条合并为一个事件）为和主人初次相遇。**

### 本次已改动

| 文件 | 改了什么 | 状态 |
| --- | --- | --- |
| `src/memory-card.js` | **新增核心引擎**：记录模型、重要度评分（主人/情绪/第一次/约定/道歉/B站打分）、清晰度目标与每日衰减（一次一档）、压缩、容量 80/90/100% 状态、QQ/B站 两套渲染与注入块、脱敏、inbox append、维护入口 | ✅ `node scripts/test-memory-card.mjs` 20/20 |
| `src/memory-card.js`（全量卡） | **全量记忆卡 v2**：`archiveDecayedToFull`（只 append JSONL）/ `ensureFullArchive`（迁移旧 JSON）/ `recallFullMemory`（流式扫描）/ `fullMemoryCardStatus`（按字节）/ `saveFullMemoryCard`（≤5MB 才出 md）；全量卡永不衰减、不生成 prompt | ✅ 单测 |
| `src/memory-card.js`（最初） | `initialProbabilityForOffset`（0.9/0.55/0.3/0.03）+ `refreshInitialState`（只算 owner、30 天窗口、确定性 hash）+ `designateFirstMeeting`（单条/多条合并）+ `clearFirstMeeting`；「最初」独立分区、不会被彻底遗忘 | ✅ `test-memory-card` 20/20 |
| `plugins/surfcore/lib/client.js`（最初） | 「初次相遇」摘要 + 主人记录复选框 + 「设为初次相遇」/「恢复自动」；记录 chip 显示「初次相遇 / 最初 first10…」 | ✅ 语法/console static |
| `plugins/surfcore/lib/memory-card.js`（全量卡） | 维护器先归档后衰减；pin/add/forget/compact/restore 都同步全量卡；`fullMemoryCardSnapshot` 流式召回；每天只备份很小的 stats，不复制 10GB JSONL；`memoryCardStatusNow` 返回 `loaded: 'decayed'` | ✅ 集成测试 |
| `plugins/surfcore/lib/paths.js`（全量卡） | 新增 `MEMORY_CARD_FULL_JSONL` / `_STATS` / `_JSON`（旧版）/ `_MD`（没有 prompt 文件） | ✅ |
| `plugins/surfcore/lib/index.js`（全量卡） | 新增只读路由 `GET /api/memory-card/full?q=&limit=` | ✅ host smoke |
| `plugins/surfcore/lib/client.js`（全量卡） | 记忆页顶部「当前提示词加载：衰减记忆卡」；新增「全量记忆卡（只存档）」面板：容量/条数、关键词搜索、全文预览、明确“未加载到提示词”；配置加 `fullMaxBytes`（GB，0=不限）；**衰减卡上限输入直接绑 unified 可编辑状态（修「输入没反应」），范围 2000~100000** | ✅ 语法/console static |
| `plugins/surfcore/lib/memory-card.js` | **新增插件维护器**：唯一写卡者；摄取 `state/bili-memory.json` + `memory-inbox.jsonl`；每日 backup + 维护；控制台快照/动作；告警私聊节流；8 秒后首次 + 每 10 分钟 tick | ✅ 集成测试通过 |
| `plugins/surfcore/lib/paths.js` | 新增 `MEMORY_CARD_JSON/MD/PROMPT_QQ/PROMPT_BILI/INBOX` 路径常量 | ✅ |
| `plugins/surfcore/lib/store.js` | `DEFAULT_UNIFIED.memoryCard` 默认值（与核心同源）；`saveUnified()` 里用 `normalizeMemoryCardConfig` 收敛上限（999999 → 100000） | ✅ |
| `plugins/surfcore/lib/index.js` | 启动/销毁记忆卡定时器；`/memory-card` GET/POST（maintain/compact/pin/forget/ack/add/restore/notify-test）；概览 `memoryCard`；保存配置后立即重渲染 | ✅ host smoke 里 GET 正常 |
| `plugins/surfcore/lib/scheduler.js` | `identityContextLines()` 增加 `memoryCardBlockForBili()`（只读 B站 注入块） | ✅ |
| `src/bridge.js` | 消息进线时 `recordMemoryInboxEvent`（主人全记、群友只记直接/情绪/约定）；v1 角色提示 + v2 唤醒提示 + `qq_get_prompt` 注入记忆卡；`/api/memory-card/notify` 只私聊 ownerQQ（10 分钟节流） | ✅ 语法 + 接线测试；**需重启桥接** |
| `plugins/surfcore/lib/client.js` | 记忆页顶部「记忆卡」面板（容量条 / 三档告警 / 最近记忆 / 置顶/忘记 / 手动记一条 / 规则配置 / 两份注入预览 / 备份恢复）；主界面每 60 秒检查并弹窗（立即压缩 / 2 小时后再提醒 / 本次不再提醒） | ✅ 语法；待刷新页面/重启 DSH 生效 |
| `scripts/test-memory-card.mjs` | 评分/锚点/inbox/B站/隐私/遗忘/压缩/容量/渲染/脱敏/幂等/补跑/全量归档/全量召回/最初概率/初次相遇/配置收敛 | ✅ 20/20 |
| `scripts/test-memory-card-wiring.mjs` | 桥接/调度器/插件/控制台/路径接线的源码级回归 | ✅ |
| `plugins/surfcore/scripts/test-memory-card-api.mjs` | 临时 DSH_HOME + 临时 QQBOT_ROOT 跑维护、pin/add/forget/compact/ack、幂等 | ✅ |
| `scripts/audit-bridge-harness.mjs` | VM 注入 `memory-card` 导出；`DSH_HOME` 指向 fixture，避免测试写真实记忆 | ✅ 修完 test-reply-wait 10/10 |
| `docs/guides/MEMORY_CARD.md` | 规则/评分/容量/隐私/配置/API/验证/已知边界 | ✅ 新增 |
| `README.md`、`plugins/surfcore/README.md`、`RULES.md`、`docs/README.md` | 记忆卡说明与索引 | ✅ |

### 关键设计（为什么这样写）

- **单写者**：插件宿主写卡，桥接只 append `memory-inbox.jsonl`；避免两个进程同时改 JSON 互相覆盖。桥接/调度器只读现成的 `memory-card-prompt-{qq,bili}.md`（mtime 缓存），文件是唯一契约。
- **一次降一档**：`targetClarity()` 算目标，`applyDailyDecay()` 每天只移动一格；pinned / 主人重要记忆（≥65）有下限，所以不会「今天还在、明天失忆」。
- **评分不调模型**：权重固定、可解释、可单测；调参只改 `src/memory-card.js`。
- **隐私 scope 是硬的**：QQ 记录 `scope=qq`，B站 渲染只取 `bili/shared`；时政/娱乐圈 `sensitive` 只留本地；入库前统一脱敏。
- **容量按完整 md 算**：注入另有 `injectMaxChars.qq=2200` / `bili=2000`；满 100% 自动压到 90%，但告警按峰值 100% 保留。
- **告警两条出口**：控制台弹窗（主）+ QQ 私聊管理员（可选，同一档 12h 一次；桥接侧再 10min 节流）。
- **全量卡是底账，不是第二份注入**：`archiveDecayedToFull()` 在衰减/压缩/遗忘之前执行，只 append 到 `memory-card-full.jsonl`；全量卡**不生成 prompt 文件**，桥接/调度器也没有读它的路径，所以“平时只加载衰减卡”是结构约束，不靠自觉。
- **全量卡只增不删**：记录固定 `clarity='vivid'`；`fullMaxBytes` 默认 10GB、`fullMaxRecords` 默认 0（不限），超过只告警；要清理只能人工导出/备份后处理，代码不会自动删。
- **10GB 不是靠整份 JSON 硬撑**：v2 用 append-only JSONL + stats，容量按字节算，不渲染整份档案；md 导出只在档案 ≤5MB 时生成。
- **设置页明确“加载哪张”**：`memoryCardSnapshot` 返回 `loaded:'decayed'` + `loadedLabel`，顶部固定显示；全量面板标 `fullLoaded:false` + “未加载到提示词”。

### 已验证

- `npm run test:audit` → **41/41**（`danger-full-access` 一次性跑；workspace-write 下两个 spawn 用例如实按 EPERM 报环境限制）。
- `npm run test:memory-card` → 20/20（含「停机补跑」「全量卡保留已遗忘记录」「全量召回」「最初概率/初次相遇合并」）；`npm run test:memory-card-wiring` → OK。
- `node plugins/surfcore/scripts/test-memory-card-api.mjs` → OK。
- `cd plugins/surfcore && npm test` → 全绿（host smoke `SMOKE OK`）。
- `node scripts/test-reply-wait.mjs` → 10/10（harness 修复后）。
- `node scripts/test-console-static.mjs` → 全部通过。
- **本机实际维护已跑通**（16:19 日志）：新增 B站 2 / QQ 8 条，当前 **44.9%（5392/12000 字）**；
  `~/.dsh/surfcore/memory/` 已生成 `memory-card-full.jsonl`（87KB）+ stats，旧 `memory-card-full.json` 已迁移为 `.legacy-*`。

### 尚未验证 / 待办

1. **重启 DSH**：宿主代码（维护器/API/调度器/面板）生效；重启后看「记忆」页顶部是否写「当前提示词加载：衰减记忆卡」，以及 `/api/memory-card`、`/api/memory-card/full`。
2. **重启 QQ 桥接**：桥接才开始把主人消息写进 inbox，并在提示词里注入记忆卡（只读衰减卡的 prompt 文件）。
3. 首轮整理后检查 `~/.dsh/surfcore/memory/`：`memory-card.json/.md`、两份 prompt、`memory-card-full.jsonl` + `memory-card-full-stats.json`（+ 可选 `memory-card-full.md`）；B站 记忆应从 `state/bili-memory.json` 摄取，全量卡条数应等于衰减卡（首次）。
4. 真机验证：管理员发一条情绪消息 → 下一条 QQ 提示词出现「和主人（管理员）的记忆」；B站 醒来提示词有记忆卡且不含 QQ 私事、不含全量卡。
5. 容量弹窗：临时把 `maxChars` 调小 → 页面 60 秒内弹窗；「立即压缩到 80%」后回落。
6. 全量卡：在记忆页搜索一个刚被衰减/忘记的词，应能查到原文；确认聊天提示词里没有全量卡内容。
7. **`npm run test:audit`**：在 workspace-write 沙箱里是 39/41（`test-audit-setup` / `test-qq-model-view` 的 `spawn ... EPERM` 是沙箱禁止子进程管道，不是回归）；用一次 `danger-full-access` 跑完是 **41/41**。**全绿的前提是允许 spawn**。
8. 记忆卡是启发式：如果实测发现主人闲聊占容量太快，调 `minOwnerImportance` / 权重，不要靠提示词硬压。

---

## 快照：2026-10-22 14:35–14:47（对齐表加「称呼」：以后只叫这个；单边也可以）

### 背景

上一轮（管理员身份）做完后用户重启了 DSH（14:26，新端口 `17173`），
`/overview.admin` 已返回对齐身份 —— 上一轮的宿主投影 + B站 提示词已经真正生效。

本轮需求：在**对齐**里给某个人指定 QQ 号 + B站 UID + 称呼，以后 QQ / B站 都只用称呼叫他，
不再叫成 QQ 群名片 / B站昵称。

### 本次已改动

| 文件 | 改了什么 | 状态 |
| --- | --- | --- |
| `plugins/surfcore/lib/align.js` | 对齐记录新增 `label`（称呼）；QQ 简报有称呼时带 QQ 号（按 ID 对上）+ 称呼优先规则；B站 简报带称呼但仍不带 QQ 号；**只有 QQ / 只有 B站 的单边记录设了称呼后也会进对应一侧简报（独立小节）**；`stats.labels` | ✅ `node scripts/test-align.mjs` 通过 |
| `plugins/surfcore/lib/client.js` | **对齐页顶部**新增粉色「以后只叫他（称呼）」输入框；「已对齐」表格新增「称呼」列，可直接改/清；add 时带 label；**单边也能填称呼**；旧宿主时输入框禁用并提示重启 | ✅ 语法通过；待 DSH 重启后生效 |
| `plugins/surfcore/scripts/test-align.mjs` | 扩展：有称呼时的 QQ/B站 简报、无称呼时保持旧格式 | ✅ |
| `plugins/surfcore/scripts/test-align-label-api.mjs` | 新增：临时目录跑真实 `/align` add/update，断言落盘、简报重建、改称呼、清称呼、B站 不带 QQ 号 | ✅ 已加入插件 `npm test` |
| `plugins/surfcore/README.md`、根 `README.md` | 对齐结构加 `label`，说明称呼优先级与生效时机 | ✅ |
| `docs/PITFALLS.md` | 新增 #13：认人键只能是平台 ID，昵称会变/会撞 | ✅ |

### 关键设计（为什么 QQ 简报只在有称呼时带 QQ 号）

- 旧规则是「QQ 号不出现在简报里」，但那样只能靠昵称匹配；昵称会变、会撞，正是这次要解决的问题。
- 取舍：**只有管理员明确设了称呼的链接**才带 QQ 号，并写明“只用来对发送者、绝对不要念出来”；
  没设称呼的链接保持旧格式。B站 简报无论如何都不出现 QQ 号/群号。
- **只有 QQ / 只有 B站 的人也能设称呼**：以「只在 QQ 登记过 / 只在 B站 登记过」的独立小节进对应一侧简报；
  之后补齐另一边时 `addLink` 会合并同一 QQ/同一 B站 的单边旧记录并继承称呼，不会同一个人两条；
  没设称呼的单边记录不占提示词（旧行为）。
- 生效时机：`writeAlignmentBriefs()` 保存时立刻重建两份简报；QQ 桥接按 mtime 重新读，下一条消息生效；
  B站 每次醒来重读文件。**不用重启桥接**。

### 尚未验证 / 待办

1. **宿主代码要重启 DSH 才生效**（`align.js` 的 label 归一化、`/align` 写盘）。
   客户端新界面刷新页面即可看到；在旧宿主上对齐页会显示黄色提示「宿主还是旧代码」，
   称呼输入框被禁用（防止“提示成功但其实没存进去”）。**先重启 DSH 再用**。
2. 重启后建议实测：对齐页填 QQ `10001` / B站 mid `87654321` / 称呼「小零」→ 保存 → 「已对齐」表格出现称呼 →
   让那个人在群里说一句话，看角色是否用新称呼（QQ 简报下一条消息即生效）。
3. 若要给管理员本人也设称呼：管理员卡片（`admin.displayName`）已经覆盖 QQ/B站 两侧；
   对齐表里再建一条也不会冲突（称呼规则一致）。

---

## 快照：2026-10-22 14:15 左右（管理员身份 + 对管理员温柔规则）

### 本次已改动（代码 + 配置）

| 文件 | 改了什么 | 状态 |
| --- | --- | --- |
| `src/admin-identity.js` | 新增：管理员身份规范化/旧字段推导/保存投影（`projectAdminSave`）/QQ·B站两份提示词/`【管理员·温柔】`标记 | ✅ `node scripts/test-admin-identity.mjs` 通过 |
| `src/bridge.js` | 角色提示（每条消息）和二代唤醒提示各注入管理员规则；管理员消息标记改 `【管理员·温柔】`；`loadConfig()` 补上 `admin` 字段（白名单式重建，漏了会静默变 undefined） | ✅ 语法通过；**桥接已重启（pid 24956），`/api/socialV2/prompt` 实测 role.hint 含规则 + mid + 用户** |
| `plugins/surfcore/lib/store.js` | 合体层 `admin` 默认值；`readAll` 读时用旧字段推导；`readUnified` 增加 `hasAdmin`（修合并默认值把显式空串误判的问题） | ✅ 插件测试通过 |
| `plugins/surfcore/lib/index.js` | 保存时调 `projectAdminSave`：一次写 `ownerQQ` + `bili.owner` + 合体层 `admin`；overview 增加 `admin` 摘要 | ✅ `test-host-smoke` 通过；**需重启 DSH 生效** |
| `plugins/surfcore/lib/scheduler.js` | B站 每次醒来/评论区/私信/直播间注入主人温柔规则；`identityContextLines` 顺序改为 人设→管理员→对齐→QQ记忆 | ✅ 语法通过；**需重启 DSH 生效** |
| `plugins/surfcore/lib/client.js` | QQ / B站 两个标签页**顶部**新增同一张「管理员（QQ ⇄ B站 · 同一个人）」卡片；移除旧的散落字段 `ownerQQ` / `owner.mid` | ✅ 语法通过；**已用本机 Edge headless 实测**：刷新页面后 QQ / B站 两个标签页顶部都能看到卡片（QQ / B站 / 称呼三个字段都已带出），截图 `state/ui-probe-qq.png`、`state/ui-probe-bili.png`；**保存投影仍需重启 DSH** |
| `config.example.json` | 新增 `"admin": null`（空=用旧字段/未配置） | ✅ |
| `roles/<角色>.md` | 第七节补「对主人永远温柔、不顶嘴」 | ✅ 提示词注入即生效 |
| `scripts/test-admin-identity.mjs` | 新增单测（规范化/推导/冲突/保存投影/两份提示词/B站 不出现 QQ 号） | ✅ 已加入 `test:audit` 与 `npm run test:admin` |
| `scripts/test-admin-prompt-wiring.mjs` | 新增：用真实 `bridge.js` 源码断言唤醒/角色提示/消息标记都带规则 | ✅ 已加入 `test:audit` |
| `plugins/surfcore/scripts/test-admin-config-api.mjs` | 新增：临时目录里跑真实 `/config` GET/POST，断言三份文件同步、正常保存不抹 owner | ✅ 已加入插件 `npm test` |
| `plugins/surfcore/scripts/test-admin-bili-prompt.mjs` | 新增：B站 提示词认主 + 不出现 QQ 号 + 关掉温柔只留身份 | ✅ 已加入插件 `npm test` |
| `docs/PITFALLS.md` | 新增 #12：合并默认值后空串覆盖旧 owner 的坑 | ✅ |
| `plugins/surfcore/README.md`、根 `README.md` | 管理员卡片 / 三份文件投影 / 温柔规则说明 | ✅ |

### 本机已写入的管理员（默认同一个人）

| 平台 | 值 | 落在哪 |
| --- | --- | --- |
| QQ | `3287064288` | `config.json` 的 `ownerQQ`（+ `admin` 投影） |
| B站 | 用户自己的 mid/昵称 | `~/.dsh/surfcore/bili.config.json` 的 `owner.mid/name` |
| 称呼 | 用户自填 | 合体层 `~/.dsh/surfcore/config.json` 的 `admin.displayName` |

写入前已备份到 `~/.dsh/surfcore/backups/unified-config-*.json` 与 `qq-config-*.json`。

### 尚未验证 / 待办

1. **运行中的插件仍是旧代码**（`/overview` 还没有 `admin` 字段）：需要**重启 DSH**，
   刷新设置页后确认 QQ / B站 顶部出现管理员卡片、值已带出。
   - 客户端 bundle 已能从磁盘取到新卡片（实测 `plugins/??…surfcore/client.js` 含 `AdminCard`），
     刷新页面就能看到；但**保存投影要等宿主代码生效**，所以建议先重启再改管理员设置。
2. **QQ 桥接已重启并验证**（`/api/socialV2/prompt` 的 `role.hint` 已含「管理员 · 温柔模式」、
   `绝不回嘴`、`37634003`、`用户`）。还差真机发一条管理员消息看语气。
3. `npm run test:audit` 39/39、`npm run test:regressions`、插件 `npm test` 全绿。
4. B站 侧要等 DSH 重启后才会用新 `scheduler.js`；重启后可在她下一次醒来时看提示词。
5. 若用户手动改了 `~/.dsh/surfcore/config.json` 的 `admin` 为空对象 `{}`，
   会当作「显式清空」→ 下次保存会把两边 owner 清掉（这是设计，不是 bug）。

---

## 快照：2026-10-22 13:00 左右

### 背景（当天发生了什么）

1. 上午 DSH 崩溃：工作区列表全空、新建报 `workspaceController is unavailable`。
   根因是一个**身份错位**的会话日志（详见 `PITFALLS.md` #1）。坏目录已隔离到
   `~/.dsh\_quarantine-20261022-122709\`（未删除；用户说先留着，发现危险因素再说）。
2. 之后我给 `app.asar` 做了**等长字节补丁**，让「坏会话只跳过、不炸服务」。
   - 离线功能验证通过（解包 asar + cordis 起 `sessionPersistence` + 错位文件 → `list()` 返回 0 条不抛错；正常会话仍列出）。
   - **已原地写入本机 asar（13:00）**：实测运行中的 asar 允许同长度写入，只是不允许改名/删除。
     `node scripts/patch-dsh-session-guard.mjs --apply-in-place` 只写了 95 字节，`--check` = `patched`；
     原文件备份为 `resources\app.asar.bak-2026-10-22T05-00-06-256Z`。
   - 换入方式走过的弯路：计划任务守候进程在 DSH 退出时被以 `0xC000013A`（Ctrl+C）终止，没换成；
     于是改用「原地写」，不再依赖后台守候。计划任务与 `app.asar.guarded` 已清理。

### 本次已改动（代码）

| 文件 | 改了什么 | 状态 |
| --- | --- | --- |
| `scripts/patch-dsh-session-guard.mjs` | 新增：asar 字节补丁（check/apply/out/**in-place**），等长替换 `Error` → `SessionPersistenceCorruptionError` | ✅ 已原地应用，`--check`=patched |
| `scripts/install-session-guard.mjs` | 新增：预生成副本、退出后换入、计划任务守候、冒烟与回滚（本轮未用上，作为备用路径保留） | ✅ 语法通过；未执行换入 |
| `plugins/surfcore/lib/index.js` | 旧工作区清理**整段删除**（不是改成隔离，是彻底不再有这段逻辑）；插件不再对工作区目录做任何写/删 | ✅ 语法+`test:audit` 通过；**下次启动生效** |
| `scripts/check-session-integrity.mjs` | 新增：与目录名无关的会话日志体检（目录名/id、项目目录/cwd、重复 id、不可读），默认只读，`--quarantine` 只做 rename | ✅ 本机 16 条全绿；用隔离区旧文件反向验证能精确报出 `cwd=surfcore` 放在 `surface_core` |
| `AGENTS.md` | 新增：本工作区自动注入的工程纪律（十条铁律、环境事实、交付定义） | ✅ 已被 DSH 自动加载（本轮会话已看到注入） |
| `docs/ROADMAP.md` | 新增：路线守则、目标/底线/妥协、路线候选、人工决策点 | ✅ |
| `docs/PITFALLS.md` | 新增：9 条踩坑档案（含本次 P0 事故全流程） | ✅ |
| `docs/RISK_REGISTER.md` | 新增：风险台账（审计结果 + 残余风险 + 修复状态） | ✅ |
| `docs/README.md` | 索引补上以上文档 | ✅ |
| `plugins/surfcore/lib/index.js` | 「一键启动」按需打开 SnowLuma WebUI（已登录不打扰 / 停在登录页才打开 / 没运行则启动后打开）；启动自检与 overview 增加 SnowLuma 诊断（not-running / needs-login / onebot-rejected） | ✅ 语法+smoke+audit 通过；**重启 DSH 生效** |

### 尚未验证 / 待办（按优先级）

1. **护栏补丁下一次启动生效**（文件已改好，当前进程仍跑旧代码）。
   - 验证：重启后 `npm run guard:check` 应为 `patched`；`npm run check:sessions` 全绿。
   - 回滚：`resources\app.asar.bak-2026-10-22T05-00-06-256Z` 改回 `app.asar`。
2. **插件清理逻辑改动未在真机走过**：下次启动后确认插件日志里**不再出现**「清理旧工作区」任何字样（这段代码已删除）。
3. **`privacy-scan` 还有 3 处命中**：均为 `test-store.mjs` 的合成夹具（`'secret-token'` 等），已确认误报。
4. **README 版本口径**：README 写「实测于 DSH 0.2.1-rc.2」，但正文多处仍提 0.2.0-rc.2；待统一。
5. 计划任务 `DshSessionGuard` 已删除；`state\guard-watch.cmd`、`app.asar.guarded` 也已清理。

### 环境指纹

- DSH：`<DSH 安装目录>`，`0.2.1-rc.2`；用户数据 `~/.dsh`。
- 本会话网关：`http://127.0.0.1:61609`（端口会漂移，别硬编码）。
- 工作区：`<仓库根>`（当前），另有 ptc / 开场动画 / 杀戮尖塔 / slang-agent 等 7 个。
- 关键备份：`~/.dsh/_quarantine-20261022-122709`（坏会话）、
  `resources\app.asar.bak-2026-10-22T05-00-06-256Z`（打补丁前的原始 asar）。
  （`~/.dsh/_fix-backup-2026-10-22` 的 profile 配置副本已在 2026-10-23 SurfCore 迁移收尾时删除——里面只有改名前的配置快照。）

### 收工检查单

- [ ] `npm run test:audit` 全绿
- [ ] `npm run check:sessions` 全绿
- [ ] `npm run guard:check` 状态符合预期（本机 patched / 未换入时 unpatched）
- [ ] 本文件「尚未验证」段落已更新
- [ ] 新踩的坑已写进 `PITFALLS.md`
- [ ] 路线有变化已写进 `ROADMAP.md`

---

## 安装进度规矩（2026-10-28 用户明确要求）

**凡是"安装/下载"类操作，都必须有可见进度条**（`ProgressBar` 组件，`lib/client.js` 模块级）：

- 有百分比就给 `pct`；拿不到百分比（pip 安装、合并解压）用不确定态 `indeterminate`；
- 目前覆盖：语音包安装、桌宠安装、Electron 下载、一键安装（按步骤）、更新应用；
- 新增安装入口时**必须**同时接进度条，并在 `npm test` 里能跑通（至少 `test-client-contract.mjs`）。

## 修 bug 记录规矩（2026-10-28 用户明确要求，优先级最高）

**修完任何一个 bug，必须写一份 `docs/cases/YYYY-MM-DD-<slug>.md`，并在 `docs/cases/README.md` 的表格里登记一行。**

- 模板：`docs/cases/_TEMPLATE.md`（现象 / 环境 / 根因 / 修法 / 验证 / 遗留，六段缺一不可）；
- 只写结论不算记录：至少要有「代码位置」「为什么之前没发现」「怎么验证的」「没验证到什么」；
- 影响用户的 bug 还要同步一条到 `docs/PITFALLS.md`（按坑记，case 按 bug 记，两者互补）；
- **CHANGELOG 里要带 case 链接**：每个修复版本末尾写一行 `> 调查记录：[标题](docs/cases/xxx.md)`；
- 已有案例见 `docs/cases/README.md`。

## 发版规矩（2026-10-28 用户明确要求，优先级最高）

1. **版本号由用户决定**：`node scripts/version.mjs bump` 之后**不要直接发布**，
   必须先开一个确认窗口问用户「这次用哪个版本号」，用户回复后按他给的号改 `package.json`
   （root + plugins/surfcore）并重跑 `node scripts/version.mjs check`。
2. **发布前确认清单**（一次问清，别挤牙膏）：
   - 版本号（用户填）
   - 是否要 tag + Release
   - 是否要同步 `opensource/surfcore`（公开仓库）
3. 发布方式：`github.com:443` 经常不通 → 用 `scripts/publish-via-api.mjs`（走 api.github.com），
   `--since <本地已有的远端祖先>` 用于 API 造提交后本地没有远端树的情况。
4. 发完回填：`CHANGELOG.md`、本文件「尚未验证」、需要时 `PITFALLS.md`。
