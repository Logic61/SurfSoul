import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {ratesAt} from '../src/model-prices.js';
import {MODELSNEXUS_PROVIDER,MODELSNEXUS_URL,discoverModelsNexusModels,modelsNexusTurn,resolveModelsNexusKey}
  from '../plugins/surfcore/lib/qq-modelsnexus.js';

const claude='claude-sonnet-5', gemini='gemini-4-carbon';
const readKey=family=>({claude:'fixture-claude',gemini:'fixture-gemini'}[family]);
const modelPayload={data:[{id:claude,supported_endpoint_types:['anthropic','openai']},{id:gemini,supported_endpoint_types:['openai']},
  {id:claude},{id:'google/gemini-4-carbon'},{id:'gemini-3-flash-image'},{id:'claude-native-1',supported_endpoint_types:['anthropic']},
  {id:'gpt-6.2-sol'},{id:'anthropic/gemini-bad-1'},{id:'claude-unsafe/../token'},{id:'claude-trailing\n'}]};

test('discovery uses the two keys separately and filters each catalogue independently',async()=>{
  const requests=[];
  const fetchImpl=async (url,req)=>{
    assert.equal(url,MODELSNEXUS_URL+'/v1/models');
    assert.equal(req.redirect,'error');
    assert.equal(req.method,'GET');
    requests.push(req.headers.Authorization);
    return Response.json(modelPayload);
  };
  const catalog=await discoverModelsNexusModels({fetchImpl,readKey});
  assert.deepEqual(requests.sort(),['Bearer fixture-claude','Bearer fixture-gemini']);
  assert.deepEqual(catalog.models.map(m=>m.id),[claude,gemini,'google/gemini-4-carbon']);
  assert.deepEqual(catalog.families.map(s=>s.count),[1,2]);
  assert.doesNotMatch(JSON.stringify(catalog),/fixture-/);
  const partial=await discoverModelsNexusModels({readKey,fetchImpl:(url,req)=>
    req.headers.Authorization.endsWith('claude') ? new Response('fixture-key-in-error',{status:401}) : fetchImpl(url,req)});
  assert.deepEqual(partial.models.map(x=>x.id),[gemini,'google/gemini-4-carbon']);
  assert.equal(partial.families[0].httpStatus,401);
  assert.doesNotMatch(JSON.stringify(partial),/fixture-key-in-error/);
  requests.length=0;
  assert.equal((await discoverModelsNexusModels({fetchImpl,readKey:()=>''})).families[0].status,'unconfigured');
  assert.equal(requests.length,0);
});

test('Windows resolution prefers the exact process variable and never uses the other key',async()=>{
  const hit=[];
  const opts={env:{CLAUDE_KEY:' inherited '},platform:'win32',readUserKey:n=>{hit.push(n);return ' user-key ';}};
  assert.equal(await resolveModelsNexusKey('claude',opts),'inherited');
  assert.equal(await resolveModelsNexusKey('gemini',opts),'user-key');
  assert.equal(await resolveModelsNexusKey('other',opts),'');
  assert.deepEqual(hit,['GEMINI_ROUTER_KEY']);
});

const schema={required:['action','arguments','text'],properties:{action:{enum:['end','qq_read']}}};
const args={model:claude,system:'Instructions',input:[{type:'text',text:'Synthetic question'}],schema};
const choice=(content,finish_reason='stop')=>Response.json({choices:[{finish_reason,message:{content}}],usage:{prompt_tokens:19,
  prompt_tokens_details:{cached_tokens:7,cache_write_tokens:2},completion_tokens:5,completion_tokens_details:{reasoning_tokens:1}}});

test('generation routes by model, maps images and usage, and validates actions before DSH execution',async()=>{
  for (const [model,family] of [[claude,'claude'],['google/'+gemini,'gemini']]) {
    const result=await modelsNexusTurn({...args,model,input:[...args.input,{type:'image',url:'data:image/png;base64,AA=='}]},
      {readKey,fetchImpl:async(url,req)=>{
        assert.equal(url,MODELSNEXUS_URL+'/v1/chat/completions');
        assert.equal(req.redirect,'error');
        assert.equal(req.headers.Authorization,'Bearer fixture-'+family);
        const body=JSON.parse(req.body);
        assert.equal(body.model,model);
        assert.equal(body.messages[0].role,'system');
        assert.match(body.messages[0].content,/qq_read/);
        assert.equal(body.messages[1].role,'user');
        assert.equal(body.messages[1].content[1].image_url.url,'data:image/png;base64,AA==');
        assert.equal(body.tools,undefined);
        return choice('```json\n{"action":"qq_read","arguments":"{}","text":""}\n```');
      }});
    assert.equal(result.output.action,'qq_read');
    assert.deepEqual(result.usage,{inputTokens:19,outputTokens:5,cachedInputTokens:7,cacheWriteInputTokens:2,reasoningOutputTokens:1});
    assert.equal(ratesAt(model,Date.now(),undefined,MODELSNEXUS_PROVIDER).billing,'unpriced');
  }
  await assert.rejects(modelsNexusTurn(args,{readKey,fetchImpl:async()=>choice('{"action":"unknown","arguments":"{}","text":""}')}),/动作校验失败/);
  await assert.rejects(modelsNexusTurn(args,{readKey,fetchImpl:async()=>choice('{}','length')}),/未正常完成/);
  await assert.rejects(modelsNexusTurn(args,{readKey,fetchImpl:async()=>new Response('secret-error-body',{status:403})}),
    e=>/HTTP 403/.test(e.message)&&!/secret-error-body/.test(e.message));
  await assert.rejects(modelsNexusTurn({...args,model:gemini},{readKey:family=>family==='claude'?'other-key':'',
    fetchImpl:()=>assert.fail('must not fall back to the other key')}),/GEMINI_ROUTER_KEY/);
});

