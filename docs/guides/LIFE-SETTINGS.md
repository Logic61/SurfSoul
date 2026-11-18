# 生活参数（LIFE-SETTINGS）

> 一句话：让 QQ 里的 agent 通过工具**预览 / 执行 / 验证 / 回滚**自己的生活参数（B站作息、主动冒泡、唤醒概率、目的节奏…），
> 同时保证**不改基础配置、不越权、不放宽硬上限**。参考 GitHub `nefelibata5136-code/surfcore-life` 的设计，
> 按本仓库 0.6.22 的权限/归因基础设施重做了实现层（差异见文末）。
>
> 待审阅的开放清单：[LIFE-PARAMS-CHECKLIST.md](LIFE-PARAMS-CHECKLIST.md)。

---

## 1. 架构（谁写、谁读、谁验证）

```
QQ 会话里的 agent（reserved2）
  └─ MCP 工具 mcp__life-settings__life_*（key + token 必填）
       └─ HTTP → bridge 127.0.0.1:<consolePort>/api/life/*
            ├─ 全局鉴权：x-console-token + x-agent-token + x-agent-call:1
            ├─ 会话绑定：agentTokenOk(key, token) + 当前模式白名单 + reserved2
            ├─ 写操作 owner 闸：ownerTurnAllowed(key)
            │    = 主人私聊 || reserved2 下「本回合触发消息发送者=ownerQQ 本人」
            ├─ 每会话写入限频 + 审计 state/life-settings-audit.jsonl
            └─ manager（事务层）→ sidecar ~/.dsh/surfcore/life-settings.json
                                  （锁 / 原子写 / 备份 / history / observations）

消费者（各自读 sidecar 覆盖层，再发布「我采用了」的证据）：
  · QQ / purpose：bridge 每 5s refresh → 只改内存 cfg 的受管字段 → life-runtime/qq.json
  · B站：插件 scheduler/config 每次读配置时 overlay → life-runtime/bili.json
验证：life_verify 读消费者证据（同 scope/同 revision/90s 内/pid 存活/值相等才算 runtime-adopted）。
运维：控制台/CLI 是**唯一审批入口**（MCP 没有 approve 工具）。
```

三个事实必须分开（参考实现的核心口径，本仓库沿用）：
1. **保存 ≠ 采用**：`life_apply` 只保证 sidecar 已落盘（`saved-unverified`）；
2. **采用 ≠ 行为**：消费者读到了新值才算 `runtime-adopted`，但「真的发了一条 QQ/看了一个视频」要另看活动记录；
3. **默认值 ≠ 她的选择**：`life_state` 会标 `origin`（catalog 默认 / 人类基础配置 / agent 覆盖）。

## 2. 文件与状态

| 路径 | 作用 | 谁能写 |
|---|---|---|
| `~/.dsh/surfcore/life-settings.json` | **唯一受管权威源**：`{schema,scopeId,revision,overrides,history,plans,observations}` | bridge（manager）/CLI（同一事务锁） |
| `~/.dsh/surfcore/life-settings.lock/` | 跨进程 mkdir 锁（崩溃遗留可用 CLI `recover-lock` 隔离） | 同上 |
| `~/.dsh/surfcore/life-settings-backups/` | 每次提交前整份备份 `r<revision>-<uuid>.json` | manager |
| `~/.dsh/surfcore/life-runtime/{qq,bili}.json` | 消费者自证快照（producer/pid/revision/observedAt/values/details） | 各自消费者 |
| `state/life-settings-audit.jsonl` | 桥接侧写入审计（谁、什么动作、成功/失败；不含 token 与参数全文） | bridge |
| `<repo>/config.json`、`~/.dsh/surfcore/bili.config.json` | **基础配置，保持原样**（受管值不写回这里） | 原有设置页/控制台 |

`scopeId = sha256(canonical(root)+canonical(dshHome))`：bridge、插件、CLI 必须共享同一个 `SURFCORE_ROOT`/`DSH_HOME`，
否则读不到同一份 sidecar（MCP 挂载时由 `setup-dsh.mjs` 显式写 env）。

## 3. 工具面（9 个，挂在新 MCP server `life-settings`）

DSH 侧工具名：`mcp__life-settings__life_*`。所有工具都必须带 `key` + `token`（就是唤醒提示里的【会话令牌】）。

