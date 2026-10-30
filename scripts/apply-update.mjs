#!/usr/bin/env node
/**
 * 独立更新执行器：等 DSH 宿主退出后，再把新文件覆盖到目标目录。
 *
 * 为什么必须独立进程：SurfCore 插件跑在 DSH 宿主进程里，而"目标目录"就是宿主正在
 * 加载的模块目录（~/.dsh/plugins/surfcore → junction → 仓库根）。在进程内 cpSync 覆盖
 * 正在使用的模块，会让宿主直接终止（0xFFFF7003，无异常栈），更新也不会落地。
 * 所以下载/解压都在进程内做（安全），**覆盖动作交给这个脚本，在宿主退出后执行**。
 *
 * 用法（由 updates.js 生成参数）：
 *   node scripts/apply-update.mjs --pending ~/.dsh/surfcore/updates-pending.json
 *
 * pending.json（新形状，2026-10-30 起：一个文件可以装多个 job）：
 *   {
 *     "waitPid": 12345,
 *     "logFile": "…/apply-update.log",
 *     "createdAt": "2026-10-28T...",
 *     "jobs": [
 *       {
 *         "kind": "zip" | "git",
 *         "component": "surfcore",
 *         "target": "D:/surfcore",
 *         "staging": "…",       // zip 用
 *         "branch": "main",     // git 用
 *         "to": "0.6.11",
 *         "meta": { … }         // zip 用：写进目标的 .installed-meta.json
 *       },
 *       …
 *     ]
 *   }
 *
 * 旧单 job 形状（顶层直接有 kind/component/target/...，2026-10-30 之前写下的 pending）
 * 仍然支持：读入后归一成 `jobs: [job]`，和插件侧 updates.js 的归一化保持一致。
 *
 * 为什么宿主退出后要**重读** pending：用户一次勾选多个组件时，插件会先写第一份 pending、
 * 起本助手，然后**追加**其余 job。启动时的快照里只有第一个 job，必须退出后重读才能拿全。
 *
 * 结果 / 退出码：
 *   · 每个 job 成功 → <stateDir>/updates-applied/<ts>-<component>.json
 *   · job 失败     → <pendingFile>.failed 追加一条 {component,error,at}（允许累计多条）
 *   · 全部成功     → 删 pending + .started，退出码 0
 *   · 部分/全部失败 → pending 只保留失败的 job（下次启动只重试失败项）+ 退出码 4
 *   · 等宿主退出超时 → 3；找不到 pending → 2；异常 → 5
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ENVELOPE_KEYS = new Set(['waitPid', 'logFile', 'createdAt', 'resumedAt', 'jobs']);
const args = process.argv.slice(2);
const valueOf = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

/**
 * 兼容新旧 pending 形状。
 * ⚠️ 故意不 import 插件的 updates.js：本脚本是"更新失败后手动救场"的兜底，
 * 不能依赖正在被替换的插件代码；两边的归一化逻辑要保持一致（有测试锁）。
 */
function normalizePending(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const isEnvelope = Array.isArray(raw.jobs);
  const jobs = (isEnvelope ? raw.jobs : [raw])
    .filter((job) => job && typeof job === 'object' && !Array.isArray(job))
    .map((job) => (isEnvelope
      ? { ...job }
      : Object.fromEntries(Object.entries(job).filter(([key]) => !ENVELOPE_KEYS.has(key)))));
  if (!jobs.length) return null;
  return {
    waitPid: Number(raw.waitPid) || 0,
    logFile: typeof raw.logFile === 'string' ? raw.logFile : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    jobs,
  };
}

function readPending(file) {
  return normalizePending(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** 小 JSON（pending/.failed/应用记录）一律 tmp+rename，避免中途被 kill 留下半截文件。 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

const pendingFile = path.resolve(valueOf('pending'));
if (!fs.existsSync(pendingFile)) {
  console.error(`[apply-update] 找不到 pending 文件：${pendingFile}`);
  process.exit(2);
}

// 启动时的快照只用来取 waitPid / logFile（以及写"助手真的跑起来了"的 .started 标记）；
// 真正要执行的 jobs 必须在宿主退出后重读（启动后插件可能又追加了组件）。
let initial = null;
try { initial = readPending(pendingFile); } catch { initial = null; }
const logFile = initial?.logFile || path.join(path.dirname(pendingFile), 'apply-update.log');
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(logFile, line); } catch {}
  console.log(line.trim());
};

