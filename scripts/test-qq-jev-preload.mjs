import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {sealQqWake} from '../src/qq-wake-checkpoint.js';
import {createOpenAiAdapter} from '../plugins/surfcore/lib/qq-codex-provider.js';
import {createQqPreloader,jevDecision,qqJevStatus} from '../plugins/surfcore/lib/qq-jev.js';

const sticker='mcp__snowluma__qq_list_stickers';
const video='mcp__browser__bilibili_video';
const menu=[sticker,video,'mcp__other__qq_get_forward_msg','mcp__snowluma__qq_send_message'];
const question='帮我翻一下攒的会动的小家伙，早八那张叫什么？';
const wake=(text,extra={})=>({id:'test',group:false,incoming:{text,seq:50},recent:[],window:[],...extra});
const answer=(choice='qq_list_stickers',p=0.8)=>({answer:{choice,probabilities:{[choice]:p}},input:400,output:42,ms:105});
function setup(options={}) {
  const requests=[],metrics=[];
  const preload=createQqPreloader({mode:()=>'auto',hasKey:()=>true,
    decide:async(state,q)=>{requests.push({state,q});return answer();},onMetric:m=>metrics.push(m),...options});
  return {preload,requests,metrics};
}

test('explicit reads use local rules, existing and unauthorized names are never added',async()=>{
  const {preload,requests}=setup();
  assert.equal(await preload(wake('查下 BV1xx411c7mD 多长？'),menu),video);
  assert.equal(await preload(wake('帮我看收藏表情有哪些？'),menu),sticker);
  assert.equal(await preload(wake('请看这张截图图里是什么颜色？',{incoming:{text:'截图图里是什么颜色？',hasMedia:true}}),['qq_get_message_images']),'qq_get_message_images');
  for (const [text,offered] of [
    ['读一下合并转发',menu],['帮我查收藏表情',['mcp__fake__qq_list_stickers']],['别查收藏表情了',menu],
    ['那晚安啦',menu],['看看明天的事',[]],['发送消息',menu]
  ]) assert.equal(await preload(wake(text),offered),undefined);
  assert.equal(requests.length,0);
  for(const mode of ['off','rules']) {
    const s=setup({mode:()=>mode});
    assert.equal(await s.preload(wake(question),menu),undefined);
    assert.equal(await s.preload(wake('翻翻收藏表情'),menu),mode==='rules'?sticker:undefined);
    assert.equal(s.requests.length,0);
  }
  const noKey=setup({hasKey:()=>false});
  assert.equal(await noKey.preload(wake(question),menu),undefined);
  assert.equal(noKey.requests.length,0);
});

test('remote choice is constrained, redacted and reused across retries',async()=>{
  const s=setup();
  const incoming={text:'[引用外部文字]',plain:question+' token=test-fixture-secret 联系 demo@example.org 和 76234101',
    sender:'名字不应上传',messageId:'绝密编号',media:['附件内容']};
  const w=wake('',{incoming,recent:[{text:'旁人的整段记录'}]});
  assert.equal(await s.preload(w,menu),sticker);
  assert.equal(await s.preload(w,menu),sticker);
  assert.equal(s.requests.length,1);
  assert.deepEqual(Object.keys(s.requests[0].state),['最新用户消息']);
  assert.deepEqual(Object.keys(s.requests[0].q.criteria).sort(),['standard','qq_list_stickers','bilibili_video'].sort());
  assert.doesNotMatch(JSON.stringify([s.requests,s.metrics]),/fixture-secret|demo@|76234101|名字不应上传|绝密编号|附件内容|旁人的整段|引用外部/);
  for (const result of [answer('qq_send_message'),answer('qq_list_stickers',0.59),answer('qq_list_stickers',1.1),answer('standard'),{}]) {
    const other=setup({decide:async()=>result});
    assert.equal(await other.preload(w,menu),undefined);
  }
  assert.deepEqual(Object.keys(qqJevStatus()).sort(),['keyConfigured','mode','model']);
});

test('followups bind explicit bot quotes in groups and private chats, or immediate private predecessor',async()=>{
  const bot={messageId:'15',time:100,isSelf:true,text:'要我翻一下会动的小家伙，找那张早八吗？'};
  const newer={messageId:'18',time:150,isSelf:true,text:'要我查一下视频吗？'};
  for (const group of [true,false]) {
    const s=setup(), incoming={time:200,text:'好，你看下。',replyToMessageId:'15',quoteTargetIsSelf:true};
    assert.equal(await s.preload(wake('',{group,incoming,recent:[newer],window:[bot]}),menu),sticker);
    assert.equal(s.requests[0].state.上一条助手消息,bot.text);
    assert.equal(await s.preload(wake('',{group,incoming:{...incoming,replyToMessageId:'9'},window:[newer]}),menu),undefined);
  }
  const s=setup(), incoming={text:'好，你看下。',time:201};
  assert.equal(await s.preload(wake('',{incoming,recent:[bot],window:[bot]}),menu),sticker);
  for (const w of [
    wake('',{group:true,incoming,recent:[bot]}),wake('',{group:true,incoming:{...incoming,atSelf:true},recent:[bot]}),
    wake('',{incoming:{...incoming,time:2000000},recent:[bot]}),
    wake('',{incoming,recent:[bot,{...newer,isSelf:false}]}),
    wake('',{incoming,recent:[bot,{...newer,time:100}]}),
    wake('',{incoming:{...incoming,text:'[引用其他人] 好，你看下。',plain:'好，你看下。'},recent:[bot]}),
    wake('',{incoming:{...incoming,text:question,tail:'长消息末尾另有要求'},recent:[bot]}),
    wake('',{incoming:{text:'好，你看下。',history:true},recent:[bot]})
  ]) assert.equal(await s.preload(w,menu),undefined);
});

