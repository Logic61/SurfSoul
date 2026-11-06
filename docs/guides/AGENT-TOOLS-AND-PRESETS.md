# 工具面与 preset（AGENT-TOOLS-AND-PRESETS）

> 这份文档回答：**agent 的手从哪来**（四个 MCP server + 全部 `qq_*` 工具）、**哪些手被绑住**
> （七层闸门 + fail-closed 守卫 + 本回合归因 + 内部模型审批）、**她戴哪张面具**（`qq-chat` / `qq-chat-v2` 两代 preset）、
> **这些是怎么装进 DSH 的**。
> **最后核对**：2026-11-06（工具场景放宽 + ownerQQ 归因 + 内部模型审批：本地执行 10 工具、好友申请、
> 跨场合投递、群管理改为「主人本人触发的回合」可用且逐次模型审批，仅 `reserved2` 生效）。
> 工具/名单数量以 [CURRENT-NUMBERS.md](CURRENT-NUMBERS.md) 为准。
> 配套阅读：总纲 [ARCHITECTURE.md](ARCHITECTURE.md) · 边界 [BOUNDARIES.md](BOUNDARIES.md) · 索引 [../README.md](../README.md)。

---

## 0. 一句话

**两个 MCP 手 + 一张面具。**

- `snowluma`（全部 `qq_*` 工具，数量见 [CURRENT-NUMBERS.md](CURRENT-NUMBERS.md)）是主力手：读消息、发消息、等待、表情、语音、记忆、她自己的资料/空间、快速生图、群管理动作、好友申请。
- `snowluma-host`（1 个）是探活手：只问 SnowLuma 在不在，**没有启停能力**（EULA）。
- `web-search-safe`（2 个）是外部信息手：只读搜索与抓取，带 SSRF 防护。
- preset 决定"她是谁、在哪说话"：`qq-chat`（一代/普通）与 `qq-chat-v2`（二代仿真）。

---

## 1. 四个 MCP server

| server | 入口 | 工具 | 挂载 | 边界 |
| --- | --- | --- | --- | --- |
| `snowluma` | `src/mcp-snowluma-safe.js`（约 1,700 行） | `qq_*` 工具全表（数量见 [CURRENT-NUMBERS.md](CURRENT-NUMBERS.md)） | `~/.dsh/profiles/<profile>/cordis.patch.yml`（`setup-dsh.mjs` 写入） | 发送必须命中白名单；会话绑定 `x-agent-token`；工具开关逐项可控 |
| `snowluma-host` | `src/mcp-host-server.js`（93 行） | `snowluma_status` | 同上 | **只读探活**；v0.1.5 起移除了 `start_snowluma`/`stop_snowluma` |
| `web-search-safe` | `src/mcp-web-search-safe.js`（92 行） | `web_search`、`web_fetch` | 同上 | 只读；禁内网/环回/CGNAT；DNS 解析后逐地址校验；重定向每跳复核 |
| `stock` | `src/mcp-stock-safe.js` | 3 个只读行情工具 | 同上 | 只读公开行情；无 key、无账号、不落盘（2026-10-29 加） |

> 数量以 [CURRENT-NUMBERS.md](CURRENT-NUMBERS.md) 为准（自动生成，避免手抄漂移）。

三者都是 **stdio** transport，由 DSH 的 MCP 客户端按 profile 配置拉起，进程生命周期归 DSH 管。

> 为什么要把 host 单独拆出来：SnowLuma 的登录态查询（`get_login_info`）与"操控进程"是两类能力，
> 前者无副作用、后者触碰 EULA §5.4。拆成两个 server 后，MCP 配置里可以只挂前者的能力。

---

## 2. `qq_*` 工具全表（数量以 [CURRENT-NUMBERS.md](CURRENT-NUMBERS.md) 为准）

**配置开关**列对应 `config.json` 的 `socialV2.tools.<key>`（`true` 才注册；默认只有
`setStickerRemark` 与 `sendVoice` 是 `false`）。**需要令牌**列：二代模式下所有 `qq_*` 调用都要带
`x-agent-token`（会话令牌）+ `x-agent-call: 1`。

### 2.1 只读：状态与名单

| 工具 | 作用 | 开关 |
| --- | --- | --- |
| `qq_status` | 查机器人登录状态与账号信息 | —（常驻） |
| `qq_list_groups` | 列出机器人所在的全部群 | — |
| `qq_get_group_members` | 群成员列表（QQ 号 / 昵称 / 群名片 / **群身份 role**）。closed-agent 模式直接查；**reserved2 需带 `key`+`token`**（群聊限本群、主人私聊可查白名单群）——管理员按昵称点名禁言/改名片时用它解析真实 QQ 号，并看 role 避开群主/管理员（2026-11-02） | — |
| `qq_get_group_history` | 群最近消息历史（可按 messageSeq 往前翻） | — |
| `qq_get_active_members` | 最近活跃成员（判断话题参与者） | `getActiveMembers` |
| `qq_get_self_image` | 看自己的 Q 版形象（DeepSeek 小鲸鱼） | `getSelfImage` |
| `qq_list_voices` | 语音库清单（名字/时长/大小） | `sendVoice` |
| `qq_list_stickers` | 收藏表情清单（编号/情绪/内容/关键词） | `listStickers` |

### 2.2 只读：消息与上下文

| 工具 | 作用 | 开关 |
| --- | --- | --- |
| `qq_get_prompt` | 当前提示词/角色/推荐值/可用工具/唤醒配置 | `getPrompt` |
| `qq_get_unread_messages` | 未读消息（**不自动标记已读**；支持 `afterSeq` 从水位补读） | `getUnread` |
| `qq_get_recent_messages` | 最近消息（支持 offset 往前翻） | `getRecent` |
| `qq_get_my_recent_messages` | 自己最近发过的话（防重复/保持人设） | `getMyRecent` |
| `qq_get_message_detail` | 单条消息的发送者/引用/正文（≤200 字，长文不给） | `getMessageDetail` |
| `qq_get_message_images` | 把消息里的图片/表情**直接返回给视觉模型** | `getImages` |
| `qq_get_forward_msg` | 展开合并转发（含嵌套转发与图片） | `getForwardMsg` |
| `qq_social_state` | 该会话的 WakeConfig/未读数/上次唤醒原因/上次发言 | `socialState` |

