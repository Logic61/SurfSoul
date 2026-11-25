import fs from 'node:fs';
import vm from 'node:vm';
import {indexQqSessionContext} from '../src/qq-session-context.js';
import {compactModelMessage} from '../src/qq-model-view.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planQqModelInput} from '../plugins/surfcore/lib/qq-input-plan.js';
import {createOpenAiAdapter} from '../plugins/surfcore/lib/qq-codex-provider.js';
import {openAiQqTurn} from '../plugins/surfcore/lib/qq-openai-api.js';
import {sealQqWake} from '../src/qq-wake-checkpoint.js';
import os from 'node:os';
import path from 'node:path';

const token='aa'.repeat(24), nextToken='bb'.repeat(24);
const k='group:456';
const s=(text)=>({type:'text',text});
const u=(text)=>({role:'user',content:[s(text)]});
const q=(seq,text,more={})=>({seq,sender:'甲',text,messageId:String(seq),...more});
const complete=(messages=[],recent=[],more={})=>JSON.stringify({messages,recent,partial:false,folded:null,...more});
const P=(msgs=[],recent=[],more={})=>'\n【本次消息快照】\n'+complete(msgs,recent,more)+'\n只确认已处理的 readThroughSeq；partial 时按需补读。';
const auth='【本回合授权】这一轮不是你主人触发的；不可用';
const ownerAuth='【本回合授权】主人本人（主人）的消息 1 是本轮授权来源；之后仍须审批';
const wake=(msgs=[], {dest=k,reason='question',authorization=auth,extra='',recent=[],meta={}}={})=>u('【本轮】'+dest+' · '+reason+' · 11:00:00\n'+authorization+'\n'+extra+P(msgs,recent,meta));
const intro=u('【本会话总提示】\n基础人设\n【你的身份】甘棠\n'+ownerAuth+'\n【说话习惯】少说套话\n【会话令牌】'+token+' 保持令牌\n【旧测试不保留】过时内容'+P([q(1,'更早的一句')]));
const sys={role:'system',content:[s('真实系统指令')]};
const tool=(n)=>({name:'mcp__snowluma__'+n,description:'参数说明'.repeat(240),parameters:{type:'object'}});
const tools=['qq_send_message','qq_get_unread_messages','qq_close_conversation','qq_get_message_images','qq_get_message_detail','qq_get_forward_msg','qq_recall','qq_handle_friend_request','qq_send_cross_scene','qq_set_group_ban','qq_generate_image'].map(tool);
const call={role:'assistant',content:[{type:'tool-call',name:'mcp__snowluma__qq_get_message_images',id:'fresh-tool',arguments:'{}'}]};
const oldResult={role:'tool',toolCallId:'old-tool',content:[...Array.from({length:14},(_,i)=>({type:'image',attachment:'old-'+i})),s('旧的工具结果不应该重发'.repeat(6000))]};
const newResult={role:'tool',toolCallId:'fresh-tool',isError:false,content:[{type:'image',attachment:'fresh-unique'},s('此刻工具的必要结果')]};
const readDigest=x=>x.messages[0].content[0].text;
const opts=over=>({messages:[sys,intro,oldResult,wake([q(3,'哈哈好啊')])],tools,...over});
test('a planned end or natural closure requires matching, fresh host receipts; failures go back to the model',async t=>{
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-finish-test-')),sid='test-room';
  t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));
  const write=(file,obj)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(obj));};
  const live=(seq,credential=token)=>write(path.join(stateDir,'social-v2.json'),{conversations:{[k]:{agentToken:credential,lastUnreadSeq:seq}}});
  write(path.join(stateDir,'sessions.json'),{sessions:{[k]:sid}});
  const src=wake([q(3,'知道啦')],{extra:'【近聊窗口（背景）】\n[]',meta:{readThroughSeq:3}}).content[0].text;
  const signed=u(sealQqWake({dir:stateDir,write,key:k,sid,token,text:src,profile:{fixed:'小蓝',values:{}}}));
  const sent={ok:true,key:k,lastUnreadSeq:3,sent:1,failed:0,messageIds:['22']};
  const closed={ok:true,key:k,lastUnreadSeq:3,closedAt:300,unreadCount:0,wakeKept:true};
  for (const scenario of ['end','close','open','partial','error','key','id','warn','stale','new-wake','rotated','receipt-stale','close-failed','missing-close']) {
    live(3);
    let calls=0;
    const chain=[sys,signed], natural=['close','close-failed','missing-close'].includes(scenario);
    const adapter=createOpenAiAdapter({},async req=>{
      calls++;
      if(calls>1) {
        if (scenario==='error') {
          assert.equal(req.stablePrefix,false);
          assert(!req.schema.properties.note.description.includes('$close'));
        }
        return {output:{action:'end',text:'交回模型',note:'重新判断'}};
      }
      assert(req.schema.properties.note.description.includes('$close'));
      return {output:{action:tools[0].name,text:'',arguments:JSON.stringify({key:k,token:'QQ_SESSION_TOKEN_1',messages:'收到',
        ...(natural?{$close:{reason:'topic-done',summary:'约好北门'}}:{})}),note:scenario==='open'?'':'北门见。'}};
    },undefined,{stateDir});
    const step=async(menu=tools)=>{const ev=await Array.fromAsync(adapter.stream({model:'gpt-6.2-sol',reasoningEffort:'low',tools:menu,messages:chain,sessionId:sid}));return ev.find(x=>x.type==='block-end')?.block;};
    const receipt=(block,r,error=false)=>{chain.push({role:'assistant',content:[block]},{role:'tool',toolCallId:block.id,isError:error,content:[s(JSON.stringify(r))]});};
    const send=await step();assert.equal(send.name,tools[0].name);assert(!Object.hasOwn(JSON.parse(send.arguments),'$close'));
    const r={...sent};
    if (scenario==='partial') r.failed=1;
    if (scenario==='key') r.key='private:100';
    if (scenario==='id') r.messageIds=[];
    if (scenario==='warn') r.warn='检查用词';
    if (scenario==='receipt-stale') r.lastUnreadSeq=4;
    receipt(send,r,scenario==='error');
    if (scenario==='stale') live(4);
    if (scenario==='rotated') live(3,nextToken);
    if (scenario==='new-wake') chain.push(u('另一条来信'));
    let block=await step(scenario==='missing-close'?tools.filter(t=>t!==tools[2]):tools);
    if (scenario==='close' || scenario==='close-failed') {
      assert.equal(block.name,tools[2].name);assert.equal(JSON.parse(block.arguments).summary,'约好北门');assert.equal(calls,1);
      receipt(block,closed,scenario==='close-failed');block=await step();
    }
    const expected=['end','close'].includes(scenario);
    assert.equal(calls,expected?1:2,scenario);assert.match(block.text,expected?/【DSH小记】北门见/:/交回模型/);
    if (expected) {assert.deepEqual(await step(),block);assert.equal(calls,1);}
  }
});
test('bounds old history and uses a short menu for ordinary group chat without touching current or inputs',()=>{
 const old=wake([q(2,'很长的旧消息'.repeat(12000)),q(3,'现在这句的重复旧副本')],{extra:'【当前约定更新】叫对方老吴'});
 const current=wake([q(3,'哈哈好啊')]);
 const options=opts({messages:[sys,intro,old,oldResult,current]});
 const a=planQqModelInput(options);
 assert(a.projected);assert.equal(a.messages.at(-1),current);
 const digest=readDigest(a);
 assert.match(digest,/基础人设|甘棠/);assert.match(digest,/叫对方老吴/);
 assert.match(digest,/更早的一句|旧消息截短/);
 assert.doesNotMatch(digest,/重复旧副本|主人本人的消息|旧的工具结果|过时内容/);
 assert(digest.length<24000);assert(!a.messages.includes(oldResult));
 assert(!a.tools.some(x=>x.name.endsWith('qq_send_cross_scene')));
 assert(a.tools.some(x=>x.name.endsWith('qq_get_message_images')));
 assert.equal(options.messages.length,5);assert.equal(options.tools.length,11);
});
test('current correction replaces old override and latest token persists only from the known conversation wishes',()=>{
 const overrides=wake([q(2,'好')],{extra:'【会话令牌更新】'+nextToken+'\n【当前约定更新】旧称呼'});
 const current=wake([q(3,'嗯')],{extra:'【当前约定更新】新称呼'});
 const r=planQqModelInput(opts({messages:[sys,intro,overrides,current]}));
 assert.match(readDigest(r),new RegExp(nextToken));assert.doesNotMatch(readDigest(r),/旧称呼/);
 assert(!readDigest(r).includes(token));assert(r.messages[1].content[0].text.includes('新称呼'));
});
test('complex needs, media posts, partial packets, and active specialist continuations retain full tools',()=>{
 const currents=[wake([q(3,'帮我看看这个链接')]),wake([q(3,'哈',{hasMedia:true})]),wake([q(3,'哈')],{meta:{partial:true}})];
 for(const c of currents)assert.equal(planQqModelInput(opts({messages:[sys,intro,c]})).tools,tools);
 const special={role:'assistant',content:[{type:'tool-call',name:'mcp__snowluma__qq_set_group_ban',id:'s',arguments:'{}'}]};
 const r=planQqModelInput(opts({messages:[sys,intro,wake([q(3,'哈哈')]),special]}));
 assert.equal(r.tools,tools);
});
test('system jobs, compaction, legacy and missing bridge anchor are byte-preserving',()=>{
 for(const [messages,purpose,legacy] of [
 [[sys,intro,wake([q(3,'好')],{reason:'system'})]],
 [[sys,intro,wake([q(3,'好')])],'compaction'],
 [[sys,intro,wake([q(3,'好')])],undefined,true],
 [[sys,wake([q(3,'好')])]],
 [[sys,intro,u('一般文字')]]
 ]) {const v=planQqModelInput(opts({messages,purpose}),{legacy});assert.equal(v.messages,messages);assert.equal(v.tools,tools);}
});
test('fresh tool-call, result, image and errors survive; old ones do not reach attachments',async()=>{
 const current=wake([q(3,'这是什么图片？',{hasMedia:true})]);
 const calls=[];
 const a=createOpenAiAdapter({readImage:async id=>{calls.push(id);return {ref:{mediaType:'image/jpeg'},data:Buffer.from('mock')};}},
   async request=>{
    assert.equal(request.input.length,2);
    assert.match(request.system,/真实系统指令/);
    const env=JSON.parse(request.input[0].text);
    assert.match(JSON.stringify(env.messages),/此刻工具的必要结果|fresh-tool/);
    assert.doesNotMatch(JSON.stringify(env),/old-tool|旧的工具结果/);
    assert(!JSON.stringify(request).includes(token));
    const safeAction=tools[0].name;
    assert(request.schema.properties.action.enum.includes(safeAction));
    return {output:{action:safeAction,arguments:'{"token":"QQ_SESSION_TOKEN_1"}',text:''}};
   });
 const options={...opts({messages:[sys,intro,oldResult,current,call,newResult]}),model:'gpt-4o'};
 const out=await Array.fromAsync(a.stream(options));
 assert.deepEqual(calls,['fresh-unique']);assert.equal(JSON.parse(out.find(x=>x.type==='block-end').block.arguments).token,token);
});
test('a fresh 32-character bridge token is masked in every model-bound block and restored only for DSH', async () => {
 const short='ef'.repeat(16), mediaId='ab'.repeat(16);
 const opening=u(intro.content[0].text.replace(token,short));
 const adapter=createOpenAiAdapter({},async req=>{
   assert(!JSON.stringify(req).includes(short));
   assert(JSON.stringify(req).includes(mediaId));
   return {output:{action:tools[0].name,arguments:'{"token":"QQ_SESSION_TOKEN_1"}',text:''}};
 });
 const messages=[sys,opening,wake([q(2,'附件 '+mediaId)])];
 const output=await Array.fromAsync(adapter.stream({...opts({messages}),model:'gpt-4o'}));
 assert.equal(JSON.parse(output.find(x=>x.type==='block-end').block.arguments).token,short);
});
test('filtered tool fails before DSH execution even if mocked model hallucinates it',async()=>{
 const a=createOpenAiAdapter({},async({schema})=>{
  assert(!schema.properties.action.enum.includes(tools[8].name));
  return {output:{action:tools[8].name,arguments:'{}',text:''}};
 });
 await assert.rejects(Array.fromAsync(a.stream({...opts(),model:'gpt-4o'})),/Unadvertised DSH tool/);
});
test('mock Responses wire uses same planned menu and never sends bearer or stale payload',async()=>{
 const a=createOpenAiAdapter({},task=>openAiQqTurn(task,{key:'TEST',fetchImpl:async(_u,init)=>{
  const body=JSON.parse(init.body); const envelope=JSON.parse(body.input[0].content[0].text);
  assert.equal(envelope.tools.length,7);assert(!init.body.includes(token));assert(!init.body.includes('旧的工具结果'));
  return {ok:true,json:async()=>({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'{"action":"end","arguments":"{}","text":"","note":""}'}]}]})};
 }}));
 const result=await Array.fromAsync(a.stream({...opts(),model:'gpt-4o'}));
 assert.equal(result.at(-1).reason.kind,'stop');
});


