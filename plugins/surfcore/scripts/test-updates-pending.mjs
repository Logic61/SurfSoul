// 延迟应用（pending 队列）与版本号通道的回归：
//   · 没有 remote / 不是 git 仓库时，结果要进 pending（否则永远不弹更新提示）；
//   · apply() 对 version 通道要下载 zip 覆盖，而不是走 git fast-forward；
//   · 2026-10-30（审计 F3/P1-5）多选更新：多个组件必须进同一个 pending 的 jobs 数组，
//     不能后一个覆盖前一个；helper 在宿主退出后重读 pending、顺序执行全部 job；
//   · 旧单 job 形状的 pending（升级前写下的）读取时要能归一成 [job]（插件侧 + helper 侧）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createUpdatesService, normalizePendingPayload, resumePendingApply } from '../lib/updates.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-zip-upd-'));
const stateDir = path.join(dir, 'state');
fs.mkdirSync(stateDir, { recursive: true });
const pkgDir = path.join(dir, 'pkg');
fs.mkdirSync(pkgDir, { recursive: true });
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '0.4.6' }));

const realFetch = global.fetch;
global.fetch = async (url) => {
  const text = String(url);
  if (text.includes('/releases/latest')) return { ok: true, json: async () => ({ tag_name: 'v0.4.8', html_url: 'https://example.test/v0.4.8' }) };
  return { ok: false, json: async () => ({}) };
};

const svc = createUpdatesService({
  stateDir,
  components: () => [{ id: 'surfcore', name: 'SurfCore 本体', dir: pkgDir, kind: 'git', branch: 'main', versionRepo: 'Mieksido/surfcore' }],
  pluginLog: () => {},
});

await svc.check({ fetch: true });
const st = svc.status();
const row = (st.results ?? []).find((x) => x.id === 'surfcore');
assert.ok(row, '应该有 surfcore 这一行结果');
assert.equal(row.available, true, '没有 remote 也要能查（降级到版本号）');
assert.equal(row.latestVersion, '0.4.8');
assert.equal(row.updateAvailable, true);
assert.equal(st.pending.length, 1, '有新版时必须进 pending（决定是否弹窗）');
assert.equal(st.showPrompt, true, 'showPrompt 必须为 true');

// dismiss 之后不该再提示；换版本后重新提示
svc.dismiss();
assert.equal(svc.status().pending.length, 0, 'dismiss 后不再提示');
global.fetch = async (url) => {
  const text = String(url);
  if (text.includes('/releases/latest')) return { ok: true, json: async () => ({ tag_name: 'v0.5.0', html_url: 'https://example.test/v0.5.0' }) };
  return { ok: false, json: async () => ({}) };
};
await svc.check({ fetch: true });
assert.equal(svc.status().pending.length, 1, '远端再前进时应重新提示');

global.fetch = realFetch;
fs.rmSync(dir, { recursive: true, force: true });
console.log('✅ 版本号通道弹窗/更新判定通过');

// ═══════════════════════════════════════════════════════════════════════════════
// 2026-10-30（审计 F3/P1-5）：pending 升级成 jobs 队列，多组件不再互相覆盖
// ═══════════════════════════════════════════════════════════════════════════════
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-upd-jobs-'));
const helperPath = path.resolve('../../scripts/apply-update.mjs');
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** 造一个"落后远端一个提交"的组件仓库（本地提交与文件都不动，只让 origin/main 前进）。 */
function setupRepo(name) {
  const remote = path.join(base, `${name}.git`);
  const work = path.join(base, `${name}-work`);
  const author = path.join(base, `${name}-author`);
  git(['-c', 'init.defaultBranch=main', 'init', '--bare', remote], base);
  git(['clone', remote, work], base);
  git(['checkout', '-b', 'main'], work);
  fs.writeFileSync(path.join(work, 'README.md'), `# ${name}\n`);
  git(['add', '.'], work);
  git(['commit', '-m', 'init'], work);
  git(['push', '-u', 'origin', 'main'], work);
  git(['clone', remote, author], base);
  fs.writeFileSync(path.join(author, `${name}.txt`), 'remote ahead\n');
  git(['add', '.'], author);
  git(['commit', '-m', `feat: ${name}`], author);
  git(['push', 'origin', 'main'], author);
  return work;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function readApplied(statePath) {
  const doneDir = path.join(statePath, 'updates-applied');
  if (!fs.existsSync(doneDir)) return [];
  return fs.readdirSync(doneDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(doneDir, name)));
}

