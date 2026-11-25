import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSourceWorker,isDirectPageRequest} from '../plugins/surfcore/lib/qq-source-worker.js';
import {createOpenAiAdapter} from '../plugins/surfcore/lib/qq-codex-provider.js';
import {planQqModelInput} from '../plugins/surfcore/lib/qq-input-plan.js';
import {sealQqWake} from '../src/qq-wake-checkpoint.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const read='mcp__web-search-safe__web_fetch',search='mcp__web-search-safe__web_search',url='https://fiction.invalid/a';
const tools=[{name:read},{name:search}],scope={wake:'signed',seq:3};
const text='从 '+url+' 开始，沿引用查雨天地点。';
const wake=(s=text,extra={})=>({incoming:{text:s},...extra});
const call=(id,name,args)=>({type:'tool-call',id,name,arguments:JSON.stringify(args)});
const block=(role,text)=>({role,content:[{type:'text',text}]});
function receipt(b,obj){return [{role:'assistant',content:[b]},{...block('tool',JSON.stringify(obj)),toolCallId:b.id}];}
const page=(body,address=url)=>({statusCode:200,body,url:address});
const result=answer=>({text:JSON.stringify(answer),usage:{prompt_tokens:8,prompt_cache_hit_tokens:1,completion_tokens:3}});

test('one direct link keeps the original request layout; a chain or comparison can delegate',()=>{
  assert(isDirectPageRequest('请查 '+url+' 的开门时间。'));
  assert(!isDirectPageRequest(text));
  assert(!isDirectPageRequest('请比较 '+url+' 和 https://fiction.invalid/b'));
  assert(!isDirectPageRequest(undefined));
});

test('only host-attributed initial supplements preserve external routing eligibility',()=>{
  const packet={messages:[{seq:3,plain:text}],recent:[],readThroughSeq:3};
  const signed=block('user','【本轮】private:51 · private · 12:00\n【本回合授权】这是主人私聊。\n【本次消息快照】\n'+JSON.stringify(packet)+'\n【近聊窗口（背景）】\n[]');
  const resolveCheckpoint=()=>({wakeId:'fixture',profile:{fixed:'',values:{}},lastUnreadSeq:3});
  const supplement=block('user','<system-reminder>context</system-reminder>');
  const plan=extra=>planQqModelInput({messages:[signed,extra],tools},{resolveCheckpoint});
  assert(!plan(supplement).routingWake);
  assert(plan({...supplement,source:{kind:'runtime-context',form:'snapshot'}}).routingWake);
});

test('scope, read capabilities and explicit multi-source intent gate the handoff',()=>{
  const worker=createSourceWorker({enabled:()=>true});
  for(const w of [wake('请查 '+url),wake('不用联网，沿引用查 '+url),wake(text,{group:true}),
    wake(text,{incoming:{plain:text,hasMedia:true}}),wake(text,{incoming:{plain:text,tail:'有遗漏'}}),
    wake('请先读 https://fiction.invalid/a?token=sensitive 再读确认'),wake('闲聊')])
    assert(!worker.offer(scope,w,tools));
  assert(!worker.offer(scope,wake(),[{name:'mcp__other__web_fetch'}]));
  assert(!worker.offer(null,wake(),tools));
  assert(worker.offer(scope,wake(),tools));
  assert(worker.offer(scope,wake('请搜索不同来源，再核实开放时间。'),tools));
});

