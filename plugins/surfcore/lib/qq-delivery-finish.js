// Plans only the next host step. QQ side effects still run through the advertised DSH tools.
const send='qq_send_message', close='qq_close_conversation';
const short=name=>name.split('__').at(-1);
const reasons=new Set(['natural','topic-done','explicit-end','busy','tired','other']);
function closeFields(value) {
  return value && typeof value==='object' && !Array.isArray(value) &&
    Object.keys(value).every(k=>['reason','summary','nextOpening'].includes(k)) &&
    reasons.has(value.reason) && typeof value.summary==='string' && value.summary.trim() && value.summary.length<=200 &&
    (value.nextOpening===undefined || (typeof value.nextOpening==='string' && value.nextOpening.length<=120));
}

export function createDeliveryFinish() {
  const pending=new Map();
  function remember(block,args,note,scope,tools,afterClose) {
    if (!scope || !note?.trim() || args.key!==scope.key || args.token!==scope.token || !tools.some(t=>t.name===block.name)) return;
    const name=short(block.name);
    if ((name!==send && name!==close) || (block.name!==name && block.name!=='mcp__snowluma__'+name)) return;
    const count=name===send ? (typeof args.messages==='string' ? 1 : args.messages?.length) : 0;
    if (name===send && !(Number.isInteger(count) && count>0 && count<=8)) return;
    const closeName=block.name.slice(0,-send.length)+close;
    if (afterClose!==undefined && (name!==send || !closeFields(afterClose) || !tools.some(t=>t.name===closeName))) return;
    for (const [id,item] of pending) if (item.until<Date.now()) pending.delete(id);
    if (pending.size>=128) pending.delete(pending.keys().next().value);
    pending.set(block.id,{wake:scope.wake,seq:scope.seq,name:block.name,count,note,closeName,afterClose,until:Date.now()+600000});
  }
  function resume(messages,scope,tools) {
    const last=messages.at(-1), prev=messages.at(-2);
    if (last?.role!=='tool' || prev?.role!=='assistant' || prev.content?.length!==1) return;
    const call=prev.content[0], plan=pending.get(last.toolCallId);
    if (!plan || call.type!=='tool-call' || call.id!==last.toolCallId || call.name!==plan.name) return;
    if (!scope || plan.until<Date.now() || plan.wake!==scope.wake || plan.seq!==scope.seq ||
        last.isError || last.content?.length!==1 || last.content[0].type!=='text' || !tools.some(t=>t.name===call.name)) return;
    let r;
    try {r=JSON.parse(last.content[0].text);} catch {return;}
    if (r?.ok!==true || r.key!==scope.key || r.lastUnreadSeq!==scope.seq || r.warn || r.splitWarn || r.hint || r.error) return;
    if (short(call.name)===send) {
      if (r.failed!==0 || r.sent!==plan.count || !Array.isArray(r.messageIds) || r.messageIds.length!==plan.count ||
          new Set(r.messageIds.map(String)).size!==plan.count ||
          !r.messageIds.every(id=>(typeof id==='string' && id.trim() && id!=='0') || (Number.isSafeInteger(id) && id!==0))) return;
      if (plan.afterClose) {
        if (!tools.some(t=>t.name===plan.closeName)) return;
        pending.delete(call.id); // Never issue a second native close from a replayed send receipt.
        return {action:plan.closeName,arguments:JSON.stringify({...plan.afterClose,key:scope.key,token:scope.token,openQuestion:'none'}),note:plan.note};
      }
    } else if (r.wakeKept!==true || !(r.closedAt>0) || r.unreadCount!==0) return;
    return {action:'end',text:'',note:plan.note};
  }
  return {remember,resume};
}