/** 跑 helper（等宿主退出那段用 waitPid=999999 直接跳过）。expectFail=true 时返回退出码。 */
function runHelper(pendingFile, { expectFail = false } = {}) {
  try {
    execFileSync(process.execPath, [helperPath, '--pending', pendingFile], { stdio: 'ignore' });
    if (expectFail) assert.fail('helper 应该以非 0 退出');
    return 0;
  } catch (error) {
    if (!expectFail) throw error;
    return Number(error?.status ?? 1);
  }
}

try {
  // 不联网：git 检查走本地远端；fetchRemoteVersion 的 GitHub 请求一律失败（返回空版本）
  global.fetch = async () => ({ ok: false, json: async () => ({}) });

  // ── 1. pending 归一化：旧单 job 形状 → jobs:[job]；新形状原样 ──────────────────
  {
    const legacy = normalizePendingPayload({
      kind: 'zip', component: 'surfcore', target: 'D:/t', staging: 'D:/s', to: '9.9.9',
      waitPid: 123, logFile: 'D:/apply-update.log', createdAt: '2026-10-29T00:00:00.000Z',
    });
    assert.equal(legacy.jobs.length, 1, '旧单 job 形状必须归一成 1 个 job');
    assert.equal(legacy.jobs[0].kind, 'zip');
    assert.equal(legacy.jobs[0].component, 'surfcore');
    assert.equal(legacy.waitPid, 123);
    assert.equal(legacy.logFile, 'D:/apply-update.log');
    assert.equal(legacy.jobs[0].waitPid, undefined, '信封字段（waitPid）不能留在 job 里');

    const envelope = normalizePendingPayload({
      waitPid: 7, logFile: 'L', createdAt: 'C',
      jobs: [{ kind: 'git', component: 'a' }, { kind: 'zip', component: 'b', staging: 'S' }],
    });
    assert.equal(envelope.jobs.length, 2);
    assert.equal(envelope.waitPid, 7);
    assert.equal(normalizePendingPayload(null), null);
    assert.equal(normalizePendingPayload({ jobs: [] }), null);
    console.log('✅ 旧单 job pending 归一化 / 新 jobs 队列解析');
  }

  // ── 2. 两个组件一起 apply：pending.jobs 必须是 2（修复前后者覆盖前者）──────────
  {
    const repoA = setupRepo('alpha');
    const repoB = setupRepo('beta');
    const stateDirTwo = path.join(base, 'state-two');
    fs.mkdirSync(stateDirTwo, { recursive: true });
    const svcTwo = createUpdatesService({
      stateDir: stateDirTwo,
      components: () => [
        { id: 'alpha', name: 'Alpha 组件', dir: repoA },
        { id: 'beta', name: 'Beta 组件', dir: repoB },
      ],
      blockedReason: () => '',
      pluginLog: () => {},
    });

    const checked = await svcTwo.check({ fetch: true });
    assert.equal(checked.pendingCount, 2, '两个组件都应判定为有待更新');

    process.env.SURFCORE_UPDATE_NO_SPAWN = '1'; // 测试里不起"等宿主退出"的进程
    let applied;
    try {
      applied = await svcTwo.apply(['alpha', 'beta']);
    } finally {
      delete process.env.SURFCORE_UPDATE_NO_SPAWN;
    }
    assert.equal(applied.ok, true, `两个组件都应排队成功（results=${JSON.stringify(applied.results)}）`);
    assert.equal(applied.updated, 2, '两个组件都算"已处理"');
    assert.equal(applied.results.filter((r) => r.ok && r.staged).length, 2, '两个组件都标记 staged');

    const pendingFile = path.join(stateDirTwo, 'updates-pending.json');
    assert.ok(fs.existsSync(pendingFile), 'pending 文件必须存在');
    const pending = readJson(pendingFile);
    assert.ok(Array.isArray(pending.jobs), 'pending 必须升级成 jobs 数组');
    assert.equal(pending.jobs.length, 2, '两个 job 都要保留（不能互相覆盖）');
    assert.equal(pending.waitPid, process.pid, 'waitPid 指向当前宿主');
    assert.ok(String(pending.logFile || '').endsWith('apply-update.log'), 'logFile 要有值');
    assert.ok(pending.createdAt, 'createdAt 要有值');
    assert.deepEqual(pending.jobs.map((job) => job.component), ['alpha', 'beta'], '顺序与勾选一致');
    assert.ok(pending.jobs.every((job) => job.kind === 'git'), '两个都是 git 通道');
    assert.equal(path.resolve(pending.jobs[0].target), path.resolve(repoA));
    assert.equal(path.resolve(pending.jobs[1].target), path.resolve(repoB));
    assert.ok(pending.jobs.every((job) => job.branch === 'main'), 'branch 要带上');
    // staged 后记 dismissed：重启前不再重复弹同一个提醒
    assert.equal(svcTwo.status().pendingCount, 0, 'staged 的两个组件都要记 dismissed');
    console.log('✅ apply([alpha,beta]) → pending.jobs.length === 2（不再丢组件）');
  }

  // ── 3. resumePendingApply：新旧形状都能重新排队，且保留所有 job ────────────────
  {
    const stateDirResume = path.join(base, 'state-resume');
    fs.mkdirSync(stateDirResume, { recursive: true });
    const pendingFile = path.join(stateDirResume, 'updates-pending.json');
    process.env.SURFCORE_UPDATE_NO_SPAWN = '1';
    try {
      // 旧单 job 形状（升级前写下的 pending）
      fs.writeFileSync(pendingFile, JSON.stringify({
        kind: 'git', component: 'legacy', target: 'D:/legacy', branch: 'main', to: '0.1.0',
        waitPid: 4242, logFile: 'D:/apply-update.log', createdAt: '2026-10-29T00:00:00.000Z',
      }, null, 2));
      assert.equal(resumePendingApply({ stateDir: stateDirResume, pluginLog: () => {} }), true, '旧单 job pending 应能重新排队');
      let requeued = readJson(pendingFile);
      assert.equal(requeued.jobs.length, 1, '旧单 job 归一成 1 个 job');
      assert.equal(requeued.jobs[0].component, 'legacy');
      assert.equal(requeued.jobs[0].waitPid, undefined, '信封字段不能进 job');
      assert.equal(requeued.waitPid, process.pid, '重排队后等当前宿主');
      assert.ok(requeued.resumedAt, '记录 resumedAt');

      // 新 jobs 形状
      fs.writeFileSync(pendingFile, JSON.stringify({
        waitPid: 1, logFile: 'L', createdAt: 'C',
        jobs: [{ kind: 'git', component: 'alpha' }, { kind: 'zip', component: 'beta', staging: 'S', target: 'T' }],
      }, null, 2));
      assert.equal(resumePendingApply({ stateDir: stateDirResume, pluginLog: () => {} }), true);
      requeued = readJson(pendingFile);
      assert.equal(requeued.jobs.length, 2, '重排队必须保留所有 job');
      assert.deepEqual(requeued.jobs.map((job) => job.component), ['alpha', 'beta']);
    } finally {
      delete process.env.SURFCORE_UPDATE_NO_SPAWN;
    }
    console.log('✅ resumePendingApply 兼容旧单 job / 保留全部 jobs');
  }

  // ── 4. helper：宿主退出后重读 pending，顺序执行全部 job ───────────────────────
  // 4a. 新形状两个 job 都成功：各自 applied 记录、pending 清理
  {
    const hbase = path.join(base, 'helper-multi');
    const stateDirH = path.join(hbase, 'state');
    fs.mkdirSync(stateDirH, { recursive: true });
    const jobs = [];
    for (const [index, component] of ['multi-a', 'multi-b'].entries()) {
      const staging = path.join(hbase, `stage-${component}`);
      const target = path.join(hbase, `target-${component}`);
      fs.mkdirSync(staging, { recursive: true });
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: component, version: `1.0.${index}` }));
      jobs.push({ kind: 'zip', component, target, staging, to: `1.0.${index}`, meta: { version: `1.0.${index}` } });
    }
    const pendingFile = path.join(stateDirH, 'updates-pending.json');
    fs.writeFileSync(pendingFile, JSON.stringify({
      waitPid: 999999, logFile: path.join(stateDirH, 'apply-update.log'), createdAt: new Date().toISOString(), jobs,
    }, null, 2));
    runHelper(pendingFile);
    for (const job of jobs) {
      assert.ok(fs.existsSync(path.join(job.target, 'package.json')), `${job.component} 应被应用`);
    }
    assert.equal(readJson(path.join(jobs[0].target, '.installed-meta.json')).version, '1.0.0', 'meta 写到目标目录');
    assert.equal(fs.existsSync(pendingFile), false, '全部成功后 pending 删除');
    assert.equal(fs.existsSync(`${pendingFile}.started`), false, '全部成功后 .started 清理');
    const records = readApplied(stateDirH);
    assert.equal(records.length, 2, '每个 job 各一条 updates-applied 记录');
    assert.deepEqual(records.map((record) => record.component).sort(), ['multi-a', 'multi-b']);
    console.log('✅ helper 多 job：顺序执行、逐 job applied 记录、pending 清理');
  }

  // 4b. 旧单 job 形状：helper 也能归一化并应用（向后兼容）
  {
    const hbase = path.join(base, 'helper-legacy');
    const stateDirH = path.join(hbase, 'state');
    const staging = path.join(hbase, 'stage');
    const target = path.join(hbase, 'target');
    fs.mkdirSync(stateDirH, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ version: '2.0.0' }));
    fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify({ keep: true }));
    const pendingFile = path.join(stateDirH, 'updates-pending.json');
    fs.writeFileSync(pendingFile, JSON.stringify({
      kind: 'zip', component: 'legacy', target, staging, to: '2.0.0',
      waitPid: 999999, logFile: path.join(stateDirH, 'apply-update.log'),
    }, null, 2));
    runHelper(pendingFile);
    assert.ok(fs.existsSync(path.join(target, 'package.json')), 'helper 应能应用旧单 job pending');
    assert.equal(fs.existsSync(path.join(target, 'config.json')), true, '用户 config.json 被保留');
    assert.equal(fs.existsSync(pendingFile), false, '成功后 pending 删除');
    const records = readApplied(stateDirH);
    assert.equal(records.length, 1);
    assert.equal(records[0].component, 'legacy');
    console.log('✅ helper 兼容旧单 job pending 形状');
  }

  // 4c. 部分失败：成功的落地、失败的留明细 + pending 只留失败项 + 非 0 退出
  {
    const hbase = path.join(base, 'helper-partial');
    const stateDirH = path.join(hbase, 'state');
    fs.mkdirSync(stateDirH, { recursive: true });
    const goodStaging = path.join(hbase, 'stage-good');
    const goodTarget = path.join(hbase, 'target-good');
    const badTarget = path.join(hbase, 'target-bad');
    fs.mkdirSync(goodStaging, { recursive: true });
    fs.mkdirSync(goodTarget, { recursive: true });
    fs.mkdirSync(badTarget, { recursive: true });
    fs.writeFileSync(path.join(goodStaging, 'package.json'), JSON.stringify({ version: '3.0.0' }));
    const missingStaging = path.join(hbase, 'missing-stage');
    const pendingFile = path.join(stateDirH, 'updates-pending.json');
    fs.writeFileSync(pendingFile, JSON.stringify({
      waitPid: 999999, logFile: path.join(stateDirH, 'apply-update.log'), createdAt: new Date().toISOString(),
      jobs: [
        { kind: 'zip', component: 'good-comp', target: goodTarget, staging: goodStaging, to: '3.0.0' },
        { kind: 'zip', component: 'bad-comp', target: badTarget, staging: missingStaging, to: '4.0.0' },
      ],
    }, null, 2));

    const code = runHelper(pendingFile, { expectFail: true });
    assert.notEqual(code, 0, '部分失败必须非 0 退出');
    assert.ok(fs.existsSync(path.join(goodTarget, 'package.json')), '成功的 job 要落地');
    assert.equal(readApplied(stateDirH).filter((record) => record.component === 'good-comp').length, 1, '成功项有 applied 记录');

    const failedFile = `${pendingFile}.failed`;
    assert.ok(fs.existsSync(failedFile), '失败要留下 .failed 明细');
    const failed = readJson(failedFile);
    assert.equal(failed.jobs.length, 1, '.failed 记录失败的 job');
    assert.equal(failed.jobs[0].component, 'bad-comp');
    assert.ok(failed.jobs[0].error, '.failed 要有 error');
    assert.ok(failed.jobs[0].at, '.failed 要有 at');

    const remain = readJson(pendingFile);
    assert.equal(remain.jobs.length, 1, 'pending 只保留失败项（成功的不再重跑）');
    assert.equal(remain.jobs[0].component, 'bad-comp');
    assert.equal(remain.jobs[0].staging, missingStaging, '失败 job 原样保留，下次可重试');
    console.log('✅ helper 部分失败：非 0 退出、.failed 明细、pending 只留失败项');
  }
} finally {
  global.fetch = realFetch;
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
}

console.log('\n✅ 延迟更新 pending 队列回归通过');
