# 当前规模数字（自动生成）

> **不要手改**：本文件由 `npm run docs:numbers` 生成；`npm run test:doc-numbers` 会校验它与代码一致。
> 手写文档需要提到这些数字时，引用本文件而不是再抄一份（旧文档里已经漂过：3 个 MCP server / 15,000 行 / 47 个工具）。

| 指标 | 值 | 来源 |
| --- | --- | --- |
| 版本（根/插件） | 0.6.22 / 0.6.22 | `package.json × 2` |
| bridge.js 行数 | 17859 | `src/bridge.js` |
| qq_* MCP 工具数 | 49 | `src/mcp-snowluma-safe.js` |
| MCP server 数 | 4 | `host-server / snowluma-safe / stock-safe / web-search-safe` |
| restrict 名单条数 | 99 | `plugins/surfcore/qq-tool-restrict.mjs` |
| 「仅主人私聊」工具数 | 10 | `同上（OWNER_PRIVATE_TOOL_NAMES）` |
| 控制台页面数 | 10 | `public/console.html（consolePages）` |
| test:audit 脚本数 | 101 | `scripts/test-audit.mjs（tests[]）` |

重新生成：`node scripts/doc-numbers.mjs`；只校验：`node scripts/doc-numbers.mjs --check`。