test('owner traffic keeps full tool policy but drops old tool results',()=>{
 for(const c of [wake([q(3,'好')],{authorization:ownerAuth}),wake([q(3,'好')],{dest:'private:7',authorization:'【本回合授权】这是主人私聊：可用'})]){
   const r=planQqModelInput(opts({messages:[sys,intro,oldResult,c]}));
   assert(r.projected);assert.equal(r.tools,tools);assert(!r.messages.includes(oldResult));
 }
});
test('native QQ timeline replaces fallback snippets, different conversation and unknown auth do not project',()=>{
 const current=wake([q(3,'好')],{extra:'【近聊窗口（背景）】\n[{"seq":2,"text":"本地最新背景"}]'});
 const o=opts({messages:[sys,intro,current]});const r=planQqModelInput(o);
 assert(r.projected);assert.equal(r.messages[1],current);assert(!readDigest(r).includes('更早的一句'));
 const other=wake([q(3,'好')],{dest:'group:9'});
 const b=opts({messages:[sys,intro,other,current]});assert.equal(planQqModelInput(b).messages,b.messages);
 const authUnknown=wake([q(3,'好')],{authorization:'【本回合授权】未知'});
 const c=opts({messages:[sys,intro,authUnknown]});assert.equal(planQqModelInput(c).messages,c.messages);
});
test('bridge window keeps latest raw QQ messages disjoint from live packet, honors unread and full body',()=>{
 const b=fs.readFileSync(new URL('../src/bridge.js',import.meta.url),'utf8');
 const a=b.indexOf('  function buildQqRecentWindowV2('),z=b.indexOf('  function buildWakeSnapshotV2(',a);
 const f=vm.runInNewContext(b.slice(a,z)+'\nbuildQqRecentWindowV2',{compactModelMessage,groupMessageView:(_key,row)=>row});
 const rows=Array.from({length:45},(_,i)=>q(i+1,'原文'+(i+1),{plain:'换行\n尾段'+(i+1)}));
 rows.at(-4).media=[{type:'image',url:'https://local.invalid/should-not-transfer'}];
 const state={recentMessages:rows,unread:[rows.at(-1),rows.at(-2)]};
 const active={recent:[rows.at(-3)],messages:[rows.at(-1)],readThroughSeq:17};
 const v=f(k,state,active);
 assert.equal(v.length,27);
 assert.equal(v[0].seq,16);assert.equal(v.at(-1).seq,42);
 assert.equal(v.at(-1).plain,'换行\n尾段42');
 assert(!JSON.stringify(v).includes('should-not-transfer'));
 assert.equal(active.readThroughSeq,17);assert.equal(state.unread.length,2);
 assert.equal(f(k,{recentMessages:rows,unread:[]},null).length,30);
});


