# 对话收尾判断（conversation closure）

> 目标：让每段对话有自然终点。发完最后一句后先判断「这段还能不能继续」，不能就安静结束，
> 不再硬补一句；但结束不是断掉——收在哪、下次怎么接都会留下来。
>
> 代码：`src/conversation-closure.js`（纯逻辑）、`src/bridge.js`（状态/接口/冷却）、
> `src/mcp-snowluma-safe.js`（`qq_close_conversation` 工具）。
> 测试：`scripts/test-conversation-closure.mjs`、`scripts/test-closure-wiring.mjs`。
> 踩坑背景：`docs/PITFALLS.md` #63。

---

## 1. 谁决定收尾

甘棠读同一会话里最近的来回、说话人、引用和还有没有人等她答复，自己选择接话、发图、等待或收尾。群友互相提问和熟人说反话都需要这些上下文。控制台的本地节奏指标用于排障，聊天唤醒里只保留上次的结束点。

## 2. 三个动作别混

| 动作 | 语义 | 改 wakeConfig？ | 要沉睡前观察？ | 留结束点？ |
| --- | --- | --- | --- | --- |
| `qq_send_message` | 说话 | 否 | 否 | 否 |
| `qq_mark_read` | 看过了，划走 | 否 | **是**（若当前是潜水配置） | 否 |
| `qq_set_wake_config` | 进入潜水/改唤醒条件 | **是** | **是** | 否 |
| `qq_close_conversation` | 这段自然结束 | **否** | **否** | **是**（summary / nextOpening） |

`close` 不是潜水：唤醒配置原样保留，对方再找你、开新话题、私聊都会照常醒。
它只是「这一轮不再输出」，并把结束点留给下次。

## 3. 硬规则与冷却

### 3.1 先处理新来信

收到尚未向模型展示的新来信时，桥接返回 409 `unseen-messages`，保留所有未读；模型通过 `qq_get_unread_messages` 读完再决定。已经展示的问题由模型结合前文判断，`openQuestion=pending` 且 `requireNoOpenQuestion` 开启时会收到 409 `open-question`。反问、问旁人或已经回答的问题都可自然收尾。

### 3.2 冷却只压软唤醒

收尾后 `cooldownMs`（默认 20 分钟）内，只跳过：

- `probability`：普通消息按概率唤醒；
- `replyCheck`：发完消息 30 秒后的例行回复检查（close 时直接取消）；
- `proactiveCheck`：冷场主动机会。

**不压**：`atMention`、`nameMention`、`question`、`keyword`、`poke`、`speaker`、`private`。
结束不是把人关掉。

### 3.3 重开

- 私聊：对方一开口就是新的开始；
- 群聊：只有直接叫到 / 引用 / 提问 / 道别才重开；普通闲聊不打断冷却。

重开后 `closure.reopenedAt` 会被写上，下次唤醒提示会说「上次刚收过尾，现在是新的开始，
别复读上次的结尾」。

### 3.4 自然收尾 5 次后换 DSH 会话（2026-11-01 规则，2026-11-02 加静置窗口）

不按 token 压力，**数自然收尾次数**：`socialV2.closure.rotateAfterClosures`（默认 5，0=关闭），
再叠加静置窗口 `socialV2.closure.rotateIdleMs`（默认 **5 分钟**，0=不等）。

- 本次 DSH 会话内每成功 `qq_close_conversation` 一次，`st.sessionClosures` +1；累计 ≥ 阈值
  → 挂定时器：先等收尾回合结束（`isConversationBusyV2()` 为 false），**再等 `rotateIdleMs` 内没有新消息**
  （`lastIncomingAt` 被新消息推后就把剩余时间顺延），满足后执行 `retireSession(key)`：
  停+归档旧 DSH 会话、轮换 agentToken、`bootstrapSent=false`、**收尾计数清零**，
  而收尾记录/记忆卡/轻记忆/未读窗口全部保留（都在 `social-v2.json`）。下一段对话由
  `ensureSession` 懒创建并走 `bootstrap` 冷启动。
- **为什么加静置窗口（PITFALLS #90）**：原来「收尾回合结束就换」，活跃聊天时几分钟换一次会话；
  每次新会话第一轮都要重发很长的 bootstrap（环境说明 + 记忆卡注入，冷启动 ≈37–38k tokens），
  token 成本高、上下文还被切断。现在收尾后 5 分钟内只要对方又开口就继续用原会话，真的静下来才换。
- 为什么换而不是压缩：1M 窗口下 DSH 自动压缩阈值高达 727,040 tokens（实际几乎不触发）；手动 `/compact`
  的摘要是英文 coding agent 八段式，对陪伴人格的记忆不友好（见 PITFALLS #87）。换会话冷启动 ≈37–38k
  tokens，比手动压缩后的常态 ≈50k 还低。
- 放弃条件（都不算错，只是这次不换；计数不清零，下次收尾会再触发）：对方又开口（`reopenedAt` 更新）/
  有更新的一次收尾 / 会话映射已被别的路径换掉 / 等待 6 次（约 30s）仍在忙。
- 只在 `reserved2` 的 `qq_close_conversation` 链路生效（v1 模式没有收尾概念）。

### 3.5 上下文到阈值换 DSH 会话（2026-11-10 用户改口径：220k 一换）

用户原话：「要不改成上下文大小吧，220k 一换」——收尾次数太慢时（一段对话聊很久也不收尾，
但每轮都在为几十万历史付费），直接按**当前上下文大小**换 session。

