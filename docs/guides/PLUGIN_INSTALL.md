# SurfCore DSH 插件包 —— 安装 / 卸载 / 回滚说明

> 本文件是**分发包内 `INSTALL.md` 的源文件**：`node scripts/build-plugin-package.mjs` 构建时会把本文件
> 复制为包根 `INSTALL.md`。仓库里改了安装流程，记得同步改这里再重新构建。

本文针对 **Layout B（整仓库即 npm 包）** 的 SurfCore fork 插件包：
一个自包含的 npm 包（包名 `surfcore`），装进任意 DSH profile 后，插件代码、preset、MCP server、
静态资源都在包内，**不再依赖 fork 仓库目录 + 仓库根 node_modules**。

- 包版本：`0.6.22`（fork，基于上游 surfcore v0.6.22 + 本地 56 个提交）
- 产物两种，任选其一：
  1. 目录：`dist/plugin/surfcore/`（未压缩的完整包，适合 `link:`/本地目录安装）
  2. 压缩包：`dist/plugin/surfcore-0.6.22-fork-plugin.tgz`（`npm pack` 产物，适合直接分发/一键安装）
- 包根布局（关键）：
  ```
  <包根>/package.json                      # name=surfcore，dsh.bundle.patch 指向 plugins/surfcore/*.yml
  <包根>/plugins/surfcore/                 # DSH 插件本体（lib/index.js、client.js、cordis.patch.yml、presets/…）
  <包根>/src/                              # QQ 桥接进程 + 4 个 MCP server + 共享模块
  <包根>/scripts/setup-plugin.mjs          # 安装后接线脚本（MCP 行 + 首次数据引导）
  <包根>/config.example.json               # 首次运行由 setup-plugin 复制成 config.json
  <包根>/state/  <包根>/roles/             # 运行期数据 / 人设卡（首次运行会创建/复用）
  ```

---

## 0. 构建产物（维护者在仓库里跑）

```bat
cd /d <仓库根>
node scripts/build-plugin-package.mjs        :: 默认输出到 dist/plugin/（已 gitignore）
:: 只构建目录不打包：node scripts/build-plugin-package.mjs --no-pack
:: 指定其他输出目录：node scripts/build-plugin-package.mjs --out D:\somewhere
```

产物：

- `dist/plugin/surfcore/` —— 完整包目录；
- `dist/plugin/surfcore-<版本>-fork-plugin.tgz` —— 分发用 tarball；
- `dist/plugin/build-manifest.json` —— 构建清单与自检结果（16 项自检全绿才算成功）。
- `dist/plugin/surfcore-<版本>-fork-plugin.tgz.sha256` —— 分发校验和（`Get-FileHash` / `sha256sum -c` 均可核对）。

> 构建脚本只读仓库、只写 `dist/plugin/`；不带 `--force` 时不会覆盖不是它生成过的目录。

## 0.1 前置条件

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10/11（本 fork 的 QQ 桥接/语音/桌宠只在 Windows 实测） |
| Node.js | **>= 22.13.0**（`package.json` engines；实测 22.23 / 24.x 均可） |
| DSH | DeepSeek Harness 0.2.x（本包按 0.2.2-rc.1 的 bundle/patch 机制验证）；`dsh.cmd` 在 PATH 里 |
| pnpm | DSH 的插件管理/`dsh plugin` 背后就是 pnpm，请保证 `pnpm` 可用（DSH 自带 runtime 里也有一份） |
| SnowLuma | **第三方外装、不包含在本包里**。只影响 QQ 相关功能；没有它 DSH 仍能加载插件，QQ 侧不可用 |
| 网络 | 用 `.tgz` 安装时，pnpm 需要能访问 npm registry 安装本包依赖（js-yaml、@snowluma/sdk、@modelcontextprotocol/sdk 等）。用本地目录 + 已 `npm install` 好的包可离线 |