### 2.3 发送

| 工具 | 作用 | 开关 | 硬约束 |
| --- | --- | --- | --- |
| `qq_send_group_message` | 群里发一条纯文本（可引用） | `sendGroup` | 白名单 + 模式 + 500 字 + 频率 |
| `qq_send_private_message` | 私聊发一条（可引用） | `sendPrivate` | 同上 |
| `qq_reply` | 引用某条消息发送 | `reply` | 必须给出真实 messageId |
| `qq_send_message` | **统一发送**：一条或多条、可引用、可自定义条间间隔 | `sendMessage` | 最多 8 条 |
| `qq_send_burst` | 分多条发（随机真人间隔） | `sendBurst` | 最多 8 条 |
| `qq_send_cross_scene` | **受控跨场合投递**：主人本人发起 → 显式白名单群 | `crossSceneSend` | 默认关（`socialV2.crossSceneSend.enabled=false`）；来源 = 主人私聊（旧路径）或主人本人触发的回合（2026-11-06 放宽），别人私聊/群友触发的回合 403；目标须同时进 `allow.groups` 与 `allowTargets`；一条纯文本；敏感/身份/长度/频率/静默/鱼群全闸；桥接代投，不向模型发目标 token；每次调用先过内部模型审批 |
| `qq_send_poke` | 拍一拍（群聊需 targetUserId） | `sendPoke` | 频率限制 |
| `qq_send_sticker` | 发一张收藏表情（一条只能一张，不能带文字；**可以单独作为一条回复**，不必配文字） | `sendSticker` | 每条只能一张；频率由模型按语境判断（只受每轮 8 条 / token 闸门约束） |
| `qq_send_image` | 发一张普通图片：URL / `data:image/…` / `base64://…` / **本机文件路径**；也支持 `fromMessageId` 转发别人发的图 | `sendImage` | 每条只能一张、不能带文字；桥接内下载/读盘并校验（≤10MB、文件头必须是 jpg/png/gif/webp）；本机路径只在管理员机器读。**>1.3MB 的本地图自动改走 SnowLuma 的 `file://` 通道**（OneBot HTTP 请求体上限 2MiB，base64 会超；见 PITFALLS #82）。**画图功能的落地点**（见 §4） |
| `qq_generate_image` | **快速画图**：用 Agnes 图像模型现场画一张（默认 `agnes-image-2.5-flash`、1024×1024，实测 10~25 秒），返回本机绝对路径；再由 `qq_send_image` 发出 | `imageGen`（默认开） | **群聊与主人私聊可用**（别人私聊 403）；群聊默认 **3 张/小时、10 张/天**（`socialV2.imagegen.group.*`，0=不限；主人私聊默认 20/100），超限 429；prompt ≤2000 字；一次一张；结果落 `state/generated-images/`（默认保留 7 天）；配额记在 `state/social-v2.json` 的 `imageGenTimes`。密钥解析：`socialV2.imagegen.apiKey` → 环境变量 → DSH 凭据 `AGNES_API_KEY`；见 §4「快速生图」 |
| `qq_send_voice` | 发语音：`text` 现场合成 / `voice` 用语音库现成文件 | `sendVoice`（默认**关**） | 需引擎；120 字；2/分钟 |

### 2.4 她自己的资料与空间（只动她自己的账号）

| 工具 | 作用 | 开关 | 硬约束 |
| --- | --- | --- | --- |
| `qq_set_signature` | 改**她自己**的 QQ 个性签名（空串=清除签名） | `setSignature`（默认开） | ≤120 字；敏感信息 / 身份泄露 403；只 reserved2 + 会话令牌 |
| `qq_send_qzone` | 发一条 QQ 空间说说（`visibility` 默认 `friends`=好友可见，可选 `all`/`self`） | `sendQzone`（默认开） | 1~1000 字；不支持图片；敏感信息 / 身份泄露 403 |

> 两个动作都只作用于机器人自己的 QQ 账号，不涉及他人；但它们是**公开面**（好友/所有人可见），
> 所以除 `SENSITIVE_RE` 外还过 `src/identity-guard.js` 身份闸——主人 QQ、群号等账号标识写上去就收不回来。
> 行为边界见 [`RULES.md`](../../RULES.md) 硬边界第 5 条，踩坑记录见 `PITFALLS.md`
> 「SnowLuma 动作目录是 SDK 构建期快照」。

### 2.4.1 群管理动作（主人本人触发的回合；2026-11-06 起群聊/私聊都行）

> 2026-11-02 用户拍板：「允许 qqbot 在群聊中接受管理员除了访问电脑之外的所有工具，包括但不限于禁言群成员」。
> 人工决策点：管理员 = **ownerQQ 本人**（不是 QQ 群管理员/群主）。2026-11-06 用户再次拍板把场景放宽到
> 「主人本人触发的回合」（群聊/私聊都行），旧「管理员最近在群里开口 10 分钟」的 `ownerAt` 时间窗**保留为兜底**。

| 工具 | 作用 | 开关 | 硬约束 |
| --- | --- | --- | --- |
| `qq_set_group_ban` | **禁言 / 解除禁言**一个群成员（`durationSeconds` 秒；**0 = 解禁**） | `setGroupBan`（默认开） | 授权 = 主人本人触发的回合（主路径）或旧 `ownerAt` 时间窗（兜底，`socialV2.adminActions.windowMs` 默认 10 分钟）；群聊/私聊都行，但**私聊必须显式带 `groupId` 且命中 `allow.groups`**（群聊里传别的群号会被 400 拒）；目标必须是本群成员，不能是她自己 / 管理员本人 / 群主 / 其他群管理员；时长 0~2592000 秒；每会话每小时 ≤ `maxPerHour`（默认 20）；只 reserved2 + 会话令牌；每次调用先过内部模型审批 |
| `qq_set_group_card` | 改群名片：默认改自己；**改别人**属于管理动作 | `setGroupCard`（默认开） | 改自己：群里/私聊都行；改别人：主人本人私聊、主人本人触发的回合、或管理员在群里开口后的旧授权窗口（三通道任一成立即放行）；目标须为本群成员；≤60 字；每次调用先过内部模型审批 |

