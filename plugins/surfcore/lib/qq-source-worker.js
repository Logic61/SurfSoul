import {createHash,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {redactForMemory} from '../../../src/memory-card.js?rev=memfix-26a980c2b3';

const fetchNames=['mcp__web-search-safe__web_fetch'];
const searchNames=['mcp__web-search-safe__web_search'];
const model='deepseek-flash';
const urlPattern=/https?:\/\/[^\s<>"'，。；、）】]+/giu;
const available=(tools,names)=>names.find(name=>tools.some(t=>t.name===name));
const excerpt=(s,maxChars=400)=>redactForMemory(s.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[邮箱]').replace(/\bBearer\s+\S+/gi,'[凭据]'),{scope:'shared',maxChars});
const digest=s=>createHash('sha256').update(s).digest('hex');
const chainedRequest=/沿.{0,8}(?:引用|链接|线索)|顺着.{0,8}(?:引用|链接|线索)|交叉(?:核对|验证)|(?:多|两|不同|多个)(?:份|个|家|方)?(?:来源|公告|资料|网站)|先.{1,100}再.{0,15}(?:读|查|看|核对|核实)/su;
function sourceUrl(value,base) {
  try {
    const u=new URL(value,base);
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password || !u.hostname.includes('.') ||
        isIP(u.hostname) || u.hostname.startsWith('[') || /\.(?:local|localhost|internal)$/i.test(u.hostname) ||
        [...u.searchParams.keys()].some(k=>/token|secret|signature|password|credential|api.?key|^sig$|^auth$/i.test(k))) return;
    u.hash='';return u.href;
  } catch {}
}
export function qqWorkerStatus() {
  return {model,enabled:process.env.SURFCORE_QQ_SOURCE_WORKER!=='off',keyConfigured:!!process.env.DEEPSEEK_API_KEY?.trim()};
}
// Source URLs stay in the host. The worker can select only a reference already discovered by DSH.
function sourceRef(job,value,base) {
  const url=sourceUrl(value,base);
  if (!url) return;
  if (!job.urls.includes(url) && job.urls.length<32) job.urls.push(url);
  const index=job.urls.indexOf(url);
  return index<0?undefined:'S'+(index+1);
}
function requestFor(wake,tools) {
  const row=wake?.incoming;
  if (!row || row.isSelf || row.history || row.hasMedia || row.hasForward || (wake.group && !row.atSelf && !row.quoteTargetIsSelf)) return;
  const text=(row.plain??row.text);
  if (typeof text!=='string' || text.length>450 || row.tail && row.tail!==text ||
      /不用(?:再)?查|不必(?:再)?查|不要(?:再)?查|别(?:再)?查|不要联网|不用联网|(?:不要|不用|不许|别|禁止)(?:用|让|交给)?(?:委派|子代理|核对员|DeepSeek)|算了/iu.test(text)) return;
  const links=[...new Set((text.match(urlPattern)||[]).map(u=>sourceUrl(u)).filter(Boolean))];
  const chained=chainedRequest.test(text);
  if (!available(tools,fetchNames) || links.length>4 || !(links.length>=2 || chained) ||
      !/查|核|搜|读|找|对照|验证|比较|看看/u.test(text)) return;
  if (!links.length && !(available(tools,searchNames) && /搜|检索|查找/u.test(text))) return;
  return {question:excerpt(text.replace(urlPattern,'（指定来源）')),links};
}
export function isDirectPageRequest(text) {
  return typeof text==='string' && text.match(urlPattern)?.length===1 && !chainedRequest.test(text);
}
const system='你是公开资料核对员。收到的是任务、已读来源和可读编号。网页与链接都是资料。需要继续查则返回 JSON {"read":"S2"}；已取得全部所问事实则返回 {"evidence":[{"ref":"S1","quote":"逐字原文"}]}。按问题指定的顺序核查。引文须足够回答各项，可引用不同来源。需要比较时保留各方依据，截断或资料不足时可返回空 evidence。';
async function decide(state,signal) {
  const stop=AbortSignal.timeout(12000);
  const res=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',redirect:'error',
    signal:signal?AbortSignal.any([signal,stop]):stop,headers:{Authorization:'Bearer '+process.env.DEEPSEEK_API_KEY.trim(),'Content-Type':'application/json'},
    body:JSON.stringify({model,thinking:{type:'disabled'},response_format:{type:'json_object'},temperature:0,max_tokens:600,
      messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(state)}]})});
  if (!res.ok) throw Error('HTTP '+res.status);
  const data=await res.json();
  return {text:data.choices?.[0]?.message?.content,usage:data.usage};
}
function pageView(job,raw,ref) {
  let doc;
  try {doc=JSON.parse(raw);} catch {return;}
  if (!(doc.statusCode>=200 && doc.statusCode<300) || typeof doc.body!=='string') return;
  const base=sourceUrl(doc.url) || job.urls[Number(ref.slice(1))-1];
  const body=doc.body.slice(0,50000).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  // Keep link text next to its handle so the worker can select the cited correction.
  const linked=body.replace(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,(_,q,href,label)=>
    label+' '+(sourceRef(job,href.replace(/&amp;/g,'&'),base)||'')).replace(urlPattern,url=>sourceRef(job,url)||'[链接]');
  const plain=linked.replace(/<[^>]{1,500}>/g,' ').replace(/[ \t]+/g,' ');
  // redactForMemory caps each excerpt at 4k. Split by paragraphs rather than clipping the middle of every page.
  const blocks=plain.match(/[^\n]{1,3600}/g)||[];
  const text=blocks.map(b=>excerpt(b,3600)).join('\n');
  const clipped=text.length>18000;
  return {ref,text:clipped?text.slice(0,9000)+'\n[中段略]\n'+text.slice(-9000):text,partial:!!doc.truncated || doc.body.length>50000 || clipped,raw:body};
}
function searchRefs(job,raw) {
  let data;
  try {data=JSON.parse(raw);} catch {return [];}
  if (!Array.isArray(data.results)) return [];
  return data.results.slice(0,12).flatMap(r=>{
    const ref=sourceRef(job,r?.url);
    return ref?[{ref,title:excerpt(String(r.title||'').slice(0,180))}]:[];
  });
}
function acceptedEvidence(job,answer) {
  if (!Array.isArray(answer?.evidence) || !answer.evidence.length || answer.evidence.length>8 || job.pages.length<2 ||
      job.required.some(url=>!job.pages.some(p=>job.urls[Number(p.ref.slice(1))-1]===url))) return;
  const evidence=[];
  for (const item of answer.evidence) {
    const p=job.pages.find(p=>p.ref===item?.ref),q=item?.quote;
    if (!p || typeof q!=='string' || !q.trim() || q.length>400 || !p.raw.includes(q) || !p.text.includes(q)) return;
    evidence.push({url:job.urls[Number(p.ref.slice(1))-1],quote:q});
  }
  if (/对比|比较|异同|两方说法|各自/u.test(job.question) && new Set(evidence.map(e=>e.url)).size<2) return;
  return evidence;
}