> 不要用旧方案 `scripts/setup-dsh.mjs`（那是 Layout A：把 `plugins/surfcore` 子目录 junction 进
> `~/.dsh/plugins/surfcore`）。新旧两套不要同时注册到同一个 profile。

---

## 1. 安装（二选一）

### 方式 A：DSH 插件管理页 / `plugin_manager install_bundle`（推荐 tar 包）

1. 在 DSH 里打开插件管理，安装来源选「本地路径 / tarball」，target 填以下**绝对路径之一**：
   - `<仓库根>\dist\plugin\surfcore-0.6.22-fork-plugin.tgz`
   - 或目录：`<仓库根>\dist\plugin\surfcore`
2. 安装完成后，在终端执行接线脚本（把 `<profile>` 换成实际 profile 名，如 `desktop`）：
   ```bat
   node "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\surfcore\scripts\setup-plugin.mjs" --profile <profile>
   ```
   - 若装的是「目录」，把上面的包根换成你安装时用的那个目录绝对路径。
   - 先干跑检查：追加 `--check`，只报告不写文件。
3. 重启 DSH（或重载 profile），打开 SurfCore 设置窗口确认版本号与配置页正常。

### 方式 B：命令行（`dsh plugin`，等价于在 profile 目录跑 pnpm）

```bat
:: tarball（推荐；pnpm 会自动安装本包依赖）
dsh.cmd plugin --profile <profile> add file:<仓库根>\dist\plugin\surfcore-0.6.22-fork-plugin.tgz

:: 或目录（link: 依赖，不会自动装本包依赖，见下方「依赖安装」）
dsh.cmd plugin --profile <profile> add link:<仓库根>\dist\plugin\surfcore

:: 然后接线
node "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\surfcore\scripts\setup-plugin.mjs" --profile <profile>
```

`dsh plugin ... add` 会自动把声明了 `dsh.bundle` 的依赖加进 profile 的 `dsh.profile.bundles`；
若你手工改 profile 的 `package.json`，请确认 `dependencies.surfcore` 与 `dsh.profile.bundles` 里都有 `surfcore`，
并让 profile 的 `node_modules\surfcore` 指向包根（pnpm 会做这件事）。

### 依赖安装与 postinstall 审批（重要）

本包 `package.json` 带 `postinstall: node scripts/patch-snowluma-sdk.mjs`（修 @snowluma SDK 的 ESM 扩展名 bug）。

- **`.tgz` 安装**：pnpm 默认**不执行**依赖/包的 build 脚本，会把它记成 pending build。
  - 在插件管理页对 surfcore 点「允许构建 / Allow build」，然后重新安装/重载；**或**
  - 在 `<profile>/pnpm-workspace.yaml` 的 `allowBuilds:` 下加 `surfcore: true` 后重跑安装；**或**
  - 手动补跑：`node "<包根>\scripts\patch-snowluma-sdk.mjs"`（等价效果，之后重载 DSH）。
- **本地目录 / `link:` 安装**：pnpm 不会替你装依赖。先在该目录里执行一次：
  ```bat
  cd /d "<包根>"
  npm install
  ```
  这会装依赖并正常执行 `postinstall`（没有 pnpm 审批问题；网络需要可达 registry）。

### 装完必须做的事（setup-plugin.mjs）

`setup-plugin.mjs` 只做两件事，幂等、可重复跑、写前自动备份：

1. **MCP 接线**：在 `<profile>/cordis.patch.yml` 维护 4 个 MCP server 行，路径指向**本包内**的脚本：
   `mcp-snowluma → src/mcp-snowluma-safe.js`、`mcp-snowluma-host → src/mcp-host-server.js`、
   `mcp-web-search-safe → src/mcp-web-search-safe.js`、`mcp-stock-safe → src/mcp-stock-safe.js`；
   node 用运行脚本的 `process.execPath`，超时参数沿用旧安装器（725000 / 60000 ms）。
   写前把原文件备份成 `cordis.patch.yml.bak-<时间戳>`（保留最近 5 份）。