> **授权口径与为什么升级**：旧设计只有「管理员最近在群里说话的时间窗」——因为工具调用发生在 AI 回合里，
> 桥接当时无法把一次调用归因到某一条消息。2026-11-06 新增 `state/turn-triggers.json`（桥接按真实
> `event.user_id` 写「本回合触发者」，DSH 插件只读）之后，**主路径变成精确归因**：只有「主人本人那条触发消息
> 所在的回合」才临时授权，非主人回合直接 403；旧时间窗只作为兼容兜底保留。两条只认真实 sender QQ
> （`isOwner` 由 `cfg.ownerQQ` 判定，群友无法伪造）。实现见 `src/bridge.js` 的 `ownerTurnAllowed()` /
> `groupAdminAuthority()`，测试见 `scripts/test-owner-trigger-gates.mjs`、`scripts/test-group-admin-tools.mjs`。
> 唤醒提示在授权有效时会多一段【管理员在群里】或【本回合授权】（见 §5 与 `MODULE-BRIDGE.md` §3.12）。
>
> **reserved2 下的从严口径（有意为之）**：非 owner 回合对账号级/群管理工具会**直接 deny**——DSH 前置模型审批层
> （`qq-owner-approval`，pre-execute）先拒绝，走不到桥接端点；旧 `ownerAt` 时间窗在实际运行中只在
> **chat/reserved/closed-agent**（不挂审批行）或 **`socialV2.toolApproval.enabled=false` 回滚**时兜底。
> 目的：不再让「主人上一轮说过话、这一轮群友触发」的回合继承授权。
>
> **模型审批**：这两条工具在非私聊主人会话里每次调用还会过 `plugins/surfcore/qq-owner-approval.mjs` 的内部
> 模型审批（`socialV2.toolApproval`，fail-closed）；审批只核对「是否为主人这条消息真正要求、风险是否可接受」，
> 不改变授权来源（授权仍只认真实 sender 归因）。
>
> **目标解析**：管理员只说了昵称/群名片时，模型用 `qq_get_group_members(key, token)`（reserved2 的只读 v2
> 通道，见 §2.1）拿到真实 QQ 号 + role；同名分不清就先问管理员。旧只读工具在 reserved2 下没有会话令牌，
> 所以这条通道是 2026-11-02 专门为群管理动作补的（`GET /api/socialV2/group-members`）。

### 2.4.2 好友申请（主人本人私聊或主人触发的回合；模型自己判断，2026-11-06）

> 用户原话：「看看snowluma有没有好友申请的接口，有的话给surfcore的qq部分加上」。
> 随后用户又定：「**权限放开，由模型自己判断是否添加好友**」——不再要求主人逐条点头/刚开过口；
> 当晚再次拍板把场景放宽到「主人本人触发的回合」（2026-11-06 全部放开的一部分）。
> SnowLuma 只在有人加好友时推一次 `request` 事件、**没有**「列出普通待处理好友申请」的接口
> （`get_doubt_friends_add_request` 是「被过滤/可疑申请」，不是普通列表，见 `PITFALLS.md` #102），
> 所以桥接自己把事件落盘缓存，列表 = 事件缓存 + 网关现拉的两档合并。

| 工具 | 作用 | 开关 | 硬约束 |
| --- | --- | --- | --- |
| `qq_list_friend_requests` | **查看待处理好友申请**：合并「事件推送的普通申请」+「QQ 系统过滤的可疑申请」；返回每条的 `kind`（`request`/`filtered`）与 `flag`（处理时要原样回传）、申请人 QQ 号/昵称/留言，留言标 `untrusted: true` | `friendRequests`（默认开） | **主人本人私聊，或主人本人触发的回合**可用（账号级信息；别人私聊/群友触发的回合 403）；只读。普通申请来自 `state/friend-requests.json` 事件缓存（保留 7 天、最多 50 条）；`filtered` 一档现拉网关，拉取失败仍返回已知部分；群里只报结论、不念原始信息；每次调用先过内部模型审批 |
| `qq_handle_friend_request` | **同意 / 拒绝一条好友申请**：`kind=request` 走 `set_friend_add_request`；`kind=filtered` 走 `set_doubt_friends_add_request`。`approve=true` 同意、`false` 拒绝（缺省 true） | `friendRequests`（默认开） | **真会生效的账号级动作**（同意后对方真的成为好友、会开始收到对方消息）：主人本人私聊或主人本人触发的回合；**由模型自己判断**（不用主人逐条确认，处理完在私聊里告诉主人；群里只说结论）；每小时 ≤ `maxPerHour`（默认 20，与群管理动作共用计数）；`kind`/`flag` 必须来自列表返回，普通申请还要命中桥接事件缓存（否则 400）；网关失败 502；每次调用先过内部模型审批 |