test('authorized native reads, replay, exact quotes, projection and uncertainty',async()=>{
  for(const scenario of ['success','invented','bad-reference','redirect-error','missing','api-error','revoked','abort']){
    const seen=[],metrics=[],abort=new AbortController();
    const w=createSourceWorker({enabled:()=>true,onMetric:m=>metrics.push(m),ask:async state=>{
      seen.push(state);
      if(scenario==='abort') {abort.abort();throw Error('abort');}
      if(scenario==='api-error') throw Error('timeout');
      if(state.sources.length===1)return result({read:scenario==='bad-reference'?'S73':'S2'});
      return result({evidence:[{ref:'S2',quote:scenario==='invented'?'来自另一个来源':'雨天在溪杉楼。'}]});
    }});
    const first=call('one',read,{url}),offer=w.offer(scope,wake(),tools);
    w.begin(scope,offer,first,JSON.parse(first.arguments),tools);
    assert(!w.offer(scope,wake(),tools));
    const h=receipt(first,scenario==='redirect-error'?{statusCode:403,body:'错误'}:page('联系 mailbox@fixture.invalid。正式公告见 <a href="/b">最终版</a>'));
    if(scenario==='abort'){await assert.rejects(w.resume(scope,h,tools,abort.signal));continue;}
    assert.equal(await w.resume({...scope,wake:'other'},h,tools),undefined);
    const next=await w.resume(scope,h,scenario==='revoked'?[]:tools);
    if(['bad-reference','redirect-error','api-error','revoked'].includes(scenario)){assert(!next);continue;}
    assert.equal(next.action,read);assert.deepEqual(JSON.parse(next.arguments),{url:'https://fiction.invalid/b'});
    assert.deepEqual(await w.resume(scope,h,tools),next);assert.equal(seen.length,1);
    const nextCall=call(next.id,read,JSON.parse(next.arguments));
    const chain=[...h,...receipt(nextCall,page('雨天在溪杉楼。','https://fiction.invalid/b'))];
    if(scenario==='missing')chain.at(-1).isError=true;
    assert.equal(await w.resume(scope,chain,tools),undefined);
    const projected=w.project(scope,chain,chain);
    if(scenario!=='success'){assert.equal(projected,chain);continue;}
    assert(projected.at(-1).content[0].text.includes('公开来源查证完成'));
    assert.equal(projected.length,2);assert.equal(projected[1].toolCallId,first.id);
    assert.deepEqual(JSON.parse(projected[1].content[0].text).sources,[url,'https://fiction.invalid/b']);
    const interrupted=[...h,block('user','另一个问题'),...chain.slice(h.length)];
    assert.equal(w.project(scope,interrupted,interrupted),interrupted);
    const reopened=[...chain,...receipt(call('reopen',read,{url}),page('另一版内容'))];
    assert.equal(w.project(scope,reopened,reopened),reopened);
    assert(!JSON.stringify(seen).includes('https://'));assert.equal(metrics.length,2);
    assert(!JSON.stringify(seen).includes('mailbox@'));
    assert.equal(w.project(scope,h,h),h);
    const altered=structuredClone(chain);altered.at(-1).content[0].text='{}';
    assert.equal(w.project(scope,altered,altered),altered);
  }
});

test('search picks only URLs from a returned result, then reads two actual pages',async()=>{
  const w=createSourceWorker({enabled:()=>true,ask:async s=>result(s.sources.length<2?{read:s.available[0]}:{evidence:[
    {ref:'S1',quote:'甲馆周一开。'},{ref:'S2',quote:'乙馆周二开。'}]})});
  const first=call('search',search,{query:'展馆对照'}),req=w.offer(scope,wake('请搜索两份来源，比较开门日。'),tools);
  w.begin(scope,req,first,JSON.parse(first.arguments),tools);
  const h=receipt(first,{results:[{title:'甲馆',url},{title:'乙馆',url:'https://fiction.invalid/b'}]});
  for(const line of ['甲馆周一开。','乙馆周二开。']){
    const next=await w.resume(scope,h,tools);assert(next);
    const args=JSON.parse(next.arguments);h.push(...receipt(call(next.id,next.action,args),page(line,args.url)));
  }
  assert.equal(await w.resume(scope,h,tools),undefined);
  assert.match(w.project(scope,h,h).at(-1).content[0].text,/乙馆周二开/);
});

