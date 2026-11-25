import fs from 'node:fs';
import path from 'node:path';
import {createHash, createHmac, timingSafeEqual} from 'node:crypto';

// Only the final line of a bridge-authored wake can refer to local state.
const seal = /\n【QQ会话校验 v1】([0-9a-f]{64})\.([0-9a-f]{64})$/u;
const scene = /^(private|group):\d+$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const fileFor = (dir,key) => path.join(dir,'qq-context',digest(key)+'.json');
const signature = (token,key,sid,version,text) => createHmac('sha256',token)
  .update(JSON.stringify([1,key,sid,version,text])).digest();
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));

export function stripWakeSeal(text) { return text.replace(seal,''); }

export function sealQqWake({dir,write,key,sid,token,profile,text}) {
  if (!scene.test(key) || !sid || !/^(?:[a-f\d]{32}|[a-f\d]{48})$/i.test(token)) return text;
  const version = digest(JSON.stringify([key,sid,profile]));
  const file = fileFor(dir,key);
  let old = [];
  try { old = read(file); } catch {}
  if (!Array.isArray(old) || old[0]?.sid !== sid) old=[];
  if (!old.some(x=>x.version===version)) {
    // Preserve recent revisions for queued wakes. No credentials or chat packets are stored here.
    try { write(file,[{sid,version,profile},...old.slice(0,3)]); } catch { return text; }
  }
  return text+'\n【QQ会话校验 v1】'+version+'.'+signature(token,key,sid,version,text).toString('hex');
}

export function resolveQqWake(dir,key,text,hostSessionId) {
  const m=seal.exec(text);
  if (!m || !scene.test(key)) return null;
  try {
    const sid=read(path.join(dir,'sessions.json')).sessions[key];
    if (!sid || (hostSessionId && hostSessionId!==sid)) return null;
    const live=read(path.join(dir,'social-v2.json')).conversations[key];
    const token=live?.agentToken;
    if (!token || !timingSafeEqual(Buffer.from(m[2],'hex'),signature(token,key,sid,m[1],text.slice(0,m.index)))) return null;
    const entry=read(fileFor(dir,key)).find(x=>x.sid===sid && x.version===m[1]);
    if (!entry || digest(JSON.stringify([key,sid,entry.profile]))!==m[1]) return null;
    const lines=text.split('\n',3);
    const auth=text.startsWith('【本会话总提示】') ? text.match(/^【本回合授权】[^\r\n]*/mu)?.[0] :
      (lines[1]?.startsWith('【QQ上下文索引 v1】') ? lines[2] : lines[1]);
    const guest=/^【本回合授权】这一轮(?:不是你主人触发的|没有主人消息触发)/u.test(auth);
    if (!guest && !/^【本回合授权】(?:这是主人私聊|主人本人（)/u.test(auth)) return null;
    return {token,profile:entry.profile,lastUnreadSeq:live.lastUnreadSeq,wakeId:m[2],archive:{dir:path.join(dir,'qq-receipts',digest(key+(guest?'|guest':'|owner'))),
      generation:digest(JSON.stringify([sid,token,guest]))}};
  } catch { return null; }
}
