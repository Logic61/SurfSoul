// DSH 工具名抽取：**唯一实现**，供
//   · `scripts/scan-dsh-tool-names.mjs`（人工/升级时对账，打印清单）
//   · `scripts/test-preset-local-tools.mjs`（登记期断言，防拼错假名）
// 共同使用。
//
// 为什么要抽成模块：这两处过去各有一份实现，而测试那份是**模糊**的
// （`\bname:\s*['"]x['"]` 全文件乱扫 + 只认少数包名前缀 + 只读包根目录的
// cordis.patch.yml）。结果 0.2.0 对账时把 10 个**真实存在**的工具名误判成
// 「假名」——`dsh-mcp-resources` 与 `dsh-experimental-tool-agent-team` 不匹配它
// 的包名白名单，`subagent_codex` 写在 `dsh-web-app/presets/*.patch.yml` 而不是
// 包根。误判方向是危险的：它会逼人把真名字从守卫名单里删掉。
//
// 抽取规则（都要求**就近锚定**，不把 `systemPrompt.section({ name: 'tool:read' })`
// 这类非工具名当工具）：
//   ① `.register(defineTool({ … name: "X" … }))` —— DSH 所有工具包的注册形状
//   ② `toolName: "X"` / `toolName: z.string().default("X")` —— 配置化工具名
//      （dsh-tool-subagent 的 subagent / subagent_fork 就是这样声明的）
//   ③ YAML patch 里的 `toolName: X` 行（任意层级 *.patch.yml，含 presets/ 子目录）
import fs from 'node:fs';
import path from 'node:path';
import { dshAsarPath, dshModulesDir, readAsarHeader } from './dsh-modules.mjs';

/** 名字形态：小写字母开头，允许下划线与连字符，长度合理。 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{1,40}$/;

/** DSH 自带包所在目录（`<node_modules>/@deepseek-ai`）。 */
export function dshPackagesDir() {
  return process.env.DSH_TOOL_PACKAGES || path.join(dshModulesDir(), '@deepseek-ai');
}

/** 用户安装的第三方插件目录（也会注册工具：plugin-guard / 超级注入器等）。 */
export function dshPluginDirs() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : null);
  return [home ? path.join(home, 'plugins') : null].filter((p) => p && fs.existsSync(p));
}

function walkFiles(dir, out = [], depth = 0, maxDepth = 5) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < maxDepth) walkFiles(full, out, depth + 1, maxDepth); }
    else out.push(full);
  }
  return out;
}