test('production reasons, typed revision and search continuation reach the adapter', async () => {
  const opening = u(indexQqSessionContext(intro.content[0].text,k,{'会话设置':'模型社群','角色卡':'甲'.repeat(15000),'QQ里的动作':'先核对再答'},null));
  const changed = wake([q(2,'好')]);
  changed.content[0].text = indexQqSessionContext(changed.content[0].text,k,{'会话设置':'读书小组'},new Set(['会话设置']));
  for (const reason of ['private','atMention','keyword:小鱼','speaker:鱼','anyMessage']) {
    const current = wake([q(3,'今晚8点？')],{reason});
    const projected = planQqModelInput(opts({messages:[sys,opening,changed,current]}));
    assert(projected.projected);
    assert.match(readDigest(projected), /读书小组/);
    assert.match(readDigest(projected), /先核对再答/);
    assert.doesNotMatch(readDigest(projected), /模型社群/);
    assert(projected.tools.length < tools.length);
  }
  const lookup = {role:'assistant',content:[{type:'tool-call',id:'lookup',name:tool('qq_slang_query').name,arguments:'{}'}]};
  const miss = {role:'tool',toolCallId:'lookup',content:[s('本地未命中')]};
  const catalog = [...tools,...['qq_slang_query','web_search','bilibili_search'].map(tool)];
  const options = opts({messages:[sys,opening,wake([q(3,'什么是黑话',{atSelf:true})]),lookup,miss],tools:catalog});
  const metrics=[];
  const adapter=createOpenAiAdapter({},async request=>{
    const chars=JSON.stringify(request);
    assert(!chars.includes('QQ上下文索引'));
    assert(request.schema.properties.action.enum.includes(tool('web_search').name));
    assert(request.schema.properties.action.enum.includes(tool('bilibili_search').name));
    assert(!request.schema.properties.action.enum.includes(tool('qq_set_group_ban').name));
    return {output:{action:'end',text:'',note:''},usage:{inputTokens:45,outputTokens:3}};
  },m=>metrics.push(m));
  await Array.fromAsync(adapter.stream({...options,model:'gpt-4o'}));
  assert.equal(metrics[0].usage.inputTokens,45);
  assert.equal(metrics[0].images,0);
  assert(!JSON.stringify(metrics).includes('模型社群'));
});