| 工具 | 作用 | 权限 |
|---|---|---|
| `life_state` | 保存值 / 来源 / 采用证据 / 只读项 / 预算快照 / 待审批 | QQ 白名单会话可读 |
| `life_catalog` | 发现 30 个参数 + 5 个意图（可按中文关键词过滤） | 可读 |
| `life_explain` | 单参数说明、范围、影响、依赖、生效时机、恢复方式 | 可读 |
| `life_preview` | 生成精确计划（patch 或 intent + 理由），**不生效**；15 分钟过期 | 写权限（owner 回合） |
| `life_apply` | 执行一个已预览计划 → `saved-unverified` | 写权限 |
| `life_verify` | 读消费者证据，返回 adopted / saved-unverified / superseded | 可读 |
| `life_history` | 修改与观察记录（分页） | 可读 |
| `life_rollback` | 生成「恢复到某次修改前」的计划（仍要 apply；拒绝覆盖后来同字段选择） | 写权限 |
| `life_observe` | 记录她自己的观察/保留/考虑撤回（不推断心理、不改参数） | 写权限 |

内置意图（确定性 patch，仍需预览+执行）：`less-disturbance`（减少主动打扰）、`more-group-opportunities`（提高群聊参与机会）、
`more-solitude`（增加独处时间）、`more-exploration`（增加自主浏览机会）、`fewer-model-opportunities`（减少自主模型机会）。

## 4. 权限与硬边界

| 场景 | 读 | 写（preview/apply/rollback/observe） |
|---|---|---|
| 主人本人私聊 `private:<ownerQQ>` | ✅ | ✅（不跑模型审批） |
| reserved2 群里「主人本人那条消息」触发的回合 | ✅ | ✅ + 每次过内部模型审批（`qq-owner-approval`） |
| 群友触发的回合（含转述「主人说」） | ✅ | ⛔ 403 fail-closed |
| 非主人私聊 | ✅ | ⛔ 403 |
| 非 QQ 会话（DSH Web/桌宠） | ⛔（没有会话令牌） | ⛔ |
| 控制台（consoleToken） | ✅ 只读 + pending | ✅ 只有 `approve`；不代替 agent 改值 |

- `toolApproval.enabled=false` 时，群聊里的 owner 回合写会 fail-closed（与其它特权工具同口径）；主人私聊不受影响。
- 每会话每小时最多 `lifeSettings.maxWritesPerHour`（默认 12）次 `apply/rollback/observe`。
- **永远不开放**：凭据/cookie/账号身份、`allow`/`deny` 名单、模式/preset、工具审批开关、鱼群保护硬闸、系统提示词、
  token 预算硬上限、`purpose.dailyMax`、`bili.limits`、记忆容量/遗忘规则。
- 目录是**闭集**：patch 里出现未登记参数直接 `PROTECTED_OR_UNKNOWN_PARAMETER`，不存在「透传任意 JSON」。

## 4.1 每日生活参数心跳（2026-11-08，用户要求「就在早安一个心跳」）

每天在主人私聊叫醒一次，让她自检生活参数、有明确理由才改、改完汇报。**默认开、每天 08:00、最多改 2 项**。

| 项 | 行为 |
|---|---|
| 配置 | `config.json` 的 `lifeSettings.dailyReview.{enabled,time,maxChanges,notifyOwner,graceHours}`（默认 `true/08:00/2/true/3`） |
| 排程 | 准点；错过在 `graceHours` 内补跑；DSH 离线/投递失败 10 分钟重试；同一天只跑一次（状态 `state/life-review.json`） |
| 唤醒位置 | 固定 `private:<ownerQQ>`（主人私聊）；暂停/非 reserved2 时跳过并记当天，不反复重试 |
| 与早安合并 | 早安问候也开着、对象=主人、时间相同 → 心跳正文拼进同一条早安唤醒（不重复叫醒）；否则单独投一条「早安+复盘」 |
| 内容 | `life_state` → 判断（最近是否总被打断/没机会探索/目的节奏不合适…）→ `life_preview/apply/verify`；最多 `maxChanges` 项；默认保持不动；只读/审批项不碰 |
| 汇报 | `notifyOwner=true` 时改完用 `qq_send_private_message` 说一句「改了什么/为什么/怎么改回」；没改不特意发 |
| 控制台验收 | `GET /api/life/review`（配置+今天跑没跑+下一次）、`POST /api/life/review/run`（手动试跑，不占当天名额） |
| 关闭 | `lifeSettings.dailyReview.enabled=false`（只管心跳；生活参数工具仍可用） |

