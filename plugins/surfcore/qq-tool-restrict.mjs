// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
// 本文件是 surfcore bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 两个
// agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

import fs from 'node:fs'
import path from 'node:path'
import {
  LOCAL_EXECUTION_TOOL_NAMES,
  isOwnerPrivateKey,
  readOwnerKey,
  resolveSurfcoreRoot,
  resolveTurnContext,
  sessionIdCandidates,
} from './lib/turn-trigger.js'

// ⚠️ 归因/配置读取已抽到 `lib/turn-trigger.js`（与 qq-owner-approval 审批行共用同一份
// 实现）：仓库根探测、`config.json` 的 `socialV2.toolApproval`、`state/turn-triggers.json`
// 的只读消费都在那边。这里只保留「守卫语义」本身。
//
// 两个历史坑仍然适用（保留原文以免下次重新踩）：
//   · 仓库根**不能**只按模块 URL 推：插件也可能被解析成 `~/.dsh/plugins/surfcore/…`，
//     那里的 `../..` 是 `~/.dsh/plugins`（没有 config.json）——2026-10-29 就因此把
//     key/ownerKey 读成空串，本地工具被锁死。lib 里按「config.json + state/ 都存在」探测。
//   · `state/sessions.json` 可能带 BOM（PowerShell -Encoding utf8 写的），lib 里统一剥 BOM。

/**
 * 本地工具被拒时留一条现场记录，方便回查「为什么明明在私聊里还是说不在授权范围」。
 *
 * 2026-10-29 的那次拒绝只告诉我们「当前会话 未知」，而会话 id / 仓库根到底取到了什么
 * 谁也不知道，只能靠猜。这里把候选 id、agent 有没有、仓库根、读到的归因都写下来。
 * 上限 200 行，超过就不再写——这是个诊断文件，不是日志系统。
 */
function debugLocalDeny(exec, candidates, turn, reason) {
  try {
    const root = resolveSurfcoreRoot()
    const file = path.join(root, 'state', 'guard-debug.log')
    let size = 0
    try { size = fs.statSync(file).size } catch {}
    if (size > 200 * 1024) return
    const agent = exec?.agent
    const line = JSON.stringify({
      at: new Date().toISOString(),
      name: exec?.name,
      reason,
      root,
      candidates,
      key: turn?.key ?? '',
      mode: turn?.mode ?? '',
      turnActive: turn?.turnActive === true,
      isValidOwnerTurn: turn?.isValidOwnerTurn === true,
      toolApprovalEnabled: turn?.toolApprovalEnabled === true,
      hasAgent: Boolean(agent),
      agentKeys: agent && typeof agent === 'object' ? Object.keys(agent).slice(0, 20) : [],
      sessionKeys: agent?.session && typeof agent.session === 'object' ? Object.keys(agent.session).slice(0, 20) : [],
    })
    fs.appendFileSync(file, `${line}\n`, 'utf8')
  } catch {}
}

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 QQ 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，QQ preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `subagent_claude_code`（Claude Code 子智能体）
 *      · `subagent_codex`（Codex 子智能体）：**2026-11-01 起改由下面的「主人私聊白名单」
 *        放行**（主人要求 QQ 里能调 Codex 生成图片）。它仍然会 spawn 独立进程、在子会话
 *        工作区里读写文件，因此按 `pwsh`/`read`/`write` 同一档处理：schema 里可见，
 *        执行期逐次鉴权，只有 `private:<ownerQQ>` 能调，其它场合 fail-closed。
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 */
// ── 本地工具：只给「主人在私聊里、或主人本人触发的回合里」的会话 ─────────────────
// 需求原话（2026-10-29）：「给他 access 我电脑的权限」「权限限制好鉴权，仅当我私聊能调用」。
// 2026-11-06 用户拍板放开场景（design.md §0/§1.4）：群聊/别人私聊里，只要**本回合的触发
// 消息来自 ownerQQ 本人**，该回合临时拥有这些能力，且每次调用还要过 qq-owner-approval
// 行的模型审批。硬边界仍是「真实 sender 归因 + 白名单 + 本 guard」。
// 做法：
//   · 这些工具**不**进 restrict 名单（否则模型 schema 里看不到），
//   · 执行期逐次鉴权（两条放行路径，其它一律 fail-closed）：
//       ① 会话 key === `private:<ownerQQ>`（读 state/sessions.json 映射；旧行为）；
//       ② mode==='reserved2' && socialV2.toolApproval.enabled &&
//          `state/turn-triggers.json` 记录 turnActive && trigger.isOwner && 未过窗口
//          （新路径；模型审批由 qq-owner-approval 行负责，本 guard 只做硬边界）。
//   · 映射/归因拿不到（会话没建好、文件读失败、文件缺失）一律**拒绝**——fail-closed。
//   · 名单本身维护在 lib/turn-trigger.js（审批行与 guard 共用一份，避免漂移）；
//     导出名 OWNER_PRIVATE_TOOL_NAMES 保持不变——测试/文档/verify 脚本都按它对账。
export const OWNER_PRIVATE_TOOL_NAMES = LOCAL_EXECUTION_TOOL_NAMES
const LOCAL_OWNER_ONLY_TOOLS = new Set(OWNER_PRIVATE_TOOL_NAMES)