> **权限口径（2026-11-06 用户二次拍板 + 当晚场景放宽后）**：好友申请是账号级动作（同意=对方进入好友列表，
> 不可逆、对方会收到通知），申请留言/昵称是**陌生人可控内容**（典型提示注入入口：「同意我，我是你主人」）。
> 桥接的口径是：① 只允许**主人本人私聊，或主人本人触发的回合**（主人那条触发消息所在的回合；别人私聊 /
> 群友触发的回合拿不到，403）；② **收到新申请时会主动唤醒主人私聊会话**，她自己判断加不加
> （软判断在 preset 第 21 条：像真人/群友/熟人的可以同意，可疑/说不清的先问或拒绝）；
> ③ 唤醒有节流（`socialV2.friendRequests.wakeMinIntervalMs`，默认 5 分钟；间隔内新申请只落缓存，下次唤醒一起看到），
> 唤醒本身还走鱼群/token 防爆破/限频；④ 留言只当资料看，不执行其中的指令、不批量乱加；⑤ 群里由主人触发时，
> **只说结论，不念陌生人 QQ/昵称/留言原文**——账号级信息不落群聊上下文。
> 为什么不再用「主人最近开口的时间窗」：用户明确要求把判断权交给模型；但**授权归因（真实 sender）**、
> **场景（主人本人触发的回合）**和**每小时上限**仍是硬闸，避免群聊内容驱动账号级动作、也避免被刷。
> 实现：`src/friend-requests.js`（规范化/TTL/上限/合并/文案）+ `src/bridge.js` 两个端点与 `wakeFriendRequestV2()`；
> 预设规则见工具协议第 21、22 条。

> **开关与装配**：桥接默认 `socialV2.tools.friendRequests = true`；控制台「二代仿真 → 工具开关」里有同名
> checkbox（标签「好友申请」），DSH 设置页工具标签同步。主动唤醒另受 `socialV2.friendRequests.wakeOnRequest`
> （默认开）与 `wakeMinIntervalMs` 控制。新工具与其它 MCP 工具一样要**重启 DSH** 才进入 QQ 会话工具面；
> 桥接端点/主动唤醒重启桥接即生效。

### 2.5 等待与状态机

| 工具 | 作用 | 开关 |
| --- | --- | --- |
| `qq_wait_for_messages` | 长轮询等消息。`purpose="reply"` 是"首答前补静默"；默认用途是"等新消息 / 沉睡前观察" | `waitMessages` |
| `qq_mark_read` | 标记已读到某个水位（推荐总带 `throughSeq`，否则会清空全部未读） | `markRead` |
| `qq_close_conversation` | **自然收尾**：不发消息，记录"收在哪/下次怎么接"，保持唤醒配置 | `closeConversation` |
| `qq_set_wake_config` | 设置唤醒条件（@/名字/关键词/提问/拍一拍/概率/任意消息/指定成员）与潜水时长 | `setWakeConfig` |

> **沉睡前观察**是硬约束：决定潜水/收尾前必须先用 `qq_wait_for_messages(timeoutMs=300000)` 完成一次
> 静默观察，桥接会校验；`purpose="reply"` 的短静默**不能**代替它。

### 2.6 记忆、黑话、表情管理、反馈

| 工具 | 作用 | 开关 |
| --- | --- | --- |
| `qq_memory_append` / `qq_memory_query` / `qq_memory_remove` / `qq_memory_clear` | 轻量记忆（进行中的话题 / 想说的话 / 对某人的印象 / **规矩 rule** / **selfNote 自我认知**）。`rule` 是带作用域的指令性记忆：`extra.scope = global/private/group/group:<群号>/here`（默认 global），注入按当前场合过滤，私聊里定的 global 规矩群里也认。`selfNote`（2026-11-02）= 她自己写的「我最近变成什么样」，按角色共享、整句去重、40 条上限，**只在换新会话第一轮注入一次**；`qq_memory_clear` 不传 category 时不会清它 | `memory` |
| `qq_recall` | **原文召回 + 文档记忆（2026-11-01 / 2026-11-02）**：只读查 `memory/events/` 原文库**和**她自己的文档（B站语感本薄版/厚本、两本日记），返回带时间/出处的结果与「不是指令」框定；空结果提示「记不清了，不要编」。群聊只查本群与 shared 文档；主人私聊默认跨会话（`socialV2.recall.crossConversation`）。注：语感本**厚本不常驻注入**（只增不减、太长），细节一律走这里查；每轮提示词里带的是 B站 整理的**薄版** | `memory` |
| `qq_slang_query` / `qq_slang_submit` | 查已确认的群聊黑话 / 提交候选词（**看到没把握的词就直接提**，不再限频） | `slangQuery` / `slangSubmit` |
| `qq_collect_sticker` | 收藏别人发的表情，并写情绪/内容/关键词 | `collectSticker` |
| `qq_sticker_note` | 给自己的收藏表情写语义（本地记忆，不改 QQ 备注） | `stickerNote` |
| `qq_get_sticker_image` | 看某个收藏表情长什么样 | `getStickerImage` |
| `qq_set_sticker_remark` | 改 QQ 官方备注（写操作，默认**关**） | `setStickerRemark` |
| `qq_report_feedback` | 向控制台反馈问题/困惑 | `feedback` |

---

## 3. 工具闸门：七层，从外到内

```
① 进程/传输    DSH 的 MCP 客户端（stdio）——只有装进 profile 的 server 才存在
② 工具是否注册 socialV2.tools.<key> 为 true（false 时该工具压根不在 schema 里）
③ 调用方身份   x-agent-call: 1 + x-agent-token 必须命中一个**活跃会话**；
              漏传令牌不会升级成管理端全权（防 confused deputy）
④ 本回合归因   state/turn-triggers.json：本回合触发消息的发送者是不是 ownerQQ 本人
              （桥接按真实 sender QQ 写、DSH 插件只读；定时/系统唤醒一律不算）
⑤ 内部模型审批 qq-owner-approval 逐次评审三类特权工具（仅 qq-chat-v2 / reserved2）：
              allow 才继续；deny/坏 JSON/超时/不可用/异常 → 拒绝（fail-closed，reason 必填）
⑥ 运行状态    AI 暂停（socialV2.paused）/ 二代总开关关闭 / 该会话不在当前模式允许范围
⑦ 业务闸门    发送白名单、敏感信息、长度与条数、频率、token 额度、鱼群守则
```

