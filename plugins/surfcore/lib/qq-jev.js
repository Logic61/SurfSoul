import {redactForMemory} from '../../../src/memory-card.js?rev=memfix-26a980c2b3';

const model='typesafe/jev-1.14';
const endpoint='https://openrouter.ai/api/alpha/decisions';
const tools={
  qq_list_stickers:['snowluma','从自己的收藏里找表情的名字或编号。',/表情|梗图|动图|会动的|图册/u],
  qq_get_forward_msg:['snowluma','展开合并转发，读取其中的消息。',/转发|聊天记录|聊天合集/u],
  qq_get_message_images:['snowluma','查看聊天图片里的画面或文字。',/照片|截图|图片|图里|图上|这张图/u],
  bilibili_video:['browser','查已指定的哔哩哔哩视频的作者、标题或时长。',/视频|片子|时长|哔哩|B站|BV[\da-z]{10}/iu],
  web_fetch:['web-search-safe','打开指定网址，读取页面原文。',/网页|网站|链接|网址|https?:\/\//iu]
};
const lookup=/查|核对|核一下|读|找|翻|看[看下眼]|看一[下眼]|帮我看|搜|给我|告诉我|编号|名字|叫什么|原话|哪|谁|几|多久|多长|什么颜色/u;
const continuation=/^(?:好[的啊呀]?|嗯+|对|行[啊呀]?|可以|那|就|帮我看|你看|按刚才|照你说的|麻烦你|看看吧)/u;
const cancel=/不用|不必|不要|别(?:再|去)?(?:查|找|读|翻|看)|算了|算啦|先放放|不需要|我找到了|我找到啦|我已经查/u;
function plain(row) {
  if (typeof row?.plain==='string') return row.plain;
  return typeof row?.text==='string' && !/【(?:本轮|会话令牌)|\[引用/u.test(row.text)?row.text:'';
}
const bv=/\bBV[0-9a-z]{10}\b/i;
const url=/https?:\/\/\S+/i;

// Leave chat metadata, attachments, URLs, identifiers and credentials out of the second provider.
function excerpt(text,limit) {
  return redactForMemory(text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[邮箱]')
    .replace(/\bBearer\s+\S+/gi,'[凭据]').replace(/\bQQ_SESSION_TOKEN_\d+\b/g,'[凭据]'),
    {scope:'shared',maxChars:limit});
}

export async function jevDecision(state,question,{signal,timeoutMs=2500,fetchImpl=fetch}={}) {
  const key=process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw Error('missing-key');
  const started=performance.now(),timeout=AbortSignal.timeout(timeoutMs);
  const response=await fetchImpl(endpoint,{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout,
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model,state,questions:{decision:question}})});
  if (!response.ok) throw Error('HTTP '+response.status);
  const data=await response.json();
  if (!data.answers?.decision || !Number.isSafeInteger(data.usage?.input_tokens) || data.usage.input_tokens<0) throw Error('invalid-response');
  const resolved=/^typesafe\/jev-[\d.-]+$/.test(data.model)?data.model:model;
  return {answer:data.answers.decision,model:resolved,input:data.usage.input_tokens,
    output:Number.isSafeInteger(data.usage.output_tokens)?data.usage.output_tokens:undefined,
    cost:Number.isFinite(data.usage.cost)?data.usage.cost:undefined,ms:Math.round(performance.now()-started)};
}

