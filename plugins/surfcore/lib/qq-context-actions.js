import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const publicReads=new Set(['web_fetch','web_search','bilibili_video','bilibili_search']);
const core=new Set(['qq_send_message','qq_reply','qq_send_sticker','qq_send_voice','qq_get_unread_messages',
  'qq_get_recent_messages','qq_get_message_detail','qq_mark_read','qq_close_conversation','qq_set_wake_config','qq_recall','qq_slang_query']);
const short=name=>name.split('__').at(-1);
export const READ='surfcore_read_receipt', LOAD='surfcore_load_tools';
const day=24*60*60*1000;
const savedName=/^[a-f0-9]{64}\.r_[a-f0-9]{24}\.json$/;

function listSaved(archive) {
  if (!archive) return [];
  const dir=archive.dir;
  try {
    const rows=fs.readdirSync(dir).filter(n=>savedName.test(n)).flatMap(name=>{
      try { return [{name,time:fs.statSync(path.join(dir,name)).mtimeMs}]; } catch { return []; }
    }).sort((a,b)=>b.time-a.time || a.name.localeCompare(b.name));
    const kept=[];
    for (const [i,row] of rows.entries()) {
      if (i<12 && row.name.startsWith(archive.generation+'.') && Date.now()-row.time<day && kept.length<6) {
        kept.push({id:row.name.split('.')[1],file:path.join(dir,row.name)});
      } else if (i>=12 || Date.now()-row.time>=day || (row.name.startsWith(archive.generation+'.') && kept.length>=6)) {
        try { fs.unlinkSync(path.join(dir,row.name)); } catch {}
      }
    }
    return kept;
  } catch { return []; }
}

function saveReceipt(archive,receipt) {
  if (!archive) return;
  const dir=archive.dir;
  const dest=path.join(dir,archive.generation+'.'+receipt.id+'.json');
  if (fs.existsSync(dest)) return;
  const tmp=dest+'.'+randomUUID()+'.tmp';
  try {
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(tmp,JSON.stringify(receipt),{mode:0o600,flag:'wx'});
    fs.renameSync(tmp,dest);
  } catch { try { fs.unlinkSync(tmp); } catch {} }
}

// Inspect the already masked model view. DSH's original messages and attachments stay intact.
export function prepareQqContext(messages,tools,archive,{skipVisible=false}={}) {
  const calls=new Map(), receipts=new Map();
  const inFull=new Set();
  const lastAssistant=messages.findLastIndex(m=>m.role==='assistant');
  for (const m of messages) if (m.role==='assistant') for (const b of m.content) if (b.call) calls.set(b.id,b.call);
  const failedDelivery=m=>m?.role==='tool' && m.isError && ['qq_reply','qq_send_message','qq_send_burst'].includes(short(calls.get(m.toolCallId) || ''));
  const recovering=messages.some(failedDelivery);
  skipVisible=skipVisible && !recovering;
  const latestTool=messages.findLastIndex(m=>m.role==='tool');
  const failed=messages[latestTool];
  const sendFailure=latestTool>lastAssistant && failedDelivery(failed);
  // After a rejected delivery the reviewer may have added a factual requirement.
  // Restore the last source for the first retry, alongside the actual failure reason.
  const retrySource=sendFailure ? messages.findLastIndex(m=>m.role==='tool' && !m.isError && publicReads.has(short(calls.get(m.toolCallId) || ''))) : -1;
  const pending=sendFailure ? {status:'上一稿未送达',reason:failed.content.find(b=>b.text)?.text.slice(0,1200),
    instruction:'按原回执处理。要求收尾就结束；要求补答时，把新增问题和原问题一并答全。'} : undefined;
  const view=messages.map((m,i)=>{
    const name=calls.get(m.toolCallId);
    if (m.role!=='tool' || !name || !publicReads.has(short(name)) || m.isError || m.content.length!==1) return m;
    const text=m.content[0].text;
    if (typeof text!=='string' || text.length<8192 || text.length>262144 ||
        /^\s*(?:error\b|错误|失败)|"(?:ok|success)"\s*:\s*false|"(?:isError)"\s*:\s*true|^\s*\{\s*"error"\s*:/iu.test(text)) return m;
    const id='r_'+createHash('sha256').update(JSON.stringify([name,m.toolCallId,text])).digest('hex').slice(0,24);
    const receipt={id,name,text};
    receipts.set(id,receipt);
    saveReceipt(archive,receipt);
    if (i>lastAssistant || i===retrySource) {
      inFull.add(id);
      return m;
    }
    return {...m,content:[{text:'【已读网页回执 '+id+'，共 '+text.length+' 字符】\n'+
      text.slice(0,650)+'\n…中段可按关键词或位置重读…\n'+text.slice(-350)}]};
  });
  const saved=listSaved(archive);
  const used=new Set(calls.values());
  const latest=messages.findLast(m=>m.role==='user' && m.content[0]?.text?.startsWith('【本轮】'))?.content[0]?.text || '';
  const packet=/^【本次消息快照】\r?\n([^\r\n]+)/mu.exec(latest);
  let query='';
  try { query=JSON.parse(packet?.[1]).messages.map(m=>m.plain || m.text || '').join(' '); } catch {}
  const search=/网页|网站|搜索|检索|来源|出处|链接|https?:|B站|哔哩/u.test(query) || [...used].some(n=>publicReads.has(short(n)));
  const visible=new Set(tools.filter(t=>core.has(short(t.name)) || used.has(t.name) || (search && publicReads.has(short(t.name)))).map(t=>t.name));
  const adaptive=tools.length>24 && !tools.some(t=>t.name===LOAD || t.name===READ) && visible.size>0;
  let feedback;
  function menu() { return adaptive ? tools.filter(t=>visible.has(t.name)) : tools; }
  function catalog() { return adaptive ? tools.filter(t=>!visible.has(t.name)).map(t=>t.name) : []; }
  function ids() { return [...new Set([...receipts.keys(),...saved.map(x=>x.id)])].filter(id=>!skipVisible || !inFull.has(id)); }
  function inspect(action,args) {
    if (action===LOAD) {
      const names=Array.isArray(args.names)?args.names.slice(0,12):[];
      const found=tools.filter(t=>names.includes(t.name));
      for (const t of found) visible.add(t.name);
      feedback={loaded:found.map(t=>t.name),unknown:names.filter(n=>!found.some(t=>t.name===n))};
      return;
    }
    let r=receipts.get(args.id);
    if (!r) {
      const stored=saved.find(x=>x.id===args.id);
      try { if (stored) r=JSON.parse(fs.readFileSync(stored.file,'utf8')); } catch {}
    }
    if (!r || r.id!==args.id || typeof r.text!=='string') {feedback={error:'该回执已过期或不属于当前会话'};return;}
    let start=Math.max(0,Math.min(r.text.length,Number.isSafeInteger(args.offset)?args.offset:0));
    if (typeof args.find==='string' && args.find) {
      const match=r.text.indexOf(args.find.slice(0,200),start);
      if (match<0) {feedback={id:r.id,error:'原文中没有找到该字串',length:r.text.length};return;}
      start=Math.max(start,match-200);
    }
    const size=Math.max(256,Math.min(6000,Number.isSafeInteger(args.limit)?args.limit:3000));
    feedback={id:r.id,tool:r.name,offset:start,length:r.text.length,text:r.text.slice(start,start+size)};
  }
  return {messages:view,pending,recovering,menu,catalog,ids,inspect,get feedback(){return feedback;}};
}
