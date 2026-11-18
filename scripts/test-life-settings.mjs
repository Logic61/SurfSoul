// 生活参数核心层回归（隔离 fixture；不读真实 ~/.dsh、不联网、不启动桥接/模型）。
// 从参考仓库 scripts/test-life-settings.mjs 搬并适配，额外覆盖 IMPL-SPEC §3 的本地增强：
// 跨午夜窗口拆分 / fail-safe overlay / plans-history 裁剪 / recoverStaleLock / 计划过期。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createManager, PLAN_RETENTION, HISTORY_RETENTION, OBSERVATION_RETENTION } from '../src/life-settings/manager.js';
import { scopePaths, emptyState, atomicWrite, readState, readJson, withStateLock, recoverStaleLock } from '../src/life-settings/file-store.js';
import { applyManagedSettings, extractManagedValues, publishRuntimeEvidence, readRuntimeEvidence, compactLifeState, settingsRevision } from '../src/life-settings/runtime.js';
import { splitCrossMidnightWindows } from '../src/life-settings/catalog.js';
import { writeDailyUsage } from '../src/token-budget.js';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'surfcore-life-core-'));
const root=path.join(temp,'root'), dshHome=path.join(temp,'home'), scope={root,dshHome};
fs.mkdirSync(root,{recursive:true});
const paths=scopePaths(scope), manager=createManager(scope);
atomicWrite(paths.qq,{socialV2:{proactive:{probability:0.3}},secretNeverExpose:'PRIVATE_SENTINEL',dsh:{authToken:'PRIVATE_SENTINEL'}});
const original=fs.readFileSync(paths.qq,'utf8');
let passed=0;
const test=async(name,run)=>{await run();passed++;console.log('PASS '+name);};
try {
  await test('state never claims configuration as adopted or exposes secrets',()=>{
    const state=manager.state();assert.ok(state.parameters.every((p)=>p.effectiveValue===null));
    assert.ok(!JSON.stringify(state).includes('PRIVATE_SENTINEL'));
    assert.equal(state.budget.officialBookedAmount,null);
  });
  await test('catalog discovery / description / protected writes',()=>{
    assert.ok(manager.catalog('群聊').parameters.some((p)=>p.id.startsWith('qq.')));
    assert.equal(manager.explain('qq.dsh.reasoningEffort').reason.includes('实际请求'),true);
    for(const patch of [
      {'qq.dsh.authToken':'secret'},{'qq.socialV2.tokenGuard.maxDailyCostCNY':999},
      {'__proto__.polluted':true},{'bili.agent.sandbox':'danger-full-access'},
      {'qq.socialV2.proactive.probability':NaN},{'qq.socialV2.proactive.probability':1.1},
      {'qq.socialV2.proactive.enabled':'true'},{'purpose.dailyMax':0},
    ])assert.throws(()=>manager.preview({patch,reason:'boundary test'}));
    assert.equal({}.polluted,undefined);
  });
  let plan,changed;
  await test('preview couples sleep range but does not apply or alter base',()=>{
    plan=manager.preview({patch:{'qq.socialV2.wake.recommendedSleepMinMs':10800000},reason:'想多独处一会'});
    assert.equal(plan.changes.find((c)=>c.id.endsWith('MaxMs')).after,10800000);
    assert.equal(manager.state().revision,0);
    assert.equal(readState(paths).overrides['qq.socialV2.wake.recommendedSleepMinMs'],undefined);
    assert.equal(fs.readFileSync(paths.qq,'utf8'),original);
  });
  await test('single atomic revision / idempotency / independent proof',()=>{
    changed=manager.apply(plan.id);
    assert.equal(changed.status,'saved-unverified');assert.equal(changed.revision,1);
    assert.equal(manager.apply(plan.id).status,'already-applied');
    assert.equal(manager.verify(changed.changeId).status,'saved-unverified');
    const adopted=applyManagedSettings({socialV2:{}},'qq',scope);
    publishRuntimeEvidence('qq',{revision:1,values:extractManagedValues(adopted,'qq'),details:{mode:'local-simulation'}},scope);
    assert.equal(manager.verify(changed.changeId).status,'runtime-adopted');
    assert.equal(manager.verify(changed.changeId).validationScope,'local-simulation');
    assert.equal(fs.readFileSync(paths.qq,'utf8'),original);
  });
  await test('old/dead/stopped/mismatched evidence is not adoption',()=>{
    const e=readJson(path.join(paths.runtime,'qq.json'),null);
    for(const patch of [
      {observedAt:new Date(Date.now()-1000000).toISOString()},
      {scopeId:'different-life'},{pid:2147483647},{details:{running:false}},
    ]) {
      atomicWrite(path.join(paths.runtime,'qq.json'),{...e,...patch});
      assert.equal(manager.verify(changed.changeId).status,'saved-unverified');
    }
    atomicWrite(path.join(paths.runtime,'qq.json'),{...e,revision:0});
    assert.equal(manager.verify(changed.changeId).checks[0].status,'pending-runtime-reload');
    atomicWrite(path.join(paths.runtime,'qq.json'),e);
  });
  await test('history, observation and rollback restore prior values',()=>{
    manager.observe({changeId:changed.changeId,text:'隔离计时器采用了更长时间，未发生平台活动',decision:'consider-revert'});
    const undo=manager.rollback({changeId:changed.changeId,reason:'恢复之前设置'});
    assert.equal(manager.state().revision,1);
    const reverted=manager.apply(undo.id);
    assert.equal(reverted.revision,2);
    assert.equal(readState(paths).overrides['qq.socialV2.wake.recommendedSleepMinMs'],300000);
    assert.equal(manager.history().observations[0].kind,'agent-reported-observation');
    assert.equal(manager.verify(changed.changeId).status,'superseded');
  });
  await test('approval cannot be self-granted or reused for changed plan',()=>{
    const p=manager.preview({patch:{'qq.socialV2.context.wakeMaxChars':8000},reason:'需要更多上下文'});
    assert.equal(p.status,'approval-required');
    assert.throws(()=>manager.apply(p.id),/APPROVAL_REQUIRED/);
    assert.throws(()=>manager.approve({planId:p.id,reason:'self',expectedRevision:2}),/OPERATOR_ONLY/);
    const operator=createManager(scope);
    // 本地改动：operator 改为显式传参，而不是 createManager({operator:true})。
    operator.approve({planId:p.id,reason:'批准此隔离测试计划',operator:true,expectedRevision:2});
    assert.equal(manager.apply(p.id).revision,3);
  });
  await test('expired plan is rejected even when revision is unchanged',()=>{
    const p=manager.preview({patch:{'qq.socialV2.proactive.idleThresholdMs':1200000},reason:'expiry test'});
    const s=readState(paths);
    s.plans.find((x)=>x.id===p.id).expiresAt=new Date(Date.now()-1000).toISOString();
    atomicWrite(paths.state,s);
    assert.throws(()=>manager.apply(p.id),/PLAN_EXPIRED/);
  });
  await test('stale plan and base-file changes rejected',()=>{
    const p=manager.preview({patch:{'purpose.enabled':false},reason:'conflict1'});
    const q=manager.preview({patch:{'qq.socialV2.proactive.enabled':false},reason:'conflict2'});
    manager.apply(q.id);
    assert.throws(()=>manager.apply(p.id),/CONFIG_CONFLICT/);
    const r=manager.preview({patch:{'purpose.enabled':false},reason:'base conflict'});
    atomicWrite(paths.qq,{...readJson(paths.qq,{}),humanUnrelatedChange:true});
    assert.throws(()=>manager.apply(r.id),/CONFIG_CONFLICT/);
    assert.equal(readJson(paths.qq,{}).humanUnrelatedChange,true);
  });
  await test('rollback refuses later same-field decision / locked precondition',()=>{
    const p=manager.preview({patch:{'qq.socialV2.proactive.probability':0.5},reason:'first'});
    const c=manager.apply(p.id);
    manager.apply(manager.preview({patch:{'qq.socialV2.proactive.probability':0.6},reason:'later'}).id);
    assert.throws(()=>manager.rollback({changeId:c.changeId,reason:'undo'}),/ROLLBACK_CONFLICT/);
    assert.throws(()=>manager.preview({patch:{'purpose.enabled':false},reason:'interleaved rollback',expectedRevision:0}),/ROLLBACK_CONFLICT/);
  });
  await test('Bili coupling rejects impossible global gaps and accepts inactive capacity',()=>{
    assert.throws(()=>manager.preview({patch:{
      'bili.night.windows':[{start:'20:00',end:'20:01',wakes:1},{start:'20:01',end:'20:02',wakes:1}],
      'bili.night.maxWakesPerDay':2,'bili.night.minGapMin':120,
    },reason:'impossible'}),/INFEASIBLE_GLOBAL_GAP/);
    assert.ok(manager.preview({patch:{'bili.night.windows':[{start:'20:00',end:'24:00',wakes:4}],'bili.night.maxWakesPerDay':1,'bili.night.minGapMin':120},reason:'capacity is not mandatory'}));
    const p=manager.preview({intent:'more-exploration',reason:'想增加浏览机会'});
    assert.equal(p.changes.find((c)=>c.id==='bili.night.windows').coupled,true);
    assert.throws(()=>manager.preview({patch:{'bili.night.windows':[]},reason:'empty'}),/INVALID_VALUE/);
  });
  await test('cross-midnight windows are split before storage (local addition)',()=>{
    assert.deepEqual(splitCrossMidnightWindows([{start:'22:00',end:'02:00',wakes:1}]).windows,[
      {start:'00:00',end:'02:00',wakes:1},{start:'22:00',end:'24:00',wakes:1},
    ]);
    assert.deepEqual(splitCrossMidnightWindows([{start:'22:00',end:'00:00',wakes:2}]).windows,[{start:'22:00',end:'24:00',wakes:2}]);
    assert.deepEqual(splitCrossMidnightWindows([{start:'20:00',end:'24:00',wakes:1}]).windows,[{start:'20:00',end:'24:00',wakes:1}]);
    assert.equal(splitCrossMidnightWindows([{start:'20:00',end:'24:00',wakes:1}]).split,false);
    const p=manager.preview({patch:{
      'bili.night.windows':[{start:'22:00',end:'02:00',wakes:1}],
      'bili.night.maxWakesPerDay':1,'bili.night.minGapMin':20,
    },reason:'把夜里跨午夜的时间段写进去'});
    const after=p.changes.find((c)=>c.id==='bili.night.windows').after;
    assert.deepEqual(after,[{start:'00:00',end:'02:00',wakes:1},{start:'22:00',end:'24:00',wakes:1}]);
    assert.ok(p.warnings.some((w)=>w.includes('跨午夜')));
    const c=manager.apply(p.id);
    assert.deepEqual(readState(paths).overrides['bili.night.windows'],after);
    // 存储层只接受拆分后的非重叠窗口：直接塞 wrap 会被 readState 判成非法，不静默接受。
    const s=readState(paths);
    const bad=structuredClone(s);
    bad.overrides['bili.night.windows']=[{start:'22:00',end:'02:00',wakes:1}];
    atomicWrite(paths.state,bad);
    assert.throws(()=>manager.state(),/INVALID_VALUE/);
    atomicWrite(paths.state,s);
    assert.equal(manager.state().revision,c.revision);
  });
  await test('interest dependencies are explicit, unknown topic weights rejected',()=>{
    assert.throws(()=>manager.preview({patch:{'bili.preferences.weights':{unknown:2}},reason:'weight'}),/UNKNOWN_INTEREST_WEIGHT/);
    const p=manager.preview({patch:{'bili.preferences.like':['编程'],'bili.preferences.keywords':['编程','猫'],'bili.preferences.weights':{'编程':2}},reason:'explicit preference'});
    assert.deepEqual(p.changes.find((c)=>c.id==='bili.preferences.keywords').after,['猫']);
  });
  await test('fresh budget is estimate only; stale usage is unknown',()=>{
    writeDailyUsage(paths.dir,{qq:{cost:2,tokens:1234}});
    const b=manager.state().budget;assert.equal(b.scopes.qq.remaining.estimatedCny,6);assert.equal(b.officialBookedAmount,null);
    assert.equal(b.latestCacheHitRate,null);
    const board=compactLifeState({platform:'qq',wakeReason:'local-test'},scope);
    assert.ok(board.includes('本地预算余量'));assert.ok(board.length<1100);
    writeDailyUsage(paths.dir,{qq:{cost:2}},{at:Date.now()-600000});
    assert.equal(manager.state().budget.scopes.qq.remaining,null);
  });
  await test('cross-process contention commits exactly one revision',async()=>{
    const p=manager.preview({patch:{'purpose.enabled':false},reason:'writer1'});
    const q=manager.preview({patch:{'qq.socialV2.proactive.probability':0.7},reason:'writer2'});
    const before=manager.state().revision;
    const moduleUrl=new URL('../src/life-settings/manager.js',import.meta.url).href;
    const code="import {createManager} from "+JSON.stringify(moduleUrl)+";try{createManager(JSON.parse(process.argv[1])).apply(process.argv[2]);process.exitCode=0;}catch{process.exitCode=2;}";
    const run=(id)=>new Promise((resolve)=>{
      const child=spawn(process.execPath,['--input-type=module','-e',code,JSON.stringify(scope),id],{stdio:'ignore',windowsHide:true});
      child.on('exit',(code)=>resolve(code));child.on('error',(e)=>{throw e;});
    });
    const outcomes=await Promise.all([run(p.id),run(q.id)]);
    assert.equal(outcomes.filter((x)=>x===0).length,1);assert.equal(manager.state().revision,before+1);
  });
  await test('plans, history and observations are capped on write (local addition)',()=>{
    const now=Date.now();
    const seeded=emptyState(paths);
    seeded.plans=Array.from({length:PLAN_RETENTION+10},(_,i)=>({
      id:'plan-seed-'+i,actor:'agent:surfcore',baseRevision:0,sourceFingerprint:'seed',
      createdAt:new Date(now-60000+i*1000).toISOString(),
      // 一半已应用、一半已过期：都算 settled，裁剪时优先清掉。
      expiresAt:new Date(now+600000).toISOString(),changes:[],warnings:[],
      approvalRequired:false,approval:null,restartRequired:false,evidenceBefore:{},
      ...(i%2?{}:{appliedRevision:1}),
    }));
    seeded.overrides={};
    seeded.history=Array.from({length:HISTORY_RETENTION+5},(_,i)=>({
      id:'change-seed-'+i,revision:0,previousRevision:0,actor:'agent:surfcore',
      createdAt:new Date(now+i).toISOString(),reason:'seed',experience:'',changes:[],
      beforeOverrides:{},afterOverrides:{},evidenceBefore:{},rollbackOf:null,planId:null,
      status:'saved-unverified',approval:null,
    }));
    seeded.observations=Array.from({length:OBSERVATION_RETENTION+5},(_,i)=>({
      id:'observation-seed-'+i,changeId:'change-seed-'+i,actor:'agent:surfcore',
      occurredAt:new Date(now+i).toISOString(),observedAt:new Date(now+i).toISOString(),
      text:'seed',decision:'undecided',evidenceRef:'',kind:'agent-reported-observation',systemVerification:{},
    }));
    atomicWrite(paths.state,seeded);
    const p=manager.preview({patch:{'purpose.pendingTtlDays':15},reason:'cap test'});
    const afterPreview=readState(paths);
    assert.ok(afterPreview.plans.length<=PLAN_RETENTION);
    assert.ok(afterPreview.plans.some((x)=>x.id===p.id));
    assert.ok(!afterPreview.plans.some((x)=>x.id==='plan-seed-0'));
    const c=manager.apply(p.id);
    const afterApply=readState(paths);
    assert.equal(afterApply.history.length,HISTORY_RETENTION);
    assert.equal(afterApply.history.at(-1).id,c.changeId);
    assert.equal(afterApply.history[0].id,'change-seed-'+(seeded.history.length+1-HISTORY_RETENTION));
    const observation=manager.observe({changeId:c.changeId,text:'裁剪测试的观察'});
    const afterObserve=readState(paths);
    assert.equal(afterObserve.observations.length,OBSERVATION_RETENTION);
    assert.equal(afterObserve.observations.at(-1).id,observation.id);
    assert.equal(afterObserve.observations[0].id,'observation-seed-'+(seeded.observations.length+1-OBSERVATION_RETENTION));
  });
  await test('recoverStaleLock only quarantines a provably dead owner (local addition)',()=>{
    assert.equal(recoverStaleLock(paths).reason,'no-lock');
    fs.mkdirSync(paths.lock,{recursive:true});
    fs.writeFileSync(path.join(paths.lock,'owner.json'),JSON.stringify({pid:999999999,createdAt:new Date().toISOString()}));
    const dead=recoverStaleLock(paths);
    assert.equal(dead.recovered,true);
    assert.ok(dead.quarantine.startsWith(paths.lock+'.abandoned-'));
    assert.equal(fs.existsSync(paths.lock),false);
    fs.rmSync(dead.quarantine,{recursive:true,force:true});
    fs.mkdirSync(paths.lock,{recursive:true});
    fs.writeFileSync(path.join(paths.lock,'owner.json'),JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));
    assert.equal(recoverStaleLock(paths).reason,'owner-alive');
    assert.equal(fs.existsSync(paths.lock),true);
    fs.rmSync(paths.lock,{recursive:true,force:true});
  });
  await test('runtime overlay fail-safe keeps last known overrides on corrupt sidecar (local addition)',()=>{
    const s=readState(paths);
    s.revision=5;
    s.overrides={'qq.socialV2.autoReplyCheckMs':45000};
    atomicWrite(paths.state,s);
    const warned=[];
    const opts={root,dshHome,warn:(message)=>warned.push(message)};
    assert.equal(applyManagedSettings({socialV2:{}},'qq',opts).socialV2.autoReplyCheckMs,45000);
    assert.equal(settingsRevision(opts),5);
    fs.writeFileSync(paths.state,'{broken');
    // 坏 sidecar 不抛给消费者：沿用最后一次成功的 overrides / revision。
    assert.equal(applyManagedSettings({socialV2:{}},'qq',opts).socialV2.autoReplyCheckMs,45000);
    assert.equal(settingsRevision(opts),5);
    assert.ok(warned.some((message)=>message.includes('life-settings.json')));
    const warningCount=warned.length;
    settingsRevision(opts);
    assert.equal(warned.length,warningCount,'同一个坏 state 只记一条 warn，不随 refresh 刷屏');
    // 坏证据 = 不可用证据，不抛错、不冒充采用。
    fs.mkdirSync(paths.runtime,{recursive:true});
    fs.writeFileSync(path.join(paths.runtime,'qq.json'),'{broken');
    assert.equal(readRuntimeEvidence('qq',opts).valid,false);
    assert.equal(readRuntimeEvidence('qq',opts).status,'unreadable');
    fs.rmSync(path.join(paths.runtime,'qq.json'),{force:true});
    // 修复后按新 mtime/size 重新读取，缓存失效。
    fs.rmSync(paths.state,{force:true});
    const repaired=emptyState(paths);
    repaired.revision=6;
    repaired.overrides={'qq.socialV2.autoReplyCheckMs':60000};
    atomicWrite(paths.state,repaired);
    assert.equal(applyManagedSettings({socialV2:{}},'qq',opts).socialV2.autoReplyCheckMs,60000);
    assert.equal(settingsRevision(opts),6);
  });
  await test('failure and abandoned lock preserve previous bytes',()=>{
    const before=fs.readFileSync(paths.state,'utf8');
    withStateLock(paths,()=>assert.throws(()=>manager.preview({patch:{'purpose.enabled':false},reason:'busy'}),/CONFIG_BUSY/));
    assert.equal(fs.readFileSync(paths.state,'utf8'),before);
    const backupPath=paths.backups;
    const quarantine=backupPath+'.test-quarantine';
    fs.renameSync(backupPath,quarantine);fs.writeFileSync(backupPath,'block backup directory');
    assert.throws(()=>manager.preview({patch:{'qq.socialV2.proactive.probability':0.8},reason:'disk failure'}));
    assert.equal(fs.readFileSync(paths.state,'utf8'),before);
    fs.unlinkSync(backupPath);fs.renameSync(quarantine,backupPath);
    fs.writeFileSync(paths.state,'{broken');
    assert.throws(()=>manager.state(),/CORRUPT_FILE/);
    assert.throws(()=>manager.preview({patch:{'purpose.enabled':false},reason:'corrupt'}),/CORRUPT_FILE/);
    assert.equal(fs.readFileSync(paths.state,'utf8'),'{broken');
  });
  console.log(passed+'/'+passed+' core settings scenarios passed');
}finally{
  // Only the absolute directory returned by mkdtempSync for this fixture.
  fs.rmSync(temp,{recursive:true,force:true});
}
