// 生活参数 × B站 消费者接线回归（完全离线：不联网、不读真实 ~/.dsh、不跑真实 bili CLI）。
//
// 覆盖 IMPL-SPEC §5.2 / task-4 的 B站 侧断言：
//   1) life-runtime 纯函数：reconcile 保留当天已用次数/旧 slots；minGap、下次计划时间。
//   2) tools/lib/config.mjs：config() 返回前叠加 sidecar 覆盖值（不依赖基础文件 mtime），
//      返回副本不可污染缓存。
//   3) whale-night.mjs（真实 planner 子进程，只读/写临时 fixture 文件）：
//      overlay 生效、采用回执写进 whale-night.json 的 lifeSettings、
//      降低每日上限不抹掉已用次数/旧计划、cap=0 不回落到 12。
//   4) scheduler.js：revision 变化才触发 `night plan` 重排（用 stub 脚本，不真跑 bili CLI）；
//      每次 tick 发布 bili 运行时证据且节流（变更加急 / 45s 心跳）；坏 sidecar 不打断 tick。
//   5) 唤醒 prompt 尾部 append compactLifeState 状态板（不改静态前缀）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
// 夹具全部落在系统临时目录：绝不读写真实 ~/.dsh 或真实仓库 config/state。
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-life-bili-wiring-'))
const root = path.join(temp, 'isolated-root')
const dshHome = path.join(temp, 'isolated-dsh')
const isolatedProfile = path.join(temp, 'unrelated-profile')
const biliConfigFile = path.join(dshHome, 'surfcore', 'bili.config.json')
const stubLog = path.join(temp, 'stub-planner.log')
process.env.DSH_HOME = dshHome
process.env.USERPROFILE = isolatedProfile
process.env.HOME = isolatedProfile
process.env.SURFCORE_ROOT = root
process.env.DSH_NODE = process.execPath
process.env.SURFCORE_BILI_CONFIG = biliConfigFile
process.env.LIFE_STUB_LOG = stubLog
delete process.env.SURFCORE_QQBOT_ROOT

fs.mkdirSync(path.join(root, 'src'), { recursive: true })
fs.writeFileSync(path.join(root, 'src', 'bridge.js'), '// fixture only\n')
fs.writeFileSync(path.join(root, 'config.json'), '{}\n')
fs.mkdirSync(path.join(dshHome, 'surfcore'), { recursive: true })

const { scopePaths, emptyState, atomicWrite } = await import('../../../src/life-settings/file-store.js')
const paths = scopePaths()
assert.equal(paths.bili, biliConfigFile, 'DSH_HOME + SURFCORE_BILI_CONFIG 必须指向同一个 fixture 配置')
const stateFile = path.join(dshHome, 'surfcore', 'bili', 'whale-night.json')
const evidenceFile = path.join(dshHome, 'surfcore', 'life-runtime', 'bili.json')

const today = () => new Date().toLocaleDateString('sv-SE')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/** 写受管 sidecar（revision 单调递增，overrides 为 bili.* 覆盖值）。 */
function saveManaged(revision, overrides) {
  atomicWrite(paths.state, { ...emptyState(paths), revision, overrides })
}
function writeBiliConfig(value) {
  fs.mkdirSync(path.dirname(biliConfigFile), { recursive: true })
  fs.writeFileSync(biliConfigFile, JSON.stringify(value, null, 2) + '\n')
}