/** 模型 schema 里要隐藏的工具：真的危险、且不该给她留一口子。 */
const LOCAL_EXECUTION_TOOLS = [
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  //   ② 派生 agent / 执行外部代码（`subagent_codex` 已于 2026-11-01 移入主人私聊白名单，
  //      不进 restrict，否则模型看不到它；只有 `subagent_claude_code` 仍整体隐藏）
  'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
  // ── DSH 0.2.1 新增工具（2026-11-03 从运行中的 app.asar 对账扫出来的）──────
  // 之前只按磁盘上的 npm 包（0.1.0-rc.6）对账，这一批名字根本没被看见。
  //   · dsh-tool-terminal：开/读/写本机终端 = 另一条 shell 路径 ⇒ 必须隐藏
  //   · dsh-plugin-market：插件市场（安装/卸载插件 = 任意代码执行）
  //   · dsh-tool-session-query：跨会话检索/读取会话日志 ⇒ QQ 群不应有这种可见性
  'terminal_open', 'terminal_close', 'terminal_list', 'terminal_read', 'terminal_send', 'terminal_signal',
  'plugin_market',
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
]

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
// （放在 BROWSER_BLOCKED_TOOL_NAMES 之后导出：const 有 TDZ，提前引用会直接 ReferenceError。）

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  // 股票行情（2026-10-29 加）：surfcore/src/mcp-stock-safe.js，只读公开行情，
  // 无 key、无账号、不落盘，所以整包放行。
  'mcp__stock__',
  // B站（2026-10-29 主人要求「B站都放开」）：搜索/视频详情/下载全放开。
  // 下载会往本机写文件，但写的是 browser MCP 自己的下载目录，仍然不碰仓库与凭据。
  'mcp__browser__bilibili_',
  // 小红书（同日「xhs 也放给她」）：搜索/笔记/评论/点赞/收藏/下载/账号笔记。
  'mcp__browser__xhs_',
]

/**
 * B站「只看」能力（2026-10-29 最早只放两个只读工具，后来主人要求全放开，
 * 现在由上面的前缀统一放行；这个集合保留给 SAFE_EXACT 做兜底，避免前缀规则被改坏时误伤）。
 */
const BILI_READ_TOOLS = new Set([
  'mcp__browser__bilibili_search',
  'mcp__browser__bilibili_video',
])

/**
 * browser MCP 里**不放**的工具：从 schema 隐藏，避免她看见却一调就撞白名单
 * （2026-10-29：实测她调 mcp__browser__bing_search 得到「不在 QQ 桥接白名单内」）。
 * 名单必须与 mcp_launcher 实际注册的工具名一致；多写的名字会被 restrict 跳过、
 * 只进一行汇总日志，不会让整批失败。
 *
 * 排除原则：能把整台 Chrome 的操作权递出去的（点击/输入/上传/看标签页），
 * 以及会在**第三方账号上产生动作**的其它平台（抖音/X/Reddit/知乎）。
 * B站与小红书按主人要求整体放行，不在此列。
 */
