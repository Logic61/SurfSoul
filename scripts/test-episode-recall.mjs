import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runNarration, loadNarrative, saveNarrative } from '../src/memcard-narrative.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('300 existing episodes survive a new, idempotent, single-conversation batch', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-growth-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const records = ['r1','r2','r3'].map((id,i) => ({id, text:'讨论如何保持聊天的连续性', scope:'qq',
    conversationKey:i===1?'group:8':'private:7', createdAt:'2026-01-01'}));
  fs.writeFileSync(path.join(dir,'memory-card.json'), JSON.stringify({records}));
  saveNarrative(dir,{episodes:Array.from({length:300}, (_,i)=>({id:'ep'+i,text:'旧经历',covers:['old'+i]}))});
  let calls=0;
  const complete=async ({user})=>{
    calls++;
    assert.ok(!user.includes('"r2"'));
    return {text:JSON.stringify([{title:'活人感',text:'我们说起活人感，希望我也会自己找话说。后来我想起昨天看的电影，就多聊了一会儿。',covers:['r1','r3']}])};
  };
  const options={memoryDir:dir, config:{minRecords:2},complete};
  assert.equal((await runNarration(options)).total,301);
  const episodes=loadNarrative(dir).episodes;
  assert.ok(episodes.some(ep=>ep.covers.includes('old0')));
  assert.equal(episodes.find(ep=>ep.covers.includes('r1')).sceneKey,'private:7');
  assert.equal((await runNarration(options)).skipped,'not-enough');
  assert.equal(calls,1);
});

test('QQ wake selects an older episode by paraphrase and rejects unrelated or out-of-scene memories', async () => {
  const dir='dsh/surfcore/memory/';
  const records=[['p','private:7'],['g','group:8'],['g2','group:9']].map(([id,conversationKey])=>({id,conversationKey}));
  const episodes=[['正确旧事',['p']],['别群旧事',['g2']],['混合旧事',['p','g']],['缺失来源',['missing']]].map(([title,covers])=>({title,covers,text:'我们聊到活人感，希望我有自己的事情。',date:'2024-01-02'}));
  const h=await bridgeHarness({files:{
    [dir+'memory-card.json']:JSON.stringify({records}),
    [dir+'memory-card-narrative.json']:JSON.stringify({episodes}),
    [dir+'memory-card-prompt-qq.md']:'【记忆卡】\n## 我们一起经历过的\n- 旧版混合内容\n## 其他\n- 保留'
  }});
  try {
    function wake(key,text,reason){
      h.appendSocialV2Message(key,'用户',text,text,false,true,'m'+Math.random(),[],'7',[]);
      return h.buildWakePromptV2(key,reason);
    }
    const prompt=wake('private:7','怎么又说完就跑了','question');
    assert.match(prompt,/正确旧事/);
    assert.doesNotMatch(prompt,/别群旧事|混合旧事|缺失来源/);
    assert.doesNotMatch(wake('group:8','怎么又说完就跑了','bootstrap'),/正确旧事|别群旧事|混合旧事|旧版混合内容|缺失来源/);
    assert.doesNotMatch(wake('private:7','今天吃什么','question'),/相关经历·摘要/);
  } finally {await h.close();}
});


test('new turns use the speaker target, relevant sticker metadata and the current request', async () => {
  const rows = [
    {no:12, emotion:'speechless',content:'头顶铁锅，适合背锅、被甩锅、一脸无辜的时候',keywords:['背锅','被甩锅','铁锅']},
    {no:19, emotion:'wronged',content:'投降，适合认怂、放弃抵抗',keywords:['认怂','投降','放弃抵抗']},
  ].map(r=>({...r,id:'fixture-'+r.no,resId:'fixture-'+r.no}));
  const h=await bridgeHarness({files:{'state/stickers.json':rows},config:{socialV2:{sticker:{match:{minScore:0.6,topK:2}}}}});
  try {
    const key='private:123';
    const wake = (msg,keyArg=key,media=[]) => {
      h.appendSocialV2Message(keyArg,'伙伴',msg,msg,false,false,'f'+Math.random(),media,'7',[]);
      return h.buildWakePromptV2(keyArg,'question').split('【表情匹配】')[1]?.split('（qq_send_sticker）')[0] || '';
    };
    assert.match(wake('这口锅归你了'),/#12/);
    assert.match(wake('抓包，你又偷吃了'),/#19/);
    assert.equal(wake('换个事，帮我确认集合时间'), '');
    assert.equal(wake('[图片]',key,[{kind:'image',file:'x'}]), '');
    assert.doesNotMatch(wake('抓包，你又偷吃了','group:456'),/#19/);
  } finally {await h.close();}
});