test('a runtime supplement seen before a picture and close preserves the terminal note; new input still invalidates it',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'worker-signed-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data));};
  const key='private:50',sid='sample',token='ef'.repeat(24),pic='mcp__snowluma__qq_get_message_images',close='mcp__snowluma__qq_close_conversation';
  write(path.join(dir,'sessions.json'),{sessions:{[key]:sid}});
  write(path.join(dir,'social-v2.json'),{conversations:{[key]:{agentToken:token,lastUnreadSeq:3}}});
  const packet={messages:[{seq:3,plain:'看看这图，然后结束',hasMedia:true}],recent:[],partial:false,folded:null,readThroughSeq:3};
  const raw='【本轮】'+key+' · private · 17:18:00\n【本回合授权】这是主人私聊：本轮授权。\n【本次消息快照】\n'+JSON.stringify(packet)+'\n【近聊窗口（背景）】\n[]';
  const signed=sealQqWake({dir,write,key,sid,token,text:raw,profile:{fixed:'测试角色',values:{}}});
  const menu=[pic,close,'qq_send_message','qq_get_unread_messages'].map(name=>({name,description:name,parameters:{type:'object'}}));
  for(const scenario of ['ok','interrupted','changed']){
    let calls=0,imageReads=0;
    const msgs=[block('user',signed),block('user','<system-reminder>context</system-reminder>')];
    const adapter=createOpenAiAdapter({readImage:async()=>{imageReads++;return {ref:{mediaType:'image/png'},data:Buffer.from('test')};}},async r=>{
      calls++;
      if(calls===1)return {output:{action:pic,arguments:'{}',text:'',note:''}};
      if(calls===2){assert(r.schema.properties.note.description.includes('$close'));
        return {output:{action:close,arguments:JSON.stringify({key,token:'QQ_SESSION_TOKEN_1'}),text:'',note:'看到了。'}};}
      return {output:{action:'end',arguments:'{}',text:'继续判断。',note:'新的小记。'}};
    },undefined,{stateDir:dir});
    const step=async()=> (await Array.fromAsync(adapter.stream({model:'gpt-6.2-sol',sessionId:sid,tools:menu,messages:msgs}))).find(x=>x.type==='block-end').block;
    const image=await step(),pair=receipt(image,{ok:true});pair[1].content.push({type:'image',attachment:'fixture'});msgs.push(...pair);
    const finish=await step();msgs.push(...receipt(finish,{ok:true,key,lastUnreadSeq:3,closedAt:20,unreadCount:0,wakeKept:true}));
    if(scenario==='changed')msgs[1]=block('user','修改了补充要求');
    if(scenario==='interrupted')msgs.push(block('user','还有新要求'));
    const r=await step();assert.equal(calls,scenario==='ok'?2:3);assert.equal(imageReads,scenario==='ok'?1:2);assert(r.text.includes(scenario==='ok'?'看到了':'新的小记'));
  }
  for(const scenario of ['delivered','new','edited','failed','water','pending','runtime']){
    write(path.join(dir,'social-v2.json'),{conversations:{[key]:{agentToken:token,lastUnreadSeq:3}}});
    let calls=0;
    const msgs=[block('user',signed)];
    const adapter=createOpenAiAdapter({readImage:async()=>({ref:{mediaType:'image/png'},data:Buffer.from('fixture')})},async r=>{
      calls++;
      if(calls===1)return {output:{action:pic,arguments:'{}',text:'',note:''}};
      if(calls===2){
        assert.equal(r.schema.properties.note.description.includes('取图后最新补充'),scenario!=='runtime');
        return {output:{action:'qq_send_message',arguments:JSON.stringify({key,token:'QQ_SESSION_TOKEN_1',messages:['黄色。']}),text:'',note:scenario==='pending'?'':'知道了。'}};
      }
      return {output:{action:'end',arguments:'{}',text:'重新判断。',note:'小记。'}};
    },undefined,{stateDir:dir});
    const step=async()=>(await Array.fromAsync(adapter.stream({model:'gpt-6.2-sol',sessionId:sid,tools:menu,messages:msgs}))).find(e=>e.type==='block-end').block;
    const pair=receipt(await step(),{ok:true});pair[1].content.push({type:'image',attachment:'fixture'});msgs.push(...pair);
    const change=block('user','改一下，只说颜色。');
    if(scenario==='runtime')change.source={kind:'runtime-context'};
    msgs.push(change);
    const sent=receipt(await step(),{ok:true,key,lastUnreadSeq:3,sent:1,failed:0,messageIds:['101']});
    if(scenario==='failed')sent[1].isError=true;
    msgs.push(...sent);
    if(scenario==='new')msgs.push(block('user','还要位置'));
    if(scenario==='edited')change.content[0].text='改成数量';
    if(scenario==='water')write(path.join(dir,'social-v2.json'),{conversations:{[key]:{agentToken:token,lastUnreadSeq:4}}});
    const result=await step();
    assert.equal(calls,scenario==='delivered'?2:3,scenario);
    assert(result.text.includes(scenario==='delivered'?'知道了':'重新判断'),scenario);
  }
});