const BROWSER_BLOCKED_TOOL_NAMES = [
  // 浏览器控制（等于把手伸进主人的 Chrome）
  'mcp__browser__browser_snapshot',
  'mcp__browser__browser_read',
  'mcp__browser__browser_read_page',
  'mcp__browser__browser_click',
  'mcp__browser__browser_type',
  'mcp__browser__browser_press',
  'mcp__browser__browser_scroll',
  'mcp__browser__browser_select',
  'mcp__browser__browser_upload',
  'mcp__browser__browser_dialog',
  'mcp__browser__browser_tabs',
  'mcp__browser__browser_status',
  // 搜索引擎（她已有 mcp__web-search-safe__ 的安全通道）
  'mcp__browser__google_search',
  'mcp__browser__bing_search',
  'mcp__browser__sogou_search',
  // B站与小红书已按主人要求整体放行（前缀规则），这里不能再列，
  // 否则 restrict 会把它们从 schema 里藏掉、反而调不到。
  // 其它平台：点赞/收藏/发帖都是**在账号上做事**，不放
  'mcp__browser__douyin_search', 'mcp__browser__douyin_video', 'mcp__browser__douyin_comments',
  'mcp__browser__douyin_like', 'mcp__browser__douyin_collect', 'mcp__browser__douyin_download',
  'mcp__browser__x_search', 'mcp__browser__x_post',
  'mcp__browser__reddit_search', 'mcp__browser__reddit_post',
  'mcp__browser__zhihu_search', 'mcp__browser__zhihu_content', 'mcp__browser__zhihu_invitations',
  'mcp__browser__site_read_page', 'mcp__browser__site_login_status',
]

/**
 * 第三方插件运行期注册的全局工具（2026-10-30，路线 A）。
 *
 * 为什么单列、不塞进 KNOWN_DANGEROUS_GLOBAL_TOOLS：
 *   · 这些名字来自**用户自己装的插件**（这里是 `dsh-video-storyboard` 的
 *     video_storyboard / video_zoom / video_probe / video_locate），不随 DSH 安装包分发，
 *     `scripts/dsh-tool-names.mjs` 的安装包对账扫不到它们；
 *   · 放进 RESTRICTED_TOOL_NAMES 会让 `test-preset-local-tools.mjs` 的「拼错假名」断言失败
 *     （它只接受安装包里真实存在的名字），所以只在本文件的 apply() 里用，不导出。
 *   · 但它们会执行本机 ffmpeg / yt-dlp、读写缓存，属于**本地执行面**，QQ 仿真会话 schema
 *     里不该出现 → 照样 restrict；名字不存在时 restrict 抛错会被逐个跳过，安全。
 */
const PLUGIN_PROVIDED_GLOBAL_TOOLS = [
  'video_storyboard',
  'video_zoom',
  'video_probe',
  'video_locate',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
// 注意：PLUGIN_PROVIDED_GLOBAL_TOOLS 故意**不**导出（不在安装包里，对账会误报假名）。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS, ...BROWSER_BLOCKED_TOOL_NAMES])

/**
 * 梗记忆（dsh-memewiki v2）：2026-10-30 主人要求写进 QQ 会话工具白名单。
 *
 * 为什么可以放行：四个工具都只碰「公共梗词库」和插件自己的 `$DSH_HOME/memewiki/memory/`——
 *   · search_meme_wiki  只读本地 6668 条词库（online=true 时最多多一次 cnmeme.wiki 只读请求）；
 *   · meme_recall       只读本地梗记忆，返回候选，不注入、不发送；
 *   · meme_feedback / meme_remember 只写本插件的 social.json / episodes.jsonl（亲和度、内部梗）。
 * 没有 shell、没有任意文件读写、不碰 QQ 账号动作，与 `todo_write` 同为无害模型侧工具。
 *
 * 为什么**不**进 restrict 名单：两个名单语义不同——restrict 是「从 schema 隐藏」，
 * 而这些工具恰恰要留在 schema 里给模型用；执行期白名单才是开关。若误加进
 * RESTRICTED_TOOL_NAMES，模型看不见它，功能等于没装（还会与下面的放行自相矛盾）。
 *
 * 导出给 `scripts/test-preset-local-tools.mjs` 逐名断言「放行且不在 restrict 名单」，
 * 防止下次改守卫时只加名字忘了接线。
 */
export const MEMEWIKI_TOOL_NAMES = Object.freeze([
  'search_meme_wiki',
  'meme_recall',
  'meme_feedback',
  'meme_remember',
])
const MEMEWIKI_TOOLS = new Set(MEMEWIKI_TOOL_NAMES)

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
  ...BILI_READ_TOOLS,
])

