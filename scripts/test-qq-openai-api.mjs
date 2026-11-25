import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverOpenAiQqModels, openAiQqTurn, OPENAI_QQ_PROVIDER } from '../plugins/surfcore/lib/qq-openai-api.js';
import { apply, createOpenAiAdapter } from '../plugins/surfcore/lib/qq-codex-provider.js';
import { MODELSNEXUS_PROVIDER } from '../plugins/surfcore/lib/qq-modelsnexus.js';

const syntheticKey = 'mock-not-a-real-key';
const action = {action:'qq_safe',arguments:'{"token":"QQ_SESSION_TOKEN_1"}',text:''};
const key = syntheticKey;
const token = 'a'.repeat(48); // synthetic; cannot authorize anything
const result = (output, extra={})=>({
  status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(output)}]}],
  usage:{input_tokens:17,output_tokens:8,input_tokens_details:{cached_tokens:3},output_tokens_details:{reasoning_tokens:2}},
  ...extra,
});
const ok = value=>({ok:true,json:async()=>value});
{
  const bg={role:'user',content:[{text:'【会话背景】角色的小本子'}]},wake={role:'user',content:[{text:'本轮来信'}]};
  const envelope={tools:[],messages:[bg,wake,{role:'tool',content:[{text:'工具回执'}]}]};
  const payload={model:'gpt-6.2-sol',effort:'low',stablePrefix:true,system:'宿主指令',input:[{type:'text',text:JSON.stringify(envelope)}],
    schema:{properties:{action:{enum:['end']}},required:['action']}};
  const test=await openAiQqTurn(payload,{key,fetchImpl:async(_,init)=>{
    const request=JSON.parse(init.body);assert.equal(request.instructions,undefined);assert.equal(request.store,false);
    assert.deepEqual(request.text.format,{type:'text'});
    const update=request.input.splice(-2,1)[0];
    assert.equal(update.type,'configuration_update');
    assert.deepEqual(update.text.format.schema,payload.schema);
    assert.equal(update.text.format.strict,true);
    assert.deepEqual(request.input.map(m=>m.role),['developer','user','user','user']);
    assert.equal(request.prompt_cache_options.mode,'explicit');
    assert.deepEqual(request.input.map(m=>m.content[0].prompt_cache_breakpoint?.mode),['explicit','explicit','explicit',undefined]);
    const parts=request.input.map(m=>m.content[0].text);
    assert.equal(parts[0],'宿主指令');assert.deepEqual(JSON.parse(parts[1]),bg);assert.deepEqual(JSON.parse(parts[2]),wake);
    assert.equal(JSON.parse(parts[3]).messages.length,1);assert(!parts[3].includes('小本子'));
    return ok(result({action:'end'},{usage:{input_tokens:100,input_tokens_details:{cached_tokens:55,cache_write_tokens:35},output_tokens:7}}));
  }});
  assert.equal(test.usage.cacheWriteInputTokens,35);
}
{
  const bg={role:'user',content:[{text:'【会话背景】历史资料'}]};
  const wake={role:'user',content:[{text:'【本轮】收到附图'}]};
  const image={role:'tool',toolCallId:'picture',content:[{text:'取图成功'},{image:1}]};
  const amended={role:'user',content:[{text:'只答颜色'}]};
  const sent={role:'tool',toolCallId:'delivery',content:[{text:'已送达'}]};
  const reminder={role:'user',content:[{text:'<system-reminder>runtime</system-reminder>'}]};
  const inline={...wake,content:[...wake.content,{image:1}]};
  async function bodyFor(messages,{cacheFormat=true,imageAmendment=true}={}) {
    let body;
    await openAiQqTurn({model:'gpt-6.2-sol',effort:'low',stablePrefix:true,cacheFormat,imageAmendment,system:'系统规则',
      input:[{type:'text',text:JSON.stringify({messages:[bg,...messages],tools:[{name:'picture'}]})},
        {type:'image',url:'data:image/png;base64,dGVzdA=='}],schema:{properties:{action:{enum:['end']}},required:['action']}},
      {key,fetchImpl:async(_,init)=>{body=JSON.parse(init.body);return ok(result({action:'end'}));}});
    return body.input;
  }
  const q=await bodyFor([wake,image,amended,sent]);
  assert.deepEqual(JSON.parse(q[2].content[0].text),wake);
  assert.equal(q[2].content[0].prompt_cache_breakpoint.mode,'explicit');
  assert.equal(q.at(-2).content[1].type,'input_image');
  assert.deepEqual(JSON.parse(q.at(-2).content[0].text).messages,[image]);
  assert.equal(q.at(-1).role,'user');
  assert.deepEqual(JSON.parse(q.at(-1).content[0].text.split('\n')[0]).messages,[amended,sent]);
  assert.equal(q.at(-1).content[0].prompt_cache_breakpoint,undefined);
  const failed={...sent,isError:true,content:[{text:'发送失败，请处理'}]};
  const retry=await bodyFor([wake,image,amended,failed]);
  assert.deepEqual(JSON.parse(retry.at(-1).content[0].text.split('\n')[0]).messages,[amended,failed]);
  for(const [messages,options,expected] of [
    [[inline,image,amended],{},[inline,image,amended]],
    [[wake,image,amended],{cacheFormat:false},[wake,image,amended]],
    [[wake,image,amended],{imageAmendment:false},[image,amended]],
    [[wake,image,reminder],{},[image,reminder]],
    [[wake,image,amended,{role:'tool',content:[{result:'more',content:[{image:1}]}]}],{},null],
  ]) {
    const items=await bodyFor(messages,options),last=items.at(-1);
    assert.equal(last.content[1].type,'input_image');
    assert.deepEqual(JSON.parse(last.content[0].text).messages,expected ?? messages.slice(1));
  }
}
const packets=[];
const adapter = createOpenAiAdapter({readImage:async()=>({ref:{mediaType:'image/jpeg'},data:Buffer.from('synthetic-image')})},
  turn=>openAiQqTurn(turn,{key,fetchImpl:async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/responses'); assert.equal(init.redirect,'error');
    assert.equal(init.headers.Authorization,'Bearer '+syntheticKey);
    assert.equal(init.method,'POST'); assert(!init.body.includes(token));
    packets.push(JSON.parse(init.body)); return ok(result(action));
  }}));
