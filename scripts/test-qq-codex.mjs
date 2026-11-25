import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {createAdapter,provider} from '../plugins/surfcore/lib/qq-codex-provider.js';
import {readReactionScene} from '../src/qq-reaction.js';
import {readQqMessageFiles} from '../src/qq-message-files.js';
import {createConversationMemory} from '../src/conversation-memory.js';
import {createBiliMemory} from '../src/bili-memory.js';
import {createBiliShareScheduler} from '../src/bili-share-scheduler.js';
import {stickerCandidates} from '../src/sticker-lib.js';

const oldCodexHome = process.env.CODEX_HOME;
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(),'surfcore-catalog-test-'));
process.env.CODEX_HOME = codexHome;
const models = ['gpt-6.1-sol','gpt-6-astra'];
const levels = ['low','medium','high','xhigh','max','ultra'];
const cacheModel = (slug, efforts = levels, modalities = ['text','image'], visibility = 'list') => ({
  slug, display_name:slug, visibility, input_modalities:modalities, context_window:120000,
  default_reasoning_level:efforts[0], supported_reasoning_levels:efforts.map(effort => ({effort})),
});
const saveCatalog = entries => fs.writeFileSync(path.join(codexHome,'models_cache.json'),
  JSON.stringify({models:[...models.map(id => cacheModel(id)), ...entries]}));
saveCatalog([]);
after(() => {
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldCodexHome;
  fs.unlinkSync(path.join(codexHome,'models_cache.json'));
  fs.rmdirSync(codexHome);
});