test('failed service cools down, caller cancellation stays cancellation, wire format uses fixed destination',async()=>{
  let calls=0;
  const s=setup({decide:async()=>{calls++;throw Error('HTTP 429');}});
  await s.preload(wake(question),menu);
  await s.preload(wake(question,{id:'retry'}),menu);
  assert.equal(calls,1);assert.equal(s.metrics[0].reason,'HTTP 429');
  const controller=new AbortController();
  const aborted=setup({decide:async()=>{controller.abort();throw Error('canceled');}});
  await assert.rejects(aborted.preload(wake(question),menu,controller.signal),{name:'AbortError'});
  assert.equal(aborted.metrics.length,0);
  const old=process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY='unit-test-only';
    const r=await jevDecision('fixture',{type:'choice'},{fetchImpl:async(url,options)=>{
      assert.equal(url,'https://openrouter.ai/api/alpha/decisions');assert.equal(options.redirect,'error');
      assert.equal(options.headers.Authorization,'Bearer unit-test-only');
      assert.deepEqual(JSON.parse(options.body).questions,{decision:{type:'choice'}});
      return {ok:true,json:async()=>({answers:{decision:answer().answer},usage:{input_tokens:77,output_tokens:8,cost:0.000003}})};
    }});
    assert.equal(r.input,77);assert.equal(r.cost,0.000003);
  } finally {if(old===undefined) delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=old;}
});

test('adapter exposes one optional schema on the first signed, current, complete wake only',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-jev-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  function write(file,obj){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(obj));}
  const key='private:101',sid='jev-offline',token='cd'.repeat(24);
  write(path.join(dir,'sessions.json'),{sessions:{[key]:sid}});
  write(path.join(dir,'social-v2.json'),{conversations:{[key]:{agentToken:token,lastUnreadSeq:50}}});
  const asText=(role,text)=>({role,content:[{type:'text',text}]});
  const names=[sticker,video,'qq_send_message','qq_get_unread_messages','qq_close_conversation',
    ...Array.from({length:28},(_,i)=>'read_fixture_'+i)];
  const tools=names.map(name=>({name,description:name,parameters:{type:'object'}}));
  for(const scenario of ['ordinary','unsigned','tampered','later','stale','partial','folded','multi','backlog','compaction']){
    const row={seq:50,text:question}, packet={messages:scenario==='multi'?[row,row]:[row],recent:[],
      readThroughSeq:scenario==='stale'?49:50,unreadCount:scenario==='backlog'?2:1,partial:scenario==='partial',folded:scenario==='folded'?{count:2}:null};
    const raw='【本轮】'+key+' · private · 19:00:00\n【本回合授权】这是主人私聊：本轮授权。\n【近聊窗口（背景）】\n[]\n【本次消息快照】\n'+JSON.stringify(packet);
    let body=sealQqWake({dir,write,key,sid,token,profile:{fixed:'小棠',values:{}},text:raw});
    if(scenario==='unsigned')body=raw;
    if(scenario==='tampered')body=body.replace('早八','晚八');
    const messages=[asText('user',body)];
    if(scenario==='later')messages.push(asText('assistant','上一步'));
    const s=setup(),main=[];
    const adapter=createOpenAiAdapter({},async req=>{main.push(req);return {output:req.purpose==='compaction'?'摘要':{action:'end',arguments:'{}',text:'完成',note:'小记'}};},
      undefined,{stateDir:dir,preload:s.preload});
    await Array.fromAsync(adapter.stream({model:'gpt-6.2-sol',tools,messages,sessionId:sid,purpose:scenario==='compaction'?'compaction':undefined}));
    assert.equal(main.length,1,scenario);
    assert.equal(s.requests.length,scenario==='ordinary'?1:0,scenario);
    const prompt=JSON.parse(main[0].input[0].text);
    if(scenario==='ordinary'){
      assert(main[0].schema.properties.action.enum.includes(sticker));
      assert(!main[0].schema.properties.action.enum.includes(video));
      assert.equal(prompt['根据本轮来信预载的只读工具（可选）'],sticker);
    } else assert(!Object.hasOwn(prompt,'根据本轮来信预载的只读工具（可选）'));
  }
});