// ── 1. life-runtime 纯函数：保留已发生、不补跑错过窗口 ───────────────────────
{
  const fixedNow = new Date(2026, 10, 8, 12, 0)
  const {
    nightSettingsFingerprint, reconcileNightPlanState, nightNotBeforeMinute, plannedWakeTime,
  } = await import('../lib/life-runtime.js')
  const old = {
    date: fixedNow.toLocaleDateString('sv-SE'), wakes: 2, watchWakes: 1,
    wokeAt: new Date(2026, 10, 8, 11, 55).toISOString(),
    slots: [{ id: 'old-slot', status: 'fired' }], action: 'wake',
  }
  const replanned = reconcileNightPlanState(old, { windows: [{ start: '00:00', end: '24:00', wakes: 4 }], maxWakesPerDay: 3 }, { now: fixedNow, revision: 7 })
  assert.equal(replanned.wakes, 2, '重排不得抹掉当天已用次数')
  assert.equal(replanned.watchWakes, 1)
  assert.equal(replanned.slots, undefined, '新节奏重排时旧 slots 让位给新计划')
  assert.equal(replanned.scheduleChanges.at(-1).previousSlots[0].id, 'old-slot', '旧计划要留证而不是静默丢弃')
  assert.equal(replanned.scheduleChanges.at(-1).revision, 7)
  assert.equal(nightNotBeforeMinute(replanned, 20, fixedNow), 735, '距上次真实唤醒不足 minGap 时不得提前醒')
  const adopted = { ...old, scheduleSettingsFingerprint: nightSettingsFingerprint({ maxWakesPerDay: 3 }) }
  assert.deepEqual(
    reconcileNightPlanState(adopted, { maxWakesPerDay: 3 }, { now: fixedNow, revision: 8 }).slots,
    old.slots, '节奏没变时不能重掷当天计划',
  )
  assert.equal(plannedWakeTime({ date: old.date, action: 'wake', at: 1329.95 }, fixedNow),
    new Date(2026, 10, 8, 22, 10).toISOString(), '小数分钟 slot 归一到下一整分钟')
  assert.equal(plannedWakeTime({ date: '2000-01-01', action: 'wake', at: 100 }, fixedNow), null)
  console.log('✅ life-runtime：reconcile 保留已用次数/旧计划留证，minGap 与下次计划时间正确')
}

// ── 2. config()：受管 overlay 生效，且不依赖基础文件 mtime ───────────────────
writeBiliConfig({
  night: { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], maxWakesPerDay: 2, skipChance: 0.3, maxVideos: 3, minGapMin: 20 },
  listen: { comment: false, dm: false, live: false },
})
{
  const { config, configPath } = await import('../tools/lib/config.mjs')
  assert.equal(configPath, biliConfigFile)
  saveManaged(1, {
    'bili.night.windows': [{ start: '00:00', end: '24:00', wakes: 4 }],
    'bili.night.maxWakesPerDay': 4,
    'bili.night.maxVideos': 7,
    'bili.night.skipChance': 0,
    'bili.night.minGapMin': 1,
  })
  assert.equal(config().night.maxVideos, 7, 'sidecar 覆盖值必须叠加到 config()')
  assert.equal(config().night.maxWakesPerDay, 4, '受管值优先于 bili.config.json 的旧值')
  // 只改 sidecar、不碰基础文件：仍然要立即生效（受管 revision 独立于 mtime 缓存）。
  saveManaged(2, {
    'bili.night.windows': [{ start: '00:00', end: '24:00', wakes: 4 }],
    'bili.night.maxWakesPerDay': 4,
    'bili.night.maxVideos': 9,
    'bili.night.skipChance': 0,
    'bili.night.minGapMin': 1,
  })
  assert.equal(config().night.maxVideos, 9, 'sidecar 热读不能依赖基础文件 mtime')
  const clone = config()
  clone.night.maxVideos = 1
  assert.equal(config().night.maxVideos, 9, '调用方改返回副本不得污染缓存的基础配置')
  console.log('✅ config()：受管 overlay 生效（含热读），缓存不被调用方污染')
}