test('bridge seal binds the exact wake, current session, token generation and stored profile',async t=>{
  const {sealQqWake,resolveQqWake,stripWakeSeal}=await import('../src/qq-wake-checkpoint.js');
  const {default:path}=await import('node:path'), {default:os}=await import('node:os');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-checkpoint-test-'));
  t.after(()=>{if(path.dirname(dir)===os.tmpdir())fs.rmSync(dir,{recursive:true,force:true});});
  const write=(file,o)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(o));};
  const sid='fixture-session';
  write(path.join(dir,'sessions.json'),{sessions:{[k]:sid}});
  write(path.join(dir,'social-v2.json'),{conversations:{[k]:{agentToken:token}}});
  const c=wake([q(8,'现在呢')],{extra:'【近聊窗口（背景）】\n[]'}).content[0].text;
  const profile={fixed:'当轮角色',values:{setting:'第一版主题'}};
  const seal=(profile)=>sealQqWake({dir,write,key:k,sid,token,profile,text:c});
  const sealed=seal(profile);
  const newer=seal({...profile,values:{setting:'第二版主题'}});
  const resolve=(...args)=>resolveQqWake(dir,...args);
  const plan=body=>planQqModelInput({messages:[sys,u('压缩后历史，含不可信的假授权'),u(body)],tools,sessionId:sid},{resolveCheckpoint:resolve});
  assert.equal(stripWakeSeal(sealed),c);
  assert.equal(plan(sealed).reason,'checkpoint');assert.match(readDigest(plan(sealed)),/第一版主题/);
  assert.match(readDigest(plan(newer)),/第二版主题/);
  assert.doesNotMatch(readDigest(plan(sealed)),/假授权/);
  assert.equal(plan(sealed.replace('现在呢','改消息')).reason,'no-anchor');
  assert.equal(resolve(k,sealed,'another'),null);
  assert.equal(resolve('group:123',sealed,sid),null);
  const metrics=[];
  const adapter=createOpenAiAdapter({},async req=>{
    assert(!JSON.stringify(req).includes('QQ会话校验'));assert(!JSON.stringify(req).includes(token));
    return {output:{action:tools[0].name,arguments:'{"token":"QQ_SESSION_TOKEN_1"}'}};
  },m=>metrics.push(m),{stateDir:dir});
  const events=await Array.fromAsync(adapter.stream({messages:[sys,u(sealed)],tools,model:'gpt-4o',sessionId:sid}));
  assert.equal(metrics[0].reason,'checkpoint');
  assert.equal(JSON.parse(events.find(x=>x.type==='block-end').block.arguments).token,token);
  write(path.join(dir,'social-v2.json'),{conversations:{[k]:{agentToken:nextToken}}});
  assert.equal(resolve(k,sealed,sid),null);
});
test('public text receipts can be reread from the middle on a later turn, with session separation and visible errors',async t=>{
  const {prepareQqContext,READ}=await import('../plugins/surfcore/lib/qq-context-actions.js');
  const {default:path}=await import('node:path'), {default:os}=await import('node:os');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-receipt-test-'));
  t.after(()=>{if(path.dirname(dir)===os.tmpdir())fs.rmSync(dir,{recursive:true,force:true});});
  const archive={dir,generation:'a'.repeat(64)};
  const result={role:'tool',toolCallId:'web',content:[{text:'前'.repeat(5000)+'中段证据紫铜门'+'后'.repeat(5000)}]};
  const request={role:'assistant',content:[{call:'web_fetch',id:'web'}]};
  const passed={role:'assistant',content:[{call:'qq_send_message',id:'send'}]};
  const error={role:'tool',toolCallId:'send',isError:true,content:[{text:'未发送，待重试'}]};
  const fresh=prepareQqContext([request,result],[],archive);
  assert.equal(fresh.messages[1],result);
  const retry=prepareQqContext([request,result,passed,error],[],archive);
  assert.equal(retry.messages[1],result);assert.equal(retry.messages.at(-1),error);
  assert.match(retry.pending.reason,/未发送/);
  assert.deepEqual(prepareQqContext([request,result,passed,error],[],archive,{skipVisible:true}).ids(),retry.ids());
  assert(prepareQqContext([request,result,passed,error],[],archive).recovering);
  assert.equal(prepareQqContext([request,result],[],archive,{skipVisible:true}).ids().length,0);
  const folded=prepareQqContext([request,result,passed],[],archive);
  assert(folded.messages[1].content[0].text.length<1400);
  const [id]=folded.ids();
  assert(prepareQqContext([request,result,passed],[],archive,{skipVisible:true}).ids().includes(id));
  const later=prepareQqContext([],[],archive);
  later.inspect(READ,{id,find:'紫铜门'});assert.match(later.feedback.text,/中段证据紫铜门/);
  later.inspect(READ,{id,offset:5010,limit:300});assert.equal(later.feedback.offset,5010);
  const newer=prepareQqContext([],[],{...archive,generation:'b'.repeat(64)});
  newer.inspect(READ,{id});assert(newer.feedback.error);
  for(const failed of [{...result,isError:true},{...result,content:[{text:'{"ok":false,'+'x'.repeat(9000)}]},
    {...result,content:[...result.content,{image:1}]}]) {
    assert.equal(prepareQqContext([request,failed,passed],[],null).messages[1],failed);
  }
});
test('local tool discovery only offers host-approved names and accounts for each model request',async()=>{
  const catalog=[...tools,...Array.from({length:20},(_,i)=>tool('public_demo_'+i))];
  const name=catalog.at(-1).name;
  let pass=0;
  const metrics=[];
  const adapter=createOpenAiAdapter({},async req=>{
    const env=JSON.parse(req.input[0].text), actions=req.schema.properties.action.enum;
    if (pass++===0) {
      assert(env.toolDirectory.names.includes(name));assert(!actions.includes(name));
      return {output:{action:'surfcore_load_tools',arguments:JSON.stringify({names:[name,'never_authorized']})},usage:{inputTokens:42,cachedInputTokens:10,outputTokens:3}};
    }
    assert(actions.includes(name));assert(!actions.includes('never_authorized'));
    assert.deepEqual(env.inspections[0].unknown,['never_authorized']);
    return {output:{action:name,arguments:'{}'},usage:{inputTokens:58,cachedInputTokens:20,outputTokens:7}};
  },m=>metrics.push(m));
  const out=await Array.fromAsync(adapter.stream({model:'gpt-4o',tools:catalog,messages:[sys,intro,wake([q(3,'好')],{authorization:ownerAuth})]}));
  assert.equal(out.find(x=>x.type==='usage').usage.inputTokens,70);
  assert.equal(out.find(x=>x.type==='usage').usage.cacheReadTokens,30);
  assert.equal(out.find(x=>x.type==='block-end').block.name,name);assert.equal(metrics.length,2);
});


test('usage from discovery is emitted if the next provider request fails',async()=>{
  let calls=0;const catalog=[...tools,...Array.from({length:20},(_,i)=>tool('public_demo_'+i))];
  const adapter=createOpenAiAdapter({},async()=>{
    if (calls++) throw Error('fixture unavailable');
    return {output:{action:'surfcore_load_tools',arguments:JSON.stringify({names:[catalog.at(-1).name]})},usage:{inputTokens:40,cachedInputTokens:5,outputTokens:2}};
  });
  const events=[];
  await assert.rejects(async()=>{for await (const evt of adapter.stream({model:'gpt-4o',tools:catalog,messages:[sys,intro,wake([q(3,'好')],{authorization:ownerAuth})]})) events.push(evt);},/fixture unavailable/);
  assert.equal(events.find(e=>e.type==='usage').usage.inputTokens,35);
  assert.equal(events.find(e=>e.type==='usage').usage.cacheReadTokens,5);
});