2. **首次数据引导**（仅当包根缺文件时）：
   - 包根无 `config.json` → 从 `config.example.json` 复制一份；
   - 确保包根 `state/`、`roles/` 目录存在；
   - `state/mode.json` 缺失 → 写入 `{"mode":"reserved2","closedAgentPreset":""}`。

常用参数：

```bat
node "<包根>\scripts\setup-plugin.mjs" --profile desktop          :: 正常执行
node "<包根>\scripts\setup-plugin.mjs" --profile desktop --check  :: 只报告（0=已就绪，2=需要做配置，1=错误）
node "<包根>\scripts\setup-plugin.mjs" --profile <p> --link       :: 额外把 profile 依赖写成 link:<包根>（手工/开发安装用）
node "<包根>\scripts\setup-plugin.mjs" --profile <p> --no-bootstrap --no-mcp   :: 只做其中一半
```
默认 profile 解析顺序：`--profile` → 环境变量 `DSH_PROFILE` → 自动探测正在运行的 DSH → 兜底 `web`。
脚本**不会启动/重启 DSH，也不会碰其它 profile**。

### 首次启动后的最小验收

1. DSH 插件列表里 surfcore 为启用状态，版本 `0.6.22`；
2. 打开 SurfCore 设置窗口，各分页能加载（配置 API 通）；
3. 若用 QQ：启动 SnowLuma，并在设置窗口里配置 SnowLuma 目录/端口；
4. `%USERPROFILE%\.dsh\surfcore\plugin.log` 出现 `已激活 v0.6.22` 且 `surfcore=<包根>` 指向新包。

---

## 2. 数据目录（务必先读）

路径逻辑（`plugins/surfcore/lib/paths.js`）按以下优先级确定「桥接数据根」`QQBOT_ROOT`：

1. 环境变量 `SURFCORE_ROOT` / `SURFCORE_QQBOT_ROOT`（显式覆盖，优先级最高）
2. 包根（`<包根>/plugins/surfcore/lib` 往上两级）——当它有 `config.json` + `src/bridge.js` 时
3. 兜底仍是包根

因此**默认数据（config.json、state/、roles/、audio/）在包目录内**：

- `.tgz` 安装：包目录在 `<profile>/node_modules/...` 的安装位置里，**升级/重装会替换包目录 → 数据会丢**；
  长期使用建议设置用户级环境变量 `SURFCORE_ROOT=D:\SurfCoreData`（DSH 和 QQ 桥接进程都能读到），
  并手动把 `config.json`、`state\`、`roles\`、`audio\` 迁到该目录，然后重跑 `setup-plugin.mjs`（它会继续维护包内的 MCP 行；
  数据引导只补缺失文件，不会覆盖你迁走的数据）。
- 本地目录 / `link:` 安装：包目录就是你指定的稳定目录，数据随包目录持久（升级时用新包覆盖代码、保留数据文件）。

插件自身还有一份 DSH 侧状态在 `%USERPROFILE%\.dsh\surfcore\`（配置历史、B站 cookie、记忆卡等），
它与包目录无关，卸载插件不会删它；确需清理时手动删除该目录。

---

## 3. 从旧安装（Layout A / setup-dsh.mjs）迁移

旧装法是：`~/.dsh/plugins/surfcore` junction → `<仓库>\plugins\surfcore`，profile 里 `"surfcore": "link:...\plugins\surfcore"`。
同一个 profile 里 `surfcore` 依赖只能有一个，请按顺序切换：

1. **备份**：整个 `<profile>` 目录（至少 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`）复制一份；
2. 卸载旧依赖：插件管理页移除 surfcore，或
   `dsh.cmd plugin --profile <profile> remove surfcore`；