④⑤ 是 2026-11-06「工具场景放宽 + ownerQQ 归因 + 内部模型审批」新增的两层，只覆盖**三类特权工具**：
本地执行（10 个 `OWNER_PRIVATE_TOOL_NAMES`，如 `pwsh`/`write`/`subagent_codex`）、账号级（好友申请 2 个 + 跨场合投递）、
群管理（禁言 / 改别人群名片）。其它工具照旧走 ⑥⑦。**顺序不能换**：模型审批在 guard 之前（审批只决定
「要不要放行到下一层」，不能让调用跳过 guard/白名单），人工审批（DSH 沙箱升权）还在最内层兜底。

失败码语义（模型据此改策略，而不是硬试）：

| 码 | 含义 | 模型应该做什么 |
| --- | --- | --- |
| `400` | 参数不合法 / 单条超长 / JSON 错误 | 改参数或缩短 |
| `401` | 令牌无效/过期 | 重新读提示词里的会话令牌（或放弃） |
| `403` | 白名单外 / 模式不允许 / 工具未启用 / 额度到 100% | **不要重试**，换目标或等 |
| `404` | 目标不存在（群/消息/音频） | 停 |
| `409` | 状态冲突（例如正在跑） | 等一下再试 |
| `415` | 写操作不是 `application/json` | 修请求 |
| `429` | 频率超限 | 放慢/减少条数 |
| `502` | 上游失败（TTS 引擎/发送失败） | 降级（改回打字） |

---

### 3.1 出口边界：写动作只走桥接，直连 OneBot 只有只读（2026-11-03 冻结）

| 路径 | 谁在用 | 动作 | 经过的闸门 |
| --- | --- | --- | --- |
| 桥接 HTTP `127.0.0.1:3100` | 所有 `qq_send_*` / `qq_reply` / `qq_send_image` / … | **写** | 会话令牌 → 发送白名单 → 模式/暂停 → 发送前评审 → 敏感/身份 → 长度/条数/频率/额度/鱼群 → 审计 |
| OneBot HTTP `127.0.0.1:3000`（MCP 直连） | `qq_status` / `qq_list_groups` / `qq_get_group_members` / `qq_get_group_history` | **只读** | 仅 `get_login_info` / `get_status` / `get_group_list` / `get_group_member_list` / `get_group_msg_history`（`src/onebot-readonly.js` 白名单，非白名单**直接抛错**） |

为什么保留只读直连：桥接没起来时，模型仍能回答「QQ 在不在线 / 有哪些群」，不会表现为「QQ 工具全挂」。
代价是这条旁路绕开桥接审计，所以把它**冻结成只读白名单 + 运行时断言**：新增动作必须同时改
`src/onebot-readonly.js`、`scripts/test-egress-boundary.mjs` 与上表；写动作永远不能直连。

## 4. 工具守卫：fail-closed 的两段式

文件：`plugins/surfcore/qq-tool-restrict.mjs`（约 500 行，**唯一权威实现**）。
两个 preset 目录下的同名文件只是 `export * from` 的壳，避免两份实现漂移。

**名单规模（实测，2026-11-03；实时数字见 [CURRENT-NUMBERS.md](CURRENT-NUMBERS.md)）**

| 名单 | 条数 | 内容 |
| --- | --- | --- |
| `OWNER_PRIVATE_TOOL_NAMES` | **10** | **「主人触发回合」专用本地能力**（执行期逐次鉴权，不在 restrict 里）：`pwsh` `bash` `read` `read_image` `write` `edit` `str_replace_editor` `glob` `grep` `subagent_codex`（2026-11-01 加入：Codex 画图；2026-11-06 场景放宽到「主人本人触发的回合」，不再只限私聊） |
| `LOCAL_EXECUTION_TOOLS`（restrict 隐藏） | **51** | 原 39 个危险能力 + 2026-11-03 新增 12 个（`terminal_*` / `plugin_market` / `session_*`，均从运行中 app.asar 对账扫出） |
| `KNOWN_DANGEROUS_GLOBAL_TOOLS` | 51 + 18 = **69** | 本地执行面 51 个 + 18 个 `dev_*`（插件注入/打包/自测） |
| `RESTRICTED_TOOL_NAMES`（导出给测试） | **99** | 69 个危险全局名 + 30 个 `mcp__browser__*`（只放 B站/小红书，其余平台与浏览器控制类隐藏） |
| `SAFE_PREFIXES` | 6 | `mcp__snowluma__`、`mcp__snowluma-host__`、`mcp__web-search-safe__`、`mcp__stock__`、`mcp__browser__bilibili_`、`mcp__browser__xhs_` |
| `SAFE_EXACT` | 2 | `ask_user_question`、`todo_write` |
| `MEMEWIKI_TOOL_NAMES` | 4 | `search_meme_wiki`、`meme_recall`、`meme_feedback`、`meme_remember`（dsh-memewiki v2，2026-10-30 放行） |

**为什么必须两段**（这是设计要点，不是啰嗦）：

1. `ctx.tools.restrict({ deny })` 把它们从**工具清单/schema** 里隐藏（注册期）。
2. `ctx.tools.guard(fn)` 白名单兜底：执行期任何不在允许范围的调用一律拒绝并返回可读原因。

只做第 2 段不够——工具名仍会出现在模型面前，既违反"仿真会话不得拥有本地执行能力"，
也会诱导模型去调它。反过来只做第 1 段也不够——别的 composition 可能再把名字注册进全局层。

**「主人触发的回合」这一类（2026-10-29 起；2026-11-06 放宽场景）**：`pwsh`/`bash`/文件类工具不再进 restrict
（否则模型 schema 里看不见、私聊里也用不了），改成执行期逐次鉴权（`plugins/surfcore/qq-tool-restrict.mjs` 的 `guard`）：
1. 读 `state/turn-triggers.json`（桥接在投递 prompt 前按真实 `event.user_id` 写、`turn/start` 对齐、`turn/end` 失效）
   把当前 DSH 会话映射到「本回合触发者」；`mode === 'reserved2'` + `socialV2.toolApproval.enabled !== false` +
   `turnActive` + `trigger.isOwner` + 未过 `triggerWindowMs`（默认 10 分钟）→ 放行；