// ── 3. whale-night planner：overlay 采用回执 + 上限降低保留已用次数 ─────────
{
  const planner = path.join(repo, 'plugins', 'surfcore', 'tools', 'commands', 'whale-night.mjs')
  const plan = () => readJsonText(execFileSync(process.execPath, [planner, 'plan'], {
    env: process.env, encoding: 'utf8', cwd: temp,
  }))
  saveManaged(2, {
    'bili.night.windows': [{ start: '00:00', end: '24:00', wakes: 4 }],
    'bili.night.maxWakesPerDay': 4,
    'bili.night.maxVideos': 9,
    'bili.night.skipChance': 0,
    'bili.night.minGapMin': 1,
  })
  const first = plan()
  assert.equal(first.lifeSettings.revision, 2, 'planner 必须记录本次采用的受管 revision')
  assert.equal(first.lifeSettings.values['bili.night.maxWakesPerDay'], 4, '采用值要写进 lifeSettings.values')
  assert.equal(first.lifeSettings.values['bili.night.maxVideos'], 9)
  assert.equal(first.scheduleSettingsFingerprint, first.lifeSettings.fingerprint)
  assert.ok(first.lifeSettings.values && typeof first.lifeSettings.values === 'object', '采用回执要带 values 对象')

  // 当天已用 3 次后把上限降到 2：已用次数/看过次数必须保留，不能再复活 slot。
  atomicWrite(stateFile, {
    ...first, date: today(), wakes: 3, watchWakes: 2,
    wokeAt: new Date().toISOString(), scheduleSettingsFingerprint: 'previous-real-plan',
  })
  saveManaged(3, {
    'bili.night.windows': [{ start: '00:00', end: '24:00', wakes: 4 }],
    'bili.night.maxWakesPerDay': 2,
    'bili.night.maxVideos': 9,
    'bili.night.skipChance': 0,
    'bili.night.minGapMin': 1,
  })
  const reduced = plan()
  assert.equal(reduced.wakes, 3, '降低每日上限不得抹掉当天已用次数')
  assert.equal(reduced.watchWakes, 2)
  assert.equal(reduced.action, 'done', '已用次数超过新上限 → 今天不再排新唤醒')
  assert.equal((reduced.slots ?? []).length, 0, '降低上限不能复活更多唤醒机会')
  assert.ok(Array.isArray(reduced.scheduleChanges) && reduced.scheduleChanges.length > 0, '重排要留证')

  // 上限 0 是「今天不自动浏览」的合法值：不能被 `|| 12` 吞成 12。
  saveManaged(4, {
    'bili.night.windows': [{ start: '00:00', end: '24:00', wakes: 4 }],
    'bili.night.maxWakesPerDay': 0,
    'bili.night.maxVideos': 9,
    'bili.night.skipChance': 0,
    'bili.night.minGapMin': 1,
  })
  const zero = plan()
  assert.equal(zero.action, 'done', 'maxWakesPerDay=0 必须真的不醒（不能回落 12）')
  assert.match(String(zero.reason), /maxWakesPerDay=0/)
  console.log('✅ whale-night：overlay 采用回执落 lifeSettings；降 cap 保留已用次数；cap=0 不回落')
}

// ── 4. scheduler：revision 变化才重排 + 证据发布/节流 + 坏 sidecar 不抛 ──────
const stubPlanner = path.join(temp, 'stub-bili-planner.mjs')
fs.writeFileSync(stubPlanner, [
  "import fs from 'node:fs'",
  "const file = process.env.LIFE_STUB_LOG",
  "try { fs.appendFileSync(file, JSON.stringify({ args: process.argv.slice(2), dshHome: process.env.DSH_HOME ?? null }) + '\\n') } catch {}",
  "process.stdout.write('{\"ok\":true}\\n')",
].join('\n') + '\n')
const stubCalls = () => (fs.existsSync(stubLog)
  ? fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [])
const { startScheduler, createEvidencePump } = await import('../lib/scheduler.js')
const { plannedWakeTime } = await import('../lib/life-runtime.js')

function makeContext(prompts) {
  return {
    sessionController: {
      inspect: async () => ({ id: 'local-bili-wiring-fixture' }),
      create: async () => ({ id: 'local-bili-wiring-fixture' }),
      prompt: async (args) => { prompts.push(args); return { accepted: true } },
    },
  }
}
const schedulerOptions = (log) => ({
  dshHome,
  biliMjs: stubPlanner,
  cwd: root,
  sessionId: 'local-bili-wiring-fixture',
  log: (message) => log.push(String(message)),
})