test('compaction asks for text, preserves history if too big, and honors abort before using a key',async()=>{
  const result=await modelsNexusTurn({...args,purpose:'compaction',maxTokens:512},{readKey,fetchImpl:async(_url,req)=>{
    const body=JSON.parse(req.body);
    assert.equal(body.max_tokens,512);
    assert.equal(body.messages[0].content,args.system);
    assert.equal(body.messages[1].content,args.input[0].text);
    return choice('  原会话摘要。 ');
  }});
  assert.equal(result.output,'原会话摘要。');
  const blocked={readKey:()=>assert.fail('must not read key'),fetchImpl:()=>assert.fail('must not send')};
  await assert.rejects(modelsNexusTurn({...args,signal:AbortSignal.abort()},blocked),{name:'AbortError'});
  await assert.rejects(modelsNexusTurn({...args,purpose:'compaction',input:[{type:'text',text:'x'.repeat(128000)}]},blocked),/历史保持不变/);
});

test('scoped DSH route follows the saved model, keeps tool execution local, and clears foreign effort',async()=>{
  const h=await bridgeHarness();
  const before=process.env.SURFCORE_ROOT;
  let server;
  try {
    h.setMode('reserved2');
    fs.mkdirSync(path.join(h.temp,'src'),{recursive:true});
    fs.writeFileSync(path.join(h.temp,'src','bridge.js'),'');
    process.env.SURFCORE_ROOT=h.temp;
    const route=await import('../plugins/surfcore/lib/qq-model-route.js');
    const {createModelsNexusAdapter}=await import('../plugins/surfcore/lib/qq-codex-provider.js');
    let claim, held={provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'max'};
    route.apply({on:(event,fn)=>{assert.equal(event,'agent/inbox/claimed');claim=fn;}});
    const agent={model:{current:()=>held,select:r=>{held=r;}}};
    server=h.startConsoleServer();
    if (!server.listening) await new Promise(resolve=>server.once('listening',resolve));
    const endpoint='http://127.0.0.1:'+server.address().port+'/api/dsh/';
    const headers={'content-type':'application/json','x-console-token':'fixture-console-token'};
    const post=(resource,body,auth=headers)=>fetch(endpoint+resource,{method:'POST',headers:auth,body:JSON.stringify(body)});
    assert.equal((await fetch(endpoint+'modelsnexus-models')).status,401);
    assert.equal((await fetch(endpoint+'modelsnexus-models',{headers:{'x-agent-token':h.getSocialV2State('group:456').agentToken}})).status,401);
    assert.equal((await fetch(endpoint+'modelsnexus-models',{headers})).status,200);
    assert.equal((await post('engine',{engine:'modelsnexus',modelsNexusModel:'gpt-4o'})).status,400);
    for (const model of [claude,gemini]) {
      assert.equal((await post('engine',{engine:'modelsnexus',modelsNexusModel:model})).status,200);
      claim({agent});
      assert.deepEqual(held,{provider:MODELSNEXUS_PROVIDER,model,reasoningEffort:undefined});
      const r=await (await fetch(endpoint+'model',{headers})).json();
      assert.equal(r.globalSideEffect,false);
      assert.equal(r.model,model);
      assert.deepEqual(r.options,[]);
    }
    assert.equal((await post('effort',{engine:'modelsnexus',reasoningEffort:'max'})).status,400);
    assert.equal(fs.readdirSync(path.join(h.temp,'_backups')).length,2);
    const adapter=createModelsNexusAdapter({},async({model})=>{
      assert.equal(model,gemini);
      return {output:{action:'qq_read',arguments:'{}',text:''}};
    });
    const events=await Array.fromAsync(adapter.stream({...held,tools:[{name:'qq_read'}],messages:[]}));
    assert.equal(events.find(event=>event.type==='block-end').block.name,'qq_read');
    assert.equal((await post('engine',{engine:'deepseek'})).status,200);
    claim({agent});
    assert.equal(held.provider,'deepseek-official');
  } finally {
    if (before === undefined) delete process.env.SURFCORE_ROOT;
    else process.env.SURFCORE_ROOT=before;
    if (server?.listening) await new Promise(resolve=>server.close(resolve));
    await h.close();
  }
});