test('a DSH note stays visible locally and never becomes a QQ draft or forwarded text',async()=>{
  const adapter=createAdapter({},async ({schema})=>{
    assert.ok(schema.required.includes('note'));
    return {output:{action:'end',arguments:'{}',text:'',note:'等对面把阵容贴完，这次先没接话。'}};
  });
  const chunks=await Array.fromAsync(adapter.stream({provider,model:models[0],tools:[{name:'qq_close_conversation'}],messages:[]}));
  const block=chunks.find(c=>c.type==='block-end').block;
  assert.match(block.text,/^【DSH小记】.*阵容/);
  const h=await bridgeHarness();
  try{
    for (const original of [block.text,'目的备忘\n'+block.text]) {
      h.trackTurnEvent('fixture',{type:'turn/start',data:{turn:1}});
      const message={content:[{type:'text',text:original}]};
      h.trackTurnEvent('fixture',{type:'assistant/message',data:{turn:1,message}});
      const result=h.trackTurnEvent('fixture',{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
      assert.equal(message.content[0].text,original);
      assert.equal(result.ended.text,original===block.text?'':'目的备忘');
      if(original===block.text) assert.equal(result.draftOnly,false);
    }
    const prompt=h.buildWakePromptV2('private:123','proactiveCheck');
    assert.match(prompt,/跟对方有关的新进展/);
    assert.doesNotMatch(prompt,/最近在 B 站（真实看过/);
  }finally{await h.close();}
});

test('group names follow the actual account and local slang follows the sentence',async()=>{
  const key='group:456';
  const profile = {[key]:{members:{42:{names:['小叶'],note:'这个群里的旧名片'}},
    terms:[{term:'弱',meaning:'本群用法',forms:['也弱','弱完了']}]}};
  const h=await bridgeHarness({config:{ownerQQ:1234567,admin:1234567,slang:{enabled:true}},files:{
    'dsh/surfcore/config.json':{admin:{qq:'1234567',displayName:'阿平'}},
    'dsh/surfcore/memory/qq-group-notes.json':JSON.stringify(profile)}});
  try {
    const mem=createConversationMemory(path.join(h.temp,'dsh/surfcore/memory'));
    assert.deepEqual(mem.member(key,'42').names,['小叶']);
    assert.equal(mem.member(key,'43'),undefined);
    assert.equal(mem.member('group:123','42'),undefined);
    assert.equal(mem.member('private:42','42'),undefined);
    assert.equal(mem.groupTerms(key,'这题他也弱')[0].meaning,'本群用法');
    assert.deepEqual(mem.groupTerms(key,'这题他也弱化了'),[]);
    assert.deepEqual(mem.groupTerms('group:123','弱',true),[]);
    mem.observe(key,{messageId:'1',userId:'42',time:1},'7','以后叫我小树');
    const reloaded=createConversationMemory(path.join(h.temp,'dsh/surfcore/memory'));
    assert.deepEqual(reloaded.member(key,'42').names,['小树']);
    h.appendSocialV2Message(key,'新名片','这题他也弱','这题他也弱',false,false,'2',[],'42',[]);
    const row=h.buildWakeSnapshotV2(key).messages.at(-1);
    assert.equal(row.sender,'新名片');
    assert.deepEqual(Array.from(row.addressAs),['小树']);
    assert.equal(row.groupUsage[0].term,'弱');
    h.appendSocialV2Message(key,'另一个群名片','收到','收到',false,true,'3',[],'1234567',[]);
    assert.deepEqual(Array.from(h.buildWakeSnapshotV2(key).messages.at(-1).addressAs),['阿平']);
  } finally { await h.close(); }
});

test('slang lookup returns local evidence for an unresolved term and skips it for confirmed words',async()=>{
  const key='group:456';
  const examples=[
    [key,'human','今天的画风又沫了'],[key,'human','今天的画风又沫了'],[key,'human','沫'],
    [key,'ai','我自己猜沫的意思'],['group:789','human','隔壁群的沫'],['private:123','human','私聊的沫']
  ].map(([key,role,text])=>JSON.stringify({key,role,text})).join('\n');
  const h=await bridgeHarness({config:{slang:{enabled:true}},files:{
    'dsh/surfcore/memory/events/qq.jsonl':examples,
    'dsh/surfcore/bili/语感本.md':'给样片标上月釉号，右上角那两位就是版本号。',
    'dsh/surfcore/bili/whale-diary-private.md':'月釉号在私底下还有另一层用法。',
    'dsh/surfcore/memory/qq-group-notes.json':{[key]:{terms:[{term:'绫',meaning:'本地确认的解释'}]}}
  }});
  let server;
  try {
    h.setMode('reserved2');
    server=h.startConsoleServer();
    if (!server.listening) await new Promise(resolve=>server.once('listening',resolve));
    const url=new URL('/api/socialV2/slang/query','http://127.0.0.1:'+server.address().port);
    url.searchParams.set('key',key);
    const headers={'x-console-token':'fixture-console-token','x-agent-token':h.getSocialV2State(key).agentToken};
    const lookup=async term=>{
      url.searchParams.set('q',term);
      const res=await fetch(url,{headers});
      assert.equal(res.status,200);
      return res.json();
    };
    const local=await lookup('沫');
    assert.equal(local.memory.status,'matches');
    assert.deepEqual(local.memory.examples,['今天的画风又沫了']);
    const doc=await lookup('月釉号');
    assert.equal(doc.memory.docs.length,1);
    assert.match(doc.memory.docs[0].text,/版本号/);
    assert.equal((await lookup('缃绡未收录')).memory.status,'empty');
    const known=await lookup('绫');
    assert.equal(known.groupUsage[0].meaning,'本地确认的解释');
    assert.equal(known.memory,undefined);
    assert.equal((await lookup('')).memory,undefined);
    h.cfg.socialV2.recall={enabled:false};
    assert.equal((await lookup('沫')).memory.status,'disabled');
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    await h.close();
  }
});

test('public video selection respects the destination, cold-start preferences and previously sent links',async()=>{
  const key='group:456';
  const profile={note:'本群主动分享王者，不主动发猫狗',prefer:['王者'],avoid:['猫咪']};
  const h=await bridgeHarness({files:{'dsh/surfcore/memory/qq-group-notes.json':{[key]:{shareTopics:profile}}}});
  try {
    h.setMode('reserved2');
    assert.match(h.buildWakePromptV2(key,'proactiveCheck'),/本群主动分享王者/);
    assert.doesNotMatch(h.buildWakePromptV2('group:789','proactiveCheck'),/本群主动分享王者/);
    const dir=path.join(h.temp,'picks');fs.mkdirSync(dir);
    const today=new Date().toISOString().slice(0,10);
    const entries=Array.from({length:19},(_,i)=>({
      id:'bv:BV'+String(i).padStart(10,'0'),bvid:'BV'+String(i).padStart(10,'0'),type:'video',
      title:i===0?'猫咪王者':i===18?'王者赛季':('普通视频'+i),text:'这是至少十八个字的公开视频简介，讨论具体的剪辑方法。',watched:true,
      date:today,score:18,shareable:true,priority:99-i
    }));
    fs.writeFileSync(path.join(dir,'bili-memory.json'),JSON.stringify({entries}));
    const memory=createBiliMemory({stateDir:dir});
    const cards=[];
    const sched=createBiliShareScheduler({stateDir:dir,memory,groups:['456','789'],gapMs:0,
      getAudience:group=>({profile:group===key?profile:null}),
      sendCard:async(group,card)=>{cards.push([group,card.title]);return true;},deliverPrompt:async()=>{}});
    assert.equal((await sched.fireNow()).sent,2);
    assert.deepEqual(cards,[[key,'王者赛季'],['group:789','猫咪王者']]);
    assert.equal(memory.pickShareCard({key,profile}),null);
    assert.equal(memory.pickShareCard({key:'group:987',profile}).title,'王者赛季');
  } finally { await h.close(); }
});

test('an incoming market sticker can be collected from the second image and later found in the library',async()=>{
  const key='group:456', h=await bridgeHarness();
  let server;
  try {
    h.setMode('reserved2');
    const read=h.bot.request.bind(h.bot), uploaded=[];
    h.bot.request=async(action,args)=>{
      if(action==='add_custom_face') {uploaded.push(args.file);return {status:'ok',retcode:0,data:{emoji_id:'fixture-sticker'}};}
      return read(action,args);
    };
    const media=[{kind:'image',file:'first.png'},{kind:'sticker',file:'second.png',subType:'1'}];
    h.appendSocialV2Message(key,'群友','[图片][市场表情]','[图片][市场表情]',false,false,'800',media,'42');
    const hint=h.buildWakePromptV2(key,'message');
    assert.match(hint,/第 2 张.*qq_collect_sticker/);
    server=h.startConsoleServer();
    if(!server.listening) await new Promise(r=>server.once('listening',r));
    const base='http://127.0.0.1:'+server.address().port+'/api/socialV2/';
    const headers={'content-type':'application/json','x-console-token':'fixture-console-token','x-agent-token':h.getSocialV2State(key).agentToken};
    const post=async index=>(await fetch(base+'collect-sticker',{method:'POST',headers,body:JSON.stringify({key,messageId:'800',index,content:'散会时收起板凳'})})).json();
    assert.equal((await post(3)).ok,false);
    const result=await post(2);
    assert.equal(result.ok,true,result.error);
    assert.deepEqual(h.calls.images,['second.png']);
    assert.equal(uploaded.length,1);
    assert.match(uploaded[0],/^base64:\/\/iVBOR/);
    assert.equal(result.sticker.content,'散会时收起板凳');
    const available=await (await fetch(base+'sticker-list?key='+key+'&query='+encodeURIComponent('板凳'),{headers})).json();
    assert.ok(available.stickers.some(s=>s.ref && s.content==='散会时收起板凳'));
  } finally {if(server) await new Promise(r=>server.close(r)); await h.close();}
});

test('browsing stickers surfaces unused alternatives while an explicit number remains exact',()=>{
  const entries=[1,2,3].map(no=>({id:'st'+no,no,content:'举杯庆祝',useCount:no===1?20:0,lastUsedAt:no===1?Date.now():0}));
  for(const q of ['','举杯']) assert.notEqual(stickerCandidates(entries,q,1).stickers[0].ref,'#01');
  assert.equal(stickerCandidates(entries,'#01',1).stickers[0].ref,'#01');
});

test('the video index merges a full watch once and ignores previews, undated imports and partial writes',async()=>{
  const h=await bridgeHarness();
  try {
    const dir=path.join(h.temp,'views');fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir,'bili-dynamics-cache.json'),JSON.stringify({at:Date.now(),items:[{}]}));
    const viewed={bvid:'BV1111111111',title:'剪辑比赛',at:new Date().toISOString(),mode:'full'};
    const rows=[{...viewed,mode:'meta'},viewed,viewed,{...viewed,bvid:'BV2222222222',mode:'meta'},
      {...viewed,bvid:'BV3333333333',unknownDate:true}];
    fs.writeFileSync(path.join(dir,'watch-history.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n{"');
    const memory=createBiliMemory({stateDir:dir,home:h.temp});
    assert.ok((await memory.refresh()).ok);
    const videos=JSON.parse(fs.readFileSync(memory.paths.index)).entries.filter(e=>e.type==='video');
    assert.deepEqual(videos.map(e=>[e.bvid,e.title,e.watched]),[[viewed.bvid,viewed.title,true]]);
  } finally {await h.close();}
});

test('QQ file lookup binds downloads to the original chat and returns typed attachments',async()=>{
  const segment=(name,id)=>({type:'file',data:{name,file_id:id}});
  const raw={group_id:123,message_id:7,message:[segment('便签.txt','1'),segment('图.png','2'),segment('程序.exe','3')]};
  const bot={getMessage:async()=>raw,getGroupFileUrl:async(peer,id)=>{assert.equal(peer,123);return {url:id};}};
  const buffers={'1':Buffer.from('麦芽'),'2':Buffer.from('image')};
  const request={bot,kind:'group',peer:123,messageId:'7',maxCount:5,maxBytes:100,
    imagesEnabled:true,download:async ref=>({buffer:buffers[ref]}),acceptImage:()=>({mimeType:'image/png'})};
  const files=await readQqMessageFiles(request);
  assert.equal(files[0].text,'麦芽');
  assert.equal(files[1].data,buffers['2'].toString('base64'));
  assert.match(files[2].note,/仅提供文件名/);
  assert.equal((await readQqMessageFiles({...request,imagesEnabled:false}))[1].data,undefined);
  await assert.rejects(readQqMessageFiles({...request,peer:321}),/当前会话/);
  await assert.rejects(readQqMessageFiles({...request,kind:'private'}),/当前会话/);
});

test('repeated self-pokes change reaction, preserve speaker and stop at the visible cursor',()=>{
  const msg=(seq, text, extra={})=>({seq,time:seq*60000,text,...extra});
  const poke=(seq,self=true)=>msg(seq,'[拍一拍]',{kind:'poke',poke:{targetIsSelf:self}});
  const history=[poke(1),poke(2),msg(3,'手不累啊',{isSelf:true}),msg(23,'依旧罪己诏'),poke(39)];
  const read=(last,rows=history)=>readReactionScene([{...last}],rows);
  assert.match(read(history[4]).cue,/别继续报数.*不用挨条补/);
  assert.match(read(history[4]).stickerQuery,/顶锅/);
  assert.match(read(history[3]).stickerQuery,/顶锅/);
  assert.equal(read(history[1]).stickerQuery,'');
  assert.equal(read(poke(39,false),[...history.slice(0,-1),poke(39,false)]).stickerQuery,'');
  for (const line of ['历史课上为什么要发罪己诏？','他又写检讨书了','认真问，你数的是谁？']) {
    const rows=[history[2],msg(4,line)];
    assert.equal(read(rows[1],rows).stickerQuery,'');
  }
  assert.equal(read(msg(4,'依旧罪己诏',{mentionedIds:['other']}),[history[2],msg(4,'依旧罪己诏',{mentionedIds:['other']})]).stickerQuery,'');
});

test('DSH retains tool execution and credentials across image, success, and error turns',async()=>{
  const secret='bf'.repeat(24);
  const tools=['qq_send_sticker','qq_send_voice','qq_get_message_images','qq_recall_message','qq_set_my_group_card','qq_close_conversation'].map(name=>({name,parameters:{type:'object'},description:name}));
  const image={attachmentId:'fixture',mediaType:'image/png'};
  const messages=[{role:'system',content:[{type:'text',text:'DSH QQ role '+secret}]},{role:'user',content:[{type:'text',text:'会话令牌 '+secret}]},
    {role:'assistant',content:[{type:'tool-call',name:'qq_get_message_images',id:'old',arguments:JSON.stringify({token:secret})}]},
    {role:'user',content:[{type:'tool-result',toolCallId:'old',content:[{type:'image',attachment:image}]}]},
    {role:'tool',toolCallId:'denied',isError:true,content:[{type:'text',text:'403'}]}];
  const options={provider,model:models[0],messages,tools,reasoningEffort:'high'};
  const files={readImage:async ref=>({ref,data:Buffer.from('mock')})};
  for (const {name} of tools) {
    const adapter=createAdapter(files,async args=>{
      assert.equal(args.effort, 'high');
      assert.ok(!JSON.stringify(args).includes(secret));
      assert.match(args.input[0].text,/403/);
      assert.match(args.system,/DSH QQ role QQ_SESSION_TOKEN_1/);
      assert.doesNotMatch(args.input[0].text,/DSH QQ role/);
      assert.match(args.input[0].text,/"toolCallId":"denied","isError":true/);
      assert.equal(args.input[1].url,'data:image/png;base64,bW9jaw==');
      return {output:{action:name,arguments:'{"token":"QQ_SESSION_TOKEN_1"}',text:''},usage:{inputTokens:8,cachedInputTokens:3,outputTokens:2}};
    });
    const prepared=await adapter.prepareCall(provider,models[0]);
    assert.equal(prepared.model.id,models[0]);
    const chunks=await Array.fromAsync(prepared.stream(options));
    assert.equal(chunks[2].block.name,name);
    assert.equal(JSON.parse(chunks[2].block.arguments).token,secret);
    assert.equal(chunks.at(-2).usage.inputTokens,5);
    assert.equal(chunks.at(-1).reason.kind,'tool-calls');
  }
  const bad=createAdapter(files,async()=>({output:{action:'not_registered',arguments:'{}',text:''}}));
  await assert.rejects(Array.fromAsync(bad.stream(options)),/Unadvertised/);
});

test('operator switches the next QQ turn between both CLI models and DeepSeek; other callers cannot change the setting',async()=>{
  const h=await bridgeHarness({config:{dsh:{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'low'}}});
  const old=process.env.SURFCORE_ROOT;
  let server;
  try {
    h.setMode('reserved2');
    server=h.startConsoleServer();
    if (!server.listening) await new Promise(r=>server.once('listening',r));
    const post=(engine,codexModel,extra={})=>fetch('http://127.0.0.1:'+server.address().port+'/api/dsh/engine',{
      method:'POST',headers:{'content-type':'application/json','x-console-token':'fixture-console-token',...extra},
      body:JSON.stringify({engine,codexModel})});
    assert.equal((await post('codex','invalid')).status,400);
    const token=h.getSocialV2State('group:456').agentToken;
    assert.equal((await post('codex',models[0],{'x-agent-token':token})).status,403);
    fs.mkdirSync(path.join(h.temp,'src'),{recursive:true});
    fs.writeFileSync(path.join(h.temp,'src','bridge.js'),'');
    process.env.SURFCORE_ROOT=h.temp;
    const route=await import('../plugins/surfcore/lib/qq-model-route.js');
    let claimed, held;
    route.apply({on:(name,fn)=>{assert.equal(name,'agent/inbox/claimed');claimed=fn;}});
    const agent={model:{current:()=>held,select:r=>{held=r;}}};
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/dsh/';
    const headers = {'content-type':'application/json','x-console-token':'fixture-console-token'};
    const saveEffort = (engine,reasoningEffort) => fetch(endpoint+'effort',{method:'POST',headers,body:JSON.stringify({engine,reasoningEffort})});
    const settings = async () => (await fetch(endpoint+'model',{headers})).json();
    for (const id of models) {
      const model = await createAdapter({}).resolveModel(provider,id);
      assert.deepEqual(model.reasoning.efforts.map(e=>e.id),levels);
    }
    for (const [engine,id,wanted,effort] of [['codex',models[0],models[0],'low'],['codex',models[1],models[1],'ultra'],['deepseek',models[1],'deepseek-flash','low'],['codex',models[0],models[0],'ultra']]) {
      assert.equal((await post(engine,id)).status,200);
      claimed({agent});
      assert.equal(held.model,wanted);
      assert.equal(held.provider,engine==='codex'?provider:'deepseek-official');
      assert.equal(held.reasoningEffort,effort);
      const current = await settings();
      assert.equal(current.reasoningEffort,effort);
      assert.equal(current.effortEngine,engine);
      if (engine === 'codex') {
        assert.deepEqual(current.options,levels);
        assert.equal(current.default,'low');
        for (const next of levels) {
          assert.equal((await saveEffort(engine,next)).status,200);
          claimed({agent});
          assert.equal(held.reasoningEffort,next);
        }
        assert.equal((await saveEffort(engine,'invalid')).status,400);
        assert.equal((await saveEffort('deepseek','low')).status,409);
        assert.equal((await settings()).reasoningEffort,'ultra');
      } else {
        assert.equal((await saveEffort(engine,'ultra')).status,400);
        assert.equal((await saveEffort(engine,'max')).status,200);
        claimed({agent});
        assert.equal(held.reasoningEffort,'max');
      }
    }
    const newcomer = 'gpt-future-fixture';
    const adapter = createAdapter({}, async ({effort,input}) => {
      assert.equal(effort,'high');
      assert.equal(input.length,1,'text-only model must not receive bytes from history');
      return {output:{action:'end',text:'fixture'}};
    });
    assert.equal((await post('codex',newcomer)).status,400);
    saveCatalog([cacheModel(newcomer,['high'],['text']),cacheModel('reserved-fixture',levels,['text'],'hide')]);
    assert.equal((await post('codex',newcomer)).status,200);
    assert.equal((await post('codex','reserved-fixture')).status,400);
    claimed({agent});
    assert.equal(held.model,newcomer);
    assert.equal(held.reasoningEffort,'high');
    assert.equal((await saveEffort('codex','ultra')).status,400);
    const latest = await settings();
    assert.deepEqual(latest.qqCodexModels.map(item=>item.id),[...models,newcomer]);
    assert.deepEqual(latest.options,['high']);
    assert.equal(latest.reasoningEffort,'high');
    assert.ok((await adapter.listModels()).some(item=>item.id===newcomer));
    assert.equal((await adapter.resolveModel(provider,newcomer)).context.contextWindow,120000);
    await Array.fromAsync(adapter.stream({provider,model:newcomer,reasoningEffort:held.reasoningEffort,
      messages:[{role:'user',content:[{type:'image',attachment:{attachmentId:'fixture'}}]}]}));
  } finally {
    if(old===undefined) delete process.env.SURFCORE_ROOT; else process.env.SURFCORE_ROOT=old;
    if(server) await new Promise(resolve=>server.close(resolve));
    await h.close();
  }
});