失败语义：和早安同一套——早起/重启不丢当天（补跑），DSH 不在线不标记完成，投递失败重试；跑了就写 `lastDate`，绝不一天叫两次。

## 5. 运维与回滚

```powershell
# 看状态 / 待审批计划（本机真实 DSH_HOME）
npm run life -- state
npm run life -- pending

# 审批一项 approval 参数（wakeMaxChars）：把 agent 预览返回的 planId 粘进来
npm run life -- approve --plan plan-xxxx --reason "同意把唤醒上下文放宽到 8000"

# 历史 / 单参数说明
npm run life -- history --limit 10
npm run life -- catalog --q B站

# 崩溃后遗留锁：确认 owner.json 里的进程已死，隔离锁目录
npm run life -- recover-lock
```

回滚走同一条事务：agent 侧 `life_rollback(changeId)` 生成计划 → 确认后 `life_apply`；
若同一参数后来又被改过，回滚会被拒绝（不会覆盖后来选择）。**回滚不重置**当天已用次数、预算用量、平台凭据或记忆。
基础配置文件始终没被改过，所以最坏情况也可以让你自己在设置页/手改配置回到原值。

## 6. 生效时机（诚实口径）

| 参数组 | 生效 | 说明 |
|---|---|---|
| `qq.socialV2.*` / `purpose.*` | 下一拍（≤5s 内桥接采用；下一次排程/提示词使用） | 已有计时器不强制重排（`nextFireAt`/睡眠时长保留），`purpose.gap*` 影响下一次排程 |
| `bili.night.*` / `preferences.*` / `share.*` / `listen.*` | 下一轮 B站 tick（插件 overlay） | 重排保留当天已用次数/旧 slot，不补跑错过窗口 |
| `socialV2.context.wakeMaxChars` | 审批通过 + apply 后下一次唤醒 | 需主人 CLI approve |

## 7. 故障语义（fail-safe 优先）

- sidecar 坏/读失败：消费者保留最后一次成功值并记日志，**不中断** QQ 投递与 B站 tick；`readState` 拒绝覆盖坏文件（保留现场）。
- 锁被占：写接口返回 `CONFIG_BUSY`，不自动破坏锁；启动/CLI 的 `recover-lock` 只在 owner 进程已死时隔离。
- 证据过期/进程重启：`life_verify` 显示 `saved-unverified`/`stale-or-inactive`，**不假装生效**。
- 生活参数初始化失败：bridge 其余功能照常，life 工具返回 503。
- 证据写盘已节流（变化立即 + 45s 心跳），避免参考实现 5s 一次写盘的 IO 噪音。

## 8. 与参考仓库（surfcore-life 0.7.0）的差异

| 维度 | 参考实现 | 本仓库 |
|---|---|---|
| 工具进程权限 | MCP 进程直接持有 manager，**不知道调用者是谁**（群会话也能改） | MCP 只做 HTTP 代理；bridge 按真实 sender 归因 + owner 回合 + 白名单做硬闸 |
| 审批 | 只有本地 CLI，MCP 无 approve | 同（CLI + 控制台 `/api/life/approve`），MCP 仍不暴露 approve |
| 写入 | sidecar 覆盖层（不写基础配置） | 同（保留该优点） |
| 跨午夜窗口 | 只接受 `start<end` | 接受 `22:00→02:00`，自动拆两窗并提示 |
| 证据写盘 | QQ 每 5s 一次 | 变化立即 + ≥45s 心跳 |
| 计划/历史 | 无上限 | plans 保留最近 50、history/observations 各 ≤1000 |
| 消费失败 | B站 CLI 遇坏 sidecar 会抛 `CORRUPT_FILE` 拖垮链路 | runtime 层 fail-safe 缓存，坏文件不拖垮消费链路 |
| 预算 | 只读快照 | 同（只读；「少自动机会」靠减少机会实现，不是放宽上限） |