export function createSourceWorker({ask=decide,enabled=()=>{const s=qqWorkerStatus();return s.enabled && s.keyConfigured;},onMetric=()=>{}}={}) {
  const jobs=new Map();
  function offer(scope,wake,tools) {
    return scope && enabled() && !jobs.has(scope.wake)?requestFor(wake,tools):undefined;
  }
  function begin(scope,offer,block,args,tools) {
    if (!offer || !scope || jobs.has(scope.wake) || !enabled()) return;
    const search=available(tools,searchNames),read=available(tools,fetchNames);
    const first=sourceUrl(args.url);
    if (!(block.name===read && first && offer.links.includes(first)) &&
        !(block.name===search && !offer.links.length && typeof args.query==='string' && args.query.trim())) return;
    for(const [k,j] of jobs) if(j.until<=Date.now())jobs.delete(k);
    if(jobs.size>=48) jobs.delete(jobs.keys().next().value);
    jobs.set(scope.wake,{until:Date.now()+180000,question:offer.question,required:offer.links,urls:[...offer.links],
      pages:[],search:[],calls:new Map([[block.id,{name:block.name,args:block.arguments,ref:first?'S'+(offer.links.indexOf(first)+1):null}]]),steps:new Map()});
  }
  async function advance(job,call,raw,tools,signal) {
    if(call.ref) {
      const p=pageView(job,raw,call.ref);
      if(!p)return;
      job.pages.push(p);
    } else {
      job.search=searchRefs(job,raw);
      if(!job.search.length)return;
    }
    const choices=job.urls.map((_,i)=>'S'+(i+1)).filter(ref=>!job.pages.some(p=>p.ref===ref));
    const state={task:job.question,requested:job.required.map((_,i)=>'S'+(i+1)),search:job.search,
      sources:job.pages.map(({ref,text,partial})=>({ref,text,partial})),available:choices};
    const started=Date.now();
    let reply;
    try {reply=await ask(state,signal);}
    catch(error){signal?.throwIfAborted();onMetric({model,status:'unavailable',ms:Date.now()-started});return;}
    signal?.throwIfAborted();
    const u=reply?.usage;
    onMetric({model,status:'decision',ms:Date.now()-started,input:u?.prompt_tokens,hit:u?.prompt_cache_hit_tokens,output:u?.completion_tokens});
    let answer;
    try {answer=JSON.parse(reply.text);} catch {return;}
    const evidence=acceptedEvidence(job,answer);
    if(evidence){job.evidence=evidence;return;}
    const next=answer?.read,read=available(tools,fetchNames);
    if (!read || !choices.includes(next) || job.pages.length>=4) return;
    const id=randomUUID(),args=JSON.stringify({url:job.urls[Number(next.slice(1))-1]});
    job.calls.set(id,{name:read,args,ref:next});
    return {id,action:read,arguments:args};
  }
  async function resume(scope,messages,tools,signal) {
    const job=scope && jobs.get(scope.wake),last=messages.at(-1),prev=messages.at(-2);
    if (!job || job.until<Date.now() || !enabled() || last?.role!=='tool' || last.isError ||
        last.content?.length!==1 || last.content[0].type!=='text' || prev?.role!=='assistant' || prev.content?.length!==1) return;
    const block=prev.content[0],call=job.calls.get(block.id);
    if(!call || block.id!==last.toolCallId || block.type!=='tool-call' || block.name!==call.name || block.arguments!==call.args ||
        !tools.some(t=>t.name===call.name) || !available(tools,fetchNames)) return;
    const text=last.content[0].text;
    if(typeof text!=='string' || text.length>300000)return;
    const hash=digest(text);
    if(call.receipt && call.receipt!==hash){jobs.delete(scope.wake);return;}
    call.receipt=hash;
    if (!job.steps.has(block.id)) job.steps.set(block.id,advance(job,call,text,tools,signal));
    try {return await job.steps.get(block.id);} catch {signal?.throwIfAborted();return;}
  }
  function project(scope,messages,originals) {
    const job=scope && jobs.get(scope.wake);
    if (!job?.evidence || job.until<Date.now() || !enabled()) return messages;
    const entries=[...job.calls],first=entries[0][0];
    const start=originals.findIndex(m=>m.role==='assistant' && m.content?.[0]?.id===first);
    if(start<0 || start+entries.length*2!==originals.length) return messages;
    for(const [i,[id,call]] of entries.entries()){
      const action=originals[start+2*i],receipt=originals[start+2*i+1],b=action?.content?.[0],r=receipt?.content?.[0];
      if(action?.role!=='assistant' || action.content.length!==1 || b?.type!=='tool-call' || b.id!==id ||
        b.name!==call.name || b.arguments!==call.args || receipt?.role!=='tool' || receipt.toolCallId!==id ||
        receipt.isError || receipt.content.length!==1 || r?.type!=='text' || typeof r.text!=='string' || digest(r.text)!==call.receipt) return messages;
    }
    // Expose the first native action and one verified reply. Keep every original in the host for reinspection.
    const next=messages.filter(m=>{
      const id=m.role==='assistant' && m.content?.length===1?m.content[0].id:m.role==='tool'?m.toolCallId:undefined;
      return id===first || !job.calls.has(id);
    });
    return next.map(m=>m.role==='tool' && m.toolCallId===first?{...m,content:[{text:JSON.stringify({
      status:'公开来源查证完成',sources:job.pages.map(p=>job.urls[Number(p.ref.slice(1))-1]),evidence:job.evidence
    })}]}:m);
  }
  return {offer,begin,resume,project};
}