// 启动标记：插件侧 2.5 秒后检查它，确认"助手真的跑起来了"（Electron 没带 RUN_AS_NODE 时会静默退出）。
try { fs.writeFileSync(`${pendingFile}.started`, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitExit(pid, timeoutMs = 15 * 60_000) {
  if (!pid) return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!alive(pid)) return true;
    await sleep(800);
  }
  return false;
}

function copyZip(staging, target) {
  // robocopy 比 cpSync 可靠：能处理大量文件、失败会返回码。
  // /MIR 会删掉"源里没有"的文件（修掉旧版残留混杂），但必须排除运行数据 &
  // 用户配置，否则会把 state、config.json、node_modules 一起删掉。
  if (!target) return { ok: false, error: '缺少目标目录（target）' };
  if (!staging || !fs.existsSync(staging)) return { ok: false, error: `暂存目录不存在：${staging || '(空)'}` };
  const exDirs = ['state', 'backups', 'node_modules', '.git', 'logs', 'staging', 'pet', 'characters', 'voice-packs', 'tmp-update*'];
  const exFiles = ['config.json', 'bili.config.json', 'updates-pending.json'];
  const argv = [
    staging, target,
    '/MIR',
    '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1',
    '/XD', ...exDirs,
    '/XF', ...exFiles,
  ];
  try {
    execFileSync('robocopy', argv, { windowsHide: true, stdio: 'pipe', timeout: 10 * 60_000 });
    return { ok: true };
  } catch (error) {
    // robocopy: 0/1 成功，>=8 失败
    const code = Number(error?.status ?? -1);
    if (code >= 0 && code < 8) return { ok: true, code };
    const detail = `${error?.stdout || ''}${error?.stderr || ''}`.trim().slice(-500);
    return { ok: false, error: `robocopy 失败（exit ${code}）：${detail}` };
  }
}

function gitPull(target, branch) {
  if (!target) return { ok: false, error: '缺少目标目录（target）' };
  try {
    execFileSync('git', ['-C', target, 'fetch', '--prune', 'origin'], { windowsHide: true, stdio: 'pipe', timeout: 120_000 });
    execFileSync('git', ['-C', target, 'merge', '--ff-only', `origin/${branch || 'main'}`], { windowsHide: true, stdio: 'pipe', timeout: 120_000 });
    return { ok: true };
  } catch (error) {
    const detail = `${error?.stdout || ''}${error?.stderr || ''}`.trim().slice(-500);
    return { ok: false, error: `git 更新失败：${detail || String(error?.message ?? error)}` };
  }
}

/** 执行一个 job；保持旧语义：kind==='git' 走 git，其余按 zip 处理（旧 pending 兼容）。 */
function applyJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, error: 'job 形状非法' };
  if (job.kind === 'git') return gitPull(job.target, job.branch);
  return copyZip(job.staging, job.target);
}

/** 失败明细累积写到 <pending>.failed；兼容旧单条形状（顶层 component/error/at）。 */
function recordFailure(job, message) {
  const failedFile = `${pendingFile}.failed`;
  const nowIso = new Date().toISOString();
  let history = [];
  try {
    const old = JSON.parse(fs.readFileSync(failedFile, 'utf8'));
    if (old && typeof old === 'object' && Array.isArray(old.jobs)) history = old.jobs;
    else if (old && typeof old === 'object' && (old.component || old.error)) history = [{ component: old.component, error: old.error, at: old.at }];
  } catch {}
  history.push({
    component: String(job.component ?? ''),
    kind: String(job.kind ?? ''),
    target: String(job.target ?? ''),
    error: String(message ?? ''),
    at: nowIso,
  });
  writeJsonAtomic(failedFile, { updatedAt: nowIso, jobs: history });
}

