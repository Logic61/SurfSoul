import assert from 'node:assert/strict';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {effectiveContextRotationThreshold} from '../src/conversation-closure.js';
import {createOpenAiAdapter,createAdapter} from '../plugins/surfcore/lib/qq-codex-provider.js';
import {openAiQqTurn} from '../plugins/surfcore/lib/qq-openai-api.js';

const cfg={rotateAfterContextTokens:220000};
assert.equal(effectiveContextRotationThreshold(cfg,128000),99123);
assert.equal(effectiveContextRotationThreshold(cfg,500000),220000);
assert.equal(effectiveContextRotationThreshold({rotateAfterContextTokens:0},128000),0);
const key='private:123';
async function bridgeCase({sample,projected,busy=false,blank=false,expected,enabled=220000,model='gpt-4o'}) {
  const h=await bridgeHarness({config:{dsh:{qqEngine:'openai-api',qqOpenAiModel:model},
    allow:{private:[123]},socialV2:{closure:{rotateAfterContextTokens:enabled}}}});
  try {
    h.setMode('reserved2');
    let reads=0;
    const orig=h.api.callUnary;
    h.api.callUnary=async (m,p)=>{
      if (m!=='session/projections')return orig(m,p);
      reads++;
      return {result:{ok:true,value:{values:{inbox:{'next-turn':busy?[{itemId:'fixture'}]:[],'next-step':[]},
        ...(blank?{sessionListMetadata:{blank:true},sessionStats:{turns:0}}:{}),
        ...(projected===undefined?{}:{contextPressure:{pressureTokens:projected,projectedTokens:projected}})}}}};
    };
    const old=await h.ensureSession(key);
    if (sample) h.tokenLedger.ingestEvent({sessionId:old,event:{type:'assistant/message',seq:2,time:Date.now(),
      data:{turn:1,step:1,usage:{inputTokens:sample,outputTokens:1}}}});
    const result=await h.deliverPrompt(key,'synthetic same prompt', {silent:true});
    if(expected==='defer') {
      assert.equal(result.deferredContext,true);assert.equal(h.calls.prompts.length,0);
      assert.equal(h.state.sessions[key],old);assert.equal(h.calls.archived.length,0);assert(reads>0);
    } else {
      assert.equal(result.ok,true);assert.equal(h.calls.prompts.length,1);
      assert.equal(h.calls.prompts[0].sessionId===old,expected==='same');
      if(expected==='new'){
        await new Promise(r=>setTimeout(r,15));
        assert.deepEqual(h.calls.archived,[old]);
        assert.equal(h.calls.created.length,2);
      }
    }
  } finally {await h.close();}
}
await bridgeCase({sample:184729,projected:184749,expected:'new'});
await bridgeCase({sample:184729,projected:184749,busy:true,expected:'defer'});
await bridgeCase({projected:184749,expected:'new'});
await bridgeCase({expected:'defer'});
await bridgeCase({blank:true,expected:'same'});
await bridgeCase({sample:184729,projected:184749,enabled:0,expected:'same'});
await bridgeCase({sample:184729,projected:184749,model:'gpt-6.2-sol',expected:'same'});
const messages=[{role:'user',content:[{type:'text',text:'SYNTHETIC: summarize these turns.'}]}];
const request={model:'gpt-4o',purpose:'compaction',maxTokens:800,messages,tools:[{name:'send_qq'}]};
let roundTrips=0;
const wrapped=reply=>createOpenAiAdapter({},turn=>openAiQqTurn(turn,{key:'test-only',fetchImpl:async(url,init)=>{
  roundTrips++;
  assert.equal(url,'https://api.openai.com/v1/responses');
  const body=JSON.parse(init.body);
  assert.equal(body.text,undefined);assert.equal(body.tools,undefined);assert.equal(body.reasoning,undefined);
  assert.equal(body.max_output_tokens,800);assert(!init.body.includes('send_qq'));
  return {ok:true,json:async()=>({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:reply}]}]})};
}}));
let result=await Array.fromAsync(wrapped(' fixture plain summary ').stream(request));
assert.equal(result.find(x=>x.type==='block-end').block.text,'fixture plain summary');
assert(!result.some(x=>x.type==='tool-call-delta'));
await assert.rejects(Array.fromAsync(wrapped('  ').stream(request)),/非空文本/);
await assert.rejects(Array.fromAsync(wrapped('never').stream({...request,messages:[{role:'user',content:[{type:'text',text:'x'.repeat(130000)}]}]})),/超出.*上下文预算/);
assert.equal(roundTrips,2);
const fakeCodex=createAdapter({},async task=>{
  assert.equal(task.purpose,'compaction');assert.equal(task.schema,undefined);
  return {output:'fixture Codex summary'};
});
const codexModel=(await fakeCodex.listModels())[0].id;
assert.equal((await Array.fromAsync(fakeCodex.stream({...request,model:codexModel}))).find(x=>x.type==='block-end').block.text,'fixture Codex summary');
console.log('QQ model-aware rotation, protected preflight and dedicated summary tests passed');