2. 否则回退旧路径：会话 key === `private:<ownerQQ>`（读 `state/sessions.json` 映射）→ 放行；
3. 两条都不成立 → fail-closed。**归因文件缺失/读坏/过期、不是 reserved2、开关关闭、会话映射拿不到，全部落到拒绝。**
`.subagent_codex`（Codex 画图）仍归这一类——它会 spawn 真 Codex 子进程、能在工作区跑命令/写文件，能力面 ≈ 本地执行；
区别只是现在「主人触发的回合」也能用，且每次调用先过模型审批。
Guard 侧导出 `OWNER_PRIVATE_TOOL_NAMES` 供 `test-preset-local-tools.mjs` 逐名对账；清单本体在
`plugins/surfcore/lib/turn-trigger.js`（审批行与 guard 共用一份，避免两份名单漂移）。

**内部模型审批行 `qq-owner-approval`（2026-11-06，仅 qq-chat-v2）**：

- 文件：`plugins/surfcore/qq-owner-approval.mjs`（行 id `qq-owner-approval`；`inject: ['tools']`，llm 用 `ctx.get('llm')` 懒取）；
  共享库 `plugins/surfcore/lib/turn-trigger.js`（读归因/配置归一化/审批 prompt/fail-closed verdict/脱敏）。
  只由 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 挂载；**qq-chat（一代冻结）不挂**。
- 主门 `tools/pre-execute`（`prepend: true`）：三类特权工具逐次评审；主人私聊直接 `next()`（不跑模型审批，老行为）；
  非 `reserved2`/开关关闭时本地工具仍按旧「仅主人私聊」拒绝、账号级/群管理交回 bridge 旧闸；reserved2 且开关开启时
  只认「主人本人触发的回合」，否则 deny（reason 必填）。模型返回严格 JSON（low/medium+allow、medium/high+deny），
  其余组合/坏 JSON/超时/异常 → deny。每回合预算 `maxReviewsPerTurn`（默认 6），同回合同工具同参数去重。
- 配套 `approval/request`（`prepend: true`）：模型已批准过的本地调用，用 `sessionId + callId` 领取一次
  `allowed-once`（消费即删），不再转 QQ 人工；没领取到的审批照旧走桥接人工（只有 owner 能回）。
- 审计：每次决定追加 `state/tool-approvals.jsonl`（**插件写、桥接只读展示**；参数与令牌不入日志；>1MB 轮转 `.1`）。
- 回滚：`socialV2.toolApproval.enabled=false` → bridge 端点场景闸与插件监听一起回旧行为；代码回滚按 commit revert。

**快速生图（Agnes）——2026-11-01 起是「画图」首选**：

- 链路：preset 第 19 条 → MCP `qq_generate_image` → 桥接 `POST /api/socialV2/generate-image`
  → `src/imagegen.js` 调 Agnes `POST {baseUrl}/images/generations`（默认
  `https://apihub.agnes-ai.com/v1`、`agnes-image-2.5-flash`、1024×1024）→ 落盘
  `state/generated-images/img-YYYYMMDD-HHmmss-<hex>.<png|jpg>` → 返回绝对路径 →
  `qq_send_image` 发出。本机实测：**10.2 秒 / 1028KB / 1024×1024**。
- 为什么不用 freegpt（DSH 里配的 CLI Proxy API 面板）：它虽然列出了 `gpt-image-*`，
  但 `/images/generations` 全部返回 **503 `auth_not_found: no auth available (providers=codex, …)`**
  （面板侧没给这个 key 配生图通道）；它的纯文本 chat 模型只会吐 SVG 代码，不是真出图。
  详见 PITFALLS #83。
- 密钥解析（只在桥接侧做，MCP 层看不到密钥）：`socialV2.imagegen.apiKey` →
  环境变量 `AGNES_API_KEY` → DSH 凭据文件 `~/.dsh/.credentials.yaml` 里的同名键。
- 安全/成本（2026-11-01 主人要求「允许群聊画图」后更新）：**群聊与主人私聊都可用**（别人私聊
  仍 403）；群聊按会话配额限流（默认 **3 张/小时、10 张/天**，`socialV2.imagegen.group.*`，
  0 = 不限；主人私聊默认 20/小时、100/天）。prompt ≤2000 字、一次一张；生成图默认保留 7 天后清理
  （`socialV2.imagegen.keepDays`）。prompt 会发给第三方 Agnes，所以别拿它转述私密内容/账号信息。
  **这是外部 API 调用，不是本地执行能力**；放开群聊只放开了「谁可以请求画图」，没有放开任何本地权限，
  成本边界从「仅主人私聊」改成了「会话配额 + 群聊开关」。
- 部署注意：`qq_generate_image` 是 MCP 工具 → **改完要重启 DSH** 才出现在工具面；
  桥接新路由改完要重启桥接（`POST /api/restart`）。配额记录在 `state/social-v2.json`
  的 `conversations[<key>].imageGenTimes`（跨重启保留，避免重启刷额度）。

**Codex 画图的运行时前提（2026-11-01，环境事实，不是代码，作为「复杂/照片级」备用通道）**：

- `subagent_codex` 由 **bundle** 提供（`@deepseek-ai/dsh-subagent-codex`，Host 行 = 全局工具），
  不是 QQ preset 自己挂的行；preset 不需要加 `tool-subagent-codex`。
- bundle 版本必须与**运行中的 DSH runtime 完全一致**：rc.3 的 peerDependencies 精确钉
  `0.2.1-rc.3`，在 rc.5 runtime 上会被 `loadProfileDirectory` 判 `incompatible-version`
  **整包静默跳过**（工具根本不存在，restrict/白名单都无从谈起）。本机已升级到 rc.5。
- DSH 的 bundle 自带 `@openai/codex` **0.153.4**，其模型目录里没有 `~/.codex/config.toml`
  的默认模型 `gpt-6.1-sol`（会 `model_not_found`）——必须在 profile 的 `cordis.patch.yml`
  给 `subagent-codex` 行配 `model: gpt-6-astra`；同时配
  `permissionMode: approve-for-me`（默认 `never` 省略 sandbox，子会话把生成的图片复制到
  工作区可能被拦）。两处都改完要**重启 DSH**。