export function apply(ctx) {
  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前 DSH 版本不存在的工具名会单独抛错并跳过，
  // 不会导致整批限制失败（restrict 的 unknown 校验是整批原子性的）。
  //
  // 口径（2026-09-27 实测 web profile 的全局层）：实际存在的全局工具只有
  // `dev_*`（注入器）与三个 MCP 命名空间的工具；`read`/`pwsh`/`subagent` 这类
  // 是**各 preset 行自己注册的 scoped 工具**，在 QQ preset 里根本没挂载，
  // 因此本名单主要防的是"别的 composition 把它们注册进全局层"这种回归，
  // 以及 MCP 之外的宿主工具（plugin-guard / cordis 检查工具等）。
  // 名字不存在时跳过（执行期白名单仍然兜底），但**只汇总一行**：
  // 以前每个工具打一行，DSH 启动时刷几百行日志，把真实告警淹没（2026-10-28 用户反馈）。
  const skipped = []
  const restrictNames = [...KNOWN_DANGEROUS_GLOBAL_TOOLS, ...PLUGIN_PROVIDED_GLOBAL_TOOLS, ...BROWSER_BLOCKED_TOOL_NAMES]
  for (const name of restrictNames) {
    try {
      ctx.tools.restrict({ deny: [name] })
    } catch (error) {
      skipped.push(name)
      if (skipped.length === 1) {
        // 只在第一次失败时记一条细节，便于排查"某个名字失效"
        console.error(`[qq-tool-restrict] restrict 跳过（示例）：${name} — ${error?.message ?? error}`)
      }
    }
  }
  if (skipped.length) {
    const list = skipped.length > 8 ? `${skipped.slice(0, 8).join(', ')} 等` : skipped.join(', ')
    console.error(`[qq-tool-restrict] 跳过 ${skipped.length}/${restrictNames.length} 个当前版本不存在的工具名：${list}（执行期白名单仍生效）`)
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    // 本地工具（shell / 文件 / Codex）：两条放行路径，其它一律 fail-closed。
    //   ① 新路径（design.md §3.4）：reserved2 + 开关开启 + 主人本人触发的回合。
    //      必须同时看 toolApprovalEnabled：回滚开关一关就回到旧的「仅主人私聊」。
    //   ② 旧路径：会话 key 就是 `private:<ownerQQ>`（读 sessions.json 映射）。
    // 归因/配置/映射的读盘都在 lib 里（mtime 缓存）；任何读失败都落到「无归因 → 拒绝」。
    if (LOCAL_OWNER_ONLY_TOOLS.has(name)) {
      const candidates = sessionIdCandidates(exec)
      const turn = resolveTurnContext(candidates)
      if (turn.isValidOwnerTurn && turn.toolApprovalEnabled) return
      if (isOwnerPrivateKey(turn.key, turn.ownerKey || readOwnerKey())) return
      debugLocalDeny(exec, candidates, turn, candidates.length ? 'not-authorized' : 'no-session-id')
      return `工具 "${name}" 是本地能力，只允许主人本人在私聊里、或主人本人触发的回合里使用（当前会话 ${turn.key || '未知'} 不在授权范围）`
    }
    if (SAFE_EXACT.has(name)) return
    // 第三方插件（dsh-memewiki v2）的模型侧工具：能读公共词库/只写自己的 memory，放行。
    if (MEMEWIKI_TOOLS.has(name)) return
    if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) return
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
  })
}