/** 成功记录：updates-applied/<ts>-<component>.json（原有读者按这个目录找）。 */
function recordApplied(job) {
  try {
    const doneDir = path.join(path.dirname(pendingFile), 'updates-applied');
    fs.mkdirSync(doneDir, { recursive: true });
    const safeComponent = String(job.component || 'component').replace(/[^\w.-]+/g, '_');
    const stamp = `${Date.now()}-${safeComponent}`;
    writeJsonAtomic(path.join(doneDir, `${stamp}.json`), {
      component: job.component,
      kind: job.kind ?? '',
      target: job.target ?? '',
      to: job.to ?? '',
      at: new Date().toISOString(),
      ok: true,
    });
    return true;
  } catch (error) {
    log(`[apply-update] 写应用记录失败（${job.component}）：${String(error?.message ?? error)}`);
    return false;
  }
}

function writeInstalledMeta(job) {
  if (!job?.meta || !job.target) return;
  try {
    fs.writeFileSync(path.join(job.target, '.installed-meta.json'),
      `${JSON.stringify({ ...job.meta, at: new Date().toISOString() }, null, 2)}
`, 'utf8');
    log(`[apply-update] ${job.component}: 已写 .installed-meta.json`);
  } catch (e) { log(`[apply-update] ${job.component}: 写 meta 失败：${e.message}`); }
}

try {
  log(`[apply-update] 等待 DSH 退出（pid=${initial?.waitPid ?? '?'}）…`);
  const exited = await waitExit(initial?.waitPid);
  if (!exited) {
    log('[apply-update] 等超时（15 分钟宿主还没退出），放弃本次更新；可手动重试');
    process.exit(3);
  }

  // ⚠️ 必须重读：启动时快照只有第一个 job，多选更新时其余组件是在助手起来之后才追加的。
  if (!fs.existsSync(pendingFile)) {
    log('[apply-update] pending 已被处理（另一个助手接手或用户删除），无需执行');
    try { fs.rmSync(`${pendingFile}.started`, { force: true }); } catch {}
    process.exit(0);
  }
  let pending = null;
  try {
    pending = readPending(pendingFile);
  } catch (error) {
    log(`[apply-update] pending 文件解析失败，保留原文件不覆盖：${String(error?.message ?? error)}`);
    process.exit(5);
  }
  if (!pending) {
    log('[apply-update] pending 里没有可执行的更新项，无需执行');
    try { fs.rmSync(`${pendingFile}.started`, { force: true }); } catch {}
    process.exit(0);
  }

  const jobs = pending.jobs;
  log(`[apply-update] 宿主已退出，开始应用 ${jobs.length} 个更新：${jobs.map((job) => `${job.component}(${job.kind ?? '?'})`).join('、')}`);

  const failedJobs = [];
  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    const label = `${i + 1}/${jobs.length} ${job.component ?? '?'}（${job.kind ?? '?'} → ${job.target ?? '?'}）`;
    log(`[apply-update] [${label}] 开始`);
    const result = applyJob(job);
    if (!result.ok) {
      log(`[apply-update] [${label}] 失败：${result.error}`);
      try { recordFailure(job, result.error); } catch (e) { log(`[apply-update] [${label}] 写失败明细失败：${String(e?.message ?? e)}`); }
      failedJobs.push(job);
      continue;
    }
    writeInstalledMeta(job);
    recordApplied(job);
    if (job.kind !== 'git') {
      try { fs.rmSync(job.staging, { recursive: true, force: true }); } catch {}
    }
    log(`[apply-update] [${label}] 完成：${job.component} → v${job.to ?? '?'}`);
  }

  if (failedJobs.length) {
    // 失败的 job 留在 pending 里，下次启动 resumePendingApply 只重试这些；成功的不会再执行一遍。
    const remain = { ...pending, waitPid: process.pid, jobs: failedJobs, failedAt: new Date().toISOString() };
    try { writeJsonAtomic(pendingFile, remain); } catch (error) {
      log(`[apply-update] 回写待重试 pending 失败：${String(error?.message ?? error)}`);
    }
    log(`[apply-update] 部分失败（${failedJobs.length}/${jobs.length}）：${failedJobs.map((job) => job.component).join('、')}；pending 保留失败项，下次启动重试；明细见 ${pendingFile}.failed`);
    process.exit(4);
  }

  try { fs.rmSync(pendingFile, { force: true }); } catch {}
  try { fs.rmSync(`${pendingFile}.started`, { force: true }); } catch {}
  log(`[apply-update] 全部完成（${jobs.length} 个）`);
  process.exit(0);
} catch (error) {
  log(`[apply-update] 异常：${String(error?.message ?? error)}`);
  process.exit(5);
}