assert.equal(adapter.providerInfo().id,OPENAI_QQ_PROVIDER);
const providers=[];
apply({attachments:{},llm:{registerAdapter(ids,a){providers.push([ids[0],a.providerInfo().id]);}}});
assert.deepEqual(providers,[['surfcore-codex-cli','surfcore-codex-cli'],[OPENAI_QQ_PROVIDER,OPENAI_QQ_PROVIDER],
  [MODELSNEXUS_PROVIDER,MODELSNEXUS_PROVIDER]]);
const options={model:'gpt-6.2-sol',reasoningEffort:'low',system:'fixture',messages:[{role:'user',content:[{type:'text',text:token},{type:'image',attachment:'fake'}]}],tools:[{name:'qq_safe'}]};
const output=[];
for await (const piece of adapter.stream(options)) output.push(piece);
const request = packets.shift();
assert.equal(request.model,'gpt-6.2-sol');
assert.equal(request.reasoning.effort,'low');
assert.equal(request.store,false);
assert.equal(request.max_output_tokens,4096);
assert.equal(request.tools,undefined);
assert.equal(request.previous_response_id,undefined);
assert.equal(request.text.format.type,'json_schema');
assert.equal(request.text.format.strict,true);
assert.deepEqual(request.text.format.schema.properties.action.enum,['end','qq_safe']);
assert(request.input[0].content[0].text.includes('QQ_SESSION_TOKEN_1'));
assert.equal(request.input[0].content[1].type,'input_image');
assert(request.input[0].content[1].image_url.startsWith('data:image/jpeg;base64,'));
assert.equal(JSON.parse(output.find(x=>x.type==='block-end').block.arguments).token,token);
assert.deepEqual(output.find(x=>x.type==='usage').usage,{inputTokens:14,outputTokens:8,cacheReadTokens:3,cacheWriteTokens:0,reasoningTokens:2});
const turn = {model:'gpt-6.2-astra',system:'fixture',input:[{type:'text',text:'synthetic only'}],schema:request.text.format.schema,effort:'low'};
const end = {action:'end',arguments:'{}',text:'mock'};
assert.deepEqual((await openAiQqTurn(turn,{key,fetchImpl:async()=>ok(result(end))})).output,end);
let calls=0;
await assert.rejects(openAiQqTurn(turn,{key:'',fetchImpl:async()=>{calls++;}}),/OPENAI_API_KEY/);
await assert.rejects(openAiQqTurn({...turn,model:'gpt-4o-realtime-preview'},{key,fetchImpl:async()=>{calls++;}}),/模型兼容性未确认/);
assert.equal(calls,0);
await assert.rejects(openAiQqTurn(turn,{key,fetchImpl:async()=>{calls++;return {ok:false,status:401,json:async()=>{assert.fail('raw error read');}};}}),/HTTP 401/);
assert.equal(calls,1);
await assert.rejects(openAiQqTurn(turn,{key,fetchImpl:async()=>ok(result(end,{status:'incomplete'}))}),/未完成/);
await assert.rejects(openAiQqTurn(turn,{key,fetchImpl:async()=>ok(result(end,{output:[{type:'message',role:'assistant',content:[{type:'refusal'}]}]}))}),/拒绝/);
await assert.rejects(openAiQqTurn(turn,{key,fetchImpl:async()=>ok(result({...end,action:'not_advertised'}))}),/校验失败/);
await assert.rejects(openAiQqTurn(turn,{key,fetchImpl:async()=>ok(result({...end,text:1}))}),/校验失败/);
await assert.rejects(openAiQqTurn(turn,{key,timeoutMs:15,fetchImpl:async(_url,init)=>delay(1000,null,{signal:init.signal})}),/超时/);
const abort=new AbortController();
const interrupted=openAiQqTurn({...turn,signal:abort.signal},{key,fetchImpl:async(_url,init)=>delay(1000,null,{signal:init.signal})});
abort.abort();
await assert.rejects(interrupted,/停止/);
const unsafe=createOpenAiAdapter({},async()=>({output:{...action,action:'unsafe'}}));
await assert.rejects(async()=>{for await(const _ of unsafe.stream({...options,messages:[]})){}},/Unadvertised DSH tool/);
const discovery=await discoverOpenAiQqModels({key,fetchImpl:async(url,init)=>{
  assert.equal(url,'https://api.openai.com/v1/models'); assert.equal(init.method,'GET'); assert.equal(init.body,undefined);
  assert.equal(init.redirect,'error'); assert.equal(init.headers.Authorization,'Bearer '+key);
  return ok({data:[{id:'gpt-6.2-sol'},{id:'gpt-4o'},{id:'chat-latest'},{id:'text-embedding-3-small'},{id:'gpt-4o'},{id:'invalid id'}]});
}});
assert.equal(discovery.status,'ready');
assert.deepEqual(discovery.models.map(m=>m.id),['chat-latest','gpt-4o','gpt-6.2-sol']);
assert.deepEqual(discovery.unverified,['text-embedding-3-small']);
assert.equal(discovery.models[1].legacy,true);
for (const model of ['gpt-4o','gpt-4o-2024-08-06','chat-latest','gpt-4.1']) {
  const resolved=await adapter.resolveModel(OPENAI_QQ_PROVIDER,model);
  assert.equal(Object.hasOwn(resolved,'reasoning'),false);
}
assert.equal((await adapter.resolveModel(OPENAI_QQ_PROVIDER,'gpt-6.2-sol')).reasoning.defaultEffort,'low');
await openAiQqTurn({...turn,model:'gpt-4o',effort:undefined},{key,fetchImpl:async(_url,init)=>{
  assert.equal(JSON.parse(init.body).reasoning,undefined); return ok(result(end));
}});
assert.equal((await discoverOpenAiQqModels({key:'',fetchImpl:async()=>assert.fail('unexpected call')})).status,'unconfigured');
assert.equal((await discoverOpenAiQqModels({key,fetchImpl:async()=>({ok:false,status:401})})).httpStatus,401);
console.log('QQ OpenAI Responses, discovery mock and shared guard: passed');
