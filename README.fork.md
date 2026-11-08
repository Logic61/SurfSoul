# SurfSoul — 基于 SurfCore 的本地大改版（QQ × B站 × 桌宠）

> **本仓库叫 SurfSoul**（[github.com/Logic61/SurfSoul](https://github.com/Logic61/SurfSoul)）：它是 [Mieksido/surfcore](https://github.com/Mieksido/surfcore)（下称 **SurfCore**）的**非官方衍生版（fork）**，与 SurfCore 维护者无关，也未获上游背书。
>
> - **分叉点：SurfCore v0.6.22（2026-10-28，MIT）**，commit `d7f6b33`（与上游同 tag 是同一个 commit）；
> - 分叉后本地累计 **56 个提交**（作者 `logic`，2026-10-30 ~ 2026-11-07），新增 65 个文件、修改 122 个文件；
> - **版本号仍沿用 `0.6.22`**（未跟随上游 bump，`package.json` 未改）；上游同期已独立走到 **v0.8.9**（2026-11-07）；
> - SurfCore 的问题/功能请求请回[原仓库](https://github.com/Mieksido/surfcore)；SurfSoul 的问题、改动请找 SurfSoul 维护者；
> - 许可仍为 **MIT**，`LICENSE` 原样保留上游版权声明（`Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors`）。
>
> **一句话**：SurfSoul 不是「SurfCore 加几个补丁」，而是从 v0.6.22 另起一条线（+56 提交、净 +30,724 / −1,267 行）——权限模型、记忆体系、工具面、桌宠/看屏幕、语音、工程门禁都做了大改。
>
> **名称对照**：**SurfSoul = 本仓库/本衍生版**（对外名称，仓库 [Logic61/SurfSoul](https://github.com/Logic61/SurfSoul)）；**SurfCore = 上游原项目**（[Mieksido/surfcore](https://github.com/Mieksido/surfcore)）。仓库内部标识仍是 `surfcore`（npm 包名、DSH 插件行 id、preset 里的 `surfcore/*` 说明符、`~/.dsh/surfcore` 状态目录、环境变量 `SURFCORE_ROOT`；DSH 设置页里目前也仍显示「SurfCore」）——这是 DSH 绑定与向后兼容、以及 UI 暂未改名的事实，**不随对外名称改**。

---

## 目录

- [一、与原仓库的关系](#一与原仓库的关系)
- [二、SurfSoul 是什么](#二surfsoul-是什么)
- [三、差异总览（12 个主题）](#三差异总览12-个主题)
- [四、新增功能（按主题）](#四新增功能按主题)
- [五、行为改动：权限与安全模型](#五行为改动权限与安全模型)
- [六、与上游当前版 v0.8.9 的差异](#六与上游当前版-v089-的差异)
- [七、安装](#七安装)
- [八、文档索引](#八文档索引)
- [九、许可与致谢](#九许可与致谢)
- [十、维护策略](#十维护策略)

---

## 一、与原仓库的关系

| 项 | 值 |
| --- | --- |
| 上游 | [Mieksido/surfcore](https://github.com/Mieksido/surfcore)（MIT，下称 **SurfCore**） |
| 本仓库 | **SurfSoul** — [github.com/Logic61/SurfSoul](https://github.com/Logic61/SurfSoul)；内部包名/插件 id 仍为 `surfcore`（见上方「名称对照」） |
| 分叉点 | **v0.6.22**（2026-10-28），commit `d7f6b33`（与上游 v0.6.22 tag 同一 commit） |
| 本地 HEAD | `060796c`（2026-11-07） |
| 分叉后本地提交 | **56 个**（作者 `logic`，2026-10-30 ~ 2026-11-07；`git rev-list --count v0.6.22..HEAD`） |
| 相对分叉点差异 | **187 个文件**（新增 65 / 修改 122 / 无删除），净 **+30,724 / −1,267** 行 |
| 上游最新 | **v0.8.9**（2026-11-07）；v0.6.22 之后上游独立走了 **34 个正式 Release**（v0.7.0–v0.7.23 共 24 个 + v0.8.0–v0.8.9 共 10 个，另有 13 个 `-dev` 预发布 tag） |
| 上游分叉后改动 | 相对 v0.6.22：**491 个文件，+82,718 / −30,968 行**（`git diff v0.6.22..v0.8.9`）；本地同期 187 个文件，+30,724 / −1,267 行 |
| 标签情况 | 本地只有 `v0.6.22` 一个 tag；上游共 **79 个** tag（含 v0.6.0–v0.8.9 与 dev 预发布） |
| 版本策略 | **仍写 0.6.22**，不跟上游版本号比较；见 [§十](#十维护策略) |
| 许可证 | MIT（`LICENSE` 原样保留上游版权声明） |
| 演进关系 | v0.6.22 是共同祖先，之后**两条线独立演进**：上游继续 0.7.x / 0.8.x，SurfSoul 从 v0.6.22 往前改自己的方向 |

> ⚠️ 不要用「落后上游 34 个版本」理解 SurfSoul：本地没有 merge 过上游 v0.7.0–v0.8.9 的任何提交，两边是**分叉后的两条独立线**，差异是功能取向不同，不是简单的版本落后。具体缺什么见 [§六](#六与上游当前版-v089-的差异)。

---

## 二、SurfSoul 是什么

一句话：**这是一个把 SurfCore 往「更像真人、更敢在群里干活、但权限收得更硬」方向推的个人向大改版。**

相比原版 v0.6.22，它主要多了这些方向的能力：

- **权限模型重做**：本机工具/账号级/群管理动作从「只认主人私聊」放宽到「**主人本人触发的那一个回合**」，并加一道**内部模型审批**逐次评审（fail-closed）+ 审计流水；群友权限硬边界不变。
- **记忆体系升级**：长期记忆从「一张静态卡」变成「叙事层 + selfNote 自我认知 + 文档记忆互通 + 原文库证据链 + 按需召回」。
- **工具面扩张**：好友申请、群管理（禁言/解禁/群名片）、跨场合投递、发送前评审、QQ 自身资料（签名/说说）、生图、看屏幕、B站分镜等（`qq_*` 工具 39 → 49）。
- **桌宠/目的机制与看屏幕**：截屏 → 视觉判定 → 决定要不要主动搭话；新增 leaky 概率闸门，桌宠与 QQ 两条载体共享同一套闸门。
- **工程门禁**：`test:audit` 从 77 个脚本扩到 105 个，`restrict` 名单按运行中 DSH 的 `app.asar` 对账（87 → 99），新增唤醒决策流水/安全姿态/数字生成物等可核对设施。

**能力总览（全部为 git/仓库实测，口径见 `docs/guides/CURRENT-NUMBERS.md`）**

| 指标 | 值 | 说明 |
| --- | ---: | --- |
| 分叉后提交 | **56** | 作者 `logic`，2026-10-30 ~ 2026-11-07 |
| 改动文件 | **187** | 新增 65 / 修改 122 |
| 净增删行 | **+30,724 / −1,267** | `git diff v0.6.22..HEAD` |
| 改动主题 | **12** | 见 [§三](#三差异总览12-个主题) |
| 测试脚本 | **166**（fork 点 132，+34） | `scripts/test-*.mjs` + 插件测试 |
| `qq_*` MCP 工具 | **49**（fork 点 39，+10） | `src/mcp-snowluma-safe.js` |
| `config.example.json` 叶子键 | **400**（fork 点 283，+117） | 新增能力基本都有独立配置段 |
| `test:audit` 脚本 | **105**（fork 点 77；含本次新增 `test-plugin-package`） | 发布前必跑 |
| `src/bridge.js` | **18,427 行**（fork 点 15,060） | 桥接主进程 |
| `src/*.js` / MCP server | **57 个 / 4 个**（fork 点 44 / 3） | 新增 `mcp-stock-safe` |

---

## 三、差异总览（12 个主题）

> 口径：按「提交归属」把 56 个提交归入唯一主域，行数为毛增删（同一文件反复改动会累加，故合计略大于整仓净 diff；12 域合计 +31,531 / −2,074）。逐主题的提交清单与改动行数可用 `git show <hash> --stat` 直接核对。

| # | 领域 | 原版 v0.6.22 | SurfSoul 现在 | 关键提交 / 文件 |
| ---: | --- | --- | --- | --- |
| 1 | **QQ 权限/审批/出站闸门** | 本机/账号级/群管理动作只认「主人私聊」；无审批；无好友申请/禁言/跨场合/出站评审 | 「主人本人触发的回合」临时可用 + **逐次内部模型审批**（fail-closed）+ 审批流水/安全姿态；好友申请、群管理、跨场合、发送前评审全新增 | `fb99c7a` `0c2705b` `5565afb`；`src/turn-trigger.js`、`plugins/surfcore/qq-owner-approval.mjs` |
| 2 | **QQ 桥接核心/运维** | token 失配后全天 401 直到人工重启；断线期间消息补不回；每轮重发全量记忆卡；收尾即换会话 | 401 自愈重试；断线按旧水位 60/240/600s 幂等补历史；唤醒提示瘦身 45%；收尾后静置 5 分钟再换 session | `82ed8dc` `231ad32` `e3e1064` `a8bce77`；`src/bridge.js`、`src/conversation-closure.js` |
| 3 | **QQ 表达与工具面** | 群里不能画图；无签名/说说；表情包有频率劝退；黑话要「多次出现才提」；梗记忆工具被守卫拒绝 | 群聊可画图（有配额）；签名/说说；表情包/盗图软策略；黑话直接提；梗记忆四工具进执行期白名单；`qq_send_image` 规避 OneBot 2MiB 上限 | `f0a797d` `2612198` `934345e` `7bb09b4` `c7a1563`；`src/imagegen.js`、`qq-tool-restrict.mjs` |
| 4 | **记忆系统** | 只有一张衰减记忆卡 + 全量卡；无叙事/自我认知/文档互通/原文召回 | 叙事层（可查可编辑，上限 120→300）+ selfNote + 文档记忆（语感本薄版/两本日记）+ 原文库 L0 + `qq_recall` + 隐私纵深 | `4ba4af7` `472aee0` `86aae11` `342af1e` `b6f9c2e`…；`src/{memcard-narrative,memory-card,memory-docs,memory-search,self-notes}.js` |
| 5 | **B站/工具链** | 深读只有旧九宫格；工具账本并发会丢记录；部分网络读/子进程无超时 | 可引用分镜 `watch-storyboard`（9 格编号图 + 每格时间/台词）；`--download-only` 路线；账本原子写 + 全链路超时 + 出站身份闸补 4 个出口 | `4ae13d7` `33e048d` `cd85d34`；`plugins/surfcore/tools/{commands,lib}/watch-storyboard.mjs` |
| 6 | **桌宠与目的机制** | 目的机制「到点就发」；busy 字段自锁导致主动搭话永久停摆；桌宠读不到最近 QQ 记忆 | 目的机制收口；桌宠专用记忆注入块（4200 字）；叙事上限 300；`autoStart`；桌宠 LLM 90s 超时；对话里可「按需看屏幕」 | `c4d8bab` `af237b1`；`plugins/surfcore/lib/{pet-purpose,pet-chat,pet}.js`、`memory-card-prompt-pet.md` |
| 7 | **看屏幕** | **完全没有 screen 代码** | 截屏 → 视觉判定 `{summary,activity,busy,interruptible,privacy}` → 决定要不要搭话；阈值 / **leaky 概率**双策略；桌宠 + QQ 两条载体共享同一闸门 | `377f8ea` `1df9b9f`；`plugins/surfcore/lib/{screen-capture,screen-watch-core,screen-watch-service}.js` |
| 8 | **语音** | 合成超时被中文正则兜底成 HTTP 400，模型反复重试 | 失败结构化（超时 504 / 连不上 502 / 空音频 502）+ 耗时日志 + 改回文字提示；本机 TTS 预算 60s → 150s | `e16afcf` `8c34578`；`src/voice-tts.js`、`docs/cases/2026-10-31-voice-tts-timeout.md` |
| 9 | **控制台/设置页** | 语音目录被旧草稿覆盖；切角色写错人格卡；保存成功显示红字；深色主题不可读 | 统一走草稿/warn 通道；切角色后重读人格卡；坏配置自动隔离 `.corrupt-<ts>`；深色主题 token 化；`/api/browse` 去掉 PowerShell 注入面 | `262010d` `e6b157e`；`public/console.html`、`plugins/surfcore/lib/{client,store}.js` |
| 10 | **更新/打包** | 批量更新只落地最后一个 job；`ensureSession` 失败被缓存成 ready；只有仓库模式安装 | 更新改 jobs 队列逐 job 幂等落地、失败下 tick 重试；另提供 **Layout B 自包含 DSH 插件包**（整仓库即 npm 包，见 [§七 B](#b-自包含-dsh-插件包surfsoul-新增建议优先)） | `246ca09`；`scripts/apply-update.mjs`、`plugins/surfcore/package.json` |
| 11 | **安全/审计** | 唤醒为什么没醒只能翻日志；安全状态散落各处；MCP 可直连 OneBot 写动作 | 唤醒决策流水 + 安全姿态一屏 + 重启恢复唤醒 + OneBot 只读边界（5 个只读动作 + 运行时断言）+ 隐私闸私钥死循环 P0 修复 | `ccc177d` `cee8797` `9e44eec`；`src/{wake-decisions,onebot-readonly}.js`、`lib/privacy.js` |
| 12 | **文档与内部工具** | 文档里的数字靠手写，漂过「3 个 MCP server / 15,000 行 / 47 个工具」 | `npm run docs:numbers` 生成 `CURRENT-NUMBERS.md` + 校验测试；`state:usage` / `config:check` 只读报表 | `f6be196` `7aab19a`；`scripts/{doc-numbers,state-usage,config-check}.mjs` |

---

## 四、新增功能（按主题）

> 下面按 10 个功能面归纳 CHANGELOG 顶部 26 段 `## [未发布]` 记录；每节表格的「证据文件」都可直接 `git show <hash>` 或打开文件核对。

### 4.1 权限模型：主人回合归因 + 内部模型审批

原版把「本机执行 / 账号级动作 / 群管理」锁死在 `private:<ownerQQ>`（主人私聊）；SurfSoul 放宽为「**本回合的触发消息发送者是 ownerQQ 本人**」时临时可用，并在 DSH 插件层对每次特权调用做**内部模型审批**。授权只认桥接按真实 `event.user_id` 写下的归因事实（模型无法伪造），审批只是启发式安全层。

| 能力 | 是什么 | 入口（设置/工具/配置） | 证据文件 |
| --- | --- | --- | --- |
| 回合触发者归因 | 投递 prompt 前记录「本回合谁发的」；定时/系统唤醒（timeout/replyCheck/proactiveCheck/history/friendRequest/recovery/poke）**一律不算主人触发**；插件读不到归因 → fail-closed | 无 UI；状态 `state/turn-triggers.json` | `src/turn-trigger.js`（475 行）、`plugins/surfcore/lib/turn-trigger.js`（694 行） |
| 内部模型审批 | 对本地执行 10 个 / 账号级 3 个 / 群管理 2 个工具逐次评审：低中风险 allow、高风险 deny；坏 JSON/超时/异常/缺路由一律 fail-closed；模型批准的本地调用在 `approval/request` 领取一次 `allowed-once` | `socialV2.toolApproval.*`（`enabled`/`model`/`timeoutMs`/`maxReviewsPerTurn`/`triggerWindowMs`…） | `plugins/surfcore/qq-owner-approval.mjs`（504 行） |
| 审批流水 | 每次 allow/deny/fail 追加一行 JSONL（工具/决定/风险/理由/延迟/触发者归因，**不含参数与令牌**） | `GET /api/tool-approvals?limit=N`（仅控制台令牌） | `state/tool-approvals.jsonl` |
| 安全姿态 | 审批开关/failClosed/今日 allow·deny·fail/最近一次时间等聚合成一屏 | `GET /api/security-posture`；控制台「访问与安全 → 安全姿态」 | `src/bridge.js` |
| 一键回滚 | `enabled=false` 立即回到 v0.6.22 旧行为 | `socialV2.toolApproval.enabled` | `config.example.json` |

### 4.2 好友申请与群管理动作

两类「账号级/群级」真会生效的动作，都是原版没有的：

| 能力 | 是什么 | 入口（设置/工具/配置） | 证据文件 |
| --- | --- | --- | --- |
| 好友申请查看/处理 | SnowLuma 只在有人加好友时推一次事件 → 桥接落盘（pending 保留 7 天/最多 50 条）；`approve=true` **真的会加好友**；留言/昵称标 `untrusted`，只当资料看 | 工具 `qq_list_friend_requests` / `qq_handle_friend_request`；端点 `GET /api/socialV2/friend-requests`、`POST …/handle-friend-request` | `src/friend-requests.js`（312 行）、`state/friend-requests.json` |
| 新申请主动唤醒 | 收到新申请主动唤醒主人私聊，让她自己决定加不加（用户要求「权限放开，由模型自己判断」） | `socialV2.friendRequests.{wakeOnRequest,wakeMinIntervalMs}`；控制台「二代仿真 → 工具开关 → 好友申请」 | `src/bridge.js`（`wakeReason=friendRequest`） |
| 群禁言/解禁 | `qq_set_group_ban`：`durationSeconds` 秒，`0`=解禁，最长 30 天；目标必须是本群成员，且不是她自己/管理员/群主/其他管理员 | 工具开关 `socialV2.tools.setGroupBan`；控制台工具开关 | `src/bridge.js`、`plugins/surfcore/lib/index.js` |
| 改别人群名片 | `qq_set_group_card` 的「改别人」分支：旧行为（主人私聊）+ 新的「主人触发回合」路径 | `socialV2.tools.setGroupCard`；`socialV2.adminActions.windowMs`（默认 10 分钟兜底）、`maxPerHour`（默认 20） | `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 第 20 条 |
| 群成员名单（只读） | 管理员只喊昵称时，AI 需按昵称/群名片解析真实 QQ 号并避开群主/管理员 | `GET /api/socialV2/group-members`（带会话令牌） | `qq_get_group_members` 的 v2 通道 |

### 4.3 记忆体系（叙事 / selfNote / 文档互通 / 原文库）

| 能力 | 是什么 | 入口（设置/工具/配置） | 证据文件 |
| --- | --- | --- | --- |
| 叙事层 | 把散记忆压成「我们一起经历过的」故事，可查/可编辑/可关；上限 `maxEpisodes` 120 → 300 | 设置 → 记忆（叙事可见/可关）；`socialV2.memoryNarrative.*` | `src/memcard-narrative.js`（490 行）、`memory/memory-card-narrative.json` |
| selfNote 自我认知 | 她写「我最近变成什么样」，**按角色共享**、整句去重、40 条上限、每条 200 字；只在 bootstrap（新会话第一轮）注入一次 | 控制台「轻量记忆 → 自我记录」；`GET/POST /api/socialV2/self-notes`；`socialV2.selfNotes.*` | `src/self-notes.js`（233 行）、`memory/self-notes.json` |
| 文档记忆互通 | B站 语感本**薄版**每轮注入、厚本按需 `qq_recall`；两本日记同步进 QQ（私密日记只在私聊）；文件一改下轮跟随（SHA-1 指纹） | `socialV2.docMemory.*`（`maxChars` QQ 1100 / 群 900） | `src/memory-docs.js`（432 行）、`bili/语感本-薄版.md` |
| 原文库 L0 + 证据链 | inbox 事件补 `messageId`/`sourceId`/`evidence`；追加式 `memory/events/<YYYY-MM>.jsonl`（id 幂等、可重建索引） | 自动（插件维护）；`qq_recall` 检索 | `src/memory-card.js`、`archiveInboxToEvents()` |
| `qq_recall` 按需召回 | 中文 bigram 倒排、带「哪本/哪一节/时间」出处；群聊严格按会话隔离；空结果提示「记不清了，不要编」 | 工具 `qq_recall`；`GET /api/socialV2/recall`；`socialV2.recall.*` | `src/memory-search.js`（164 行） |
| 隐私纵深 | 记忆记录 `audience`（any/private-only/group-only）+ `memoryScene.groupExcludePrivate` 硬开关 | `socialV2.memoryScene.*` | `docs/guides/MEMORY_CARD.md`、`RULES.md` |
| 唤醒预览 | 排障「文档记忆/记忆卡/selfNote 到底进没进提示词」：直接跑 `buildWakePromptV2` 返回模型真会看到的内容（令牌打码） | `GET /api/socialV2/wake-preview?key=&reason=`（控制台令牌） | `src/bridge.js` |

### 4.4 场合作用域与受控跨场合投递

原版「记忆共同、分清场合」只靠提示词自律；SurfSoul 落成结构化作用域，并新增一条默认关闭的跨场合投递通道。

| 能力 | 是什么 | 入口（设置/工具/配置） | 证据文件 |
| --- | --- | --- | --- |
| 三层作用域 | ① 轻记忆 `rule` 的 `scope`（global/private/group/group:<id>/here）；② style-notes 行首 `[全局]/[私聊]/[群]/[群:123]`；③ 记忆记录 `audience`。每轮注入【场合】卡（场合 + 群名 + 语气 + 私聊边界） | `socialV2.scenes.{defaultPrivate,defaultGroup,overrides}`；`socialV2.memoryScene.*` | `src/scene-scope.js`（387 行） |
| 跨场合投递 | 只允许「主人发起 → `allowTargets` 显式白名单群」，且目标还要命中 QQ 发送白名单；桥接代投、不把目标 token 下发模型；一条纯文本，过敏感/身份/长度/频率/token/静默/鱼群闸 | 工具 `qq_send_cross_scene`；`socialV2.crossSceneSend.*`（默认 **关**）；`socialV2.tools.crossSceneSend` | `src/bridge.js`、`docs/guides/BOUNDARIES.md` |

### 4.5 发送前评审

原版没有出站评审；SurfSoul 把评审搬进桥接，在 `send-message` / `send-burst` 真正发送前先打分，低于阈值**不发**，把理由作为工具错误回给模型改写——修掉「回合结束才评审 → 已发出的消息只能补一条更正版」造成的连发。

| 能力 | 是什么 | 入口（设置/工具/配置） | 证据文件 |
| --- | --- | --- | --- |
| 发送前评审 | 评审 prompt = 情景（群/私聊、近 10 分钟发言量、最近 4 条）+ 抽象记忆卡（≤620 字，缓存）+ style-notes；低于 `threshold` 退回 | `socialV2.review.*`（模板默认 `enabled=false`） | `src/presend-review.js`（639 行） |
| 安全阀 | 评审失败/超时/解析失败默认 failOpen 放行；同 key 通过后 2 分钟跳过；被退回 3 次/10 分钟后放行；<8 字不审 | 同上 | `src/presend-review.js` |
| 退回兜底 | 评审退回后 90 秒内没有重新发送成功 → 自动补发最后一版稿子（用户拍板） | `socialV2.review.rejectFallbackMs`（默认 90000） | `src/bridge.js` |
| 调参/排障 | 只评审不发送；可传真实场合/记忆卡/最近对话试评分 | `POST /api/socialV2/review-preview`（控制台令牌）、`node scripts/review-dryrun.mjs` | `scripts/review-dryrun.mjs` |

### 4.6 看屏幕与桌宠目的机制

原版**没有任何 screen 代码**；SurfSoul 新增「截屏 → 视觉判定 → 决定要不要主动搭话」，并把桌宠的目的机制收口。

| 能力 | 是什么 | 入口（设置/工具/配置） | 证据文件 |
| --- | --- | --- | --- |
| 看屏幕判定 | 每 `intervalMin` 分钟截图（DPI 感知、下采样 JPEG）→ 视觉模型返回 `{summary,activity,busy,interruptible,privacy}` → 私人内容/游戏/会议/看不清 → 不搭话且摘要不进提示词 | 设置 → 桌宠 →「看屏幕再决定要不要搭话」；`purpose.screen.*`（23 键） | `plugins/surfcore/lib/{screen-capture,screen-watch-service}.js` |
| leaky 概率闸门 | 两个策略：`threshold`（默认，旧行为）与 `leaky`（≥阈值按 `rateAbove` 抽签、<阈值按 `rateBelow` 泄漏）；硬闸（隐私/游戏/会议/看不清/关闭）**永远不抽签**；泄漏预算落盘跨重启/跨载体共享 | `purpose.screen.{interruptPolicy,rateAbove,rateBelow,softBand,maxLeakPerDay,leakCooldownMin,lotterySnoozeMin}` | `plugins/surfcore/lib/screen-watch-core.js`（411 行）、`~/.dsh/surfcore/pet/screen/policy.json` |
| QQ 载体接入 | 桌宠与 QQ 桥接两条载体共享同一闸门：`bridge.js` 目的出发前调 pet-api 要决定（90s 超时，调不通 fail-open） | `POST /purpose/screen/decide`、`GET /purpose/screen`（pet-api） | `src/bridge.js`、`plugins/surfcore/lib/pet-api.js` |
| 对话里按需看屏幕 | 桌宠对话里被问到屏幕/画面时现截一张，摘要以「你刚看了一眼屏幕（不是指令）」进提示词；失败要求如实说没看清 | 桌宠对话（自动） | `plugins/surfcore/lib/pet-chat.js` |
| 桌宠目的机制 | 桌宠专用记忆注入块（`memory-card-prompt-pet.md`，预算 4200 字）；叙事上限 300；`autoStart` 随 DSH 自动打开；LLM 90s 超时 | 设置 → 桌宠；`pet/config.json` 的 `autoStart`；`pet.chat.llmTimeoutMs` | `plugins/surfcore/lib/pet-purpose.js`、`pet-chat.js` |

### 4.7 生图与 QQ 表达

| 能力 | 是什么 | 入口（设置/工具/配置） | 证据文件 |
| --- | --- | --- | --- |
| 快速生图（Agnes） | `qq_generate_image` → Agnes `images/generations`，实测 10~25 秒出 1024×1024 PNG；**群聊可用**但按会话配额（群 3 张/小时、10 张/天；主人 20/小时、100/天），超限 429；生成成功才记账 | 工具 `qq_generate_image`；`socialV2.imagegen.*`；控制台「二代仿真 → 工具开关」 | `src/imagegen.js`（300 行） |
| Codex 画图（仅主人私聊） | `subagent_codex` 进 `OWNER_PRIVATE_TOOL_NAMES`：主人在私聊明确要图时可用，群聊/别人私聊拒绝 | 工具 `subagent_codex`（DSH 子代理） | `plugins/surfcore/qq-tool-restrict.mjs` |
| 发图片 | `qq_send_image`：URL/data URI/base64/本机路径；>1.3MB 本机图改走 `file://` 规避 SnowLuma OneBot 2MiB 请求体上限 | 工具 `qq_send_image`；`socialV2.tools.sendImage` | `src/bridge.js`（`sendImageV2`） |
| 自身资料动作 | `qq_set_signature` 改她自己 QQ 的签名（空串=清除，≤120 字）；`qq_send_qzone` 发她自己 QQ 空间说说（1~1000 字，好友/所有人/仅自己） | 工具 `qq_set_signature` / `qq_send_qzone`；`socialV2.tools.{setSignature,sendQzone}` | `src/bridge.js`、`src/identity-guard.js` |
| 表情包软策略 | 允许「只用一张表情作为一条回复」、鼓励盗图收藏；硬约束不变（一条只能一张、每轮 ≤8 条、收藏限流 2/分钟 & 50/小时） | preset 第 14/15 条；`socialV2.sticker.collect.*` | `src/sticker-lib.js`、`dsh/agent-presets/qq-chat-v2/agent.cordis.yml` |
| 黑话直接提 | 删掉每会话 2 次/分钟、10 次/小时的提交限流与「多次出现才提交」前置；看到没把握的词就直接提交（管理员仍要确认） | 工具 `qq_slang_submit`；`socialV2.tools.slangSubmit` | `src/bridge.js`、`docs/guides/AGENT-TOOLS-AND-PRESETS.md` |
| 梗记忆四工具 | `search_meme_wiki` / `meme_recall` / `meme_feedback` / `meme_remember` 进 QQ 执行期白名单（以前 schema 可见但一调就报「不在白名单」） | 工具（dsh-memewiki v2） | `plugins/surfcore/qq-tool-restrict.mjs` |

### 4.8 语音

| 能力 | 是什么 | 入口（设置/工具/配置） | 证据文件 |
| --- | --- | --- | --- |
| 合成失败结构化 | 超时 `TTS_TIMEOUT`→504、连不上 `TTS_UNAVAILABLE`→502、voxd 非 2xx/空音频→502；AI 通道文案追加「请改回打字，不要重试」 | 自动；设置 → 语音 | `src/voice-tts.js`、`src/bridge.js`（`voiceSynthError()`） |
| 超时预算 | 本机 CPU 版 GSV 单条合成实测 70~126s → 本机 `timeoutMs` 60s → 150s（MCP 外层 300s 仍是硬上限） | `socialV2.voice.tts.timeoutMs` | `docs/cases/2026-10-31-voice-tts-timeout.md` |
| 失败可见 | 桥接日志打印「合成完成 <ms>（N 字）」/「合成失败 <ms>：<code> <msg>」，能分清引擎慢还是引擎挂 | 桥接日志 | `src/bridge.js` |

### 4.9 B站 工具链与分镜

| 能力 | 是什么 | 入口（设置/工具/配置） | 证据文件 |
| --- | --- | --- | --- |
| 可引用分镜 `watch-storyboard` | 720p 直链 + WBI 官方字幕 → 9 格**编号**图 + 每格起止时间/frame/台词 + 音频包络；看图后按「第 N 格」引用，细节 `--from/--to --cells 4` 重出；缺 `dsh-video-storyboard` 自动降级旧 `watch-video` 九宫格（不新增硬依赖） | B站 会话 CLI 命令表 | `plugins/surfcore/tools/commands/watch-storyboard.mjs`（206 行）、`tools/lib/watch-storyboard.mjs`（297 行） |
| 路线 A（本机专用） | `watch-storyboard <BV> --download-only` 只备素材（打印 `MP4:`/`SUBS:`、不写历史），B站 会话直连原生 `video_storyboard` / `video_zoom` | `--download-only` | `docs/guides/SUBSYSTEM-BILI.md` |
| 工具链 P1 收口 | 账本改跨进程锁 + tmp/rename 原子写；网络/子进程补超时；出站身份闸补 4 个公开出口（daily/edit-dynamic/danmaku/dynamic-image） | 自动 | `plugins/surfcore/tools/lib/{atomic-json,http-timeout}.mjs` |
| 梗记忆/黑话工具面 | 见 [§4.7](#47-生图与-qq-表达) | — | — |

### 4.10 工程门禁、安全姿态与打包

| 能力 | 是什么 | 入口 | 证据文件 |
| --- | --- | --- | --- |
| 唤醒决策流水 | 每个「醒 / 跳过（哪道闸门）/ 压后 / 回合无行动」落 JSONL，控制台可看 6h~7d 聚合与明细 | `GET /api/wake-decisions`；控制台「二代仿真 → 唤醒决策流水」 | `src/wake-decisions.js`（169 行） |
| 安全姿态一屏 | 把 state ACL、SnowLuma token、鱼群/防爆破/发送频率/发送前评审/跨场合/白名单/群管理窗口/关闭的工具聚合成一屏 | `GET /api/security-posture`；控制台「访问与安全 → 安全姿态」 | `src/bridge.js` |
| OneBot 只读边界 | MCP 直连 OneBot 只剩 5 个只读动作，`onebot()` 入口运行时断言；写动作永远经桥接 | 自动 | `src/onebot-readonly.js`（46 行）、`scripts/test-egress-boundary.mjs` |
| 隐私闸 P0 修复 | 私钥正则漏 `g` 导致 `while (exec)` 死循环、粘贴 PEM 会卡死整个 DSH 宿主 → 补 `g` + 匹配不前进即 break | 自动 | `plugins/surfcore/lib/privacy.js`、`plugins/surfcore/scripts/test-privacy.mjs` |
| 门禁与数字治理 | `test:audit` 77 → 105 个脚本（含插件包回归）；`restrict` 名单按运行中 `app.asar` 对账 87 → 99（补 `terminal_*`/`plugin_market`/`session_*`）；`CURRENT-NUMBERS.md` 由 `docs:numbers` 生成 + `test:doc-numbers` 校验；`state:usage` / `config:check` 只读报表 | `npm run test:audit` / `docs:numbers` / `state:usage` / `config:check` | `scripts/{test-audit,doc-numbers,state-usage,config-check}.mjs` |
| state 治理 | `state/` 恢复「只放桥接运行时数据」：本机把 DSH 会话工作区根移出 `state/`（新会话生效，旧工作区保留待人工清）；`state:usage` 报表只读、不删任何东西 | `npm run state:usage` | `scripts/state-usage.mjs`、`docs/PITFALLS.md` #100 |
| 更新器 P1 | 批量更新只落地最后一个 → 改 jobs 队列逐 job 幂等落地；`ensureSession` 创建失败不再缓存成 ready | 自动（更新卡片） | `scripts/apply-update.mjs`、`plugins/surfcore/lib/updates.js` |
| 控制台稳定性 | 语音目录草稿覆盖、切角色写错人格卡、保存红字、深色主题不可读等一批 P1 修复 | 设置页/控制台 | `public/console.html`、`plugins/surfcore/lib/{client,store}.js` |
| 打包 | 提供 **Layout B「整仓库即 npm 包」** 的自包含 DSH 插件包：包内带 `plugins/surfcore/`、`src/`、4 个 MCP server、`scripts/setup-plugin.mjs`；不再依赖 fork 仓库目录与仓库根 `node_modules` | 产物 `dist/plugin/surfcore-0.6.22-fork-plugin.tgz`；安装见 [§七 B](#b-自包含-dsh-插件包surfsoul-新增建议优先) | `scripts/setup-plugin.mjs`、`plugins/surfcore/package.json` |

---

## 五、行为改动：权限与安全模型

这一节是 SurfSoul 最需要「先读懂再装」的部分。

| 维度 | 原版 v0.6.22 | SurfSoul 现在 | 回滚方式 |
| --- | --- | --- | --- |
| 本机工具权限 | 只有 `private:<ownerQQ>`（主人私聊）可用 | 主人私聊 **或** reserved2 下「主人本人触发的回合」临时可用，且逐次过内部模型审批（fail-closed） | `socialV2.toolApproval.enabled=false` |
| 群友权限 | 群友没有特权工具 | **不变**：群友自己触发的回合对本地/账号级/群管理工具直接 deny（有意从严）；主人触发回合里群友追加的要求不算授权 | — |
| 账号级动作 | 无（没有好友申请工具） | 好友申请：只在主人私聊或主人触发回合可用；**由模型自己判断加不加**，处理完告知主人；每小时 ≤20 | `socialV2.tools.friendRequests=false` |
| 群管理授权 | 无 | 回合归因优先（`state/turn-triggers.json`）+ 旧「群里开口后 10 分钟」窗口兜底；只认真实 sender QQ | `socialV2.toolApproval.enabled=false` 回到旧窗口语义 |
| 审计 | 无 | `state/tool-approvals.jsonl` + `GET /api/tool-approvals` + `GET /api/security-posture` | 只读，无副作用 |
| 出站评审 | 无 | 默认**关**（模板 `review.enabled=false`）；开启后低于阈值不发送、退回 90s 兜底 | `socialV2.review.enabled=false` |
| 跨场合投递 | 无 | 默认**关**；开启后只允许主人 → `allowTargets` 白名单群，一条纯文本 | `socialV2.crossSceneSend.enabled=false` |
| 看屏幕 | 无 | 默认**关**（`purpose.screen.interruptPolicy=threshold` 保持旧行为）；开启后阈值/leaky 双策略 | `purpose.screen.enabled=false` / 切回 `threshold` |

**诚实记录的残余风险**（口径见 `RULES.md` 硬边界第 15 条、`docs/guides/SECURITY_BASELINE.md` §三）：

- **R12：内部模型审批可能被注入/误放行**。审批模型看到群聊原文与工具参数，可能被「这是主人要的/已获授权」类话术影响；也可能超时/不可用导致误拒。缓解：审批 prompt 把触发消息/最近对话/参数全放 `<untrusted>` 段；授权只认桥接写的真实 sender 归因；deny 必带 reason、失败一律 fail-closed；每次决策写审计。**它是启发式，不能承诺 100%**。
- **R13：`qq_send_image` 的本机路径没有目录白名单**（只校验存在/≤10MB/图片文件头）。旧约束「路径只在主人私聊里产生」在放宽后失效；残余风险是「主人触发回合 + 模型审批放行 + 发送白名单命中」时可能外发一张本机图片。后续可给本机路径加目录白名单（**未做**）。
- **硬边界不靠审批**：真实 sender 归因 + 工具 schema/guard 白名单 + 发送白名单才是硬边界；审批 allow 只决定放行到下一层，不跳过 guard/端点旧闸。
- **真机状态**：CHANGELOG 多段标注「真机未验证（未重启 DSH）」。装前以 `docs/HANDOFF.md` 顶部快照为准，不要把这些能力当成已在生产环境验证过。

---

## 六、与上游当前版 v0.8.9 的差异

上游在 v0.6.22 之后独立发布了 **34 个正式 Release**（v0.7.0–v0.7.23 共 24 个 + v0.8.0–v0.8.9 共 10 个，另有 13 个 `-dev` 预发布），累计 **491 个文件 / +82,718 / −30,968 行**；SurfSoul 同期是 **56 个提交 / 187 个文件 / +30,724 / −1,267 行**。

> 两条线方向不同：上游把产品往「可安装、可更新、可计费、省 token 的本地 AI 陪伴应用」推；SurfSoul 往「QQ 人格/记忆/权限/表达 + 桌宠看屏幕」深挖。**本地不是落后 34 个版本，而是 v0.6.22 的双向分叉。**

### 6.1 本地没有跟进的（上游有、SurfSoul 没有）

| 上游能力 | 上游实现证据 | SurfSoul 现状 |
| --- | --- | --- |
| 向量记忆 + 成本/上下文体系 | `src/vector-memory.js`(629)、`embedding-packs`、`runtime/embedding-service.mjs`（本地 bge-small/qwen3/bge-m3 + 四家云端 embedding）；`context-telemetry`/`billing-report`/`context-snapshot` + 会话滚动 `session-rollover` | 无；本地只有「原文库 bigram 召回」与 token 额度闸，换会话靠「收尾 5 次 + 静置 5 分钟」 |
| 人格/群行为分层 | `persona-layers`/`persona.tone.md`/`persona-identity`/智能拆分；`group-policy` 小群积极大群收紧 + `command-spam` 刷屏短指令过滤 | 无；本地自我叙述走 selfNote + 叙事层，权限走回合归因 + 审批 |
| 一键启动/停止 + SnowLuma 生命周期 | 多组件（QQ/B站/桌宠/语音）launch/stop、SnowLuma explorer+VBS 隐藏启动/关闭按钮/手动指定安装 | 无；本地仍靠 `.bat` 与手动重启 |
| 插件体检 + 闸门事件 + 单轮止血 | `compat.js` 插件冲突体检、`gate-events` L0–L3 事件中心、`turn-guard` 单轮 L3 止血、`qq_get_context_snapshot`/`toolProfile` | 无；本地是「逐次模型审批 + 审批审计流水」另一条路 |
| 白名单/唤醒策略 + DSH 基建 | `allowlist` 归一、`wake-policy` 每日配额/direct 豁免、`wake-batch`/`wake-filter`/backlog；`dsh-health`/`session-map`/`outbox`/`dsh-model-follow`/`owner-audit`/`callname` | 部分同类问题各修各的：本地有 401 自愈、掉线补历史、静置换会话，但没有上述独立模块 |
| 语音包体系 | `voice-pack-import`（离线导入）、`voice-pack-secrets`（凭据清理）、`voice-diagnostics`（失败分类/换路/三步自检）、安装进度与取消 | 无；本地只有 TTS 错误结构化 + 150s 预算 |
| 发布体系 | `release/install-manifest.json` 入库、`release-manifest --verify-ref` 硬门禁、dev/stable 通道、`applyGeneration`、更新锁 ABA 防护 | 无；本地只修了批量更新 jobs 队列 |
| 平台增强 | B站 扫码核查/长 UID/`@` 楼层回复/视频缓存/沉默逛；`web_search` API 直连；outbox 出站补发 | 无；本地 B站 只加了分镜 `watch-storyboard` 与工具链 P1 |

### 6.2 重叠项（两边各自独立做了相似功能）

> 判定口径：先取双方相对 v0.6.22 的改动文件交集（**70 个文件双方都改**），再对该能力在对方树里 grep 关键函数/文件名；「无」= 对侧业务代码 0 命中。关系：`divergent` = 同一子系统两边各做一套、互不兼容；`duplicate` = 同类问题各自独立修，代码不共享。

| 领域 | SurfSoul 实现 | 上游实现 | 关系 / 合并成本 |
| --- | --- | --- | --- |
| 更新系统 | 批量更新 jobs 队列 + `ensureSession` 失败不缓存 ready（`updates.js` +105/−36） | 0.7.1–0.8.2 全面重写：版本发现/失败分类/流式下载/暂存/回滚/清单校验/进度（`updates.js` +2020/−1031） | divergent；以上游为基座补本地队列修复，冲突在 `updates.js`/`apply-update.mjs` |
| 记忆 | 叙事层 + selfNote + 文档记忆 + 原文库/`qq_recall` + audience | 向量记忆（本地/云端 embedding、多索引）+ 多群隔离/互通圈 | divergent；**成本最高**，需先定长期记忆主库 |
| 唤醒/会话生命周期 | 唤醒决策流水 + bootstrapOnlyContext 瘦身 + 收尾 5 次/静置 5 分钟换 session | `wake-policy` 配额/direct 豁免 + `wake-batch`/`wake-filter` + backlog + `session-rollover` 按当前上下文 token 换会话 | divergent；都改 `src/bridge.js`（18k 行）唤醒/会话路径 |
| 工具执行安全/可观测 | 逐次模型审批 + 审批流水 + 安全姿态一屏 + `state:usage` | `gate-events` L0–L3 + `turn-guard` 单轮止血 + `context-telemetry`/`billing-report` | divergent；都挂在工具执行层/插件行，需定审批与熔断先后 |
| SnowLuma 连通性 | token 401/1401 自愈重试 + 掉线按旧水位 60/240/600s 补历史 | `snowluma-conn` 重写 + 发送通道闸门 + 15s 去抖 + `everConnected` + backlog 补唤醒 | divergent；`bridge.js`/SnowLuma 连接层冲突 |
| 语音 | TTS 错误结构化（504/502）+ 150s 预算 + 「改回打字」 | `voice-diagnostics` 失败分类 + cloud⇄local 换路 + 三步自检 + 语音包体系 | divergent；可互补，需统一错误码命名 |
| B站 | `watch-storyboard` 可引用分镜 + 路线 A + 工具账本/超时/出站身份闸 | 扫码登录核查/长 UID、`@` 楼层回复 root/parent、B站接入向量记忆 | divergent；子命令层可叠加 |
| 控制台/预设/桌宠 | 新卡片（决策流水/安全姿态/selfNote/看屏幕/好友申请）+ 安全规则与工具协议 17–22 + 桌宠目的/看屏幕 | 一键启动/人格四层/群分层/更新进度 + 人格 tone/身份注入 + 桌宠修复 | divergent；`client.js`/`index.js`/`agent.cordis.yml` 冲突面最大 |
| 隐私闸 | 私钥正则死循环 P0 修复 + 出站身份闸补 4 个出口 | `privacy.js` 也有改，但无同类死循环修复 | divergent；合并时别丢 P0 修复 |

**结论**

- 双方在**更新、语音、SnowLuma 连通、记忆、唤醒/会话、B站、控制台、预设、桌宠、隐私** 10 个领域都动了手，但实现互不兼容（divergent）；唯一「各自独立修了同类 bug」的是语音页保存提示（duplicate，本地 `262010d` warn 通道 vs 上游 v0.7.8 toast 修复）。
- SurfSoul 有 **8 类上游完全没有的能力**：好友申请、看屏幕、内部模型审批/回合归因、群管理动作、画图/签名/空间/表情包软策略、场合作用域/跨场合投递、发送前评审、可引用分镜。
- 上游有 **12 类本地完全没有的能力**：向量记忆、上下文成本遥测/会话滚动、人格分层、群分层、一键启动、插件体检/闸门事件、白名单归一/唤醒策略、语音包体系、SnowLuma 健康/安装、DSH 基建、发布体系、成本账单。
- 想把上游能力搬进来：按主题 cherry-pick/重写，**不要整仓 merge**——冲突集中在 `src/bridge.js`、`src/mcp-snowluma-safe.js`、`plugins/surfcore/lib/*`、`dsh/agent-presets/*`。

---

## 七、安装

> 前置（两种方式相同）：Windows + Node ≥ 22.13 + DSH 0.2.1-rc.2 或更新 + SnowLuma（第三方专有运行时，SurfSoul 不随附、需自己安装并扫码登录）。概览与详细步骤见 `docs/guides/INSTALL.md`。

### A. 仓库模式（沿用上游方式）

```powershell
git clone https://github.com/Logic61/SurfSoul.git
cd surfcore
npm install                     # 没有 npm 可用 DSH 自带的 pnpm
node scripts/setup-dsh.mjs      # 自动判断 DSH profile，注册 preset / MCP / bundle
# 完全退出并重新打开 DSH → 设置 → SurfCore（插件当前显示名）→ 诊断 → 一键安装（全部）
```

注意事项（沿用上游结论）：

- **必须从仓库根目录安装**：插件里有多处 `../../../src/xxx.js` 引用、且 junction 安装时模块从仓库真实路径解析，仓库根必须有 `node_modules`；只装 `plugins/surfcore` 会报模块不存在。
- 装完要**刷新页面或重启 DSH**：客户端模块图是页面加载时的快照，否则设置里暂时看不到 SurfCore（插件当前显示名）。
- 仓库模式会注册：`qq-chat` / `qq-chat-v2` 两套 agent preset、4 条 MCP server（`snowluma` / `snowluma-host` / `web-search-safe` / `stock-safe`）与 `surfcore` bundle。

### B. 自包含 DSH 插件包（SurfSoul 新增，建议优先）

SurfSoul 提供 **Layout B「整仓库即 npm 包」** 的自包含分发包：包名 `surfcore`，装进任意 DSH profile 后，**插件代码、preset、4 个 MCP server、静态资源都在包内**，不再依赖 fork 仓库目录与仓库根 `node_modules`。

- **产物**：`dist/plugin/surfcore-0.6.22-fork-plugin.tgz`（或同名目录 `dist/plugin/surfcore/`）。包内布局：`plugins/surfcore/`（插件本体）+ `src/`（桥接 + MCP）+ `scripts/setup-plugin.mjs`（接线脚本）+ `config.example.json`。
- **前置**：Windows 10/11、Node ≥ 22.13、DSH 0.2.x（`dsh.cmd` 在 PATH）、pnpm 可用；SnowLuma 仍是第三方外装（只影响 QQ 功能）。

```powershell
# 1) 在 DSH 插件管理页安装本地 target（也可以命令行，二者等价）：
#    plugin_manager install_bundle target="C:\...\dist\plugin\surfcore-0.6.22-fork-plugin.tgz"
dsh.cmd plugin --profile <profile> add file:C:\...\dist\plugin\surfcore-0.6.22-fork-plugin.tgz

# 2) 若 pnpm 把 postinstall 记成 pending build：在插件管理页对 surfcore 点「允许构建」，
#    或手动补跑 node "<包根>\scripts\patch-snowluma-sdk.mjs"（之后重载 DSH）

# 3) 给 profile 接 4 个 MCP server 行 + 首次数据引导（幂等；先加 --check 可只报告）
node "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\surfcore\scripts\setup-plugin.mjs" --profile <profile>

# 4) 完全退出并重开 DSH → 设置 → SurfCore（插件当前显示名）验收（版本 0.6.22、各分页可正常加载）
```

- `setup-plugin.mjs` **不会启动/重启 DSH**：它维护 `<profile>/cordis.patch.yml` 的 4 个 MCP 行（写前备份 `cordis.patch.yml.bak-<时间戳>`），并在包根缺文件时引导 `config.json`/`state/`/`roles/`。
- 默认数据（`config.json`、`state/`、`roles/`、`audio/`）在**包根内**；`.tgz` 升级会替换包目录 → 长期使用建议用 `SURFCORE_ROOT` 把数据放到包外（详见 `docs/guides/PLUGIN_INSTALL.md` 第 2 节）。
- **不要与旧的 Layout A（`scripts/setup-dsh.mjs` junction 安装）同时注册到同一个 profile**：`surfcore` 依赖名唯一，需按 PLUGIN_INSTALL.md 第 3 节迁移。

详细前置条件、产物校验、迁移/卸载/回滚与排障见 **[docs/guides/PLUGIN_INSTALL.md](docs/guides/PLUGIN_INSTALL.md)**（由打包脚本生成；若该文件缺失，以分发包内 `INSTALL.md` 为准）。

> ⚠️ 分发包**只含代码**：`config.json`、`state/`、`memory/`、`roles/`、语音包、SnowLuma 均不随包分发；首次安装后仍需在设置页填管理员 QQ、白名单等。

---

## 八、文档索引

| 文件 | 看什么 |
| --- | --- |
| [`README.md`](README.md) / [`README.en.md`](README.en.md) | 原版 README（安装/能力/FAQ 大部分仍适用；安全承诺已按 SurfSoul 口径更新） |
| [`CHANGELOG.md`](CHANGELOG.md) | **改动一手记录**：顶部 26 段 `## [未发布]`（2026-10-30 ~ 11-07），含用户原话、修法、安全、测试、回滚 |
| [`RULES.md`](RULES.md) | 权限分层与 QQ agent 硬边界 1–15（含 2026-11-06 放宽后的口径） |
| [`docs/guides/SECURITY_BASELINE.md`](docs/guides/SECURITY_BASELINE.md) | 威胁模型、已实现边界、残余风险 R1–R13、发布前检查清单 |
| [`docs/guides/AGENT-TOOLS-AND-PRESETS.md`](docs/guides/AGENT-TOOLS-AND-PRESETS.md) | 工具面（49 个 `qq_*`）、两代 preset、工具开关与权限口径 |
| [`docs/guides/MEMORY_CARD.md`](docs/guides/MEMORY_CARD.md) | 记忆卡/叙事层/selfNote/文档记忆/容量与隐私 |
| [`docs/guides/DATA-AND-CONFIG.md`](docs/guides/DATA-AND-CONFIG.md) | `config.json` 键、状态文件、新接口一览 |
| [`docs/guides/PURPOSE_OUTREACH.md`](docs/guides/PURPOSE_OUTREACH.md) | 目的机制与看屏幕（含 leaky 配置表） |
| [`docs/guides/SUBSYSTEM-PET.md`](docs/guides/SUBSYSTEM-PET.md) / [`SUBSYSTEM-VOICE.md`](docs/guides/SUBSYSTEM-VOICE.md) / [`SUBSYSTEM-BILI.md`](docs/guides/SUBSYSTEM-BILI.md) | 桌宠 / 语音 / B站 三套子系统 |
| [`docs/guides/CURRENT-NUMBERS.md`](docs/guides/CURRENT-NUMBERS.md) | 当前规模数字（自动生成，**不要手改**；引用它而不是抄数字） |
| [`docs/guides/INSTALL.md`](docs/guides/INSTALL.md) | 仓库模式安装细节 |
| [`docs/guides/PLUGIN_INSTALL.md`](docs/guides/PLUGIN_INSTALL.md) | **SurfSoul 新增**：自包含 DSH 插件包安装（打包脚本生成） |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | 最近做到哪、哪些还没验证（真机状态看这里） |
| [`docs/PITFALLS.md`](docs/PITFALLS.md) | 踩过的坑与复现命令（#90–#104 多为本次新增） |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | 路线与模式冻结（`reserved2` 是唯一演进模式） |

---

## 九、许可与致谢

- SurfSoul 基于 **[Mieksido/surfcore](https://github.com/Mieksido/surfcore)**（MIT）。感谢上游作者 **Mieksido** 以及 `qq-bridge / QSH` 的贡献者——没有这个底子就没有 SurfSoul。
- `LICENSE` **原样保留**上游版权声明：`Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors`；SurfSoul 的改动（+56 提交）作者为 `logic`，同样以 MIT 授权。
- **SnowLuma** 是第三方专有运行时，**不随 SurfSoul 分发**（只探测、不部署）；语音包等配套仓库（[surfvoicelocal](https://github.com/Mieksido/surfvoicelocal)、[surfvoicecloud](https://github.com/Mieksido/surfvoicecloud)、[surfpet](https://github.com/Mieksido/surfpet)）也是独立分发物。
- 如果你基于 SurfSoul 再分发：请保留 `LICENSE` 与上游版权声明，并注明「基于 surfcore 的衍生版」以及 SurfSoul 的仓库地址（https://github.com/Logic61/SurfSoul）。

---

## 十、维护策略

**跟随上游**

```powershell
git remote add upstream https://github.com/Mieksido/surfcore.git   # 只需一次
git fetch upstream --tags
git log --oneline v0.6.22..upstream/main        # 看上游分叉后改了什么
git diff v0.6.22..upstream/main --stat          # 看改动面
```

- **不要整仓 merge 上游**：两边从 v0.6.22 起独立演进，冲突集中在 `src/bridge.js`、`src/mcp-snowluma-safe.js`、`plugins/surfcore/lib/*`、`dsh/agent-presets/*`。
- 推荐按主题 cherry-pick / 重写（记忆、唤醒、语音、B站、更新各自评估），并先看 [§六 6.2 重叠项](#62-重叠项两边各自独立做了相似功能) 决定以哪边实现为准。
- 当前对比规模：`git diff v0.6.22..upstream/main --shortstat` 为 **491 文件 / +82,718 / −30,968**（会随上游继续增长）；双方改动文件交集 **70 个**，这 70 个是合并时的必冲突面。

**版本号约定**

- 当前沿用 `0.6.22`（分叉时未 bump，也不要按它和上游版本号比较）。
- 建议后续 fork 用独立版本线（如 `0.6.22-fork.N`）并在 `CHANGELOG.md` 新增段记录；是否需要改需维护者拍板（**尚未采用**）。

**回滚**

- 单功能：优先用配置开关回滚——`socialV2.toolApproval.enabled=false`（审批/放宽）、`socialV2.review.enabled=false`（出站评审）、`socialV2.crossSceneSend.enabled=false`（跨场合）、`purpose.screen.interruptPolicy=threshold`（看屏幕回阈值策略）。
- 整体：按提交 `git revert <hash>` 后重启桥接/DSH；升级前备份 `config.json`、`state/`、`memory/`（SurfSoul 的 `docs/HANDOFF.md` 有对应的备份/恢复步骤）。
- 生效矩阵（沿用上游）：桥接代码 → 重启桥接；插件行/preset/MCP 工具描述 → **重启 DSH**；正在进行的 QQ 会话需 `/reset` 一次。

**真机状态**：CHANGELOG 有多个「真机未验证（未重启 DSH）」标注——以 `docs/HANDOFF.md` 顶部快照为准，不要把未验证能力当成已上线。
