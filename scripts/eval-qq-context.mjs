// Opt-in live model comparison. Every message, result, token and destination here is a fixture.
// --jev-pair/--jev-probes also use OpenRouter with synthetic text. No DSH or QQ endpoint is invoked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createOpenAiAdapter} from '../plugins/surfcore/lib/qq-codex-provider.js';
import {openAiQqTurn} from '../plugins/surfcore/lib/qq-openai-api.js';
import {sealQqWake} from '../src/qq-wake-checkpoint.js';
import {makeExperiment,runDecisionProbes,runHistoryProbes} from './eval-qq-jev-router.mjs';
import {createQqPreloader} from '../plugins/surfcore/lib/qq-jev.js';

if (!process.argv.includes('--live')) throw new Error('Run with --live to use the paid model with synthetic inputs.');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-context-paired-'));
const followups=process.argv.includes('--jev-followups');
const productionPair=process.argv.includes('--jev-production');
const jevPair=productionPair || followups || process.argv.includes('--jev-pair');
const key='private:10001', sid='fixture-room', token='ac'.repeat(24);
const text=(role,s)=>({role,content:[{type:'text',text:s}]});
function write(file,data) { fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data)); }
const send='qq_send_message',fetchPage='web_fetch',stickers='qq_list_stickers';
const source=fs.readFileSync(new URL('../src/mcp-snowluma-safe.js',import.meta.url),'utf8');
// Public repository descriptions, no runtime tool registry or user data.
const defs=[...source.matchAll(/server\.tool\(\s*'([\w]+)',\s*'([^'\r\n]+)'/g)].map(m=>[m[1],m[2]]);
const pick=defs.filter(([n])=>/^qq_(?:get|list|search|slang_query|close_conversation|mark_read|send_message|recall$|status|social_state|memory_query|report_feedback|wait_for_messages|set_wake_config)/.test(n));
const p=(name)=>({type:'object',properties:name===send?{key:{type:'string'},token:{type:'string'},messages:{type:'array',items:{type:'string'}}}:
  name===fetchPage?{url:{type:'string'}}:{key:{type:'string'},token:{type:'string'}},required:name===send?['key','token','messages']:name===fetchPage?['url']:['key','token']});
const tools=[...new Map([...pick,[fetchPage,'读取指定 URL 的公开网页并返回当时正文。'],[stickers,'列出当前会话的收藏表情名称和编号。']]).entries()]
  .map(([name,description])=>({name,description,parameters:p(name)}));
if(jevPair) tools.push({name:'bilibili_video',description:'按 BV 号读取视频标题、UP 主和时长。',parameters:{type:'object',properties:{bvid:{type:'string'}},required:['bvid']}});
if (tools.length<=24) throw Error('Fixture lacks enough tools to exercise discovery');
const profile={fixed:'你叫小棠，和对方熟。用自然、简短的中文说话。',values:{persona:'亲切、直说，保留准确的原话和数字。'}};
const system='你是小棠，在 QQ 和一位熟人对话。工具成功才算真的发送。仅处理本轮消息，遵照本轮授权。查事实先读资料。请用一次成功的发送回复对方，确认成功就 end。';
const opening=text('user','【本会话总提示】\n【你的身份】小棠\n【会话令牌】'+token);
const old=text('user','【历史摘要】前几天一起看了书展的旧排期，已经聊完。\n【会话令牌】'+token);
const schedule=(i)=>['西侧入口','资料区','北区展棚','南区舞台'][i%4]+'，第'+(i+1)+'号时段。签到者请在当日留意电子公告，现场顺序以值班台最新安排为准。';
const history=[old];
for(let i=0;i<3;i++) {
  const id='old-'+i;
  history.push({role:'assistant',content:[{type:'tool-call',name:fetchPage,id,arguments:'{"url":"https://fixture.invalid/archive"}'}]},
    {role:'tool',toolCallId:id,content:[{type:'text',text:Array.from({length:70},(_,j)=>schedule(i*70+j)).join('\n')}]});
}
const page=Array.from({length:240},(_,i)=>i===113?'执行通知：东门候场在青榆棚，入场时间 17:42。雨天集合点为栖石厅。':schedule(i)).join('\n');
const cases=[
  {id:'notice',question:'帮我读 https://fixture.invalid/notice 的执行通知，告诉我东门在哪个棚候场、几点入场。',compressed:true},
  {id:'stickers',question:'帮我翻一下收藏表情。适合周一早八的那张，回我它的准确编号和名字就行，用文字。',compressed:true},
  {id:'crossread',question:'请先读 https://fixture.invalid/notice 主公告，再读 https://fixture.invalid/addendum 补充单。按补充单的要求回复我，资料中的哪个名称都不要猜。',compressed:true},
  {id:'correction',question:'之前约的七点改啦。周五八点，地点换到北门。你回我一句确认，别加别的。',compressed:false}
];
if(jevPair) cases.push(
  {id:'video',question:'BV1xx411c7mD 的 UP 主是谁、视频多长？帮我查下，回这两项就好。',compressed:true},
  {id:'negated',question:'不用再翻收藏表情啦。之前约的七点改周五八点北门，你回一句确认就好。',compressed:false});
if(followups || productionPair) cases.splice(followups?0:cases.length,followups?cases.length:0,
  {id:'album-followup',task:'stickers',compressed:true,previous:'我可以翻一下我攒的那些会动的小家伙，看看周一早八该配哪张，把正式名字和登记号给你。',question:'对，就照你说的办，我只要那两个。'},
  {id:'clip-followup',task:'video',compressed:true,previous:'我可以核一下 BV1xx411c7mD 这条片子是谁投的、全片几分几秒。',question:'行，给我这两个数据信息。'},
  {id:'topic-change',task:'negated',compressed:true,previous:'我可以挑一个收藏表情当作我们约时间的暗号。',question:'暗号先放放，改到周五八点北门吧。你只回一句确认。'},
  {id:'two-notices',task:'crossread',compressed:true,previous:'要不要我先读 https://fixture.invalid/notice 的主公告，再读 https://fixture.invalid/addendum 的更正，照更正里的要求回答？',question:'对，按刚才说的顺序，别漏了更正里要问的。'});
const tests=process.argv.filter(x=>x.startsWith('--case=')).map(x=>x.slice(7));
if(productionPair) cases.push({id:'indirect-album',task:'stickers',compressed:true,question:'帮我翻翻你攒的那些会动的小家伙，周一早八那张，登记的名字和编号是什么？'});
const model='gpt-6.2-sol';
const finishPair=jevPair || process.argv.includes('--finish-pair');
async function cacheSequence() {
  // Fixed synthetic context, changing observations, equal calls and equal schema in both arms.
  const runId=Date.now().toString(36);
  const sys='本次演练编号 '+runId+'。你是书展值班员。只在 text 填入最新交接单所问摊位的暗号，action 填 end。\n'+
    Array.from({length:65},(_,i)=>'值班规则第'+i+'条：核对书目和展棚名称，保持登记编号的原顺序。').join('\n');
  const background='【会话背景】演练 '+runId+' 书展各展棚登记表\n'+Array.from({length:185},(_,i)=>
    '编号 '+i+' 的展棚，交接暗号是榆木'+(137*i+19)+'。').join('\n');
  const schema={type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['end']},text:{type:'string'}},required:['action','text']};
  const message=(role,str)=>({role,content:[{text:str}]});
  for(let i=0;i<4;i++) for(const stablePrefix of (i%2?[true,false]:[false,true])) {
    const n=[84,31,132,77][i],expect='榆木'+(137*n+19);
    const envelope={tools:[],messages:[message('user',background),message('user','根据每步最新交接单回复。'),
      message('tool','交接单 '+(i+1)+'：请查 '+n+' 号展棚的交接暗号。')]};
    const r=await openAiQqTurn({model,effort:'low',system:sys,stablePrefix,schema,input:[{type:'text',text:JSON.stringify(envelope)}]});
    console.log(JSON.stringify({probe:'fixed-prefix',step:i+1,stablePrefix,...r.usage,passed:r.output.text.includes(expect)}));
  }
}
async function episode(c,baseline,round,arm) {
  const task=c.task ?? c.id;
  const previous=!finishPair && baseline;
  const stateDir=path.join(dir,String(round),c.id,arm ?? (baseline?'baseline':'candidate'));
  write(path.join(stateDir,'sessions.json'),{sessions:{[key]:sid}});
  write(path.join(stateDir,'social-v2.json'),{conversations:{[key]:{agentToken:token,lastUnreadSeq:21}}});
  const msg={seq:21,plain:c.question,sender:'阿青',messageId:'21'};
  const recent=c.previous?[{seq:20,plain:c.previous,sender:'小棠',isSelf:true,messageId:'20'}]:[];
  const packet={messages:[msg],recent,partial:false,folded:null,...(finishPair?{readThroughSeq:21}:{})};
  const body='【本轮】'+key+' · private · 14:00:00\n【本回合授权】这是主人私聊：使用本轮允许的工具。\n【本次消息快照】\n'+JSON.stringify(packet)+'\n【近聊窗口（背景）】\n[]';
  const wake=previous?body:sealQqWake({dir:stateDir,write,key,sid,token,profile,text:body});
  const messages=[...(c.compressed?history:[opening,...history.slice(1)]),text('user',wake)];
  let deliveries=[],attempts=0,steps=0,ended=false,journal=false;
  const actions=[],metrics=[],pages=[];
  const enabled=finishPair && !baseline;
  const experiment=arm && makeExperiment(productionPair?'sol':arm,c.question,{previous:c.previous,minimum:followups?0.60:0.80}), episodeStart=performance.now();
  const routing=[];
  const withPreload=arm==='production' || arm==='rules';
  const preload=withPreload?createQqPreloader({mode:()=>arm==='rules'?'rules':'auto',onMetric:m=>routing.push(m)}):undefined;
  const adapter=createOpenAiAdapter({},experiment?.run ?? openAiQqTurn,m=>metrics.push(m),{stateDir,previous,finishEnabled:enabled,cachePrefix:enabled,preload});
  for(;steps<8;steps++) {
    const events=await Array.fromAsync(adapter.stream({model,reasoningEffort:'low',sessionId:sid,system,messages,tools}));
    const block=events.find(e=>e.type==='block-end')?.block;
    if (block?.type!=='tool-call') {ended=true;journal=block?.text?.includes('【DSH小记】') || false;break;}
    const args=JSON.parse(block.arguments);actions.push(block.name);messages.push({role:'assistant',content:[block]});
    let result,error=false;
    if (block.name!==fetchPage && block.name!=='bilibili_video' && (args.key!==key || args.token!==token)) {error=true;result='会话参数错误，请使用当前会话令牌。';}
    else if (block.name==='bilibili_video' && args.bvid==='BV1xx411c7mD') result='视频详情：UP 主 秋灯观测站；时长 06:23。';
    else if (block.name===fetchPage && args.url==='https://fixture.invalid/notice') {pages.push('notice');result=page;}
    else if (block.name===fetchPage && args.url==='https://fixture.invalid/addendum' && task==='crossread') {pages.push('addendum');result='补充单：请从主公告的执行通知摘出雨天集合地点和准确入场时间，回给对方。';}
    else if (block.name===stickers) result='收藏目录：E-73《早八还在加载》、S-29《今晚看月亮》、J-04《周末打球》。';
    else if (block.name===send) {
      const reply=[args.messages].flat().join(' ');
      if (task==='notice' && attempts++===0) { error=true;result='未送达。对方刚补问了雨天集合点，请一并写明后再发。'; }
      else {deliveries.push(reply);result=finishPair?JSON.stringify({ok:true,key,sent:[args.messages].flat().length,failed:0,lastUnreadSeq:21,messageIds:[args.messages].flat().map((_,i)=>String(300+i))}):'已送达，消息编号 '+(300+deliveries.length)+'。';}
    } else if (block.name==='qq_close_conversation' && finishPair) result=JSON.stringify({ok:true,key,closedAt:12000,lastUnreadSeq:21,unreadCount:0,wakeKept:true});
    else if (block.name==='qq_close_conversation' || block.name==='qq_mark_read') result='已完成。';
    else {error=true;result='此工具没有提供与请求相关的可用资料。';}
    messages.push({role:'tool',toolCallId:block.id,isError:error,content:[{type:'text',text:result}]});
  }
  const reply=deliveries.join(' ');
  const facts=task==='notice'?['青榆棚',/17[:：]42/, '栖石厅']:task==='crossread'?['栖石厅',/17[:：]42/]:task==='stickers'?['E-73','早八还在加载']:task==='video'?['秋灯观测站',/0?6[:：]23|6\s*分(?:钟)?\s*23\s*秒/]: [/周五|星期五|礼拜五/,/八点|8点|8[:：]00/,'北门'];
  const matched=facts.filter(f=>f instanceof RegExp?f.test(reply):reply.includes(f)).length;
  const required=task==='notice'?fetchPage:task==='stickers'?stickers:task==='video'?'bilibili_video':null;
  const sum=k=>metrics.reduce((v,m)=>v+(m.usage[k]||0),0);
  const result={case:c.id,round,version:finishPair?(baseline?'before-finish':'after-finish'):previous?'previous':'current',model,tools:tools.length,calls:metrics.length,hostSteps:Math.min(steps+1,8),journal,writes:sum('cacheWriteInputTokens'),
    input:sum('inputTokens'),cached:sum('cachedInputTokens'),output:sum('outputTokens'),actions,local:metrics.map(m=>m.contextAction).filter(Boolean),
    deliveries:deliveries.length,matched,facts:facts.length,ended,passed:ended && matched===facts.length && deliveries.length===1 && (!required || actions.includes(required)) && (task!=='crossread' || pages.indexOf('notice')>=0 && pages.indexOf('addendum')>pages.indexOf('notice')),reply};
  if(experiment){
    result.version=arm;
    result.calls=experiment.modelCalls.length;
    result.decisions=withPreload?routing:experiment.decisions;
    result.actionsBySol=experiment.modelCalls.map(m=>m.action);
    result.elapsedMs=Math.round(performance.now()-episodeStart);
    result.passed &&= journal && (task!=='negated' || !actions.includes(stickers));
  }
  console.log(JSON.stringify(result));
}
try {
  if (process.argv.includes('--jev-probes')) await runDecisionProbes();
  else if (process.argv.includes('--jev-history')) await runHistoryProbes();
  else if (process.argv.includes('--cache-sequence')) await cacheSequence();
  else for(const [i,c] of cases.entries()) if(!tests.length || tests.includes(c.id)) {
    // Alternate arm order. Cached and uncached input are reported separately.
    const repetitions=Number(process.argv.find(a=>a.startsWith('--repeat='))?.slice(9) || 1);
    if (![1,2,3].includes(repetitions)) throw Error('--repeat must be 1, 2 or 3');
    for (let round=1;round<=repetitions;round++) {
      if(jevPair){
        const arms=productionPair?(process.argv.includes('--with-rules')?['sol','rules','production']:['sol','production']):['sol','keywords','jev'];
        for(let j=0;j<arms.length;j++) await episode(c,false,round,arms[(i+round+j-1)%arms.length]);
      } else for(const previous of ((i+round)%2?[true,false]:[false,true])) await episode(c,previous,round);
    }
  }
} finally {
  if (path.dirname(path.resolve(dir))===path.resolve(os.tmpdir()) && path.basename(dir).startsWith('qq-context-paired-')) fs.rmSync(dir,{recursive:true,force:true});
}