// 证据节流器（纯函数）：revision 变化立即发；同 revision 至少隔 45s 心跳一次。
{
  const published = []
  let clock = 1000
  const pump = createEvidencePump({ publish: (snapshot) => published.push(snapshot), heartbeatMs: 45_000, now: () => clock })
  pump({ revision: 1 })
  clock += 10_000
  assert.equal(pump({ revision: 1 }), false, '同 revision 且未到心跳周期 → 不发')
  clock += 35_000
  assert.equal(pump({ revision: 1 }), true, '距上次发布 ≥45s → 发一次心跳')
  clock += 1_000
  assert.equal(pump({ revision: 5 }), true, 'revision 变化 → 立即发，不等心跳')
  assert.deepEqual(published.map((s) => s.revision), [1, 1, 5])
  console.log('✅ 证据节流器：变更加急 + 45s 心跳，水位只在成功后推进')
}

{
  // 受管 revision 6 的“已采用”状态：scheduler 读到的受管值来自 sidecar，采用回执来自计划状态文件。
  saveManaged(6, {
    'bili.night.windows': [{ start: '00:00', end: '24:00', wakes: 2 }],
    'bili.night.maxWakesPerDay': 1,
    'bili.night.maxVideos': 9,
    'bili.night.skipChance': 0,
    'bili.night.minGapMin': 1,
  })
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  const futureState = () => ({
    date: today(), action: 'wake', fired: false, done: false,
    at: (nowMin + 30) % 1440, atText: 'fixture-future', slotId: 's1', wakes: 0, watchWakes: 0,
    slots: [{ id: 's1', action: 'wake', status: 'pending', at: (nowMin + 30) % 1440, end: 1440, start: 0, window: 'fixture', kind: 'base' }],
    lifeSettings: {
      revision: 6, fingerprint: 'fixture-fingerprint', plannedAt: new Date().toISOString(),
      values: { 'bili.night.maxWakesPerDay': 1, 'bili.night.maxVideos': 9 },
    },
    scheduleSettingsFingerprint: 'fixture-fingerprint',
  })
  atomicWrite(stateFile, futureState())
  const log = []
  let scheduler = startScheduler(makeContext([]), schedulerOptions(log))
  try {
    await scheduler.tick()
    assert.equal(stubCalls().length, 1, '启动后首次 tick 必须触发一次 night plan 采用新 revision')
    assert.deepEqual(stubCalls()[0].args, ['night', 'plan'], '重排命令必须是 bili.mjs night plan')
    assert.equal(stubCalls()[0].dshHome, dshHome, '子进程必须继承同一个 DSH_HOME（否则会读另一份 sidecar）')
    const evidence = readJson(evidenceFile)
    assert.equal(evidence.details.mode, 'runtime', '真实进程证据必须是 mode:runtime')
    assert.equal(evidence.details.running, true)
    assert.equal(evidence.revision, 6, '证据 revision 来自计划里记录的“已采用” revision')
    assert.equal(evidence.values['bili.night.maxVideos'], 9, '证据要带消费者实际采用的值')
    assert.equal(typeof evidence.details.plannedAt, 'string')
    assert.equal(evidence.details.nextPlan, plannedWakeTime(futureState()), '证据要带下一次计划时间')
    const firstSnapshot = fs.readFileSync(evidenceFile, 'utf8')

    await scheduler.tick()
    assert.equal(stubCalls().length, 1, 'revision 未变时不得重复重排')
    assert.equal(fs.readFileSync(evidenceFile, 'utf8'), firstSnapshot, '45s 心跳窗口内不重复发布同 revision 证据')

    // revision 变化 → 立即重排（再 tick 一次），且状态里采用新 revision 后证据立即更新。
    saveManaged(7, {
      'bili.night.windows': [{ start: '00:00', end: '24:00', wakes: 2 }],
      'bili.night.maxWakesPerDay': 1,
      'bili.night.maxVideos': 10,
      'bili.night.skipChance': 0,
      'bili.night.minGapMin': 1,
    })
    await scheduler.tick()
    assert.equal(stubCalls().length, 2, '受管 revision 变化必须触发重排')
    const adopted = futureState()
    adopted.lifeSettings = { ...adopted.lifeSettings, revision: 7, values: { 'bili.night.maxWakesPerDay': 1, 'bili.night.maxVideos': 10 } }
    atomicWrite(stateFile, adopted)
    await scheduler.tick()
    const updated = readJson(evidenceFile)
    assert.equal(updated.revision, 7, '已采用的 revision 变化 → 证据立即发布（不等 45s 心跳）')
    assert.equal(updated.values['bili.night.maxVideos'], 10)

    // 坏 sidecar：fail-safe 读回最后一次成功值；tick 不抛、证据不假报。
    fs.writeFileSync(paths.state, '{ this is not json')
    await assert.doesNotReject(() => scheduler.tick(), '坏 sidecar 不得打断 B站 tick')
    assert.ok(scheduler.status().lastTickAt, '坏 sidecar 后 tick 仍要完成并记录时间')
    const { config } = await import('../tools/lib/config.mjs')
    assert.doesNotThrow(() => config(), '坏 sidecar 不得让 B站 config() 整条抛错')
    assert.equal(config().night.maxVideos, 10, '坏 sidecar 沿用最后一次成功读取的 overlay')

    // stop()：证据必须标成 running:false，避免死后仍被 verify 当作采用证据。
    scheduler.stop()
    const stopped = readJson(evidenceFile)
    assert.equal(stopped.details.running, false)
    console.log('✅ scheduler：revision 变化才重排；证据按 45s 节流且变更加急；坏 sidecar 不打断 tick')
  } finally {
    scheduler.stop()
  }
}

