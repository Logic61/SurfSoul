# AGENTS.md — 在这个仓库干活前先读这 60 行

> DSH 会把本文件自动注入本工作区的每个会话。**别在这里写人设或业务规则**（那些在 `roles/`、`RULES.md`）；
> 这里只写「怎么在这个仓库干活，才不会把东西干坏」。
> 人设/日子：`~/AGENTS.md`；业务规则：`RULES.md`；文档索引：`docs/README.md`。

## 0. 每次开工的固定动作（顺序别改）

1. 读 [`docs/ROADMAP.md`](docs/ROADMAP.md) 顶部「路线守则」——它决定你**该不该**动手。
2. 读 [`docs/HANDOFF.md`](docs/HANDOFF.md)——上一个我做到哪、什么还没验证。
3. 带着具体问题查 [`docs/PITFALLS.md`](docs/PITFALLS.md)（踩过的坑，含复现命令）。
4. 最后再读代码。**别相信会话记忆，相信文件**：半天前的「我记得改过」通常是错的。

## 1. 十条铁律（违反任何一条都算事故）

1. **先分析，再动手**：写清「现象 → 根因 → 影响面 → 修法 → 怎么验证」。分析没到能预判失败点，就只做只读排查。
2. **先算收益再选路线**：至少比较 2 条（收益/成本/风险/回滚难度）。**收益不佳就回退换路线**，别因为「已经写了这么多」硬撑。
3. **不补屎山**：宁可回退重写 30 行，也不在错地基上叠 300 行补丁。判断标准：新代码让「下一次改动」更容易了吗？没有就别合。
4. **不盲目跑探针**：`probe:*`、`setup-dsh.mjs`、`start*.bat`、任何会启动服务/发 QQ 消息/写 `~/.dsh` 的脚本，先说明目的、预期输出、失败后果，再跑；跑完先看日志再下结论。
5. **改完必测**：至少 `npm run test:audit`；碰协议/桥接加 `npm run test:regressions`；碰插件跑对应 `plugins/surfcore/scripts/test-*.mjs`。
6. **删改必隔离**：任何删除/覆盖前先备份或 rename 到 `~/.dsh/_quarantine/`、`_backups/`。**禁止**对配置/会话/工作区做不可逆删除。
7. **密钥红线**：`config.json`、`state/`、`~/.dsh` 里的 token 不进代码、不进日志、不进回复；输出前脱敏（`********`）。
8. **文档同步**：改了行为就改文档，并把「为什么」写进 `docs/PITFALLS.md` 或 `docs/ROADMAP.md`。不写的后果是下次的我完全不知道。
9. **小步提交**：一次一件事；提交信息写「现象 + 修法」，别写 update/fix。
10. **不确定就问**：涉及删除、发布、对外发送、改用户数据时停下来问用户，不要「先做了再说」。

## 2. 环境事实（省得重新摸一遍）

- 本机 DSH：`<DSH 安装目录>`，版本 `0.2.1-rc.5`；用户数据 `~/.dsh`。
- Web GUI / 网关：**端口会漂移**（见过 3080 / 48994 / 57981）。用 `discoverDshBaseUrl()` 或 `state/dsh-port.json`，**别硬编码**。
- 桥接控制台：`http://127.0.0.1:3100`（需要令牌；`consoleToken`）。
- SnowLuma：第三方专有运行时，**不随仓库分发、不打包**；本程序只探测、不部署（EULA §5.4）。
- 会话日志：`~/.dsh/sessions/<项目目录>/session-<id>/session.v4.jsonl.zstd`，zstd 压缩，别当文本读。
- 本机有 ACL 类沙箱报错时：需要 `danger-full-access` 会话，别硬试（见 `~/AGENTS.md`）。

## 3. 交付定义（Done 的标准）

代码 + 测试通过 + 文档更新 + 回滚路径 + 一句话「怎么验证」。缺一项都不算完成。

## 4. 现在最该知道的三件事

- **2026-10-22 事故**：一个「身份错位」的会话日志让 `workspace` 服务起不来，工作区全空、新建报 `workspaceController unavailable`。
  处置：坏文件整目录隔离 + 给 `app.asar` 打了字节级护栏补丁（`scripts/patch-dsh-session-guard.mjs`，坏文件只跳过不炸服务）。
  ⚠️ **DSH 一升级就会覆盖 `app.asar`，补丁消失** → 升级后第一件事 `npm run guard:check`。
- 旧工作区清理逻辑已从「`fs.rmSync` 硬删除」改成「rename 到 `~/.dsh/_quarantine/`」，可回滚。
- 详细踩坑见 [`docs/PITFALLS.md`](docs/PITFALLS.md)；风险台账见 [`docs/RISK_REGISTER.md`](docs/RISK_REGISTER.md)。