function previousReply(wake) {
  const current=wake.incoming;
  const rows=[...wake.window,...wake.recent];
  if (wake.group || current.quoteTargetIsSelf || current.replyToMessageId || /\[引用/u.test(current.text || '')) {
    const id=current.replyToMessageId;
    return id && current.quoteTargetIsSelf ? plain(rows.find(r=>r?.isSelf && String(r.messageId)===String(id))) : '';
  }
  // Sent QQ messages often have a time and a messageId but no seq.
  const byTime=Number.isFinite(current.time);
  const key=byTime?'time':'seq';
  const prior=rows.filter(r=>r && !r.history && Number.isFinite(r[key]) && r[key]<current[key])
    .sort((a,b)=>b[key]-a[key]);
  if (!prior[0]?.isSelf || prior.some((r,i)=>i>0 && r[key]===prior[0][key] &&
      (!r.isSelf || !r.messageId || String(r.messageId)!==String(prior[0].messageId) || plain(r)!==plain(prior[0])))) return '';
  if (byTime && current.time-prior[0].time>30*60000) return '';
  return plain(prior[0]);
}

function explicitTool(text,msg) {
  if (bv.test(text)) return 'bilibili_video';
  if (url.test(text)) return 'web_fetch';
  if (/收藏.{0,6}(?:表情|动图)|表情收藏/u.test(text)) return 'qq_list_stickers';
  if (msg?.hasForward || /合并转发/u.test(text)) return 'qq_get_forward_msg';
  if (msg?.hasMedia && /图里|图上|截图|照片|这张图/u.test(text)) return 'qq_get_message_images';
}

const configuredMode=()=>process.env.SURFCORE_QQ_JEV || 'auto';
const configuredKey=()=>!!process.env.OPENROUTER_API_KEY?.trim();
export function qqJevStatus() {
  const mode=configuredMode();
  return {mode:['auto','rules'].includes(mode)?mode:'off',model,keyConfigured:configuredKey()};
}
export function createQqPreloader({decide=jevDecision,mode=configuredMode,hasKey=configuredKey,onMetric=()=>{}}={}) {
  // Store only the decision for a signed wake, never the excerpts. Concurrent retries may use the original menu.
  const cache=new Map();
  let retryAt=0;
  return async function preload(wake,hidden,signal) {
    const setting=mode();
    if (!wake?.id || !['auto','rules'].includes(setting) || !hidden.length) return;
    const msg=wake.incoming;
    if (!msg || msg.isSelf || msg.history || (wake.group && !msg.atSelf && !msg.quoteTargetIsSelf)) return;
    const names=new Map();
    for (const name of hidden) {
      const short=name.split('__').at(-1);
      if (!Object.hasOwn(tools,short)) continue;
      if (name===short || name==='mcp__'+tools[short][0]+'__'+short) names.set(short,name);
    }
    const current=plain(msg).trim();
    if (!names.size || !current || current.length>450 || (msg.tail && (typeof msg.tail!=='string' || msg.tail.trim()!==current)) || cancel.test(current)) return;
    const follows=continuation.test(current) && current.length<=70;
    const currentTopic=Object.values(tools).some(([, ,cue])=>cue.test(current));
    const prior=follows && !currentTopic?previousReply(wake):'';
    const request=lookup.test(current), combined=[prior,current].filter(Boolean).join('\n');
    const direct=request?explicitTool(current,msg):undefined;
    const fromPrior=prior && !cancel.test(prior) && (bv.test(prior) || url.test(prior)) ? explicitTool(prior) : undefined;
    const known=direct || fromPrior;
    if (known) {
      if (names.has(known)) {onMetric({source:'rule',choice:known});return names.get(known);}
      return;
    }
    if (setting!=='auto' || (!request && !prior) || ![...names.keys()].some(n=>tools[n][2].test(combined))) return;
    if (!hasKey() || Date.now()<retryAt) return;
    signal?.throwIfAborted();
    const cacheKey=wake.id+'|'+[...names.values()].join(',');
    const entry=cache.get(cacheKey);
    if (entry && entry.until>Date.now()) return entry.name;
    if (cache.size>=128) cache.delete(cache.keys().next().value);
    cache.set(cacheKey,{until:Date.now()+120000});
    const state={最新用户消息:excerpt(current,240)};
    if (prior) state.上一条助手消息=excerpt(prior,180);
    const criteria={standard:'沿用已有工具与主模型流程。',...Object.fromEntries([...names.keys()].map(n=>[n,tools[n][1]]))};
    const started=performance.now();
    let result;
    try {
      result=await decide(state,{type:'choice',instructions:'根据最新来信及直接前文，哪一个只读工具需要提前展示？若无需新工具、意图不明或仍需权衡，选 standard。',criteria},{signal});
      signal?.throwIfAborted();
    } catch(error) {
      signal?.throwIfAborted();
      retryAt=Date.now()+30000;
      onMetric({source:'fallback',reason:/^HTTP \d{3}$/.test(error?.message)?error.message:'unavailable',ms:Math.round(performance.now()-started)});
      return;
    }
    const {choice,probabilities}=result.answer??{},prob=probabilities?.[choice];
    const selected=names.has(choice) && Number.isFinite(prob) && prob>=0.60 && prob<=1 ? names.get(choice) : undefined;
    cache.set(cacheKey,{until:Date.now()+120000,name:selected});
    onMetric({source:'jev',choice:selected?choice:'standard',model:result.model,input:result.input,output:result.output,cost:result.cost,ms:result.ms});
    return selected;
  };
}