- 配置：`socialV2.closure.rotateAfterContextTokens`（默认 **0=关闭**；live 设为 **220000**）。
- 口径：**当前这一轮真正带入模型的 input token**（最近一条 assistant usage 的
  `cacheMiss + cacheHit + cacheWrite`），不是会话累计计费量——后者每轮把历史重发都叠加一次，
  一条正常长会话几轮就能到几百万，阈值会退化成「每轮都换」。读不到采样（刚换过会话 /
  DSH 还没上报 usage）时为 0，**不触发**（fail-open 到旧行为，宁可晚换也不误拆）。
- 触发点：每个回合结束（`turn/end`）后判断；到阈值就挂 5s 定时器，定时器里
  `isConversationBusyV2()` 为 false 才执行 `retireSession(key)`（会话忙最多重试 6 次，
  放弃后下一次回合结束重新判断——上下文只会更大，不会漏）。
  与 3.4 的「自然收尾 N 次」是**两个独立触发，谁先到算谁**；live 把 `rotateAfterClosures`
  设成 0，就是纯上下文模式。
- 为什么不在投递前当场换（上游 fork 的 session-rollover 做法）：本地桥接的 `deliverPromptNow`
  可能和上一轮 turn 有交错，当场 retire 会轮换 agentToken、把在途回合的回复打成 403；
  回合结束后 5s 换，会话里没有在途 turn，最安全。为什么不是「每轮都重发就重发」：
  DSH 自动压缩阈值在 1M 窗口下高达 727k，等它压缩时上下文已经贵了一整天。
- 换会话只换 DSH session：记忆卡/收尾记录/轻记忆/`recentMessages` 都在 `social-v2.json`，
  下一段对话 `ensureSession` 懒创建、走 bootstrap 冷启动。
- 可观测：`GET /api/socialV2/states` 每个会话带 `contextTokens`（当前上下文，离阈值还有多远）；
  `bridge.log` 命中时打 `[轮换] … 上下文 N token ≥ 阈值，换新会话`。
- 与 3.4 的静置窗口不同：上下文滚动**不受 `rotateIdleMs` 约束**（那边是为收尾场景设计的
  「等对方真的不说话了」，这边是成本闸：到阈值就该换，否则下一轮又是几十万）。

### 3.6 等补充、自然收尾与潜水

对方还在分条打字，可以短等补充；聊完调用 `qq_close_conversation` 后就能结束回合。想暂时退出聊天并改唤醒策略时才走配置的潜水观察窗口。桥接维护已读水位、时间和下次唤醒，问句是否指向自己由聊天模型结合前文判断。

## 4. 结束点长什么样

`state/social-v2.json` 的会话状态里：

```json
"closure": {
  "at": 1761280000000,
  "key": "private:123",
  "kind": "private",
  "reason": "natural",
  "summary": "聊到扯平这件事",
  "nextOpening": "问问她周末去不去看展",
  "cooldownUntil": 1761281200000,
  "turns": 3,
  "lastOtherKind": "substantive",
  "lastSelfKind": "ack",
  "reopenedAt": 0,
  "reopenReason": ""
}
```

- `reason`：`natural / topic-done / explicit-end / busy / tired / other`；
- `summary` / `nextOpening` 会被截断到配置上限（默认 160 / 120 字）；
- 记录跨桥接重启保留；`/api/socialV2/state` 返回 `closure` 摘要。

## 5. 配置

`config.json` 的 `socialV2.closure`：

```json
{
  "enabled": true,
  "cooldownMs": 1200000,
  "requireNoOpenQuestion": true,
  "promptInWake": true,
  "maxSummaryChars": 160,
  "maxNextOpeningChars": 120,
  "rotateAfterClosures": 5,
  "rotateIdleMs": 300000,
  "rotateAfterContextTokens": 0
}
```

- `enabled=false`：不注入判断块、`close` 返回 403；工具也会在 MCP 注册期被过滤；
- `promptInWake=false`：仍可 close，唤醒时省略上次的结束点；
- `rotateAfterClosures`（默认 **5**，0=关闭）：本会话内自然收尾累计 ≥ 该次数 → 之后换 DSH 会话；
  换完计数归零重新数；设为 0 关闭「按收尾次数」轮换。
- `rotateIdleMs`（默认 **300000 = 5 分钟**，0=不等）：收尾后要静置这么久没有新消息才真正换会话；
  期间对方又开口就继续用原会话。调大更省 bootstrap token，调小上下文更干净。
- `rotateAfterContextTokens`（默认 **0=关闭**；live **220000**）：当前上下文（最近一轮 input token）
  ≥ 该值 → 回合结束后换会话，见 §3.5。**不受 `rotateIdleMs` 约束**；与 `rotateAfterClosures`
  是独立的两个触发（live 设 0 关闭收尾口径，只按上下文）。
- 计数存在 `social-v2.json` 的会话状态 `sessionClosures`（跨桥接重启保留）；换会话/任何退役路径都会清零。
  `contextTokens` 不落盘：每次都从 token 账本 `state/token-usage.jsonl` 的最近采样现算。
- 设置页 QQ 页有「二代 · 对话收尾判断」卡片（`rotateAfterClosures`/`rotateIdleMs`/
  `rotateAfterContextTokens` 暂未做成 UI，改 `config.json` 后重启桥接生效）。

## 6. 验证与回滚

```bash
node scripts/test-conversation-closure.mjs
node scripts/test-closure-wiring.mjs
node scripts/test-qq-preset-contract.mjs
```

回滚：

1. 立刻停用：`socialV2.closure.enabled=false`（不用改代码）；
2. 彻底回滚：删 `src/conversation-closure.js`，回退 `src/bridge.js` / `src/mcp-snowluma-safe.js` /
   `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`，再跑
   `node scripts/build-agent-preset-patches.mjs`。
