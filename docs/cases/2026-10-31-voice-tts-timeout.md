# 2026-10-31 · 语音连发两条都「合成超时（>60s）」，AI 只好改打字

## 现象

- 用户原话：「喂，不行，哼给我听」→ AI 两次 `qq_send_voice`（text 现场合成）都失败，回复「算了，嗓子罢工，哼不出来」；
  随后在 DSH 里丢了一句「修复语音功能」。
- 复现步骤（当时现场）：
  1. 机器上并行跑着自己的「犬类情绪识别」重训流水线（1514 帧特征提取 + 6 组重训，峰值 7~8 个 python 进程）；
  2. QQ 里让 AI 发一条 6~14 字的语音；
  3. 桥接 `[voice]` 路径 60 秒后报「发送语音失败：合成超时（>60s）：The operation was aborted due to timeout」。
- 影响面：语音发不出去（不丢数据、可恢复）；对话里 AI 被迫改文字。**只要高 CPU 负载还在就会复发**。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 11 / DSH 0.2.1-rc.2 |
| SurfCore 版本 | v0.6.22（HEAD `c7a1563`） |
| 安装方式 | junction（`node_modules/surfcore` → 本仓库） |
| 其它相关版本 | 本地语音包 voice-local 0.1.0；GPT-SoVITS（**CPU 推理**，`tts_infer.yaml: device: cpu`） |

## 根因

**直接原因（代码）**：`socialV2.voice.tts.timeoutMs` 默认 60 秒，语音引擎这次合成用了 **126.4s / 70.0s**
（引擎侧实据见 `docs/guides/SUBSYSTEM-VOICE.md` 引用的 `gsv/api.log` 四段耗时），客户端先放弃。

**为什么这次会 126s（环境）**：本地 GSV 是 **CPU 推理**（`.venv-gsv` 里是 `torch 2.5.1+cpu`，
`device: cpu`），不是 GPU。主人重训流水线把 CPU 调度/内存压满时，GSV 整段请求只拿到 0.24~0.61 core，
三阶段（BERT / T2S / 音频）同步劣化 5~30 倍。GPU 假设被证伪：故障期 GPU 只有 12~28%、显存 4.1/8.1GB、
无热降频。流水线 00:19:29 结束后，同一探针立刻回到 9~17 秒。

**代码侧放大缺陷**：
1. `src/voice-tts.js` 的合成失败只抛 `Error(message)`，没有 `code/statusCode`；
   `src/bridge.js` 用中文正则 `/语音合成|TTS/` 猜状态码 —— 超时文案「合成超时」不含这两个词，
   被兜底成 **HTTP 400**，模型/运维会误以为是「参数不对」（`SUBSYSTEM-VOICE.md` §10.6 #5 早已登记）。
2. 客户端 AbortSignal 超时后，voxd 的合成任务**不会停**（`/v1/speak/file` 没有 finally cancel，
   GSV 是阻塞 urllib），继续占着单 worker，同文本稍后重发只能排队 —— 雪崩的温床。
3. 桥接日志不记录合成耗时，事后只能去翻引擎日志才能判断「慢」还是「挂」。
4. 顺手发现群聊 `trigger.who="list"` 分支引用未定义变量 `last`（R37），一用就 ReferenceError。

## 修法

| 改动 | 内容 |
| --- | --- |
| `src/voice-tts.js` | 新增 `ttsFailure(message, code, statusCode)`；空文本→400、超时→`TTS_TIMEOUT`/**504**、连不上→`TTS_UNAVAILABLE`/**502**、voxd 非 2xx→`TTS_HTTP_ERROR`/**502**、空音频→`TTS_EMPTY_AUDIO`/**502** |
| `src/bridge.js` | 新增 `voiceSynthError(error, {hint})` 统一分类器（优先 `error.statusCode`，中文文案只做旧错误兜底）；AI/操作者两条路由都改用它；AI 通道 5xx 文案追加「请改回打字，不要重试」（MCP 丢状态码，文案是模型唯一能看到的）；`synthesizeVoiceText` 记录合成耗时/失败日志；修 `last` ReferenceError |
| `config.json` | `socialV2.voice.tts.timeoutMs` 60000 → **150000**（覆盖本次观测最坏 126s；MCP 外层 300s 仍是硬上限） |
| 测试 | `scripts/test-voice-tts.mjs` 增 ⑧⑨⑩（结构化 code/statusCode）；新增 `scripts/test-voice-route-errors.mjs`（超时→504、引擎→502、旧式错误按文案兜底→504、超字数→400、失败不发任何消息）；进 `test:audit` 门禁 + `npm run test-voice:errors` |

**为什么选这个方案**：不改音色、不换引擎（`strict` 音色不允许静默换人）；`/v1/stop` 无 job_id 会误伤桌宠
且对单句阻塞合成无效（实测）；流式精确取消属 Phase 2。先做到「失败可读、慢也能发出去、日志可诊断」。

**没选**：把 GSV 换到 GPU（`.venv-gsv` 是 CPU 版 torch，RTX 5070 是 sm_120 需要 cu128 版 torch，
属独立升级，风险/下载量都大，需另行拍板）；把主音色切到 piper（2~5s 但音色会变，违反冻音色约定）。

**回滚**：`git revert <commit>` + `config.json` 的 `timeoutMs` 改回 60000 + 重启桥接。

## 验证

- 自动化：`node scripts/test-voice-tts.mjs`（exit 0）、`node scripts/test-voice-route-errors.mjs`（exit 0）；
  既有 `test-voice.mjs`(83)/`test-voice-route.mjs`/`test-voice-edge.mjs`(12)/`test-voice-volume.mjs`(14)/
  `test-voice-gui.mjs`(20)/`test-voice-packs-default.mjs` 全绿（`test-voice-system.mjs` 的 1 条红是既有基线，
  与本轮无关）。
- 手工（本机，训练结束后）：桥接 dry-run `node scripts/voice-send-test.mjs --key private:<owner>` →
  「预演通过：合成 0ms 音频（102.2 KB）」；引擎直探 7 字 ≈ 8.6~11.6s；`/v1/health` 队列空。
- 没验证到的部分：桥接重启后**真机发一条语音**（需重启窗口；AI 通道的 MCP 文案改动要等下一次 DSH 重启）。
- 下次再遇同类：先看 `bridge.log` 的 `[voice] TTS 合成完成/失败 <ms>` 与 `state/voice-packs/voice-local/logs/`
  四段耗时；若单次 >150s，先看 CPU 满载（`Processor Queue Length`、可用内存），再决定是否要 Phase 2（流式取消 / GPU）。

## 遗留 / 后续

- **Phase 2（可选）**：`/v1/speak` 流式改造（拿得到 `X-Job-Id`，客户端断开时 voxd 自己 cancel；顺便可做精确 `/v1/stop`）。
- **GPU 升级（可选，单独拍板）**：给 `.venv-gsv` 装 cu128 torch（RTX 5070 = sm_120）预期 1~3s/句；需要验证
  GPT-SoVITS 兼容性与 8GB 显存余量，失败可整体保留 CPU venv 回退。
- **MCP 层（下轮 DSH 重启一起）**：`mcp-snowluma-safe.js` 透传状态码、工具说明第⑤条补「504/合成超时」分支、
  preset 文案同步（`plugins/surfcore/presets/*.patch.yml` 防漂移测试要跑）。
- 文档：`SUBSYSTEM-VOICE.md` §4.3/§4.4/§10.2/§10.6 已同步；`docs/guides/AGENT-TOOLS-AND-PRESETS.md` 的
  「qq_send_voice 一直 502」排障行补了「或合成慢/超时」。