/** 从一个 JS/TS 源文件里抽取工具名。 */
function extractFromSource(text, source, add) {
  for (const m of text.matchAll(/\.register\(\s*defineTool\(\{[\s\S]{0,400}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
  for (const m of text.matchAll(/\btoolName:\s*["']([^"']+)["']/g)) add(m[1], source);
  for (const m of text.matchAll(/\btoolName:\s*[^;\n]*?\.default\(\s*["']([^"']+)["']/g)) add(m[1], source);
  // 独立的一次性工具文件（defineTool 不挂在 .register( 上时的兜底）
  for (const m of text.matchAll(/defineTool\(\{[\s\S]{0,200}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
}

/** 从 YAML patch 里抽取配置化的工具名。 */
function extractFromPatch(text, source, add) {
  for (const m of text.matchAll(/^\s*(?:-\s*)?toolName:\s*([^\s#]+)\s*$/gm)) {
    add(m[1].replace(/^['"]|['"]$/g, ''), source);
  }
}

/** 按文件类型分派抽取：JS/TS 走源码规则，patch YAML 走配置规则。 */
function extractFromFile(filePath, text, source, add) {
  if (/\.(js|mjs|cjs)$/.test(filePath) || filePath.endsWith('.d.ts')) extractFromSource(text, source, add);
  else if (/\.patch\.ya?ml$/.test(filePath)) extractFromPatch(text, source, add);
}

const ASAR_TOOL_FILE_RE = /\.(?:js|mjs|cjs)$|\.d\.ts$|\.patch\.ya?ml$/;

/**
 * 从**运行中 DSH 的 app.asar** 里抽工具名（0.2.x 桌面版的真实包装位置）。
 *
 * 为什么不能只扫磁盘上的 node_modules：桌面版把 `@deepseek-ai/dsh-*` 全打进
 * `resources/app.asar`，磁盘上只有 npm 装的旧版本（本机实测 0.1.0-rc.6）。
 * 按旧版本对账会把 0.2.1 真实存在的工具误判成假名（见 PITFALLS #97）。
 *
 * 只读：打开 asar 读头，按条目 offset 读需要的小文件；`unpacked` 条目
 * （内容在 `app.asar.unpacked/`）跳过——工具注册代码不会放那里。
 */
function collectFromAsar(asarPath) {
  const names = new Map();
  const packages = [];
  const add = (name, source) => {
    if (!TOOL_NAME_RE.test(name)) return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(source);
  };
  const { json, dataStart } = readAsarHeader(asarPath);
  const root = json?.files?.dsh?.files?.node_modules?.files?.['@deepseek-ai'];
  if (!root) return { names, packages, asarPath, error: 'app.asar 里没有 /dsh/node_modules/@deepseek-ai' };

  const fd = fs.openSync(asarPath, 'r');
  try {
    const walk = (node, prefix) => {
      for (const [entryName, entry] of Object.entries(node.files ?? {})) {
        const full = `${prefix}/${entryName}`;
        if (entry.files) { walk(entry, full); continue; }
        if (!ASAR_TOOL_FILE_RE.test(full) || entry.link) continue;
        const offset = Number(entry.offset);
        const size = Number(entry.size);
        // unpacked 条目没有 offset（内容在 app.asar.unpacked），跳过。
        if (!Number.isFinite(offset) || !Number.isFinite(size)) continue;
        const pkg = full.split('/')[4];
        if (!pkg) continue;
        if (!packages.includes(pkg)) packages.push(pkg);
        let text = '';
        try {
          const buf = Buffer.alloc(size);
          fs.readSync(fd, buf, 0, size, dataStart + offset);
          text = buf.toString('utf8');
        } catch {
          continue;
        }
        extractFromFile(full, text, `asar:${pkg}`, add);
      }
    };
    walk(root, '/dsh/node_modules/@deepseek-ai');
  } finally {
    fs.closeSync(fd);
  }
  return { names, packages, asarPath };
}

function tryDshPackagesDir() {
  try { return dshPackagesDir(); } catch { return null; }
}

/**
 * 抽取已安装 DSH（及其插件）里出现的全部工具名。
 *
 * 优先级（2026-11-03 起）：
 *   ① 运行中的 Electron 桌面版 → 扫 `resources/app.asar`（0.2.x 的真实安装位置）；
 *   ② 显式传入 `packagesDir`，或找不到 app.asar（headless / npm 安装）→ 扫磁盘包目录；
 *   ③ 第三方插件目录始终扫（它们也可能 register 全局工具）。
 * ① 命中时**不再**扫 ② 的默认目录：混入旧版本会把新工具误判成假名。
 *
 * @param options.packagesDir - `@deepseek-ai` 目录；传了才扫（否则按 ①/② 规则）。
 * @param options.pluginDirs - 第三方插件目录列表；缺省按 {@link dshPluginDirs} 解析。
 * @param options.asar - 指定 app.asar 路径（测试/诊断用）；缺省按 {@link dshAsarPath}。
 * @returns `{ names: Map<name, Set<source>>, packages: string[], asarPath: string|null }`。
 *          `packages` 是实际扫过的包/插件名，便于诊断「一个都没扫到」。
 */
export function collectDshToolNames({ packagesDir, pluginDirs, asar: asarOverride } = {}) {
  const names = new Map();
  const packages = [];
  const add = (name, source) => {
    if (!TOOL_NAME_RE.test(name)) return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(source);
  };

  // ① 运行中的 Electron 版 DSH：优先 app.asar（0.2.x 桌面版真身）。
  let asarResult = null;
  if (!packagesDir) {
    const asarPath = asarOverride ?? dshAsarPath();
    if (asarPath) {
      try {
        asarResult = collectFromAsar(asarPath);
        for (const [name, sources] of asarResult.names) {
          if (!names.has(name)) names.set(name, new Set());
          for (const source of sources) names.get(name).add(source);
        }
        packages.push(...asarResult.packages);
      } catch {
        asarResult = null;
      }
    }
  }

  const roots = [];
  const pkgRoot = packagesDir ?? (asarResult ? null : tryDshPackagesDir());
  if (pkgRoot && fs.existsSync(pkgRoot)) roots.push({ dir: pkgRoot, filter: /^dsh-/ });
  for (const dir of pluginDirs ?? dshPluginDirs()) {
    // 用户的插件目录里全是插件包（含 .bak-* 备份，也一起扫：备份里的旧名字
    // 仍然说明这个名字曾经真实存在）。
    roots.push({ dir, filter: null });
  }

  for (const { dir, filter } of roots) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (filter && !filter.test(e.name)) continue;
      const pkgDir = path.join(dir, e.name);
      packages.push(e.name);
      for (const f of walkFiles(pkgDir)) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        extractFromFile(f, text, e.name, add);
      }
    }
  }
  return { names, packages, asarPath: asarResult?.asarPath ?? null };
}

/** 便利包装：只要名字集合。 */
export function dshToolNameSet(options) {
  return new Set(collectDshToolNames(options).names.keys());
}

/**
 * 「危险语义」判定：与本地执行 / 文件 / 进程 / 派生 agent / 宿主运行期相关的名字。
 * 守卫**必须**覆盖它们。纯模型侧无害工具由 {@link SAFE_MODEL_TOOLS} 显式排除。
 *
 * 这是**发现用**的启发式（宁可多报，人工再判），不是安全边界本身；
 * 边界是守卫的 restrict 名单 + 执行期白名单。
 */
export const DANGER_TOOL_RE = /(pwsh|bash|shell|exec|spawn|process|terminal|pty|read|write|edit|file|fs_|glob|grep|patch|str_replace|subagent|agent_|teammate|workflow|ralph|job|skill|present|goal|plan|todo|memory|snapshot|rollback|incident|plugin|cordis|dsh_|dev_|import|install|reload|inject|stage|config|workspace|session|export|office|slash|command|schedule|voice|speech|team|mcp_resource)/;

/** 明确无害、允许出现在仿真会话 schema 里的模型侧工具。 */
export const SAFE_MODEL_TOOLS = new Set(['ask_user_question', 'todo_write']);

/**
 * MCP server 提供的工具名（`mcp__<server>__<tool>`）：由各 MCP server 在运行时注册，
 * **不在 DSH 安装包里**，本抽取器永远扫不到。对账时应排除，否则会误报成假名。
 * 它们各自的白名单/边界由 MCP 侧测试负责（snowluma / browser / web-search）。
 */
export function isExternalMcpToolName(name) {
  return /^mcp__/.test(String(name ?? ''));
}

/**
 * 历史 / 可选 bundle 里出现过、但当前安装包里抽不到的工具名。
 *
 * 守卫保留它们是**零成本的纵深防御**（`tools.restrict` 对未知名字的报错被逐项
 * try/catch 吞掉，不会让整批失败），不是拼写错误；对账时放行，避免反过来逼人
 * 把安全网删掉。新增条目要写清来源。
 */
export const LEGACY_UNREGISTERED_TOOL_NAMES = new Set([
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved', // dsh-plugin-guard（web profile bundle）
  'subagent_claude_code', // DSH 0.1.x 自带 preset 里出现过；0.2.1 安装包未注册
]);
