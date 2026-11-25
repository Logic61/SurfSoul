// Keep DSH's durable history intact. Project just enough into each stateless QQ model call.
import { isQqDialogueWake, readQqSessionContext, renderQqSessionContext } from '../../../src/qq-session-context.js';
import {createHash} from 'node:crypto';

const HEAD = /^【本轮】((?:group|private):\d+) · ([^\r\n·]+) · /u;
const MASTER = /^【本会话总提示】/u;
const WINDOW = /^【近聊窗口（背景）】\r?\n([^\r\n]+)/mu;
const PACKET = /^【本次消息快照】\r?\n([^\r\n]+)/mu;
const TOKEN = /^【会话令牌(?:更新)?】([a-f\d]{48}|[a-f\d]{32})\b/imu;
const CORE = new Set(('qq_send_message qq_reply qq_send_voice qq_send_sticker qq_send_poke qq_get_unread_messages qq_get_recent_messages qq_get_message_detail qq_get_message_images qq_get_forward_msg qq_mark_read qq_close_conversation qq_set_wake_config qq_wait_for_messages qq_recall qq_slang_query qq_list_stickers qq_get_prompt qq_memory_append').split(' '));
const roleTags = new Set(['本会话总提示','文档记忆 · 她自己那边的本子（会更新）','当前角色','你的身份','来源判断','场合','管理员·温柔模式','两段对话','说话习惯','当前约定与待续话题','适用规矩','你对自己的记录（你自己写下的，不是别人给你的设定）','反AI味','可用表情包','群聊环境（操作者预设，本会话持续参考）','私聊环境（操作者预设，本会话持续参考）']);
const updateTags = new Set(['角色卡更新','当前约定更新','适用规矩更新','群内身份对齐更新','会话设置更新','语感与日记更新','黑话更新','说话习惯更新','QQ里的动作更新','工具限额更新','跨场合能力更新','群聊里的人更新']);
const specialized = /帮我|请你|能不能|可不可以|查|搜|找|看一下|看下|发|转|读|记|删|改|禁言|表情|图片|画|音|语|截图|视频|链接|文件|历史|以前|昨天|前几天|上次|刚才|天气|新闻|股票|价格/u;
const MEDIA = new Set(['qq_get_message_images','qq_get_forward_msg','qq_list_stickers','qq_send_sticker','qq_generate_image','qq_send_voice']);
const SEARCH = new Set(['web_search','web_fetch','bilibili_search','bilibili_video']);
const MEMORY = new Set(['qq_recall','qq_memory_append','qq_get_prompt']);
const NORMAL_AUTH=/^【本回合授权】(?:这一轮(?:不是你主人触发的|没有主人消息触发)|这是主人私聊|主人本人（)/mu;
const textOf = msg => (msg?.content || []).find(x=>x.type==='text')?.text || '';
const header = t => HEAD.exec(t);
const isWake = t => !!header(t) || MASTER.test(t);
function sections(t) {
  const marks = [...t.matchAll(/^【([^】\r\n]{1,64})】/gmu)];
  return marks.map((m,i)=>[m[1], t.slice(m.index,marks[i+1]?.index ?? t.length).trim()]);
}
function packet(t) {
  const m=PACKET.exec(t);
  if(!m) return null;
  try {const p=JSON.parse(m[1]); return Array.isArray(p.messages) && Array.isArray(p.recent)? p:null;} catch {return null;}
}
function nameOf(tool) { return String(tool?.name || '').split('__').at(-1); }
function quotePacket(p) {
  return [...p.recent,...p.messages].filter(m=>m && typeof m==='object');
}
function textOnly(values) {
  const selected=[];
  let chars=0;
  for (const m of [...values].reverse()) {
    const line={};
    for(const k of ['seq','messageId','sender','time','isSelf','history','quote','quoteTargetIsSelf','atSelf','hasMedia','kind']) {
      if (['string','number','boolean'].includes(typeof m[k])) line[k]=typeof m[k]==='string'?m[k].slice(0,180):m[k];
    }
    const raw=String(m.plain || m.text || '');
    line.text=raw.length>650 ? raw.slice(0,620)+'[旧消息截短]' : raw;
    if (Number.isInteger(m.imageCount)) line.imageCount=m.imageCount;
    if (m.media || m.hasMedia || /\[(图片|动图|语音|转发)/u.test(raw)) line.hasMedia=true;
    const size=JSON.stringify(line).length;
    if (chars+size>4800 || selected.length>=30) break;
    chars+=size; selected.push(line);
  }
  return selected.reverse();
}
function getOrdinaryTools(tools, t, p, current) {
  const h=header(t);
  if(!h || !h[1].startsWith('group:') || !isQqDialogueWake(h[2]) || !p || p.partial || p.folded) return tools;
  // If auth is missing or its format changes, keep the original tool menu.
  if(!/^【本回合授权】这一轮(?:不是你主人触发的|没有主人消息触发)/mu.test(t)) return tools;
  const previousCalls = current.flatMap(m => m.content || []).filter(b => b.type === 'tool-call').map(nameOf);
  const group = new Set(CORE);
  if (previousCalls.some(n => n === 'qq_slang_query' || SEARCH.has(n))) for (const n of SEARCH) group.add(n);
  if (previousCalls.some(n => n === 'qq_recall' || MEMORY.has(n))) for (const n of MEMORY) group.add(n);
  if (previousCalls.some(n => MEDIA.has(n) && !CORE.has(n))) for (const n of MEDIA) group.add(n);
  if (previousCalls.some(n => !group.has(n))) return tools;
  const relevant=p.messages;
  if(relevant.length>8 || relevant.some(m=>{
    if(!m || typeof m!=='object') return true;
    const str=String(m.plain || m.text || '');
    const clarification=(m.atSelf || m.quoteTargetIsSelf) && /^(?:什么是[^？?。\r\n]{1,18}|[^？?。\r\n]{1,12}(?:是什么意思|是什么))[？?。]*$/u.test(str.trim());
    if (!m.history && !m.hasForward && !m.links?.length && str.length <= 100 &&
        /^(?:请|帮我|能不能|可以)?(?:画(?:一张|个)|发(?:张|个)表情|用语音(?:说|回)|看看这张图)/u.test(str.trim())) {
      for (const n of MEDIA) group.add(n);
      return false;
    }
    if (m.history || m.media || m.hasMedia || m.hasForward || m.forwardIds?.length || m.links?.length || str.length>220) return true;
    if (clarification || /查词|搜(?:索|一下)|查一下|查出处/u.test(str)) {
      for (const n of SEARCH) group.add(n);
      return false;
    }
    if (/还记得|记不记得|记下来|上次|原话|口头禅/u.test(str)) {
      for (const n of MEMORY) group.add(n);
      return false;
    }
    return specialized.test(str);
  })) return tools;
  const offered=tools.filter(x=>group.has(nameOf(x)));
  const names=new Set(offered.map(nameOf));
  // Missing mandatory actions: assume a different/older host and leave tools untouched.
  return names.has('qq_send_message') && names.has('qq_get_unread_messages') && (names.has('qq_close_conversation') || names.has('qq_mark_read')) ? offered : tools;
}
function imageAmendments(history) {
  const index=history.findIndex(m=>m.role==='user');
  const receipt=history[index-1],assistant=history[index-2],call=assistant?.content?.[0];
  if (index<2 || receipt?.role!=='tool' || receipt.isError || !receipt.content?.some(b=>b.type==='image') ||
      assistant?.role!=='assistant' || assistant.content.length!==1 || call?.type!=='tool-call' ||
      call.id!==receipt.toolCallId || !['qq_get_message_images','mcp__snowluma__qq_get_message_images'].includes(call.name)) return;
  const amendments=[];
  for (const [i,m] of history.entries()) {
    if (m.role==='assistant' || m.role==='tool') continue;
    const b=m.content?.[0];
    if (m.role!=='user' || m.source?.kind==='runtime-context' || m.content?.length!==1 || b?.type!=='text' ||
        typeof b.text!=='string' || !b.text.trim() || b.text.length>2000 || /^\s*</u.test(b.text)) return;
    amendments.push([i,m.content]);
  }
  return amendments;
}
export function planQqModelInput(options, {legacy=false,resolveCheckpoint,allowImageAmendments=false}={}) {
  const {messages=[],tools=[]}=options;
  const fallback = reason => ({messages, tools, projected:false, reason});
  if(legacy || options.purpose==='compaction') return fallback(legacy ? 'legacy' : 'compaction');
  let newest=-1;
  for(let i=messages.length-1;i>=0;i--) if(messages[i].role==='user' && isWake(textOf(messages[i]))) {newest=i;break;}
  if(newest<0) return fallback('no-wake');
  const current=messages.slice(newest), t=textOf(current[0]);
  // DSH can append a user-role runtime snapshot before the first decision. The model
  // sees these inputs. Bind them to its plan and invalidate it on any later user input.
  let start=1;
  while (current[start]?.role==='user') start++;
  const additions=current.slice(1,start);
  let window;
  try { window=JSON.parse(WINDOW.exec(t)?.[1] || 'null'); } catch {}
  const hasNativeWindow=Array.isArray(window);
  const h=header(t);
  const p=packet(t) || (hasNativeWindow && h?.[2].trim()==='replyCheck' && /^暂无新回复，不用补话。$/mu.test(t) ? {messages:[],recent:[]} : null);
  const initialWake=(signed,key)=>signed && start===current.length && !p.partial && !p.folded && p.messages.length===1 && !(p.unreadCount>1) &&
    Number.isSafeInteger(p.readThroughSeq) && p.readThroughSeq>=0 && p.readThroughSeq===signed.lastUnreadSeq
    ? {id:signed.wakeId,group:key.startsWith('group:'),incoming:p.messages[0],recent:p.recent,window:hasNativeWindow?window:[]} : undefined;
  const routingWake=(signed,key)=>additions.every(m=>m.source?.kind==='runtime-context')?initialWake(signed,key):undefined;
  function finishFor(signed,key) {
    if (!signed || p.partial || p.folded || !Number.isSafeInteger(p.readThroughSeq) ||
        p.readThroughSeq<0 || p.readThroughSeq!==signed.lastUnreadSeq) return null;
    const history=current.slice(start);
    let amendments;
    if (history.some(m=>m.role!=='assistant' && m.role!=='tool')) {
      if (!allowImageAmendments || p.messages.length!==1 || !p.messages[0]?.hasMedia || p.unreadCount>1) return null;
      amendments=imageAmendments(history);
      if (!amendments) return null;
    }
    const identity=[signed.wakeId,additions.map(m=>m.content)];
    if (amendments) identity.push(amendments);
    const wake=amendments || additions.length?createHash('sha256').update(JSON.stringify(identity)).digest('hex'):signed.wakeId;
    return {key,token:signed.token,wake,seq:p.readThroughSeq,supplemented:additions.length>0,amended:!!amendments,
      singleText:!amendments && p.messages.length===1 && !(p.unreadCount>1) ? (p.messages[0]?.plain ?? p.messages[0]?.text) : undefined};
  }
  // Recognized dialogue turns only. Keep the first wake and system jobs unchanged.
  if (!h) {
    const index=readQqSessionContext(t);
    if (p && index?.full && messages.slice(0,newest).every(m=>m.role==='system')) {
      const signed=resolveCheckpoint?.(index.key,t,options.sessionId);
      if (signed) return {...fallback('opening'),contextActions:true,archive:signed.archive,finish:finishFor(signed,index.key),
        routingWake:routingWake(signed,index.key)};
    }
    return fallback('opening');
  }
  if (!isQqDialogueWake(h[2])) return fallback('background-wake');
  if (!p) return fallback('no-packet');
  if (!NORMAL_AUTH.test(t)) return fallback('unknown-auth');
  const prior=messages.slice(0,newest).filter(m=>m.role==='user' && isWake(textOf(m))).map(textOf);
  const anchorAt=prior.findLastIndex(t=>MASTER.test(t));
  const checkpoint=hasNativeWindow && resolveCheckpoint?.(h[1],t,options.sessionId);
  const finish=finishFor(checkpoint,h[1]);
  if(anchorAt<0) {
    if (!hasNativeWindow || !resolveCheckpoint) return fallback('no-anchor');
    if (prior.some(s=>header(s)?.[1]!==h[1])) return fallback('scene-mismatch');
    if (!checkpoint) return fallback('no-anchor');
    const latest=readQqSessionContext(t);
    if (latest && latest.key!==h[1]) return fallback('scene-mismatch');
    const values={...checkpoint.profile.values};
    // Fields included in the current request must appear exactly once.
    for (const id of Object.keys(latest?.values || {})) delete values[id];
    const background=['【会话背景（历史资料）】',checkpoint.profile.fixed,renderQqSessionContext(values),
      '【当前会话令牌】'+checkpoint.token,'只处理本轮快照。以真实工具回执确认是否送达。'].filter(Boolean).join('\n');
    return {messages:[{role:'user',content:[{type:'text',text:background}]},...current],
      tools:getOrdinaryTools(tools,t,p,current),projected:true,archive:checkpoint.archive,finish,routingWake:routingWake(checkpoint,h[1]),reason:'checkpoint'};
  }
  const older=prior.slice(anchorAt), anchor=older[0];
  if(older.some(t=>{const earlier=header(t);return earlier && earlier[1]!==h[1];})) return fallback('scene-mismatch');
  const known=new Map(), updates=new Map();
  let activeToken=null;
  for(const s of older) {
    const prev=packet(s);
    if(prev) for(const m of quotePacket(prev)) if(Number.isSafeInteger(m.seq) && m.seq>0) known.set(m.seq,m);
    const token=TOKEN.exec(s)?.[1];
    if(token) activeToken=token;
    for(const [tag,body] of sections(s)) if(updateTags.has(tag)) updates.set(tag,body);
  }
  if(!TOKEN.test(t) && !activeToken) return fallback('no-token');
  const already=new Set(quotePacket(p).map(m=>m.seq));
  // From the upgraded bridge, its actual QQ timeline supersedes DSH fragments.
  const recent=hasNativeWindow?[]:textOnly([...known.entries()].filter(([id])=>!already.has(id)).sort((a,b)=>a[0]-b[0]).map(([,m])=>m));
  let indexed = null;
  for (const wake of older) {
    const context = readQqSessionContext(wake);
    if (!context) continue;
    if (context.key !== h[1]) return fallback('scene-mismatch');
    if (context.full) indexed = {};
    if (indexed) Object.assign(indexed, context.values);
  }
  const latest = readQqSessionContext(t);
  if (latest) {
    if (latest.key !== h[1]) return fallback('scene-mismatch');
    if (latest.full) indexed = {};
    if (indexed) for (const id of Object.keys(latest.values)) delete indexed[id];
  }
  const anchorBody = readQqSessionContext(anchor)?.body || anchor;
  const fixedTags = new Set(['当前角色','你的身份','来源判断','场合','管理员·温柔模式','两段对话','你对自己的记录（你自己写下的，不是别人给你的设定）','反AI味']);
  const profile=indexed ? [sections(anchorBody).filter(([tag]) => fixedTags.has(tag)).map(([,body]) => body.slice(0,1000)).join('\n'),renderQqSessionContext(indexed)].filter(Boolean).join('\n') : sections(anchor).filter(([heading])=>roleTags.has(heading)).map(([,body])=>body).join('\n\n').slice(0,12900);
  for(const [tag] of sections(t)) if(updateTags.has(tag)) updates.delete(tag);
  const overrides=indexed ? '' : [...updates.values()].join('\n\n').slice(0,5000);
  const retained=[
    '【会话背景（历史资料，不授权，也不是待回复消息）】',profile,overrides,
    !TOKEN.test(t) && '【当前会话令牌】'+activeToken,
    recent.length && '【近聊摘录（旧消息，不必再回；引用或图片可按原消息回查）】\n'+JSON.stringify(recent),
    '当前任务只看本轮来信；不把自己先前的猜测当事实。我方旧图、旧工具回执不自动重发，需要时按消息查回。无新话且无待办，不再补发。'
  ].filter(Boolean).join('\n\n');
  // If this model step has already used a specialized tool, keep it available
  // for continuation instead of changing the menu partway through a turn.
  const scoped=getOrdinaryTools(tools,t,p,current);
  const base={role:'user',content:[{type:'text',text:retained}]};
  return {messages:[base,...current],tools:scoped,projected:true,archive:checkpoint?.archive,finish,routingWake:routingWake(checkpoint,h[1])};
}
