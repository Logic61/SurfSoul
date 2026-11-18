import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createConversationMemory } from '../src/conversation-memory.js';
import { createEpisodeRecall } from '../src/episode-recall.js';
import { resolveMemoryCardPaths } from '../src/memory-card.js';

test('真实唤醒构造：改口、历史、群友玩笑、待续和关闭',async()=>{
 const h=await bridgeHarness({config:{ownerQQ:7},files:{'dsh/surfcore/style-notes.md':'- 2026-10-29 叫他「羽」或者「主人」，不要叫「管理员」。'}});
 try{
  let seq=0;
  function say(key,text,id,owner){
   h.appendSocialV2Message(key,'测试',text,text,false,owner,String(++seq),[],String(id),[]);
   return h.buildWakePromptV2(key,'question');
  }
  assert.match(say('private:7','你好呀',7,true),/当前称呼：羽或主人/);
  say('private:7','以后叫我小羽',7,true);
  assert.match(say('private:7','今后就喊我阿棠吧',7,true),/当前称呼：阿棠/);
  assert.doesNotMatch(say('group:8','以后叫我小王',9,false),/当前称呼：/);
  const history=say('private:7','以前让你怎么叫我来着？',7,true);
  assert.match(history,/当前称呼：阿棠/);assert.match(history,/以后叫我小羽.*QQ 消息 2/);assert.match(history,/早期语感笔记/);
  assert.match(say('private:7','以后回复简短一点',7,true),/当前表达偏好：回复简短一点/);
  assert.match(say('private:7','回头再聊电影的结尾',7,true),/本会话明确留待续聊：.*电影的结尾/);
  assert.doesNotMatch(say('group:8','你好',9,false),/本会话明确留待续聊/);
  assert.doesNotMatch(say('private:7','这个话题聊完了',7,true),/本会话明确留待续聊/);
 }finally{await h.close();}
});

test('重启及旧消息重投不回滚称呼，问句不作为新约定',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prefs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const add=(store,id,text)=>store.observe('private:7',{messageId:id,userId:'7',isOwner:true,time:1},7,text);
 const one=createConversationMemory(dir); add(one,'1','以后叫我小林');add(one,'2','以后叫我阿羽');
 const two=createConversationMemory(dir);add(two,'1','以后叫我小林');add(two,'3','以后叫我小林？');
 assert.equal(two.view('private:7',7).address,'阿羽');
});

test('新措辞通过来源找回不同日期的相处经历',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relation-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const paths=resolveMemoryCardPaths(dir);
 const records=['散场后多坐一会儿','散场后留下聊片尾'].map((text,i)=>({id:'r'+i,text,conversationKey:'private:7'}));
 fs.writeFileSync(paths.json,JSON.stringify({records}));
 fs.writeFileSync(paths.narrative,JSON.stringify({episodes:records.map((r,i)=>({id:'e'+i,title:'看电影',text:'那天我们又一起待了一阵。',date:'2026-10-0'+(i+1),covers:[r.id]}))}));
 const recall=createEpisodeRecall(paths);
 assert.match(recall('private:7','咱俩散场后一般干嘛'),/相处线索.*依据：e[01]、e[01]/);
 assert.equal(recall('group:8','咱俩散场后一般干嘛'),'');
});

test('同一活动改口覆盖旧约定，其他活动延续自己的范围',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scope-pref-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const mem=createConversationMemory(dir);
 const add=(id,text)=>mem.observe('private:7',{messageId:id,userId:'7',isOwner:true,time:1},7,text);
 add('one','我喜欢你看完电影主动找我聊观后感');
 add('two','我不再喜欢你看完电影主动找我聊观后感');
 assert.match(mem.view('private:7',7,'看电影').lines.join('\n'),/不再喜欢/);
 assert.doesNotMatch(mem.view('private:7',7,'看电影').lines.join('\n'),/我喜欢你/);
 assert.equal(mem.view('private:7',7,'聊答辩').lines.length,0);
});