// ── 5. 唤醒 prompt：状态板 append 在尾部，不污染静态前缀 ─────────────────────
{
  saveManaged(7, {
    'bili.night.windows': [{ start: '00:00', end: '24:00', wakes: 2 }],
    'bili.night.maxWakesPerDay': 1,
    'bili.night.maxVideos': 10,
    'bili.night.skipChance': 0,
    'bili.night.minGapMin': 1,
  })
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  atomicWrite(stateFile, {
    date: today(), action: 'wake', fired: false, done: false,
    at: Math.min(1439, Math.max(0, nowMin)), atText: 'fixture-due', slotId: 'due', wakes: 0, watchWakes: 0,
    slots: [{ id: 'due', action: 'wake', status: 'pending', at: Math.min(1439, Math.max(0, nowMin)), end: 1440, start: 0, window: 'fixture', kind: 'base' }],
    lifeSettings: {
      revision: 7, fingerprint: 'fixture-fingerprint', plannedAt: new Date().toISOString(),
      values: { 'bili.night.maxWakesPerDay': 1, 'bili.night.maxVideos': 10 },
    },
    scheduleSettingsFingerprint: 'fixture-fingerprint',
  })
  const prompts = []
  const log = []
  const scheduler = startScheduler(makeContext(prompts), schedulerOptions(log))
  try {
    await scheduler.tick()
    assert.equal(prompts.length, 1, '到点的 wake slot 必须真的投递一次 prompt')
    const content = prompts[0].content
    assert.equal(content[0].type, 'text')
    assert.equal(String(content[0].text).includes('【生活状态｜系统事实】'), false, '状态板不得插入静态前缀')
    const last = content.at(-1)
    assert.equal(last.type, 'text')
    assert.match(String(last.text), /【生活状态｜系统事实】/, '状态板必须 append 到本次唤醒末尾')
    assert.match(String(last.text), /平台=bili/)
    assert.match(String(last.text), /设置=r7/, '状态板要带受管 revision 事实')
    assert.equal(readJson(stateFile).wakes, 1, '真实投递后当天唤醒次数 +1（失败才能重试）')
    console.log('✅ 唤醒 prompt：compactLifeState 状态板 append 在尾部，静态前缀逐字节不变')
  } finally {
    scheduler.stop()
  }
}

/**
 * whale-night 的 `plan` 把 JSON 打到 stdout（pretty-printed，后面可能跟别的输出行）；
 * 整段解析失败时再退化成「第一个 { 到最后一个 }」的切片。
 * @param {string} text
 */
function readJsonText(text) {
  const raw = String(text ?? '').trim()
  try { return JSON.parse(raw) } catch { /* fall through */ }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch { /* fall through */ }
  }
  throw new Error('whale-night plan 没有输出可解析的 JSON：' + raw.slice(0, 200))
}

console.log('\n✅ 生活参数 × B站 消费者接线（overlay/重排/证据/坏 sidecar/状态板）全部通过')
console.log('fixture:', temp)