3. 删除旧安装位 junction（**只删 junction，不删真实仓库**）：确认
   `%USERPROFILE%\.dsh\plugins\surfcore` 是 LinkType=Junction 且指向 `<旧仓库>\plugins\surfcore` 后再删；
   若它已被别的目录占用，改名保留备份即可；
4. 按本文第 1 节安装新包（tar 或目录），再跑 `setup-plugin.mjs --profile <profile>`；
5. **迁移数据**：把旧仓库根的 `config.json`、`state\`、`roles\`、`audio\` 复制到新包根（或 `SURFCORE_ROOT` 指向的目录），
   避免重新配置；
6. 重启 DSH，检查设置窗口与 MCP 工具（mcp__snowluma__* 等）是否正常。

> 旧仓库不要删：迁移期间它是唯一的数据/配置备份来源。

---

## 4. 卸载与回滚

**卸载**
```bat
dsh.cmd plugin --profile <profile> remove surfcore
```
或插件管理页移除 surfcore。然后（可选）：
- 恢复 `cordis.patch.yml`：把 `<profile>\cordis.patch.yml.bak-<最近时间戳>` 复制回去（setup-plugin 每次写前都备份）；
- 删除 `%USERPROFILE%\.dsh\surfcore\`（插件 DSH 侧状态）与包目录下的 `config.json/state/roles/audio`（如确定不要数据）。

**回滚到旧安装**
1. 用上面步骤卸载新包；
2. 恢复 profile 的 `package.json` / `cordis.patch.yml` 备份（或重跑旧仓库的 `node scripts/setup-dsh.mjs <profile>`）；
3. 把旧仓库的 junction 链恢复（`~/.dsh/plugins/surfcore` → 旧仓库 `plugins/surfcore`；
   `<profile>/node_modules/surfcore` → 上一级 link），重载 DSH。

**回滚到上一个版本的插件包**：`dsh.cmd plugin --profile <profile> add file:<上一个 tgz>`，重跑 `setup-plugin.mjs`。

---

## 5. 已知限制

1. **数据在包内**：默认 `config.json`、`state/`、`roles/`、`audio/` 在包根，`.tgz` 安装升级会丢；用 `SURFCORE_ROOT` 或 `link:` 安装规避（见第 2 节）。
2. **MCP 行需要接线脚本**：`plugin_manager`/`dsh plugin` 只负责装 bundle，不写 MCP server 行；必须跑一次 `setup-plugin.mjs`。
3. **postinstall 可能被 pnpm 拦截**：见「依赖安装与 postinstall 审批」。
4. **SnowLuma 是外装**：本包不含 SnowLuma 本体/浏览器扩展；QQ 群、B站登录等需要你在设置窗口自行配置。
5. **首次安装需要网络**（tgz 方式）：pnpm 要拉本包依赖。离线机器请用「目录 + 预先 `npm install` 的包」或内网 registry。
6. **Windows 优先**：插件里的语音/桌宠/路径处理按 Windows 实测；Linux/macOS 未验证。
7. **与旧 Layout A 不能并存于同一 profile**：`surfcore` 依赖名唯一，必须按第 3 节切换。
8. **本包未提交到 npm registry**：分发靠 `.tgz` 文件或目录路径，不提供 `pnpm add surfcore` 这种裸名安装。

---

## 6. 一键步骤（最短路径）

1. 在 DSH 插件管理页安装本地 target：`<仓库根>\dist\plugin\surfcore-0.6.22-fork-plugin.tgz`。
2. 若提示构建被忽略：在插件管理页允许 surfcore 的构建（或手动 `node "<包根>\scripts\patch-snowluma-sdk.mjs"`）。
3. 终端执行：`node "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\surfcore\scripts\setup-plugin.mjs" --profile <profile>`。
4. （QQ 用户）启动 SnowLuma，在 SurfCore 设置窗口配置路径/端口。
5. 重启 DSH，打开 SurfCore 设置窗口验收（建议长期用户先设置 `SURFCORE_ROOT` 再迁移数据，见第 2 节）。