- 完整画图链路：`subagent_codex` → Codex 子会话用内置 `image_gen` 出图（保存到
  `$CODEX_HOME/generated_images/...`，返回 `savedPath`）→ 复制到工作区绝对路径 → 最终回答只给路径
  → QQ 侧 `mcp__snowluma__qq_send_image(image="<路径>")` 发出（一条一张、不能带文字）。
  生成一次约 1~3 分钟。
- 安全备注：`qq_send_image` 的本机路径**没有目录白名单**（只校验存在/≤10MB/图片文件头——
  这是"把她画/截的图发出来"的设计口径）。画图功能依赖它；反过来说，**知道本机路径文本**
  就有外发本机图片的能力，这是模型被注入时的一条外发通道。**2026-11-06 之后**旧间接约束
  「路径只在主人私聊里产生」不再成立（主人触发的回合里本机工具也能产生路径），现在靠的是：
  特权工具只在主人触发回合可用 + 逐次模型审批核对「是不是主人这条消息要求的」+ 发送白名单/敏感审计；
  仍未加目录白名单（残余风险，见 `SECURITY_BASELINE.md` §三 R13、`docs/PITFALLS.md` #81）。

**第三方插件的模型侧工具**（例如 `dsh-memewiki` v2 的 `search_meme_wiki` / `meme_recall` /
`meme_feedback` / `meme_remember`）：它们不在 DSH 安装包里，`scan-dsh-tool-names` 对账扫不到，
但 QQ 会话要用就必须进执行期白名单。2026-10-30 起这 4 个名字在 `MEMEWIKI_TOOL_NAMES` 里单独放行；
**故意不进 `RESTRICTED_TOOL_NAMES`**（restrict 是"从 schema 隐藏"，加进去模型就看不见、功能等于没装）。
判断标准同 `todo_write`：只读公共数据 / 只写插件自己的数据目录、没有 shell、没有任意文件与账号动作。
以后再加第三方插件工具，照这个模式：独立导出名单 + 三条测试断言（导出/放行/不在 restrict）+ 本节登记。

**历史教训（写进代码注释里）**：名单初版把 `pwsh_persistent`/`bash_persistent`/`cordis`/`goal_write`
当成工具名，这五个**根本不存在**；而 `tools.restrict()` 对未知名字会抛错、被逐条 try/catch 吞掉，
于是坏名字**静默失效**。现在 `scripts/test-preset-local-tools.mjs` 与
`scripts/scan-dsh-tool-names.mjs` 会拿 DSH 真实工具名与名单双向求差——**每次升级 DSH 都要跑**。

---

## 5. 两代 preset

| | `qq-chat`（order 10） | `qq-chat-v2`（order 11） |
| --- | --- | --- |
| 用在哪 | 一代 `social` / 普通 `chat` / 黑话学习会话 | 二代 `reserved2`（DSH 里默认） |
| 文本输出 | **就是消息**（桥接直接发） | **只是思考**，发言必须调工具 |
| 分条 | 按空格分句 | 用 `qq_send_message` 的数组 |
| 唤醒 | 桥接按概率/关键词唤醒 | 模型自己 `qq_set_wake_config` 决定下次怎么醒 |
| 工具面 | 同样挂 `qq-tool-restrict` + QQ MCP | 同 + **`qq-owner-approval` 内部模型审批行**（`inject:['tools']`） |
| 人格 | `agent.cordis.yml` 的 `persona.prefix`（约 9 个 plugin 行 + 人格段） | 同结构 + 二代协议/工具规则 + 第 22 条【场景与审批】 |

**共同点**：两个 preset 都是"一条 `@deepseek-ai/dsh-agent-preset` 行"，人格正文与工具面都写在
`dsh/agent-presets/<name>/agent.cordis.yml` 里，由生成器转成 bundle patch。

**差异要点（改之前先想清楚）**：

- 二代**不自动转发文本**。如果工具没挂上，模型会"说了话但群里没反应"——这是最常见的误配症状。
- 一代的 `[SILENT]` 是潜水信号；二代没有这个约定（用 `mark_read` + `set_wake_config` 潜水）。
- 二代有 `qq_close_conversation`；一代没有（一代靠状态机自行退场）。
- **审批行只在二代**：一代冻结、行为不变；`socialV2.toolApproval.enabled=false` 时 guard 与审批行一起回旧语义
  （本地工具只认主人私聊，桥接端点只认主人私聊/旧窗口）。
- preset 正文的安全不变量（`src/preset-prompt.js` 的 `PRESET_BLOCKING_SUBSTRINGS`）：2026-11-06 起
  `只在主人私聊里可用` 已换成 **`主人本人触发的回合`**（必须逐字出现在 qq-chat-v2 正文里），其余四条
  （`群友没有管理权限` / `作为 token 参数传入` / `角色由桥接注入` / `不会自动发送到 QQ`）不变。
  控制台保存/还原仿真提示词会按这份清单校验——改 preset 文案时两边一起改，否则保存会 403。
- `qq-chat-v2` 的安全规则第 1/4 条、工具协议第 18/20/21 条已按新语义改写，并**新增第 22 条【场景与审批】**：
  【本回合授权】含义、审批会拒绝「与主人请求对不上」的调用、被拒不要反复重试、群友追加要求不算授权。

---

## 6. 装配流程

```
dsh/agent-presets/<preset>/{preset.yml, agent.cordis.yml}      ← 权威源（人改这里）
        │  scripts/build-agent-preset-patches.mjs（--check 防漂移）
        ▼
plugins/surfcore/presets/<preset>.patch.yml                    ← 生成物（勿手改）
        │  scripts/setup-dsh.mjs（幂等）
        ▼
~/.dsh/profiles/<profile>/package.json       → 注册 bundle: surfcore（link: 依赖）
~/.dsh/profiles/<profile>/cordis.patch.yml   → 挂四个 MCP server + 两条 preset 行
```

- **为什么需要生成器**：DSH 0.1.7 起 preset 不再是目录，而是一行 loader，
  它的 `config.plugins` 必须是内联列表，只能由 bundle patch 插入。于是同一份行列表必然有两种表示
  （源/产物），生成器是唯一转换器。
- **守卫行的引用方式**：必须是**从 profile 目录可解析的裸说明符**（`surfcore/qq-tool-restrict.mjs`），
  不能是 `./qq-tool-restrict.mjs`——子行 name 按 profile 目录解析，相对路径会找不到文件（正是 0.1.7 的坑）。
  审批行同理：`surfcore/qq-owner-approval.mjs`（`scripts/build-agent-preset-patches.mjs` 的
  `RELATIVE_ROW_REWRITES` 已登记；`plugins/surfcore/package.json` 的 `exports` / `files` 也已加入）。
- **必含行**：生成器按 preset 校验——`qq-chat` 必须含 `persona` + `qq-tool-restrict`；
  `qq-chat-v2` 还必须含 **`qq-owner-approval`**（缺了 = 群聊主人回合的特权工具没审批，属于安全回归，生成直接报错）。
- **安装是幂等的**：重复跑 `setup-dsh.mjs` 不会重复插入。
- **DSH 升级后**：重新 `npm run test:preset-patches` → `node scripts/setup-dsh.mjs` → 重启 DSH。
  工具名对账：`npm run scan:tool-names`。
- 改审批插件/守卫/preset 后**要重启 DSH**（新行与工具描述才进 QQ 会话工具面），正在进行的 QQ 会话再 `/reset` 一次；
  只改 `config.json` 的 `socialV2.toolApproval` 属热配置（插件按 mtime 读），下次工具调用即生效。

---

## 7. 边界与失败模式

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 模型只会说话，群里没反应 | 二代文本不自动发；工具没挂上/没开 | 检查 MCP 挂载 + `socialV2.tools.sendMessage` |
| 工具调用 403「不在白名单内」 | 目标不在 `allow.*` | 加白名单（这是硬闸，没有管理员例外） |
| 403「该接口仅控制台可用」 | 某端点只允许管理端 | 换工具，不要绕 |
| 401「会话令牌无效」 | 会话被重置/退役，旧 token 失效 | 让桥接重新注入提示词（重新唤醒） |
| 特权工具报「只能在主人本人触发的回合里使用」/ 403（好友申请、跨场合、群管理） | 本回合不是 ownerQQ 本人触发（群友触发/定时唤醒/别人私聊），或归因文件缺失/过期，或不是 `reserved2` | 由主人本人发一条消息触发新回合；检查 `state/turn-triggers.json` 是否随消息更新、`mode` 是否 `reserved2` |
| 特权工具报「模型审批未通过 / 审批失败，已拒绝 / 审批结果不可用」 | 内部模型审批 deny / 超时 / 坏 JSON / 模型路由缺失（fail-closed） | 让主人把要求说清楚再试（审批核对的是「是否主人这条消息要求的」）；不要换个说法反复试探；看 `state/tool-approvals.jsonl` 的 decision/reason |
| 特权工具报「本回合模型审批次数已达上限」 | 单回合调用超过 `maxReviewsPerTurn`（默认 6） | 合并操作；确实需要更多审批时调大配置（1~12） |
| 群管理 403「私聊里禁言必须显式指定 groupId…」 | 私聊发起禁言没传 `groupId` 或该群不在 `allow.groups` | 传白名单群号重试 |
| 群管理 403「该群不在白名单，已拒绝」/「群会话只能管理本群的成员」 | 目标群不在 `allow.groups`，或群聊里传了别的群号 | 用当前群；私聊带白名单 groupId |
| 429 | 频率超限 | 减条数/放慢 |
| 工具名拼错 → 静默失效 | `restrict()` 对未知名字抛错被吞 | 跑 `npm run scan:tool-names` |
| DSH 升级后工具集体消失 | MCP 配置被覆盖 / preset 行没重建 | 重跑 `setup-dsh.mjs` |
| 升级后 QQ 会话建不出来 / preset invalid | 审批行或守卫行加载失败（模块顶层抛错、相对路径解析不到） | 看 DSH 日志里的 `agent-preset/invalid`；确认 `plugins/surfcore/package.json` 的 `exports/files` 含新行、跑 `npm run test:preset-patches` |
| `qq_send_voice` 报 502 / 「合成超时」 | 语音引擎没启动，或 CPU 被别的大型任务占满导致合成慢过超时（本地包是 CPU 推理；错误现为 504 + 「改回打字」） | 启动对应包；或把 `socialV2.voice.tts.timeoutMs` 调大后重启桥接（见 `SUBSYSTEM-VOICE.md` §4.4） |
| `qq_wait_for_messages` 报「必须先做沉睡前观察」 | 直接 `set_wake_config` 潜水 | 先 wait 300000 |

---

## 8. 还没覆盖的部分（⚠️）

- `src/mcp-snowluma-safe.js` 里每个工具**完整的参数 schema 与逐条校验顺序**没有在本文件展开
  （只给出了能力面与闸门层级）。要改某个工具时，直接读该工具定义附近的代码。
- `mcp-host-server.js` / `mcp-web-search-safe.js` 的传输细节与错误透传没有逐行展开。
- preset 的人格正文（`persona.prefix`，数千字）没有全文抄进本文档——它是产品内容，直接看源文件。

> 相关文档：[ARCHITECTURE.md](ARCHITECTURE.md)（工具面在整体里的位置）、
> [BOUNDARIES.md](BOUNDARIES.md)（失败模式总表）、[DSH_SETUP.md](DSH_SETUP.md)（安装细节）、
> [../PITFALLS.md](../PITFALLS.md)（#71 preset 漂移、守卫名单对账的历史教训）。
